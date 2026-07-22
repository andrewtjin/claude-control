// Rich Discord rendering primitives: emoji progress bars, proportional emoji timeline
// tracks, severity colors, and native Discord timestamps.
//
// Everything here is a pure string/number transform — no discord.js, no clock reads —
// so it unit-tests without a bot. Design constraint: the owner reads these on a PHONE,
// where ANSI code-block colors do NOT render. Color therefore comes from three things
// that render on every Discord client: emoji, the embed accent color, and `<t:...>`
// native timestamps (which also localize and live-update for free).

// Severity banding lives in usage-advisor (the CLI colors by the same bands); re-exported
// here so every bot-internal consumer keeps one import site.
import { severityOf, worstSeverity, type Severity } from '@claude-control/usage-advisor';

export { severityOf, worstSeverity, type Severity };

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

/** What occupies one cell of a proportional timeline track. */
export type TrackCell = 'empty' | 'session' | 'weekly' | 'both';

/**
 * The proportional-placement math shared by every track renderer: map events onto `width`
 * cells spanning `now → now + spanMs`. Two different marks landing in the same cell collapse
 * to 'both' so neither silently vanishes; past events don't belong on a forward-looking track.
 */
export function trackCells(
  events: TrackEvent[],
  nowMs: number,
  spanMs: number,
  width = 12,
): TrackCell[] {
  const cells: TrackCell[] = new Array<TrackCell>(width).fill('empty');
  const span = Math.max(spanMs, 1); // avoid divide-by-zero when all events are "now"
  for (const e of events) {
    if (e.atMs < nowMs) continue;
    const pos = Math.min(width - 1, Math.round(((e.atMs - nowMs) / span) * (width - 1)));
    const current = cells[pos];
    cells[pos] = current === 'empty' || current === e.kind ? e.kind : 'both';
  }
  return cells;
}

/**
 * Unicode fallback track: 🟦 = 5h-window reset, 🟪 = weekly reset, ⭐ = both in one cell,
 * ⬛ = nothing. All accounts share one span so their tracks align vertically. The sleek
 * default is the custom-emoji track (emojiBars.ts `renderEmojiTrack`); this renders only
 * when those sprites are unavailable.
 */
export function emojiTrack(
  events: TrackEvent[],
  nowMs: number,
  spanMs: number,
  width = 12,
): string {
  return trackCells(events, nowMs, spanMs, width)
    .map((c) =>
      c === 'empty'
        ? TRACK.empty
        : c === 'session'
          ? TRACK.session
          : c === 'weekly'
            ? TRACK.weekly
            : TRACK.both,
    )
    .join('');
}

/** How `buildTimelineEmbed` draws its reset tracks and marker glyphs. Injected exactly like
 *  `BarRenderer`: the unicode style is the credential-free default, and the gateway swaps in
 *  the custom-emoji style once the sprites upload (see discordJsGateway). */
export interface TimelineTrackStyle {
  /** Render one account's proportional reset track. */
  track(events: TrackEvent[], nowMs: number, spanMs: number, width?: number): string;
  /** Single-glyph markers for the legend and the upcoming-resets list. */
  session: string;
  weekly: string;
  both: string;
}

/** The unicode default — always available, never needs an upload. */
export const UNICODE_TRACK_STYLE: TimelineTrackStyle = {
  track: emojiTrack,
  session: TRACK.session,
  weekly: TRACK.weekly,
  both: TRACK.both,
};

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

/** The three lifecycle notification cards get their OWN visual language, deliberately distinct
 *  from the usage `SEVERITY_COLOR` gradient: a usage bar is a *measurement*, these are *events*
 *  that demand (or celebrate) a specific reaction, so they must never be mistaken for a usage
 *  band. 'done' = finished, no action; 'waiting' = your turn, act; 'quarantine' = an account is
 *  down and only a host-side re-login fixes it. */
export type NotificationKind = 'done' | 'waiting' | 'quarantine';

/** Embed accent color per lifecycle card. Green reads "complete", blue "your calm attention",
 *  red "action required" — the red intentionally matches `SEVERITY_COLOR.critical` because a
 *  quarantined account is, for planning purposes, as bad as an exhausted one. */
export const NOTIFICATION_COLOR: Record<NotificationKind, number> = {
  done: 0x2ecc71,
  waiting: 0x3498db,
  quarantine: SEVERITY_COLOR.critical,
};

/** Leading icon per lifecycle card — the phone-first signal (color alone doesn't survive a
 *  grayscale glance or an accent-blind viewer, so the icon carries the meaning too). */
export const NOTIFICATION_ICON: Record<NotificationKind, string> = {
  done: '✅',
  waiting: '🔔',
  quarantine: '🚫',
};

/** Discord embed length ceilings we truncate against. Exceeding either makes discord.js throw
 *  at send time, which would drop the whole card — so a long field is shortened, never omitted. */
export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBED_FIELD_VALUE_LIMIT = 1024;
/** Discord rejects a message whose top-level `content` exceeds 2000 chars (distinct from an embed
 *  description's 4096). A milestone/summary/error/daemon-error line is posted as raw `content`, so
 *  it is clamped to this before sending — an over-long line would otherwise be swallowed at send
 *  time (executeOps catches the throw) and vanish, appearing on no surface. */
export const MESSAGE_CONTENT_LIMIT = 2000;

/**
 * Shorten `text` to at most `max` characters, appending a VISIBLE marker of exactly how much
 * was cut. The plan bans silent truncation: a shortened `last_assistant_message` must say so,
 * so the reader knows the tail exists (full text arrives via the attachment path). The
 * result is guaranteed ≤ `max` — the marker budget is reserved using the largest possible
 * hidden-count width, so the returned string can never itself overflow the limit.
 */
export function truncateLabeled(text: string, max: number): string {
  if (text.length <= max) return text;
  // Reserve room for the worst-case marker (hidden count as wide as the whole string) so the
  // final string — slice + marker — is always within `max`.
  const reserve = ` … [+${text.length} chars truncated]`.length;
  const cut = Math.max(0, max - reserve);
  const hidden = text.length - cut;
  return `${text.slice(0, cut)} … [+${hidden} chars truncated]`;
}
