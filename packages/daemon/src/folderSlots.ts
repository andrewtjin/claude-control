// Small shared views of the folder-rule registry for the daemon: the one registry picture the
// engine's pure pool functions take, built from the fleet the daemon already loaded each cycle, and
// a rule's name in words. Shared by the per-slot auto-switch and the per-scope outage log, so the
// two can never disagree about which accounts a slot draws from or what a folder is called.

import { slotMayHold } from '@claude-control/switch-engine';
import type { AccountView, FolderRule, RulesPicture, SlotId } from '@claude-control/switch-engine';

/** The registry picture the engine's pool functions (`slotMembers`, `slotMayHold`) read, from the
 *  whole fleet: a row tagged with rule ids is reserved, any other is shared. */
export function rulesPictureOf(
  accounts: readonly AccountView[],
  rules: readonly FolderRule[],
): RulesPicture {
  const reserved = (a: AccountView): boolean => a.ruleIds !== undefined && a.ruleIds.length > 0;
  return {
    shared: accounts.filter((a) => !reserved(a)),
    reserved: accounts.filter(reserved),
    rules,
  };
}

/** The accounts the global slot may switch to right now: the ones it may hold (the shared pool,
 *  never an account reserved to a folder) that are live in no folder slot. What the global slot's
 *  burn plan may name (see `AdvisorOptions.slotAccountIds`), so the plan the phone and `cctl
 *  timeline` show never announces a hop the global executor refuses. */
export function globalSlotAccountIds(
  accounts: readonly AccountView[],
  rules: readonly FolderRule[],
  liveSlots: ReadonlyMap<SlotId, string | null>,
): Set<string> {
  const picture = rulesPictureOf(accounts, rules);
  const liveInFolders = new Set(
    [...liveSlots].filter(([slot]) => slot !== 'global').map(([, id]) => id),
  );
  return new Set(
    accounts
      .filter((a) => slotMayHold('global', a.id, picture) && !liveInFolders.has(a.id))
      .map((a) => a.id),
  );
}

/** A rule in words: its folders, joined (what the operator acts on), or its label when it somehow
 *  has none recorded. The label alone would not do: it defaults to the folder, but can be anything. */
export function folderNameOf(rule: Pick<FolderRule, 'folders' | 'label'>): string {
  return rule.folders.length > 0 ? rule.folders.join(', ') : rule.label;
}
