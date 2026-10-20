// The import decision judged against what the batch itself writes: the slots it moves, the slots it
// leaves empty, the caps it counts, the account a slot ends up on, and what happens when a slot
// cannot take the account it was handed. Each case is decided by planImportRules (the dry run) and
// carried out by importRules (the real run), which must agree.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { sandboxPaths, type Paths } from './paths.js';
import { LockTimeoutError, RefreshError } from './errors.js';
import { ruleSlotId } from './types.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  ImportRuleSpec,
  ImportRuleVerdict,
  RuleScopeRef,
} from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
const ORIGIN = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  alive: Set<number>;
  /** Replace how a token refresh behaves (it succeeds, with a marked token, by default). */
  onRefresh: (fn: (cur: ClaudeOauth) => Promise<ClaudeOauth>) => void;
  /** Move the clock on. */
  advance: (ms: number) => void;
  clock: () => number;
}

/** A sandboxed engine over a fresh vault, whose running sessions and token refreshes a test sets. */
async function harness(opts: { clock?: () => number; root?: string } = {}): Promise<Harness> {
  const root = opts.root ?? realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-decide-')));
  if (opts.root === undefined) dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  let offset = 0;
  const clock = opts.clock ?? ((): number => NOW + offset);
  const alive = new Set<number>();
  let refresh = (cur: ClaudeOauth): Promise<ClaudeOauth> =>
    Promise.resolve({ ...cur, accessToken: 'NETWORK-' + cur.accessToken, expiresAt: NOW + HOUR });
  const engine = new SwitchEngine({
    paths,
    protector,
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) => refresh(cur),
    clock,
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
    isProcessAlive: (pid) => alive.has(pid),
  });
  return {
    root,
    paths,
    engine,
    vault: new Vault(paths.vaultDir, protector, clock),
    alive,
    onRefresh: (fn) => {
      refresh = fn;
    },
    advance: (ms) => {
      offset += ms;
    },
    clock,
  };
}

