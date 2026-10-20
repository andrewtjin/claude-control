// The import planner over every collision case: a login already stored, a label taken, rule
// scopes whose folders are missing here, members that did not travel, and settings that are
// unknown, path-valued, invalid, unchanged or new. What a rule does here is the engine's decision:
// these tests check what the planner asks the engine (a stand-in for it) and how it shows the
// verdicts; the engine's own tests and the integration tests check the decision itself.

import { describe, it, expect } from 'vitest';
import {
  ruleSlotId,
  type AccountView,
  type FolderRule,
  type ImportRuleSpec,
  type PlanImportRulesOptions,
  type RuleScopeRef,
} from '@claude-control/switch-engine';
import type { ExportPayload, ExportedAccount, ExportedRule } from './exportPayload.js';
import {
  planImport,
  renderImportPlan,
  type AccountStep,
  type FolderLookup,
  type PlanInput,
  type PlanRules,
  type SettingStep,
} from './importPlan.js';

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

/** A rule's identity across machines. */
const ORIGIN = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

/** The id the plan gives the account of file entry `i` until the import stores it. */
const PENDING = (i: number): string => `entry\u0000${i}`;

/** What the planner asked the engine. */
interface Asked {
  specs: ImportRuleSpec[];
  opts: PlanImportRulesOptions;
}

/** A stand-in for the engine's decision that creates every rule as asked, recording what it was
 *  asked in `asked`. */
function engineCreating(asked?: Asked[]): PlanRules {
  return (specs, opts) => {
    asked?.push({ specs, opts });
    return Promise.resolve({
      rules: specs.map((s) => ({
        kind: 'create' as const,
        scopes: s.scopes,
        include: s.include,
        exclude: s.exclude,
        leftOut: [],
      })),
      handOffs: [],
      seats: [],
    });
  };
}

/** A rule here, on /other. */
const HERE_RULE: FolderRule = {
  id: 'rule-here',
  label: 'mine',
  folders: ['/other'],
  include: [],
  exclude: ['x'],
  activeId: null,
  createdAtMs: 1,
  updatedAtMs: 1,
};

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
    planRules: engineCreating(),
    ...extra,
  };
}

