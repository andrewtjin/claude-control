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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Format a millisecond countdown as whole days: "3d", "1d", "<1d", "now".
 *
 * Rounds DOWN, so the label is a floor on the runway left and never claims a day that has not
 * been earned — the same conservative convention the 5h-window budget counts with. `<1d` keeps
 * a reset a few hours out from rendering as "0d", which would read as "already spent".
 *
 * Days are the unit the usage surfaces answer in: "how long until this account is whole again"
 * is a question about days, and a window count made the reader do the conversion. The timeline
 * keeps the window count — there, windows ARE the planning unit.
 */
export function humanizeDaysUntil(ms: number): string {
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / DAY_MS);
  return days < 1 ? '<1d' : `${days}d`;
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
 * Format a value already scaled into one unit: one decimal while the ROUNDED value is still
 * under 10 (where it carries information), a bare integer once it isn't. Rounding to one decimal
 * first — rather than checking the raw scaled value — matters at the boundary: 9.9999B raw is
 * "under 10" but rounds to 10.0, which must print as "10B", not the self-contradictory "10.0B".
 */
function formatScaled(scaled: number, suffix: string): string {
  const oneDecimal = Math.round(scaled * 10) / 10;
  if (oneDecimal < 10) return `${oneDecimal.toFixed(1)}${suffix}`;
  return `${Math.round(scaled)}${suffix}`;
}

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
  // TOKEN_UNITS is largest-first, so `bigger` tracks the previously visited (larger) unit —
  // `null` only on the first iteration (B), which has no unit above it to promote into.
  let bigger: readonly [number, string] | null = null;
  for (const unit of TOKEN_UNITS) {
    const [scale, suffix] = unit;
    if (Math.abs(value) >= scale) {
      const scaled = value / scale;
      // Rounding can push a value past THIS unit's ceiling before formatScaled ever sees it
      // (999.6k rounds to "1000k", a unit this function must never print) -- promote to the
      // next larger unit instead of letting the fake unit leak through.
      if (Math.round(scaled) >= 1000 && bigger !== null) {
        const [biggerScale, biggerSuffix] = bigger;
        return formatScaled(value / biggerScale, biggerSuffix);
      }
      return formatScaled(scaled, suffix);
    }
    bigger = unit;
  }
  return String(Math.round(value));
}
