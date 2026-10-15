// The frame renderer: whole-screen snapshots at the widths people run terminals at, with and
// without color, for every tag and error state; the column-drop order; and the width arithmetic
// every line depends on.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ANSI_PALETTE, PLAIN_PALETTE } from '../ansi.js';
import {
  NOW,
  account,
  everyStateAccounts,
  inMs,
  snapshotOf,
  stateWith,
  usage,
} from '../testing/tuiFixtures.js';
import {
  COLUMN_DROP_ORDER,
  KEY_HELP,
  MIN_COLS,
  MIN_ROWS,
  planAccountColumns,
  renderFrame,
  settleScroll,
} from './render.js';
import { reduce } from './state.js';
import { clip, displayWidth, fit, truncateAnsi, visibleWidth } from './text.js';
import type { TuiSnapshot, TuiState } from './types.js';

const ESC = String.fromCharCode(27);
const WIDTHS = [40, 80, 120, 200] as const;
const ROWS = 14;

/** A frame as a snapshot reads it: escapes shown as `<E>` so a diff is legible. */
function shown(lines: string[]): string {
  return lines.map((l) => l.split(ESC).join('<E>')).join('\n');
}

/** Draw, and hold every frame to the contract: exactly `rows` lines, none wider than `cols`. */
function frame(state: TuiState, cols: number, rows: number, color: boolean): string[] {
  const lines = renderFrame(state, cols, rows, color ? ANSI_PALETTE : PLAIN_PALETTE);
  expect(lines).toHaveLength(rows);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  return lines;
}

const SCENES: Array<[string, () => TuiState]> = [
  ['every tag and state', () => stateWith(snapshotOf(everyStateAccounts()))],
  ['empty vault', () => stateWith(snapshotOf([]))],
  [
    'daemon down',
    () =>
      stateWith(
        snapshotOf(everyStateAccounts(), {
          daemon: {
            heartbeat: {
              state: 'stopped',
              writtenAtMs: NOW - 600_000,
              stoppedAtMs: NOW - 600_000,
              ageMs: 600_000,
            },
          },
        }),
      ),
  ],
  [
    'accounts unreadable',
    () =>
      stateWith(
        snapshotOf([], {
          accounts: { ok: false, error: 'the account registry at x is malformed' },
        }),
      ),
  ],
  [
    'a failed read under the last picture',
    () => ({
      ...stateWith(snapshotOf(everyStateAccounts())),
      loadError: 'daemon.db is locked',
    }),
  ],
];

describe('renderFrame snapshots', () => {
  for (const [name, make] of SCENES) {
    for (const cols of WIDTHS) {
      for (const color of [false, true]) {
        it(`${name} at ${cols} cols${color ? ', color' : ''}`, () => {
          expect(shown(frame(make(), cols, ROWS, color))).toMatchSnapshot();
        });
      }
    }
  }
});

