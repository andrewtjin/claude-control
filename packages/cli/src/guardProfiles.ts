// Resolving the group-profile `settings.json` paths the enforcement guard must be propagated into.
//
// A group-slot session runs with CLAUDE_CONFIG_DIR pointed at its profile dir, so it reads THAT
// settings.json — not main's. The guard is installed into main and shared into a profile by a hard
// link that a temp+rename write to main severs, so the guard reconcile (see hookInstaller
// ensureBindGuard) re-links each profile settings.json to the guard-carrying main inode. This module
// computes which profile settings.json files that reconcile should touch, and is shared by the CLI
// bind/unbind path and the daemon's start-time reconcile so the two never diverge.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { profilesRoot, type FolderRule } from '@claude-control/switch-engine';

/** The settings.json inside a single rule profile dir (`<profilesRoot>/<ruleId>/settings.json`). */
function profileSettingsPath(vaultDir: string, ruleId: string): string {
  return join(profilesRoot(vaultDir), ruleId, 'settings.json');
}

/**
 * The profile settings.json paths the guard reconcile should touch.
 *
 * When rules exist, that is exactly the CURRENT rules' profiles — the guard must reach each. When
 * the last rule is removed (`hasBindings` false), the dissolved rule's profile dir is kept for
 * history and is no longer in the rule list, so a guard entry can be stranded in its
 * (severed) settings.json; we therefore scan the whole profiles root so the reconcile can clean every
 * profile, dissolved ones included. Best-effort: a missing/unreadable profiles root yields none.
 */
export function resolveGuardProfileSettingsPaths(
  vaultDir: string,
  rules: readonly Pick<FolderRule, 'id'>[],
  hasBindings: boolean,
): string[] {
  if (hasBindings) {
    return rules.map((r) => profileSettingsPath(vaultDir, r.id));
  }
  let entries: string[];
  try {
    entries = readdirSync(profilesRoot(vaultDir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return entries.map((name) => join(profilesRoot(vaultDir), name, 'settings.json'));
}
