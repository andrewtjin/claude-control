// Settings visibility: which knobs are on, what value is in effect, and where it came from.
//
// One module owns the entire configuration surface — the env parsing helpers, the default
// constants (imported from the packages that own them, never restated), the row-building for
// both the CLI view (`cctl settings`) and the daemon's own effective-settings report, and
// the pure renderer. daemonRun.ts consumes `resolveDaemonConfig` for its ACTUAL policy
// values, so the settings view can never drift from what the daemon really runs with:
// display and behavior are read from the same resolution.
//
// The daemon also persists its resolved report to a JSON file beside the vault (values and
// sources only — never token material), so `cctl settings` can show what the last-started
// daemon is ACTUALLY using rather than guessing from this shell's env. The Discord bot gets
// the same report over the wire (`settings.snapshot`).
//
// Two JSON files sit beside the vault and must not be confused — they point opposite ways:
// `config.json` is INPUT an operator writes (`readDaemonConfigFile`), and only it can change
// behavior; `daemon-settings.json` is OUTPUT the daemon writes (`writeSettingsReport`).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SettingsSnapshot,
  type SettingRow,
  type SettingSource,
} from '@claude-control/shared-protocol';
import {
  DEFAULT_MIN_SWITCH_INTERVAL_MS,
  DEFAULT_REFRESH_SKEW_MS,
  atomicWriteFile,
  defaultPaths,
  type Paths,
} from '@claude-control/switch-engine';
import { DEFAULT_AUTOSWITCH_COOLDOWN_MS, DEFAULT_PERMISSION_HOLD_MS } from '@claude-control/daemon';
import {
  DEFAULT_GREEDY_RESET_MARGIN_MS,
  DEFAULT_MIN_SESSION_HEADROOM_PCT,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_STALE_TRIGGER_PERCENT,
  DEFAULT_TRIGGER_PERCENT,
} from '@claude-control/usage-advisor';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

export type { SettingRow } from '@claude-control/shared-protocol';

/** The build version, surfaced by `cctl --version` and as a settings row on both the CLI and
 *  the phone. Lives here (not program.ts) so the daemon's settings report can carry it: after
 *  an `npm i -g` update the running daemon keeps its old build until restarted, and the two
 *  rows ('cli build' vs 'daemon build') are how an operator sees that skew. */
export const VERSION = '0.4.6';

/** The hosted control plane a published build dials with no configuration at all. This is the
 *  last fallback in the precedence ladder, not a lock-in: `--relay`, `CCTL_RELAY_URL`, and
 *  `relayUrl` in `config.json` each override it, so self-hosting never needs a rebuild. */
export const DEFAULT_RELAY_URL = 'wss://cctl.andrewtjin.com';

/** OAuth2 install link for the shared Discord bot. `applications.commands` is required or
 *  `/pair` never appears in the invited server; the permission bits cover message/embed/file
 *  delivery plus private-thread mode (View Channel and Read Message History included so the
 *  bot can see its host channel and re-fetch its own cards). */
export const BOT_INVITE_URL =
  'https://discord.com/oauth2/authorize?client_id=1527387188772208790&permissions=395137108992&scope=bot+applications.commands';

/** User-install variant of the invite: adds the app to a Discord ACCOUNT rather than a
 *  server, so `/pair` and DM delivery work with no server at all. No `bot` scope and no
 *  permission bits — a user-installed app has no guild presence (which is also why
 *  private-thread mode still needs the server invite above). */
export const BOT_USER_INSTALL_URL =
  'https://discord.com/oauth2/authorize?client_id=1527387188772208790&integration_type=1&scope=applications.commands';

// ---------------------------------------------------------------------------
// Env parsing (shared with daemonRun.ts — the single source of truth)
// ---------------------------------------------------------------------------

/** A non-negative number from the environment, or undefined when unset/unparseable — an env
 *  typo silently falling back to the default beats a daemon that refuses to start. */
export function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A boolean flag from the environment: 1/true/yes/on (any case) means on; anything else —
 *  including unset — means off. Same typo-tolerance stance as envNumber. */
export function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** A tri-state boolean from the environment, for knobs whose default is ON: explicit on,
 *  explicit off (0/false/no/off), or undefined when unset/unparseable — the caller picks the
 *  default, and the settings view attributes 'env' only to a parsed override. */
export function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return undefined;
}

/** Compact duration for display: "45s", "10m", "2h". Sub-second values are only reachable
 *  through deliberate env overrides, so millisecond precision is not worth the noise. */
function humanizeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** The source for an env-tunable value: 'env' only when the override actually PARSED (a
 *  typo'd value falls back to the default, and the view must say so honestly). */
function envSource(overridden: boolean): SettingSource {
  return overridden ? 'env' : 'default';
}

/** A blank or whitespace-only override is an ABSENT one. Without this, `CCTL_RELAY_URL=` in a
 *  shell profile or an unsubstituted `--relay "$UNSET"` wins a `??` chain with '' and the
 *  daemon dials nothing — the same typo-tolerance envNumber applies to numbers. */
function blankAsUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** A JSON object (not null, not an array): the only shape the config file and its `env` block
 *  are read from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// What `cctl settings set` may persist, and how each value is checked
// ---------------------------------------------------------------------------

/** The relay's env var. Singled out because the relay has a field of its own in config.json
 *  (`relayUrl`, older than the `env` block) — `settings set` writes it there, and the reader
 *  folds an `env` entry by this name into the same field, so the relay is never persisted two
 *  ways that could disagree. */
const RELAY_ENV_NAME = 'CCTL_RELAY_URL';

/** How a value is checked before it is persisted. Each kind uses the SAME parser the daemon
 *  reads with, so `cctl settings set` can only store what the daemon will honor — a value the
 *  daemon would silently treat as unset is the one typo the file exists to protect from. */
export type SettingKind = 'bool' | 'number' | 'url' | 'log-level' | 'log-format' | 'path';

export interface DaemonEnvSetting {
  /** The env var name — also the key inside config.json's `env` block. */
  name: string;
  /** The short name typed on the command line (`fable-cap` for
   *  `CCTL_AUTOSWITCH_ON_FABLE_CAP`). Lower-case kebab; unique across the table and never
   *  equal to any env var name, so a ref can only ever mean one setting. */
  alias: string;
  kind: SettingKind;
}

/** Every daemon knob `cctl settings set` may persist. Names match the `detail` column of the
 *  daemon rows one for one (a test holds the two lists together), so `cctl settings` doubles
 *  as the list of what can be set. Engine and CLI-shell knobs (`CCTL_SWITCH_MIN_INTERVAL_MS`,
 *  `CCTL_REFRESH_SKEW_MS`, `NO_COLOR`) are deliberately absent: one-shot commands read them
 *  from the shell that runs them, where an env var is the natural home. */
export const DAEMON_ENV_SETTINGS: readonly DaemonEnvSetting[] = [
  { name: 'CCTL_AUTOSWITCH', alias: 'autoswitch', kind: 'bool' },
  { name: 'CCTL_AUTOSWITCH_GREEDY', alias: 'greedy', kind: 'bool' },
  { name: 'CCTL_AUTOSWITCH_ON_FABLE_CAP', alias: 'fable-cap', kind: 'bool' },
  { name: 'CCTL_AUTOSWITCH_TRIGGER_PCT', alias: 'trigger', kind: 'number' },
  { name: 'CCTL_AUTOSWITCH_STALE_TRIGGER_PCT', alias: 'stale-trigger', kind: 'number' },
  { name: 'CCTL_AUTOSWITCH_STALE_AFTER_MS', alias: 'stale-after', kind: 'number' },
  { name: 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT', alias: 'min-session-left', kind: 'number' },
  { name: 'CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS', alias: 'greedy-margin', kind: 'number' },
  { name: 'CCTL_AUTOSWITCH_COOLDOWN_MS', alias: 'cooldown', kind: 'number' },
  { name: 'CCTL_WAITING_CARDS', alias: 'waiting-cards', kind: 'bool' },
  { name: 'CCTL_PERMISSION_HOLD_MS', alias: 'permission-hold', kind: 'number' },
  { name: 'CCTL_QUESTION_HOLD_MS', alias: 'question-hold', kind: 'number' },
  { name: 'CCTL_COMMAND_OUTPUT', alias: 'command-output', kind: 'bool' },
  { name: 'CCTL_IDENTITY_CHECK', alias: 'identity-check', kind: 'bool' },
  { name: 'CCTL_TOOL_OUTPUT_FULL', alias: 'full-output', kind: 'bool' },
  { name: RELAY_ENV_NAME, alias: 'relay', kind: 'url' },
  { name: 'CCTL_LOG_LEVEL', alias: 'log-level', kind: 'log-level' },
  { name: 'CCTL_LOG_FORMAT', alias: 'log-format', kind: 'log-format' },
  { name: 'CCTL_LOG_FILE', alias: 'log-file', kind: 'path' },
];

/** Look a setting up by alias or env var name, case-insensitively and with `_`/`-` read as
 *  the same character: `fable-cap`, `FABLE_CAP` and `cctl_autoswitch_on_fable_cap` are all too
 *  easy to type to refuse over spelling. */
export function findDaemonEnvSetting(ref: string): DaemonEnvSetting | undefined {
  const trimmed = ref.trim();
  const name = trimmed.toUpperCase().replace(/-/g, '_');
  const alias = trimmed.toLowerCase().replace(/_/g, '-');
  return DAEMON_ENV_SETTINGS.find((s) => s.name === name || s.alias === alias);
}

/** One line naming every settable knob as `alias (ENV_NAME)`, for help and error text. */
export function settableSettingsSummary(): string {
  return DAEMON_ENV_SETTINGS.map((s) => `${s.alias} (${s.name})`).join(', ');
}

/** The lines `cctl settings set` prints once the value is on disk. The assignment is the
 *  outcome, so it alone is painted (green: done, nothing further owed); the path says where to
 *  look and the caveat what to do next, and both stay plain so the eye lands on the result.
 *  Plain by default — piped output and the tests see exact strings. */
export function renderSettingSaved(
  setting: DaemonEnvSetting,
  value: string,
  filePath: string,
  palette: Palette = PLAIN_PALETTE,
): string {
  return (
    `${palette.green(`Saved ${setting.name}=${value}`)} to ${filePath}.\n` +
    'Applies when the daemon next starts: cctl daemon restart. A value set in the ' +
    'environment still wins over the file.\n'
  );
}

/** The line `cctl settings unset` prints. A removal is painted like a save — the file changed
 *  as asked — while "not set" stays plain: nothing changed and nothing needs doing. */
export function renderSettingForgotten(
  setting: DaemonEnvSetting,
  filePath: string,
  removed: boolean,
  palette: Palette = PLAIN_PALETTE,
): string {
  return removed
    ? `${palette.green(`Removed ${setting.name}`)} from ${filePath}; the daemon falls back to ` +
        'the environment or the default when it next starts: cctl daemon restart.\n'
    : `${setting.name} is not set in ${filePath}.\n`;
}

/** pino's level names, which `CCTL_LOG_LEVEL` is handed to verbatim — an unknown one would
 *  throw at logger construction, which for a persisted value means at every daemon start. */
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

export type SettingValueCheck = { ok: true; value: string } | { ok: false; message: string };

/** Check a value the way the daemon will read it. Returns the text to persist (trimmed, and
 *  lower-cased where the reader is case-sensitive), or the reason it would be ignored. */
export function checkSettingValue(setting: DaemonEnvSetting, raw: string): SettingValueCheck {
  const value = raw.trim();
  const probe: NodeJS.ProcessEnv = { [setting.name]: value };
  switch (setting.kind) {
    case 'bool':
      return envBool(probe, setting.name) === undefined
        ? {
            ok: false,
            message: `${setting.name} takes on or off (also 1/0, true/false, yes/no), not "${raw}"`,
          }
        : { ok: true, value };
    case 'number':
      return envNumber(probe, setting.name) === undefined
        ? { ok: false, message: `${setting.name} takes a non-negative number, not "${raw}"` }
        : { ok: true, value };
    case 'url':
      return /^wss?:\/\/\S+$/i.test(value)
        ? { ok: true, value }
        : { ok: false, message: `${setting.name} takes a ws:// or wss:// url, not "${raw}"` };
    case 'log-level':
      return LOG_LEVELS.includes(value.toLowerCase())
        ? { ok: true, value: value.toLowerCase() }
        : {
            ok: false,
            message: `${setting.name} takes one of ${LOG_LEVELS.join(', ')}, not "${raw}"`,
          };
    case 'log-format':
      return value.toLowerCase() === 'json' || value.toLowerCase() === 'pretty'
        ? { ok: true, value: value.toLowerCase() }
        : { ok: false, message: `${setting.name} takes json or pretty, not "${raw}"` };
    case 'path':
      return value === ''
        ? { ok: false, message: `${setting.name} takes a file path` }
        : { ok: true, value };
  }
}

// ---------------------------------------------------------------------------
// The operator's config file (persisted overrides)
// ---------------------------------------------------------------------------

/** Persisted env-style overrides, keyed by the env var each one stands in for. */
export type FileEnv = Record<string, string>;

/** Lay `fileEnv` UNDER `env`: a name set (non-blank) in the real environment shadows the file
 *  entirely — even an unparseable value, which then falls to the default exactly as it does
 *  without a file — so "the environment always wins" holds with no exceptions to learn.
 *  Returns a fresh object; `env` is left alone. */
export function layerFileEnv(env: NodeJS.ProcessEnv, fileEnv: FileEnv = {}): NodeJS.ProcessEnv {
  return applyFileEnv({ ...env }, fileEnv);
}

/** The in-place form of `layerFileEnv`, for the daemon's own `process.env`: every module that
 *  reads the environment directly (the logger, the engine's cadence guard) then sees the
 *  persisted overrides too, not only the knobs `resolveDaemonConfig` wires by hand. */
export function applyFileEnv(env: NodeJS.ProcessEnv, fileEnv: FileEnv = {}): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(fileEnv)) {
    if (blankAsUnset(env[name]) === undefined) env[name] = value;
  }
  return env;
}

