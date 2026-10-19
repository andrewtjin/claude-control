// Folder rules: the pure half of the slot model.
//
// Every slot draws its accounts from an EFFECTIVE POOL. The global slot's pool is the shared pool;
// a folder rule's pool is its own included accounts first, then the shared pool it inherits minus
// the accounts it excludes. On top of membership sits AVAILABILITY: an account live in another slot
// is in the pool but cannot be taken, because no account is ever live in two slots (a second live
// copy of a rotating refresh token logs itself out on the next refresh).
//
// Nothing here does IO. The engine reads one registry picture and the live occupancy of every slot,
// and these functions decide; that keeps every rule about who may go where in one place, testable
// without a vault, and shared verbatim by the engine's mutations, its invariant checker and the
// daemon-facing pool read.

import {
  aliasKey,
  canonicalStoredFolder,
  exactAliasBinding,
  exactBinding,
  resolveBinding,
  resolveSessionBinding,
  type ScopedGroup,
} from './folderPath.js';
import { ruleIdOfSlot, ruleSlotId } from './types.js';
import type {
  FolderRule,
  LeaseHolder,
  PoolEntry,
  SessionLease,
  SlotId,
  StoredAccount,
} from './types.js';

/** The id prefix of a parallel-session rule: `session-<accountId>`. Account ids are random UUIDs, so
 *  the id (and the profile dir it names) stays unguessable, and two terminals asking for the same
 *  account find the same rule. */
export const LEASE_RULE_PREFIX = 'session-';

/** The id of the parallel-session rule of an account. */
export function leaseRuleId(accountId: string): string {
  return `${LEASE_RULE_PREFIX}${accountId}`;
}

/** Whether a rule is a parallel-session slot rather than an operator's folder or alias rule. Every
 *  place that treats the two differently branches on this one predicate, so the compiler and a reader
 *  see each such place. */
export function isLeaseRule(rule: FolderRule): rule is FolderRule & { lease: SessionLease } {
  return rule.lease !== undefined;
}

/** The rules an operator made (folder and alias rules), without the parallel-session slots: what
 *  every rule listing, `where` and the rule verbs show and act on. */
export function operatorRules(rules: readonly FolderRule[]): FolderRule[] {
  return rules.filter((r) => !isLeaseRule(r));
}

/** Whether two holder records name the same process slot: same pid on the same machine, platform and
 *  pid namespace. A record on the same process with another start is that pid reused, so it is the
 *  same SLOT in the list, replaced rather than kept beside the new one. */
export function sameHolderProcess(a: LeaseHolder, b: LeaseHolder): boolean {
  return (
    a.pid === b.pid &&
    a.host === b.host &&
    a.platform === b.platform &&
    (a.pidNs ?? null) === (b.pidNs ?? null)
  );
}

/** Whether two holder records are the same process: {@link sameHolderProcess} and the same start. */
export function sameHolder(a: LeaseHolder, b: LeaseHolder): boolean {
  return sameHolderProcess(a, b) && a.start === b.start;
}

/** `holders` with `added` folded in, each added record replacing any on the same process slot (the
 *  later record wins), never appended beside it: a list on disk never names one process twice. */
export function withHolders(
  holders: readonly LeaseHolder[],
  added: readonly LeaseHolder[],
): LeaseHolder[] {
  let out = holders.slice();
  for (const h of added) {
    out = out.filter((x) => !sameHolderProcess(x, h));
    out.push(h);
  }
  return out;
}

/** `holders` without the ones `removed` names exactly (same process and same start): a record of a
 *  reused pid is someone else's and stays. */
export function withoutHolders(
  holders: readonly LeaseHolder[],
  removed: readonly LeaseHolder[],
): LeaseHolder[] {
  return holders.filter((h) => !removed.some((r) => sameHolder(h, r)));
}

/** Who a parallel session is in use by, counted the way a person would: terminals and background
 *  sessions. A terminal is each launcher, and each Claude Code (or process found running on the
 *  profile) whose launcher is not among the holders: one whose terminal was killed under it still
 *  runs where that terminal was. A background session is a worker the profile's service hosts.
 *  The caller passes the holders it counts (the live ones, for a display of what runs now). */
export function leaseOccupants(holders: readonly Pick<LeaseHolder, 'pid' | 'role' | 'parent'>[]): {
  terminals: number;
  background: number;
} {
  const launchers = new Set(holders.filter((h) => h.role === 'launcher').map((h) => h.pid));
  const orphans = holders.filter(
    (h) => h.role === 'claude' && (h.parent === undefined || !launchers.has(h.parent)),
  ).length;
  return {
    terminals: launchers.size + orphans,
    background: holders.filter((h) => h.role === 'background').length,
  };
}

