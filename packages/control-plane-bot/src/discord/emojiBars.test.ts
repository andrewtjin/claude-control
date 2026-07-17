import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderEmojiBar,
  ensureProgressEmojis,
  emojiResolverFrom,
  PROGRESS_EMOJI_NAMES,
  type EmojiResolver,
  type ProgressApplicationLike,
  type AppEmojiLike,
} from './emojiBars.js';
import { noopLogger } from '../logger.js';

// The committed sprites live next to this test file: src/discord → ../../assets/progress-bar.
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../assets/progress-bar');

/** A resolver that echoes every name as a bracketed token, so a rendered bar reads as the
 *  exact sequence of sprite pieces it composed — easy to assert on. */
const echoResolver: EmojiResolver = (name) => `[${name}]`;

describe('renderEmojiBar composition', () => {
  it('renders an all-empty track with rounded caps at 0%', () => {
    expect(renderEmojiBar(0, echoResolver)).toBe('[pb_le][pb_me][pb_me][pb_me][pb_me][pb_re]');
  });

  it('layers the severity gradient (green → yellow → red) across a full bar', () => {
    // width 6: cell upper-edges land in ok (cells 0-2), warn (cells 3-4), critical (cell 5) —
    // orange never appears at this width, exactly as the unicode layeredBar behaves.
    expect(renderEmojiBar(100, echoResolver)).toBe(
      '[pb_lf_g][pb_mf_g][pb_mf_g][pb_mf_y][pb_mf_y][pb_rf_r]',
    );
  });

  it('renders a half-filled middle cell at half-cell granularity', () => {
    // 42% → round(0.42·12)=5 half-cells: caps+one middle full, the next middle HALF, rest empty.
    expect(renderEmojiBar(42, echoResolver)).toBe(
      '[pb_lf_g][pb_mf_g][pb_mh_g][pb_me][pb_me][pb_re]',
    );
  });

  it('lights the leading cap as soon as any fill begins', () => {
    // One half-cell of fill → left cap on, everything else empty.
    expect(renderEmojiBar(8, echoResolver)).toBe('[pb_lf_g][pb_me][pb_me][pb_me][pb_me][pb_re]');
  });

  it('clamps overage and negatives so the track never overflows', () => {
    expect(renderEmojiBar(240, echoResolver)).toBe(renderEmojiBar(100, echoResolver));
    expect(renderEmojiBar(-5, echoResolver)).toBe(renderEmojiBar(0, echoResolver));
  });

  it('honours a custom width', () => {
    // width 2 is two caps; 50% fills the left cap only.
    expect(renderEmojiBar(50, echoResolver, 2)).toBe('[pb_lf_g][pb_re]');
  });

  it('returns undefined when ANY needed sprite is missing (caller falls back to unicode)', () => {
    // Missing a filled middle the 100% bar needs → whole bar bails out.
    const missingMiddle: EmojiResolver = (name) => (name === 'pb_mf_g' ? undefined : `[${name}]`);
    expect(renderEmojiBar(100, missingMiddle)).toBeUndefined();
    // Missing even the empty cap the 0% bar needs → also bails out.
    const missingCap: EmojiResolver = (name) => (name === 'pb_le' ? undefined : `[${name}]`);
    expect(renderEmojiBar(0, missingCap)).toBeUndefined();
  });
});

describe('emojiResolverFrom', () => {
  it('builds <:name:id> tokens and undefined for unknown names', () => {
    const resolve = emojiResolverFrom(new Map([['pb_le', '123']]));
    expect(resolve('pb_le')).toBe('<:pb_le:123>');
    expect(resolve('pb_me')).toBeUndefined();
  });
});

/** A fake ApplicationEmojiManager that records create calls and lets a test seed pre-existing
 *  emojis, force a fetch failure, or fail specific creates — no real Discord client involved. */
