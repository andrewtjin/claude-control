// The import planner over every collision case: a login already stored, a label taken, rule
// scopes whose folders are missing or already ruled here, members that did not travel, and
// settings that are unknown, path-valued, invalid, unchanged or new.

import { describe, it, expect } from 'vitest';
import type { AccountView, FolderRule } from '@claude-control/switch-engine';
import type { ExportPayload, ExportedAccount, ExportedRule } from './exportPayload.js';
import { planImport, renderImportPlan, type FolderLookup, type PlanInput } from './importPlan.js';

/** Account ids as the vault makes them. */
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

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

  it('matches an entry by the id it had on the other machine, whatever its label here', () => {
    // An earlier import stored it as 'anon (2)' (the label was taken), with no identity at all.
    const anon = local(ID1, 'anon (2)');
    const plan = planImport(
      input({
        payload: payload({ accounts: [{ label: 'anon', id: ID1, autoSwitchExcluded: false }] }),
        accounts: [local(ID2, 'anon', { accountUuid: 'u-local' }), anon],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'skip', existing: anon });
  });

  it('never matches by label alone: another account with the same label is added beside it', () => {
    const mine = local(ID1, 'main');
    const plan = planImport(
      input({
        payload: payload({ accounts: [entry('main', { id: ID2 })] }),
        accounts: [mine],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({
      kind: 'add',
      label: 'main (2)',
      id: ID2,
      renamedFrom: 'main',
    });
  });

  it('does not take an id for the same account when the two name different logins', () => {
    const other = local(ID1, 'other', { accountUuid: 'u-other' });
    const plan = planImport(
      input({
        payload: payload({ accounts: [entry('new', { id: ID1, accountUuid: 'u-new' })] }),
        accounts: [other],
      }),
    );
    // Added, and not under the id the other account already has.
    expect(plan.accounts[0]).toEqual({
      kind: 'add',
      entry: 0,
      label: 'new',
      withTokens: true,
      autoSwitchExcluded: false,
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

  it('numbers a label that spells an id the same import keeps, whichever entry comes first', () => {
    // One entry is labelled with the id another entry keeps: the vault would refuse whichever of
    // the two it stored second, so the plan renames the label instead.
    for (const order of [0, 1]) {
      const labelled = entry(ID2, { accountUuid: 'u-q', id: ID1 });
      const holder = entry('p', { accountUuid: 'u-p', id: ID2 });
      const accounts = order === 0 ? [labelled, holder] : [holder, labelled];
      const plan = planImport(input({ payload: payload({ accounts }) }));
      const steps = plan.accounts as Array<{ label: string; id?: string; entry: number }>;
      const byEntry = (e: ExportedAccount): { label: string; id?: string } =>
        steps.find((s) => s.entry === accounts.indexOf(e))!;
      expect(byEntry(labelled)).toMatchObject({ label: `${ID2} (2)`, id: ID1 });
      expect(byEntry(holder)).toMatchObject({ label: 'p', id: ID2 });
    }
  });

  it('does not keep an id an account here carries as its label', () => {
    const plan = planImport(
      input({
        payload: payload({ accounts: [entry('p', { accountUuid: 'u-p', id: ID1 })] }),
        accounts: [local(ID2, ID1.toUpperCase(), { accountUuid: 'u-other' })],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'add', label: 'p' });
    expect(plan.accounts[0]).not.toHaveProperty('id');
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

describe('planImport: --replace needs tokens that prove the login', () => {
  const stored = local(ID1, 'x', {
    accountUuid: 'u-x',
    emailAddress: 'u-x@x.com',
    organizationUuid: 'org-x',
  });

  /** The plan for one entry naming login u-x whose tokens carry `block`. */
  function planWith(block: Record<string, unknown>): ReturnType<typeof planImport>['accounts'][0] {
    const e = entry('x', { accountUuid: 'u-x' });
    e.bundle!.oauthAccount = block;
    return planImport(
      input({ payload: payload({ accounts: [e] }), accounts: [stored], replace: true }),
    ).accounts[0]!;
  }

  it('replaces only when the block names the stored login', () => {
    expect(planWith({ accountUuid: 'u-x' })).toMatchObject({ kind: 'replace' });
  });

  it('skips a block that is empty, names no login as text, or names only the email or a name', () => {
    for (const block of [
      {},
      { accountUuid: 42 },
      { emailAddress: 'u-x@x.com' },
      { displayName: 'Y person' },
    ]) {
      const step = planWith(block);
      expect(step).toMatchObject({ kind: 'skip' });
      expect((step as { reason: string }).reason).toContain(
        "the file's tokens do not name the login they belong to",
      );
    }
  });

  it('for a stored row with no login, needs the block to echo every anchor the row has', () => {
    const noLogin = local(ID1, 'x', { emailAddress: 'u-x@x.com', organizationUuid: 'org-x' });
    const e = (block: Record<string, unknown>): ExportedAccount => {
      const out = entry('x', { emailAddress: 'u-x@x.com' });
      out.bundle!.oauthAccount = block;
      return out;
    };
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            e({ emailAddress: 'u-x@x.com', organizationUuid: 'org-x' }),
            e({ emailAddress: 'u-x@x.com' }),
          ],
        }),
        accounts: [noLogin],
        replace: true,
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'replace' });
    expect(plan.accounts[1]).toMatchObject({ kind: 'skip' });
    expect((plan.accounts[1] as { reason: string }).reason).toContain('organizationUuid');
  });

  it('never replaces a stored row that records no identity to check against', () => {
    const bare = local(ID1, 'x');
    const e = entry('x', { id: ID1 });
    e.bundle!.oauthAccount = { accountUuid: 'u-x' };
    const step = planImport(
      input({ payload: payload({ accounts: [e] }), accounts: [bare], replace: true }),
    ).accounts[0]!;
    expect(step).toMatchObject({ kind: 'skip' });
    expect((step as { reason: string }).reason).toContain('records no login');
  });
});

describe('planImport: a rule an earlier import made part way', () => {
  /** The rule an earlier import made on /proj alone (the second folder did not exist then). */
  function partRule(extra: Partial<FolderRule> = {}): FolderRule {
    return {
      id: 'rule-part',
      label: 'Client',
      folders: ['/proj'],
      include: [ID1],
      exclude: [],
      activeId: ID1,
      createdAtMs: 1,
      updatedAtMs: 1,
      ...extra,
    };
  }
  const x = local(ID1, 'x', { accountUuid: 'u-x', ruleIds: ['rule-part'] });

  it('grows that rule with the folder it lacks instead of making a second rule', () => {
    const here = partRule();
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [fileRule({ label: 'Client', folders: ['/proj', '/other'], include: ['u-x'] })],
        }),
        accounts: [x],
        rules: [here],
      }),
    );
    expect(plan.rules[0]).toMatchObject({ into: here, include: [] });
    expect(plan.rules[0]!.skip).toBeUndefined();
    expect(plan.rules[0]!.scopes.map((s) => [s.folder, s.joins, s.skip])).toEqual([
      ['/proj', undefined, undefined],
      ['/other', true, undefined],
    ]);
    const text = renderImportPlan(plan);
    expect(text).toContain('folder /proj, folder /other: add to the rule here\n');
    expect(text).toContain('    folder /other: joins the rule here');
  });

  it('grows it with a session alias scope too', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [
            fileRule({
              folders: ['/proj'],
              aliases: [{ folder: '/proj', alias: 'deploy' }],
              include: ['u-x'],
            }),
          ],
        }),
        accounts: [x],
        rules: [partRule()],
      }),
    );
    expect(plan.rules[0]!.into?.id).toBe('rule-part');
    expect(plan.rules[0]!.scopes.map((s) => s.joins)).toEqual([undefined, true]);
  });

  it("leaves a rule of this machine's own alone: one that shares no member with the file's rule", () => {
    const own = partRule({ include: [ID2] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [fileRule({ folders: ['/proj', '/other'], include: ['u-x'] })],
        }),
        accounts: [
          local(ID1, 'x', { accountUuid: 'u-x' }),
          local(ID2, 'z', { accountUuid: 'u-z', ruleIds: ['rule-part'] }),
        ],
        rules: [own],
      }),
    );
    expect(plan.rules[0]!.into).toBeUndefined();
    expect(plan.rules[0]!.scopes.map((s) => s.skip)).toEqual([
      'this machine has another rule there; it is left as it is',
      undefined,
    ]);
  });

  // Whatever changed since the first import, a rule here that includes an account the file's rule
  // includes is that rule: a second rule including the same account would be a second slot, and
  // the account can be live in only one, so the other folders would run on some other account.
  it('grows it when it has a member the file rule no longer has (an exclusion dropped since)', () => {
    const t = local(ID2, 't', { accountUuid: 'u-t' });
    const here = partRule({ exclude: [ID2] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [fileRule({ folders: ['/proj', '/other'], include: ['u-x'] })],
        }),
        accounts: [x, t],
        rules: [here],
      }),
    );
    expect(plan.rules[0]).toMatchObject({ into: here, include: [], exclude: [] });
    expect(plan.rules[0]!.skip).toBeUndefined();
    expect(plan.rules[0]!.scopes.map((s) => s.joins)).toEqual([undefined, true]);
  });

  it('grows it when it has a member the file rule lacks, adding the ones it lacks', () => {
    const here = partRule({ include: [ID1, ID2] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [
            entry('x', { accountUuid: 'u-x', id: ID1 }),
            entry('y', { accountUuid: 'u-y' }),
          ],
          rules: [fileRule({ folders: ['/proj', '/other'], include: ['u-x', 'u-y'] })],
        }),
        accounts: [x, local(ID2, 'z', { accountUuid: 'u-z', ruleIds: ['rule-part'] })],
        rules: [here],
      }),
    );
    expect(plan.rules[0]!.into).toBe(here);
    expect(plan.rules[0]!.include).toEqual([{ entry: 1, label: 'y' }]);
  });

  it('grows it when it holds a folder the file rule no longer has, which stays its own', () => {
    const wider = partRule({ folders: ['/proj', '/proj/sub'] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [fileRule({ folders: ['/proj', '/other'], include: ['u-x'] })],
        }),
        accounts: [x],
        rules: [wider],
      }),
    );
    expect(plan.rules[0]!.into).toBe(wider);
    expect(plan.rules[0]!.scopes.map((s) => [s.folder, s.joins, s.skip])).toEqual([
      ['/proj', undefined, undefined],
      ['/other', true, undefined],
    ]);
  });

  it("grows it while a rule of this machine's own holds another of the folders", () => {
    // This machine's own rule holds /proj; the earlier import left the rest of the file's rule on
    // the session alias alone. The folder that now exists joins that rule, /proj stays the other's.
    const mine = partRule({ id: 'rule-mine', label: 'mine', include: [ID2] });
    const earlier = partRule({
      folders: [],
      aliases: [{ folder: '/proj', alias: 'deploy' }],
      label: 'work-rule',
    });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [
            fileRule({
              label: 'work-rule',
              folders: ['/proj', '/other'],
              aliases: [{ folder: '/proj', alias: 'deploy' }],
              include: ['u-x'],
            }),
          ],
        }),
        accounts: [x, local(ID2, 'other', { accountUuid: 'u-o', ruleIds: ['rule-mine'] })],
        rules: [mine, earlier],
      }),
    );
    expect(plan.rules[0]!.into).toBe(earlier);
    expect(plan.rules[0]!.scopes.map((s) => [s.sourceFolder, s.alias, s.joins, s.skip])).toEqual([
      ['/proj', undefined, undefined, 'this machine has another rule there; it is left as it is'],
      ['/other', undefined, true, undefined],
      ['/proj', 'deploy', undefined, undefined],
    ]);
    expect(renderImportPlan(plan)).toContain(': add to the rule here');
  });

  it('skips, saying so, a rule this machine already holds split in two, rather than a third', () => {
    const one = partRule({ id: 'rule-a' });
    const two = partRule({ id: 'rule-b', folders: ['/other'] });
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('x', { accountUuid: 'u-x', id: ID1 })],
          rules: [fileRule({ folders: ['/proj', '/other', '/proj/sub'], include: ['u-x'] })],
        }),
        accounts: [local(ID1, 'x', { accountUuid: 'u-x', ruleIds: ['rule-a', 'rule-b'] })],
        rules: [one, two],
      }),
    );
    expect(plan.rules[0]!.skip).toBe(
      'this machine already has it split between rules on /proj and /other; it is left as it ' +
        'is (remove all but one with cctl folder reset, then import again)',
    );
  });
});

