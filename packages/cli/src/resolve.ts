// Resolve a user-supplied account reference to a stored account.
//
// Users type whatever is convenient — the exact id, or the label. We accept both, matching
// id first (unambiguous), then an exact label, then a case-insensitive label. Ambiguity
// (two accounts sharing a label under case-insensitive match) is reported rather than
// guessed, so a switch never targets the wrong account silently.

import type { StoredAccount } from '@claude-control/switch-engine';

export type ResolveResult =
  | { ok: true; account: StoredAccount }
  | { ok: false; reason: 'not_found' | 'ambiguous'; message: string };

/** Resolve `ref` (an id or a label) against the account list. */
export function resolveAccountRef(accounts: StoredAccount[], ref: string): ResolveResult {
  const byId = accounts.find((a) => a.id === ref);
  if (byId) return { ok: true, account: byId };

  const exactLabel = accounts.filter((a) => a.label === ref);
  if (exactLabel.length === 1) return { ok: true, account: exactLabel[0]! };
  if (exactLabel.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `"${ref}" matches ${exactLabel.length} accounts; use the id.`,
    };
  }

  const lower = ref.toLowerCase();
  const ciLabel = accounts.filter((a) => a.label.toLowerCase() === lower);
  if (ciLabel.length === 1) return { ok: true, account: ciLabel[0]! };
  if (ciLabel.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `"${ref}" matches ${ciLabel.length} accounts; use the id.`,
    };
  }

  return { ok: false, reason: 'not_found', message: `No account matches "${ref}".` };
}
