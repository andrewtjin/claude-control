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
