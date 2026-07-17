import { describe, it, expect, vi } from 'vitest';
import type { PayloadOf } from '@claude-control/shared-protocol';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import { AutoSwitcher, DEFAULT_AUTOSWITCH_COOLDOWN_MS } from './autoSwitcher.js';

const NOW = 1_000_000_000;
const H = 60 * 60 * 1000;

/** Active account past the trigger + one clearly eligible spare. */
function lowSnapshot(): AccountUsageInput[] {
  return [
    {
      accountId: 'hot',
      label: 'hot',
      active: true,
      quarantined: false,
      limits: [{ kind: 'session', percent: 96, resetsAt: NOW + 2 * H }],
    },
    {
      accountId: 'spare',
      label: 'spare',
      active: false,
      quarantined: false,
      limits: [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 12 * H }],
    },
  ];
}

function healthySnapshot(): AccountUsageInput[] {
  const [active, spare] = lowSnapshot() as [AccountUsageInput, AccountUsageInput];
  return [{ ...active, limits: [{ kind: 'session', percent: 20, resetsAt: NOW + 2 * H }] }, spare];
}

function makeSwitcher(overrides: Partial<ConstructorParameters<typeof AutoSwitcher>[0]> = {}) {
  const activate = vi.fn((id: string) => Promise.resolve({ ok: true, activeAccountId: id }));
  const notify = vi.fn((payload: PayloadOf<'switch.result'>) => {
    void payload;
  });
  let nowMs = NOW;
  const switcher = new AutoSwitcher({
    activate,
    notify,
    clock: () => nowMs,
    newRequestId: () => 'fixed',
    ...overrides,
  });
  return { switcher, activate, notify, advance: (ms: number) => (nowMs += ms) };
}

describe('AutoSwitcher', () => {
  it('does nothing while the policy says no', async () => {
    const { switcher, activate, notify } = makeSwitcher();
    await switcher.evaluate(healthySnapshot());
    expect(activate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('activates the chosen account and notifies the phone like a manual switch', async () => {
    const { switcher, activate, notify } = makeSwitcher();
    await switcher.evaluate(lowSnapshot());
    expect(activate).toHaveBeenCalledWith('spare');
    const payload = notify.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      requestId: 'autoswitch-fixed',
      ok: true,
      outcome: 'hot_applied',
      activeAccountId: 'spare',
    });
    expect(payload?.message).toContain('auto-switch: hot is at 96% used');
  });

  it('enforces the cooldown between attempts, then allows the next one', async () => {
    const { switcher, activate, advance } = makeSwitcher();
    await switcher.evaluate(lowSnapshot());
    await switcher.evaluate(lowSnapshot());
    expect(activate).toHaveBeenCalledTimes(1);

    advance(DEFAULT_AUTOSWITCH_COOLDOWN_MS + 1);
    await switcher.evaluate(lowSnapshot());
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('absorbs an engine failure, reports it, and still applies the cooldown', async () => {
    const activate = vi.fn(() => Promise.reject(new Error('cadence guard: retry in 42s')));
    const { switcher, notify } = makeSwitcher({ activate });

    await expect(switcher.evaluate(lowSnapshot())).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        outcome: 'failed',
        activeAccountId: 'hot', // still the pre-attempt active account
        error: 'cadence guard: retry in 42s',
      }),
    );

    // Failing must not turn into hammering: the next cycle is inside the cooldown.
    await switcher.evaluate(lowSnapshot());
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('reports a not-ok activate result as a failed outcome', async () => {
    const activate = vi.fn(() => Promise.resolve({ ok: false, activeAccountId: 'hot' }));
    const { switcher, notify } = makeSwitcher({ activate });
    await switcher.evaluate(lowSnapshot());
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, outcome: 'failed', activeAccountId: 'hot' }),
    );
  });

  it('honors custom policy knobs', async () => {
    const { switcher, activate } = makeSwitcher({ policy: { triggerPercent: 99 } });
    await switcher.evaluate(lowSnapshot()); // 96% < 99% custom trigger
    expect(activate).not.toHaveBeenCalled();
  });
});
