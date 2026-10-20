// The frame renderer: whole-screen snapshots at the widths people run terminals at, with and
// without color, for every tag and error state; the column-drop order; and the width arithmetic
// every line depends on.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
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
import { accountsOf, reduce } from './state.js';
import {
  clip,
  displayWidth,
  fit,
  setAmbiguousWidth,
  stripAnsi,
  truncateAnsi,
  visibleWidth,
} from './text.js';
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
    const lines = frame({ ...s, mode: { kind: 'help', scroll: 0 } }, 120, 21, false);
    for (const [keys] of KEY_HELP) expect(lines.join('\n')).toContain(keys);
    expect(lines[20]).toBe('Esc: back');
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
    expect(frame(prompt.state, 80, ROWS, false)[ROWS - 1]).toBe('Enter confirm | Esc cancel');
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
    expect(frame(s, MIN_COLS - 1, ROWS, false).slice(0, 2)).toEqual([
      'Terminal too narrow: widen it to 40',
      'columns (q quits).',
    ]);
    expect(frame(s, 80, MIN_ROWS - 1, false)[0]).toBe(
      'Terminal too short: make it 6 rows tall (q quits).',
    );
    expect(frame(s, 10, 3, false)).toEqual(['Too small:', 'q quits', '']);
    // Too small even for that, the way out is what is left.
    expect(frame(s, 7, 2, false)).toEqual(['q quits', '']);
    expect(frame(s, 7, 1, false)).toEqual(['q quits']);
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
    expect(fit('abcdef', 4)).toBe('ab..');
    expect(fit('漢字漢字', 5)).toBe('漢.. ');
    expect(displayWidth(fit('漢字漢字', 4))).toBe(4);
    expect(fit('x', 0)).toBe('');
    expect(clip('abcdef', 4)).toBe('ab..');
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

