// Tolerant parsing of usage data into the two shapes the rest of the system needs:
// `AccountUsage` (shared-protocol — what goes out over the wire to the phone) and
// `AccountUsageInput` (usage-advisor — what feeds the burn-down optimizer).
//
// PURE: no IO, no throwing. The OAuth usage endpoint is undocumented but its live shape was
// wet-confirmed 2026-07-16 (live probe during the M2 gate): `limits[]` at the TOP level of
// the response body, with kind/group/percent/severity/resets_at(nullable)/scope(nullable)/
// is_active. A `utilization`-wrapped variant also exists in the wild — it's how the CLI
// persists the same payload in `.claude.json` (`cachedUsageUtilization.utilization.limits`),
// and it's what WT-2 originally recorded — so both containers are accepted. The endpoint
// can still drift, so tolerance stays: a poll that returns something we don't recognize must
// never crash the poller or blind the advisor to every OTHER account — every parse here
// degrades to a best-effort result with an `error` note instead of throwing.

import type { AccountUsage, UsageLimit } from '@claude-control/shared-protocol';
import type { AccountUsageInput, LimitInput } from '@claude-control/usage-advisor';

/** Narrow an unknown value to a plain object without throwing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The limit `kind` values the rest of the system understands. Anything else from the
 *  endpoint is dropped rather than guessed at — a wrong kind would corrupt the advisor's
 *  reset-urgency scoring, whereas a dropped limit just under-informs it. */
const KNOWN_KINDS = new Set(['session', 'weekly_all', 'weekly_scoped']);

function normalizeKind(raw: unknown): 'session' | 'weekly_all' | 'weekly_scoped' | undefined {
  if (typeof raw !== 'string') return undefined;
  // Wet-confirmed kinds: session, weekly_all, weekly_scoped (WT-2). The extra spellings stay
  // accepted as cheap drift insurance.
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'weekly' || normalized === 'weekly_all') return 'weekly_all';
  if (normalized === 'weekly_scoped' || normalized === 'weekly_opus') return 'weekly_scoped';
  if (normalized === 'session' || normalized === 'five_hour') return 'session';
  return KNOWN_KINDS.has(normalized)
    ? (normalized as 'session' | 'weekly_all' | 'weekly_scoped')
    : undefined;
}

/** Percent arrives as `percent` (0-100 — wet-confirmed, WT-2); `utilization` (0-1 fraction)
 *  stays accepted as drift insurance. Both normalize to a 0-100 scale. */
function normalizePercent(raw: Record<string, unknown>): number | undefined {
  if (typeof raw.percent === 'number' && Number.isFinite(raw.percent)) return raw.percent;
  if (typeof raw.utilization === 'number' && Number.isFinite(raw.utilization)) {
    // A fraction (<=1) is scaled up; a value already >1 is assumed to already be a percent.
    return raw.utilization <= 1 ? raw.utilization * 100 : raw.utilization;
  }
  return undefined;
}

function normalizeResetsAt(raw: Record<string, unknown>): string | undefined {
  const value = raw.resets_at ?? raw.resetsAt;
  return typeof value === 'string' ? value : undefined;
}

/** One raw limit entry, tolerantly extracted. Returns `undefined` for an entry so malformed
 *  it carries no usable `kind`/`percent` at all — everything else is best-effort defaulted. */
function parseOneLimit(raw: unknown): { limit: UsageLimit; input: LimitInput } | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = normalizeKind(raw.kind);
  const percent = normalizePercent(raw);
  if (kind === undefined || percent === undefined) return undefined;

  const resetsAtIso = normalizeResetsAt(raw);
  const resetsAtMs = resetsAtIso !== undefined ? Date.parse(resetsAtIso) : NaN;
  const isActive = typeof raw.is_active === 'boolean' ? raw.is_active : true;
  const scope = typeof raw.scope === 'string' ? raw.scope : undefined;
  const severity = typeof raw.severity === 'string' ? raw.severity : undefined;

  // `UsageLimit.percent` is clamped defensively (max 1000) so a garbage endpoint value can
  // never fail the outbound envelope's own schema validation later.
  const clampedPercent = Math.max(0, Math.min(1000, percent));

  const limit: UsageLimit = {
    kind,
    percent: clampedPercent,
    isActive,
    ...(severity !== undefined ? { severity } : {}),
    ...(resetsAtIso !== undefined ? { resetsAt: resetsAtIso } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };

  const input: LimitInput = {
    kind,
    // The advisor's `percent` is 0-100 "used"; clamp separately since it has its own range.
    percent: Math.max(0, Math.min(100, percent)),
    ...(Number.isFinite(resetsAtMs) ? { resetsAt: resetsAtMs } : {}),
  };

  return { limit, input };
}

