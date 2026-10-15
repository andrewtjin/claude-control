// The reducer: what every key does in every pane and every mode, as plain data in, plain data out.

import { describe, it, expect } from 'vitest';
import { NOW, account, everyStateAccounts, snapshotOf, stateWith } from '../testing/tuiFixtures.js';
import {
  applyLoadError,
  applySnapshot,
  describeRepoll,
  initialState,
  reduce,
  refreshBlocker,
  selectedAccount,
  settleAction,
} from './state.js';
import { PANES, type Key, type PaneId, type TuiState, type Transition } from './types.js';

const key = (name: Exclude<Key['name'], 'char'>): Key => ({ name });
const char = (c: string): Key => ({ name: 'char', char: c });

/** Run keys in order, returning the last transition (and every effect seen). */
function press(state: TuiState, ...keys: Key[]): Transition & { effects: unknown[] } {
  let t: Transition = { state };
  const effects: unknown[] = [];
  for (const k of keys) {
    t = reduce(t.state, k);
    if (t.effect) effects.push(t.effect);
  }
  return { ...t, effects };
}

function base(pane: PaneId = 'accounts'): TuiState {
  return { ...stateWith(snapshotOf(everyStateAccounts())), pane };
}

describe('moving and scrolling', () => {
  it('moves the selection in the Accounts pane, stopping at either end', () => {
    const s = base();
    expect(selectedAccount(s)?.id).toBe('id-work');
    expect(selectedAccount(press(s, key('down')).state)?.id).toBe('id-home');
    expect(selectedAccount(press(s, char('j'), char('j')).state)?.id).toBe('id-dead');
    expect(selectedAccount(press(s, key('up')).state)?.id).toBe('id-work');
    expect(selectedAccount(press(s, char('j'), char('k')).state)?.id).toBe('id-work');
    expect(selectedAccount(press(s, key('end')).state)?.id).toBe('id-long');
    expect(selectedAccount(press(s, key('end'), key('home')).state)?.id).toBe('id-work');
    expect(selectedAccount(press(s, key('pagedown')).state)?.id).toBe('id-long');
    expect(selectedAccount(press(s, key('end'), key('pageup')).state)?.id).toBe('id-work');
    expect(selectedAccount(press(s, key('end'), key('down')).state)?.id).toBe('id-long');
  });

  it.each(['sessions', 'folders', 'outages'] as const)(
    'scrolls the %s pane, never above the top',
    (pane) => {
      const s = base(pane);
      expect(press(s, key('down'), char('j')).state.scroll[pane]).toBe(2);
      expect(press(s, key('down'), key('up')).state.scroll[pane]).toBe(0);
      expect(press(s, key('up'), char('k')).state.scroll[pane]).toBe(0);
      expect(press(s, key('pagedown')).state.scroll[pane]).toBe(10);
      expect(press(s, key('pagedown'), key('home')).state.scroll[pane]).toBe(0);
      expect(press(s, key('end')).state.scroll[pane]).toBe(Number.MAX_SAFE_INTEGER);
      // Scrolling one pane never moves the account selection.
      expect(press(s, key('down')).state.selectedId).toBe('id-work');
    },
  );

  it('cycles the panes with Tab and back with Shift-Tab, wrapping', () => {
    let s = base();
    const seen: PaneId[] = [];
    for (let i = 0; i < PANES.length; i += 1) {
      s = reduce(s, key('tab')).state;
      seen.push(s.pane);
    }
    expect(seen).toEqual(['sessions', 'folders', 'outages', 'accounts']);
    expect(reduce(base(), key('backtab')).state.pane).toBe('outages');
  });

  it('left and right are not bound', () => {
    const s = base();
    expect(reduce(s, key('left')).state).toBe(s);
    expect(reduce(s, key('right')).state).toBe(s);
  });
});

