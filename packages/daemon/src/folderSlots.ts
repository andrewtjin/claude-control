// Small shared views of the folder-rule registry for the daemon: the one registry picture the
// engine's pure pool functions take, built from the fleet the daemon already loaded each cycle, and
// a rule's name in words. Shared by the per-slot auto-switch and the per-scope outage log, so the
// two can never disagree about which accounts a slot draws from or what a folder is called.

import type { AccountView, FolderRule, RulesPicture } from '@claude-control/switch-engine';

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

/** A rule in words: its folders, joined (what the operator acts on), or its label when it somehow
 *  has none recorded. The label alone would not do: it defaults to the folder, but can be anything. */
export function folderNameOf(rule: Pick<FolderRule, 'folders' | 'label'>): string {
  return rule.folders.length > 0 ? rule.folders.join(', ') : rule.label;
}
