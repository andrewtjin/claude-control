// The import planner over every collision case: a login already stored, a label taken, rule
// scopes whose folders are missing or already ruled here, members that did not travel, and
// settings that are unknown, path-valued, invalid, unchanged or new.

import { describe, it, expect } from 'vitest';
import type { AccountView, FolderRule } from '@claude-control/switch-engine';
import type { ExportPayload, ExportedAccount, ExportedRule } from './exportPayload.js';
import { planImport, renderImportPlan, type FolderLookup, type PlanInput } from './importPlan.js';

function local(id: string, label: string, extra: Partial<AccountView> = {}): AccountView {
  return { id, label, quarantined: false, createdAtMs: 1, updatedAtMs: 1, ...extra };
}

function entry(label: string, extra: Partial<ExportedAccount> = {}): ExportedAccount {
  return {
    label,
    autoSwitchExcluded: false,
    bundle: {
      claudeAiOauth: { accessToken: 'a-' + label, refreshToken: 'r-' + label, expiresAt: 9 },
    },
    ...extra,
  };
}

function fileRule(extra: Partial<ExportedRule>): ExportedRule {
  return { label: 'r', folders: [], aliases: [], include: [], exclude: [], ...extra };
}

function payload(extra: Partial<ExportPayload>): ExportPayload {
  return {
    exportedAtMs: 0,
    cctlVersion: '1.1.0',
    platform: 'linux',
    accounts: [],
    rules: [],
    settings: { env: {} },
    ...extra,
  };
}

/** Folders that exist "here". */
const HERE = new Set(['/proj', '/proj/sub', '/other']);

function input(extra: Partial<PlanInput>): PlanInput {
  return {
    payload: payload({}),
    accounts: [],
    rules: [],
    config: undefined,
    replace: false,
    platform: 'linux',
    resolveFolder: (f) =>
      HERE.has(f)
        ? { ok: true, folder: f }
        : { ok: false, reason: 'the folder does not exist on this machine' },
    ...extra,
  };
}

describe('planImport: accounts', () => {
  it('adds new accounts, with or without tokens', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('work', { accountUuid: 'u1' }),
            { label: 'home', autoSwitchExcluded: true },
          ],
        }),
      }),
    );
    expect(plan.accounts).toEqual([
      { kind: 'add', entry: 0, label: 'work', withTokens: true, autoSwitchExcluded: false },
      { kind: 'add', entry: 1, label: 'home', withTokens: false, autoSwitchExcluded: true },
    ]);
  });

  it('skips a login already stored, whatever its label here', () => {
    const existing = local('id1', 'Job', { accountUuid: 'u1' });
    const plan = planImport(
      input({
        payload: payload({ accounts: [entry('work', { accountUuid: 'u1' })] }),
        accounts: [existing],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({
      kind: 'skip',
      existing,
      reason: 'already stored here',
    });
  });

  it('matches a login by the uuid its tokens name when the entry records none', () => {
    const existing = local('id1', 'work', { accountUuid: 'u1' });
    const e = entry('work');
    e.bundle!.oauthAccount = { accountUuid: 'u1' };
    const plan = planImport(input({ payload: payload({ accounts: [e] }), accounts: [existing] }));
    expect(plan.accounts[0]!.kind).toBe('skip');
  });

  it('with --replace, plans a replace only for tokens that name their login', () => {
    const existing = local('id1', 'work', { accountUuid: 'u1' });
    const named = entry('work', { accountUuid: 'u1' });
    named.bundle!.oauthAccount = { accountUuid: 'u1' };
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            named,
            { label: 'x', accountUuid: 'u2', autoSwitchExcluded: false },
            entry('y', { accountUuid: 'u3' }),
          ],
        }),
        accounts: [
          existing,
          local('id2', 'x', { accountUuid: 'u2' }),
          local('id3', 'y', { accountUuid: 'u3' }),
        ],
        replace: true,
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'replace', existing });
    expect(plan.accounts[1]).toMatchObject({
      kind: 'skip',
      reason: 'already stored here, and the file has no tokens for it',
    });
    expect(plan.accounts[2]).toMatchObject({ kind: 'skip' });
    expect((plan.accounts[2] as { reason: string }).reason).toContain(
      'do not say which login they belong to',
    );
  });

  it('matches an entry with no identity at all by label, against a row with none either', () => {
    const anon = local('id1', 'anon');
    const plan = planImport(
      input({
        payload: payload({ accounts: [{ label: 'anon', autoSwitchExcluded: false }] }),
        accounts: [anon],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'skip', existing: anon });
  });

  it('numbers a label taken here by another login, in any case, and past taken numbers', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('Work', { accountUuid: 'u-new' }),
            entry('home', { accountUuid: 'u-h' }),
          ],
        }),
        accounts: [
          local('id1', 'work', { accountUuid: 'u-old' }),
          local('id2', 'work (2)', { accountUuid: 'u-old2' }),
        ],
      }),
    );
    expect(plan.accounts[0]).toEqual({
      kind: 'add',
      entry: 0,
      label: 'Work (3)',
      renamedFrom: 'Work',
      withTokens: true,
      autoSwitchExcluded: false,
    });
    expect(plan.accounts[1]).toMatchObject({ label: 'home' });
  });

  it('numbers a label that spells an account id here, and two entries with one label', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('abc-123', { accountUuid: 'u1' }),
            entry('dup', { accountUuid: 'u2' }),
            entry('DUP', { accountUuid: 'u3' }),
          ],
        }),
        accounts: [local('abc-123', 'other')],
      }),
    );
    expect(plan.accounts.map((s) => (s.kind === 'add' ? s.label : s.kind))).toEqual([
      'abc-123 (2)',
      'dup',
      'DUP (2)',
    ]);
  });

  it('matches an entry with no login by email only against a row with no login either', () => {
    const noLogin = local('id1', 'mail', { emailAddress: 'M@x.com' });
    const withLogin = local('id2', 'mail2', { emailAddress: 'n@x.com', accountUuid: 'u9' });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('a', { emailAddress: 'm@x.com' }),
            entry('b', { emailAddress: 'n@x.com' }),
          ],
        }),
        accounts: [noLogin, withLogin],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'skip', existing: noLogin });
    expect(plan.accounts[1]).toMatchObject({ kind: 'add' });
  });

  it('stores a label with terminal controls stripped, the way the vault will', () => {
    const plan = planImport(
      input({ payload: payload({ accounts: [entry('ev' + String.fromCharCode(27) + '[31mil')] }) }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'add' });
    const label = (plan.accounts[0] as { label: string }).label;
    expect(label).not.toContain(String.fromCharCode(27));
  });
});