describe('planImport: one account named twice in a rule', () => {
  it('skips a rule that includes and excludes one account under two names', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('f', { accountUuid: 'u-f' }), entry('g', { accountUuid: 'u-g' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-f', 'u-g'], exclude: ['f'] })],
        }),
      }),
    );
    expect(plan.rules[0]!.skip).toBe('it both includes and excludes f');
  });

  it('does the same when the account is already stored here', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('f', { accountUuid: 'u-f', id: ID1 })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-f'], exclude: ['f'] })],
        }),
        accounts: [local(ID1, 'f', { accountUuid: 'u-f' })],
      }),
    );
    expect(plan.rules[0]!.skip).toBe('it both includes and excludes f');
  });

  it('lists an account named twice on one side once', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('f', { accountUuid: 'u-f' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-f', 'f'] })],
        }),
      }),
    );
    expect(plan.rules[0]!.include).toEqual([{ entry: 0, label: 'f' }]);
  });
});

describe('planImport: the refusals the engine would make, foreseen', () => {
  /** A rule here on `folder` that excludes `exclude`, its slot running `activeId`. */
  function side(id: string, folder: string, exclude: string[], activeId: string): FolderRule {
    return {
      id,
      label: folder,
      folders: [folder],
      include: [],
      exclude,
      activeId,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
  }

  it("skips a rule that would leave another rule's slot with no account to move to", () => {
    // The side rule excludes 'other', so its slot can only run 'client'; the main login runs
    // 'other'. Reserving 'client' leaves the side slot nothing.
    const plan = planImport(
      input({
        payload: payload({ rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })] }),
        accounts: [
          local(ID1, 'other', { accountUuid: 'u-o' }),
          local(ID2, 'client', { accountUuid: 'u-c' }),
        ],
        rules: [side('rule-side', '/side', [ID1], ID2)],
        globalLive: ID1,
      }),
    );
    expect(plan.rules[0]!.skip).toBe(
      'including client would leave the slot of /side with no other account to run on',
    );
  });

  it('skips a rule when the main login and a rule slot both need the one spare account', () => {
    const ID3 = '33333333-3333-4333-8333-333333333333';
    const plan = planImport(
      input({
        payload: payload({
          rules: [fileRule({ folders: ['/proj'], include: ['u-c', 'u-w'] })],
        }),
        accounts: [
          local(ID1, 'client', { accountUuid: 'u-c' }),
          local(ID2, 'work', { accountUuid: 'u-w' }),
          local(ID3, 'spare', { accountUuid: 'u-s' }),
        ],
        rules: [side('rule-side', '/side', [ID1], ID2)],
        globalLive: ID1,
      }),
    );
    expect(plan.rules[0]!.skip).toMatch(/^including (client|work) would leave /);
  });

  it('notes both moves when each slot has an account of its own to go to', () => {
    const ID3 = '33333333-3333-4333-8333-333333333333';
    const ID4 = '44444444-4444-4444-8444-444444444444';
    const plan = planImport(
      input({
        payload: payload({
          rules: [fileRule({ folders: ['/proj'], include: ['u-c', 'u-w'] })],
        }),
        accounts: [
          local(ID1, 'client', { accountUuid: 'u-c' }),
          local(ID2, 'work', { accountUuid: 'u-w' }),
          local(ID3, 'spare', { accountUuid: 'u-s' }),
          local(ID4, 'spare2', { accountUuid: 'u-s2' }),
        ],
        rules: [side('rule-side', '/side', [ID1], ID2)],
        globalLive: ID1,
      }),
    );
    expect(plan.rules[0]!.skip).toBeUndefined();
    expect(plan.rules[0]!.notes).toEqual([
      "this machine's main login moves off client, which this rule reserves",
      'the slot of /side moves off work, which this rule reserves',
    ]);
  });

  it('never counts an account the file reserves to a rule as a slot replacement', () => {
    // client's rule is not made here (its folder is missing), so client arrives held back; the
    // other rule reserves 'only', live on the main login, and nothing else is left for it.
    const file = payload({
      accounts: [entry('client', { accountUuid: 'u-c' })],
      rules: [
        fileRule({ folders: ['/missing'], include: ['u-c'] }),
        fileRule({ folders: ['/proj'], include: ['u-o'] }),
      ],
    });
    const plan = planImport(
      input({
        payload: file,
        accounts: [local(ID1, 'only', { accountUuid: 'u-o' })],
        globalLive: ID1,
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'add', heldBack: true, forRule: true });
    expect(plan.rules[1]!.skip).toBe(
      "including only would leave this machine's main login with no shared account to run on; " +
        'add or log in another account here first',
    );
  });

  it('counts an account the import adds as live where its login already runs unstored', () => {
    // This machine's main login is the file's 'client', logged in before cctl stored it: once the
    // import stores it, it is the main login's account, and reserving it moves the main login.
    const file = payload({
      accounts: [entry('client', { accountUuid: 'u-c' })],
      rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
    });
    const unstoredLogins = new Map([['global' as const, 'u-c']]);
    const alone = planImport(input({ payload: file, globalLive: null, unstoredLogins }));
    expect(alone.rules[0]!.skip).toBe(
      "including client would leave this machine's main login with no shared account to run " +
        'on; add or log in another account here first',
    );
    const withSpare = planImport(
      input({
        payload: file,
        accounts: [local(ID1, 'spare', { accountUuid: 'u-s' })],
        globalLive: null,
        unstoredLogins,
      }),
    );
    expect(withSpare.rules[0]!.skip).toBeUndefined();
    expect(withSpare.rules[0]!.notes).toEqual([
      "this machine's main login moves off client, which this rule reserves",
    ]);
    // The same goes for an account the file brings without tokens: it is recognized there too.
    const pending = planImport(
      input({
        payload: payload({
          accounts: [{ label: 'client', accountUuid: 'u-c', autoSwitchExcluded: false }],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
        accounts: [local(ID1, 'spare', { accountUuid: 'u-s' })],
        globalLive: null,
        unstoredLogins,
      }),
    );
    expect(pending.rules[0]!.notes).toEqual([
      "this machine's main login moves off client, which this rule reserves",
    ]);
  });

  it('counts an account the import adds, with tokens, as one a slot can move to', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('fresh', { accountUuid: 'u-f' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
        accounts: [local(ID1, 'client', { accountUuid: 'u-c' })],
        globalLive: ID1,
      }),
    );
    expect(plan.rules[0]!.skip).toBeUndefined();
  });

  it('skips adding accounts past what one rule may include', () => {
    const many = Array.from({ length: 31 }, (_, i) =>
      local(`id-${i}`, `n${i}`, { accountUuid: `u-${i}`, ruleIds: ['rule-big'] }),
    );
    const big: FolderRule = {
      id: 'rule-big',
      label: 'big',
      folders: ['/proj'],
      include: many.map((a) => a.id),
      exclude: [],
      activeId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const plan = planImport(
      input({
        payload: payload({
          accounts: ['a', 'b', 'c'].map((l) => entry(l, { accountUuid: `u-${l}` })),
          rules: [fileRule({ folders: ['/proj'], include: ['u-a', 'u-b', 'u-c'] })],
        }),
        accounts: many,
        rules: [big],
      }),
    );
    expect(plan.rules[0]!.skip).toBe('the rule would include more than 32 accounts');
  });

  it('skips a rule that would reserve more accounts than a machine may', () => {
    const reserved = Array.from({ length: 256 }, (_, i) =>
      local(`id-${i}`, `n${i}`, { ruleIds: ['elsewhere'] }),
    );
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('a', { accountUuid: 'u-a' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-a'] })],
        }),
        accounts: reserved,
      }),
    );
    expect(plan.rules[0]!.skip).toBe(
      'this machine would have more than 256 accounts reserved to rules',
    );
  });
});

