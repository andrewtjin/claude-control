// Whether the running daemon can honor folder rules.
//
// A folder slot can hold a SHARED account (inherited while its included accounts are out, or in a
// folder that only excludes), and a daemon built before folder rules sees every shared account as
// fair game for the global slot. Such a daemon could auto-switch the global slot onto an account
// already live in a folder slot, leaving one login live in two places, where the second copy logs
// itself out on the next refresh. Reserved accounts are fenced from older builds (their rows live
// outside accounts.json), but nothing can fence an inherited one. So a rule change is refused while
// such a daemon runs, and `cctl doctor` flags the same skew.
//
// A daemon that honors folder rules says so in the settings report it writes at start (the row
// below). The test is "a LIVE daemon whose report lacks the row": a stopped daemon cannot switch
// anything, and a report outlives its daemon, so the heartbeat decides whether the report matters.
//
// Session alias rules get a row of their own. A rules file holding one is stamped with a schema a
// daemon built before them refuses to read, so such a daemon would stop maintaining every slot, and
// it would route a named session's phone spawn and background move by its folder alone. So an alias
// rule edit is refused while a live daemon's report lacks that row too.

import type { HeartbeatReading } from '@claude-control/daemon';
import { defaultInstallLookup } from './installLookup.js';
import type { SettingsReport } from './settings.js';

/** The settings-report row a daemon that honors folder rules writes. */
export const FOLDER_RULES_REPORT_ROW = 'folder rules';
export const FOLDER_RULES_SUPPORTED = 'supported';

/** The settings-report row a daemon that honors session alias rules writes (value
 *  {@link FOLDER_RULES_SUPPORTED}). */
export const SESSION_ALIAS_RULES_REPORT_ROW = 'session alias rules';

/** Whether the report carries a capability row saying `supported`. */
function reportSupports(report: SettingsReport | undefined, row: string): boolean {
  return (
    report?.settings.some((r) => r.name === row && r.value === FOLDER_RULES_SUPPORTED) ?? false
  );
}

/** Whether the report comes from a daemon that honors folder rules. */
export function reportSupportsFolderRules(report: SettingsReport | undefined): boolean {
  return reportSupports(report, FOLDER_RULES_REPORT_ROW);
}

/** Whether the report comes from a daemon that honors session alias rules. */
export function reportSupportsAliasRules(report: SettingsReport | undefined): boolean {
  return reportSupportsScope(report, 'alias');
}

/** Why the running daemon cannot be trusted with session alias rules (see
 *  {@link olderDaemonScopeReason}). */
export function olderDaemonAliasReason(
  report: SettingsReport | undefined,
  heartbeat: HeartbeatReading,
): string | undefined {
  return olderDaemonScopeReason('alias', report, heartbeat);
}

/** Why the running daemon cannot be trusted with folder rules, as one sentence ending in the fix, or
 *  undefined when it can (or when no daemon is running). A live daemon with no readable report at
 *  all is treated as older: the report is written at every start by builds that honor rules, so its
 *  absence is no evidence of support, and refusing costs one restart while trusting could cost a
 *  login. */
export function olderDaemonReason(
  report: SettingsReport | undefined,
  heartbeat: HeartbeatReading,
): string | undefined {
  if (heartbeat.state !== 'alive') return undefined;
  if (reportSupportsFolderRules(report)) return undefined;
  const build = report?.settings.find((r) => r.name === 'daemon build')?.value;
  return (
    `the running daemon${build !== undefined ? ` (${build})` : ''} predates folder rules: it could ` +
    'put an account live in a folder and in the global slot at once. Restart it on this build ' +
    'first: cctl daemon restart'
  );
}

// ---------------------------------------------------------------------------
// Parallel sessions (`cctl claude --account`)
// ---------------------------------------------------------------------------
//
// A rules file holding a parallel session is stamped with a schema no older build reads: an older
// daemon would stop maintaining every slot, and an older CLI would fail every command that reads the
// rules — including the `claude` the shell wrapper runs, in every terminal. So a parallel session is
// refused while a live daemon's report lacks the row below, and while an older install is the one
// that would next touch this vault: the `cctl` on PATH, or (with no daemon alive) the install the
// autostart registration starts.

/** The settings-report row a daemon that reads parallel sessions writes. */
export const SESSION_LEASES_REPORT_ROW = 'parallel sessions';

