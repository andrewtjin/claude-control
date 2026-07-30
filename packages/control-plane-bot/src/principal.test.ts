import { describe, it, expect } from 'vitest';
import { slackPrincipal, parseSlackPrincipal, surfaceOf } from './principal.js';

describe('slackPrincipal', () => {
  it('encodes team and user ids into the namespaced form', () => {
    expect(slackPrincipal('T123', 'U456')).toBe('slack:T123:U456');
  });

  it('throws on an empty teamId', () => {
    expect(() => slackPrincipal('', 'U456')).toThrow();
  });

  it('throws on an empty userId', () => {
    expect(() => slackPrincipal('T123', '')).toThrow();
  });

  it('throws when teamId contains a colon', () => {
    expect(() => slackPrincipal('T1:23', 'U456')).toThrow();
  });

  it('throws when userId contains a colon', () => {
    expect(() => slackPrincipal('T123', 'U4:56')).toThrow();
  });
});

describe('parseSlackPrincipal', () => {
  it('round-trips whatever slackPrincipal encoded', () => {
    const id = slackPrincipal('T123', 'U456');
    expect(parseSlackPrincipal(id)).toEqual({ teamId: 'T123', userId: 'U456' });
  });

  it('returns undefined for a bare Discord snowflake', () => {
    expect(parseSlackPrincipal('123456789012345678')).toBeUndefined();
  });

  it('returns undefined for the "slack:" prefix with no separator', () => {
    expect(parseSlackPrincipal('slack:garbage')).toBeUndefined();
  });

  it('returns undefined for an extra colon (too many segments)', () => {
    expect(parseSlackPrincipal('slack:T123:U456:extra')).toBeUndefined();
  });

  it('returns undefined for an empty teamId segment', () => {
    expect(parseSlackPrincipal('slack::U456')).toBeUndefined();
  });

  it('returns undefined for an empty userId segment', () => {
    expect(parseSlackPrincipal('slack:T123:')).toBeUndefined();
  });

  it('returns undefined for both segments empty', () => {
    expect(parseSlackPrincipal('slack::')).toBeUndefined();
  });

  it('returns undefined for the empty string', () => {
    expect(parseSlackPrincipal('')).toBeUndefined();
  });

  it('returns undefined for a string that merely contains the prefix mid-string', () => {
    expect(parseSlackPrincipal('notslack:T123:U456')).toBeUndefined();
  });
});

describe('surfaceOf', () => {
  it('recognizes a well-formed Slack principal', () => {
    expect(surfaceOf(slackPrincipal('T123', 'U456'))).toBe('slack');
  });

  it('grandfathers a bare Discord snowflake as discord', () => {
    expect(surfaceOf('123456789012345678')).toBe('discord');
  });

  it('treats "slack:" prefix with garbage as discord, not slack', () => {
    expect(surfaceOf('slack:garbage')).toBe('discord');
    expect(surfaceOf('slack:T123:U456:extra')).toBe('discord');
    expect(surfaceOf('slack::U456')).toBe('discord');
    expect(surfaceOf('slack:T123:')).toBe('discord');
  });

  it('treats the empty string as discord', () => {
    expect(surfaceOf('')).toBe('discord');
  });
});