describe('planImport: rules', () => {
  const accounts = [
    entry('work', { accountUuid: 'u-work' }),
    entry('home', { accountUuid: 'u-home' }),
  ];

  /** A rule here, for collision cases. */
  function hereRule(extra: Partial<FolderRule>): FolderRule {
    return {
      id: 'rule-here',
      label: 'mine',
      folders: [],
      include: [],
      exclude: ['x'],
      activeId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      ...extra,
    };
  }

  it('plans a rule whole, every scope in one rule, with its members resolved by login then label', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts,
          rules: [
            fileRule({
              label: 'Client',
              folders: ['/proj'],
              aliases: [{ folder: '/proj', alias: 'Big Job' }],
              include: ['u-work'],
              exclude: ['home'],
            }),
          ],
        }),
      }),
    );
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0]).toMatchObject({
      label: 'Client',
      include: [{ entry: 0, label: 'work' }],
      exclude: [{ entry: 1, label: 'home' }],
      dropped: [],
    });
    expect(plan.rules[0]!.scopes.map((s) => [s.kind, s.folder, s.skip])).toEqual([
      ['folder', '/proj', undefined],
      ['alias', '/proj', undefined],
    ]);
  });

  it('does not carry a default rule name as a chosen one', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts,
          rules: [fileRule({ label: '/proj', folders: ['/proj'], include: ['u-work'] })],
        }),
      }),
    );
    expect(plan.rules[0]!.label).toBeUndefined();
  });

  it('resolves a member to an account already stored here, and the label it has here', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [],
          rules: [fileRule({ folders: ['/proj'], exclude: ['u-mine'] })],
        }),
        accounts: [local('id-mine', 'mine', { accountUuid: 'u-mine' })],
      }),
    );
    expect(plan.rules[0]!.exclude).toEqual([{ existingId: 'id-mine', label: 'mine' }]);
  });

  it('shows a member by the label it gets here', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('work', { accountUuid: 'u-work' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-work'] })],
        }),
        accounts: [local('id1', 'work', { accountUuid: 'u-other' })],
      }),
    );
    expect(plan.rules[0]!.include).toEqual([{ entry: 0, label: 'work (2)' }]);
  });

  it('leaves out the scopes it cannot use and makes the rule on the rest', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts,
          rules: [
            fileRule({
              folders: ['/proj', '/gone', '/other', '/vault'],
              include: ['u-work'],
            }),
          ],
        }),
        rules: [hereRule({ folders: ['/other'] })],
        checkScope: (s) =>
          s.folder === '/vault' ? 'overlaps the cctl vault directory' : undefined,
        resolveFolder: (f) =>
          HERE.has(f) || f === '/vault'
            ? { ok: true, folder: f }
            : { ok: false, reason: 'the folder does not exist on this machine' },
      }),
    );
    expect(plan.rules[0]!.skip).toBeUndefined();
    expect(plan.rules[0]!.scopes.map((s) => s.skip)).toEqual([
      undefined,
      'the folder does not exist on this machine',
      'this machine has another rule there; it is left as it is',
      'overlaps the cctl vault directory',
    ]);
  });

  it('adds the members a rule here lacks when it holds exactly the same scopes', () => {
    const here = hereRule({ folders: ['/proj'], include: ['id-w'], exclude: [] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [],
          rules: [fileRule({ folders: ['/proj'], include: ['u-w'], exclude: ['u-h'] })],
        }),
        accounts: [
          local('id-w', 'work', { accountUuid: 'u-w', ruleIds: ['rule-here'] }),
          local('id-h', 'home', { accountUuid: 'u-h' }),
        ],
        rules: [here],
      }),
    );
    expect(plan.rules[0]).toMatchObject({
      into: here,
      include: [],
      exclude: [{ existingId: 'id-h', label: 'home' }],
    });
    expect(renderImportPlan(plan)).toContain('folder /proj: add to the rule here, exclude home');
  });

  it('says a rule is already in place, and skips the rest for their reasons', () => {
    const here = hereRule({ folders: ['/proj'], include: ['id-w'], exclude: [] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('w', { accountUuid: 'u-w' })],
          rules: [
            fileRule({ folders: ['/proj'], include: ['u-w'] }),
            fileRule({ folders: ['/gone'], include: ['u-w'] }),
            fileRule({ folders: ['/other'], include: ['u-w'] }),
            fileRule({ folders: ['/other'], include: ['u-w'] }),
            fileRule({ folders: ['/proj/sub'], include: ['u-nobody'] }),
            fileRule({ folders: ['/proj/sub'], include: ['u-nobody'], exclude: ['u-w'] }),
          ],
        }),
        accounts: [local('id-w', 'w', { accountUuid: 'u-w', ruleIds: ['rule-here'] })],
        rules: [here],
      }),
    );
    expect(plan.rules.map((r) => r.skip)).toEqual([
      'this machine already has this rule, with these accounts',
      'the folder does not exist on this machine',
      undefined,
      'the file lists it twice',
      'none of its accounts came along',
      'none of the accounts it includes is in the file or on this machine',
    ]);
    expect(plan.rules[4]!.dropped).toEqual(['u-nobody']);
  });

  it('leaves out an exclusion of an account a rule here reserves, but keeps one the file reserves', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('a', { accountUuid: 'u-a' })],
          rules: [
            fileRule({ folders: ['/proj'], exclude: ['u-a', 'u-r'] }),
            fileRule({ folders: ['/other'], include: ['u-a'] }),
          ],
        }),
        accounts: [local('id-r', 'r', { accountUuid: 'u-r', ruleIds: ['elsewhere'] })],
      }),
    );
    expect(plan.rules[0]!.exclude.map((m) => m.label)).toEqual(['a']);
    expect(plan.rules[0]!.leftOut).toEqual(['r (another rule here reserves it)']);
  });

  it('stops at the rule cap, before the engine would refuse', () => {
    const rules = Array.from({ length: 64 }, (_, i) =>
      hereRule({ id: `r${i}`, folders: [`/r${i}`] }),
    );
    const plan = planImport(
      input({
        payload: payload({
          accounts,
          rules: [fileRule({ folders: ['/proj'], include: ['u-work'] })],
        }),
        rules,
      }),
    );
    expect(plan.rules[0]!.skip).toBe('this machine would have more than 64 rules');
  });

  it("foresees moving this machine's main login, and skips a rule that would leave it nothing", () => {
    const rules = [fileRule({ folders: ['/proj'], include: ['u-live'] })];
    const live = local('id-live', 'live', { accountUuid: 'u-live' });
    const moves = planImport(
      input({
        payload: payload({ rules }),
        accounts: [live, local('id-o', 'other', { accountUuid: 'u-o' })],
        globalLive: 'id-live',
      }),
    );
    expect(moves.rules[0]!.notes).toEqual([
      "this machine's main login moves off live, which this rule reserves",
    ]);
    const stuck = planImport(
      input({ payload: payload({ rules }), accounts: [live], globalLive: 'id-live' }),
    );
    expect(stuck.rules[0]!.skip).toContain(
      "including live would leave this machine's main login with no shared account",
    );
  });

  it('keeps out of auto-switch an added account whose only rule is not made here', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('client', { accountUuid: 'u-c' }),
            entry('work', { accountUuid: 'u-w' }),
          ],
          rules: [fileRule({ folders: ['/gone'], include: ['u-c'] })],
        }),
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ autoSwitchExcluded: true, heldBack: true });
    expect(plan.accounts[1]).toMatchObject({ autoSwitchExcluded: false });
  });

  it('touches no folder for a rule it skips anyway: on macOS, and while an older daemon runs', () => {
    const looked: string[] = [];
    const rules = [
      fileRule({
        folders: ['/proj'],
        aliases: [{ folder: '/proj', alias: 'a' }],
        include: ['u-work'],
      }),
    ];
    const resolveFolder = (f: string): FolderLookup => {
      looked.push(f);
      return { ok: true, folder: f };
    };
    const mac = planImport(
      input({ payload: payload({ accounts, rules }), platform: 'darwin', resolveFolder }),
    );
    expect(mac.rules[0]!.skip).toBe('folder rules are not supported on macOS yet');
    const blocked = planImport(
      input({
        payload: payload({ accounts, rules }),
        rulesBlocked: { alias: 'old daemon (alias)' },
        resolveFolder,
      }),
    );
    expect(blocked.rules[0]!.skip).toBe('old daemon (alias)');
    expect(looked).toEqual([]);
  });

  it('notes a file from another platform when it carries rules', () => {
    const plan = planImport(
      input({
        payload: payload({
          platform: 'win32',
          accounts,
          rules: [fileRule({ folders: ['C:\\p'], include: ['u-work'] })],
        }),
      }),
    );
    expect(plan.notes.join('\n')).toContain('win32');
  });
});

