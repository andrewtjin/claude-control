import { describe, it, expect } from 'vitest';
import {
  accountMarker,
  discordRelative,
  emojiTrack,
  layeredBar,
  SEVERITY_COLOR,
  severityOf,
  TRACK,
  trackCells,
  UNICODE_TRACK_STYLE,
  worstSeverity,
} from './richFormat.js';

describe('severityOf', () => {
  it('bands percents at the documented thresholds', () => {
    expect(severityOf(0)).toBe('ok');
    expect(severityOf(59.9)).toBe('ok');
    expect(severityOf(60)).toBe('warn');
    expect(severityOf(84.9)).toBe('warn');
    expect(severityOf(85)).toBe('high');
    expect(severityOf(94.9)).toBe('high');
    expect(severityOf(95)).toBe('critical');
    // Wire percents can exceed 100 (grace overage) — still critical.
    expect(severityOf(240)).toBe('critical');
  });
});

describe('worstSeverity', () => {
  it('returns the most severe band across the set', () => {
    expect(worstSeverity([10, 70, 30])).toBe('warn');
    expect(worstSeverity([10, 99])).toBe('critical');
  });

  it('defaults to ok for an empty set', () => {
    expect(worstSeverity([])).toBe('ok');
  });

  it('has a color for every band', () => {
    for (const band of ['ok', 'warn', 'high', 'critical'] as const) {
      expect(SEVERITY_COLOR[band]).toBeGreaterThan(0);
    }
  });
});

describe('layeredBar', () => {
  it('fills proportionally and stays all-green in the ok zone', () => {
    expect(layeredBar(0)).toBe('⬜'.repeat(10));
    expect(layeredBar(40)).toBe('🟩'.repeat(4) + '⬜'.repeat(6));
  });

  it('layers green → yellow → orange → red as usage climbs', () => {
    // 100%: cells 1-5 sit under 60% (green), 6-8 under 85% (yellow),
    // cell 9 under 95% (orange), cell 10 at 100% (red).
    expect(layeredBar(100)).toBe('🟩🟩🟩🟩🟩🟨🟨🟨🟧🟥');
  });

  it('shows the current band at the bar tip', () => {
    // 92% → 9 filled cells; the tip (cell 9, upper edge 90%) is orange.
    expect(layeredBar(92)).toBe('🟩🟩🟩🟩🟩🟨🟨🟨🟧⬜');
  });

  it('clamps overage so the track never overflows', () => {
    expect(layeredBar(240)).toBe('🟩🟩🟩🟩🟩🟨🟨🟨🟧🟥');
    expect(layeredBar(-5)).toBe('⬜'.repeat(10));
  });

  it('respects a custom width', () => {
    expect(layeredBar(50, 4)).toBe('🟩🟩⬜⬜');
  });
});

describe('discordRelative', () => {
  it('emits a native relative timestamp in whole seconds', () => {
    expect(discordRelative(1_752_600_000_123)).toBe('<t:1752600000:R>');
  });
});

describe('emojiTrack', () => {
  const NOW = 1_000_000;
  const SPAN = 12_000; // 12 cells → 1000ms per step across width-1 slots

  it('places session and weekly resets proportionally on the track', () => {
    const track = emojiTrack(
      [
        { atMs: NOW, kind: 'session' },
        { atMs: NOW + SPAN, kind: 'weekly' },
      ],
      NOW,
      SPAN,
    );
    // Iterate by code point ([...str]) — the colored squares are surrogate pairs.
    const cells = [...track];
    expect(cells).toHaveLength(12);
    expect(cells[0]).toBe(TRACK.session);
    expect(cells[11]).toBe(TRACK.weekly);
    expect(cells.slice(1, 11).every((c) => c === TRACK.empty)).toBe(true);
  });

  it('collapses a session and weekly reset in the same cell to the both-marker', () => {
    const track = emojiTrack(
      [
        { atMs: NOW + 1, kind: 'session' },
        { atMs: NOW + 2, kind: 'weekly' },
      ],
      NOW,
      SPAN,
    );
    expect([...track][0]).toBe(TRACK.both);
  });

  it('ignores past events and clamps far-future ones to the last cell', () => {
    const track = emojiTrack(
      [
        { atMs: NOW - 5_000, kind: 'session' },
        { atMs: NOW + SPAN * 10, kind: 'weekly' },
      ],
      NOW,
      SPAN,
    );
    const cells = [...track];
    expect(cells[11]).toBe(TRACK.weekly);
    expect(cells.slice(0, 11).every((c) => c === TRACK.empty)).toBe(true);
  });
});

describe('trackCells', () => {
  const NOW = 1_000_000;
  const SPAN = 12_000;

  it('is the placement math emojiTrack renders from', () => {
    const events = [
      { atMs: NOW + 3_000, kind: 'session' as const },
      { atMs: NOW + SPAN, kind: 'weekly' as const },
    ];
    const cells = trackCells(events, NOW, SPAN);
    expect(cells).toHaveLength(12);
    expect(cells[3]).toBe('session');
    expect(cells[11]).toBe('weekly');
    expect(cells.filter((c) => c === 'empty')).toHaveLength(10);
    // The unicode renderer is exactly this mapping — no independent math to drift.
    expect(emojiTrack(events, NOW, SPAN)).toBe(
      cells
        .map((c) => (c === 'empty' ? TRACK.empty : c === 'session' ? TRACK.session : TRACK.weekly))
        .join(''),
    );
  });

  it('collapses same-cell collisions to both and keeps same-kind stacking stable', () => {
    expect(
      trackCells(
        [
          { atMs: NOW + 1, kind: 'session' },
          { atMs: NOW + 2, kind: 'weekly' },
        ],
        NOW,
        SPAN,
      )[0],
    ).toBe('both');
    expect(
      trackCells(
        [
          { atMs: NOW + 1, kind: 'session' },
          { atMs: NOW + 2, kind: 'session' },
        ],
        NOW,
        SPAN,
      )[0],
    ).toBe('session');
  });
});

describe('UNICODE_TRACK_STYLE', () => {
  it('bundles the unicode track renderer with the TRACK marker glyphs', () => {
    expect(UNICODE_TRACK_STYLE.session).toBe(TRACK.session);
    expect(UNICODE_TRACK_STYLE.weekly).toBe(TRACK.weekly);
    expect(UNICODE_TRACK_STYLE.both).toBe(TRACK.both);
    const NOW = 1_000_000;
    expect(UNICODE_TRACK_STYLE.track([{ atMs: NOW, kind: 'session' }], NOW, 12_000)).toBe(
      emojiTrack([{ atMs: NOW, kind: 'session' }], NOW, 12_000),
    );
  });
});

describe('accountMarker', () => {
  it('distinguishes active, idle, erroring, and quarantined accounts', () => {
    expect(accountMarker({ active: true })).toBe('🟢');
    expect(accountMarker({ active: false })).toBe('⚪');
    expect(accountMarker({ active: true, error: 'refresh failed' })).toBe('⚠️');
    expect(accountMarker({ active: true, quarantined: true })).toBe('🚫');
  });
});
