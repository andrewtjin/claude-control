// The severity bands are shared truth: the Discord bot re-exports these for its emoji and
// embed colors, and the CLI colors percents by them — so the thresholds are locked here,
// at the source.

import { describe, expect, it } from 'vitest';
import { severityOf, worstSeverity } from './severity.js';

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
});
