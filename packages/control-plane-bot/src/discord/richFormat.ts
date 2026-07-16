// Rich Discord rendering primitives: emoji progress bars, proportional emoji timeline
// tracks, severity colors, and native Discord timestamps.
//
// Everything here is a pure string/number transform — no discord.js, no clock reads —
// so it unit-tests without a bot. Design constraint: the owner reads these on a PHONE,
// where ANSI code-block colors do NOT render. Color therefore comes from three things
// that render on every Discord client: emoji, the embed accent color, and `<t:...>`
// native timestamps (which also localize and live-update for free).

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

/** Embed accent color per band — green / yellow / orange / red. */
export const SEVERITY_COLOR: Record<Severity, number> = {
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  high: 0xe67e22,
  critical: 0xe74c3c,
};

/** Fill emoji per band — the "layer" palette of the progress bar. */
const FILL_EMOJI: Record<Severity, string> = {
  ok: '🟩',
  warn: '🟨',
  high: '🟧',
  critical: '🟥',
};
const EMPTY_CELL = '⬜';

/**
 * Layered progress bar: each FILLED cell is colored by the severity band that cell's
 * position falls in, so a heavily-used bar reads as incremental layers —
 * green → yellow → orange → red — and the bar's tip always shows the current band.
 * Percent is clamped to [0, 100] for fill (overage can't overflow the track).
 */
export function layeredBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  let bar = '';
  for (let i = 0; i < width; i++) {
    // Cell i spans up to ((i+1)/width)·100% — color it by the band at its upper edge.
    bar += i < filled ? FILL_EMOJI[severityOf(((i + 1) / width) * 100)] : EMPTY_CELL;
  }
  return bar;
}

/** Discord native relative timestamp — renders as a localized, live-updating
 *  "in 2 hours" on every client. */
export function discordRelative(epochMs: number): string {
  return `<t:${Math.floor(epochMs / 1000)}:R>`;
}

/** Markers for the emoji timeline track. Emoji are uniform-width even in Discord's
 *  proportional font, which is what lets the track live OUTSIDE a code block. */
export const TRACK = {
  empty: '⬛',
  session: '🟦',
  weekly: '🟪',
  both: '⭐',
} as const;

/** One dot on a timeline track. */
export interface TrackEvent {
  atMs: number;
  kind: 'session' | 'weekly';
}

/**
 * Proportional emoji track from `now` to `now + spanMs`: 🟦 = 5h-window reset,
 * 🟪 = weekly reset, ⭐ = both landed in the same cell (so neither silently vanishes),
 * ⬛ = nothing. All accounts share one span so their tracks align vertically.
 */
export function emojiTrack(
  events: TrackEvent[],
  nowMs: number,
  spanMs: number,
  width = 12,
): string {
  const cells: string[] = new Array<string>(width).fill(TRACK.empty);
  const span = Math.max(spanMs, 1); // avoid divide-by-zero when all events are "now"
  for (const e of events) {
    if (e.atMs < nowMs) continue; // past events don't belong on a forward-looking track
    const pos = Math.min(width - 1, Math.round(((e.atMs - nowMs) / span) * (width - 1)));
    const mark = e.kind === 'session' ? TRACK.session : TRACK.weekly;
    const current = cells[pos];
    cells[pos] = current === TRACK.empty || current === mark ? mark : TRACK.both;
  }
  return cells.join('');
}

/** Account status marker: the at-a-glance signal difference between accounts. */
export function accountMarker(account: {
  active: boolean;
  quarantined?: boolean | undefined;
  error?: string | null | undefined;
}): string {
  if (account.quarantined) return '🚫';
  if (account.error) return '⚠️';
  return account.active ? '🟢' : '⚪';
}
