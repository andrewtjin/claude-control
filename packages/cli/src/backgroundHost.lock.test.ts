// The real host's move lock when letting go of it fails: Windows can refuse to remove a lock
// directory something still holds open (EBUSY, ENOTEMPTY). The lock's own code is swapped for one
// that fails so, here only, since a real directory cannot be made to fail that way on every
// platform; the rest of the move lock is tested on disk in backgroundHost.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, type Lock } from '@claude-control/switch-engine';
import { createClaudeBackgroundHost } from './backgroundHost.js';

vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@claude-control/switch-engine')>();
  return { ...actual, acquireLock: vi.fn() };
});

const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(acquireLock).mockReset();
});

describe('a move lock that cannot be let go', () => {
  it('says why, and its claim is never refreshed again: nothing keeps it alive', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => true);
    const stuck = Object.assign(new Error('EBUSY: resource busy, rmdir'), { code: 'EBUSY' });
    vi.mocked(acquireLock).mockResolvedValue({
      refresh,
      release: () => {
        throw stuck;
      },
    } as unknown as Lock);
    const host = createClaudeBackgroundHost({
      mainConfigDir: 'C:/Users/me/.claude',
      moveLockDir: 'C:/Users/me/AppData/Local/claude-control/background-moves',
      lockRefreshMs: 20,
    });
    const held = await host.lockSession(SID, 0);
    vi.advanceTimersByTime(50);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(() => held!.release()).toThrow(stuck);
    // Left on disk, unrefreshed, it lapses: a holder that is alive but no longer refreshes its
    // claim is taken over once the claim is stale.
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