describe('planImport: settings that guard something', () => {
  it('never takes a value from a file that weakens a guard, with or without --replace', () => {
    for (const replace of [false, true]) {
      const plan = planImport(
        input({
          payload: payload({
            settings: {
              env: {
                CCTL_BIND_ENFORCE: 'off',
                'identity-check': '0',
                CCTL_TOOL_OUTPUT_FULL: 'on',
              },
            },
          }),
          replace,
        }),
      );
      expect(plan.settings.map((s) => [s.kind, s.name])).toEqual([
        ['skip', 'CCTL_BIND_ENFORCE'],
        ['skip', 'CCTL_IDENTITY_CHECK'],
        ['skip', 'CCTL_TOOL_OUTPUT_FULL'],
      ]);
      expect((plan.settings[0] as { reason: string }).reason).toContain(
        'cctl settings set bind-enforce off',
      );
      expect((plan.settings[1] as { reason: string }).reason).toContain(
        'cctl settings set identity-check 0',
      );
    }
  });

  it('weighs a guard against the value in force here, not the default', () => {
    const plan = (env: Record<string, string>, here: Record<string, string>, replace = false) =>
      planImport(input({ payload: payload({ settings: { env } }), config: { env: here }, replace }))
        .settings[0];
    // 'warn' guards more than the 'off' this machine has: an ordinary difference.
    expect(plan({ CCTL_BIND_ENFORCE: 'warn' }, { CCTL_BIND_ENFORCE: 'off' })).toMatchObject({
      kind: 'kept',
    });
    expect(plan({ CCTL_BIND_ENFORCE: 'warn' }, { CCTL_BIND_ENFORCE: 'off' }, true)).toMatchObject({
      kind: 'set',
      value: 'warn',
    });
    // 'off' guards less than the 'warn' this machine has.
    expect(plan({ CCTL_BIND_ENFORCE: 'off' }, { CCTL_BIND_ENFORCE: 'warn' }, true)).toMatchObject({
      kind: 'skip',
    });
    // A value that guards as much as the default is taken.
    expect(plan({ CCTL_BIND_ENFORCE: 'block' }, {})).toMatchObject({ kind: 'set' });
    expect(plan({ CCTL_IDENTITY_CHECK: 'on' }, {})).toMatchObject({ kind: 'set' });
  });
});

