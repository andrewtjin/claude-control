// `cctl doctor` — environment sanity checks.
//
// The check RUNNERS do IO (filesystem, DPAPI, PATH); the RENDERER and the pass/fail
// summary are pure so their output is unit-tested. Each check reports a human detail so a
// failure is actionable, never a bare boolean.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultLiveCredentialChannel,
  defaultProtector,
  quoteSecurityArg,
  type LiveCredentialChannel,
  type Paths,
} from '@claude-control/switch-engine';
import { findClaudeCodeBinary, type ClaudeCodeBinaryDeps } from '@claude-control/session-runtime';
import { isBindGuardInSettingsText } from '@claude-control/daemon';
import {
  CLAUDE_CODE_TITLE_MAX_LENGTH,
  aliasFitsSessionTitle,
  shellQuoteArg,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { PLAIN_PALETTE, sanitizeForTerminal, type Palette } from './ansi.js';
import { verifyManagedSettingsEffective } from './managedSettings.js';
import { parsePowerShellWrapper, POWERSHELL_WRAPPER_MARKER } from './shellInit.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

// The Node floor is NOT the version that first shipped `node:sqlite` (22.5.0, where it was
// gated behind `--experimental-sqlite`) but the first version that exposes it WITHOUT that
// flag: 22.13.0 on the 22.x line (and 23.4.0 on 23.x). cctl runs as a bare `cctl`/Scheduled
// Task command, so it can't pass a runtime flag — a user on 22.5–22.12 would see the daemon's
// sqlite store fail to load. The publishable package's `engines` field is kept at this same
// floor (see doctor.test.ts), but npm's own engine check is advisory by default, so a user who
// ignores or bypasses that warning can still get here — this check exists to catch them with
// an actionable message instead of a raw builtin-module error. Confirmed on this repo's dev
// machine: `require('node:sqlite')` loads unflagged on v24.
export const MIN_NODE_VERSION = '22.13.0';

/** Parse `vX.Y.Z` (or `X.Y.Z`) into a numeric tuple; undefined for anything unparseable. */
function parseNodeVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1/0/1 like a comparator, on major→minor→patch order. */
function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Whether this Node is new enough that the daemon's `node:sqlite` store loads without a
 *  runtime flag. Takes the version string (default `process.version`) and floor explicitly so
 *  it is exercised against fixed inputs rather than only whatever Node happens to run the
 *  suite. */
export function checkNodeVersion(
  version: string = process.version,
  floor: string = MIN_NODE_VERSION,
): DoctorCheck {
  const current = parseNodeVersion(version);
  const minimum = parseNodeVersion(floor) ?? [0, 0, 0];
  if (!current) {
    return { name: 'node', ok: false, detail: `could not parse Node version "${version}"` };
  }
  const ok = compareVersions(current, minimum) >= 0;
  return {
    name: 'node',
    ok,
    detail: ok
      ? `${version} (>= ${floor}; node:sqlite works without --experimental-sqlite)`
      : `${version} is too old — cctl needs Node >= ${floor} ` +
        '(earlier versions require --experimental-sqlite for node:sqlite, which cctl cannot pass)',
  };
}

// ---------------------------------------------------------------------------
// Relay reachability
// ---------------------------------------------------------------------------

/** The minimal fetch surface the relay probe needs — injected in tests so no socket is ever
 *  opened, and so a timeout/connection error is exercised deterministically. */
export type ProbeFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface RelayProbe {
  reachable: boolean;
  detail: string;
}

export interface ProbeRelayOptions {
  fetchFn?: ProbeFetch;
  timeoutMs?: number;
}

/** Default: probe the relay soon enough that an unreachable host doesn't stall the wizard, but
 *  with enough slack for a real round-trip to a hosted relay. */
export const RELAY_PROBE_TIMEOUT_MS = 4000;

/** Derive the bot's unauthenticated `GET /health` URL from the relay WebSocket url: `ws`→`http`,
 *  `wss`→`https`, then a `/health` path. Anything else is returned with `/health` appended as a
 *  best effort so the caller still has something to probe. Pure. */
export function healthUrlFromRelay(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, '');
  const httpUrl = trimmed.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  return `${httpUrl}/health`;
}