/** The keys that act on the selected account, and the effect or mode each starts there. */
const ACCOUNT_KEYS: Array<[string, Key]> = [
  ['Enter', key('enter')],
  ['e', char('e')],
  ['r', char('r')],
  ['d', char('d')],
  ['l', char('l')],
];

describe('every key in every pane', () => {
  it.each(PANES)('in %s: q and Escape quit, ? opens help, a opens the add prompt', (pane) => {
    const s = base(pane);
    expect(reduce(s, char('q')).effect).toEqual({ kind: 'quit' });
    expect(reduce(s, key('escape')).effect).toEqual({ kind: 'quit' });
    expect(reduce(s, key('ctrl-c')).effect).toEqual({ kind: 'quit' });
    expect(reduce(s, char('?')).state.mode).toEqual({ kind: 'help' });
    expect(reduce(s, char('a')).state.mode).toEqual({ kind: 'prompt', purpose: 'add', input: '' });
    // u: the daemon in the fixture is up, so the refresh starts and the view is busy with it.
    const u = reduce(s, char('u'));
    expect(u.effect).toEqual({ kind: 'refresh' });
    expect(u.state.busy).toBe('Asking the daemon to refresh usage...');
    // An unbound key changes nothing.
    expect(reduce(s, char('z')).state).toBe(s);
    expect(reduce(s, key('backspace')).state).toBe(s);
  });

  it.each(['sessions', 'folders', 'outages'] as const)(
    'in %s: the account keys point at the Accounts pane and do nothing',
    (pane) => {
      for (const [, k] of ACCOUNT_KEYS) {
        const t = reduce(base(pane), k);
        expect(t.effect).toBeUndefined();
        expect(t.state.mode).toEqual({ kind: 'browse' });
        expect(t.state.status?.text).toMatch(
          /^Go to the Accounts pane \(Tab\) to .+ an account\.$/,
        );
      }
    },
  );

  it('in accounts: Enter switches to the selected account', () => {
    const t = reduce(base(), key('enter'));
    expect(t.effect).toEqual({ kind: 'switch', id: 'id-work', label: 'work' });
    expect(t.state.busy).toBe('Switching to work...');
  });

  it('in accounts: e excludes an included account and includes an excluded one', () => {
    expect(reduce(base(), char('e')).effect).toEqual({
      kind: 'exclude',
      id: 'id-work',
      label: 'work',
      excluded: true,
    });
    const onHome = press(base(), key('down')).state;
    expect(reduce(onHome, char('e')).effect).toEqual({
      kind: 'exclude',
      id: 'id-home',
      label: 'home',
      excluded: false,
    });
    expect(reduce(onHome, char('e')).state.busy).toBe('Including home...');
  });

  it('in accounts: r, d and l open their prompt or overlay for the selected account', () => {
    const target = { id: 'id-work', label: 'work' };
    expect(reduce(base(), char('r')).state.mode).toEqual({
      kind: 'prompt',
      purpose: 'rename',
      account: target,
      input: '',
    });
    expect(reduce(base(), char('d')).state.mode).toEqual({
      kind: 'prompt',
      purpose: 'remove',
      account: target,
      input: '',
    });
    expect(reduce(base(), char('l')).state.mode).toEqual({ kind: 'launch', label: 'work' });
  });

  it('in accounts with no accounts: the account keys say there is nothing to act on', () => {
    const empty = stateWith(snapshotOf([]));
    for (const [, k] of ACCOUNT_KEYS) {
      const t = reduce(empty, k);
      expect(t.effect).toBeUndefined();
      expect(t.state.status?.text).toMatch(/^There is no account to .+\.$/);
    }
    // Movement on an empty list is harmless.
    expect(reduce(empty, key('down')).state).toBe(empty);
  });
});