describe('planImport: settings the environment here overrides', () => {
  it('says so for a value already set here, not only for one it saves', () => {
    const plan = planImport(
      input({
        payload: payload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
        config: { env: { CCTL_AUTOSWITCH: 'off' } },
        env: { CCTL_AUTOSWITCH: '1' },
      }),
    );
    expect(plan.settings).toEqual([
      { kind: 'same', name: 'CCTL_AUTOSWITCH', value: 'off', overridden: true },
    ]);
    expect(renderImportPlan(plan)).toContain(
      'CCTL_AUTOSWITCH=off: already set (the environment here sets it, and wins)',
    );
  });

  it('reads a blank environment value as unset, as the daemon does', () => {
    const plan = planImport(
      input({
        payload: payload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
        env: { CCTL_AUTOSWITCH: '   ' },
      }),
    );
    expect(plan.settings).toEqual([{ kind: 'set', name: 'CCTL_AUTOSWITCH', value: 'off' }]);
  });
});

describe('planImport: accounts a rule of the file reserves', () => {
  it('stores one whose rule the plan makes held back until that rule takes it', () => {
    const plan = planImport(
      input({
        payload: payload({
          accounts: [entry('client', { accountUuid: 'u-c' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ autoSwitchExcluded: false, awaitsRule: true });
  });

  it('quotes the command that hands a held-back account back, for the shell it runs in', () => {
    const at = (platform: NodeJS.Platform): string =>
      renderImportPlan(
        planImport(
          input({
            platform,
            payload: payload({
              accounts: [entry("bob's work", { accountUuid: 'u-b' })],
              rules: [fileRule({ folders: ['/gone'], include: ['u-b'] })],
            }),
            accounts: [local(ID1, "bob's work", { accountUuid: 'u-other' })],
          }),
        ),
      );
    expect(at('linux')).toContain(
      "cctl accounts include 'bob'\\''s work (2)' lets auto-switch use it",
    );
    expect(at('win32')).toContain(
      "cctl accounts include 'bob''s work (2)' lets auto-switch use it",
    );
  });
});
