import { describe, it, expect } from 'vitest';
import {
  parseUsageEndpointResponse,
  parseCachedUsage,
  type ParseUsageOptions,
} from './usageParse.js';

const baseOpts: ParseUsageOptions = {
  accountId: 'acct-1',
  label: 'Work',
  active: true,
  quarantined: false,
  fetchedAtMs: 1_700_000_000_000,
  source: 'live',
};

describe('parseUsageEndpointResponse', () => {
  it('parses the exact live payload observed at the M2 gate (2026-07-16 probe)', () => {
    // Verbatim shape from a real 200 response: `limits` at the TOP level (no `utilization`
    // wrapper), alongside sibling fields the parser must ignore. Object-valued `scope` and
    // nullable resets_at appear in the wild too.
    const raw = {
      five_hour: { utilization: 4, resets_at: '2026-07-16T21:00:00.171240+00:00' },
      seven_day: { utilization: 20, resets_at: '2026-07-17T12:00:00.171261+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
      spend: { percent: 0, severity: 'normal', enabled: false },
      member_dashboard_available: false,
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 9,
          severity: 'normal',
          resets_at: '2026-07-16T21:00:00.171240+00:00',
          scope: null,
          is_active: false,
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 21,
          severity: 'normal',
          resets_at: '2026-07-17T12:00:00.171261+00:00',
          scope: null,
          is_active: false,
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 34,
          severity: 'normal',
          resets_at: '2026-07-17T12:00:00.171517+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: true,
        },
      ],
    };
    const { accountUsage, advisorInput } = parseUsageEndpointResponse(raw, baseOpts);

    expect(accountUsage.error).toBeUndefined();
    expect(accountUsage.limits).toHaveLength(3);
    expect(accountUsage.limits[0]).toMatchObject({ kind: 'session', percent: 9 });
    expect(accountUsage.limits[2]).toMatchObject({
      kind: 'weekly_scoped',
      percent: 34,
      isActive: true,
    });
    expect(advisorInput.limits).toHaveLength(3);
  });

  it('parses the `utilization`-wrapped variant (how the CLI caches the same payload)', () => {
    // Same limit family nested one level down — WT-2 originally recorded this shape from the
    // CLI's `.claude.json` cache; the parser accepts both containers.
    const raw = {
      utilization: {
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 24,
            severity: 'normal',
            resets_at: '2026-07-16T19:40:00.380307+00:00',
            scope: null,
            is_active: false,
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 0,
            severity: 'normal',
            resets_at: null,
            scope: null,
            is_active: false,
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 0,
            severity: 'normal',
            resets_at: null,
            scope: null,
            is_active: false,
          },
        ],
      },
    };
    const { accountUsage, advisorInput } = parseUsageEndpointResponse(raw, baseOpts);

    expect(accountUsage.error).toBeUndefined();
    expect(accountUsage.limits).toHaveLength(3);
    expect(accountUsage.limits[0]).toMatchObject({
      kind: 'session',
      percent: 24,
      severity: 'normal',
      isActive: false,
      resetsAt: '2026-07-16T19:40:00.380307+00:00',
    });
    // null resets_at / scope degrade to absent, never crash or coerce to a bogus value.
    expect(accountUsage.limits[1]?.resetsAt).toBeUndefined();
    expect(accountUsage.limits[1]?.scope).toBeUndefined();
    expect(advisorInput.limits).toHaveLength(3);
  });

  it('parses a well-formed response with percent-based limits', () => {
    const raw = {
      utilization: {
        limits: [
          { kind: 'session', percent: 42, resets_at: '2026-01-01T00:00:00.000Z' },
          { kind: 'weekly_all', percent: 10, severity: 'low', scope: 'org', is_active: true },
        ],
      },
    };
    const { accountUsage, advisorInput } = parseUsageEndpointResponse(raw, baseOpts);

    expect(accountUsage.error).toBeUndefined();
    expect(accountUsage.limits).toHaveLength(2);
    expect(accountUsage.limits[0]).toMatchObject({ kind: 'session', percent: 42, isActive: true });
    expect(accountUsage.limits[1]).toMatchObject({
      kind: 'weekly_all',
      percent: 10,
      severity: 'low',
      scope: 'org',
    });

    expect(advisorInput.limits).toHaveLength(2);
    expect(advisorInput.limits[0]).toMatchObject({ kind: 'session', percent: 42 });
    expect(advisorInput.limits[0]?.resetsAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(advisorInput.accountId).toBe('acct-1');
    expect(advisorInput.active).toBe(true);
    expect(advisorInput.quarantined).toBe(false);
  });

  it('accepts a fractional "utilization" field in place of "percent"', () => {
    const raw = { utilization: { limits: [{ kind: 'session', utilization: 0.75 }] } };
    const { accountUsage } = parseUsageEndpointResponse(raw, baseOpts);
    expect(accountUsage.limits[0]?.percent).toBe(75);
  });

  it('accepts a utilization value already on a 0-100 scale', () => {
    const raw = { utilization: { limits: [{ kind: 'session', utilization: 55 }] } };
    const { accountUsage } = parseUsageEndpointResponse(raw, baseOpts);
    expect(accountUsage.limits[0]?.percent).toBe(55);
  });

  it('accepts alternate kind spellings', () => {
    const raw = {
      utilization: {
        limits: [
          { kind: 'weekly', percent: 1 },
          { kind: 'five_hour', percent: 2 },
          { kind: 'weekly_opus', percent: 3 },
        ],
      },
    };
    const { accountUsage } = parseUsageEndpointResponse(raw, baseOpts);
    expect(accountUsage.limits.map((l) => l.kind)).toEqual([
      'weekly_all',
      'session',
      'weekly_scoped',
    ]);
  });

  it('defaults resetsAt/scope/severity to absent, not null, honoring exactOptionalPropertyTypes', () => {
    const raw = { utilization: { limits: [{ kind: 'session', percent: 5 }] } };
    const { accountUsage, advisorInput } = parseUsageEndpointResponse(raw, baseOpts);
    expect('resetsAt' in accountUsage.limits[0]!).toBe(false);
    expect('resetsAt' in advisorInput.limits[0]!).toBe(false);
  });

  it('clamps an absurd percent into UsageLimit range without throwing', () => {
    const raw = { utilization: { limits: [{ kind: 'session', percent: 99999 }] } };
    const { accountUsage, advisorInput } = parseUsageEndpointResponse(raw, baseOpts);
    expect(accountUsage.limits[0]?.percent).toBe(1000);
    expect(advisorInput.limits[0]?.percent).toBe(100);
  });

  it('skips unrecognized limit entries and notes the count without throwing', () => {
    const raw = {
      utilization: {
        limits: [
          { kind: 'session', percent: 5 },
          { kind: 'not_a_real_kind', percent: 5 },
          { percent: 5 }, // no kind at all
          'garbage',
          null,
        ],
      },
    };
    const { accountUsage, advisorInput } = parseUsageEndpointResponse(raw, baseOpts);
    expect(accountUsage.limits).toHaveLength(1);
    expect(advisorInput.limits).toHaveLength(1);
    expect(accountUsage.error).toMatch(/skipped 4/);
  });

  it('never throws on a garbage top-level shape and reports a best-effort error', () => {
    for (const garbage of [
      null,
      undefined,
      'not json',
      42,
      [],
      {},
      { utilization: null },
      { utilization: {} },
    ]) {
      const { accountUsage, advisorInput } = parseUsageEndpointResponse(garbage, baseOpts);
      expect(accountUsage.limits).toEqual([]);
      expect(advisorInput.limits).toEqual([]);
      expect(accountUsage.error).toBeDefined();
    }
  });

  it('carries accountId/label/active/source through to AccountUsage', () => {
    const { accountUsage } = parseUsageEndpointResponse(
      {},
      { ...baseOpts, source: 'cached', active: false },
    );
    expect(accountUsage.accountId).toBe('acct-1');
    expect(accountUsage.label).toBe('Work');
    expect(accountUsage.active).toBe(false);
    expect(accountUsage.source).toBe('cached');
    expect(accountUsage.fetchedAtMs).toBe(baseOpts.fetchedAtMs);
  });
});

