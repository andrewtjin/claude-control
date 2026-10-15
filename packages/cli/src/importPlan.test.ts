// The import planner over every collision case: a login already stored, a label taken, rule
// scopes whose folders are missing or already ruled here, members that did not travel, and
// settings that are unknown, path-valued, invalid, unchanged or new.

import { describe, it, expect } from 'vitest';
import type { AccountView, FolderRule } from '@claude-control/switch-engine';
import type { ExportPayload, ExportedAccount, ExportedRule } from './exportPayload.js';
import { planImport, renderImportPlan, type PlanInput, type ScopeStep } from './importPlan.js';

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
    resolveFolder: (f) => (HERE.has(f) ? f : undefined),
    ...extra,
  };
}

function scopeSkips(steps: ScopeStep[]): (string | undefined)[] {
  return steps.map((s) => s.skip);
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
      { kind: 'add', entry: 0, label: 'work', withTokens: true },
      { kind: 'add', entry: 1, label: 'home', withTokens: false },
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

  it('with --replace, plans a replace only when the file has tokens', () => {
    const existing = local('id1', 'work', { accountUuid: 'u1' });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('work', { accountUuid: 'u1' }),
            { label: 'x', accountUuid: 'u2', autoSwitchExcluded: false },
          ],
        }),
        accounts: [existing, local('id2', 'x', { accountUuid: 'u2' })],
        replace: true,
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'replace', existing });
    expect(plan.accounts[1]).toMatchObject({
      kind: 'skip',
      reason: 'already stored here, and the file has no tokens for it',
    });
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

  it('plans each scope with its members resolved, by login then by label', () => {
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
    expect(plan.scopes).toHaveLength(2);
    expect(plan.scopes[0]).toMatchObject({
      kind: 'folder',
      folder: '/proj',
      ruleLabel: 'Client',
      include: [{ entry: 0, label: 'work' }],
      exclude: [{ entry: 1, label: 'home' }],
      dropped: [],
    });
    // The display name goes to the first rule created from the source rule only.
    expect(plan.scopes[1]).toMatchObject({ kind: 'alias', alias: 'Big Job', folder: '/proj' });
    expect(plan.scopes[1]!.ruleLabel).toBeUndefined();
    expect(scopeSkips(plan.scopes)).toEqual([undefined, undefined]);
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
    expect(plan.scopes[0]!.ruleLabel).toBeUndefined();
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
    expect(plan.scopes[0]!.exclude).toEqual([{ existingId: 'id-mine', label: 'mine' }]);
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
    expect(plan.scopes[0]!.include).toEqual([{ entry: 0, label: 'work (2)' }]);
  });

  it('skips scopes whose folder is missing, already ruled here, listed twice, or left with no members', () => {
    const here: FolderRule = {
      id: 'rule-here',
      label: 'mine',
      folders: ['/other'],
      include: [],
      exclude: ['x'],
      activeId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const plan = planImport(
      input({
        payload: payload({
          accounts,
          rules: [
            fileRule({ folders: ['/gone', 'C:\\Users\\me\\proj'], include: ['u-work'] }),
            fileRule({ folders: ['/other'], include: ['u-work'] }),
            fileRule({ folders: ['/proj'], include: ['u-work'] }),
            fileRule({ folders: ['/proj'], include: ['u-home'] }),
            fileRule({ folders: ['/proj/sub'], include: ['u-nobody'] }),
          ],
        }),
        rules: [here],
      }),
    );
    expect(scopeSkips(plan.scopes)).toEqual([
      'the folder does not exist on this machine',
      'the folder does not exist on this machine',
      'this machine already has a rule there; it is left as it is',
      undefined,
      'the file lists it twice',
      'none of its accounts came along',
    ]);
    expect(plan.scopes[5]!.dropped).toEqual(['u-nobody']);
  });

  it('skips an alias scope this machine already has a rule for', () => {
    const here: FolderRule = {
      id: 'rule-here',
      label: 'mine',
      folders: [],
      aliases: [{ folder: '/proj', alias: 'big job' }],
      include: [],
      exclude: ['x'],
      activeId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const plan = planImport(
      input({
        payload: payload({
          accounts,
          rules: [
            fileRule({ aliases: [{ folder: '/proj', alias: 'Big Job ' }], include: ['u-work'] }),
          ],
        }),
        rules: [here],
      }),
    );
    expect(plan.scopes[0]!.skip).toContain('already has a rule');
  });

  it('skips every scope on macOS, and the blocked kinds while an older daemon runs', () => {
    const rules = [
      fileRule({
        folders: ['/proj'],
        aliases: [{ folder: '/proj', alias: 'a' }],
        include: ['u-work'],
      }),
    ];
    const mac = planImport(input({ payload: payload({ accounts, rules }), platform: 'darwin' }));
    expect(scopeSkips(mac.scopes)).toEqual([
      'folder rules are not supported on macOS yet',
      'folder rules are not supported on macOS yet',
    ]);
    const aliasOnly = planImport(
      input({
        payload: payload({ accounts, rules }),
        rulesBlocked: { alias: 'old daemon (alias)' },
      }),
    );
    expect(scopeSkips(aliasOnly.scopes)).toEqual([undefined, 'old daemon (alias)']);
    const both = planImport(
      input({ payload: payload({ accounts, rules }), rulesBlocked: { folder: 'old daemon' } }),
    );
    expect(scopeSkips(both.scopes)).toEqual(['old daemon', 'old daemon']);
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
  it('sets new values, leaves equal ones, and skips unknown, path-valued and invalid ones', () => {
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
        config: {
          relayUrl: 'wss://relay.example',
          env: { CCTL_AUTOSWITCH: 'on', CCTL_LOG_LEVEL: 'info' },
        },
      }),
    );
    expect(plan.settings).toEqual([
      { kind: 'set', name: 'CCTL_AUTOSWITCH', value: 'off', previous: 'on' },
      { kind: 'same', name: 'CCTL_LOG_LEVEL', value: 'info' },
      { kind: 'skip', name: 'CCTL_LOG_FILE', reason: 'it names a path on the other machine' },
      { kind: 'skip', name: 'CCTL_TRIGGER_PCT', reason: 'not a setting this cctl knows' },
      {
        kind: 'skip',
        name: 'CCTL_AUTOSWITCH_TRIGGER_PCT',
        reason: 'CCTL_AUTOSWITCH_TRIGGER_PCT takes a non-negative number, not "lots"',
      },
      { kind: 'skip', name: 'CCTL_GREEDY_TYPO', reason: 'not a setting this cctl knows' },
      { kind: 'same', name: 'CCTL_RELAY_URL', value: 'wss://relay.example' },
    ]);
  });

  it('sets the relay when it differs, and a setting with no value here yet', () => {
    const plan = planImport(
      input({
        payload: payload({
          settings: { relayUrl: 'wss://mine.example', env: { CCTL_WAITING_CARDS: 'on' } },
        }),
      }),
    );
    expect(plan.settings).toEqual([
      { kind: 'set', name: 'CCTL_WAITING_CARDS', value: 'on' },
      { kind: 'set', name: 'CCTL_RELAY_URL', value: 'wss://mine.example' },
    ]);
  });
});

describe('renderImportPlan', () => {
  it('prints every account, scope and setting with what will happen', () => {
    const p = payload({
      accounts: [
        entry('work', { accountUuid: 'u-work' }),
        { label: 'home', accountUuid: 'u-home', autoSwitchExcluded: true },
      ],
      rules: [fileRule({ folders: ['/proj', '/gone'], include: ['u-work'], exclude: ['u-home'] })],
      settings: { env: { CCTL_AUTOSWITCH: 'off' } },
    });
    const text = renderImportPlan(planImport(input({ payload: p })), p);
    expect(text).toContain('work: add, with its tokens');
    expect(text).toContain(
      'home: add, waiting for a login (no tokens in the file), excluded from auto-switch',
    );
    expect(text).toContain('folder /proj: create, include work; exclude home');
    expect(text).toContain('folder /gone: skipped - the folder does not exist on this machine');
    expect(text).toContain('CCTL_AUTOSWITCH=off');
  });

  it('says so when the file has nothing of a kind', () => {
    const p = payload({});
    expect(renderImportPlan(planImport(input({ payload: p })), p)).toBe(
      'Accounts:\n  (none in the file)\nRules:\n  (none in the file)\nSettings:\n  (none in the file)\n',
    );
  });
});
