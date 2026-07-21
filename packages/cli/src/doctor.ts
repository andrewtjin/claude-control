// `cctl doctor` — environment sanity checks.
//
// The check RUNNERS do IO (filesystem, DPAPI, PATH); the RENDERER and the pass/fail
// summary are pure so their output is unit-tested. Each check reports a human detail so a
// failure is actionable, never a bare boolean.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultLiveCredentialChannel,
  defaultProtector,
  resolveClaudeCliKeychainTarget,
  type LiveCredentialChannel,
  type Paths,
} from '@claude-control/switch-engine';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

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

/** Render checks as `[ok]/[!!]` lines (green/red when a color palette is injected). Pure. */
export function renderDoctor(checks: DoctorCheck[], palette: Palette = PLAIN_PALETTE): string {
  return checks
    .map((c) => `${c.ok ? palette.green('[ok]') : palette.red('[!!]')} ${c.name}: ${c.detail}`)
    .join('\n');
}

/** Count outcomes. Pure. */
export function summarize(checks: DoctorCheck[]): { passed: number; failed: number } {
  const failed = checks.filter((c) => !c.ok).length;
  return { passed: checks.length - failed, failed };
}

/** Vault encryption availability, verified by a REAL protect/unprotect round-trip through
 *  this platform's protector (win32: DPAPI · darwin: Keychain+AES-GCM). On an unsupported
 *  platform the factory's error IS the report — the gap is stated, never silent. */
export function checkVaultProtection(platform: NodeJS.Platform = process.platform): DoctorCheck {
  const label = platform === 'win32' ? 'DPAPI' : platform === 'darwin' ? 'Keychain' : platform;
  try {
    const p = defaultProtector(platform);
    const probe = Buffer.from('cctl-doctor-probe');
    const ok = p.unprotect(p.protect(probe)).equals(probe);
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
 *  channel, so on macOS this probes the CLI's Keychain item (which doubles as the wet-gate
 *  verifier for the item-name/shape assumptions), not a file that never exists there. */
export async function checkLiveLogin(
  paths: Paths,
  platform: NodeJS.Platform = process.platform,
  channel: LiveCredentialChannel = defaultLiveCredentialChannel(paths, platform),
): Promise<DoctorCheck> {
  // On darwin, name the EXACT Keychain target (service/account, env overrides applied) so an A1
  // item-name/account miss self-diagnoses. The hint stays R16-safe: an ATTRIBUTE-ONLY dump —
  // never `-w`/`-g`, which would print the live token — plus the env-override escape hatch.
  const target = platform === 'darwin' ? resolveClaudeCliKeychainTarget() : undefined;
  const where = target
    ? `the CLI's Keychain item (service="${target.service}", account="${target.account}")`
    : paths.credentialsPath;
  const missDetail = target
    ? `no live credentials in ${where} — verify with ` +
      `\`security find-generic-password -s "${target.service}"\` (attribute-only; never -w/-g), ` +
      `or set CLAUDE_CLI_KEYCHAIN_SERVICE / CLAUDE_CLI_KEYCHAIN_ACCOUNT`
    : `no live credentials in ${where} — run \`claude\` and log in first`;
  try {
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

/** Run every check for the given paths. */
export async function runDoctor(paths: Paths): Promise<DoctorCheck[]> {
  return [
    checkNodeVersion(),
    checkVaultProtection(),
    checkVault(paths),
    await checkLiveLogin(paths),
    checkClaudeJson(paths),
    { name: 'lock', ok: true, detail: join(paths.vaultDir, '.lock') },
  ];
}