/**
 * Probe whether the relay's HTTP health endpoint answers — the signal that lets the wizard say
 * "the relay is down" rather than "your network is broken" when pairing later fails. A non-200,
 * a connection error, or a timeout all report `reachable: false` with a human detail; only an
 * actual 200 counts as reachable.
 */
export async function probeRelay(
  relayUrl: string,
  options: ProbeRelayOptions = {},
): Promise<RelayProbe> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? RELAY_PROBE_TIMEOUT_MS;
  const healthUrl = healthUrlFromRelay(relayUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(healthUrl, { signal: controller.signal });
    if (res.ok) return { reachable: true, detail: `relay healthy at ${healthUrl}` };
    return { reachable: false, detail: `relay answered ${healthUrl} with HTTP ${res.status}` };
  } catch (err) {
    return {
      reachable: false,
      detail: `no response from ${healthUrl} (${(err as Error).message})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Render checks as `[ok]/[!!]` lines (green/red when a color palette is injected). Pure.
 *
 *  A detail quotes account labels, group labels and folder paths straight out of the registry files,
 *  which an older build or a hand edit may have left carrying terminal controls, so each line of it
 *  is made terminal-safe here — the one place every check's text reaches the terminal. */
export function renderDoctor(checks: DoctorCheck[], palette: Palette = PLAIN_PALETTE): string {
  const safe = (text: string): string => text.split('\n').map(sanitizeForTerminal).join('\n');
  return checks
    .map(
      (c) =>
        `${c.ok ? palette.green('[ok]') : palette.red('[!!]')} ${safe(c.name)}: ${safe(c.detail)}`,
    )
    .join('\n');
}

/** Count outcomes. Pure. */
export function summarize(checks: DoctorCheck[]): { passed: number; failed: number } {
  const failed = checks.filter((c) => !c.ok).length;
  return { passed: checks.length - failed, failed };
}

/** Vault encryption availability, verified by a REAL protect/unprotect round-trip through
 *  this platform's protector (win32: DPAPI · darwin: Keychain+AES-GCM · everywhere else:
 *  file-key+AES-GCM). The key stores are get-or-create, so on a first run a green check is
 *  also proof the key store is writable. `vaultKeyPath` is a test seam for the file-key
 *  branch; production omits it and probes the real key file. */
export async function checkVaultProtection(
  platform: NodeJS.Platform = process.platform,
  vaultKeyPath?: string,
): Promise<DoctorCheck> {
  const label =
    platform === 'win32' ? 'DPAPI' : platform === 'darwin' ? 'Keychain' : `file-key (${platform})`;
  try {
    const p = defaultProtector(platform, vaultKeyPath);
    const probe = Buffer.from('cctl-doctor-probe');
    const ok = (await p.unprotect(await p.protect(probe))).equals(probe);
    return {
      name: 'vault-crypto',
      ok,
      detail: ok ? `${label} protect/unprotect round-trip works` : `${label} round-trip mismatch`,
    };
  } catch (err) {
    return { name: 'vault-crypto', ok: false, detail: (err as Error).message };
  }
}

/** The vault directory is present or creatable. */
export function checkVault(paths: Paths): DoctorCheck {
  const ok = existsSync(paths.vaultDir);
  return {
    name: 'vault',
    ok: true, // absence is fine (first run); report it, don't fail
    detail: ok ? paths.vaultDir : `${paths.vaultDir} (will be created on first account add)`,
  };
}

/** Whether someone is currently logged in — read through this platform's live-credential
 *  channel, so on macOS this probes the CLI's Keychain item (which doubles as the live check
 *  of the item-name/shape assumptions), not a file that never exists there. */
export async function checkLiveLogin(
  paths: Paths,
  platform: NodeJS.Platform = process.platform,
  channel?: LiveCredentialChannel,
): Promise<DoctorCheck> {
  // `where` starts as the file-channel fallback description and is refined once the channel is
  // constructed. Keeping it defined before the try means a construction failure (e.g. the
  // Keychain channel's constructor calling `userInfo()`, which throws when the effective UID has
  // no passwd entry) still reports a target instead of skipping straight to a bare error.
  let where: string = paths.credentialsPath;
  try {
    // Constructed here, inside the try, not as a default parameter — a default parameter is
    // evaluated before this function body runs, so a throwing constructor would propagate past
    // this check entirely instead of surfacing as a normal `ok: false` doctor line.
    channel ??= defaultLiveCredentialChannel(paths, platform);
    // Name the EXACT target the CHANNEL itself resolved to (service/account, env overrides
    // applied), read off the channel rather than recomputed here — recomputing independently is
    // exactly how a reported target can drift from what readLiveCredentials/writeLiveCredentials
    // actually hit. Only the Keychain channel has one; the file channel leaves this undefined and
    // `paths.credentialsPath` (the fallback above) is the target. The suggested command is
    // deliberately an ATTRIBUTE-ONLY dump: `-w`/`-g` would print the live OAuth token to the
    // operator's terminal. `quoteSecurityArg` matches the quoting the real exec path uses, so an
    // override containing a quote or `$(...)` doesn't produce mis-quoted copy-paste advice.
    const target = channel.target;
    if (target) {
      where = `the CLI's Keychain item (service="${target.service}", account="${target.account}")`;
    }
    const missDetail = target
      ? `no live credentials in ${where} - verify with ` +
        `\`security find-generic-password -s ${quoteSecurityArg(target.service)}\` (attribute-only; never -w/-g), ` +
        `or set CLAUDE_CLI_KEYCHAIN_SERVICE / CLAUDE_CLI_KEYCHAIN_ACCOUNT`
      : `no live credentials in ${where} - run \`claude\` and log in first`;
    const live = await channel.readLiveCredentials();
    return {
      name: 'login',
      ok: live !== undefined,
      detail: live !== undefined ? `live credentials found in ${where}` : missDetail,
    };
  } catch (err) {
    return {
      name: 'login',
      ok: false,
      detail: `error reading ${where}: ${(err as Error).message}`,
    };
  }
}