describe('refresh', () => {
  it.each([
    ['never', { state: 'never' as const }, /has never run/],
    [
      'stopped',
      { state: 'stopped' as const, writtenAtMs: 0, stoppedAtMs: 0, ageMs: 1 },
      /is stopped/,
    ],
    ['stale', { state: 'stale' as const, writtenAtMs: 0, ageMs: 600_000 }, /not answering/],
  ])(
    'is refused, with the reason and the command, while the daemon is %s',
    (_n, heartbeat, why) => {
      const s = stateWith(snapshotOf(everyStateAccounts(), { daemon: { heartbeat } }));
      const t = reduce(s, char('u'));
      expect(t.effect).toBeUndefined();
      expect(t.state.busy).toBeUndefined();
      expect(t.state.status?.tone).toBe('warn');
      expect(t.state.status?.text).toMatch(why);
      expect(t.state.status?.text).toContain('cctl daemon start');
    },
  );

  it('is refused before the first read has landed', () => {
    const s = initialState(NOW, 'linux');
    expect(refreshBlocker(s)).toBe('Refresh is not available until the first read finishes.');
    expect(reduce(s, char('u')).effect).toBeUndefined();
  });

  it('describes each verdict: scheduled, held by the floor or a backoff, a failed cycle, unknown', () => {
    const labels: Record<string, string> = { a: 'work', b: 'home', c: 'side' };
    const text = describeRepoll(
      {
        ok: true,
        results: [
          { id: 'a', outcome: 'scheduled' },
          { id: 'b', outcome: 'skipped', reason: 'floor', dueAtMs: NOW + 4 * 60_000 },
          { id: 'c', outcome: 'skipped', reason: 'backoff', dueAtMs: NOW + 90 * 60_000 },
          { id: 'd', outcome: 'skipped', reason: 'cycle_failed' },
          { id: 'e', outcome: 'skipped', reason: 'unknown' },
        ],
      },
      (id) => labels[id] ?? id,
      NOW,
    );
    expect(text).toBe(
      'Refreshing work; new numbers show on the next read. ' +
        'home was polled recently (next in 4m). ' +
        'side is rate limited (next in 1h 30m). ' +
        "d not refreshed: the daemon's last poll cycle failed and it is retrying. " +
        'e is no longer stored.',
    );
    expect(describeRepoll({ ok: true, results: [] }, (id) => id, NOW)).toBe(
      'There are no accounts to refresh.',
    );
  });
});

describe('overlays and prompts', () => {
  it('closes help and the launch line on any key, without acting on it', () => {
    for (const opener of [char('?'), char('l')]) {
      const open = reduce(base(), opener).state;
      for (const k of [char('q'), key('enter'), char('d'), key('escape')]) {
        const t = reduce(open, k);
        expect(t.state.mode).toEqual({ kind: 'browse' });
        expect(t.effect).toBeUndefined();
      }
    }
  });

  it('takes typed text, backspace and a paste of several characters', () => {
    const t = press(
      base(),
      char('r'),
      char('h'),
      char('o'),
      char('x'),
      key('backspace'),
      char('m'),
    );
    expect(t.state.mode).toMatchObject({ kind: 'prompt', input: 'hom' });
    // Keys bound elsewhere are text inside a prompt.
    expect(press(base(), char('a'), char('q'), char('?'), char('u')).state.mode).toMatchObject({
      input: 'q?u',
    });
    // Backspace on nothing is harmless; movement keys do nothing.
    expect(press(base(), char('a'), key('backspace'), key('down')).state.mode).toMatchObject({
      input: '',
    });
  });

  it('caps prompt input so a paste cannot grow it without bound', () => {
    let s = reduce(base(), char('a')).state;
    for (let i = 0; i < 250; i += 1) s = reduce(s, char('x')).state;
    expect(s.mode).toMatchObject({ input: 'x'.repeat(200) });
  });

  it('cancels on Escape, saying so', () => {
    const t = press(base(), char('r'), char('x'), key('escape'));
    expect(t.state.mode).toEqual({ kind: 'browse' });
    expect(t.effects).toEqual([]);
    expect(t.state.status).toEqual({ text: 'Cancelled.', tone: 'info' });
  });

  it('submits a rename and an add, trimmed nowhere: the vault decides what a label is', () => {
    expect(press(base(), char('r'), char(' '), char('n'), key('enter')).effects).toEqual([
      { kind: 'rename', id: 'id-work', from: 'work', to: ' n' },
    ]);
    const add = press(base(), char('a'), char('n'), char('e'), char('w'), key('enter'));
    expect(add.effects).toEqual([{ kind: 'add', label: 'new' }]);
    expect(add.state.busy).toBe('Adding new...');
  });

  it('does nothing for an empty rename or add', () => {
    for (const opener of [char('r'), char('a')]) {
      const t = press(base(), opener, char(' '), key('enter'));
      expect(t.effects).toEqual([]);
      expect(t.state.status?.text).toBe('Cancelled: no label given.');
    }
  });

  it('removes only when the label is typed exactly', () => {
    const typed = (text: string) =>
      press(base(), char('d'), ...[...text].map((c) => char(c)), key('enter'));
    expect(typed('work').effects).toEqual([{ kind: 'remove', id: 'id-work', label: 'work' }]);
    for (const wrong of ['wor', 'Work', 'work ', '']) {
      const t = typed(wrong);
      expect(t.effects).toEqual([]);
      expect(t.state.status).toEqual({
        text: 'Not removed: the label typed was not work.',
        tone: 'warn',
      });
    }
  });

  it('Ctrl-C inside a prompt still quits', () => {
    expect(press(base(), char('a'), char('x'), key('ctrl-c')).effects).toEqual([{ kind: 'quit' }]);
  });
});