describe('parseCachedUsage', () => {
  it('parses the tier-0 cached shape (bare limits array)', () => {
    const raw = { limits: [{ kind: 'session', percent: 20 }] };
    const { accountUsage } = parseCachedUsage(raw, baseOpts);
    expect(accountUsage.limits).toHaveLength(1);
    expect(accountUsage.limits[0]?.percent).toBe(20);
    expect(accountUsage.error).toBeUndefined();
  });

  it('also tolerates a nested "utilization.limits" shape', () => {
    const raw = { utilization: { limits: [{ kind: 'weekly_all', percent: 33 }] } };
    const { accountUsage } = parseCachedUsage(raw, baseOpts);
    expect(accountUsage.limits).toHaveLength(1);
    expect(accountUsage.limits[0]?.kind).toBe('weekly_all');
  });

  it('never throws on garbage and reports an error', () => {
    for (const garbage of [null, undefined, 'nope', 1, [], {}]) {
      const { accountUsage } = parseCachedUsage(garbage, baseOpts);
      expect(accountUsage.limits).toEqual([]);
      expect(accountUsage.error).toBeDefined();
    }
  });

  it("honors the cache's own fetchedAtMs so stale data reports its true age", () => {
    const raw = { fetchedAtMs: 555, limits: [{ kind: 'session', percent: 20 }] };
    const { accountUsage } = parseCachedUsage(raw, baseOpts);
    expect(accountUsage.fetchedAtMs).toBe(555);
    // A cache without its own stamp keeps the caller's poll time (pre-existing behavior).
    const unstamped = parseCachedUsage({ limits: [] }, baseOpts);
    expect(unstamped.accountUsage.fetchedAtMs).toBe(baseOpts.fetchedAtMs);
  });

  // fetchedAtMs is copied onto a wire field declared `.int().nonnegative()`, and encoding
  // throws on the SENDER — taking down the whole poll cycle rather than one field. The stamp
  // comes from a file another program writes, so every shape it could hold must be survived.
  it('ignores a cached fetchedAtMs that would violate the wire contract', () => {
    for (const bad of [1234.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '555', null]) {
      const { accountUsage } = parseCachedUsage(
        { fetchedAtMs: bad, limits: [{ kind: 'session', percent: 20 }] },
        baseOpts,
      );
      expect(accountUsage.fetchedAtMs, `rejected stamp: ${String(bad)}`).toBe(baseOpts.fetchedAtMs);
      expect(Number.isInteger(accountUsage.fetchedAtMs)).toBe(true);
      expect(accountUsage.fetchedAtMs).toBeGreaterThanOrEqual(0);
    }
    // Zero is a legitimate epoch stamp, not a falsy value to discard.
    const epoch = parseCachedUsage({ fetchedAtMs: 0, limits: [] }, baseOpts);
    expect(epoch.accountUsage.fetchedAtMs).toBe(0);
  });

  it('reports "no cached usage" plainly when the reader had nothing to offer', () => {
    const { accountUsage } = parseCachedUsage(undefined, baseOpts);
    expect(accountUsage.error).toBe('no cached usage available');
  });
});
