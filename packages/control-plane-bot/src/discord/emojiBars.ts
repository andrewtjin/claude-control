// Discord application-emoji progress bars.
//
// WHY this exists alongside richFormat.ts's `layeredBar`: the unicode-square bar reads as
// chunky blocks. Discord APPLICATION emojis (bot-owned custom emojis) render as tiny custom
// images that work in DMs with NO server — so we can ship slim, connected bar sprites with
// rounded caps and half-cell granularity while keeping the exact same severity-gradient
// semantics. This is the native-TypeScript equivalent of the technique used by
// github.com/Paillat-dev/discord-progress-bar.
//
// This module splits cleanly into a PURE renderer (`renderEmojiBar` — string math only, no
// discord.js, unit-testable) and a RUNTIME uploader (`ensureProgressEmojis` — talks to the
// Discord API through a tiny structural interface so it still fakes cleanly in tests).
//
// Graceful degradation is a first-class requirement: whenever the needed emojis aren't
// available (no token, API failure, not yet uploaded) the renderer returns `undefined` and
// the caller falls back to the unicode `layeredBar`. Nothing here ever throws.

import { severityOf, trackCells, type Severity, type TrackEvent } from './richFormat.js';
import type { Logger } from '../logger.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A bar-rendering strategy: percent (+ optional cell width) → a ready-to-send bar string.
 *  Both the unicode `layeredBar` and the emoji renderer's wrapper satisfy this shape, which
 *  is what lets the gateway inject one without embeds.ts knowing which it got. */
export type BarRenderer = (percent: number, width?: number) => string;

/** Looks a sprite name (e.g. `pb_mf_g`) up to its ready-to-embed token `<:pb_mf_g:123…>`,
 *  or `undefined` if that emoji isn't available. The gateway builds this from the id map
 *  returned by `ensureProgressEmojis`. */
export type EmojiResolver = (name: string) => string | undefined;

/** Sprite colour letters, one per severity zone — the filenames use these suffixes. */
const COLOR_LETTER: Record<Severity, 'g' | 'y' | 'o' | 'r'> = {
  ok: 'g',
  warn: 'y',
  high: 'o',
  critical: 'r',
};

/** Every sprite the bar and timeline can reference. Kept as the single source of truth so
 *  the generator script, the uploader, and the tests all agree on exactly which 28 pieces
 *  exist:
 *   - 3 empty track pieces (left cap / middle / right cap) — shared by bars AND timelines
 *   - per bar colour c ∈ g/y/o/r: filled left cap, filled middle, half middle, filled
 *     right cap (16)
 *   - per timeline mark m ∈ s (5h window) / w (weekly) / b (both): a dot on the empty
 *     track, in cap-l / middle / cap-r shapes (9). */
export const PROGRESS_EMOJI_NAMES: readonly string[] = [
  'pb_le',
  'pb_me',
  'pb_re',
  ...(['g', 'y', 'o', 'r'] as const).flatMap((c) => [
    `pb_lf_${c}`,
    `pb_mf_${c}`,
    `pb_mh_${c}`,
    `pb_rf_${c}`,
  ]),
  ...(['s', 'w', 'b'] as const).flatMap((m) => [`tl_l${m}`, `tl_m${m}`, `tl_r${m}`]),
];

/**
 * Build a slim emoji progress bar, or `undefined` if ANY sprite it needs is unavailable
 * (so the caller falls back to unicode). Semantics deliberately mirror `layeredBar`:
 *
 *  - Fill is measured in HALF-cells: `round(percent/100 · width · 2)` half-cells, giving
 *    twice the granularity of the unicode bar (a middle cell can render half-filled).
 *  - Each FILLED cell is coloured by the severity zone at its position — coloured by the
 *    cell's UPPER edge exactly like `layeredBar`, so the two renderers show the same
 *    green→yellow→orange→red gradient and the same tip band.
 *  - The first/last cells are rounded CAPS. There is no half-cap sprite (only middles have a
 *    half variant), so a cap snaps to filled once its left half is reached — the leading cap
 *    lights up as soon as the bar starts, which is what a progress bar should do.
 */
export function renderEmojiBar(
  percent: number,
  resolve: EmojiResolver,
  width = 6,
): string | undefined {
  const clamped = Math.max(0, Math.min(100, percent)); // overage can't overflow the track
  const totalHalves = width * 2;
  const fillHalves = Math.round((clamped / 100) * totalHalves);

  const tokens: string[] = [];
  for (let i = 0; i < width; i++) {
    const leftHalfFilled = 2 * i < fillHalves;
    const rightHalfFilled = 2 * i + 1 < fillHalves;
    // Colour a filled cell by the band at its upper edge — identical rule to `layeredBar`.
    const color = COLOR_LETTER[severityOf(((i + 1) / width) * 100)];

    let name: string;
    if (i === 0) {
      // Left cap: no half sprite exists, so snap on the left half (bar starts filling here).
      name = leftHalfFilled ? `pb_lf_${color}` : 'pb_le';
    } else if (i === width - 1) {
      // Right cap: same snap rule as the left cap.
      name = leftHalfFilled ? `pb_rf_${color}` : 'pb_re';
    } else {
      // Middle: full when both halves are covered, half when only the left half is.
      name = rightHalfFilled ? `pb_mf_${color}` : leftHalfFilled ? `pb_mh_${color}` : 'pb_me';
    }

    const token = resolve(name);
    if (token === undefined) return undefined; // any gap → let the caller use unicode
    tokens.push(token);
  }
  return tokens.join('');
}

