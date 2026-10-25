// The running daemon's live quiet-mode setting: the one knob that changes without a restart.
//
// The daemon's gates read it through `isQuiet()`; the phone's `/quiet` and the CLI's
// `cctl settings set|unset quiet` change it through `set()`. A change is applied in memory AND
// persisted through the same config.json writer `cctl settings set` uses, so it survives the next
// start. The settings report (daemon-settings.json, and the snapshot the phone reads) is rewritten
// with it, so `cctl settings` and `/settings` show the value actually in force.
//
// The one refusal that matters: when the daemon's own environment sets CCTL_DISCORD_QUIET, that
// value outranks config.json, so a live change would quietly revert at the next start. That is
// refused with the variable named, rather than applied for an afternoon and then lost. An unset is
// still carried out: removing a file entry the environment already overrides changes nothing in
// force now or at the next start, so there is nothing to refuse.

import type { QuietControl, QuietSetResult } from '@claude-control/daemon';
import {
  DEFAULT_DISCORD_QUIET,
  QUIET_ENV_NAME,
  discordQuietRow,
  findDaemonEnvSetting,
  forgetDaemonSetting,
  persistDaemonSetting,
  quietPinnedByEnv,
  writeSettingsReport,
  type SettingsReport,
} from './settings.js';

export interface QuietControlOptions {
  /** Quiet mode as resolved at startup. */
  quiet: boolean;
  /** The daemon's environment as it was BEFORE config.json was laid under it — the layer that
   *  pins the value. */
  shellEnv: NodeJS.ProcessEnv;
  /** config.json, written the way `cctl settings set` writes it. */
  configPath: string;
  /** The report as written at startup, and where it lives. */
  report: SettingsReport;
  reportPath: string;
  /** Told when the report file could not be rewritten. The change itself stands — the file is
   *  informational, and the snapshot the phone reads is already current. */
  onReportWriteError?: (err: unknown) => void;
}

/** Build the live control. Changes are serialized: two requests arriving together (a phone tap
 *  and a CLI command) each read the value the other left, so config.json and the report never
 *  interleave. */
export function createQuietControl(options: QuietControlOptions): QuietControl {
  const setting = findDaemonEnvSetting(QUIET_ENV_NAME);
  // The table and this module are in one package, so a miss is a build defect, not input.
  if (setting === undefined)
    throw new Error(`${QUIET_ENV_NAME} is missing from the settings table`);
  const pinned = quietPinnedByEnv(options.shellEnv);
  let quiet = options.quiet;
  let report: SettingsReport = { ...options.report, quiet };
  let queue: Promise<unknown> = Promise.resolve();

  const apply = async (value: boolean | undefined): Promise<QuietSetResult> => {
    if (pinned && value !== undefined) {
      return {
        ok: false,
        quiet,
        reason: 'env_pinned',
        message:
          `${QUIET_ENV_NAME} is set in the daemon's environment, which wins over config.json, so ` +
          'this change would be undone when the daemon next starts. Remove it from the ' +
          'environment the daemon starts in, restart the daemon, then try again.',
      };
    }
    let removed = false;
    try {
      if (value === undefined) removed = await forgetDaemonSetting(options.configPath, setting);
      else await persistDaemonSetting(options.configPath, setting, value ? 'on' : 'off');
    } catch (err) {
      return {
        ok: false,
        quiet,
        reason: 'persist_failed',
        message:
          `quiet mode could not be saved (${err instanceof Error ? err.message : String(err)}); ` +
          'nothing changed',
      };
    }
    // Pinned: only the file entry went; the environment's value is still the one in force, and the
    // row already names it.
    if (pinned) return { ok: true, quiet, changed: false, report, removed, pinned };
    const next = value ?? DEFAULT_DISCORD_QUIET;
    const changed = next !== quiet;
    quiet = next;
    const row = discordQuietRow(next, value === undefined ? 'default' : 'config');
    report = {
      ...report,
      quiet: next,
      settings: report.settings.map((r) => (r.name === row.name ? row : r)),
    };
    await writeSettingsReport(options.reportPath, report).catch((err: unknown) =>
      options.onReportWriteError?.(err),
    );
    return {
      ok: true,
      quiet: next,
      changed,
      report,
      ...(value === undefined ? { removed } : {}),
      pinned,
    };
  };

  return {
    isQuiet: () => quiet,
    set(value) {
      const result = queue.then(() => apply(value));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
