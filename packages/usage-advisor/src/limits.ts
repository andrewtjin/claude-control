// Shared reading of an account's limits: which ones still describe a live window, which one is
// binding, and what each is called. Kept apart from the auto-switch policy and from the
// availability rule so both read limits the same way without importing each other.

import type { LimitInput } from './types.js';

/** Limits that still describe a live window: reset time unknown, or still in the future. */
export function effectiveLimits(limits: LimitInput[], now: number): LimitInput[] {
  return limits.filter((l) => l.resetsAt === undefined || l.resetsAt > now);
}

/** How a tie on percent is broken: the widest budget first. Only reached when two live limits
 *  report the SAME percent, and only the NAME the reason quotes is at stake (the percent is
 *  identical either way). Input order is the wrong answer there because the endpoint lists the
 *  5h window before the weekly ones: an account simultaneously out of its 5-hour window and out
 *  of its week would be reported as "at 100% of its 5-hour window", which reads as "back in a
 *  few hours" when in fact the week is gone. Naming the longest-lived constraint is the honest
 *  answer, and a total order keeps the pick deterministic. */
const LIMIT_TIE_RANK: Record<LimitInput['kind'], number> = {
  weekly_all: 3,
  weekly_scoped: 2,
  session: 1,
};

/** The binding constraint among `limits`: the live one with the highest percent used.
 *  `undefined` when no live limit was reported. The caller decides which limits the policy may
 *  see (the Fable cap is dropped up front when opted out), so a snapshot carrying only an ignored
 *  limit honestly reports no data. */
export function worstLimit(limits: LimitInput[], now: number): LimitInput | undefined {
  const live = effectiveLimits(limits, now);
  if (live.length === 0) return undefined;
  return live.reduce((worst, l) => {
    if (l.percent !== worst.percent) return l.percent > worst.percent ? l : worst;
    return LIMIT_TIE_RANK[l.kind] > LIMIT_TIE_RANK[worst.kind] ? l : worst;
  });
}

/** How a reason names each limit kind — the words the usage table already uses for them. */
export const LIMIT_NOUN: Record<LimitInput['kind'], string> = {
  session: '5-hour window',
  weekly_all: 'weekly budget',
  weekly_scoped: 'Fable weekly cap',
};