/** The kinds of rule an older daemon may not be able to read. */
export type GatedScope = 'alias' | 'lease';

/** The report row of each gated kind, and how its refusal names it. */
const GATED: Record<GatedScope, { row: string; name: string; harm: string }> = {
  alias: {
    row: SESSION_ALIAS_RULES_REPORT_ROW,
    name: 'session alias rules',
    harm: 'and would route a named session by its folder alone',
  },
  lease: {
    row: SESSION_LEASES_REPORT_ROW,
    name: 'parallel sessions',
    harm: 'and would stop maintaining every slot until restarted on this build',
  },
};

/** Whether the report comes from a daemon that reads this kind of rule. */
export function reportSupportsScope(report: SettingsReport | undefined, kind: GatedScope): boolean {
  return reportSupports(report, GATED[kind].row);
}

/** Why the running daemon cannot be trusted with this kind of rule, as one sentence ending in the
 *  fix, or undefined when it can (or when no daemon runs). A live daemon with no readable report is
 *  treated as older, as {@link olderDaemonReason} treats it. */
export function olderDaemonScopeReason(
  kind: GatedScope,
  report: SettingsReport | undefined,
  heartbeat: HeartbeatReading,
): string | undefined {
  if (heartbeat.state !== 'alive') return undefined;
  if (reportSupportsScope(report, kind)) return undefined;
  const build = report?.settings.find((r) => r.name === 'daemon build')?.value;
  const { name, harm } = GATED[kind];
  if (kind === 'alias') {
    return (
      `the running daemon${build !== undefined ? ` (${build})` : ''} predates ${name}: it cannot ` +
      `read a rules file that holds one, ${harm}. Restart it on this build first: cctl daemon restart`
    );
  }
  return (
    `the running daemon${build !== undefined ? ` (${build})` : ''} predates ${name}: it cannot ` +
    `read a rules file that holds one, ${harm}. Restart it first: cctl daemon restart`
  );
}

/** Where the cctl installs that could next touch this vault are, and what version each is. */
export interface InstallLookup {
  /** The `cctl` a shell runs (the first on PATH), or undefined when none is there. */
  onPath(): string | undefined;
  /** What the autostart registration starts, and what to call it, or undefined for none. */
  autostart(): { noun: string; execute: string } | undefined;
  /** The version of the cctl install a shim or entry script belongs to; undefined when it cannot
   *  be read. */
  versionOf(path: string): string | undefined;
}

/** A version as numbers, or undefined when it is not `major.minor.patch`. */
function versionParts(version: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `version` is older than `build`. An unreadable version is no evidence: false. */
function olderThan(version: string | undefined, build: string): boolean {
  const a = version === undefined ? undefined : versionParts(version);
  const b = versionParts(build);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/**
 * Why an older cctl install would break while a parallel session exists, as one sentence ending in
 * the fix, or undefined: the `cctl` on PATH (what the shell wrapper's `claude` runs), and — only when
 * no daemon is alive, since a live one was checked by its report — the install the autostart
 * registration starts. A version that cannot be read refuses nothing (doctor names it).
 */
export function olderInstallReason(
  ctx: { cliBuild: string; daemonAlive: boolean },
  lookup: InstallLookup = defaultInstallLookup(),
): string | undefined {
  const tail =
    'while one runs it cannot read the rules file, so every command it runs (including claude ' +
    'through the shell wrapper) would fail. Update that install first (npm i -g @andrewtjin/cctl)';
  const onPath = lookup.onPath();
  if (onPath !== undefined) {
    const version = lookup.versionOf(onPath);
    if (olderThan(version, ctx.cliBuild)) {
      return `the cctl at ${onPath} (v${version!.replace(/^v/, '')}) predates parallel sessions: ${tail}`;
    }
  }
  if (ctx.daemonAlive) return undefined;
  const auto = lookup.autostart();
  if (auto === undefined) return undefined;
  const version = lookup.versionOf(auto.execute);
  if (!olderThan(version, ctx.cliBuild)) return undefined;
  return (
    `the ${auto.noun} starts the cctl at ${auto.execute} (v${version!.replace(/^v/, '')}), which ` +
    'predates parallel sessions: while one runs, the daemon it starts cannot read the rules file ' +
    'and would maintain no slot at all. Update that install first (npm i -g @andrewtjin/cctl)'
  );
}