export interface ParsedUsage {
  accountUsage: AccountUsage;
  advisorInput: AccountUsageInput;
}

export interface ParseUsageOptions {
  accountId: string;
  label: string;
  active: boolean;
  quarantined: boolean;
  fetchedAtMs: number;
  source: 'live' | 'cached';
}

/**
 * Parse the tier-1 OAuth usage endpoint's raw JSON body. Live-confirmed shape (2026-07-16):
 *   { limits: [{ kind, percent|utilization, severity?, resets_at?, scope?, is_active? }], ... }
 * with `limits` at the top level; a `{ utilization: { limits: [...] } }` wrapper is also
 * accepted (the CLI's cache file nests the same payload that way).
 * Never throws — an unrecognized shape yields an empty `limits` array plus an `error` note,
 * so the daemon still reports the account (as unknown-but-live) rather than dropping it.
 */
export function parseUsageEndpointResponse(raw: unknown, opts: ParseUsageOptions): ParsedUsage {
  return parseLimitsPayload(raw, opts, 'response body was not a JSON object');
}

/**
 * Parse the tier-0 fallback shape cached in `~/.claude.json` under `cachedUsageUtilization`.
 * It's the same `{ limits: [...] }` family — the CLI persists the endpoint's payload wrapped
 * one level under `utilization` — so it goes through the same tolerant parser. Never throws.
 */
export function parseCachedUsage(raw: unknown, opts: ParseUsageOptions): ParsedUsage {
  // The CLI stamps the cache with WHEN it fetched (`fetchedAtMs`). Honor it: a stale cache
  // must be reported at its true age, not re-stamped as if fetched at poll time — the phone
  // (and the burn-down advisor's caller) can only judge staleness from this field.
  const fetchedAtMs =
    isRecord(raw) && typeof raw.fetchedAtMs === 'number' && Number.isFinite(raw.fetchedAtMs)
      ? raw.fetchedAtMs
      : opts.fetchedAtMs;
  return parseLimitsPayload(
    raw,
    { ...opts, fetchedAtMs },
    // `undefined` is the reader saying "no cache exists for this account" (e.g. it belongs to
    // a different account) — a normal condition deserving a plain message, not a parse error.
    raw === undefined ? 'no cached usage available' : 'cached usage value was not a JSON object',
  );
}

/** The shared tolerant core: find the `limits` array (top-level, or nested one level under
 *  `utilization` — the CLI's cache wraps it that way), parse each entry best-effort, and
 *  report anything unusable in an `error` note instead of throwing. */
function parseLimitsPayload(
  raw: unknown,
  opts: ParseUsageOptions,
  notObjectError: string,
): ParsedUsage {
  const limits: UsageLimit[] = [];
  const inputs: LimitInput[] = [];
  let error: string | undefined;

  if (!isRecord(raw)) {
    error = notObjectError;
  } else {
    const container = isRecord(raw.utilization) ? raw.utilization : raw;
    if (!Array.isArray(container.limits)) {
      error = 'missing or malformed "limits" field';
    } else {
      let skipped = 0;
      for (const rawLimit of container.limits) {
        const parsed = parseOneLimit(rawLimit);
        if (parsed) {
          limits.push(parsed.limit);
          inputs.push(parsed.input);
        } else {
          skipped++;
        }
      }
      if (skipped > 0)
        error = `skipped ${skipped} unrecognized limit entr${skipped === 1 ? 'y' : 'ies'}`;
    }
  }

  return buildResult(opts, limits, inputs, error);
}

function buildResult(
  opts: ParseUsageOptions,
  limits: UsageLimit[],
  inputs: LimitInput[],
  error: string | undefined,
): ParsedUsage {
  const accountUsage: AccountUsage = {
    accountId: opts.accountId,
    label: opts.label,
    active: opts.active,
    source: opts.source,
    fetchedAtMs: opts.fetchedAtMs,
    limits,
    ...(error !== undefined ? { error } : {}),
  };
  const advisorInput: AccountUsageInput = {
    accountId: opts.accountId,
    label: opts.label,
    active: opts.active,
    quarantined: opts.quarantined,
    limits: inputs,
  };
  return { accountUsage, advisorInput };
}