describe('while an action runs', () => {
  const busy = (): TuiState => reduce(base(), key('enter')).state;

  it('ignores every key but Ctrl-C', () => {
    const s = busy();
    for (const k of [char('q'), key('escape'), key('enter'), char('u'), key('tab'), key('down')]) {
      const t = reduce(s, k);
      expect(t.state).toBe(s);
      expect(t.effect).toBeUndefined();
    }
  });

  it('quits after the action on the first Ctrl-C, and at once on the second', () => {
    const first = reduce(busy(), key('ctrl-c'));
    expect(first.effect).toBeUndefined();
    expect(first.state.quitWhenIdle).toBe(true);
    expect(first.state.status?.text).toMatch(/Ctrl-C again to quit now/);
    expect(reduce(first.state, key('ctrl-c')).effect).toEqual({ kind: 'quit' });
  });

  it('settles with the action words and clears busy', () => {
    const ok = settleAction(busy(), { ok: true, message: 'Activated work (no change).' });
    expect(ok.busy).toBeUndefined();
    expect(ok.status).toEqual({ text: 'Activated work (no change).', tone: 'ok' });
    const refused = settleAction(busy(), { ok: false, message: 'work is quarantined' });
    expect(refused.status).toEqual({ text: 'work is quarantined', tone: 'error' });
  });
});

describe('reads', () => {
  it('keeps the selection on its account across reads, and moves it off a removed one', () => {
    const s = press(base(), key('down')).state;
    const reordered = applySnapshot(s, snapshotOf([...everyStateAccounts()].reverse()));
    expect(reordered.selectedId).toBe('id-home');
    const removed = applySnapshot(
      s,
      snapshotOf([account('id-work', 'work'), account('id-x', 'x')]),
    );
    expect(removed.selectedId).toBe('id-work');
    const none = applySnapshot(s, snapshotOf([]));
    expect(none.selectedId).toBeUndefined();
  });

  it('keeps the last picture when a read fails, and drops the failure once one succeeds', () => {
    const failed = applyLoadError(base(), 'disk on fire');
    expect(failed.snapshot).toBeDefined();
    expect(failed.loadError).toBe('disk on fire');
    expect(applySnapshot(failed, snapshotOf([])).loadError).toBeUndefined();
  });
});