describe('planImport: settings', () => {
  it('sets new values, leaves equal ones, and skips unknown, path-valued, invalid ones and the relay', () => {
    const plan = planImport(
      input({
        payload: payload({
          settings: {
            relayUrl: 'wss://relay.example',
            env: {
              CCTL_AUTOSWITCH: 'off',
              CCTL_LOG_LEVEL: 'INFO',
              CCTL_LOG_FILE: '/var/log/x',
              CCTL_TRIGGER_PCT: '5',
              CCTL_AUTOSWITCH_TRIGGER_PCT: 'lots',
              CCTL_GREEDY_TYPO: '1',
            },
          },
        }),
        config: { env: { CCTL_LOG_LEVEL: 'info' } },
      }),
    );
    expect(plan.settings.map((s) => [s.kind, s.name])).toEqual([
      ['skip', 'CCTL_RELAY_URL'],
      ['set', 'CCTL_AUTOSWITCH'],
      ['same', 'CCTL_LOG_LEVEL'],
      ['skip', 'CCTL_LOG_FILE'],
      ['skip', 'CCTL_TRIGGER_PCT'],
      ['skip', 'CCTL_AUTOSWITCH_TRIGGER_PCT'],
      ['skip', 'CCTL_GREEDY_TYPO'],
    ]);
  });

  it('keeps a value this machine has unless --replace, and says when the environment overrides', () => {
    const base = {
      payload: payload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
      config: { env: { CCTL_AUTOSWITCH: 'on' } },
    };
    expect(planImport(input(base)).settings).toEqual([
      { kind: 'kept', name: 'CCTL_AUTOSWITCH', value: 'off', here: 'on' },
    ]);
    expect(
      planImport(input({ ...base, replace: true, env: { CCTL_AUTOSWITCH: '1' } })).settings,
    ).toEqual([
      { kind: 'set', name: 'CCTL_AUTOSWITCH', value: 'off', previous: 'on', overridden: true },
    ]);
  });
});

describe('renderImportPlan', () => {
  it('prints every account, rule and setting with what will happen', () => {
    const p = payload({
      platform: `linux`,
      accounts: [
        entry('work', { accountUuid: 'u-work' }),
        { label: 'home', accountUuid: 'u-home', autoSwitchExcluded: true },
      ],
      rules: [fileRule({ folders: ['/proj', '/gone'], include: ['u-work'], exclude: ['u-home'] })],
      settings: { env: { CCTL_AUTOSWITCH: 'off' } },
    });
    const text = renderImportPlan(planImport(input({ payload: p })));
    expect(text).toContain('work: add, with its tokens');
    expect(text).toContain(
      'home: add, waiting for a login (no tokens in the file), excluded from auto-switch',
    );
    expect(text).toContain('folder /proj: create, include work; exclude home');
    expect(text).toContain(
      '    folder /gone: left out - the folder does not exist on this machine',
    );
    expect(text).toContain('CCTL_AUTOSWITCH=off');
  });

  it('says so when the file has nothing of a kind', () => {
    expect(renderImportPlan(planImport(input({ payload: payload({}) })))).toBe(
      'Accounts:\n  (none in the file)\nRules:\n  (none in the file)\nSettings:\n  (none in the file)\n',
    );
  });
});
