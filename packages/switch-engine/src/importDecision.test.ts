// The import decision judged against what the batch itself writes: the slots it moves, the slots it
// leaves empty, the caps it counts, the account a slot ends up on, and what happens when a slot
// cannot take the account it was handed. Each case is decided by planImportRules (the dry run) and
// carried out by importRules (the real run), which must agree.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { ImportInterruptedError, LockTimeoutError, RefreshError } from './errors.js';
import { ruleIdOfSlot, ruleSlotId } from './types.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  ImportRuleSpec,
  ImportRuleVerdict,
  RuleScopeRef,
  SlotHandOff,
  SlotSeat,
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

const ORIGIN2 = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e';

/** Two rules with identities, each live on an account of its own; sessions run in the second. */
async function twoRules(
  h: Harness,
  first: { exclude: string[]; live: string },
  second: { exclude: string[]; live: string },
): Promise<{ a: string; b: string; ra: string; rb: string }> {
  const a = await ruleFolder(h, 'a');
  const b = await ruleFolder(h, 'b');
  const ra = (await h.vault.createRule({ folders: [a], exclude: first.exclude, origin: ORIGIN }))
    .id;
  const rb = (await h.vault.createRule({ folders: [b], exclude: second.exclude, origin: ORIGIN2 }))
    .id;
  await h.engine.activate(first.live, { slot: ruleSlotId(ra) });
  await h.engine.activate(second.live, { slot: ruleSlotId(rb) });
  await runSession(h, b, 4242);
  return { a, b, ra, rb };
}

describe('the seat each written rule ends up on is part of the decision', () => {
  it('refuses a rule an earlier seat would leave with nothing while sessions run there', async () => {
    const h = await harness();
    const { w, s, y, k, v } = await accounts(h, 'w', 's', 'y', 'k', 'v');
    await h.engine.activate(w!);
    const { a, b, ra, rb } = await twoRules(
      h,
      { exclude: [v!], live: s! },
      { exclude: [v!], live: y! },
    );
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(a)], include: [k!], exclude: [v!], origin: ORIGIN },
      { scopes: [folder(b)], include: [k!], exclude: [v!, y!, s!], origin: ORIGIN2 },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow', 'refused']);
    expect(refusalOf(plan.rules[1])).toContain('running session');
    expect(plan.seats).toEqual([{ slot: ruleSlotId(ra), from: s, to: k }]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId(ruleSlotId(ra))).toBe(k);
    expect(await h.engine.getActiveId(ruleSlotId(rb))).toBe(y);
  });

  it('counts the account an earlier seat takes for a quarantined occupant', async () => {
    const h = await harness();
    const { g, x, q, z, v } = await accounts(h, 'g', 'x', 'q', 'z', 'v');
    await h.engine.activate(g!);
    const { a, b, ra, rb } = await twoRules(
      h,
      { exclude: [v!], live: q! },
      { exclude: [v!], live: x! },
    );
    await h.vault.quarantine(q!, 'dead');
    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(a), folder(await ruleFolder(h, 'a2'))],
        include: [],
        exclude: [],
        origin: ORIGIN,
      },
      { scopes: [folder(b)], include: [], exclude: [x!], origin: ORIGIN2 },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow', 'refused']);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(ra), from: q, to: z }]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId(ruleSlotId(rb))).toBe(x);
  });

  it('counts the account an earlier seat takes because the batch newly includes it', async () => {
    const h = await harness();
    const { g, k, e, w } = await accounts(h, 'g', 'k', 'e', 'w');
    await h.engine.activate(g!);
    const { a, b, ra, rb } = await twoRules(
      h,
      { exclude: [e!], live: k! },
      { exclude: [g!], live: e! },
    );
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(a)], include: [w!], exclude: [], origin: ORIGIN },
      { scopes: [folder(b)], include: [w!], exclude: [e!, k!], origin: ORIGIN2 },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow', 'refused']);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(ra), from: k, to: w }]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.getActiveId(ruleSlotId(ra))).toBe(w);
    expect(await h.engine.getActiveId(ruleSlotId(rb))).toBe(e);
  });

  it('moves a running slot only onto an account the batch newly includes, and says so', async () => {
    const h = await harness();
    const { g, a, b, d } = await accounts(h, 'g', 'a', 'b', 'd');
    await h.engine.activate(g!);
    const p1 = await ruleFolder(h, 'p1');
    const rule = await h.vault.createRule({ folders: [p1], include: [a!], origin: ORIGIN });
    await h.engine.activate(b!, { slot: ruleSlotId(rule.id) });
    await runSession(h, p1, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p1)], include: [a!, d!], exclude: [], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs);
    const res = await h.engine.importRules(specs);
    expect(await h.engine.getActiveId(ruleSlotId(rule.id))).toBe(d);
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow']);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(rule.id), from: b, to: d }]);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
  });
});

