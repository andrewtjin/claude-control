import { describe, it, expect } from 'vitest';
import {
  describeEnforceMode,
  describeSlotLive,
  renderFolderGuardFooter,
  renderFolderRule,
  renderFolderRulesSection,
  renderFolders,
  renderReservedAccounts,
  renderWhere,
  shellQuote,
  vscodeProfileName,
  vscodeProfileNames,
  type FolderRuleView,
  type GlobalSlotView,
  type PoolEntryView,
} from './folderRender.js';
import { ANSI_PALETTE, PLAIN_PALETTE } from './ansi.js';

const entry = (over: Partial<PoolEntryView> & { label: string }): PoolEntryView => ({
  source: 'inherited',
  live: false,
  liveElsewhere: null,
  quarantined: false,
  autoTarget: true,
  ...over,
});

// A rule on C:\repos\research that includes E and B and excludes D: E is live, B is dead, then the
// inherited shared accounts A (live in the global slot) and C (globally excluded).
const research: FolderRuleView = {
  label: 'research',
  folders: ['C:\\repos\\research'],
  include: ['E', 'B'],
  exclude: ['D'],
  live: { label: 'E', source: 'include', quarantined: false },
  pool: [
    entry({ label: 'E', source: 'include', live: true }),
    entry({ label: 'B', source: 'include', quarantined: true, autoTarget: false }),
    entry({ label: 'A', liveElsewhere: 'the global slot' }),
    entry({ label: 'C', autoTarget: false }),
  ],
  profileDir: 'C:\\data\\profiles\\r1',
};

const globalSlot: GlobalSlotView = {
  live: { label: 'A', source: 'inherited', quarantined: false },
  pool: [entry({ label: 'A', live: true }), entry({ label: 'C', autoTarget: false })],
};

describe('renderFolderRule', () => {
  it('shows folders, includes, excludes, the live account and the pool in order', () => {
    const out = renderFolderRule(research, PLAIN_PALETTE);
    expect(out).toContain('folder:   C:\\repos\\research');
    expect(out).toContain('includes: E, B');
    expect(out).toContain('excludes: D');
    expect(out).toContain('live:     E (included)');
    expect(out).toContain('profile:  C:\\data\\profiles\\r1');
    // The pool, numbered in order, every limit spelled out.
    const lines = out.split('\n');
    const at = (label: string) => lines.findIndex((l) => l.includes(`. ${label}  `));
    expect(at('E')).toBeLessThan(at('B'));
    expect(at('B')).toBeLessThan(at('A'));
    expect(at('A')).toBeLessThan(at('C'));
    expect(out).toContain('1. E  included, live here');
    expect(out).toContain('2. B  included, quarantined');
    expect(out).toContain('3. A  inherited, live in the global slot');
    expect(out).toContain('4. C  inherited, not an auto-switch target');
  });

  it('aligns pool continuation lines under the first account', () => {
    const lines = renderFolderRule(research, PLAIN_PALETTE).split('\n');
    const first = lines.find((l) => l.startsWith('  pool:     1.'))!;
    const second = lines.find((l) => l.includes('2. B'))!;
    expect(second.indexOf('2.')).toBe(first.indexOf('1.'));
  });

  it('says what an empty include or exclude list means', () => {
    const out = renderFolderRule({ ...research, include: [], exclude: [] }, PLAIN_PALETTE);
    expect(out).toContain('includes: nothing (no account is reserved to it)');
    expect(out).toContain('excludes: nothing');
  });

  it('strips terminal control and bidi sequences from labels and folders', () => {
    const out = renderFolderRule(
      {
        ...research,
        label: '\u001b[31mwork\u202e',
        folders: ['C:\\r\u200eepos'],
        include: ['a\u0007b'],
        pool: [entry({ label: 'x\u001b[2Jy', liveElsewhere: 'the folder slot of C:\\z\u202e' })],
      },
      PLAIN_PALETTE,
    );
    for (const bad of ['\u001b', '\u202e', '\u200e', '\u0007']) expect(out).not.toContain(bad);
    expect(out).toContain('work');
  });
});