describe('renderFrame: the other panes, overlays and the status line', () => {
  const s = stateWith(snapshotOf(everyStateAccounts()));

  it('shows each text pane from its command renderer, and each pane read failure', () => {
    const sessions = frame({ ...s, pane: 'sessions' }, 80, ROWS, false);
    expect(sessions[1]).toContain('[Sessions]');
    expect(sessions.join('\n')).toContain('No sessions tracked yet.');
    const folders = frame({ ...s, pane: 'folders' }, 80, ROWS, false);
    expect(folders.join('\n')).toContain('No folder rules');
    const outages = frame({ ...s, pane: 'outages' }, 80, ROWS, false);
    expect(outages.join('\n')).toContain('No time on record');

    const broken = stateWith(
      snapshotOf(everyStateAccounts(), {
        sessions: { ok: false, error: 'no such table' },
        folders: { ok: false, error: 'groups.json is not an object' },
        outages: { ok: false, error: 'EACCES' },
      }),
    );
    expect(frame({ ...broken, pane: 'sessions' }, 80, ROWS, false)[2]).toBe(
      'Could not read the sessions: no such table',
    );
    expect(frame({ ...broken, pane: 'folders' }, 80, ROWS, false)[2]).toBe(
      'Could not read the folder rules: groups.json is not an object',
    );
    expect(frame({ ...broken, pane: 'outages' }, 80, ROWS, false)[2]).toBe(
      'Could not read the outage log: EACCES',
    );
  });

  it('scrolls a long text pane, clamped to its last line', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `id-${i}`,
      label: `session-${String(i).padStart(2, '0')}`,
      kind: 'interactive',
      state: 'active',
    }));
    const long = stateWith(
      snapshotOf(everyStateAccounts(), { sessions: { ok: true, value: { rows, header: {} } } }),
    );
    const scrolled = {
      ...long,
      pane: 'sessions' as const,
      scroll: { ...long.scroll, sessions: 5 },
    };
    expect(frame(scrolled, 80, ROWS, false)[2]).toContain('session-');
    const far = { ...scrolled, scroll: { ...scrolled.scroll, sessions: 9999 } };
    const settled = settleScroll(far, ROWS, PLAIN_PALETTE);
    // 30 rows + the header line, blank and column titles: 33 lines, 10 shown.
    expect(settled.scroll.sessions).toBe(23);
    expect(frame(far, 80, ROWS, false)[ROWS - 3]).toContain('session-29');
    // Up from the clamped end moves at once.
    expect(reduce(settled, { name: 'up' }).state.scroll.sessions).toBe(22);
    // Accounts have no scroll to settle.
    expect(settleScroll(s, ROWS, PLAIN_PALETTE)).toBe(s);
  });

  it('shows the help overlay with every key', () => {
    const lines = frame({ ...s, mode: { kind: 'help' } }, 120, 20, false);
    for (const [keys] of KEY_HELP) expect(lines.join('\n')).toContain(keys);
    expect(lines[19]).toBe('any key: back');
  });

  it('shows the launch line quoted for the platform shell', () => {
    const linux = frame({ ...s, mode: { kind: 'launch', label: "o'brien" } }, 100, ROWS, false);
    expect(linux.join('\n')).toContain(`claude --account 'o'\\''brien'`);
    const win = frame(
      { ...s, platform: 'win32', mode: { kind: 'launch', label: "o'brien" } },
      100,
      ROWS,
      false,
    );
    expect(win.join('\n')).toContain(`claude --account 'o''brien'`);
    expect(win.join('\n')).toContain(`cctl claude --account 'o''brien'`);
  });

  it('puts an open prompt, else the running action, else the last message on the status line', () => {
    const prompt = reduce(reduce(s, { name: 'char', char: 'd' }).state, {
      name: 'char',
      char: 'w',
    });
    expect(frame(prompt.state, 80, ROWS, false)[ROWS - 2]).toBe('Type work to remove it: w_');
    expect(frame(prompt.state, 80, ROWS, false)[ROWS - 1]).toBe('Enter confirm · Esc cancel');
    const busy = reduce(s, { name: 'enter' }).state;
    expect(frame(busy, 80, ROWS, false)[ROWS - 2]).toBe('Switching to work...');
    const said = { ...s, status: { text: 'Renamed a to b (id).', tone: 'ok' as const } };
    expect(frame(said, 80, ROWS, false)[ROWS - 2]).toBe('Renamed a to b (id).');
  });

  it('strips terminal controls from text it did not write', () => {
    const evil = `x${ESC}]0;pwned${String.fromCharCode(7)}y`;
    const st = stateWith(snapshotOf([account('id-1', evil)]), {
      status: { text: `bad ${ESC}[2J news`, tone: 'error' },
    });
    const text = frame(st, 80, ROWS, false).join('\n');
    expect(text).not.toContain(ESC);
  });

  it('keeps the selected row on screen in a short terminal', () => {
    const many = Array.from({ length: 20 }, (_, i) => account(`id-${i}`, `acct-${i}`));
    let st = stateWith(snapshotOf(many));
    for (let i = 0; i < 15; i += 1) st = reduce(st, { name: 'down' }).state;
    const lines = frame(st, 80, 10, false);
    expect(lines.some((l) => l.startsWith('> ') && l.includes('acct-15'))).toBe(true);
  });

  it('says the terminal is too narrow or too short instead of drawing a broken layout', () => {
    expect(frame(s, MIN_COLS - 1, ROWS, false)[0]).toBe('Terminal too narrow: widen it to 40 col');
    expect(frame(s, 80, MIN_ROWS - 1, false)[0]).toBe(
      'Terminal too short: make it 6 rows tall (q quits).',
    );
    expect(frame(s, 10, 3, false)).toEqual(['Terminal t', '', '']);
  });
});

