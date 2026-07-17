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
import { DEFAULT_AUTOSWITCH_COOLDOWN_MS } from '@claude-control/daemon';
import {
  DEFAULT_MIN_SESSION_HEADROOM_PCT,
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
    minSessionHeadroomPct: number | undefined;
    cooldownMs: number | undefined;
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
  const minSessionHeadroomPct = envNumber(env, 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT');
  const cooldownMs = envNumber(env, 'CCTL_AUTOSWITCH_COOLDOWN_MS');
  const relayEnv = env['CCTL_RELAY_URL'];
  const relayUrl = flags.relay ?? relayEnv ?? DEFAULT_RELAY_URL;

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
      name: 'min session headroom',
      value: `${minSessionHeadroomPct ?? DEFAULT_MIN_SESSION_HEADROOM_PCT}% left`,
      source: envSource(minSessionHeadroomPct !== undefined),
      detail: 'CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT',
    },
    {
      name: 'auto-switch cooldown',
      value: humanizeMs(cooldownMs ?? DEFAULT_AUTOSWITCH_COOLDOWN_MS),
      source: envSource(cooldownMs !== undefined),
      detail: 'CCTL_AUTOSWITCH_COOLDOWN_MS',
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
    values: { relayUrl, autoSwitch, greedy, triggerPercent, minSessionHeadroomPct, cooldownMs },
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