describe('describeSlotLive', () => {
  it('names an inherited account in a folder with includes as a fallback', () => {
    const live = { label: 'A', source: 'inherited', quarantined: false } as const;
    expect(describeSlotLive(live, [], 'rule-with-includes')).toBe(
      'A (inherited from the shared pool: no included account is available)',
    );
    expect(describeSlotLive(live, [], 'rule')).toBe('A (inherited from the shared pool)');
    expect(describeSlotLive(live, [], 'global')).toBe('A');
  });

  it('tells an empty slot with a free account apart from one with nothing usable', () => {
    expect(describeSlotLive(null, [entry({ label: 'A' })], 'rule')).toContain('none yet');
    const none = describeSlotLive(
      null,
      [
        entry({ label: 'A', liveElsewhere: 'the global slot' }),
        entry({ label: 'B', quarantined: true }),
      ],
      'rule',
    );
    expect(none).toContain('none usable');
    expect(none).toContain('cctl accounts relogin');
  });

  it('flags a quarantined or out-of-pool live account', () => {
    expect(
      describeSlotLive({ label: 'B', source: 'include', quarantined: true }, [], 'rule'),
    ).toContain('quarantined; re-login it: cctl accounts relogin B');
    expect(
      describeSlotLive({ label: 'D', source: 'outside', quarantined: false }, [], 'rule'),
    ).toContain('not in this pool any more');
  });

  it('paints an unusable slot red', () => {
    const out = describeSlotLive(null, [], 'rule', ANSI_PALETTE);
    expect(out.startsWith('\u001b[31m')).toBe(true);
  });
});

describe('renderFolders', () => {
  const footer = { present: true, fresh: true, enforce: 'block' } as const;

  it('says no folder has a rule and how to add one', () => {
    const out = renderFolders({ rules: [], global: globalSlot, footer }, PLAIN_PALETTE);
    expect(out).toContain('No folder rules');
    expect(out).toContain('cctl folder include <folder> <account>');
    expect(out).toContain('cctl folder exclude <folder> <account>');
  });

  it('lists every rule, then the global slot, then the guard footer', () => {
    const out = renderFolders({ rules: [research], global: globalSlot, footer }, PLAIN_PALETTE);
    const rule = out.indexOf('research');
    const global = out.indexOf('every other folder (the global slot)');
    const guard = out.indexOf('enforcement: block');
    expect(rule).toBeGreaterThanOrEqual(0);
    expect(global).toBeGreaterThan(rule);
    expect(guard).toBeGreaterThan(global);
    expect(out).toContain('guard snapshot: fresh');
  });
});

describe('renderFolderGuardFooter', () => {
  it('reports a missing, a stale and a fresh snapshot', () => {
    expect(renderFolderGuardFooter({ present: false, fresh: false, enforce: 'block' })).toContain(
      'missing',
    );
    const stale = renderFolderGuardFooter({ present: true, fresh: false, enforce: 'warn' });
    expect(stale).toContain('enforcement: warn');
    expect(stale).toContain('STALE');
    expect(stale).toContain('cctl daemon restart');
    expect(renderFolderGuardFooter({ present: true, fresh: true, enforce: 'off' })).toContain(
      'fresh',
    );
  });

  it('says what each mode does: block refuses only what a rule rules out', () => {
    expect(renderFolderGuardFooter({ present: true, fresh: true, enforce: 'block' })).toContain(
      "enforcement: block (refuses a session on an account a folder's rule rules out, or on " +
        "another folder's slot)",
    );
    expect(describeEnforceMode('warn')).toBe('flags those sessions, refuses none');
    expect(describeEnforceMode('off')).toBe('no check');
  });
});

describe('renderFolderRulesSection', () => {
  it('is empty with no rules', () => {
    expect(renderFolderRulesSection([])).toBe('');
  });

  it('gives each rule its folders, live account and pool on one line', () => {
    const out = renderFolderRulesSection([research], PLAIN_PALETTE);
    expect(out).toContain('Folder rules');
    expect(out).toContain('research  C:\\repos\\research');
    expect(out).toContain('live: E (included)');
    expect(out).toContain(
      'pool: *E, B (quarantined), A (live in the global slot), C (not an auto-switch target)',
    );
  });
});

