import { describe, it, expect, vi } from 'vitest';
import type { StoredAccount } from '@claude-control/switch-engine';
import {
  connectWithTimeout,
  isSkip,
  isYes,
  normalizePairingCode,
  renderSetupSummary,
  runSetup,
  type ConnectHandle,
  type PairResult,
  type SetupDeps,
  type SetWizardTimer,
  type WizardIo,
} from './setup.js';

// The wizard's dependency methods are declared with a plain function type in the fakes below
// (`() => Promise.resolve(...)`) rather than `async` bodies, because this repo's `require-await`
// lint rule forbids an `async` function with no `await` — the same reason the daemon's own test
// fakes (e.g. controlPlaneClient.test.ts's IdentityStore) return `Promise.resolve(...)`.

// --- pure helpers ----------------------------------------------------------------------------

describe('normalizePairingCode', () => {
  it('strips whitespace and dashes and lower-cases', () => {
    expect(normalizePairingCode('  AB-CD 12 ')).toBe('abcd12');
    expect(normalizePairingCode('abcd12')).toBe('abcd12');
    expect(normalizePairingCode('A B-c-D')).toBe('abcd');
  });

  it('collapses to empty for an all-whitespace answer', () => {
    expect(normalizePairingCode('   ')).toBe('');
  });
});

describe('isYes / isSkip', () => {
  it('treats only explicit yes as affirmative (default No)', () => {
    expect(isYes('y')).toBe(true);
    expect(isYes('  YES ')).toBe(true);
    expect(isYes('')).toBe(false);
    expect(isYes('n')).toBe(false);
    expect(isYes('sure')).toBe(false);
  });

  it('recognizes s / skip', () => {
    expect(isSkip('s')).toBe(true);
    expect(isSkip(' SKIP ')).toBe(true);
    expect(isSkip('')).toBe(false);
    expect(isSkip('abcd')).toBe(false);
  });
});

// --- connectWithTimeout ----------------------------------------------------------------------