/** Settings an operator persists on this machine. Every field is optional: the file exists to
 *  override selected defaults, never to restate them. */
export interface DaemonFileConfig {
  /** The relay to dial. The reason this file exists: a published build bakes one default
   *  relay URL, and a self-hoster must be able to point at their own without a rebuild. */
  relayUrl?: string;
  /** Overrides written by `cctl settings set`, keyed by the env var each stands in for
   *  (`"CCTL_AUTOSWITCH": "off"`). Read UNDER the real environment (`layerFileEnv`), so a
   *  shell or task-level env var still wins. Values are stored exactly as an env var would
   *  carry them and parsed by the same code, so the file can never mean something the env
   *  could not. Only the names in `DAEMON_ENV_SETTINGS` are read; anything else is ignored. */
  env?: FileEnv;
}

/** Where the operator's config lives: beside the vault, like daemon.db. Distinct from
 *  `daemonSettingsPath` — this one is read, that one is written. */
export function daemonConfigPath(paths: Paths = defaultPaths()): string {
  return join(dirname(paths.vaultDir), 'config.json');
}

/** Reads the operator's config file. Missing, unreadable, corrupt, or wrong-shaped content
 *  degrades to `undefined` — the same typo-tolerance stance as `envNumber`: a malformed
 *  config falling back to the default beats a daemon that refuses to start. A blank or
 *  whitespace-only `relayUrl` counts as unset rather than as an empty URL, and the `env`
 *  block is taken one entry at a time (`readFileEnv`), so one odd entry costs only itself. */
export async function readDaemonConfigFile(
  filePath: string,
): Promise<DaemonFileConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const config: DaemonFileConfig = {};
  const env = readFileEnv(parsed['env']);
  // The relay's own field wins; an `env` entry by its name (only a hand edit puts one there)
  // is folded into the same field rather than dropped, then removed from the block so the
  // relay resolves through exactly one path.
  const relayRaw = parsed['relayUrl'];
  const relayUrl =
    blankAsUnset(typeof relayRaw === 'string' ? relayRaw : undefined) ?? env?.[RELAY_ENV_NAME];
  if (relayUrl !== undefined) config.relayUrl = relayUrl;
  if (env !== undefined) {
    delete env[RELAY_ENV_NAME];
    if (Object.keys(env).length > 0) config.env = env;
  }
  return config;
}

/** The `env` block: known names with string values only, blank ones dropped (an absent
 *  override, as in the environment itself), everything else ignored. Names are normalized to
 *  the upper case the daemon reads. */
