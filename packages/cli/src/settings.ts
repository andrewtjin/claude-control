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

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SettingsSnapshot,
  type SettingRow,
  type SettingSource,
} from '@claude-control/shared-protocol';
import {
  DEFAULT_MIN_SWITCH_INTERVAL_MS,
  DEFAULT_REFRESH_SKEW_MS,
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

export const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8765';

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

// ---------------------------------------------------------------------------
// Daemon configuration (flags + env), resolved once
// ---------------------------------------------------------------------------

/** The daemon-run flags that shape settings. Absent flag = not passed. */
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
    triggerPercent: number | undefined;
    staleTriggerPercent: number | undefined;
    staleAfterMs: number | undefined;
    minSessionHeadroomPct: number | undefined;
    greedyResetMarginMs: number | undefined;
    cooldownMs: number | undefined;
    waitingCards: boolean;
    permissionHoldMs: number | undefined;
    commandOutputCards: boolean;
    fullToolOutput: boolean;
    identityCheck: boolean;
  };
  rows: SettingRow[];
}

/**
 * Resolve every daemon knob from flags (highest precedence), then env, then defaults.
 * Called with real flags by `cctl daemon run`, and with no flags by `cctl settings` to
 * preview what a plain daemon start would use from this shell's environment.
 */
export function resolveDaemonConfig(
  env: NodeJS.ProcessEnv,
  flags: DaemonRunFlags = {},
): DaemonConfig {
  const autoSwitch = flags.autoSwitch === true;
  const greedyFlag = flags.greedy === true;
  const greedyEnv = envFlag(env, 'CCTL_AUTOSWITCH_GREEDY');
  const greedy = greedyFlag || greedyEnv;
  const triggerPercent = envNumber(env, 'CCTL_AUTOSWITCH_TRIGGER_PCT');
  const staleTriggerPercent = envNumber(env, 'CCTL_AUTOSWITCH_STALE_TRIGGER_PCT');
  const staleAfterMs = envNumber(env, 'CCTL_AUTOSWITCH_STALE_AFTER_MS');
  const minSessionHeadroomPct = envNumber(env, 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT');
  const greedyResetMarginMs = envNumber(env, 'CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS');
  const cooldownMs = envNumber(env, 'CCTL_AUTOSWITCH_COOLDOWN_MS');
  const relayEnv = env['CCTL_RELAY_URL'];
  const relayUrl = flags.relay ?? relayEnv ?? DEFAULT_RELAY_URL;
  // Default OFF: the CLI's Notification hook nags ("Claude is waiting for your input…")
  // duplicate the real permission/done cards on the phone.
  const waitingCards = envFlag(env, 'CCTL_WAITING_CARDS');
  // The hook contract offers ONE decision channel: while a permission is held for a remote
  // decision the terminal cannot prompt. A shorter hold favors keyboard-first use.
  const permissionHoldMs = envNumber(env, 'CCTL_PERMISSION_HOLD_MS');
  // Default ON: a remote operator can't see the terminal, so every shell command's output is
  // pushed as a card in every permission mode; `off` silences chatty sessions.
  const commandOutputEnv = envBool(env, 'CCTL_COMMAND_OUTPUT');
  const commandOutputCards = commandOutputEnv ?? true;
  // Default OFF: cards ship a phone-sized excerpt; full output arrives as a file attachment.
  const fullToolOutput = envFlag(env, 'CCTL_TOOL_OUTPUT_FULL');
  // Default ON: each poll verifies the vault token's OWNER against the OAuth profile
  // endpoint and quarantines on mismatch — the guard against a bundle silently holding
  // another account's credentials. The free local row-vs-bundle check runs regardless.
  const identityCheckEnv = envBool(env, 'CCTL_IDENTITY_CHECK');
  const identityCheck = identityCheckEnv ?? true;

  const rows: SettingRow[] = [
    {
      name: 'auto-switch',
      value: autoSwitch ? 'on' : 'off',
      source: autoSwitch ? 'flag' : 'default',
      detail: '--auto-switch (per daemon run)',
    },
    {
      name: 'greedy burn-back',
      // Greedy without auto-switch does nothing — say so rather than show a lying "on".
      value: greedy ? (autoSwitch ? 'on' : 'on (inactive: needs --auto-switch)') : 'off',
      source: greedyFlag ? 'flag' : envSource(greedyEnv),
      detail: '--greedy or CCTL_AUTOSWITCH_GREEDY',
    },
    {
      name: 'switch trigger',
      value: `${triggerPercent ?? DEFAULT_TRIGGER_PERCENT}% used`,
      source: envSource(triggerPercent !== undefined),
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
      source: envSource(staleTriggerPercent !== undefined),
      detail: 'CCTL_AUTOSWITCH_STALE_TRIGGER_PCT (tightened trigger while usage data is stale)',
    },
    {
      name: 'stale snapshot age',
      value: humanizeMs(staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
      source: envSource(staleAfterMs !== undefined),
      detail: 'CCTL_AUTOSWITCH_STALE_AFTER_MS (usage data older than this counts as stale)',
    },
    {
      name: 'min session headroom',
      value: `${minSessionHeadroomPct ?? DEFAULT_MIN_SESSION_HEADROOM_PCT}% left`,
      source: envSource(minSessionHeadroomPct !== undefined),
      detail: 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT',
    },
    {
      name: 'greedy reset margin',
      value: humanizeMs(greedyResetMarginMs ?? DEFAULT_GREEDY_RESET_MARGIN_MS),
      source: envSource(greedyResetMarginMs !== undefined),
      detail:
        'CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS (weekly resets closer than this count as the same deadline - no greedy hop)',
    },
    {
      name: 'auto-switch cooldown',
      value: humanizeMs(cooldownMs ?? DEFAULT_AUTOSWITCH_COOLDOWN_MS),
      source: envSource(cooldownMs !== undefined),
      detail: 'CCTL_AUTOSWITCH_COOLDOWN_MS',
    },
    {
      name: 'waiting cards',
      value: waitingCards ? 'on' : 'off',
      source: envSource(waitingCards),
      detail: 'CCTL_WAITING_CARDS ("Claude is waiting..." terminal nags as phone cards)',
    },
    {
      name: 'permission hold',
      value: `${Math.round((permissionHoldMs ?? DEFAULT_PERMISSION_HOLD_MS) / 1000)}s`,
      source: envSource(permissionHoldMs !== undefined),
      detail: 'CCTL_PERMISSION_HOLD_MS (remote-decision window; local prompt appears after)',
    },
    {
      name: 'command output cards',
      value: commandOutputCards ? 'on' : 'off',
      source: envSource(commandOutputEnv !== undefined),
      detail: "CCTL_COMMAND_OUTPUT (every shell command's output as a phone card; off silences)",
    },
    {
      name: 'identity check',
      value: identityCheck ? 'on' : 'off',
      source: envSource(identityCheckEnv !== undefined),
      detail:
        'CCTL_IDENTITY_CHECK (verify each vault token really belongs to its account per poll; quarantine on mismatch)',
    },
    {
      name: 'full tool output',
      value: fullToolOutput ? 'on' : 'off',
      source: envSource(fullToolOutput),
      detail:
        'CCTL_TOOL_OUTPUT_FULL (the attached output.txt carries the complete output instead of the phone-sized excerpt)',
    },
    {
      name: 'relay url',
      value: relayUrl,
      source: flags.relay !== undefined ? 'flag' : envSource(relayEnv !== undefined),
      detail: '--relay or CCTL_RELAY_URL',
    },
    {
      name: 'daemon log level',
      value: env['CCTL_LOG_LEVEL'] ?? 'info',
      source: envSource(env['CCTL_LOG_LEVEL'] !== undefined),
      detail: 'CCTL_LOG_LEVEL',
    },
  ];

  return {
    values: {
      relayUrl,
      autoSwitch,
      greedy,
      triggerPercent,
      staleTriggerPercent,
      staleAfterMs,
      minSessionHeadroomPct,
      greedyResetMarginMs,
      cooldownMs,
      waitingCards,
      permissionHoldMs,
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
      name: 'color',
      value: colorOn ? 'on' : 'off',
      // Color is off either because NO_COLOR asked for it (env) or because stdout is not a
      // TTY (the default TTY-detection behavior).
      source: envSource(noColorSet),
      detail: 'NO_COLOR (on only for a terminal)',
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
      detail: 'CCTL_LOG_LEVEL',
    },
  ];
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

export interface SettingsSection {
  title: string;
  rows: SettingRow[];
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
  const nameWidth = Math.max(0, ...allRows.map((r) => r.name.length));
  const valueWidth = Math.max(0, ...allRows.map((r) => r.value.length));
  const sourceWidth = Math.max(0, ...allRows.map((r) => r.source.length));

  const paintValue = (row: SettingRow): ((text: string) => string) => {
    if (row.value === 'on') return palette.green;
    if (row.value === 'off') return palette.dim;
    return (t) => t;
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
          `${paintValue(row)(row.value.padEnd(valueWidth))}  ` +
          `${paintSource(row.source.padEnd(sourceWidth))}${detail}`
        );
      });
      return [palette.bold(section.title), ...lines].join('\n');
    })
    .join('\n\n');
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