describe('column drop order', () => {
  /** The optional columns shown at `cols`, in drop order. */
  function shownAt(snapshot: TuiSnapshot, cols: number): string[] {
    const c = planAccountColumns(snapshot.accounts.ok ? snapshot.accounts.value : [], cols, NOW);
    return COLUMN_DROP_ORDER.filter((k) => c[k]);
  }

  it('drops per-model windows first, then reset times, then the plan', () => {
    const snap = snapshotOf(everyStateAccounts());
    const seen: string[] = [];
    for (let cols = 200; cols >= MIN_COLS; cols -= 1) {
      const now = shownAt(snap, cols).join(',');
      if (seen[seen.length - 1] !== now) seen.push(now);
    }
    expect(seen).toEqual(['perModel,resets,plan', 'resets,plan', 'plan', '']);
  });

  it('narrows the label only once every optional column is gone, never below five', () => {
    const accounts = everyStateAccounts();
    expect(planAccountColumns(accounts, 200, NOW).labelWidth).toBe(20);
    const narrow = planAccountColumns(accounts, 40, NOW);
    expect(narrow.plan || narrow.resets || narrow.perModel).toBe(false);
    expect(narrow.labelWidth).toBeGreaterThanOrEqual(5);
    expect(narrow.labelWidth).toBeLessThan(20);
  });

  it('has no per-model column when no account reports a model window', () => {
    const plain = [
      account('a', 'a', {
        usage: usage([{ kind: 'session', percent: 10, resetsAt: inMs(60_000), isActive: true }]),
      }),
    ];
    expect(planAccountColumns(plain, 200, NOW).perModel).toBe(false);
    expect(renderFrame(stateWith(snapshotOf(plain)), 200, ROWS, PLAIN_PALETTE)[2]).not.toContain(
      'MODELS',
    );
  });

  it('shows each per-model window by its scope, falling back to the Fable name', () => {
    const line = renderFrame(stateWith(snapshotOf(everyStateAccounts())), 200, ROWS, PLAIN_PALETTE)
      .slice(3, 5)
      .join('\n');
    expect(line).toContain('fable 12% 3d');
    expect(line).toContain('opus 64%');
  });
});

describe('width arithmetic', () => {
  it('measures wide characters as two columns and combining marks as none', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('漢字')).toBe(4);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('😀')).toBe(2);
  });

  it('pads or cuts to an exact width, never splitting a wide character', () => {
    expect(fit('ab', 4)).toBe('ab  ');
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('漢字漢字', 5)).toBe('漢字…');
    expect(displayWidth(fit('漢字漢字', 4))).toBe(4);
    expect(fit('x', 0)).toBe('');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('ab', 4)).toBe('ab');
  });

  it('cuts a painted line by visible columns, keeping escapes and closing an open style', () => {
    const red = `${ESC}[31mhello${ESC}[0m world`;
    expect(truncateAnsi(red, 3)).toBe(`${ESC}[31mhel${ESC}[0m`);
    expect(truncateAnsi(red, 100)).toBe(red);
    expect(truncateAnsi('plain text', 5)).toBe('plain');
    expect(visibleWidth(red)).toBe(11);
  });
});

describe('the documented keys', () => {
  it('lists every key the help overlay lists, in the key table of docs/CLI.md', () => {
    // The table's first cells, with the padding a formatter adds to align the columns removed.
    const cells = readFileSync(new URL('../../../../docs/CLI.md', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) => line.split('|')[1]?.trim());
    for (const [keys] of KEY_HELP) expect(cells).toContain(keys);
  });
});
