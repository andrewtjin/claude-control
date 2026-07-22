import { describe, it, expect } from 'vitest';
import { PermissionCardRegistry } from './permissionCards.js';

describe('PermissionCardRegistry', () => {
  it('take() returns the recorded ref and then forgets it', () => {
    const reg = new PermissionCardRegistry();
    reg.record('req-1', { channelId: 'c1', messageId: 'm1' });
    expect(reg.take('req-1')).toEqual({ channelId: 'c1', messageId: 'm1' });
    // One-shot: a second take() for the same requestId finds nothing.
    expect(reg.take('req-1')).toBeUndefined();
  });

  it('take() on an unknown requestId returns undefined — never throws', () => {
    const reg = new PermissionCardRegistry();
    expect(reg.take('never-recorded')).toBeUndefined();
  });

  it('evicts the oldest entry once the cap is exceeded (bounded memory)', () => {
    const reg = new PermissionCardRegistry();
    for (let i = 0; i < 64; i++) {
      reg.record(`req-${i}`, { channelId: 'c', messageId: `m${i}` });
    }
    expect(reg.size()).toBe(64);
    // One more push evicts the oldest (req-0).
    reg.record('req-64', { channelId: 'c', messageId: 'm64' });
    expect(reg.size()).toBe(64);
    expect(reg.take('req-0')).toBeUndefined();
    expect(reg.take('req-64')).toEqual({ channelId: 'c', messageId: 'm64' });
  });

  it('size() reflects live entries only', () => {
    const reg = new PermissionCardRegistry();
    reg.record('req-1', { channelId: 'c1', messageId: 'm1' });
    reg.record('req-2', { channelId: 'c1', messageId: 'm2' });
    expect(reg.size()).toBe(2);
    reg.take('req-1');
    expect(reg.size()).toBe(1);
  });
});