/** {@link leaseOccupants} as a phrase: "2 terminals", "1 background session", "1 terminal and 1
 *  background session"; "no running process" when there is none. */
export function occupantsPhrase(o: { terminals: number; background: number }): string {
  const parts: string[] = [];
  if (o.terminals > 0) parts.push(`${o.terminals} terminal${o.terminals === 1 ? '' : 's'}`);
  if (o.background > 0) {
    parts.push(`${o.background} background session${o.background === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? 'no running process' : parts.join(' and ');
}

/** One consistent picture of the registry: the shared rows (`accounts.json`), the reserved rows and
 *  the rules (`groups.json`). Read once per decision so every function below sees the same state. */
export interface RulesPicture {
  shared: readonly StoredAccount[];
  reserved: readonly StoredAccount[];
  rules: readonly FolderRule[];
}

/** Who is live in each slot right now: for every slot, every account its live login may belong to
 *  (the engine's token-aware `possibleLiveOwners`). Iteration order is the slot order — global
 *  first, then the rules in file order — which is what {@link PoolEntry.liveElsewhere} reports. */
export type SlotOccupancy = ReadonlyMap<SlotId, ReadonlySet<string>>;

/** The rule a slot belongs to, or undefined for the global slot or a rule that no longer exists. */
export function ruleOfSlot(slot: SlotId, rules: readonly FolderRule[]): FolderRule | undefined {
  const ruleId = ruleIdOfSlot(slot);
  return ruleId === undefined ? undefined : rules.find((r) => r.id === ruleId);
}

/** Every rule that includes (reserves) this account, in rule order. Empty for a shared account. */
export function rulesIncluding(accountId: string, rules: readonly FolderRule[]): FolderRule[] {
  return rules.filter((r) => r.include.includes(accountId));
}

/**
 * Whether `accountId` may legitimately be live in `slot`, ignoring quarantine and liveness: a SHARED
 * account for the global slot; for a rule's slot, one of its included accounts or a shared account
 * the rule does not exclude. An account reserved only to other rules belongs to no slot of this
 * rule, and a reserved account never belongs to the global slot.
 *
 * Quarantine is a separate question on purpose: a quarantined account live where it belongs is a
 * dead login, not an intruder, and is replaced rather than evicted (see the engine's ensure-live).
 */
export function slotMayHold(slot: SlotId, accountId: string, picture: RulesPicture): boolean {
  const isShared = picture.shared.some((a) => a.id === accountId);
  const ruleId = ruleIdOfSlot(slot);
  if (ruleId === undefined) return isShared;
  const rule = picture.rules.find((r) => r.id === ruleId);
  if (rule === undefined) return false;
  if (rule.include.includes(accountId)) return true;
  // A parallel session is pinned to the account it was started for: no shared fallback.
  if (isLeaseRule(rule)) return false;
  return isShared && !rule.exclude.includes(accountId);
}

/**
 * The effective pool of a slot, in pool order, without liveness:
 *   - global: every shared row, minus quarantined ones; a globally auto-switch-excluded account is
 *     present but not an auto target (it stays usable by hand);
 *   - a rule: its included accounts in include order (each an auto target — inclusion overrides the
 *     global exclusion there), then the shared rows it does not exclude, honoring the global
 *     exclusion; quarantined accounts are left out of both parts.
 * Accounts reserved only to other rules never appear: they are not shared rows, and this rule does
 * not include them. A rule that no longer exists has an empty pool.
 */
export function slotMembers(
  slot: SlotId,
  picture: RulesPicture,
): Omit<PoolEntry, 'liveElsewhere'>[] {
  const inherited = (exclude: readonly string[]): Omit<PoolEntry, 'liveElsewhere'>[] =>
    picture.shared
      .filter((a) => !a.quarantined && !exclude.includes(a.id))
      .map((account) => ({
        account,
        source: 'inherited' as const,
        autoTarget: account.autoSwitchExcluded !== true,
      }));
  const ruleId = ruleIdOfSlot(slot);
  if (ruleId === undefined) return inherited([]);
  const rule = picture.rules.find((r) => r.id === ruleId);
  if (rule === undefined) return [];
  const included: Omit<PoolEntry, 'liveElsewhere'>[] = [];
  for (const id of rule.include) {
    const account = picture.reserved.find((a) => a.id === id);
    if (account === undefined || account.quarantined) continue;
    included.push({ account, source: 'include', autoTarget: true });
  }
  // Pinned: a parallel session's pool is its one account, never the shared pool.
  if (isLeaseRule(rule)) return included;
  return [...included, ...inherited(rule.exclude)];
}

/** The first slot OTHER than `slot` whose live login may belong to `accountId`, or null. */
export function liveElsewhere(
  slot: SlotId,
  accountId: string,
  occupancy: SlotOccupancy,
): SlotId | null {
  for (const [other, owners] of occupancy) {
    if (other !== slot && owners.has(accountId)) return other;
  }
  return null;
}

/**
 * `occupancy` with every copy a slot may NOT hold left out: an account live where its pool does not
 * have it (excluded there, reserved only to other rules, a reserved account in the global slot) is a
 * copy the repair evicts, not a claim on the account. Deciding whether a slot may KEEP its own
 * legitimate occupant reads this, so a squatter's copy elsewhere never costs the rightful slot the
 * account. Choosing a NEW account for a slot still reads the full occupancy — no copy is ever added
 * while another, legitimate or not, is live.
 */
export function legitimateOccupancy(
  occupancy: SlotOccupancy,
  picture: RulesPicture,
): Map<SlotId, Set<string>> {
  const out = new Map<SlotId, Set<string>>();
  for (const [slot, owners] of occupancy) {
    out.set(slot, new Set([...owners].filter((id) => slotMayHold(slot, id, picture))));
  }
  return out;
}

/** The effective pool of a slot with each account's liveness elsewhere — what
 *  `SwitchEngine.slotPool` returns. See {@link slotMembers} for membership and order. */
export function slotPool(
  slot: SlotId,
  picture: RulesPicture,
  occupancy: SlotOccupancy,
): PoolEntry[] {
  return slotMembers(slot, picture).map((entry) => ({
    ...entry,
    liveElsewhere: liveElsewhere(slot, entry.account.id, occupancy),
  }));
}

/**
 * The accounts an unattended choice may seat in the slot, best first: the AVAILABLE pool entries
 * (live nowhere else) that are auto targets, in pool order, then the available ones that are not
 * (globally excluded shared accounts) as a last resort — exclusion governs which account the
 * automation prefers, not whether a slot may stand empty while one is free. Usage-based choice is
 * the daemon's; this is the engine's usable default.
 */
export function availableInOrder(pool: readonly PoolEntry[]): StoredAccount[] {
  const free = pool.filter((e) => e.liveElsewhere === null);
  return [
    ...free.filter((e) => e.autoTarget).map((e) => e.account),
    ...free.filter((e) => !e.autoTarget).map((e) => e.account),
  ];
}

/**
 * Give each of several slots a DIFFERENT account from its own candidates (each list best first), or
 * say which slot cannot have one. Taking each slot's first free candidate in turn is not enough: an
 * earlier slot can take the only account a later one could use while it had another to spare, and
 * the later slot is then refused although a valid assignment exists. So a slot whose candidates are
 * all taken asks their holders to move to a candidate of their own still free, recursively (an
 * augmenting path). A slot takes a free candidate of its own before it moves anyone, so a slot keeps
 * the account it took unless another slot would otherwise go without.
 * Returns the chosen id per slot in input order, or the index of the first slot no assignment can
 * serve. Pure; the slot counts here are a handful, so the quadratic search costs nothing.
 */
export function assignDistinct(
  candidates: readonly (readonly string[])[],
): { ok: true; chosen: string[] } | { ok: false; unserved: number } {
  const holder = new Map<string, number>();
  const chosen: string[] = [];
  const take = (slot: number, id: string): true => {
    holder.set(id, slot);
    chosen[slot] = id;
    return true;
  };
  const place = (slot: number, visited: Set<string>): boolean => {
    // A free candidate first, so no slot is moved while the one asking has one of its own.
    const free = candidates[slot]!.find((id) => !visited.has(id) && !holder.has(id));
    if (free !== undefined) return take(slot, free);
    for (const id of candidates[slot]!) {
      if (visited.has(id)) continue;
      visited.add(id);
      if (place(holder.get(id)!, visited)) return take(slot, id);
    }
    return false;
  };
  for (let slot = 0; slot < candidates.length; slot += 1) {
    if (!place(slot, new Set())) return { ok: false, unserved: slot };
  }
  return { ok: true, chosen };
}

/** The rule a folder runs under: the longest rule folder that contains it wins, with no merging
 *  between nested rules; `null` means the global slot. `folder` must be canonical. Stored folders
 *  are compared in their canonical spelling (`scopedRuleOf`), exactly as `resolveSessionRule` and
 *  the guard snapshot compare them. */
export function resolveFolderRule(
  folder: string,
  rules: readonly FolderRule[],
  platform: NodeJS.Platform,
): { rule: FolderRule; folder: string } | null {
  const match = resolveBinding(
    folder,
    rules.map((r) => scopedRuleOf(r, platform)),
    platform,
  );
  if (match === null) return null;
  const rule = rules.find((r) => r.id === match.groupId);
  return rule === undefined ? null : { rule, folder: match.folder };
}

/** A rule's scopes as the precedence rule (`resolveSessionBinding`) reads them: its folders and alias
 *  folders in their canonical spelling (`canonicalStoredFolder`: a hand-edited `C:/x` is the same
 *  folder as `C:\x`), and its alias scopes reduced to their comparison keys. The one place a stored
 *  scope is turned into what matching compares, so the guard snapshot, the launcher and `where`
 *  cannot key it differently. Pure. */
export function scopedRuleOf(
  rule: FolderRule,
  platform: NodeJS.Platform = process.platform,
): ScopedGroup {
  return {
    id: rule.id,
    folders: rule.folders.map((f) => canonicalStoredFolder(f, platform)),
    aliases: (rule.aliases ?? []).map((a) => ({
      folder: canonicalStoredFolder(a.folder, platform),
      aliasKey: aliasKey(a.alias),
    })),
  };
}

/** How many scopes (folders + alias scopes) a rule holds — the count that decides whether removing
 *  one removes the rule. */
export function ruleScopeCount(rule: FolderRule): number {
  return rule.folders.length + (rule.aliases?.length ?? 0);
}

/** A rule's scopes in words: its folders, then `session "<alias>" in <folder>` per alias scope. */
export function ruleScopes(rule: FolderRule): string[] {
  return [
    ...rule.folders,
    ...(rule.aliases ?? []).map((a) => `session "${a.alias}" in ${a.folder}`),
  ];
}

/** A rule's scopes as one display phrase, falling back to its label for a rule with none (only a
 *  hand edit leaves one). What refusals, alerts and the phone name a rule by. Unsanitized: every
 *  caller that prints it to a terminal passes it through its own sink sanitizer. */
export function describeRuleScopes(rule: FolderRule): string {
  if (isLeaseRule(rule)) return `a parallel session of ${rule.label} (until it exits)`;
  const parts = ruleScopes(rule);
  return parts.length > 0 ? parts.join(', ') : rule.label;
}

/** Which rule a session runs under, and by which scope. */
export type SessionRuleMatch =
  | { rule: FolderRule; via: 'alias'; folder: string; aliasKey: string }
  | { rule: FolderRule; via: 'folder'; folder: string };

/**
 * THE precedence rule for a session, over folder rules: the alias rule of the session's RECORDED
 * folder and custom title, else the longest folder rule containing the folder it runs in, else
 * `null` (the global slot). See `resolveSessionBinding` (folderPath.ts) for the inputs:
 * `recordedFolder` absent = the folder it runs in, `null` = recorded in no folder an alias rule can
 * name; `title` null/blank = unnamed. `folder` must be canonical.
 */
export function resolveSessionRule(
  folder: string,
  title: string | null | undefined,
  rules: readonly FolderRule[],
  platform: NodeJS.Platform,
  recordedFolder?: string | null,
): SessionRuleMatch | null {
  const match = resolveSessionBinding(
    folder,
    title,
    rules.map((r) => scopedRuleOf(r, platform)),
    platform,
    recordedFolder,
  );
  if (match === null) return null;
  const rule = rules.find((r) => r.id === match.groupId);
  if (rule === undefined) return null;
  return match.via === 'alias'
    ? { rule, via: 'alias', folder: match.folder, aliasKey: match.aliasKey }
    : { rule, via: 'folder', folder: match.folder };
}

/** The rule holding the alias scope (`folder`, `alias`) — same folder by the store's uniqueness key,
 *  same alias key — if any. */
export function exactAliasRule(
  folder: string,
  alias: string,
  rules: readonly FolderRule[],
  platform: NodeJS.Platform,
): FolderRule | undefined {
  const ruleId = exactAliasBinding(folder, alias, rules, platform);
  return ruleId === null ? undefined : rules.find((r) => r.id === ruleId);
}

/** The rule holding this EXACT folder (compared by the store's uniqueness key), if any. A nested
 *  subfolder is a different folder and may carry its own rule. */
export function exactFolderRule(
  folder: string,
  rules: readonly FolderRule[],
  platform: NodeJS.Platform,
): FolderRule | undefined {
  const ruleId = exactBinding(folder, rules, platform);
  return ruleId === null ? undefined : rules.find((r) => r.id === ruleId);
}

/** `picture` with `rule` in place of the rule of the same id — the registry as a pending edit will
 *  leave it, for deciding before the edit is written what the edited slot may hold. */
export function withRule<P extends RulesPicture>(picture: P, rule: FolderRule): P {
  return { ...picture, rules: picture.rules.map((r) => (r.id === rule.id ? rule : r)) };
}

/** Every slot that exists: the global slot, then one per rule in file order. */
export function allSlots(rules: readonly FolderRule[]): SlotId[] {
  return ['global', ...rules.map((r) => ruleSlotId(r.id))];
}