describe('a hand-off onto an account another slot leaves in the same batch', () => {
  for (const spare of [false, true]) {
    it(`offers a grown rule's new include to its own slot once the slot holding it moves off${spare ? ', with a spare' : ''}`, async () => {
      const h = await harness();
      const { nn, yy, qq } = await accounts(h, 'nn', 'yy', 'qq');
      if (spare) await accounts(h, 'gg');
      await h.engine.activate(nn!);
      const p = await ruleFolder(h, 'p');
      const r = await h.vault.createRule({ folders: [p], exclude: [qq!], origin: ORIGIN });
      await h.engine.activate(yy!, { slot: ruleSlotId(r.id) });
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(p)], include: [nn!], exclude: [], origin: ORIGIN },
        { scopes: [folder(await ruleFolder(h, 'q'))], include: [yy!], exclude: [] },
      ];

      const plan = await h.engine.planImportRules(specs);
      expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'create']);
      expect(plan.handOffs).toEqual([
        { slot: 'global', from: nn, to: qq },
        { slot: ruleSlotId(r.id), from: yy, to: nn },
      ]);
      expect(plan.seats).toEqual([]);

      const res = await h.engine.importRules(specs);
      expect(res.plan).toEqual(plan);
      expect(res.handedOff).toEqual(plan.handOffs);
      expect(res.seated).toEqual([]);
      expect(await h.engine.getActiveId('global')).toBe(qq);
      expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(nn);
    });
  }
});

describe('the seat step on its own never moves a running slot the decision did not', () => {
  it('leaves a running slot as it was when the move it planned cannot be made', async () => {
    const h = await harness();
    const { w, y, v } = await accounts(h, 'w', 'y', 'v');
    const z = await h.engine.addAccount('z', bundle('Z1', 'u-z', NOW - HOUR));
    await accounts(h, 't');
    await h.engine.activate(w!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [v!], origin: ORIGIN });
    await h.engine.activate(y!, { slot: ruleSlotId(r.id) });
    await runSession(h, p, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [], exclude: [y!], origin: ORIGIN },
    ];
    const plan = await h.engine.planImportRules(specs);

    h.onRefresh(() => Promise.reject(new RefreshError('network error during token refresh')));
    const res = await h.engine.importRules(specs);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(y);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(r.id), from: y, to: z.id }]);
    expect(res.seated).toEqual([]);
    expect(res.outcomes[0]).toMatchObject({ ok: true, live: { heldForSessions: 1 } });
  });
});

