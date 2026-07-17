// Usage severity banding, shared by every frontend.
//
// Lives here (not in the Discord bot) because the CLI colors its output by the same bands
// the bot picks emoji/embed colors by — one source of truth keeps "what counts as critical"
// identical everywhere. Pure math, no IO.

/** Usage severity bands, ordered least → most severe. Thresholds mirror the advisor's
 *  intuition: comfortable, worth watching, plan a switch, effectively exhausted. */
export type Severity = 'ok' | 'warn' | 'high' | 'critical';

const SEVERITY_ORDER: Severity[] = ['ok', 'warn', 'high', 'critical'];

/** Band a usage percent. Percents can exceed 100 on the wire (grace overage) — anything
 *  at or past 95 is critical regardless. */
export function severityOf(percent: number): Severity {
  if (percent < 60) return 'ok';
  if (percent < 85) return 'warn';
  if (percent < 95) return 'high';
  return 'critical';
}

/** The most severe band across a set of percents; 'ok' when the set is empty. */
export function worstSeverity(percents: number[]): Severity {
  let worst: Severity = 'ok';
  for (const p of percents) {
    const s = severityOf(p);
    if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) worst = s;
  }
  return worst;
}