describe('regressions: what the frame must never do', () => {
  const s = stateWith(snapshotOf(everyStateAccounts()));
  const BEL = String.fromCharCode(7);

  it('passes no escape but color through, whatever a pane renderer was handed', () => {
    const hostile = `x${ESC}[?1049l${ESC}[?25h${ESC}]52;c;aGk=${BEL}y${ESC}[2J`;
    const st = stateWith(
      snapshotOf(everyStateAccounts(), {
        sessions: {
          ok: true,
          value: {
            rows: [
              { id: 's1', kind: 'interactive', state: 'active', label: hostile },
              { id: 's2', kind: 'interactive', state: 'active', label: 'cr\rOVERWRITE' },
            ],
            header: {},
          },
        },
      }),
    );
    const lines = renderFrame({ ...st, pane: 'sessions' }, 100, ROWS, ANSI_PALETTE);
    for (const line of lines) {
      // Only SGR (color and weight) sequences survive; no other escape, BEL or carriage return.
      const rest = line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
      expect([...rest].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)).toBe(false);
    }
  });

  it('keeps the end of a long prompt input and its cursor in view', () => {
    let st: TuiState = reduce(s, { name: 'char', char: 'r' }).state;
    for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ') {
      st = reduce(st, { name: 'char', char: c }).state;
    }
    const line = frame(st, 40, ROWS, false)[ROWS - 2]!;
    expect(line.endsWith('ABCDEFGHIJ_')).toBe(true);
    expect(line.startsWith('New label for work: ')).toBe(true);
    // A label too long for the ask still leaves the typed text and the cursor showing.
    const longLabel = stateWith(snapshotOf([account('id-l', 'work-account-main-01')]));
    let rm: TuiState = reduce(longLabel, { name: 'char', char: 'd' }).state;
    for (const c of 'work-acc') rm = reduce(rm, { name: 'char', char: c }).state;
    expect(frame(rm, 40, ROWS, false)[ROWS - 2]!.endsWith('work-acc_')).toBe(true);
  });

  it('wraps a long status line over extra rows instead of cutting its remedy off', () => {
    const text =
      'Refresh needs the running daemon, and the daemon has never run on this machine - start it with: cctl daemon start';
    const lines = frame({ ...s, status: { text, tone: 'warn' } }, 60, ROWS, false);
    expect(lines.join(' ')).toContain('cctl daemon start');
  });

  it('wraps an unreadable pane error over the body so its remedy shows', () => {
    const error =
      'C:/Users/someone/AppData/Local/claude-control/vault/accounts.json is not valid JSON (Unexpected end of JSON input); fix the file or move it aside - it was left untouched';
    const st = stateWith(snapshotOf([], { accounts: { ok: false, error } }));
    const body = frame(st, 80, ROWS, false).join('\n');
    expect(body).toContain('fix the file or move it aside');
    const sessions = stateWith(snapshotOf([], { sessions: { ok: false, error } }));
    expect(frame({ ...sessions, pane: 'sessions' }, 80, ROWS, false).join('\n')).toContain(
      'move it aside',
    );
  });

  it('marks a launch command cut to fit, never showing a broken one as whole', () => {
    const lines = frame(
      { ...s, mode: { kind: 'launch', label: 'work-account-for-the-research-team' } },
      40,
      ROWS,
      false,
    );
    const commands = lines.filter((l) => l.includes('--account'));
    for (const c of commands) expect(c.endsWith("team'") || c.endsWith('..')).toBe(true);
    expect(lines.join('\n')).toContain('widen the terminal');
  });

  it('lets a short terminal scroll the help overlay to its last key', () => {
    const top = frame({ ...s, mode: { kind: 'help', scroll: 0 } }, 40, 12, false);
    expect(top.join('\n')).not.toContain('q or Esc');
    expect(top[11]).toBe('k/j scroll | Esc: back');
    const end = frame({ ...s, mode: { kind: 'help', scroll: 999 } }, 40, 12, false);
    expect(end.join('\n')).toContain('q or Esc');
  });

  it('says when usage could not be read, while still listing the accounts', () => {
    const st = stateWith({
      ...snapshotOf(everyStateAccounts()),
      usageError: 'file is not a database',
    });
    const text = frame(st, 120, 16, false).join('\n');
    expect(text).toContain('home');
    expect(text).toContain('Usage could not be read: file is not a database');
  });

  it('draws only glyphs every terminal agrees on the width of', () => {
    const narrow = frame(s, 80, ROWS, true).join('\n');
    expect(narrow).not.toMatch(/[\u00b7\u2026]/);
  });

  it('draws nothing but ASCII in any pane when everything it was handed is ASCII', () => {
    // Every pane, with the parts that carry the renderers' own separators: the session header's
    // runway, and the warning on an alias no session title can carry.
    const full = stateWith(
      snapshotOf(everyStateAccounts(), {
        sessions: {
          ok: true,
          value: {
            rows: [{ id: 's1', kind: 'interactive', state: 'active', label: 'build' }],
            header: {
              activeLabel: 'work',
              weeklyResetInMs: 3 * 86_400_000,
              weeklyResetPredicted: true,
            },
          },
        },
        folders: {
          ok: true,
          value: {
            rules: [
              {
                label: 'client-a',
                folders: ['/repos/client-a'],
                aliases: [{ folder: '/repos/client-a', alias: 'x'.repeat(300) }],
                include: ['home'],
                exclude: [],
                live: { label: 'home', source: 'include', quarantined: false },
                pool: [
                  {
                    label: 'home',
                    source: 'include',
                    live: true,
                    liveElsewhere: null,
                    quarantined: false,
                    autoTarget: true,
                  },
                ],
                profileDir: '/data/profiles/client-a',
              },
            ],
            global: { live: null, pool: [] },
            footer: { present: true, fresh: true, enforce: 'block' },
          },
        },
      }),
    );
    for (const pane of ['accounts', 'sessions', 'folders', 'outages'] as const) {
      for (const cols of [40, 80, 200, 400]) {
        for (const line of frame({ ...full, pane }, cols, 40, false)) {
          expect(line, `${pane} at ${cols}`).toMatch(/^[\x20-\x7e]*$/);
        }
      }
    }
  });
});