describe('an import interrupted after it moved a slot', () => {
  /** The setup the plan of which moves the global slot a -> c, then the rule slot b -> d. */
  async function twoMoves(
    h: Harness,
    c: { expiresAt: number },
  ): Promise<{
    a: string;
    b: string;
    c: string;
    d: string;
    side: string;
    specs: ImportRuleSpec[];
  }> {
    const { a, b } = await accounts(h, 'a', 'b');
    const c1 = await h.engine.addAccount('c', bundle('C1', 'u-c', c.expiresAt));
    const { d } = await accounts(h, 'd');
    await h.engine.activate(a!);
    const side = await h.engine.excludeInFolder(await ruleFolder(h, 'q'), [c1.id]);
    expect(await h.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(b);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [a!, b!], exclude: [] },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.handOffs).toEqual([
      { slot: 'global', from: a, to: c1.id },
      { slot: ruleSlotId(side.rule.id), from: b, to: d },
    ]);
    return { a: a!, b: b!, c: c1.id, d: d!, side: side.rule.id, specs };
  }

  it('reports the slot moved when a later move fails on a file it cannot read', async () => {
    const h = await harness();
    const { a, b, c, d, side, specs } = await twoMoves(h, { expiresAt: NOW + HOUR });
    // The account's stored tokens cannot be read: a folder stands where the file should be.
    const enc = join(h.paths.vaultDir, d, 'cred.enc');
    await rm(enc, { force: true });
    await mkdir(enc);

    const res = await h.engine.importRules(specs);
    expect(res.handedOff).toEqual([{ slot: 'global', from: a, to: c }]);
    expect(refusalOf(res.plan.rules[0])).toContain('"d"');
    expect(await h.engine.getActiveId('global')).toBe(c);
    expect(await h.engine.getActiveId(ruleSlotId(side))).toBe(b);
  });

  it('carries the slots it moved when the lock is taken over between moves', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-decide-')));
    dirs.push(root);
    const started = Date.now();
    let offset = 0;
    const clock = (): number => NOW + offset + (Date.now() - started);
    const importer = await harness({ clock, root });
    const daemon = await harness({ clock, root });
    const { a, c, specs } = await twoMoves(importer, { expiresAt: NOW - HOUR });
    importer.onRefresh(async (cur) => {
      // The refresh outlasts the lock's reclaim, and another process takes the lock meanwhile.
      offset += 61_000;
      await daemon.engine.setAutoSwitchExcluded(a, false);
      return { ...cur, accessToken: 'IMP-' + cur.accessToken, expiresAt: clock() + HOUR };
    });

    const err = await importer.engine.importRules(specs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as ImportInterruptedError).handedOff).toEqual([{ slot: 'global', from: a, to: c }]);
    expect(err).toBeInstanceOf(ImportInterruptedError);
    expect(await importer.engine.getActiveId('global')).toBe(c);
  });
});