function fakeApplication(opts: {
  existing?: string[];
  fetchThrows?: boolean;
  failCreate?: Set<string>;
}): { app: ProgressApplicationLike; created: string[] } {
  const created: string[] = [];
  let nextId = 1000;
  const existing: AppEmojiLike[] = (opts.existing ?? []).map((name) => ({
    name,
    id: String(nextId++),
  }));
  const app: ProgressApplicationLike = {
    emojis: {
      fetch: () => {
        if (opts.fetchThrows) return Promise.reject(new Error('fetch boom'));
        return Promise.resolve({ values: () => existing[Symbol.iterator]() });
      },
      create: ({ name }) => {
        if (opts.failCreate?.has(name)) return Promise.reject(new Error(`create boom: ${name}`));
        created.push(name);
        return Promise.resolve({ name, id: String(nextId++) });
      },
    },
  };
  return { app, created };
}

describe('ensureProgressEmojis', () => {
  it('creates only the missing sprites and returns the full name→id map', async () => {
    // Seed two that already exist; the other 17 should be created, none re-created.
    const { app, created } = fakeApplication({ existing: ['pb_le', 'pb_mf_g'] });
    const map = await ensureProgressEmojis(app, ASSETS_DIR, noopLogger);

    expect(map.size).toBe(PROGRESS_EMOJI_NAMES.length);
    for (const name of PROGRESS_EMOJI_NAMES) expect(map.has(name)).toBe(true);
    // Idempotent: pre-existing ones are never re-created.
    expect(created).not.toContain('pb_le');
    expect(created).not.toContain('pb_mf_g');
    expect(created).toHaveLength(PROGRESS_EMOJI_NAMES.length - 2);
  });

  it('is a no-op create when everything already exists', async () => {
    const { app, created } = fakeApplication({ existing: [...PROGRESS_EMOJI_NAMES] });
    const map = await ensureProgressEmojis(app, ASSETS_DIR, noopLogger);
    expect(created).toHaveLength(0);
    expect(map.size).toBe(PROGRESS_EMOJI_NAMES.length);
  });

  it('absorbs a create failure, logs it, and returns the partial map without throwing', async () => {
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };
    const { app, created } = fakeApplication({ failCreate: new Set(['pb_re']) });
    const map = await ensureProgressEmojis(app, ASSETS_DIR, logger);

    expect(map.has('pb_re')).toBe(false);
    expect(map.size).toBe(PROGRESS_EMOJI_NAMES.length - 1);
    expect(created).toHaveLength(PROGRESS_EMOJI_NAMES.length - 1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pb_re' }),
      expect.any(String),
    );
  });

  it('returns an empty map (and creates nothing) when the initial fetch fails', async () => {
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };
    const { app, created } = fakeApplication({ fetchThrows: true });
    const map = await ensureProgressEmojis(app, ASSETS_DIR, logger);

    expect(map.size).toBe(0);
    expect(created).toHaveLength(0); // never create blind — would risk duplicates
    expect(warn).toHaveBeenCalled();
  });
});

describe('committed sprite PNGs', () => {
  // Decode a couple of the generated files to prove the hand-rolled PNG encoder produced valid
  // 28×28 RGBA images (the exact source art Discord ingests for a custom emoji).
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it.each(['pb_le', 'pb_mf_g', 'pb_mh_y', 'pb_rf_r'])(
    '%s is a valid 28×28 RGBA PNG',
    async (name) => {
      const buf = await readFile(join(ASSETS_DIR, `${name}.png`));
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // IHDR: width @16, height @20, bit depth @24, colour type @25 (6 = truecolour + alpha).
      expect(buf.readUInt32BE(16)).toBe(28);
      expect(buf.readUInt32BE(20)).toBe(28);
      expect(buf[24]).toBe(8);
      expect(buf[25]).toBe(6);
    },
  );

  it('ships exactly the 19 sprites the renderer can reference', async () => {
    for (const name of PROGRESS_EMOJI_NAMES) {
      const buf = await readFile(join(ASSETS_DIR, `${name}.png`));
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    }
    expect(PROGRESS_EMOJI_NAMES).toHaveLength(19);
  });
});