describe("cctl's own punctuation", () => {
  // The em dash, en dash, ellipsis, middle dot, bullet, arrow and curly quotes are two columns
  // wide on a terminal set up for CJK text, and one elsewhere, so a line cut to the width that
  // holds one can run past the edge.
  const AMBIGUOUS = /[–—…·•→‘’“”]/;
  const reason = 'work is at 96% weekly — home has the soonest weekly reset (“next”…) • a → b';

  it('is drawn in ASCII in an auto-switch reason on the Outages pane', () => {
    const at = NOW - 3_600_000;
    const st = stateWith(
      snapshotOf(everyStateAccounts(), {
        outages: {
          ok: true,
          value: {
            episodes: [
              {
                start: {
                  v: 1,
                  event: 'exhausted',
                  id: 'ep-1',
                  at,
                  time: new Date(at).toISOString(),
                  summary: '',
                  active: 'work',
                  accounts: [],
                  switches: [{ at: at - 60_000, from: 'work', to: 'home', origin: 'auto', reason }],
                },
              },
            ],
            open: [],
            logPath: '/data/exhaustion.jsonl',
          },
        },
      }),
    );
    for (const cols of [40, 61, 80, 122, 200]) {
      const lines = frame({ ...st, pane: 'outages' }, cols, 40, false);
      expect(lines.join('\n'), `at ${cols}`).toContain('work -> home');
      for (const line of lines) expect(line, `at ${cols}`).not.toMatch(AMBIGUOUS);
    }
  });

  it('is drawn in ASCII wherever the view shows a message', () => {
    const base = stateWith(snapshotOf(everyStateAccounts()));
    const states: TuiState[] = [
      { ...base, status: { text: reason, tone: 'error' } },
      { ...base, busy: reason },
      // A poll error, as the account row's error tag.
      stateWith(
        snapshotOf([account('id-e', 'e', { usage: usage([], undefined, { error: reason }) })]),
      ),
      { ...base, loadError: reason },
      { ...base, status: { text: reason, tone: 'error' }, mode: { kind: 'message', scroll: 0 } },
      {
        ...base,
        mode: { kind: 'prompt', purpose: 'add', input: '', note: reason },
      },
      stateWith(snapshotOf([], { accounts: { ok: false, error: reason } })),
      {
        ...stateWith(snapshotOf(everyStateAccounts())),
        snapshot: { ...snapshotOf(everyStateAccounts()), usageError: reason },
      },
    ];
    for (const st of states) {
      for (const cols of [40, 80, 200]) {
        for (const line of frame(st, cols, ROWS, false)) expect(line).not.toMatch(AMBIGUOUS);
      }
    }
    // The messages are there, spelled in ASCII, not dropped.
    expect(frame(states[0]!, 200, ROWS, false).join('\n')).toContain('weekly - home');
    expect(frame(states[2]!, 200, ROWS, false).join('\n')).toContain('error: work is at 96%');
  });
});

