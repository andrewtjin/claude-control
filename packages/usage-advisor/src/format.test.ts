import { describe, it, expect } from 'vitest';
import { formatTokens, humanizeDuration, roundPct } from './format.js';

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

describe('formatTokens', () => {
  it('keeps small counts exact and compacts large ones with a unit', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(847)).toBe('847');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(847_000)).toBe('847k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(1_900_000_000)).toBe('1.9B');
  });

  it('drops the decimal once it stops carrying information', () => {
    // 9.9k still distinguishes two counts; 12k does not need the ".3".
    expect(formatTokens(9900)).toBe('9.9k');
    expect(formatTokens(12_300)).toBe('12k');
  });

  it('rounds sub-unit counts to a whole number rather than printing a fraction', () => {
    expect(formatTokens(0.4)).toBe('0');
    expect(formatTokens(999.6)).toBe('1000');
  });
});