describe('connectWithTimeout', () => {
  const noTimer: SetWizardTimer = () => ({ clear: () => {} });

  it('resolves ok when connect() succeeds first, and does not close', async () => {
    const close = vi.fn();
    const handle: ConnectHandle = { connect: () => Promise.resolve(), close };
    const result = await connectWithTimeout(handle, 15_000, noTimer);
    expect(result).toEqual({ ok: true });
    expect(close).not.toHaveBeenCalled();
  });

  it('reports timeout and closes the (still-reconnecting) handle when the deadline fires first', async () => {
    // connect() never settles — exactly the unreachable-relay case the deadline exists for.
    let fire: (() => void) | undefined;
    const setTimer: SetWizardTimer = (fn) => {
      fire = fn;
      return { clear: () => (fire = undefined) };
    };
    const close = vi.fn();
    const handle: ConnectHandle = { connect: () => new Promise<void>(() => {}), close };
    const promise = connectWithTimeout(handle, 15_000, setTimer);
    expect(fire).toBeDefined();
    fire?.();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
      expect(result.detail).toContain('15s');
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports rejected (and closes) on a terminal connect() rejection', async () => {
    const close = vi.fn();
    const handle: ConnectHandle = {
      connect: () => Promise.reject(new Error('hello rejected')),
      close,
    };
    const result = await connectWithTimeout(handle, 15_000, noTimer);
    expect(result).toEqual({ ok: false, reason: 'rejected', detail: 'hello rejected' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores a late timeout after a success already won the race', async () => {
    let fire: (() => void) | undefined;
    const setTimer: SetWizardTimer = (fn) => {
      fire = fn;
      return { clear: () => {} };
    };
    const close = vi.fn();
    const result = await connectWithTimeout(
      { connect: () => Promise.resolve(), close },
      15_000,
      setTimer,
    );
    expect(result).toEqual({ ok: true });
    fire?.(); // the timer firing after the fact must not flip the result or close the handle
    expect(close).not.toHaveBeenCalled();
  });
});

// --- renderSetupSummary ----------------------------------------------------------------------

describe('renderSetupSummary', () => {
  const base = {
    accounts: [{ label: 'work', active: true }],
    hooksInstalled: true,
    hooksProfilePath: 'C:/home/.claude/settings.json',
    relayUrl: 'ws://127.0.0.1:8765',
    taskRegistered: true,
    daemonAlive: true,
    paired: true,
  };

  it('marks a fully-configured setup with ok lines', () => {
    const out = renderSetupSummary(base);
    expect(out).toContain('[ok] accounts: work (active)');
    expect(out).toContain('[ok] hooks: installed in C:/home/.claude/settings.json');
    expect(out).toContain('[ok] daemon: running');
    expect(out).toContain('[ok] discord: paired');
    expect(out).toContain('relay: ws://127.0.0.1:8765');
  });

  it('flags every not-yet-done part with a [--] line', () => {
    const out = renderSetupSummary({
      ...base,
      accounts: [],
      hooksInstalled: false,
      daemonAlive: false,
      taskRegistered: false,
      paired: false,
    });
    expect(out).toContain('[--] accounts: none captured yet');
    expect(out).toContain('[--] hooks: not yet');
    expect(out).toContain('[--] daemon: no autostart registered');
    expect(out).toContain('[--] discord: local-only');
  });

  it('adds the first-poll note only on the success screen and only when paired', () => {
    expect(renderSetupSummary(base, undefined, { firstPollNote: true })).toContain(
      'reach your phone within ~1 minute',
    );
    expect(
      renderSetupSummary({ ...base, paired: false }, undefined, { firstPollNote: true }),
    ).not.toContain('reach your phone');
    expect(renderSetupSummary(base)).not.toContain('reach your phone');
  });
});

// --- runSetup orchestration ------------------------------------------------------------------

function account(label: string): StoredAccount {
  return { id: `id-${label}`, label, quarantined: false, createdAtMs: 0, updatedAtMs: 0 };
}

/** A scripted terminal: answers are consumed in order; every write and prompt is captured. */
function makeIo(answers: string[] = [], isInteractive = true) {
  const writes: string[] = [];
  let i = 0;
  const io: WizardIo = {
    write: (t) => void writes.push(t),
    ask: (prompt) => {
      writes.push(`?${prompt}`);
      return Promise.resolve(answers[i++] ?? '');
    },
    isInteractive,
    // PLAIN palette keeps assertions on literal text, not ANSI.
    palette: {
      bold: (t) => t,
      dim: (t) => t,
      red: (t) => t,
      green: (t) => t,
      yellow: (t) => t,
      blue: (t) => t,
      magenta: (t) => t,
      cyan: (t) => t,
      orange: (t) => t,
    },
  };
  return { io, writes, text: () => writes.join('') };
}

/** Deps whose state (accounts) mutates as the wizard captures — overridable per test. */
function makeDeps(io: WizardIo, overrides: Partial<SetupDeps> = {}): SetupDeps {
  const accounts: StoredAccount[] = [];
  const base: SetupDeps = {
    io,
    runDoctor: () => Promise.resolve([{ name: 'node', ok: true, detail: 'v24' }]),
    isLoggedIn: () => Promise.resolve(true),
    listAccounts: () => Promise.resolve([...accounts]),
    captureCurrentLogin: (label) => {
      const a = account(label);
      accounts.push(a);
      return Promise.resolve(a);
    },
    addFreshAccount: (label) => {
      accounts.push(account(label));
      return Promise.resolve();
    },
    hooksInstalled: () => Promise.resolve(false),
    hooksProfilePath: 'C:/home/.claude/settings.json',
    relayUrl: 'ws://127.0.0.1:8765',
    probeRelay: () => Promise.resolve({ reachable: true, detail: 'relay healthy' }),
    isPaired: () => Promise.resolve(false),
    pair: () => Promise.resolve({ ok: true }),
    taskRegistered: () => Promise.resolve(false),
    installAutostart: () => Promise.resolve({ task: 'created', started: true }),
    verifyDaemon: () => Promise.resolve(true),
  };
  return { ...base, ...overrides };
}

describe('runSetup', () => {
  it('refuses up front on a non-interactive terminal', async () => {
    const { io, text } = makeIo([], false);
    const outcome = await runSetup(makeDeps(io));
    expect(outcome).toBe('not-interactive');
    expect(text()).toContain('error: cctl setup is interactive');
    // It must not have started walking steps.
    expect(text()).not.toContain('[1/7]');
  });

  it('prints a one-line Already set up summary when complete, without walking', async () => {
    const { io, text } = makeIo();
    const outcome = await runSetup(
      makeDeps(io, {
        listAccounts: () => Promise.resolve([account('work')]),
        hooksInstalled: () => Promise.resolve(true),
        taskRegistered: () => Promise.resolve(true),
        isPaired: () => Promise.resolve(true),
      }),
    );
    expect(outcome).toBe('already-set-up');
    expect(text()).toContain('Already set up.');
    expect(text()).toContain('cctl setup --reconfigure');
    expect(text()).not.toContain('[1/7]');
  });

  it('--reconfigure walks the full wizard even when complete', async () => {
    // accounts present ⇒ capture is skipped; add-more = No; already paired ⇒ pairing skipped.
    const { io, text } = makeIo(['n']);
    const outcome = await runSetup(
      makeDeps(io, {
        listAccounts: () => Promise.resolve([account('work')]),
        hooksInstalled: () => Promise.resolve(true),
        taskRegistered: () => Promise.resolve(true),
        isPaired: () => Promise.resolve(true),
      }),
      { reconfigure: true },
    );
    expect(outcome).toBe('completed');
    expect(text()).toContain('[1/7]');
    expect(text()).toContain('[7/7]');
    expect(text()).toContain('Already paired');
  });

  it('runs the full happy path first-run and reports completed', async () => {
    // label=default (Enter), add-more=No, pair with a code.
    const { io, text } = makeIo(['', 'n', 'AB-CD 12']);
    const paired: string[] = [];
    const outcome = await runSetup(
      makeDeps(io, {
        pair: (c) => {
          paired.push(c);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    expect(outcome).toBe('completed');
    const out = text();
    // Every step announced, in order.
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(out).toContain(`[${n}/7]`);
    expect(out).toContain('Captured default');
    // The pairing code reached the pair() dep already normalized.
    expect(paired).toEqual(['abcd12']);
    expect(out).toContain('Paired.');
    expect(out).toContain('Setup complete.');
    // Hooks are deferred to daemon start, not written by the wizard.
    expect(out).toContain('when the daemon starts');
  });

  it('pauses (does not exit) until a login appears, then captures', async () => {
    let logins = 0;
    // First check false (pause), second true. answers: [Enter to re-check, label, add-more No, skip].
    const { io, text } = makeIo(['', 'personal', 'n', 's']);
    const outcome = await runSetup(
      makeDeps(io, { isLoggedIn: () => Promise.resolve(++logins > 1) }),
    );
    expect(outcome).toBe('completed');
    const out = text();
    expect(out).toContain('No Claude login found');
    expect(out).toContain('Press Enter to re-check');
    expect(out).toContain('Captured personal');
  });

  it('skips capture when accounts already exist', async () => {
    const { io, text } = makeIo(['n', 's']);
    const outcome = await runSetup(
      makeDeps(io, { listAccounts: () => Promise.resolve([account('work')]) }),
    );
    expect(outcome).toBe('completed');
    expect(text()).toContain('Leaving them as-is');
    expect(text()).not.toContain('Captured');
  });

  it('treats [s]kip at pairing as a valid local-only setup', async () => {
    const { io, text } = makeIo(['', 'n', 's']);
    let pairCalls = 0;
    const outcome = await runSetup(
      makeDeps(io, {
        pair: () => {
          pairCalls++;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    expect(outcome).toBe('completed');
    expect(pairCalls).toBe(0);
    expect(text()).toContain('local-only');
    expect(text()).toContain('[--] discord: local-only');
  });

  it('re-prompts with an actionable message on a pairing timeout, then succeeds', async () => {
    const results: PairResult[] = [
      { ok: false, reason: 'timeout', detail: 'no response within 15s' },
      { ok: true },
    ];
    const { io, text } = makeIo(['', 'n', 'code1', 'code2']);
    let call = 0;
    const outcome = await runSetup(makeDeps(io, { pair: () => Promise.resolve(results[call++]!) }));
    expect(outcome).toBe('completed');
    const out = text();
    expect(out).toContain("Couldn't reach the relay");
    expect(out).toContain('--relay');
    expect(out).toContain('Paired.');
    expect(call).toBe(2);
  });

  it('explains a rejected code and lets the user skip', async () => {
    const { io, text } = makeIo(['', 'n', 'stalecode', 's']);
    const outcome = await runSetup(
      makeDeps(io, {
        pair: () => Promise.resolve({ ok: false, reason: 'rejected', detail: 'unknown code' }),
      }),
    );
    expect(outcome).toBe('completed');
    expect(text()).toContain('refused that code');
    expect(text()).toContain('local-only');
  });

  it('surfaces an unreachable relay in step 5 without aborting', async () => {
    const { io, text } = makeIo(['', 'n', 's']);
    const outcome = await runSetup(
      makeDeps(io, {
        probeRelay: () => Promise.resolve({ reachable: false, detail: 'no response from health' }),
      }),
    );
    expect(outcome).toBe('completed');
    expect(text()).toContain('no response from health');
    expect(text()).toContain('setup can still finish');
  });

  it('reports when the daemon did not come up but still completes', async () => {
    const { io, text } = makeIo(['', 'n', 's']);
    const outcome = await runSetup(
      makeDeps(io, {
        verifyDaemon: () => Promise.resolve(false),
        installAutostart: () =>
          Promise.resolve({ task: 'created', started: false, detail: 'already running' }),
      }),
    );
    expect(outcome).toBe('completed');
    expect(text()).toContain('has not reported in yet');
    expect(text()).toContain('will start at your next logon');
  });
});