describe('renderReservedAccounts', () => {
  it('is empty with nothing reserved', () => {
    expect(renderReservedAccounts([])).toBe('');
  });

  it('shows each reserved account with its email, plan, billing and the folders that include it', () => {
    const out = renderReservedAccounts(
      [
        {
          id: 'e-1',
          label: 'E',
          email: 'e@example.com',
          plan: '5x',
          billing: '~Oct 20 (est.)',
          quarantined: false,
          live: true,
          includedBy: ['C:\\repos\\research', 'C:\\repos\\labs'],
        },
        {
          id: 'b-1',
          label: 'B',
          email: undefined,
          plan: '?',
          billing: 'unknown',
          quarantined: true,
          live: false,
          includedBy: ['C:\\repos\\research'],
        },
      ],
      PLAIN_PALETTE,
    );
    expect(out).toContain('Reserved to folder rules');
    expect(out).toMatch(/EMAIL\s+PLAN\s+BILLING\s+STATUS\s+INCLUDED BY/);
    const e = out.split('\n').find((l) => l.includes('e@example.com'))!;
    expect(e.startsWith('*')).toBe(true);
    expect(e).toMatch(/e@example\.com\s+5x\s+~Oct 20 \(est\.\)\s+ok\s/);
    expect(e).toContain('C:\\repos\\research; C:\\repos\\labs');
    const b = out.split('\n').find((l) => l.includes('b-1'))!;
    expect(b).toMatch(/ - +\? +unknown +quarantined /);
  });

  it('starts every cell of a column at the same offset as its header', () => {
    // Pad first, paint after: a plan or billing cell wider than its header must push every column
    // after it right on every line, or the table reads as shifted.
    const row = (id: string, plan: string, billing: string) => ({
      id,
      label: id.toUpperCase(),
      email: `${id}@example.com`,
      plan,
      billing,
      quarantined: false,
      live: false,
      includedBy: ['C:\\r'],
    });
    const out = renderReservedAccounts([row('e', '20x', 'trial->Nov 3'), row('f', '?', 'unknown')]);
    const [, header, ...rows] = out.split('\n');
    for (const col of ['PLAN', 'BILLING', 'STATUS', 'INCLUDED BY', 'ID']) {
      const at = header!.indexOf(col);
      for (const line of rows) {
        expect(line.slice(at - 2, at)).toBe('  ');
        expect(line[at]).not.toBe(' ');
      }
    }
  });

  it('strips control sequences from a crafted label, email or billing', () => {
    const out = renderReservedAccounts([
      {
        id: 'x',
        label: 'a\u001b[31m',
        email: 'e\u202e@x',
        plan: '?',
        billing: 'inv\u001b[2Joice',
        quarantined: false,
        live: false,
        includedBy: ['C:\\r\u0007'],
      },
    ]);
    for (const bad of ['\u001b', '\u202e', '\u0007']) expect(out).not.toContain(bad);
  });
});

