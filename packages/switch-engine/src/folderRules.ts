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

import { exactBinding, resolveBinding } from './folderPath.js';
import { ruleIdOfSlot, ruleSlotId } from './types.js';
import type { FolderRule, PoolEntry, SlotId, StoredAccount } from './types.js';

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
 *  between nested rules; `null` means the global slot. `folder` must be canonical. */
export function resolveFolderRule(
  folder: string,
  rules: readonly FolderRule[],
  platform: NodeJS.Platform,
): { rule: FolderRule; folder: string } | null {
  const match = resolveBinding(folder, rules, platform);
  if (match === null) return null;
  const rule = rules.find((r) => r.id === match.groupId);
  return rule === undefined ? null : { rule, folder: match.folder };
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