/**
 * Build a slim emoji timeline track, or `undefined` if ANY sprite it needs is unavailable
 * (so the caller falls back to the unicode track). Same recessed-tube look as the empty
 * progress bar — the empty pieces ARE the bar's empty pieces — with reset markers drawn as
 * dots on the track: blurple = 5h-window reset, violet = weekly reset, two-tone = both in
 * one cell. Placement math is `trackCells`, shared with the unicode renderer, so the two
 * tracks always agree on where a reset lands.
 */
export function renderEmojiTrack(
  events: TrackEvent[],
  nowMs: number,
  spanMs: number,
  resolve: EmojiResolver,
  width = 12,
): string | undefined {
  const tokens: string[] = [];
  const cells = trackCells(events, nowMs, spanMs, width);
  for (let i = 0; i < cells.length; i++) {
    const cap = i === 0 ? 'l' : i === cells.length - 1 ? 'r' : 'm';
    const cell = cells[i] as (typeof cells)[number];
    const name =
      cell === 'empty'
        ? `pb_${cap}e`
        : `tl_${cap}${cell === 'both' ? 'b' : cell === 'session' ? 's' : 'w'}`;
    const token = resolve(name);
    if (token === undefined) return undefined; // any gap → let the caller use unicode
    tokens.push(token);
  }
  return tokens.join('');
}

// --- Runtime upload -----------------------------------------------------------------------
// Structural slices of discord.js's ApplicationEmojiManager. We depend on the SHAPE, not the
// concrete class, so `ensureProgressEmojis` unit-tests against a hand-rolled fake with no
// real Client — and the real `client.application` still satisfies these interfaces.

/** The two fields we read off an application emoji. */
export interface AppEmojiLike {
  name: string | null;
  id: string;
}

/** The emoji manager surface we touch: list existing, create one from a PNG data URI.
 *  `attachment` is a `data:image/png;base64,…` STRING, never a raw Buffer: discord.js's
 *  resolver stamps Buffers as `data:image/jpg` regardless of content, and Discord's
 *  application-emoji endpoint 500s on the MIME/bytes mismatch. Pre-built data URIs pass
 *  through discord.js verbatim. */
export interface AppEmojiManagerLike {
  /** `application.emojis.fetch()` → a Collection; we only need `.values()`. */
  fetch(): Promise<{ values(): IterableIterator<AppEmojiLike> }>;
  create(options: { attachment: string; name: string }): Promise<AppEmojiLike>;
}

/** The application object we accept — just its `.emojis` manager. */
export interface ProgressApplicationLike {
  emojis: AppEmojiManagerLike;
}

/** Upload attempts per sprite (1 initial + retries) and the base backoff between them.
 *  Kept small: 19 sprites × worst-case 3 tries must not stall bot startup for long. */
export const CREATE_ATTEMPTS = 3;
export const CREATE_RETRY_DELAY_MS = 750;

/**
 * Idempotently ensure every progress sprite exists as an application emoji, and return the
 * name→id map of whatever currently exists (usable or partial). Contract:
 *
 *  - Fetches existing emojis first; creates ONLY the ones that are missing. Never deletes,
 *    never overwrites — safe to call on every `ready`.
 *  - Absorbs and logs every failure. If the initial fetch fails we can't tell what already
 *    exists, so we skip creation entirely (creating blind would risk duplicates) and return
 *    whatever we have — an empty map means the caller simply keeps the unicode bar.
 *  - NEVER throws. The bot must boot even if emoji setup is impossible.
 */
export async function ensureProgressEmojis(
  application: ProgressApplicationLike,
  assetsDir: string,
  logger: Logger,
  // Injectable so retry tests don't sleep for real; production callers omit it.
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();

  // 1. Discover what already exists. A failure here is terminal for THIS run (we won't create
  //    blind and risk duplicate uploads) but must not crash the bot.
  try {
    const existing = await application.emojis.fetch();
    for (const emoji of existing.values()) {
      if (emoji.name) byName.set(emoji.name, emoji.id);
    }
  } catch (err) {
    logger.warn({ err }, 'progress emojis: fetch failed; keeping unicode bars');
    return byName;
  }

  // 2. Create only the missing sprites. Each create is independent — one bad upload logs and
  //    is skipped, leaving a partial map (the renderer will fall back per-bar as needed).
  //    Each create is retried a couple of times: Discord's application-emoji endpoint throws
  //    transient 500s often enough that a single blind attempt loses sprites for no reason.
  for (const name of PROGRESS_EMOJI_NAMES) {
    if (byName.has(name)) continue;
    let attachment: string;
    try {
      // Build the data URI ourselves (see AppEmojiManagerLike) — the bytes ARE PNG, so the
      // label must say PNG or Discord rejects the upload.
      const png = await readFile(join(assetsDir, `${name}.png`));
      attachment = `data:image/png;base64,${png.toString('base64')}`;
    } catch (err) {
      logger.warn({ err, name }, 'progress emojis: sprite file unreadable; skipping');
      continue;
    }
    for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt++) {
      try {
        const created = await application.emojis.create({ attachment, name });
        byName.set(created.name ?? name, created.id);
        break;
      } catch (err) {
        if (attempt === CREATE_ATTEMPTS) {
          logger.warn({ err, name }, 'progress emojis: create failed; skipping');
        } else {
          logger.warn({ err, name, attempt }, 'progress emojis: create failed; retrying');
          await sleep(CREATE_RETRY_DELAY_MS * attempt);
        }
      }
    }
  }

  return byName;
}

/** Build an {@link EmojiResolver} over a name→id map — the bridge from `ensureProgressEmojis`
 *  output to `renderEmojiBar` input. A missing name resolves to `undefined` so the bar falls
 *  back cleanly. Custom-emoji token format is `<:name:id>`. */
export function emojiResolverFrom(byName: Map<string, string>): EmojiResolver {
  return (name) => {
    const id = byName.get(name);
    return id === undefined ? undefined : `<:${name}:${id}>`;
  };
}