describe('the credential lock over one slot with several accounts to try', () => {
  it('is renewed before each account a seat tries', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-decide-')));
    dirs.push(root);
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
      offset += 31_000;
      if (cur.refreshToken === 'r-A1') throw new RefreshError('overloaded (529), try again later');
      daemonOutcome = await daemon.engine.refreshToken(b.id).catch((err: unknown) => err);
      return { ...cur, accessToken: 'IMP-' + cur.accessToken, expiresAt: clock() + HOUR };
    });

    const res = await importer.engine.importRules([
      { scopes: [folder(await ruleFolder(importer, 'pa'))], include: [a.id, b.id], exclude: [] },
    ]);
    expect(res.outcomes[0]).toMatchObject({ ok: true, live: { liveAccount: b.id } });
    expect(daemonOutcome).toBeInstanceOf(LockTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Random batches: the dry run is the real run, and no slot in use moves unannounced
// ---------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so a batch that fails can be built again from its seed. */
function seeded(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** A rule identity per index. */
const originOf = (i: number): string => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** What one slot holds: the account it is recognized as, and whether it holds a login at all. */
interface SlotHolding {
  id: string | null;
  login: boolean;
}

/** What every slot holds right now, by slot. */
async function holdings(h: Harness): Promise<Map<string, SlotHolding>> {
  const out = new Map<string, SlotHolding>();
  for (const [slot] of await h.engine.liveSlots()) {
    const creds =
      slot === 'global'
        ? h.paths.credentialsPath
        : join(groupProfileDir(h.paths.vaultDir, ruleIdOfSlot(slot)!), '.credentials.json');
    const login = existsSync(creds);
    out.set(slot, { id: login ? await h.engine.getActiveId(slot) : null, login });
  }
  return out;
}

/** A machine with accounts and rules in random states (some slots moved off their first account,
 *  a quarantined login, sessions running under some rules), and a random file of rules for it:
 *  rules it grows (by identity) with new scopes and members, and rules it creates. */
async function randomWorld(
  seed: number,
  opts: { expired: boolean },
): Promise<{ h: Harness; specs: ImportRuleSpec[]; keepOut: string[]; running: Set<string> }> {
  const random = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const some = <T>(xs: readonly T[], most: number): T[] => {
    const left = [...xs];
    const out: T[] = [];
    const count = Math.floor(random() * (most + 1));
    while (out.length < count && left.length > 0)
      out.push(left.splice(Math.floor(random() * left.length), 1)[0]!);
    return out;
  };
  const h = await harness();
  const ids: string[] = [];
  const count = 3 + Math.floor(random() * 3);
  for (let i = 0; i < count; i += 1) {
    const expiresAt = opts.expired && random() < 0.4 ? NOW - HOUR : NOW + HOUR;
    ids.push((await h.engine.addAccount(`a${i}`, bundle(`T${i}`, `u-${i}`, expiresAt))).id);
  }
  await h.engine.activate(pick(ids));
  const rules: Array<{ id: string; folder: string; origin: string }> = [];
  const ruleCount = 1 + Math.floor(random() * 3);
  for (let i = 0; i < ruleCount; i += 1) {
    const folderPath = await ruleFolder(h, `r${i}`);
    const live = new Set((await h.engine.liveSlots()).values());
    const include = some(
      ids.filter((id) => !live.has(id)),
      1,
    );
    const exclude = some(
      ids.filter((id) => !include.includes(id)),
      2,
    );
    if (include.length + exclude.length === 0) exclude.push(pick(ids));
    const rule = await h.vault
      .createRule({ folders: [folderPath], include, exclude, origin: originOf(i) })
      .catch(() => undefined);
    if (rule === undefined) continue;
    await h.engine.ensureRuleLive(rule.id).catch(() => undefined);
    rules.push({ id: rule.id, folder: folderPath, origin: originOf(i) });
  }
  // Slots moved off their first account (auto-switch), and a login gone dead.
  for (const rule of rules) {
    if (random() < 0.4) {
      await h.engine.activate(pick(ids), { slot: ruleSlotId(rule.id) }).catch(() => undefined);
    }
  }
  if (random() < 0.3) await h.vault.quarantine(pick(ids), 'dead');
  const running = new Set<string>();
  for (const [i, rule] of rules.entries()) {
    if (random() < 0.5) {
      await runSession(h, rule.folder, 5000 + i);
      running.add(ruleSlotId(rule.id));
    }
  }
  const specs: ImportRuleSpec[] = [];
  const members = (): { include: string[]; exclude: string[] } => {
    const include = some(ids, 2);
    return {
      include,
      exclude: some(
        ids.filter((id) => !include.includes(id)),
        2,
      ),
    };
  };
  for (const rule of rules) {
    if (random() < 0.3) continue;
    const scopes = [folder(rule.folder)];
    if (random() < 0.3) scopes.push(folder(await ruleFolder(h, `g${specs.length}`)));
    const { include, exclude } = members();
    // Often the account the slot runs on now, so the batch moves slots sessions run in.
    const occupant = await h.engine.getActiveId(ruleSlotId(rule.id));
    if (occupant !== null && random() < 0.5 && !include.includes(occupant)) exclude.push(occupant);
    specs.push({ scopes, include, exclude: [...new Set(exclude)], origin: rule.origin });
  }
  const creates = Math.floor(random() * 3);
  for (let i = 0; i < creates; i += 1) {
    specs.push({
      scopes: [folder(await ruleFolder(h, `c${i}`))],
      ...members(),
      ...(random() < 0.5 ? { origin: originOf(50 + i) } : {}),
    });
  }
  for (let i = specs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [specs[i], specs[j]] = [specs[j]!, specs[i]!];
  }
  return { h, specs, keepOut: random() < 0.3 ? [pick(ids)] : [], running };
}

/**
 * The run's own report is the truth about every slot that held a login: one it does not name is as
 * it was, and one it names ends where its last line says. A slot sessions run in is never left with
 * no login, and no account is live in two slots.
 */
function expectReported(
  seed: number,
  before: ReadonlyMap<string, SlotHolding>,
  after: ReadonlyMap<string, SlotHolding>,
  running: ReadonlySet<string>,
  moves: { handedOff: readonly SlotHandOff[]; seated: readonly SlotSeat[] },
): void {
  for (const [slot, was] of before) {
    if (!was.login) continue;
    const now = after.get(slot) ?? { id: null, login: false };
    const named = [
      ...moves.handedOff.filter((m) => m.slot === slot),
      ...moves.seated.filter((m) => m.slot === slot),
    ];
    const where = `seed ${seed}, ${slot}`;
    if (named.length === 0) {
      expect(now, where).toEqual(was);
      continue;
    }
    const last = named.at(-1)!;
    expect(now, where).toEqual({ id: last.to, login: last.to !== null });
    if (running.has(slot)) expect(now.login, `${where}: cleared under its sessions`).toBe(true);
  }
  const live = [...after.values()].flatMap((s) => (s.id !== null && s.login ? [s.id] : []));
  expect(new Set(live).size, `seed ${seed}: an account live in two slots`).toBe(live.length);
}

describe('random batches through the real engine', () => {
  const SEEDS_PER_TEST = 10;
  for (const block of [0, 1, 2]) {
    it(`does what its dry run said, and moves no slot it does not report (seeds ${block * SEEDS_PER_TEST}+)`, async () => {
      for (let k = 0; k < SEEDS_PER_TEST; k += 1) {
        const seed = 1000 + block * SEEDS_PER_TEST + k;
        const { h, specs, keepOut, running } = await randomWorld(seed, { expired: false });
        const plan = await h.engine.planImportRules(specs, { keepOut });
        const before = await holdings(h);
        const res = await h.engine.importRules(specs, { keepOut });
        expect(res.plan, `seed ${seed}`).toEqual(plan);
        expect(res.handedOff, `seed ${seed}`).toEqual(plan.handOffs);
        expect(res.seated, `seed ${seed}`).toEqual(plan.seats);
        expectReported(seed, before, await holdings(h), running, res);
      }
    }, 600_000);
  }

  for (const block of [0, 1]) {
    it(`moves no slot it does not report when accounts fail to refresh at run time (seeds ${block * SEEDS_PER_TEST}+)`, async () => {
      for (let k = 0; k < SEEDS_PER_TEST; k += 1) {
        const seed = 2000 + block * SEEDS_PER_TEST + k;
        const { h, specs, keepOut, running } = await randomWorld(seed, { expired: true });
        await h.engine.planImportRules(specs, { keepOut });
        const random = seeded(seed * 7);
        const failing = new Set<string>();
        h.onRefresh((cur) => {
          if (!failing.has(cur.refreshToken) && random() < 0.5) failing.add(cur.refreshToken);
          return failing.has(cur.refreshToken)
            ? Promise.reject(new RefreshError('network error during token refresh'))
            : Promise.resolve({
                ...cur,
                accessToken: 'NET-' + cur.accessToken,
                expiresAt: NOW + HOUR,
              });
        });
        const before = await holdings(h);
        const moves = await h.engine.importRules(specs, { keepOut }).catch((err: unknown) => {
          if (err instanceof ImportInterruptedError) return err;
          throw err;
        });
        expectReported(seed, before, await holdings(h), running, moves);
      }
    }, 600_000);
  }
});