describe('renderWhere', () => {
  it('explains a ruled folder: the rule, the match, the pool, the env line and a VS Code snippet', () => {
    const out = renderWhere(
      {
        folder: 'C:\\repos\\research\\sub',
        rule: { ...research, matchedFolder: 'C:\\repos\\research' },
        global: globalSlot,
      },
      PLAIN_PALETTE,
      'win32',
    );
    expect(out).toContain('runs on:  the folder rule research, in its own slot');
    expect(out).toContain('matched:  C:\\repos\\research (the longest matching rule wins');
    expect(out).toContain('live:     E (included)');
    expect(out).toContain('1. E  included, live here');
    expect(out).toContain('CLAUDE_CONFIG_DIR=C:\\data\\profiles\\r1');
    // A plain `claude` here runs on the global slot: accepted unless on an excluded account, and a
    // background one is moved onto the folder's own accounts.
    expect(out).toContain(
      'global:   a session on the global slot is accepted unless it is on D; cctl moves ' +
        'background sessions onto E, B between turns',
    );
    // The extension's setting is machine-scoped: a folder's .vscode/settings.json is ignored, so the
    // advice is a VS Code profile whose USER settings carry it, never the workspace file.
    expect(out).toContain('USER settings only');
    expect(out).toContain("code --profile 'cctl-research' 'C:\\repos\\research\\sub'");
    expect(out).toContain('Open User Settings (JSON)');
    // The printed snippet must parse and carry the extension's array-of-{name,value} shape.
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['claudeCode.environmentVariables']).toEqual([
      { name: 'CLAUDE_CONFIG_DIR', value: 'C:\\data\\profiles\\r1' },
    ]);
  });

  it('words the global-slot line for a rule that excludes nothing, or includes nothing', () => {
    const where = (rule: FolderRuleView): string =>
      renderWhere(
        { folder: 'C:\\w', rule: { ...rule, matchedFolder: 'C:\\w' }, global: globalSlot },
        PLAIN_PALETTE,
        'win32',
      );
    expect(where({ ...research, exclude: [] })).toContain(
      'global:   a session on the global slot is accepted; cctl moves background sessions onto ' +
        'E, B between turns',
    );
    expect(where({ ...research, include: [] })).toContain(
      'global:   a session on the global slot is accepted unless it is on D\n',
    );
  });

  it('quotes the VS Code command for the shell, whatever the folder or label holds', () => {
    const out = renderWhere(
      {
        folder: "C:\\it's $HOME",
        rule: { ...research, label: 'Work "Main"', matchedFolder: "C:\\it's $HOME" },
        global: globalSlot,
      },
      PLAIN_PALETTE,
      'win32',
    );
    // PowerShell single quotes: nothing expands inside, a quote is doubled.
    expect(out).toContain("code --profile 'cctl-Work-Main' 'C:\\it''s $HOME'");
  });

  it('uses POSIX quoting off Windows', () => {
    expect(shellQuote("a'b $c", 'linux')).toBe("'a'\\''b $c'");
    expect(shellQuote("a'b $c", 'win32')).toBe("'a''b $c'");
    expect(vscodeProfileName('  ')).toBe('cctl-folder');
  });

  it('explains a folder with no rule as the global slot, with its live account and pool', () => {
    const out = renderWhere({ folder: 'C:\\tmp', rule: null, global: globalSlot }, PLAIN_PALETTE);
    expect(out).toContain('the global slot and the shared pool (no folder rule applies here)');
    expect(out).toContain('live:    A');
    expect(out).toContain('1. A  live here');
    expect(out).toContain('CLAUDE_CONFIG_DIR is not set');
    expect(out).toContain("cctl folder include 'C:\\tmp' <account>");
    expect(out).toContain("cctl folder exclude 'C:\\tmp' <account>");
  });

  it('quotes the folder in the rule hints, so a path with spaces pastes as one argument', () => {
    const folder = 'C:\\code\\my projects\\x';
    for (const platform of ['win32', 'linux'] as const) {
      const out = renderWhere({ folder, rule: null, global: globalSlot }, PLAIN_PALETTE, platform);
      expect(out).toContain(`cctl folder include ${shellQuote(folder, platform)} <account>`);
      expect(out).toContain(`cctl folder exclude ${shellQuote(folder, platform)} <account>`);
    }
  });

  it('uses the VS Code profile it is given, so two rules never share one', () => {
    const out = renderWhere(
      {
        folder: 'C:\\code\\my-app',
        rule: { ...research, matchedFolder: 'C:\\code\\my-app', vscodeProfile: 'cctl-my-app-r2' },
        global: globalSlot,
      },
      PLAIN_PALETTE,
      'win32',
    );
    expect(out).toContain("code --profile 'cctl-my-app-r2' 'C:\\code\\my-app'");
  });
});

describe('vscodeProfileNames', () => {
  it('gives rules whose labels reduce to one name different profiles, the first rule keeping the plain one', () => {
    const names = vscodeProfileNames([
      { id: 'later-rule', label: 'C:\\code\\my-app', createdAtMs: 2 },
      { id: 'first-rule', label: 'C:\\code\\my app', createdAtMs: 1 },
      { id: 'han-1', label: '/研究', createdAtMs: 3 },
      { id: 'han-2', label: '/项目', createdAtMs: 4 },
      { id: 'alone', label: 'research', createdAtMs: 5 },
    ]);
    expect(names.get('first-rule')).toBe('cctl-C-code-my-app');
    expect(names.get('later-rule')).toBe('cctl-C-code-my-app-laterrul');
    expect(names.get('han-1')).toBe('cctl-folder');
    expect(names.get('han-2')).toBe('cctl-folder-han2');
    expect(names.get('alone')).toBe('cctl-research');
    expect(new Set(names.values()).size).toBe(5);
  });
});
