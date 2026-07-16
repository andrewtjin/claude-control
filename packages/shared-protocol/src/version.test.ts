import { describe, it, expect } from 'vitest';
import { negotiateVersion, PROTOCOL_VERSION, MIN_SUPPORTED_VERSION } from './version.js';

describe('negotiateVersion', () => {
  it('meets a peer speaking our exact version', () => {
    expect(negotiateVersion(PROTOCOL_VERSION)).toBe(PROTOCOL_VERSION);
  });

  it('downgrades a newer peer to our version', () => {
    expect(negotiateVersion(PROTOCOL_VERSION + 5)).toBe(PROTOCOL_VERSION);
  });

  it('meets an older-but-supported peer at its own version', () => {
    // Only meaningful once MIN < PROTOCOL; assert the boundary holds regardless.
    if (MIN_SUPPORTED_VERSION < PROTOCOL_VERSION) {
      expect(negotiateVersion(MIN_SUPPORTED_VERSION)).toBe(MIN_SUPPORTED_VERSION);
    } else {
      expect(negotiateVersion(MIN_SUPPORTED_VERSION)).toBe(PROTOCOL_VERSION);
    }
  });

  it('refuses a version below the floor', () => {
    expect(negotiateVersion(MIN_SUPPORTED_VERSION - 1)).toBeNull();
  });

  it('refuses non-integer or nonsensical versions', () => {
    expect(negotiateVersion(0)).toBeNull();
    expect(negotiateVersion(-1)).toBeNull();
    expect(negotiateVersion(1.5)).toBeNull();
    expect(negotiateVersion(Number.NaN)).toBeNull();
  });
});