/** The `~/.claude.json` config the switch touches is present. */
export function checkClaudeJson(paths: Paths): DoctorCheck {
  const ok = existsSync(paths.claudeJsonPath);
  return {
    name: 'config',
    ok,
    detail: ok ? paths.claudeJsonPath : `${paths.claudeJsonPath} not found`,
  };
}

/** Whether a remote session could actually start. Managed sessions (`/run` from Discord) are the
 *  one feature that depends on the Agent SDK's native Claude Code binary, which the SDK looks up
 *  lazily at the first session — so an install missing it passes every other check here and
 *  fails only on the phone, hours later, with no local symptom. This check does that lookup up
 *  front. It is diagnostic: nothing consults it before spawning. */
export function checkSessionRuntime(deps: ClaudeCodeBinaryDeps = {}): DoctorCheck {
  const lookup = findClaudeCodeBinary(deps);
  return {
    name: 'session-runtime',
    ok: lookup.path !== undefined,
    detail:
      lookup.path !== undefined
        ? `Claude Code binary for remote sessions: ${lookup.path}`
        : `remote sessions (/run) cannot start — ${lookup.error}`,
  };
}

/**
 * Whether a prompt from the phone can reach a session sitting IDLE at its prompt.
 *
 * Reported as a pass-with-detail rather than a failure when unconfigured: everything else still
 * works without it, and a `/say` still lands at the session's next turn boundary. What the
 * operator needs is for "nothing happened when I messaged an idle session" to read as a
 * configuration state with a named fix, rather than as a bug.
 */