function readFileEnv(raw: unknown): FileEnv | undefined {
  if (!isRecord(raw)) return undefined;
  const env: FileEnv = {};
  for (const [name, value] of Object.entries(raw)) {
    const setting = findDaemonEnvSetting(name);
    if (setting === undefined || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') env[setting.name] = trimmed;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/**
 * Read-modify-write config.json under an atomic replace, keeping every other key exactly as
 * it was — including ones this build does not know, so a newer build's settings survive an
 * older CLI touching the file. `mutate` returns whether anything changed; nothing is written
 * (and no file is created) when it did not. Refuses, rather than overwrites, a file that
 * exists but is not a JSON object: the daemon ignores such a file, but a `set` that quietly
 * replaced it would destroy whatever the operator had been editing.
 */
export async function updateDaemonConfigFile(
  filePath: string,
  mutate: (config: Record<string, unknown>) => boolean,
): Promise<boolean> {
  let raw: string | undefined;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let config: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${filePath} is not valid JSON; fix or delete it, then retry`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`${filePath} does not hold a JSON object; fix or delete it, then retry`);
    }
    config = parsed;
  }
  if (!mutate(config)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/** Drop every `env`-block entry that READS as `setting` — the canonical name and any
 *  hand-written spelling the reader also accepts (an alias, another case). Removing only the
 *  canonical key would leave such an entry in force while `unset` reported it gone, and a
 *  `set` would sit beside it with the reader free to pick either. Returns whether anything
 *  was removed; an emptied block is deleted so the file returns to what it was before the
 *  first `set`, not to a leftover `"env": {}`. */
function dropEnvEntries(config: Record<string, unknown>, setting: DaemonEnvSetting): boolean {
  const env = config['env'];
  if (!isRecord(env)) return false;
  const matching = Object.keys(env).filter((k) => findDaemonEnvSetting(k)?.name === setting.name);
  for (const k of matching) delete env[k];
  if (Object.keys(env).length === 0) delete config['env'];
  return matching.length > 0;
}

/** Persist one setting: the relay into its own `relayUrl` field, everything else into the
 *  `env` block under its env var name. Any other spelling of the same setting already in the
 *  block goes, so the file holds one entry per setting. `value` must already have passed
 *  `checkSettingValue`. */
export async function persistDaemonSetting(
  filePath: string,
  setting: DaemonEnvSetting,
  value: string,
): Promise<void> {
  await updateDaemonConfigFile(filePath, (config) => {
    dropEnvEntries(config, setting);
    if (setting.name === RELAY_ENV_NAME) {
      config['relayUrl'] = value;
      return true;
    }
    const env = isRecord(config['env']) ? config['env'] : {};
    env[setting.name] = value;
    config['env'] = env;
    return true;
  });
}

/** Remove a persisted setting wherever the reader would find it. Resolves to whether there was
 *  one to remove; a no-op never touches the disk, so asking about a setting that was never
 *  stored creates no file. */
export async function forgetDaemonSetting(
  filePath: string,
  setting: DaemonEnvSetting,
): Promise<boolean> {
  return updateDaemonConfigFile(filePath, (config) => {
    // Both homes, deliberately: the reader folds an env-block relay entry into `relayUrl`, so
    // clearing the field alone would let a hand-written entry resurface as the live relay.
    const droppedEnv = dropEnvEntries(config, setting);
    if (setting.name === RELAY_ENV_NAME && config['relayUrl'] !== undefined) {
      delete config['relayUrl'];
      return true;
    }
    return droppedEnv;
  });
}

// ---------------------------------------------------------------------------
// Daemon configuration (flags + env + config file), resolved once
// ---------------------------------------------------------------------------

/** The daemon-run flags that shape settings. Tri-state booleans: true = the positive flag,
 *  false = its --no- negation, absent = neither passed (env or the default decides). */
export interface DaemonRunFlags {
  autoSwitch?: boolean;
  greedy?: boolean;
  relay?: string;
}

/** The values daemonRun.ts actually wires (undefined = let the owning module default),
 *  plus the display rows derived from the SAME resolution. */
export interface DaemonConfig {
  values: {
    relayUrl: string;
    autoSwitch: boolean;
    greedy: boolean;
    autoSwitchOnFableCap: boolean;
    triggerPercent: number | undefined;
    staleTriggerPercent: number | undefined;
    staleAfterMs: number | undefined;
    minSessionHeadroomPct: number | undefined;
    greedyResetMarginMs: number | undefined;
    cooldownMs: number | undefined;
    waitingCards: boolean;
    permissionHoldMs: number | undefined;
    questionHoldMs: number | undefined;
    commandOutputCards: boolean;
    fullToolOutput: boolean;
    identityCheck: boolean;
  };
  rows: SettingRow[];
}

/**
 * Resolve every daemon knob from flags (highest precedence), then env, then the operator's
 * config file, then defaults. Called with real flags by `cctl daemon run`, and with no flags
 * by `cctl settings` to preview what a plain daemon start would use from this shell's
 * environment.
 *
 * Deliberately PURE and synchronous: the caller reads `config.json` (see
 * `readDaemonConfigFile`) and passes the result in, so this function stays fully testable
 * without touching a filesystem, and display can never diverge from behavior.
 */
export function resolveDaemonConfig(
  env: NodeJS.ProcessEnv,
  flags: DaemonRunFlags = {},
  fileConfig: DaemonFileConfig = {},
): DaemonConfig {
  // The file's env block sits UNDER the real environment (`layerFileEnv`): every knob below
  // reads the layered view, and `sourceOf` names the layer that actually supplied it.
  const fileEnv = fileConfig.env ?? {};
  const layered = layerFileEnv(env, fileEnv);
  /** Attribution for a knob read from `layered`: the environment when it set the name
   *  (non-blank), else the file, else — an unparseable override included — the default. */
  const sourceOf = (name: string, parsed: boolean): SettingSource => {
    if (!parsed) return 'default';
    if (blankAsUnset(env[name]) !== undefined) return 'env';
    return name in fileEnv ? 'config' : 'default';
  };
  // Both default ON (flag > env > file > default): a flag-less `daemon run` — which is exactly
  // what the installed logon task executes — hops when the active account runs low and burns
  // expiring weekly budget first. Opt out per run with --no-auto-switch / --no-greedy, or
  // persistently for an installed daemon (whose task carries no flags) with
  // `cctl settings set CCTL_AUTOSWITCH off` / `CCTL_AUTOSWITCH_GREEDY off`.
  const autoSwitchEnv = envBool(layered, 'CCTL_AUTOSWITCH');
  const autoSwitch = flags.autoSwitch ?? autoSwitchEnv ?? true;
  const greedyEnv = envBool(layered, 'CCTL_AUTOSWITCH_GREEDY');
  const greedy = flags.greedy ?? greedyEnv ?? true;
  // Default ON: a full Fable weekly cap counts as the wall, because the sessions the daemon
  // keeps alive mostly run Fable. Off for an operator on other models, whose account still
  // has every other budget left when that cap fills.
  const fableCapEnv = envBool(layered, 'CCTL_AUTOSWITCH_ON_FABLE_CAP');
  const autoSwitchOnFableCap = fableCapEnv ?? true;
  const triggerPercent = envNumber(layered, 'CCTL_AUTOSWITCH_TRIGGER_PCT');
  const staleTriggerPercent = envNumber(layered, 'CCTL_AUTOSWITCH_STALE_TRIGGER_PCT');
  const staleAfterMs = envNumber(layered, 'CCTL_AUTOSWITCH_STALE_AFTER_MS');
  const minSessionHeadroomPct = envNumber(layered, 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT');
  const greedyResetMarginMs = envNumber(layered, 'CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS');
  const cooldownMs = envNumber(layered, 'CCTL_AUTOSWITCH_COOLDOWN_MS');
  // A blank override is an ABSENT override, not an empty relay url. `CCTL_RELAY_URL=` left in a
  // shell profile, or `--relay "$SOMETHING_UNSET"` in a wrapper script, would otherwise win the
  // `??` chain with '' and send the daemon to dial nothing — while the settings view reported
  // the blank as the effective value.
  const relayFlag = blankAsUnset(flags.relay);
  const relayEnv = blankAsUnset(env['CCTL_RELAY_URL']);
  const relayFile = blankAsUnset(fileConfig.relayUrl);
  const relayUrl = relayFlag ?? relayEnv ?? relayFile ?? DEFAULT_RELAY_URL;
  // Attribute to the source that actually WON, so a config file that is being shadowed by an
  // env var reads as 'env' rather than misleadingly claiming the file is in effect — and a
  // blank source is skipped here too, matching what actually got used.
  const relaySource: SettingSource =
    relayFlag !== undefined
      ? 'flag'
      : relayEnv !== undefined
        ? 'env'
        : relayFile !== undefined
          ? 'config'
          : 'default';
  // Default OFF: the CLI's Notification hook nags ("Claude is waiting for your input…")
  // duplicate the real permission/done cards on the phone.
  const waitingCards = envFlag(layered, 'CCTL_WAITING_CARDS');
  // The hook contract offers ONE decision channel: while a permission is held for a remote
  // decision the terminal cannot prompt. A shorter hold favors keyboard-first use.
  const permissionHoldMs = envNumber(layered, 'CCTL_PERMISSION_HOLD_MS');
  // Questions (AskUserQuestion) share the permission hold's tradeoff but not necessarily its
  // tuning: a question is usually mid-flow, so an operator may want the terminal picker back
  // sooner than they want permission prompts back. Falls back to the permission hold.
  const questionHoldMs = envNumber(layered, 'CCTL_QUESTION_HOLD_MS');
  // Default ON: a remote operator can't see the terminal, so every shell command's output is
  // pushed as a card in every permission mode; `off` silences chatty sessions.
  const commandOutputEnv = envBool(layered, 'CCTL_COMMAND_OUTPUT');
  const commandOutputCards = commandOutputEnv ?? true;
  // Default OFF: cards ship a phone-sized excerpt; full output arrives as a file attachment.
  const fullToolOutput = envFlag(layered, 'CCTL_TOOL_OUTPUT_FULL');
  // Default ON: each poll verifies the vault token's OWNER against the OAuth profile
  // endpoint and quarantines on mismatch — the guard against a bundle silently holding
  // another account's credentials. The free local row-vs-bundle check runs regardless.
  const identityCheckEnv = envBool(layered, 'CCTL_IDENTITY_CHECK');
  const identityCheck = identityCheckEnv ?? true;

  const rows: SettingRow[] = [
    {
      // Resolved by the daemon at startup, so via the report/snapshot this names the build
      // the RUNNING daemon is on — which can trail the CLI's after an npm update.
      name: 'daemon build',
      value: `v${VERSION}`,
      source: 'default',
      detail: 'update: npm i -g @andrewtjin/cctl, then cctl daemon restart',
    },
    {
      name: 'auto-switch',
      value: autoSwitch ? 'on' : 'off',
      source:
        flags.autoSwitch !== undefined
          ? 'flag'
          : sourceOf('CCTL_AUTOSWITCH', autoSwitchEnv !== undefined),
      detail: '--[no-]auto-switch or CCTL_AUTOSWITCH (on by default)',
    },
    {
      name: 'greedy burn-back',
      // Greedy without auto-switch does nothing — say so rather than show a lying "on".
      value: greedy ? (autoSwitch ? 'on' : 'on (inactive: auto-switch is off)') : 'off',
      source:
        flags.greedy !== undefined
          ? 'flag'
          : sourceOf('CCTL_AUTOSWITCH_GREEDY', greedyEnv !== undefined),
      detail: '--[no-]greedy or CCTL_AUTOSWITCH_GREEDY (on by default)',
    },
    {
      name: 'fable cap trigger',
      value: autoSwitchOnFableCap ? 'on' : 'off',
      source: sourceOf('CCTL_AUTOSWITCH_ON_FABLE_CAP', fableCapEnv !== undefined),
      detail:
        'CCTL_AUTOSWITCH_ON_FABLE_CAP (off: a full Fable weekly cap alone never triggers a hop; the shared weekly budget and the 5h window still do)',
    },
    {
      name: 'switch trigger',
      value: `${triggerPercent ?? DEFAULT_TRIGGER_PERCENT}% used`,
      source: sourceOf('CCTL_AUTOSWITCH_TRIGGER_PCT', triggerPercent !== undefined),
      detail: 'CCTL_AUTOSWITCH_TRIGGER_PCT',
    },
    {
      name: 'stale switch trigger',
      // Mirrors the policy's clamp (stale can only tighten the bar) so the view shows the
      // threshold that will actually fire, not a raw override the policy would ignore.
      value: `${Math.min(
        staleTriggerPercent ?? DEFAULT_STALE_TRIGGER_PERCENT,
        triggerPercent ?? DEFAULT_TRIGGER_PERCENT,
      )}% used`,
      source: sourceOf('CCTL_AUTOSWITCH_STALE_TRIGGER_PCT', staleTriggerPercent !== undefined),
      detail: 'CCTL_AUTOSWITCH_STALE_TRIGGER_PCT (tightened trigger while usage data is stale)',
    },
    {
      name: 'stale snapshot age',
      value: humanizeMs(staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
      source: sourceOf('CCTL_AUTOSWITCH_STALE_AFTER_MS', staleAfterMs !== undefined),
      detail: 'CCTL_AUTOSWITCH_STALE_AFTER_MS (usage data older than this counts as stale)',
    },
    {
      name: 'min session headroom',
      value: `${minSessionHeadroomPct ?? DEFAULT_MIN_SESSION_HEADROOM_PCT}% left`,
      source: sourceOf('CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT', minSessionHeadroomPct !== undefined),
      detail: 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT',
    },
    {
      name: 'greedy reset margin',
      value: humanizeMs(greedyResetMarginMs ?? DEFAULT_GREEDY_RESET_MARGIN_MS),
      source: sourceOf('CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS', greedyResetMarginMs !== undefined),
      detail:
        'CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS (weekly resets closer than this count as the same deadline - no greedy hop)',
    },
    {
      name: 'auto-switch cooldown',
      value: humanizeMs(cooldownMs ?? DEFAULT_AUTOSWITCH_COOLDOWN_MS),
      source: sourceOf('CCTL_AUTOSWITCH_COOLDOWN_MS', cooldownMs !== undefined),
      detail: 'CCTL_AUTOSWITCH_COOLDOWN_MS',
    },
    {
      name: 'waiting cards',
      value: waitingCards ? 'on' : 'off',
      // Attributed by PRESENCE of a parsed override, like every other row — an explicit "off"
      // from the file or the environment is an override that happens to equal the default,
      // and must say where it came from, not read as if nothing were set.
      source: sourceOf('CCTL_WAITING_CARDS', envBool(layered, 'CCTL_WAITING_CARDS') !== undefined),
      detail: 'CCTL_WAITING_CARDS ("Claude is waiting..." terminal nags as phone cards)',
    },
    {
      name: 'permission hold',
      value: `${Math.round((permissionHoldMs ?? DEFAULT_PERMISSION_HOLD_MS) / 1000)}s`,
      source: sourceOf('CCTL_PERMISSION_HOLD_MS', permissionHoldMs !== undefined),
      detail: 'CCTL_PERMISSION_HOLD_MS (remote-decision window; local prompt appears after)',
    },
    {
      name: 'question hold',
      value: `${Math.round((questionHoldMs ?? permissionHoldMs ?? DEFAULT_PERMISSION_HOLD_MS) / 1000)}s`,
      source: sourceOf('CCTL_QUESTION_HOLD_MS', questionHoldMs !== undefined),
      detail:
        'CCTL_QUESTION_HOLD_MS (remote-answer window for questions; terminal picker appears after)',
    },
    {
      name: 'command output cards',
      value: commandOutputCards ? 'on' : 'off',
      source: sourceOf('CCTL_COMMAND_OUTPUT', commandOutputEnv !== undefined),
      detail: "CCTL_COMMAND_OUTPUT (every shell command's output as a phone card; off silences)",
    },
    {
      name: 'identity check',
      value: identityCheck ? 'on' : 'off',
      source: sourceOf('CCTL_IDENTITY_CHECK', identityCheckEnv !== undefined),
      detail:
        'CCTL_IDENTITY_CHECK (verify each vault token really belongs to its account per poll; quarantine on mismatch)',
    },
    {
      name: 'full tool output',
      value: fullToolOutput ? 'on' : 'off',
      source: sourceOf(
        'CCTL_TOOL_OUTPUT_FULL',
        envBool(layered, 'CCTL_TOOL_OUTPUT_FULL') !== undefined,
      ),
      detail:
        'CCTL_TOOL_OUTPUT_FULL (the attached output.txt carries the complete output instead of the phone-sized excerpt)',
    },
    {
      name: 'relay url',
      value: relayUrl,
      source: relaySource,
      detail: '--relay, CCTL_RELAY_URL, or relayUrl in config.json',
    },
    {
      name: 'daemon log level',
      value: layered['CCTL_LOG_LEVEL'] ?? 'info',
      source: sourceOf('CCTL_LOG_LEVEL', layered['CCTL_LOG_LEVEL'] !== undefined),
      detail: 'CCTL_LOG_LEVEL (debug also prints the stack under every error line)',
    },
    {
      name: 'daemon log format',
      value: layered['CCTL_LOG_FORMAT'] ?? 'auto',
      source: sourceOf('CCTL_LOG_FORMAT', layered['CCTL_LOG_FORMAT'] !== undefined),
      detail: "CCTL_LOG_FORMAT ('pretty' or 'json'; auto is pretty on a terminal, json otherwise)",
    },
    {
      name: 'daemon log file',
      value: layered['CCTL_LOG_FILE'] ?? 'off',
      source: sourceOf('CCTL_LOG_FILE', layered['CCTL_LOG_FILE'] !== undefined),
      detail:
        'CCTL_LOG_FILE (path NDJSON logs are also appended to; an installed daemon has no console)',
    },
  ];

  return {
    values: {
      relayUrl,
      autoSwitch,
      greedy,
      autoSwitchOnFableCap,
      triggerPercent,
      staleTriggerPercent,
      staleAfterMs,
      minSessionHeadroomPct,
      greedyResetMarginMs,
      cooldownMs,
      waitingCards,
      permissionHoldMs,
      questionHoldMs,
      commandOutputCards,
      fullToolOutput,
      identityCheck,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------
// CLI-side settings (what one-shot `cctl` commands themselves honor)
// ---------------------------------------------------------------------------

/** Rows for the knobs the one-shot CLI honors. `colorOn` is passed in (not derived here)
 *  because it depends on the live stdout TTY, which only the program edge should touch. */
export function resolveCliSettings(env: NodeJS.ProcessEnv, colorOn: boolean): SettingRow[] {
  const cadence = envNumber(env, 'CCTL_SWITCH_MIN_INTERVAL_MS');
  const skew = envNumber(env, 'CCTL_REFRESH_SKEW_MS');
  const noColorSet = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  const effectiveCadence = cadence ?? DEFAULT_MIN_SWITCH_INTERVAL_MS;
  return [
    {
      name: 'cli build',
      value: `v${VERSION}`,
      source: 'default',
      detail: 'the build running this command (compare with daemon build below)',
    },
    {
      name: 'color',
      value: colorOn ? 'on' : 'off',
      // Color is off either because NO_COLOR asked for it (env) or because stdout is not a
      // TTY (the default TTY-detection behavior). This row is about stdout — the output a
      // command prints; error lines make the same decision for stderr on their own, so
      // `cctl x | less` can show a red error while this row says off.
      source: envSource(noColorSet),
      detail: 'NO_COLOR (on only when stdout is a terminal; error lines follow stderr)',
    },
    {
      name: 'switch cadence',
      value: effectiveCadence === 0 ? 'off' : `${humanizeMs(effectiveCadence)} between switches`,
      source: envSource(cadence !== undefined),
      detail: 'CCTL_SWITCH_MIN_INTERVAL_MS (0 disables; --force overrides once)',
    },
    {
      name: 'token refresh skew',
      value: humanizeMs(skew ?? DEFAULT_REFRESH_SKEW_MS),
      source: envSource(skew !== undefined),
      detail: 'CCTL_REFRESH_SKEW_MS',
    },
    {
      name: 'cli log level',
      value: env['CCTL_LOG_LEVEL'] ?? 'warn',
      source: envSource(env['CCTL_LOG_LEVEL'] !== undefined),
      detail: 'CCTL_LOG_LEVEL (debug also prints the stack under every error line)',
    },
    {
      name: 'cli log format',
      value: env['CCTL_LOG_FORMAT'] ?? 'auto',
      source: envSource(env['CCTL_LOG_FORMAT'] !== undefined),
      detail: "CCTL_LOG_FORMAT ('pretty' or 'json'; auto is pretty on a terminal, json otherwise)",
    },
    {
      name: 'cli log file',
      value: env['CCTL_LOG_FILE'] ?? 'off',
      source: envSource(env['CCTL_LOG_FILE'] !== undefined),
      detail: 'CCTL_LOG_FILE (path NDJSON logs are also appended to)',
    },
  ];
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/** A wire row plus what the CLI alone knows: `pending` is the value config.json will give this
 *  knob at the daemon's next start when that differs from what the running daemon reports.
 *  Display-only and never on the wire — the phone sees the daemon's own report. */
export type DisplayRow = SettingRow & { pending?: string };

export interface SettingsSection {
  title: string;
  rows: DisplayRow[];
}

/** Rows whose rendered value also depends on ANOTHER knob: the stale trigger is clamped to the
 *  switch trigger, and greedy renders as inactive while auto-switch is off. Named here so
 *  markPendingRestart can follow the dependency instead of guessing from the row alone. */
const ROW_DEPENDS_ON: Readonly<Record<string, readonly string[]>> = {
  'stale switch trigger': ['switch trigger'],
  'greedy burn-back': ['auto-switch'],
};

/**
 * Mark the daemon's reported rows with what config.json would change at its next start, so a
 * `cctl settings set` is visible the moment it is saved rather than only after a restart. The
 * comparison uses the file alone (`afterRestart` = the resolution with NO environment): a row
 * the running daemon took from the environment or a flag is never marked — nor a row whose
 * value depends on such a knob (see ROW_DEPENDS_ON): a restart through the logon task
 * inherits that environment again, so greedy stays inactive while auto-switch is off there.
 * A row is marked only when the file is involved on one side — it set the reported value
 * (`config`), or would set the next one, for the row or a knob it depends on — so a value
 * that merely renders differently across builds (the build row) never reads as pending,
 * while the stale trigger does when the file moves the switch trigger it is clamped to.
 * The daemon's own environment is unknowable from here; a value it reported as `default`
 * because an unparseable env override fell through would be marked as if the file applied,
 * which the restart then corrects — the honest limit of a view that cannot see that shell.
 */
export function markPendingRestart(
  reported: readonly SettingRow[],
  afterRestart: readonly SettingRow[],
): { rows: DisplayRow[]; pending: number } {
  const fileCanDecide = (row: SettingRow): boolean =>
    row.source === 'default' || row.source === 'config';
  const nextOf = (name: string): SettingRow | undefined =>
    afterRestart.find((r) => r.name === name);
  let pending = 0;
  const rows = reported.map((row): DisplayRow => {
    const inputs = [
      row,
      ...(ROW_DEPENDS_ON[row.name] ?? []).map((n) => reported.find((r) => r.name === n)),
    ];
    if (inputs.some((r) => r === undefined || !fileCanDecide(r))) return row;
    const next = nextOf(row.name);
    if (!next || next.value === row.value) return row;
    const fileInvolved = inputs.some(
      (r) => r?.source === 'config' || nextOf(r?.name ?? '')?.source === 'config',
    );
    if (!fileInvolved) return row;
    pending += 1;
    return { ...row, pending: next.value };
  });
  return { rows, pending };
}

/** The daemon section's title: when it started, and — if the file has changes it is not yet
 *  running with — how many and the one command that applies them. */
export function daemonSectionTitle(since: string, pending: number): string {
  if (pending === 0) return `daemon (effective since ${since})`;
  const noun = pending === 1 ? '1 setting changes' : `${pending} settings change`;
  return `daemon (effective since ${since}; ${noun} at its next start: cctl daemon restart)`;
}

/** Render sections as aligned `name  value  source  detail` tables. Pure and plain by
 *  default; a palette makes overrides pop (env/flag sources and "on" values) while default
 *  furniture recedes — padding is computed on plain text first, so styling never breaks
 *  alignment (see ansi.ts's zero-width Paint contract). */
export function renderSettings(
  sections: SettingsSection[],
  palette: Palette = PLAIN_PALETTE,
): string {
  const allRows = sections.flatMap((s) => s.rows);
  // A pending value rides in the value column as a plain-text suffix, so it is part of the
  // column's width; the suffix is painted separately below.
  const pendingSuffix = (row: DisplayRow): string =>
    row.pending !== undefined ? ` (${row.pending} after restart)` : '';
  const nameWidth = Math.max(0, ...allRows.map((r) => r.name.length));
  const valueWidth = Math.max(0, ...allRows.map((r) => r.value.length + pendingSuffix(r).length));
  const sourceWidth = Math.max(0, ...allRows.map((r) => r.source.length));

  const paintValue = (row: SettingRow): ((text: string) => string) => {
    if (row.value === 'on') return palette.green;
    if (row.value === 'off') return palette.dim;
    return (t) => t;
  };
  // The value cell: the effective value painted as usual, the pending note in the warning
  // color (something is saved that is not yet in force), the padding plain.
  const valueCell = (row: DisplayRow): string => {
    const suffix = pendingSuffix(row);
    const padding = ' '.repeat(valueWidth - row.value.length - suffix.length);
    return paintValue(row)(row.value) + (suffix ? palette.yellow(suffix) : '') + padding;
  };

  return sections
    .map((section) => {
      const lines = section.rows.map((row) => {
        // An explicit override (env or flag) is the thing this view exists to surface.
        const paintSource = row.source === 'default' ? palette.dim : palette.cyan;
        const detail =
          row.detail != null && row.detail !== '' ? `  ${palette.dim(row.detail)}` : '';
        return (
          `  ${row.name.padEnd(nameWidth)}  ` +
          `${valueCell(row)}  ` +
          `${paintSource(row.source.padEnd(sourceWidth))}${detail}`
        );
      });
      return [palette.bold(section.title), ...lines].join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// `cctl version` (pure)
// ---------------------------------------------------------------------------

/** Render `cctl version`: the build running this CLI, plus the daemon's build as of its last
 *  recorded start — reusing the exact report `cctl settings` already reads, rather than a
 *  second path to the same file. An npm update replaces the CLI's files immediately but an
 *  already-running daemon process keeps executing what it loaded at start, so the two can
 *  legitimately disagree; that skew is exactly what the warning line exists to catch. */
export function renderVersionInfo(cliVersion: string, report: SettingsReport | undefined): string {
  const cli = `v${cliVersion}`;
  const daemonBuild = report?.settings.find((r) => r.name === 'daemon build')?.value;
  if (daemonBuild === undefined) {
    return [`cli build: ${cli}`, 'daemon build: no daemon has run yet'].join('\n');
  }
  const lines = [`cli build: ${cli}`, `daemon build: ${daemonBuild}`];
  if (daemonBuild !== cli) {
    lines.push(
      'warning: the daemon is on a different build than this CLI - cctl daemon restart picks up the update.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The daemon's persisted effective-settings report
// ---------------------------------------------------------------------------

/** What the daemon resolved at startup — the same shape (and the same schema) as the
 *  `settings.snapshot` wire payload, so file and wire can never disagree. */
export type SettingsReport = SettingsSnapshot;

/** Where the report lives: beside the vault, like daemon.db. Holds values and sources only
 *  — never token material — so it needs no protection. */
export function daemonSettingsPath(paths: Paths = defaultPaths()): string {
  return join(dirname(paths.vaultDir), 'daemon-settings.json');
}

export async function writeSettingsReport(filePath: string, report: SettingsReport): Promise<void> {
  await writeFile(filePath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

/** Whether the report says greedy auto-switch was ACTIVE at the last daemon start (both the
 *  auto-switch and greedy rows resolved to exactly 'on' — an inactive greedy renders as
 *  'on (inactive: …)', which correctly fails this test). Used to phrase local plan advice
 *  consistently with the daemon's own; a stopped daemon makes this optimistically stale,
 *  which only affects wording, never the burn order itself. */
export function reportSaysGreedyActive(report: SettingsReport | undefined): boolean {
  if (!report) return false;
  const value = (name: string) => report.settings.find((r) => r.name === name)?.value;
  return value('auto-switch') === 'on' && value('greedy burn-back') === 'on';
}

/** Missing, corrupt, or foreign content degrades to `undefined` ("no daemon has reported")
 *  rather than crashing a purely informational view. */
export async function readSettingsReport(filePath: string): Promise<SettingsReport | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return SettingsSnapshot.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
