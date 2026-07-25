// Human-readable duration formatting for advisory messages.
//
// Kept separate and pure so the phrasing is unit-tested independently of the scoring logic.

/**
 * Format a millisecond duration as a short, human phrase: "45m", "2h", "3d 4h", "<1m".
 * Rounds down to the two most-significant units; used for "resets in <x>" copy.
 */
export function humanizeDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Round a percentage to a whole number for display, clamped to 0–100. */
export function roundPct(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Units for {@link formatTokens}, largest first. */
const TOKEN_UNITS: readonly (readonly [number, string])[] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
];

/**
 * Compact a token count for display: `0`, `847`, `1.2k`, `847k`, `1.2M`, `1.9B`.
 *
 * One decimal only while the scaled value is under 10, which is where it still carries
 * information — "1.2M" says something "1M" does not, but "847.3k" is just noise next to "847k".
 * Lives here rather than in either renderer because the CLI table and the Discord embed both
 * print these counts, and the same number reading differently on the phone than in the terminal
 * would look like two different measurements of the same thing.
 */
export function formatTokens(value: number): string {
  for (const [scale, suffix] of TOKEN_UNITS) {
    if (Math.abs(value) >= scale) {
      const scaled = value / scale;
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}${suffix}`;
    }
  }
  return String(Math.round(value));
}