export async function checkChannelAllowlist(
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck> {
  const status = await verifyManagedSettingsEffective({ platform });
  if (status.effective) {
    return { name: 'channel', ok: true, detail: `idle-session prompts enabled (${status.path})` };
  }
  return {
    name: 'channel',
    ok: true,
    detail: status.presentButStale
      ? `${status.detail} — re-run \`cctl channel enable\` to restore it`
      : 'idle-session prompts not enabled; /say delivers at the next turn boundary instead. ' +
        '`cctl channel enable` changes that.',
  };
}

// ---------------------------------------------------------------------------
// Folder-bound accounts (slots, guard snapshot, guard hook, version skew)
// ---------------------------------------------------------------------------

/** The slot invariant checker (engine.checkSlots) is the single authority for "is any account live
 *  where it must not be" — a reserved account squatting in global, a non-member in a group profile, a
 *  group's active id disagreeing with its live login, a broken profile link. A clean result is a
 *  pass; any violation is a failure naming each one, with the fix being `cctl doctor` -> repair (the
 *  daemon repairs these automatically on each poll). */
export async function checkSlots(engine: Pick<SwitchEngine, 'checkSlots'>): Promise<DoctorCheck> {
  try {
    const violations = await engine.checkSlots();
    if (violations.length === 0) {
      return { name: 'slots', ok: true, detail: 'no slot invariant violations' };
    }
    return {
      name: 'slots',
      ok: false,
      detail:
        `${violations.length} slot violation(s): ` +
        violations.map((v) => `${v.kind} (${v.detail})`).join('; '),
    };
  } catch (err) {
    return { name: 'slots', ok: false, detail: `could not check slots: ${(err as Error).message}` };
  }
}

/** A binding with no folder and no session alias routes nothing: it is what a cctl without session
 *  aliases leaves behind when it rewrites a file holding an alias-only binding (it drops the alias
 *  scopes it does not know). Its accounts stay reserved to it — usable nowhere but with an explicit
 *  `--account` — until a scope is bound to them again or the binding is dissolved. Flagged by name
 *  with the release command (by id: stable and paste-safe). Also flagged: a session alias longer
 *  than Claude Code keeps a session's name (bound before cctl refused those), which no session can
 *  ever match — with the command that unbinds it. */
export async function checkBindingScopes(
  engine: Pick<SwitchEngine, 'listGroups'>,
): Promise<DoctorCheck> {
  try {
    const groups = await engine.listGroups();
    const scopeless = groups.filter(
      (g) => g.folders.length === 0 && (g.aliases ?? []).length === 0,
    );
    const tooLong = groups.flatMap((g) =>
      (g.aliases ?? []).filter((a) => !aliasFitsSessionTitle(a.alias)),
    );
    if (scopeless.length === 0 && tooLong.length === 0) {
      return { name: 'binding-scopes', ok: true, detail: 'every binding has a folder or session' };
    }
    const problems: string[] = [];
    if (scopeless.length > 0) {
      problems.push(
        `${scopeless.length} binding(s) route nothing (no folder or session left): ` +
          scopeless
            .map((g) => `${g.label} (${g.members.map((m) => m.label).join(', ')})`)
            .join('; ') +
          ' — bind a session or folder to those accounts again (cctl session bind / cctl bind), ' +
          'or release them: ' +
          scopeless.map((g) => `cctl unbind --group ${g.id}`).join('; '),
      );
    }
    if (tooLong.length > 0) {
      problems.push(
        `${tooLong.length} session alias(es) never match a session (longer than the ` +
          `${CLAUDE_CODE_TITLE_MAX_LENGTH} characters Claude Code keeps of a session name) — ` +
          'unbind them: ' +
          tooLong
            .map(
              (a) =>
                `cctl session unbind ${shellQuoteArg(a.alias, process.platform)} --cwd ` +
                shellQuoteArg(a.folder, process.platform),
            )
            .join('; '),
      );
    }
    return { name: 'binding-scopes', ok: false, detail: problems.join('; and ') };
  } catch (err) {
    return {
      name: 'binding-scopes',
      ok: false,
      detail: `could not read the bindings: ${(err as Error).message}`,
    };
  }
}

/** The guard reads a snapshot copy of the groups file, stamped with the generation it was built
 *  from. If that lags the live groups generation, the guard is enforcing a stale binding view until
 *  the daemon restarts or a `cctl settings` change rewrites it. No groups + no snapshot is a pass
 *  (nothing to enforce). */
export async function checkGuardSnapshot(
  engine: Pick<SwitchEngine, 'getGuardSnapshotFreshness' | 'listGroups'>,
): Promise<DoctorCheck> {
  try {
    const [freshness, groups] = await Promise.all([
      engine.getGuardSnapshotFreshness(),
      engine.listGroups(),
    ]);
    if (!freshness.present) {
      if (groups.length === 0) {
        return {
          name: 'guard-snapshot',
          ok: true,
          detail: 'no folder bindings; nothing to enforce',
        };
      }
      return {
        name: 'guard-snapshot',
        ok: false,
        detail: `${groups.length} folder binding(s) but no guard snapshot — restart the daemon (cctl daemon restart) to write it`,
      };
    }
    // Freshness is by CONTENT, not the groups generation: a routine group member switch bumps the
    // generation on fields the snapshot does not carry and must not read as stale. A genuine STALE
    // means a bound folder / profile / member / enforce mode changed without the snapshot being
    // rewritten — a bind/unbind or a daemon restart rewrites it (a settings change only does so for
    // CCTL_BIND_ENFORCE, so it is not offered as the general fix).
    return {
      name: 'guard-snapshot',
      ok: freshness.fresh,
      detail: freshness.fresh
        ? `fresh (generation ${freshness.generation}, enforce=${freshness.enforce})`
        : `STALE (the guard is enforcing an out-of-date binding view) — run \`cctl bind\`/\`cctl unbind\` again or restart the daemon (cctl daemon restart) to rewrite it`,
    };
  } catch (err) {
    return {
      name: 'guard-snapshot',
      ok: false,
      detail: `could not read the guard snapshot: ${(err as Error).message}`,
    };
  }
}

/**
 * The binding checks `cctl doctor` appends: slot invariants, bindings that route nothing (see
 * {@link checkBindingScopes}), guard snapshot freshness, guard hook presence. They all read
 * `groups.json`, and a doctor exists precisely for the day that file cannot be read (corrupt, or
 * written by a newer build) — so an unreadable registry is reported as ONE failed `bindings` check
 * naming the reason, and every other check still runs and reports, instead of the whole command dying
 * on the first read with nothing but that error. The scope check is the one left out then: it has
 * nothing to look at beyond the registry, and would only repeat that reason. With the bindings
 * unknown, the guard hook is judged as if bindings exist: a missing guard may then be a real gap.
 */
export async function checkFolderBindings(
  engine: Pick<SwitchEngine, 'listGroups' | 'checkSlots' | 'getGuardSnapshotFreshness'>,
  paths: Paths,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let hasBindings: boolean;
  let readable = true;
  try {
    hasBindings = (await engine.listGroups()).length > 0;
  } catch (err) {
    hasBindings = true;
    readable = false;
    out.push({
      name: 'bindings',
      ok: false,
      detail: `could not read the folder bindings: ${(err as Error).message}`,
    });
  }
  out.push(await checkSlots(engine));
  if (readable) out.push(await checkBindingScopes(engine));
  out.push(await checkGuardSnapshot(engine), checkGuardHook(paths, hasBindings));
  return out;
}

/** Whether the enforcement guard hook is installed in the main config dir's settings.json. When
 *  bindings exist but the guard is absent, nothing enforces them — a failure. With no bindings, its
 *  presence is optional and reported without failing. */
export function checkGuardHook(paths: Paths, hasBindings: boolean): DoctorCheck {
  const settingsPath = join(paths.claudeDir, 'settings.json');
  let installed = false;
  let unparseable = false;
  try {
    let raw = readFileSync(settingsPath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // tolerate a PowerShell/Notepad UTF-8 BOM
    // Parse rather than substring-match alone: parsing tells a genuine install apart from a
    // settings.json the guard installer would REFUSE to write to (invalid JSON), which otherwise
    // looks identical ("guard absent") while the real cause — and fix — is different.
    JSON.parse(raw);
    // Recognize the guard by the SAME exact installed shape the installer uses, not a bare
    // `bind-guard.cjs` substring: a foreign hook that merely mentions the filename (e.g.
    // `node linter.js --config bind-guard.cjs.rc`), or an incidental mention in a comment or path,
    // must NOT read as the enforcement guard — otherwise doctor reports a security control installed
    // when nothing enforces the bindings.
    installed = isBindGuardInSettingsText(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      installed = false;
    } else if (err instanceof SyntaxError) {
      unparseable = true;
    }
  }
  if (installed) {
    return { name: 'guard-hook', ok: true, detail: `installed in ${settingsPath}` };
  }
  if (unparseable) {
    // The installer refuses to overwrite invalid JSON, so the guard is NOT installed and bindings are
    // unenforced no matter how many binds run until the file is repaired. Say so plainly rather than
    // reporting a generic "not installed".
    return {
      name: 'guard-hook',
      ok: !hasBindings,
      detail: hasBindings
        ? `guard NOT installed — ${settingsPath} is not valid JSON, so the installer refuses to write to it and folder bindings are NOT enforced. Fix the file (e.g. remove comments/trailing commas), then run \`cctl bind\` again or restart the daemon.`
        : `${settingsPath} is not valid JSON (no bindings need the guard yet, but a bind would fail to install it until the file is fixed)`,
    };
  }
  return {
    name: 'guard-hook',
    ok: !hasBindings,
    detail: hasBindings
      ? `not installed in ${settingsPath}, but folder bindings exist — bindings are NOT enforced. Run \`cctl bind\` again (it reinstalls the guard) or restart the daemon.`
      : 'not installed (no folder bindings need it yet)',
  };
}

/** Compare this CLI's build against the running daemon's last-reported build (the same two values
 *  `cctl version` shows). After an `npm i -g` upgrade the running daemon keeps its old build until
 *  restarted, so a live daemon on a different build is a real skew — the guard script, snapshot
 *  format, and poll behavior may not match. `daemonBuild` is undefined / `daemonAlive` false when no
 *  daemon is running to compare, which is a pass. Pure. */
export function checkVersionSkew(
  cliVersion: string,
  daemonBuild: string | undefined,
  daemonAlive: boolean,
): DoctorCheck {
  // The daemon-build value comes from the settings report, which stores it 'v'-prefixed
  // (`v${VERSION}`), while callers here pass the bare package VERSION. `cctl version` reconciles
  // this by prefixing its CLI value before comparing; do the mirror here by stripping an optional
  // leading 'v' from both sides, so an identical build never reads as a skew merely because one
  // string carries the 'v' and the other does not. Display the normalized numbers too, so a real
  // skew shows two genuinely different versions and the pass line matches `cctl version`.
  const strip = (v: string): string => v.replace(/^v/i, '');
  const cli = strip(cliVersion);
  if (!daemonAlive || daemonBuild === undefined) {
    return {
      name: 'daemon-version',
      ok: true,
      detail: `CLI is ${cli}; no running daemon to compare`,
    };
  }
  const daemon = strip(daemonBuild);
  if (daemon === cli) {
    return { name: 'daemon-version', ok: true, detail: `CLI and daemon both ${cli}` };
  }
  return {
    name: 'daemon-version',
    ok: false,
    detail: `CLI is ${cli} but the running daemon is ${daemon} — restart it so both match: cctl daemon restart`,
  };
}

// ---------------------------------------------------------------------------
// PowerShell `claude` wrapper (Windows) — stale embedded paths
// ---------------------------------------------------------------------------

/** Candidate PowerShell profile locations on Windows — Windows PowerShell 5.1 and PowerShell 7, plus
 *  a OneDrive-redirected Documents (the common case where `$PROFILE` does not live under
 *  `%USERPROFILE%\Documents`). Best-effort; used only by the wrapper check. Pure over `env`. */
export function powerShellProfilePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE;
  if (!home || home.length === 0) return [];
  const docRoots = [join(home, 'Documents')];
  if (env.OneDrive && env.OneDrive.length > 0) docRoots.push(join(env.OneDrive, 'Documents'));
  if (env.OneDriveCommercial && env.OneDriveCommercial.length > 0) {
    docRoots.push(join(env.OneDriveCommercial, 'Documents'));
  }
  const paths: string[] = [];
  for (const root of docRoots) {
    // Windows PowerShell 5.1 uses the WindowsPowerShell folder; PowerShell 7+ uses PowerShell.
    for (const dir of ['WindowsPowerShell', 'PowerShell']) {
      paths.push(join(root, dir, 'Microsoft.PowerShell_profile.ps1'));
      paths.push(join(root, dir, 'profile.ps1'));
    }
  }
  return paths;
}

/** Whether an installed PowerShell `claude` wrapper still points at a node binary and cctl entry that
 *  exist. A node upgrade/move or a cctl reinstall can change the absolute paths the wrapper embedded,
 *  after which typing `claude` fails with a raw CommandNotFoundException or a "Cannot find module"
 *  stack trace that never mentions cctl. This check turns that into an actionable line. Pure over its
 *  inputs: `profileText` undefined means no profile carried the wrapper (a pass), the `shim` form has
 *  no embedded paths to go stale (a pass), and only the node-direct form is existence-checked. */
export function checkPowerShellWrapper(
  profileText: string | undefined,
  existsSyncFn: (p: string) => boolean = existsSync,
): DoctorCheck {
  if (profileText === undefined) {
    return {
      name: 'ps-wrapper',
      ok: true,
      detail: 'no PowerShell profile carries a cctl claude wrapper',
    };
  }
  const parsed = parsePowerShellWrapper(profileText);
  if (parsed === undefined) {
    return {
      name: 'ps-wrapper',
      ok: true,
      detail: 'no cctl claude wrapper in the PowerShell profile',
    };
  }
  if (parsed.kind === 'shim') {
    return {
      name: 'ps-wrapper',
      ok: true,
      detail: 'cctl claude wrapper installed (cctl-shim form; no embedded paths to go stale)',
    };
  }
  const missing: string[] = [];
  if (!existsSyncFn(parsed.nodePath)) missing.push(`node (${parsed.nodePath})`);
  if (!existsSyncFn(parsed.cctlEntry)) missing.push(`cctl entry (${parsed.cctlEntry})`);
  if (missing.length === 0) {
    return {
      name: 'ps-wrapper',
      ok: true,
      detail: 'cctl claude wrapper points at an existing node and cctl entry',
    };
  }
  return {
    name: 'ps-wrapper',
    ok: false,
    detail:
      `the PowerShell claude wrapper points at ${missing.join(' and ')} that no longer exist(s) — ` +
      'regenerate it: cctl shell-init powershell | Out-File -Append $PROFILE',
  };
}

/** Read the first PowerShell profile that carries a cctl wrapper (by its marker), for the wrapper
 *  check. Returns undefined when none of the candidate profiles exist or carry the wrapper. */
export function readPowerShellWrapperProfile(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const p of powerShellProfilePaths(env)) {
    try {
      const text = readFileSync(p, 'utf8');
      if (text.includes(POWERSHELL_WRAPPER_MARKER)) return text;
    } catch {
      // Absent or unreadable profile: skip and try the next candidate.
    }
  }
  return undefined;
}

/** Run every check for the given paths. */
export async function runDoctor(paths: Paths): Promise<DoctorCheck[]> {
  return [
    checkNodeVersion(),
    await checkVaultProtection(),
    checkVault(paths),
    await checkLiveLogin(paths),
    checkClaudeJson(paths),
    checkSessionRuntime(),
    await checkChannelAllowlist(),
    { name: 'lock', ok: true, detail: join(paths.vaultDir, '.lock') },
  ];
}
