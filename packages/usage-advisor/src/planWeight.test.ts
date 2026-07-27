import { describe, it, expect } from 'vitest';
import { planWeight } from './planWeight.js';

describe('planWeight', () => {
  it('derives Max 20x from organizationRateLimitTier', () => {
    const result = planWeight({ organizationRateLimitTier: 'default_claude_max_20x' });
    expect(result).toEqual({
      weight: 20,
      known: true,
      source: 'organizationRateLimitTier',
      raw: 'default_claude_max_20x',
    });
  });

  it('derives Max 5x from rateLimitTier', () => {
    const result = planWeight({ rateLimitTier: 'default_claude_max_5x' });
    expect(result).toEqual({
      weight: 5,
      known: true,
      source: 'rateLimitTier',
      raw: 'default_claude_max_5x',
    });
  });

  it('derives the Pro 1x baseline from a "pro"-named tier', () => {
    const result = planWeight({ rateLimitTier: 'default_claude_pro' });
    expect(result).toEqual({
      weight: 1,
      known: true,
      source: 'rateLimitTier',
      raw: 'default_claude_pro',
    });
  });

  it('falls back to subscriptionType when no rate-limit tier is present', () => {
    // subscriptionType alone names the plan family but carries no multiplier, so "max" cannot
    // be trusted for magnitude - it only reaches the 1x-baseline path via an explicit "pro".
    const proResult = planWeight({ subscriptionType: 'pro' });
    expect(proResult).toEqual({ weight: 1, known: true, source: 'subscriptionType', raw: 'pro' });
  });

  it('degrades VISIBLY (known: false) when subscriptionType says "max" with no multiplier', () => {
    const result = planWeight({ subscriptionType: 'max' });
    expect(result.weight).toBe(1);
    expect(result.known).toBe(false);
    expect(result.source).toBe('subscriptionType');
    expect(result.raw).toBe('max');
    expect(result.reason).toMatch(/unrecognized plan tier "max"/);
  });

  it('degrades VISIBLY when no signal is present at all', () => {
    const result = planWeight({});
    expect(result).toEqual({
      weight: 1,
      known: false,
      source: 'none',
      reason: 'no plan tier signal available; treating as 1x baseline',
    });
  });

  it('degrades VISIBLY on a malformed tier string (no digits before the "x")', () => {
    const result = planWeight({ rateLimitTier: 'default_claude_max_abcx' });
    expect(result.known).toBe(false);
    expect(result.weight).toBe(1);
    expect(result.raw).toBe('default_claude_max_abcx');
  });

  it('honors precedence: organizationRateLimitTier wins over a conflicting rateLimitTier', () => {
    const result = planWeight({
      organizationRateLimitTier: 'default_claude_max_20x',
      rateLimitTier: 'default_claude_max_5x',
      subscriptionType: 'pro',
    });
    expect(result).toEqual({
      weight: 20,
      known: true,
      source: 'organizationRateLimitTier',
      raw: 'default_claude_max_20x',
    });
  });

  it('honors precedence: falls through an uninformative stronger signal to a weaker one', () => {
    // organizationRateLimitTier is present but gives no usable multiplier/pro marker; the
    // weaker rateLimitTier signal DOES, so it must win rather than the caller giving up early.
    const result = planWeight({
      organizationRateLimitTier: 'default_claude_something_unrecognized',
      rateLimitTier: 'default_claude_max_5x',
    });
    expect(result).toEqual({
      weight: 5,
      known: true,
      source: 'rateLimitTier',
      raw: 'default_claude_max_5x',
    });
  });

  it('ignores empty-string signals as if absent', () => {
    const result = planWeight({ organizationRateLimitTier: '', rateLimitTier: '  ' });
    expect(result.known).toBe(false);
    expect(result.source).toBe('none');
  });

  it('reads the multiplier when the tier carries a suffix after it', () => {
    // Regression: a `\b` boundary after "x" does NOT exist before "_", because `_` is itself a
    // word character. Any suffixed variant therefore read as unknown and the account was
    // silently equal-weighted at 1 — a Max 20x account counted as a Pro one, which is the exact
    // failure this module exists to prevent, and it fails INVISIBLY in aggregate math.
    for (const tier of [
      'default_claude_max_20x_v2',
      'claude_max_20x_beta',
      'tier_20x_legacy',
      'default_claude_max_20x.v2',
      'default-claude-max-20x-v2',
    ]) {
      const result = planWeight({ organizationRateLimitTier: tier });
      expect(result.weight, tier).toBe(20);
      expect(result.known, tier).toBe(true);
    }
  });

  it('reads a suffixed Pro tier and a suffixed 5x tier the same way', () => {
    expect(planWeight({ rateLimitTier: 'default_claude_pro_v2' })).toEqual({
      weight: 1,
      known: true,
      source: 'rateLimitTier',
      raw: 'default_claude_pro_v2',
    });
    expect(planWeight({ rateLimitTier: 'default_claude_max_5x_v2' }).weight).toBe(5);
  });

  it('still refuses a digits-run that is not a bare <digits>x token', () => {
    // Tokenizing must not become so permissive that it invents a multiplier: "20xl" and a bare
    // "20" name no known plan, and guessing one would be worse than degrading visibly.
    for (const tier of ['default_claude_max_20xl', 'default_claude_20', 'max_x20']) {
      const result = planWeight({ organizationRateLimitTier: tier });
      expect(result.known, tier).toBe(false);
      expect(result.weight, tier).toBe(1);
    }
  });
});
