// Discord quiet mode: what the daemon still sends to the phone when the operator wants prompts only.
//
// In quiet mode Discord carries the cards that can unblock a session (permission and question
// cards, their lapse edits, and the replies to the operator's own commands), the identity
// quarantine alert, and, for a phone-started session, one message per turn with Claude's final
// reply (or the reason the turn failed). Everything else that would post on its own — done cards,
// tool output, waiting nags, API-error cards, a managed session's tool and milestone lines, and the
// daemon's own fleet notices — stays off the phone.
//
// The setting can change on the running daemon (`/quiet`, `cctl settings set quiet`), so every gate
// reads it live through {@link QuietControl.isQuiet} rather than a value captured at start. The
// control itself is built by the composition root, which owns config.json and the settings report;
// this module is only the contract the daemon and the hook receiver depend on.

import type { PayloadOf, SettingsSnapshot } from '@claude-control/shared-protocol';

/** Why a live change was refused. `env_pinned`: the daemon's own environment sets the variable,
 *  which outranks config.json, so the change would silently revert at the next start.
 *  `persist_failed`: config.json could not be written, so the change would not survive a restart.
 *  `unsupported`: this daemon was built without a control (only a test harness is). */
export type QuietRefusal = 'env_pinned' | 'persist_failed' | 'unsupported';

/** Outcome of {@link QuietControl.set}. On success, `report` is the settings report with the quiet
 *  row and field rewritten, for the daemon to re-send so `/settings` and the bot's planner see the
 *  live value. `changed` is false when the value in force did not move (a repeat). For an unset,
 *  `removed` says whether config.json held a value to remove, and `pinned` that the environment
 *  sets the variable, so its value stays in force (only an unset succeeds while pinned). On a
 *  refusal `quiet` is the unchanged value, so a reply can say what still holds. */
export type QuietSetResult =
  | {
      ok: true;
      quiet: boolean;
      changed: boolean;
      report: SettingsSnapshot;
      removed?: boolean;
      pinned?: boolean;
    }
  | { ok: false; quiet: boolean; reason: QuietRefusal; message: string };

/** The live quiet-mode setting. */
export interface QuietControl {
  /** Whether Discord is in quiet mode right now. Cheap and synchronous: read on every hook. */
  isQuiet(): boolean;
  /** Change the value on the running daemon and persist it the way `cctl settings set` does.
   *  `undefined` forgets the persisted value, so the default applies (`cctl settings unset`). */
  set(value: boolean | undefined): Promise<QuietSetResult>;
}

/** The daemon's own unsolicited fleet notices that quiet mode keeps off the phone. Each is news
 *  about the fleet, not a request for the operator: auto-switch already acted, an outage opens and
 *  closes on its own, a folder slot alert repeats the usage view. The identity quarantine alert is
 *  deliberately absent — it is the one notice that needs a human (a re-login) before work can
 *  continue. Listed by notificationType so a notice added later is kept unless it is named here. */
export const QUIET_DROPPED_NOTICES: ReadonlySet<string> = new Set([
  'session_moved',
  'slot_alert',
  'usage_exhausted',
  'usage_restored',
  'usage_stall_resumed',
  'usage_stall_lost',
]);

/** Whether quiet mode drops this daemon-originated notice. Only a fleet notice qualifies; replies to
 *  the operator's own commands (the steering and channel notices that answer a `/say`) pass. */
export function quietDropsNotice(payload: PayloadOf<'hook.notification'>): boolean {
  return payload.notificationType != null && QUIET_DROPPED_NOTICES.has(payload.notificationType);
}
