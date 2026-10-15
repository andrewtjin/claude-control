// Test-only: write the guard snapshot for a set of folder rules exactly as the engine writes it
// (buildFolderBindingSnapshot), with the global slot's identity block beside it. Suites that drive
// the real generated guard must feed it this shape: a hand-built snapshot missing the excluded
// identities or the account list sends every global-slot session down the guard's "cannot tell"
// fallback instead of the path production takes. Never imported by production code.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildFolderBindingSnapshot,
  type FolderRule,
  type StoredAccount,
} from '@claude-control/switch-engine';

/** The shared account the global slot holds in these fixtures. */
export const GLOBAL_ACCOUNT: StoredAccount = {
  id: 'personal',
  label: 'personal',
  accountUuid: 'uuid-personal',
  quarantined: false,
  createdAtMs: 1,
  updatedAtMs: 1,
};

/** A reserved row per included id, labelled by the id (the label is all the snapshot carries). */
function reservedRows(rules: readonly FolderRule[]): StoredAccount[] {
  const ids = [...new Set(rules.flatMap((r) => r.include))];
  return ids.map((id) => ({ ...GLOBAL_ACCOUNT, id, label: id, accountUuid: `uuid-${id}` }));
}

/**
 * Write the snapshot of `rules` to `snapshotPath`, and an identity file beside it saying the global
 * slot holds {@link GLOBAL_ACCOUNT}. Whether a global-slot session is refused or accepted then
 * follows from each rule's `exclude` list, as it does in production.
 */
export function writeGuardSnapshot(opts: {
  snapshotPath: string;
  mainConfigDir: string;
  rules: readonly FolderRule[];
  profileDirOf: (ruleId: string) => string;
}): void {
  const mainIdentityFile = join(dirname(opts.snapshotPath), 'main.claude.json');
  writeFileSync(
    mainIdentityFile,
    JSON.stringify({ oauthAccount: { accountUuid: GLOBAL_ACCOUNT.accountUuid } }),
  );
  const snapshot = buildFolderBindingSnapshot({
    rules: opts.rules,
    shared: [GLOBAL_ACCOUNT],
    reserved: reservedRows(opts.rules),
    generation: 1,
    enforce: 'block',
    mainConfigDir: opts.mainConfigDir,
    mainIdentityFile,
    profileDirOf: opts.profileDirOf,
  });
  writeFileSync(opts.snapshotPath, JSON.stringify(snapshot));
}
