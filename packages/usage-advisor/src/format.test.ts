import { describe, it, expect } from 'vitest';
import { humanizeDuration, roundPct } from './format.js';

describe('humanizeDuration', () => {
  it('formats sub-minute and zero as expected', () => {
    expect(humanizeDuration(0)).toBe('now');
    expect(humanizeDuration(-5)).toBe('now');
    expect(humanizeDuration(30_000)).toBe('<1m');
  });

  it('formats minutes, hours, and days with two significant units', () => {
    expect(humanizeDuration(45 * 60_000)).toBe('45m');
    expect(humanizeDuration(2 * 3_600_000)).toBe('2h');
    expect(humanizeDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
    expect(humanizeDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(humanizeDuration(3 * 86_400_000)).toBe('3d');
  });
});

describe('roundPct', () => {
  it('rounds and clamps to 0–100', () => {
    expect(roundPct(42.4)).toBe(42);
    expect(roundPct(42.6)).toBe(43);
    expect(roundPct(-5)).toBe(0);
    expect(roundPct(140)).toBe(100);
  });
});