describe('text from data on a terminal that draws ambiguous-width characters two wide', () => {
  // Labels, folders and foreign error text are drawn as they are, so the frame must measure them
  // as the terminal draws them. Every character in these frames is ASCII but these, so a line's
  // drawn width is counted here without the code under test.
  const WIDE_HERE = /[—…Ωα·×§±°※]/u;
  const drawn = (line: string): number =>
    [...stripAnsi(line)].reduce((n, ch) => n + (WIDE_HERE.test(ch) ? 2 : 1), 0);
  /** Drawn column at which `needle` starts in `line`. */
  const drawnColumn = (line: string, needle: string): number =>
    drawn(line.slice(0, line.indexOf(needle)));

  beforeEach(() => setAmbiguousWidth(2));
  afterEach(() => setAmbiguousWidth(1));

  it('keeps the sessions table lined up under a label a model wrote', () => {
    const st = stateWith(
      snapshotOf(everyStateAccounts(), {
        sessions: {
          ok: true,
          value: {
            rows: [
              { id: 's1', kind: 'interactive', state: 'active', label: 'Fix auth — refresh flow…' },
              { id: 's2', kind: 'interactive', state: 'idle', label: 'plain' },
            ],
            header: {},
          },
        },
      }),
    );
    for (const cols of [40, 64, 80, 120]) {
      const lines = frame({ ...st, pane: 'sessions' }, cols, ROWS, false);
      for (const line of lines)
        expect(drawn(line), `at ${cols}: ${line}`).toBeLessThanOrEqual(cols);
      if (cols < 80) continue;
      const model = lines.find((l) => l.includes('Fix auth'))!;
      const plain = lines.find((l) => l.includes('plain'))!;
      expect(drawnColumn(model, 'interactive')).toBe(drawnColumn(plain, 'interactive'));
    }
  });

  it('fits an account row with an ambiguous label, folder and poll error to the width', () => {
    const st = stateWith(
      snapshotOf([
        account('id-o', 'Ωmega·α', {
          folders: ['C:/proj—client'],
          usage: usage([], undefined, { error: 'HTTP 429 × 3 retries' }),
        }),
        account('id-p', 'plain'),
      ]),
    );
    for (const cols of [40, 80, 120, 200]) {
      const lines = frame(st, cols, ROWS, false);
      for (const line of lines)
        expect(drawn(line), `at ${cols}: ${line}`).toBeLessThanOrEqual(cols);
    }
  });

  it('wraps a foreign error on the status line by the width it is drawn at', () => {
    const foreign = 'Zugriff verweigert § 3 ± 2 ° ※ ' + 'Pfad nicht gefunden '.repeat(4);
    const st = {
      ...stateWith(snapshotOf(everyStateAccounts())),
      status: { text: foreign, tone: 'error' as const },
    };
    for (const cols of [40, 41, 61, 80]) {
      const lines = frame(st, cols, ROWS, false);
      for (const line of lines)
        expect(drawn(line), `at ${cols}: ${line}`).toBeLessThanOrEqual(cols);
      expect(lines.join('\n'), `at ${cols}`).toContain('§');
    }
  });
});

