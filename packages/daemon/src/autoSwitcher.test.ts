import { describe, it, expect, vi } from 'vitest';
import type { PayloadOf } from '@claude-control/shared-protocol';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import {
  AutoSwitcher,
  DEFAULT_AUTOSWITCH_COOLDOWN_MS,
  type AutoSwitchActivateOptions,
} from './autoSwitcher.js';

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
  const activate = vi.fn((id: string, _options: AutoSwitchActivateOptions) =>
    Promise.resolve({ ok: true, activeAccountId: id }),
  );
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
    // The origin/reason stamp is what lets the audit trail (and activation_intervals) tell this
    // policy hop apart from a human's /switch — the same wording the phone card renders below.
    expect(activate).toHaveBeenCalledTimes(1);
    const [activatedId, activateOptions] = activate.mock.calls[0] ?? [];
    expect(activatedId).toBe('spare');
    expect(activateOptions).toMatchObject({ origin: 'auto' });
    expect(activateOptions?.reason).toContain('hot is at 96% of its 5-hour window');
    const payload = notify.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      requestId: 'autoswitch-fixed',
      ok: true,
      outcome: 'hot_applied',
      activeAccountId: 'spare',
    });
    expect(payload?.message).toContain('auto-switch: hot is at 96% of its 5-hour window');
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

  it('hops to a dormant account reachable only by prediction, under the same cooldown', async () => {
    // The spare's weekly window has closed, so the endpoint reports no reset for it — only the
    // caller's predicted reset makes it a candidate at all.
    const [hot] = lowSnapshot() as [AccountUsageInput];
    const snapshot: AccountUsageInput[] = [
      hot,
      {
        accountId: 'dormant',
        label: 'dormant',
        active: false,
        quarantined: false,
        limits: [{ kind: 'weekly_all', percent: 0 }],
        predictedResetAt: NOW + 20 * H,
      },
    ];
    const { switcher, activate, advance } = makeSwitcher();

    await switcher.evaluate(snapshot);
    expect(activate).toHaveBeenCalledWith('dormant', expect.objectContaining({ origin: 'auto' }));

    // Reaching a new class of target buys no faster cadence: the cooldown is untouched.
    await switcher.evaluate(snapshot);
    expect(activate).toHaveBeenCalledTimes(1);
    advance(DEFAULT_AUTOSWITCH_COOLDOWN_MS + 1);
    await switcher.evaluate(snapshot);
    expect(activate).toHaveBeenCalledTimes(2);
  });
});

describe('AutoSwitcher — per-slot restriction and cooldown', () => {
  /** Two group members (one exhausted-active, one healthy) plus a healthy shared account outside
   *  the group — the shape the daemon feeds one group's decision. */
  function groupSnapshot(): AccountUsageInput[] {
    return [
      {
        accountId: 'm1',
        label: 'm1',
        active: true,
        quarantined: false,
        limits: [{ kind: 'session', percent: 96, resetsAt: NOW + 2 * H }],
      },
      {
        accountId: 'm2',
        label: 'm2',
        active: false,
        quarantined: false,
        limits: [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 12 * H }],
      },
      {
        accountId: 'outsider',
        label: 'outsider',
        active: false,
        quarantined: false,
        limits: [{ kind: 'weekly_all', percent: 5, resetsAt: NOW + 6 * H }],
      },
    ];
  }

  it('hops only within the candidate id set (a 2-member group hops inside itself)', async () => {
    const { switcher, activate } = makeSwitcher();
    await switcher.evaluate(groupSnapshot(), {
      slotKey: 'group:g1',
      candidateIds: new Set(['m1', 'm2']),
    });
    // Never the outsider, even though its reset is sooner — it is outside the group's pool.
    expect(activate).toHaveBeenCalledExactlyOnceWith(
      'm2',
      expect.objectContaining({ origin: 'auto' }),
    );
  });

  it('hands the engine the slot each hop was decided for, and none when no slot was named', async () => {
    const { switcher, activate } = makeSwitcher();
    await switcher.evaluate(groupSnapshot(), {
      slotKey: 'group:g1',
      candidateIds: new Set(['m1', 'm2']),
    });
    await switcher.evaluate(lowSnapshot(), { slotKey: 'global' });
    expect(activate.mock.calls.map(([, options]) => options.slot)).toEqual(['group:g1', 'global']);

    // No slot named: the pre-slot contract, where the engine routes the target by membership.
    const legacy = makeSwitcher();
    await legacy.switcher.evaluate(lowSnapshot());
    expect(legacy.activate.mock.calls[0]?.[1]).not.toHaveProperty('slot');
  });

  it('names the slot on the phone notice when a slotLabel is given (a group hop)', async () => {
    const { switcher, notify } = makeSwitcher();
    await switcher.evaluate(groupSnapshot(), {
      slotKey: 'group:g1',
      candidateIds: new Set(['m1', 'm2']),
      slotLabel: 'C:/ai-research',
    });
    // A group hop's notice scopes the folder so the phone reads it as a group rotation, not a
    // global switch — the label is woven into the same switch.result message.
    expect(notify.mock.calls[0]?.[0]?.message).toContain('auto-switch (C:/ai-research):');
  });

  it('carries the slot label into a failed hop notice too', async () => {
    const activate = vi.fn(() => Promise.reject(new Error('cadence guard: retry in 42s')));
    const { switcher, notify } = makeSwitcher({ activate });
    await switcher.evaluate(groupSnapshot(), {
      slotKey: 'group:g1',
      candidateIds: new Set(['m1', 'm2']),
      slotLabel: 'C:/ai-research',
    });
    expect(notify.mock.calls[0]?.[0]?.message).toContain('auto-switch (C:/ai-research) to');
  });

  it('omits the slot scope for a global hop (historical wording preserved)', async () => {
    const { switcher, notify } = makeSwitcher();
    await switcher.evaluate(lowSnapshot(), { slotKey: 'global' });
    const message = notify.mock.calls[0]?.[0]?.message ?? '';
    expect(message).toContain('auto-switch:');
    expect(message).not.toContain('auto-switch (');
  });

  it('keeps each slot cooldown independent', async () => {
    const { switcher, activate } = makeSwitcher();
    // A global hop puts the GLOBAL bucket into cooldown.
    await switcher.evaluate(lowSnapshot(), { slotKey: 'global' });
    expect(activate).toHaveBeenCalledTimes(1);
    // A second global attempt is suppressed by the global cooldown …
    await switcher.evaluate(lowSnapshot(), { slotKey: 'global' });
    expect(activate).toHaveBeenCalledTimes(1);
    // … but a group's own bucket is untouched, so its hop still lands.
    await switcher.evaluate(groupSnapshot(), {
      slotKey: 'group:g1',
      candidateIds: new Set(['m1', 'm2']),
    });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith('m2', expect.anything());
  });
});