function bundle(access: string, uuid: string, expiresAt = NOW + HOUR): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt },
    oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.com` },
  };
}

/** A real folder beside the sandbox's vault, for a rule. */
async function ruleFolder(h: Harness, name: string): Promise<string> {
  const dir = join(h.root, 'work', name);
  await mkdir(dir, { recursive: true });
  return realpathSync.native(dir);
}

/** A Claude Code session running in `cwd`, as the engine's session scan finds one. */
async function runSession(h: Harness, cwd: string, pid: number): Promise<void> {
  const sessionsDir = join(h.paths.claudeDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `s${pid}.json`), JSON.stringify({ pid, cwd }));
  h.alive.add(pid);
}

const folder = (f: string): RuleScopeRef => ({ kind: 'folder', folder: f });

/** The refusal of a verdict, or a note that it was not one. */
function refusalOf(verdict: ImportRuleVerdict | undefined): string {
  return verdict?.kind === 'refused' ? verdict.message : `not refused (${verdict?.kind})`;
}

/** Add accounts by label, each with its own fresh login. */
async function accounts(h: Harness, ...labels: string[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const label of labels) {
    ids[label] = (await h.engine.addAccount(label, bundle(label.toUpperCase(), `u-${label}`))).id;
  }
  return ids;
}

describe('hand-offs are chosen from the rules as the batch leaves them', () => {
  it('never hands a slot to an account the same batch excludes from its rule', async () => {
    const h = await harness();
    const { x, y, z } = await accounts(h, 'x', 'y', 'z');
    await h.engine.activate(z!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [z!], origin: ORIGIN });
    await h.engine.ensureRuleLive(r.id);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(x);
    await runSession(h, p, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [], exclude: [y!], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [x!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'refused']);
    expect(refusalOf(plan.rules[1])).toContain('cannot include "x"');
    expect(plan.handOffs).toEqual([]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.handedOff).toEqual([]);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(x);
  });

  it("moves a grown rule's slot onto the account the batch includes in it", async () => {
    for (const spare of [false, true]) {
      const h = await harness();
      const { nn, yy, gg, qq } = await accounts(h, 'nn', 'yy', 'gg', 'qq');
      if (spare) await accounts(h, 'hh');
      await h.engine.activate(gg!);
      const p = await ruleFolder(h, 'p');
      const r = await h.vault.createRule({ folders: [p], exclude: [qq!], origin: ORIGIN });
      await h.engine.activate(yy!, { slot: ruleSlotId(r.id) });
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(p)], include: [nn!], exclude: [qq!], origin: ORIGIN },
        { scopes: [folder(await ruleFolder(h, 'q'))], include: [yy!], exclude: [] },
      ];

      const plan = await h.engine.planImportRules(specs);
      expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'create']);
      expect(plan.handOffs).toEqual([{ slot: ruleSlotId(r.id), from: yy, to: nn }]);

      const res = await h.engine.importRules(specs);
      expect(res.handedOff).toEqual(plan.handOffs);
      expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(nn);
    }
  });
});

describe('an exclusion that would empty a slot sessions run in', () => {
  it('is refused when the rest of the batch reserves what the slot would move to', async () => {
    const h = await harness();
    const { w, y, k, v } = await accounts(h, 'w', 'y', 'k', 'v');
    await h.engine.activate(w!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [v!], origin: ORIGIN });
    await h.engine.ensureRuleLive(r.id);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(y);
    await runSession(h, p, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [], exclude: [v!, y!], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [k!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['refused', 'create']);
    expect(refusalOf(plan.rules[0])).toContain('running session');

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(y);
  });

  it('is refused when the only account left is one the import keeps out', async () => {
    const h = await harness();
    const { w, y, v } = await accounts(h, 'w', 'y', 'v');
    await h.engine.activate(w!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [v!], origin: ORIGIN });
    await h.engine.ensureRuleLive(r.id);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(y);
    const { k } = await accounts(h, 'k');
    await runSession(h, p, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [], exclude: [y!], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs, { keepOut: [k!] });
    expect(plan.rules.map((v) => v.kind)).toEqual(['refused']);

    const res = await h.engine.importRules(specs, { keepOut: [k!] });
    expect(res.plan).toEqual(plan);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(y);
  });
});

describe('which specs the batch refuses', () => {
  it('counts the rule cap over the rules that land, not ones refused afterwards', async () => {
    const h = await harness();
    const { only } = await accounts(h, 'only');
    await h.engine.activate(only!);
    for (let i = 0; i < 63; i += 1) {
      await h.vault.createRule({ folders: [await ruleFolder(h, `r${i}`)], exclude: [only!] });
    }
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'pa'))], include: [only!], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 'pb'))], include: [], exclude: [only!] },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['refused', 'create']);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.listRules()).toHaveLength(64);
  });

  it('refuses only the spec whose reservation leaves a slot with nothing, in spec order', async () => {
    for (const order of ['ab', 'ba'] as const) {
      const h = await harness();
      const { x, y } = await accounts(h, 'x', 'y');
      await h.engine.activate(x!);
      const a: ImportRuleSpec = {
        scopes: [folder(await ruleFolder(h, 'a'))],
        include: [x!],
        exclude: [],
      };
      const b: ImportRuleSpec = {
        scopes: [folder(await ruleFolder(h, 'b'))],
        include: [x!, y!],
        exclude: [],
      };
      const specs = order === 'ab' ? [a, b] : [b, a];

      const plan = await h.engine.planImportRules(specs);
      expect(plan.rules.map((v) => v.kind)).toEqual(
        order === 'ab' ? ['create', 'refused'] : ['refused', 'create'],
      );
      expect(plan.handOffs).toEqual([{ slot: 'global', from: x, to: y }]);
      const res = await h.engine.importRules(specs);
      expect(res.plan).toEqual(plan);
      expect(await h.engine.getActiveId('global')).toBe(y);
    }
  });
});

describe('the slots a written rule ends up on', () => {
  it("leaves a grown rule's slot where it is when the batch includes nothing new in it", async () => {
    const h = await harness();
    const { g, a, b } = await accounts(h, 'g', 'a', 'b', 'c');
    await h.engine.activate(g!);
    const p1 = await ruleFolder(h, 'p1');
    await h.engine.importRules([
      { scopes: [folder(p1)], include: [a!], exclude: [], origin: ORIGIN },
    ]);
    const rule = (await h.engine.listRules())[0]!;
    // Auto-switch moved the slot to an inherited account, say because a ran out of usage.
    await h.engine.activate(b!, { slot: ruleSlotId(rule.id) });

    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(p1), folder(await ruleFolder(h, 'p3'))],
        include: [a!],
        exclude: [],
        origin: ORIGIN,
      },
    ];
    const res = await h.engine.importRules(specs);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['grow']);
    expect(await h.engine.getActiveId(ruleSlotId(rule.id))).toBe(b);
  });

  it('creates the rules in the order of the file', async () => {
    const h = await harness();
    const { x, y } = await accounts(h, 'x', 'y', 's');
    const [p1, p2, p3] = [
      await ruleFolder(h, 'p1'),
      await ruleFolder(h, 'p2'),
      await ruleFolder(h, 'p3'),
    ];
    await h.engine.importRules([
      { scopes: [folder(p1)], include: [x!], exclude: [] },
      { scopes: [folder(p2)], include: [], exclude: [y!] },
      { scopes: [folder(p3)], include: [y!], exclude: [] },
    ]);
    expect((await h.engine.listRules()).map((r) => r.folders[0])).toEqual([p1, p2, p3]);
  });
});

describe('a slot that cannot take the account it was handed', () => {
  it('is moved onto the next account that can, and the run says which', async () => {
    const h = await harness();
    const { a } = await accounts(h, 'a');
    const ex = await h.engine.addAccount('ex', bundle('EX1', 'u-ex', NOW - HOUR));
    const { good } = await accounts(h, 'good');
    await h.engine.activate(a!);
    h.onRefresh((cur) =>
      cur.refreshToken === 'r-EX1'
        ? Promise.reject(new RefreshError('network error during token refresh'))
        : Promise.resolve({ ...cur, accessToken: 'NET', expiresAt: NOW + HOUR }),
    );
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [a!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.handOffs).toEqual([{ slot: 'global', from: a, to: ex.id }]);
    const res = await h.engine.importRules(specs);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['create']);
    expect(res.handedOff).toEqual([{ slot: 'global', from: a, to: good }]);
    expect(res.outcomes[0]).toMatchObject({ ok: true });
    expect(await h.engine.getActiveId('global')).toBe(good);
  });

  it('reports a slot already moved when a later one has nowhere to go, writing what it can', async () => {
    const h = await harness();
    const { a, b, c } = await accounts(h, 'a', 'b', 'c');
    const d = await h.engine.addAccount('d', bundle('D1', 'u-d', NOW - HOUR));
    await h.engine.activate(a!);
    const side = await h.engine.excludeInFolder(await ruleFolder(h, 'q'), [c!]);
    expect(await h.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(b);
    h.onRefresh((cur) =>
      cur.refreshToken === 'r-D1'
        ? Promise.reject(new RefreshError('network error during token refresh'))
        : Promise.resolve({ ...cur, accessToken: 'NET', expiresAt: NOW + HOUR }),
    );
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [a!, b!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.handOffs).toEqual([
      { slot: 'global', from: a, to: c },
      { slot: ruleSlotId(side.rule.id), from: b, to: d.id },
    ]);
    const res = await h.engine.importRules(specs);
    expect(refusalOf(res.plan.rules[0])).toContain('"d"');
    expect(res.handedOff).toEqual([{ slot: 'global', from: a, to: c }]);
    expect(await h.engine.getActiveId('global')).toBe(c);
    expect(await h.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(b);
    expect(await h.engine.listRules()).toHaveLength(1);
  });
});

describe('the credential lock over a long import', () => {
  it('is renewed as the batch goes, so another process cannot take it while the import runs', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-decide-')));
    dirs.push(root);
    // One clock for both processes: real time plus what the slow refreshes add.
    const started = Date.now();
    let offset = 0;
    const clock = (): number => NOW + offset + (Date.now() - started);
    const importer = await harness({ clock, root });
    const daemon = await harness({ clock, root });
    const { g } = await accounts(importer, 'g');
    const a = await importer.engine.addAccount('a', bundle('A1', 'u-a', NOW - HOUR));
    const b = await importer.engine.addAccount('b', bundle('B1', 'u-b', NOW - HOUR));
    await importer.engine.activate(g!);
    let daemonOutcome: unknown = 'not called';
    importer.onRefresh(async (cur) => {
      // Each refresh is slow: a 529 retried within the budget one locked call may use.
      offset += 31_000;
      if (cur.refreshToken === 'r-B1') {
        daemonOutcome = await daemon.engine.refreshToken(b.id).catch((err: unknown) => err);
      }
      return { ...cur, accessToken: 'IMP-' + cur.accessToken, expiresAt: clock() + HOUR };
    });

    const res = await importer.engine.importRules([
      { scopes: [folder(await ruleFolder(importer, 'pa'))], include: [a.id], exclude: [] },
      { scopes: [folder(await ruleFolder(importer, 'pb'))], include: [b.id], exclude: [] },
    ]);
    expect(res.outcomes.map((o) => o?.ok)).toEqual([true, true]);
    expect(daemonOutcome).toBeInstanceOf(LockTimeoutError);
  });
});

describe('what the import does to the accounts it stores first', () => {
  it('counts a quarantined account whose login the import replaces as usable', async () => {
    const h = await harness();
    const { only } = await accounts(h, 'only');
    await h.engine.activate(only!);
    const q = await h.engine.addPendingAccount('q', { accountUuid: 'u-q' });
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [only!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs, { revived: [q.id] });
    expect(plan.rules.map((v) => v.kind)).toEqual(['create']);
    expect(plan.handOffs).toEqual([{ slot: 'global', from: only, to: q.id }]);
    await h.engine.importBundle(q.id, bundle('Q1', 'u-q'));
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
  });

  it('records the login a kept copy is of, for a stored row that recorded none', async () => {
    const h = await harness();
    const row = await h.engine.addAccount('client', {
      claudeAiOauth: { accessToken: 'C1', refreshToken: 'r-C1', expiresAt: NOW + 5 * HOUR },
      oauthAccount: { emailAddress: 'client@x.com' },
    });
    expect(row.accountUuid).toBeUndefined();
    const res = await h.engine.importBundle(row.id, {
      claudeAiOauth: { accessToken: 'C0', refreshToken: 'r-C0', expiresAt: NOW + HOUR },
      oauthAccount: { accountUuid: 'u-c', emailAddress: 'client@x.com' },
    });
    expect(res).toMatchObject({ replaced: false, reason: 'stored_newer' });
    const after = (await h.engine.listAllAccounts()).find((a) => a.id === row.id)!;
    expect(after.accountUuid).toBe('u-c');
    expect((await h.vault.readBundle(row.id)).claudeAiOauth.accessToken).toBe('C1');
  });
});

describe('a scope of the file that cannot be used here', () => {
  it("still refuses the rule whole when a rule of this machine's own holds it", async () => {
    const h = await harness();
    const { x, y } = await accounts(h, 'x', 'y', 's');
    const app = await ruleFolder(h, 'app');
    const old = await ruleFolder(h, 'old');
    await h.vault.createRule({ folders: [old], include: [y!], label: 'mine' });
    await rm(old, { recursive: true });
    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(app)],
        absent: [folder(old)],
        include: [x!],
        exclude: [],
        origin: ORIGIN,
      },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules[0]).toMatchObject({
      kind: 'refused',
      conflict: { rule: { label: 'mine' } },
    });
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.listRules()).toHaveLength(1);
  });
});