describe('a message longer than the status line', () => {
  const s = stateWith(snapshotOf(everyStateAccounts()));
  const id = '3f2b9c1e-7a4d-4e1b-9c2a-5d6e7f8a1b5e';
  const taken =
    `"home" already refers to account ${id} ("home"); ` +
    'two accounts answering to one name could not be told apart on switch';
  const added =
    `Added research-team-shared-account (${id}). Your current login was not touched - ` +
    '`cctl switch research-team-shared-account` to use it.';

  it.each([
    [taken, 40, ROWS, 'could not be told apart on switch', true],
    [taken, 60, ROWS, 'could not be told apart on switch', false],
    [taken, 60, MIN_ROWS, 'apart on switch', true],
    [added, 40, ROWS, 'to use it.', true],
    [added, 60, MIN_ROWS, 'to use it.', true],
  ])('keeps its start and its end (%#)', (text, cols, rows, end, cut) => {
    const lines = frame({ ...s, status: { text, tone: 'error' } }, cols, rows, false);
    const said = lines.slice(2, rows - 1).join(' ');
    expect(said).toContain(text.slice(0, 8));
    expect(said).toContain(end);
    // A message that had to be cut says how to read the rest.
    expect(lines[rows - 1]!.startsWith('m message | ')).toBe(cut);
  });

  it('is shown whole, and scrolls, in the message overlay (m)', () => {
    const said = { ...s, status: { text: `${taken} ${added}`, tone: 'warn' as const } };
    const open = reduce(said, { name: 'char', char: 'm' }).state;
    expect(open.mode).toEqual({ kind: 'message', scroll: 0 });
    const lines = frame(open, 40, ROWS, false);
    const all = frame(
      settleScroll({ ...open, mode: { kind: 'message', scroll: 999 } }, ROWS, PLAIN_PALETTE, 40),
      40,
      ROWS,
      false,
    );
    expect(lines.slice(2).join(' ')).toContain('"home" already refers to');
    expect(all.slice(2).join(' ')).toContain('to use it.');
    expect(reduce(open, { name: 'char', char: 'x' }).state.mode).toEqual({ kind: 'browse' });
  });

  it('says how to read a refusal cut short in a reopened prompt', () => {
    const refusal =
      'Not renamed: could not write C:/Users/someone/AppData/Local/claude-control/vault/' +
      'accounts.json (EPERM: operation not permitted, rename); close the program holding it ' +
      'and try again';
    const prompt = {
      ...s,
      mode: {
        kind: 'prompt' as const,
        purpose: 'rename' as const,
        account: { id: 'id-work', label: 'work' },
        input: 'other',
        note: refusal,
        refusal,
      },
    };
    for (const [cols, rows] of [
      [40, ROWS],
      [80, MIN_ROWS],
    ] as const) {
      const lines = frame(prompt, cols, rows, false);
      expect(lines[rows - 1], `${cols}x${rows}`).toContain('Esc, then m: full note');
      expect(lines[rows - 1], `${cols}x${rows}`).toContain('Enter confirm');
    }
    // A note that fits needs no such hint.
    const short = frame(
      { ...prompt, mode: { ...prompt.mode, note: 'Not renamed.', refusal: 'Not renamed.' } },
      80,
      ROWS,
      false,
    );
    expect(short[ROWS - 1]).toBe('Enter confirm | Esc cancel');
  });

  it('does not offer m while an action runs, when m would do nothing', () => {
    const busy = { ...s, busy: `Renaming ${'x'.repeat(200)}...` };
    expect(frame(busy, 40, ROWS, false)[ROWS - 1]!.startsWith('m message')).toBe(false);
  });

  it('never takes the row of the selected account, however short the terminal', () => {
    const accounts = accountsOf(s);
    const last = accounts[accounts.length - 1]!;
    const said = {
      ...s,
      selectedId: last.id,
      status: { text: `${taken} ${added}`, tone: 'error' as const },
    };
    for (const [cols, rows] of [
      [40, MIN_ROWS],
      [40, MIN_ROWS + 1],
      [80, MIN_ROWS],
      [80, MIN_ROWS + 1],
    ] as const) {
      const lines = frame(said, cols, rows, false);
      const selected = lines.filter((l) => l.startsWith('>'));
      expect(selected, `${cols}x${rows}`).toHaveLength(1);
      expect(selected[0], `${cols}x${rows}`).toContain(last.label.slice(0, 3));
      // The message still keeps its end, and says how to read the rest.
      expect(lines.join(' '), `${cols}x${rows}`).toContain('to use it.');
      expect(lines[rows - 1]!.startsWith('m message | '), `${cols}x${rows}`).toBe(true);
    }
  });

  it('keeps the remedy of an unreadable accounts file in a short terminal', () => {
    const error =
      'C:/Users/someone/AppData/Local/claude-control/vault/accounts.json is not valid JSON (Unexpected end of JSON input); fix the file or move it aside';
    const st = stateWith(snapshotOf([], { accounts: { ok: false, error } }));
    const body = frame(st, 80, MIN_ROWS, false).join('\n');
    expect(body).toContain('Could not read the accounts');
    expect(body).toContain('fix the file or move it aside');
  });
});

describe('width of emoji and combining marks', () => {
  it.each([
    ['🚀ops', 5],
    ['✅ok', 4],
    ['⚡x', 3],
    ['❤️x', 3],
    ['🫠x', 3],
    ['👨‍👩‍👧fam', 5],
    ['🇯🇵', 2],
    ['ทีมงาน', 5],
    ['नमस्ते', 4],
    ['\u1112\u1161\u11ab', 2],
    ['a\u20d7', 1],
    // A skin tone joins its emoji into one glyph, with or without a joiner.
    ['\ud83d\udc4d\ud83c\udffdx', 3],
    ['\ud83d\udc4b\ud83c\udffb\ud83d\udc4b\ud83c\udfff', 4],
    ['\u261d\u{1f3fd}', 2],
  ])('%s is %i columns', (text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it('never splits a cluster when cutting', () => {
    expect(fit('👨‍👩‍👧family', 4)).toBe('👨‍👩‍👧..');
    expect(truncateAnsi('❤️x', 2)).toBe('❤️');
  });
});