describe('planImport: accounts', () => {
  it('adds new accounts, with or without tokens', async () => {
    const plan = await planImport(
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

  it('skips a login already stored, whatever its label here', async () => {
    const existing = local('id1', 'Job', { accountUuid: 'u1' });
    const plan = await planImport(
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

  it('matches a login by the uuid its tokens name when the entry records none', async () => {
    const existing = local('id1', 'work', { accountUuid: 'u1' });
    const e = entry('work');
    e.bundle!.oauthAccount = { accountUuid: 'u1' };
    const plan = await planImport(
      input({ payload: payload({ accounts: [e] }), accounts: [existing] }),
    );
    expect(plan.accounts[0]!.kind).toBe('skip');
  });

  it('with --replace, plans a replace only for tokens that name their login', async () => {
    const existing = local('id1', 'work', { accountUuid: 'u1' });
    const named = entry('work', { accountUuid: 'u1' });
    named.bundle!.oauthAccount = { accountUuid: 'u1' };
    const plan = await planImport(
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

  it('matches an entry by the id it had on the other machine, whatever its label here', async () => {
    // An earlier import stored it as 'anon (2)' (the label was taken), with no identity at all.
    const anon = local(ID1, 'anon (2)');
    const plan = await planImport(
      input({
        payload: payload({ accounts: [{ label: 'anon', id: ID1, autoSwitchExcluded: false }] }),
        accounts: [local(ID2, 'anon', { accountUuid: 'u-local' }), anon],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'skip', existing: anon });
  });

  it('never matches by label alone: another account with the same label is added beside it', async () => {
    const mine = local(ID1, 'main');
    const plan = await planImport(
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

  it('does not take an id for the same account when the two name different logins', async () => {
    const other = local(ID1, 'other', { accountUuid: 'u-other' });
    const plan = await planImport(
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

  it('numbers a label taken here by another login, in any case, and past taken numbers', async () => {
    const plan = await planImport(
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

  it('numbers a label that spells an account id here, and two entries with one label', async () => {
    const plan = await planImport(
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

  it('numbers a label that spells an id the same import keeps, whichever entry comes first', async () => {
    // One entry is labelled with the id another entry keeps: the vault would refuse whichever of
    // the two it stored second, so the plan renames the label instead.
    for (const order of [0, 1]) {
      const labelled = entry(ID2, { accountUuid: 'u-q', id: ID1 });
      const holder = entry('p', { accountUuid: 'u-p', id: ID2 });
      const accounts = order === 0 ? [labelled, holder] : [holder, labelled];
      const plan = await planImport(input({ payload: payload({ accounts }) }));
      const steps = plan.accounts as Array<{ label: string; id?: string; entry: number }>;
      const byEntry = (e: ExportedAccount): { label: string; id?: string } =>
        steps.find((s) => s.entry === accounts.indexOf(e))!;
      expect(byEntry(labelled)).toMatchObject({ label: `${ID2} (2)`, id: ID1 });
      expect(byEntry(holder)).toMatchObject({ label: 'p', id: ID2 });
    }
  });

  it('does not keep an id an account here carries as its label', async () => {
    const plan = await planImport(
      input({
        payload: payload({ accounts: [entry('p', { accountUuid: 'u-p', id: ID1 })] }),
        accounts: [local(ID2, ID1.toUpperCase(), { accountUuid: 'u-other' })],
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ kind: 'add', label: 'p' });
    expect(plan.accounts[0]).not.toHaveProperty('id');
  });

  it('matches an entry with no login by email only against a row with no login either', async () => {
    const noLogin = local('id1', 'mail', { emailAddress: 'M@x.com' });
    const withLogin = local('id2', 'mail2', { emailAddress: 'n@x.com', accountUuid: 'u9' });
    const plan = await planImport(
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

  it('stores a label with terminal controls stripped, the way the vault will', async () => {
    const plan = await planImport(
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

  it('plans a rule whole, every scope in one rule, with its members resolved by login then label', async () => {
    const plan = await planImport(
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

  it('does not carry a default rule name as a chosen one', async () => {
    const plan = await planImport(
      input({
        payload: payload({
          accounts,
          rules: [fileRule({ label: '/proj', folders: ['/proj'], include: ['u-work'] })],
        }),
      }),
    );
    expect(plan.rules[0]!.label).toBeUndefined();
  });

  it('resolves a member to an account already stored here, and the label it has here', async () => {
    const plan = await planImport(
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

  it('shows a member by the label it gets here', async () => {
    const plan = await planImport(
      input({
        payload: payload({
          accounts: [entry('work', { accountUuid: 'u-work' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-work'] })],
        }),
        accounts: [local('id1', 'work', { accountUuid: 'u-other' })],
      }),
    );
    expect(plan.rules[0]!.include).toEqual([{ entry: 0, label: 'work (2)' }]);
    expect(renderImportPlan(plan)).toContain('folder /proj: create, include work (2)');
  });

  it('sends the engine the scopes it can use here, and notes the ones it cannot', async () => {
    const asked: Asked[] = [];
    const plan = await planImport(
      input({
        payload: payload({
          accounts,
          rules: [
            fileRule({
              label: '/proj',
              folders: ['/proj', '/gone', '/other', '/vault', '/proj'],
              include: ['u-work'],
              origin: ORIGIN,
            }),
          ],
        }),
        checkScope: (s) =>
          s.folder === '/vault' ? 'overlaps the cctl vault directory' : undefined,
        resolveFolder: (f) =>
          HERE.has(f) || f === '/vault'
            ? { ok: true, folder: f }
            : { ok: false, reason: 'the folder does not exist on this machine' },
        planRules: engineCreating(asked),
      }),
    );
    expect(plan.rules[0]!.scopes.map((s) => s.skip)).toEqual([
      undefined,
      'the folder does not exist on this machine',
      undefined,
      'overlaps the cctl vault directory',
      'the rule lists it twice',
    ]);
    expect(asked[0]!.specs).toEqual([
      {
        scopes: [
          { kind: 'folder', folder: '/proj' },
          { kind: 'folder', folder: '/other' },
        ],
        // Nothing is made on these, but a rule here holding one keeps the rule from landing.
        absent: [
          { kind: 'folder', folder: '/gone' },
          { kind: 'folder', folder: '/vault' },
        ],
        include: [PENDING(0)],
        exclude: [],
        origin: ORIGIN,
      },
    ]);
    const text = renderImportPlan(plan);
    expect(text).toContain('  folder /proj, folder /other: create, include work\n');
    expect(text).toContain(
      '    folder /gone: left out - the folder does not exist on this machine\n',
    );
  });

  it('skips, without asking the engine, a rule it cannot send, and says why', async () => {
    const asked: Asked[] = [];
    const plan = await planImport(
      input({
        payload: payload({
          accounts: [entry('w', { accountUuid: 'u-w' })],
          rules: [
            fileRule({ folders: ['/gone'], include: ['u-w'] }),
            fileRule({ folders: ['/proj/sub'], include: ['u-nobody'] }),
            fileRule({ folders: ['/proj/sub'], include: ['u-nobody'], exclude: ['u-w'] }),
          ],
        }),
        planRules: engineCreating(asked),
      }),
    );
    expect(plan.rules.map((r) => r.skip)).toEqual([
      'the folder does not exist on this machine',
      'none of its accounts came along',
      'none of the accounts it includes is in the file or on this machine',
    ]);
    expect(plan.rules[1]!.dropped).toEqual(['u-nobody']);
    expect(asked).toEqual([]);
  });

  it('names the accounts it adds by ids no account here has, and tells the engine about them', async () => {
    const asked: Asked[] = [];
    await planImport(
      input({
        payload: payload({
          accounts: [
            entry('client', { accountUuid: 'u-c' }),
            { label: 'spare', accountUuid: 'u-s', autoSwitchExcluded: true },
            entry('mine', { accountUuid: 'u-m' }),
          ],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c', 'u-m'], exclude: ['u-s'] })],
        }),
        accounts: [local(ID1, 'mine', { accountUuid: 'u-m' })],
        planRules: engineCreating(asked),
      }),
    );
    expect(asked[0]!.specs[0]).toMatchObject({ include: [PENDING(0), ID1], exclude: [PENDING(1)] });
    expect(asked[0]!.opts).toEqual({
      // client is reserved to a rule on the machine it came from: kept out of every other slot.
      keepOut: [PENDING(0)],
      pending: [
        {
          id: PENDING(0),
          label: 'client',
          accountUuid: 'u-c',
          withTokens: true,
          autoSwitchExcluded: true,
        },
        {
          id: PENDING(1),
          label: 'spare',
          accountUuid: 'u-s',
          withTokens: false,
          autoSwitchExcluded: true,
        },
      ],
      logins: [],
      revived: [],
    });
  });

  it('tells the engine the login --replace gives a stored row that records none', async () => {
    const asked: Asked[] = [];
    const e = entry('c', { id: ID1, emailAddress: 'c@x.com', accountUuid: 'u-c' });
    e.bundle!.oauthAccount = { accountUuid: 'u-c', emailAddress: 'c@x.com' };
    await planImport(
      input({
        payload: payload({
          accounts: [e],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
        accounts: [local(ID1, 'c', { emailAddress: 'c@x.com' })],
        replace: true,
        planRules: engineCreating(asked),
      }),
    );
    expect(asked[0]!.opts.logins).toEqual([{ id: ID1, accountUuid: 'u-c' }]);
  });

  it('counts only the login the tokens name, not one the entry states beside them', async () => {
    const asked: Asked[] = [];
    const e = entry('c', { id: ID1, emailAddress: 'c@x.com', accountUuid: 'u-c' });
    e.bundle!.oauthAccount = { emailAddress: 'c@x.com' };
    await planImport(
      input({
        payload: payload({
          accounts: [e],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
        accounts: [local(ID1, 'c', { emailAddress: 'c@x.com' })],
        replace: true,
        planRules: engineCreating(asked),
      }),
    );
    expect(asked[0]!.opts.logins).toEqual([]);
  });

  it("shows the engine's verdicts: a grown rule, an unchanged one, and what it leaves out", async () => {
    const plan = await planImport(
      input({
        payload: payload({
          accounts: [],
          rules: [
            fileRule({ folders: ['/proj'], include: ['u-w'], exclude: ['u-h', 'u-r'] }),
            fileRule({ folders: ['/other'], include: ['u-w'] }),
          ],
        }),
        accounts: [
          local('id-w', 'work', { accountUuid: 'u-w' }),
          local('id-h', 'home', { accountUuid: 'u-h' }),
          local('id-r', 'r', { accountUuid: 'u-r', ruleIds: ['elsewhere'] }),
        ],
        rules: [HERE_RULE],
        planRules: () =>
          Promise.resolve({
            rules: [
              {
                kind: 'grow',
                rule: HERE_RULE,
                scopes: [{ kind: 'folder', folder: '/proj/sub' }],
                include: [],
                exclude: ['id-h'],
                leftOut: [{ id: 'id-r', why: 'reserved-here' }],
              },
              {
                kind: 'unchanged',
                reason: 'this machine already has this rule, with these accounts',
                rule: HERE_RULE,
                leftOut: [],
              },
            ],
            handOffs: [],
            seats: [],
          }),
      }),
    );
    const text = renderImportPlan(plan);
    expect(text).toContain(
      '  folder /proj: add to the rule here, exclude home (left out: r (another rule here reserves it))\n' +
        '    folder /proj/sub: joins the rule here\n',
    );
    expect(text).toContain(
      '  folder /other: skipped - this machine already has this rule, with these accounts\n',
    );
  });

  it('shows a rule the engine refuses as not imported, and how to merge it by hand', async () => {
    // The rule here holds the folder and a session alias in it; removing it takes both resets.
    const held: RuleScopeRef[] = [
      { kind: 'folder', folder: '/proj' },
      { kind: 'alias', folder: '/proj', alias: 'a b' },
    ];
    const refused =
      (scope: RuleScopeRef): PlanRules =>
      () =>
        Promise.resolve({
          rules: [
            {
              kind: 'refused',
              message: 'it is held here',
              conflict: { scope, rule: { id: 'rule-here', label: 'mine', scopes: held } },
            },
          ],
          handOffs: [],
          seats: [],
        });
    const rules = [
      fileRule({
        folders: ['/proj'],
        aliases: [{ folder: '/proj', alias: 'a b' }],
        include: ['u-work'],
      }),
    ];
    const byFolder = renderImportPlan(
      await planImport(
        input({
          payload: payload({ accounts, rules }),
          planRules: refused({ kind: 'folder', folder: '/proj' }),
        }),
      ),
    );
    expect(byFolder).toContain(
      '  folder /proj, session "a b" in /proj: not imported - it is held here; to bring them ' +
        "together, remove the rule here (cctl folder reset '/proj'; cctl session reset 'a b' " +
        "--cwd '/proj') and import again\n",
    );
    const byAlias = renderImportPlan(
      await planImport(
        input({
          payload: payload({ accounts, rules }),
          planRules: refused({ kind: 'alias', folder: '/proj', alias: 'a b' }),
        }),
      ),
    );
    expect(byAlias).toContain("cctl session reset 'a b' --cwd '/proj'");
    // Giving the rule here the file's accounts by hand would never let the import land it.
    expect(byAlias).not.toContain('cctl session include');
  });

  it('shows every slot the engine says the rules move, by the names here', async () => {
    const plan = await planImport(
      input({
        payload: payload({
          accounts: [entry('client', { accountUuid: 'u-c' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
        accounts: [local('id-o', 'other', { accountUuid: 'u-o' })],
        rules: [HERE_RULE],
        planRules: (specs) =>
          Promise.resolve({
            rules: specs.map((s) => ({
              kind: 'create' as const,
              scopes: s.scopes,
              include: s.include,
              exclude: s.exclude,
              leftOut: [],
            })),
            handOffs: [
              { slot: 'global', from: 'id-o', to: PENDING(0) },
              { slot: ruleSlotId(HERE_RULE.id), from: PENDING(0), to: 'id-o' },
            ],
            seats: [],
          }),
      }),
    );
    const text = renderImportPlan(plan);
    expect(text).toContain('  the global slot moves off other onto client\n');
    expect(text).toContain('  the folder slot of /other moves off client onto other\n');
  });

  it('keeps out of auto-switch an added account whose only rule is not made here', async () => {
    const refusing: PlanRules = () =>
      Promise.resolve({ rules: [{ kind: 'refused', message: 'no' }], handOffs: [], seats: [] });
    for (const { folder, planRules, made } of [
      { folder: '/gone', planRules: engineCreating(), made: false },
      { folder: '/proj', planRules: refusing, made: false },
      { folder: '/proj', planRules: engineCreating(), made: true },
    ]) {
      const plan = await planImport(
        input({
          payload: payload({
            accounts: [
              entry('client', { accountUuid: 'u-c' }),
              entry('work', { accountUuid: 'u-w' }),
            ],
            rules: [fileRule({ folders: [folder], include: ['u-c'] })],
          }),
          planRules,
        }),
      );
      expect(plan.accounts[0]).toMatchObject(
        made
          ? { autoSwitchExcluded: false, awaitsRule: true, forRule: true }
          : { autoSwitchExcluded: true, heldBack: true, forRule: true },
      );
      expect(plan.accounts[1]).toMatchObject({ autoSwitchExcluded: false });
    }
  });

  it('touches no folder for a rule it skips anyway: on macOS, and while an older daemon runs', async () => {
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
    const mac = await planImport(
      input({ payload: payload({ accounts, rules }), platform: 'darwin', resolveFolder }),
    );
    expect(mac.rules[0]!.skip).toBe('folder rules are not supported on macOS yet');
    const blocked = await planImport(
      input({
        payload: payload({ accounts, rules }),
        rulesBlocked: { alias: 'old daemon (alias)' },
        resolveFolder,
      }),
    );
    expect(blocked.rules[0]!.skip).toBe('old daemon (alias)');
    expect(looked).toEqual([]);
  });

  it('notes a file from another platform when it carries rules', async () => {
    const plan = await planImport(
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
  it('sets new values, leaves equal ones, and skips unknown, path-valued, invalid ones and the relay', async () => {
    const plan = await planImport(
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

  it('keeps a value this machine has unless --replace, and says when the environment overrides', async () => {
    const base = {
      payload: payload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
      config: { env: { CCTL_AUTOSWITCH: 'on' } },
    };
    expect((await planImport(input(base))).settings).toEqual([
      { kind: 'kept', name: 'CCTL_AUTOSWITCH', value: 'off', here: 'on' },
    ]);
    expect(
      (await planImport(input({ ...base, replace: true, env: { CCTL_AUTOSWITCH: '1' } }))).settings,
    ).toEqual([
      { kind: 'set', name: 'CCTL_AUTOSWITCH', value: 'off', previous: 'on', overridden: true },
    ]);
  });
});

describe('renderImportPlan', () => {
  it('prints every account, rule and setting with what will happen', async () => {
    const p = payload({
      platform: `linux`,
      accounts: [
        entry('work', { accountUuid: 'u-work' }),
        { label: 'home', accountUuid: 'u-home', autoSwitchExcluded: true },
      ],
      rules: [fileRule({ folders: ['/proj', '/gone'], include: ['u-work'], exclude: ['u-home'] })],
      settings: { env: { CCTL_AUTOSWITCH: 'off' } },
    });
    const text = renderImportPlan(await planImport(input({ payload: p })));
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

  it('says so when the file has nothing of a kind', async () => {
    expect(renderImportPlan(await planImport(input({ payload: payload({}) })))).toBe(
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
  async function planWith(block: Record<string, unknown>): Promise<AccountStep> {
    const e = entry('x', { accountUuid: 'u-x' });
    e.bundle!.oauthAccount = block;
    return (
      await planImport(
        input({ payload: payload({ accounts: [e] }), accounts: [stored], replace: true }),
      )
    ).accounts[0]!;
  }

  it('replaces only when the block names the stored login', async () => {
    expect(await planWith({ accountUuid: 'u-x' })).toMatchObject({ kind: 'replace' });
  });

  it('skips a block that is empty, names no login as text, or names only the email or a name', async () => {
    for (const block of [
      {},
      { accountUuid: 42 },
      { emailAddress: 'u-x@x.com' },
      { displayName: 'Y person' },
    ]) {
      const step = await planWith(block);
      expect(step).toMatchObject({ kind: 'skip' });
      expect((step as { reason: string }).reason).toContain(
        "the file's tokens do not name the login they belong to",
      );
    }
  });

  it('for a stored row with no login, needs the block to echo every anchor the row has', async () => {
    const noLogin = local(ID1, 'x', { emailAddress: 'u-x@x.com', organizationUuid: 'org-x' });
    const e = (block: Record<string, unknown>): ExportedAccount => {
      const out = entry('x', { emailAddress: 'u-x@x.com' });
      out.bundle!.oauthAccount = block;
      return out;
    };
    const plan = await planImport(
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

  it('never replaces a stored row that records no identity to check against', async () => {
    const bare = local(ID1, 'x');
    const e = entry('x', { id: ID1 });
    e.bundle!.oauthAccount = { accountUuid: 'u-x' };
    const step = (
      await planImport(
        input({ payload: payload({ accounts: [e] }), accounts: [bare], replace: true }),
      )
    ).accounts[0]!;
    expect(step).toMatchObject({ kind: 'skip' });
    expect((step as { reason: string }).reason).toContain('records no login');
  });
});

describe('planImport: one account named twice in a rule', () => {
  it('skips a rule that includes and excludes one account under two names', async () => {
    const plan = await planImport(
      input({
        payload: payload({
          accounts: [entry('f', { accountUuid: 'u-f' }), entry('g', { accountUuid: 'u-g' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-f', 'u-g'], exclude: ['f'] })],
        }),
      }),
    );
    expect(plan.rules[0]!.skip).toBe('it both includes and excludes f');
  });

  it('does the same when the account is already stored here', async () => {
    const plan = await planImport(
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

  it('lists an account named twice on one side once', async () => {
    const plan = await planImport(
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

describe('planImport: settings that guard something', () => {
  it('never takes a value from a file that weakens a guard, with or without --replace', async () => {
    for (const replace of [false, true]) {
      const plan = await planImport(
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

  it('weighs a guard against the value in force here, not the default', async () => {
    const plan = async (
      env: Record<string, string>,
      here: Record<string, string>,
      replace = false,
    ): Promise<SettingStep | undefined> =>
      (
        await planImport(
          input({ payload: payload({ settings: { env } }), config: { env: here }, replace }),
        )
      ).settings[0];
    // 'warn' guards more than the 'off' this machine has: an ordinary difference.
    expect(await plan({ CCTL_BIND_ENFORCE: 'warn' }, { CCTL_BIND_ENFORCE: 'off' })).toMatchObject({
      kind: 'kept',
    });
    expect(
      await plan({ CCTL_BIND_ENFORCE: 'warn' }, { CCTL_BIND_ENFORCE: 'off' }, true),
    ).toMatchObject({
      kind: 'set',
      value: 'warn',
    });
    // 'off' guards less than the 'warn' this machine has.
    expect(
      await plan({ CCTL_BIND_ENFORCE: 'off' }, { CCTL_BIND_ENFORCE: 'warn' }, true),
    ).toMatchObject({
      kind: 'skip',
    });
    // A value that guards as much as the default is taken.
    expect(await plan({ CCTL_BIND_ENFORCE: 'block' }, {})).toMatchObject({ kind: 'set' });
    expect(await plan({ CCTL_IDENTITY_CHECK: 'on' }, {})).toMatchObject({ kind: 'set' });
  });
});

describe('planImport: settings the environment here overrides', () => {
  it('says so for a value already set here, not only for one it saves', async () => {
    const plan = await planImport(
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

  it('reads a blank environment value as unset, as the daemon does', async () => {
    const plan = await planImport(
      input({
        payload: payload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
        env: { CCTL_AUTOSWITCH: '   ' },
      }),
    );
    expect(plan.settings).toEqual([{ kind: 'set', name: 'CCTL_AUTOSWITCH', value: 'off' }]);
  });
});

describe('planImport: accounts a rule of the file reserves', () => {
  it('stores one whose rule the engine makes held back until that rule takes it', async () => {
    const plan = await planImport(
      input({
        payload: payload({
          accounts: [entry('client', { accountUuid: 'u-c' })],
          rules: [fileRule({ folders: ['/proj'], include: ['u-c'] })],
        }),
      }),
    );
    expect(plan.accounts[0]).toMatchObject({ autoSwitchExcluded: false, awaitsRule: true });
  });

  it('quotes the command that hands a held-back account back, for the shell it runs in', async () => {
    const at = async (platform: NodeJS.Platform): Promise<string> =>
      renderImportPlan(
        await planImport(
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
    expect(await at('linux')).toContain(
      "cctl accounts include 'bob'\\''s work (2)' lets auto-switch use it",
    );
    expect(await at('win32')).toContain(
      "cctl accounts include 'bob''s work (2)' lets auto-switch use it",
    );
  });
});
