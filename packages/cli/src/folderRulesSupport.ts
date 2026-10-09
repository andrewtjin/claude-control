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

import type { HeartbeatReading } from '@claude-control/daemon';
import type { SettingsReport } from './settings.js';

/** The settings-report row a daemon that honors folder rules writes. */
export const FOLDER_RULES_REPORT_ROW = 'folder rules';
export const FOLDER_RULES_SUPPORTED = 'supported';

/** Whether the report comes from a daemon that honors folder rules. */
export function reportSupportsFolderRules(report: SettingsReport | undefined): boolean {
  return (
    report?.settings.some(
      (r) => r.name === FOLDER_RULES_REPORT_ROW && r.value === FOLDER_RULES_SUPPORTED,
    ) ?? false
  );
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
