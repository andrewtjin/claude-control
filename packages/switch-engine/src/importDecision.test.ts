// The import decision judged against what the batch itself writes: the slots it moves, the slots it
// leaves empty, the caps it counts, the account a slot ends up on, and what happens when a slot
// cannot take the account it was handed. Each case is decided by planImportRules (the dry run) and
// carried out by importRules (the real run), which must agree.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { Lock } from './lock.js';
import { folderBindingsPath, groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import {
  ImportInterruptedError,
  LockTimeoutError,
  RefreshError,
  SwitchEngineError,
  VaultError,
} from './errors.js';
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
  it('refuses a later rule that reserves the only account the slot could move to', async () => {
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
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'refused']);
    expect(refusalOf(plan.rules[1])).toContain('where sessions are running');
    expect(plan.seats).toEqual([{ slot: ruleSlotId(r.id), from: y, to: k }]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(k);
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

  it('moves no slot for a rule an account that cannot go live then refuses', async () => {
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
    // d is found unable to go live before anything moves: the rule is refused, and the global slot
    // never leaves a.
    expect(res.handedOff).toEqual([]);
    expect(await switchesIn(h, 'global')).toEqual([{ from: null, to: a }]);
    expect(await h.engine.getActiveId('global')).toBe(a);
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

  it('is handed to another process waiting for it between one seat and the next', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-decide-')));
    dirs.push(root);
    // One clock for both processes, so neither takes the other's claim for a stale one.
    const started = Date.now();
    const clock = (): number => NOW + (Date.now() - started);
    const h = await harness({ clock, root });
    const { g } = await accounts(h, 'g');
    await h.engine.activate(g!);
    const n = 8;
    const specs: ImportRuleSpec[] = [];
    for (let i = 0; i < n; i += 1) {
      const { id } = await h.engine.addAccount(`a${i}`, bundle(`A${i}`, `u-a${i}`));
      specs.push({ scopes: [folder(await ruleFolder(h, `p${i}`))], include: [id], exclude: [] });
    }
    // Another process takes the lock over and over, the way a cctl command or the daemon would,
    // each time waiting for it as they do, and says when it got it.
    const lockModule = pathToFileURL(join(import.meta.dirname, 'lock.ts')).href;
    const script = join(root, 'contender.mts');
    await writeFile(
      script,
      [
        `import { acquireLock } from ${JSON.stringify(lockModule)};`,
        'const [dir, offset] = process.argv.slice(2);',
        'const clock = () => Date.now() + Number(offset);',
        "process.stdout.write('ready\\n');",
        'for (;;) {',
        '  const lock = await acquireLock(dir, clock, { timeoutMs: 60000, pollMs: 100 });',
        "  process.stdout.write('got ' + Date.now() + '\\n');",
        '  lock.release();',
        '  await new Promise((r) => setTimeout(r, 20));',
        '}',
      ].join('\n'),
    );
    const contender = spawn(
      process.execPath,
      ['--import', 'tsx', script, join(h.paths.vaultDir, '.lock'), String(NOW - started)],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      let out = '';
      await new Promise<void>((resolve, reject) => {
        contender.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('ready')) resolve();
        });
        contender.once('exit', (code) => reject(new Error(`contender exited (${String(code)})`)));
      });
      const from = Date.now();
      const res = await h.engine.importRules(specs);
      const to = Date.now();
      expect(res.outcomes.every((o) => o?.ok === true)).toBe(true);
      const got = [...out.matchAll(/got (\d+)/g)].map((m) => Number(m[1]));
      // The import holds the lock n + 2 times (the batch, each seat, the snapshot): the process
      // waiting all along is handed it in every gap between them, not only when a poll of its own
      // happens to land in one.
      expect(got.filter((at) => at > from && at < to).length).toBeGreaterThanOrEqual(n);
    } finally {
      contender.kill();
    }
  }, 60_000);
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
  it('leaves a rule the account it would only have liked, for a slot sessions need it in', async () => {
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
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow', 'grow']);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(rb), from: y, to: k }]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId(ruleSlotId(ra))).toBe(s);
    expect(await h.engine.getActiveId(ruleSlotId(rb))).toBe(k);
  });

  it('replaces a quarantined occupant with the account another moving slot leaves', async () => {
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
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow', 'grow']);
    expect(plan.seats).toEqual([
      { slot: ruleSlotId(rb), from: x, to: z },
      { slot: ruleSlotId(ra), from: q, to: x },
    ]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId(ruleSlotId(ra))).toBe(x);
    expect(await h.engine.getActiveId(ruleSlotId(rb))).toBe(z);
  });

  it('keeps an account a rule newly includes for the running slot that has no other', async () => {
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
    expect(plan.rules.map((r) => r.kind)).toEqual(['grow', 'grow']);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(rb), from: e, to: w }]);

    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.getActiveId(ruleSlotId(ra))).toBe(k);
    expect(await h.engine.getActiveId(ruleSlotId(rb))).toBe(w);
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

describe('an account of the plan found unable to go live', () => {
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

  it('moves no slot when its stored tokens cannot be read', async () => {
    const h = await harness();
    const { a, b, d, side, specs } = await twoMoves(h, { expiresAt: NOW + HOUR });
    // The account's stored tokens cannot be read: a folder stands where the file should be.
    const enc = join(h.paths.vaultDir, d, 'cred.enc');
    await rm(enc, { force: true });
    await mkdir(enc);

    const res = await h.engine.importRules(specs);
    expect(refusalOf(res.plan.rules[0])).toContain('"d"');
    expect(res.handedOff).toEqual([]);
    expect(await h.engine.getActiveId('global')).toBe(a);
    expect(await h.engine.getActiveId(ruleSlotId(side))).toBe(b);
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

/**
 * Every slot a finished run reports as handed off left an account that the rules, as the run leaves
 * them, no longer let it hold ("now reserved"): no slot is ever moved for a rule the run then
 * refuses.
 */
async function expectHandOffsKept(
  seed: number,
  h: Harness,
  moves: { handedOff: readonly SlotHandOff[] },
): Promise<void> {
  const rules = await h.engine.listRules();
  for (const hand of moves.handedOff) {
    const own = rules.find((r) => r.id === ruleIdOfSlot(hand.slot));
    const reserved = rules.some((r) => r.include.includes(hand.from));
    expect(
      reserved && own?.include.includes(hand.from) !== true,
      `seed ${seed}, ${hand.slot}`,
    ).toBe(true);
  }
}

/** The breaches of who may be live where, one key per breach. */
async function custodyBreaches(h: Harness): Promise<Set<string>> {
  const kinds = [
    'reserved_live_in_global',
    'outside_pool_live_in_rule',
    'account_in_multiple_slots',
  ];
  return new Set(
    (await h.engine.checkSlots())
      .filter((v) => kinds.includes(v.kind))
      .map((v) => `${v.kind} ${v.slot ?? (v.slots ?? []).join(',')} ${v.accountId ?? ''}`),
  );
}

/** The run left no slot running an account its rules forbid it that it did not run before. */
function expectNoNewBreach(seed: number, before: Set<string>, after: Set<string>): void {
  expect(
    [...after].filter((b) => !before.has(b)),
    `seed ${seed}`,
  ).toEqual([]);
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
        const breaches = await custodyBreaches(h);
        const res = await h.engine.importRules(specs, { keepOut });
        expect(res.plan, `seed ${seed}`).toEqual(plan);
        expect(res.handedOff, `seed ${seed}`).toEqual(plan.handOffs);
        expect(res.seated, `seed ${seed}`).toEqual(plan.seats);
        expectReported(seed, before, await holdings(h), running, res);
        expectNoNewBreach(seed, breaches, await custodyBreaches(h));
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
        const breaches = await custodyBreaches(h);
        const moves = await h.engine.importRules(specs, { keepOut }).catch((err: unknown) => {
          if (err instanceof ImportInterruptedError) return err;
          throw err;
        });
        expectReported(seed, before, await holdings(h), running, moves);
        expectNoNewBreach(seed, breaches, await custodyBreaches(h));
        if (!(moves instanceof ImportInterruptedError)) await expectHandOffsKept(seed, h, moves);
      }
    }, 600_000);
  }
});

// ---------------------------------------------------------------------------
// Every move planned together, and made only once every account it needs is known to work
// ---------------------------------------------------------------------------

/** Every switch the audit trail records in `slot`, in order. */
async function switchesIn(
  h: Harness,
  slot: string,
): Promise<Array<{ from: string | null; to: string }>> {
  const text = await readFile(join(h.paths.vaultDir, 'switch-audit.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string;
          slot?: string;
          fromAccountId: string | null;
          toAccountId: string;
        },
    )
    .filter((e) => e.event === 'activated' && (e.slot ?? 'global') === slot)
    .map((e) => ({ from: e.fromAccountId, to: e.toAccountId }));
}

/** A refresh that fails for the stored tokens of `dead` and succeeds for every other. */
function failingFor(h: Harness, ...dead: string[]): void {
  h.onRefresh((cur) =>
    dead.includes(cur.refreshToken)
      ? Promise.reject(new RefreshError('network error during token refresh'))
      : Promise.resolve({
          ...cur,
          accessToken: 'NET-' + cur.accessToken,
          expiresAt: h.clock() + HOUR,
        }),
  );
}

describe('a slot torn between two accounts', () => {
  it('is seated where the dry run said, whether or not sessions run under the rule', async () => {
    for (const running of [false, true]) {
      const h = await harness();
      const { g, w, x, e, z } = await accounts(h, 'g', 'w', 'x', 'e', 'z');
      await h.engine.activate(g!);
      const p1 = await ruleFolder(h, 'p1');
      const p2 = await ruleFolder(h, 'p2');
      const r1 = await h.vault.createRule({ folders: [p1], exclude: [e!], origin: ORIGIN });
      const r2 = await h.vault.createRule({ folders: [p2], exclude: [w!], origin: ORIGIN2 });
      await h.engine.activate(w!, { slot: ruleSlotId(r1.id) });
      await h.engine.activate(e!, { slot: ruleSlotId(r2.id) });
      // r1's slot holds x's stored token under w's identity.
      const xs = (await h.vault.readBundle(x!)).claudeAiOauth;
      await writeFile(
        join(groupProfileDir(h.paths.vaultDir, r1.id), '.credentials.json'),
        JSON.stringify({ claudeAiOauth: xs }),
      );
      expect(await h.engine.getActiveId(ruleSlotId(r1.id))).toBe(w);
      if (running) await runSession(h, p2, 4242);
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(p1)], include: [], exclude: [z!], origin: ORIGIN },
        { scopes: [folder(p2)], include: [], exclude: [e!], origin: ORIGIN2 },
      ];

      const plan = await h.engine.planImportRules(specs);
      const res = await h.engine.importRules(specs);
      expect(res.plan, `running ${running}`).toEqual(plan);
      expect(res.seated, `running ${running}`).toEqual(plan.seats);
      const seat = plan.seats.find((s) => s.slot === ruleSlotId(r2.id));
      expect(seat?.to, `running ${running}`).toBe(z);
      expect(await h.engine.getActiveId(ruleSlotId(r2.id)), `running ${running}`).toBe(z);
    }
  });
});

describe('a decision made again after an account fails', () => {
  it('switches a slot it still moves once, and reports it as the seat it is', async () => {
    const h = await harness();
    const { x, y, v, g } = await accounts(h, 'x', 'y', 'v', 'g');
    const w = await h.engine.addAccount('w', bundle('W1', 'u-w', NOW - HOUR));
    await h.engine.activate(g!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [w.id], origin: ORIGIN });
    await h.engine.activate(x!, { slot: ruleSlotId(r.id) });
    const r3 = await h.vault.createRule({
      folders: [await ruleFolder(h, 'r3')],
      exclude: [x!, y!, g!],
    });
    await h.engine.activate(v!, { slot: ruleSlotId(r3.id) });
    failingFor(h, 'r-W1');
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [y!], exclude: [], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [x!, v!], exclude: [] },
    ];

    const res = await h.engine.importRules(specs);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['grow', 'refused']);
    expect(await switchesIn(h, ruleSlotId(r.id))).toEqual([
      { from: null, to: x },
      { from: x, to: y },
    ]);
    expect(res.seated).toEqual([{ slot: ruleSlotId(r.id), from: x, to: y }]);
    expect(res.handedOff).toEqual([]);
    expect(await h.engine.getActiveId(ruleSlotId(r3.id))).toBe(v);
  });

  it('lands a rule the slots allow without switching any slot back and forth', async () => {
    const h = await harness();
    const { x, w, v, y } = await accounts(h, 'x', 'w', 'v', 'y');
    const z = await h.engine.addAccount('z', bundle('Z1', 'u-z', NOW - HOUR));
    await h.engine.activate(x!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [z.id], origin: ORIGIN });
    await h.engine.activate(w!, { slot: ruleSlotId(r.id) });
    const r3 = await h.vault.createRule({ folders: [await ruleFolder(h, 'q')], exclude: [x!] });
    await h.engine.activate(v!, { slot: ruleSlotId(r3.id) });
    failingFor(h, 'r-Z1');
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [x!, v!], exclude: [z.id], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 's'))], include: [w!], exclude: [] },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'create']);

    const res = await h.engine.importRules(specs);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['refused', 'create']);
    expect(refusalOf(res.plan.rules[0])).not.toContain('"y"');
    expect(res.handedOff).toEqual([{ slot: ruleSlotId(r.id), from: w, to: y }]);
    expect(await switchesIn(h, 'global')).toEqual([{ from: null, to: x }]);
    expect(await h.engine.getActiveId(ruleSlotId(r3.id))).toBe(v);
  });

  it('reports every slot it moved as moved for a rule that landed', async () => {
    const h = await harness();
    const { a, v, y } = await accounts(h, 'a', 'v', 'y');
    await accounts(h, 't');
    await h.engine.activate(a!);
    const side = await h.engine.excludeInFolder(await ruleFolder(h, 'q'), [a!]);
    expect(await h.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(v);
    h.advance(HOUR);
    failingFor(h, 'r-A', 'r-T');
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 's2'))], include: [v!], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 's1'))], include: [a!], exclude: [] },
    ];

    const res = await h.engine.importRules(specs);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['create', 'refused']);
    expect(res.handedOff).toEqual([{ slot: ruleSlotId(side.rule.id), from: v, to: y }]);
    await expectHandOffsKept(0, h, res);
    expect(await h.engine.getActiveId('global')).toBe(a);
  });
});

describe('an import that stops part-way', () => {
  it('moves nothing when the lock is taken over before any rule is written', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-decide-')));
    dirs.push(root);
    const started = Date.now();
    let offset = 0;
    const clock = (): number => NOW + offset + (Date.now() - started);
    const importer = await harness({ clock, root });
    const daemon = await harness({ clock, root });
    const { a, b } = await accounts(importer, 'a', 'b');
    const c = await importer.engine.addAccount('c', bundle('C1', 'u-c', NOW - HOUR));
    await accounts(importer, 'd');
    await importer.engine.activate(a!);
    const side = await importer.engine.excludeInFolder(await ruleFolder(importer, 'q'), [c.id]);
    importer.onRefresh(async (cur) => {
      // The refresh outlasts the lock's reclaim, and another process takes the lock meanwhile.
      offset += 61_000;
      await daemon.engine.setAutoSwitchExcluded(a!, false);
      return { ...cur, accessToken: 'IMP-' + cur.accessToken, expiresAt: clock() + HOUR };
    });
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(importer, 'p'))], include: [a!, b!], exclude: [] },
    ];

    const err = await importer.engine.importRules(specs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(ImportInterruptedError);
    expect((err as SwitchEngineError).code).toBe('lock_lost');
    expect(await importer.engine.getActiveId('global')).toBe(a);
    expect(await importer.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(b);
    expect(await importer.engine.listRules()).toHaveLength(1);
  });

  it('carries what each rule it wrote came to when it stops after the writes', async () => {
    const h = await harness();
    const { g, a, b } = await accounts(h, 'g', 'a', 'b');
    await h.engine.activate(g!);
    // The guard snapshot cannot be written: a folder stands where the file goes.
    const snapshot = folderBindingsPath(h.paths.vaultDir);
    await rm(snapshot, { force: true });
    await mkdir(join(snapshot, 'in-the-way'), { recursive: true });
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [a!], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [b!], exclude: [] },
    ];

    const err = await h.engine.importRules(specs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImportInterruptedError);
    const stopped = err as ImportInterruptedError;
    expect(stopped.message.match(/running it again/g) ?? []).toHaveLength(0);
    expect(stopped.plan.rules.map((v) => v.kind)).toEqual(['create', 'create']);
    expect(stopped.outcomes.map((o) => o?.ok)).toEqual([true, true]);
    expect(stopped.allWritten).toBe(true);
    expect(await h.engine.listRules()).toHaveLength(2);
  });
});

describe('the refusal of a rule that would leave sessions with no account', () => {
  it('names a remedy cctl import has', async () => {
    const h = await harness();
    const { w, y, v } = await accounts(h, 'w', 'y', 'v');
    await h.engine.activate(w!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [v!], origin: ORIGIN });
    await h.engine.ensureRuleLive(r.id);
    const { k } = await accounts(h, 'k');
    await runSession(h, p, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [], exclude: [y!], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs, { keepOut: [k!] });
    expect(refusalOf(plan.rules[0])).toContain('running session');
    expect(refusalOf(plan.rules[0])).not.toContain('--force');
    expect(refusalOf(plan.rules[0])).toContain('import again');
  });
});

describe('the cost of seating many rules', () => {
  /** The most reads of slot logins, and of every stored token, that one hold of the credential lock
   *  makes while `n` new rules are imported and seated. */
  async function mostPerHold(n: number): Promise<{ slotReads: number; tokenReads: number }> {
    const h = await harness();
    const { g } = await accounts(h, 'g');
    await h.engine.activate(g!);
    const specs: ImportRuleSpec[] = [];
    for (let i = 0; i < n; i += 1) {
      const { id } = await h.engine.addAccount(`a${i}`, bundle(`A${i}`, `u-a${i}`));
      specs.push({ scopes: [folder(await ruleFolder(h, `p${i}`))], include: [id], exclude: [] });
    }
    const slotReads = vi.spyOn(CredentialStore.prototype, 'readLiveCredentials');
    const tokenReads = vi.spyOn(Vault.prototype, 'readStoredTokens');
    const releases = vi.spyOn(Lock.prototype, 'release');
    const res = await h.engine.importRules(specs);
    const ends = releases.mock.invocationCallOrder;
    /** The calls of `spy` in the busiest hold. */
    const most = (spy: { mock: { invocationCallOrder: number[] } }): number =>
      Math.max(
        ...ends.map(
          (end, k) =>
            spy.mock.invocationCallOrder.filter((at) => at < end && at > (ends[k - 1] ?? 0)).length,
        ),
      );
    const out = { slotReads: most(slotReads), tokenReads: most(tokenReads) };
    vi.restoreAllMocks();
    expect(res.outcomes.every((o) => o?.ok === true)).toBe(true);
    return out;
  }

  it('holds the lock for work that grows with the rules, never with their square', async () => {
    const small = await mostPerHold(3);
    const large = await mostPerHold(12);
    // Four times the rules: about four times the slot reads in the busiest hold (one walk of every
    // slot), nowhere near sixteen times, and the same few reads of every stored token.
    expect(large.slotReads / small.slotReads).toBeLessThan(5);
    expect(large.tokenReads).toBeLessThanOrEqual(small.tokenReads + 2);
  });
});

describe('moves planned with the seats they make room for', () => {
  /** T on folder t2 excludes d and runs s, sessions run there, and the main login runs a. Shared
   *  accounts, in pool order: s, c, d, a. */
  async function seatWorld(
    h: Harness,
  ): Promise<{ s: string; c: string; d: string; a: string; t: string; t2: string }> {
    const { s, c, d, a } = await accounts(h, 's', 'c', 'd', 'a');
    await h.engine.activate(a!);
    const t2 = await ruleFolder(h, 't2');
    const t = await h.vault.createRule({ folders: [t2], exclude: [d!], origin: ORIGIN });
    await h.engine.activate(s!, { slot: ruleSlotId(t.id) });
    await runSession(h, t2, 4242);
    return { s: s!, c: c!, d: d!, a: a!, t: t.id, t2 };
  }

  it('hands the main login an account the batch moves a seat off', async () => {
    const h = await harness();
    const { s, c, d, a, t, t2 } = await seatWorld(h);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(t2)], include: [c], exclude: [s], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 'n1'))], include: [a], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 'n2'))], include: [d], exclude: [] },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'create', 'create']);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.getActiveId('global')).toBe(s);
    expect(await h.engine.getActiveId(ruleSlotId(t))).toBe(c);
    expect(await switchesIn(h, 'global')).toEqual([
      { from: null, to: a },
      { from: a, to: s },
    ]);
  });

  it('leaves a seat the account it needs when the main login can take another', async () => {
    const h = await harness();
    const { s, c, a, t, t2 } = await seatWorld(h);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(t2)], include: [], exclude: [s], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 'n1'))], include: [a], exclude: [] },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'create']);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    // The main login takes the account the running slot leaves, which leaves c for that slot.
    expect(await h.engine.getActiveId('global')).toBe(s);
    expect(await h.engine.getActiveId(ruleSlotId(t))).toBe(c);
  });

  it('leaves a running slot that holds a login of no account here the account it needs', async () => {
    const h = await harness();
    const { c, d, a } = await accounts(h, 'c', 'd', 'a');
    await h.engine.activate(a!);
    const t2 = await ruleFolder(h, 't2');
    const t = await h.vault.createRule({ folders: [t2], exclude: [d!], origin: ORIGIN });
    await h.engine.ensureRuleLive(t.id);
    // A /login there of an account this machine does not store.
    await liveLogin(h, t.id, 'ZED', 'u-zed');
    await runSession(h, t2, 4242);
    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(t2), folder(await ruleFolder(h, 't3'))],
        include: [],
        exclude: [d!],
        origin: ORIGIN,
      },
      { scopes: [folder(await ruleFolder(h, 'n1'))], include: [a!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'create']);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    // The main login takes d, which leaves c for the running slot.
    expect(await h.engine.getActiveId('global')).toBe(d);
    expect(await h.engine.getActiveId(ruleSlotId(t.id))).toBe(c);
  });

  it('lands in one run what a second run of the same file would', async () => {
    const h = await harness();
    const { a, b, c, d } = await accounts(h, 'a', 'b', 'c', 'd');
    await h.engine.activate(c!);
    const r = await h.vault.createRule({ folders: [await ruleFolder(h, 'r')], include: [d!] });
    await h.engine.activate(b!, { slot: ruleSlotId(r.id) });
    const pf = await ruleFolder(h, 'p');
    const pr = await h.vault.createRule({ folders: [pf], exclude: [c!] });
    await h.engine.activate(a!, { slot: ruleSlotId(pr.id) });
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(pf)], include: [d!], exclude: [a!], origin: pr.id },
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [c!], exclude: [], origin: ORIGIN2 },
    ];
    const res = await h.engine.importRules(specs);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['grow', 'create']);
    expect(await h.engine.getActiveId('global')).toBe(a);
    expect(await h.engine.getActiveId(ruleSlotId(pr.id))).toBe(d);
    const again = await h.engine.planImportRules(specs);
    expect(again.rules.map((v) => v.kind)).toEqual(['unchanged', 'unchanged']);
    expect(again.handOffs).toEqual([]);
    expect(again.seats).toEqual([]);
  });

  it('refuses a rule only for what the rest of the file leaves it, so a second run adds nothing', async () => {
    const h = await harness();
    const { a0, a1, a2 } = await accounts(h, 'a0', 'a1', 'a2');
    await h.engine.activate(a1!);
    const r0 = await h.vault.createRule({
      folders: [await ruleFolder(h, 'r0')],
      include: [a2!],
      exclude: [a0!, a1!],
    });
    await h.engine.activate(a2!, { slot: ruleSlotId(r0.id) });
    const r1f = await ruleFolder(h, 'r1');
    const r1 = await h.vault.createRule({ folders: [r1f], exclude: [a1!], origin: ORIGIN });
    await h.engine.activate(a0!, { slot: ruleSlotId(r1.id) });
    // The first two need what the last two free: r1's own rule takes its slot off a0, and the
    // main login can move onto a0 once it has.
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'c0'))], include: [a1!, a2!], exclude: [a0!] },
      { scopes: [folder(await ruleFolder(h, 'c1'))], include: [a0!, a2!], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 'c2'))], include: [a1!], exclude: [a2!] },
      { scopes: [folder(r1f)], include: [a2!], exclude: [a0!, a1!], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    const again = await h.engine.planImportRules(specs);
    for (const [i, verdict] of again.rules.entries()) {
      expect(verdict.kind, `spec ${i}: ${refusalOf(plan.rules[i])}`).not.toMatch(/create|grow/);
    }
  });

  it('refuses no rule for an account a later rule frees, when more than one rule cannot land', async () => {
    const h = await harness();
    const { g, f, p, q, x } = await accounts(h, 'g', 'f', 'p', 'q', 'x');
    await h.engine.activate(g!);
    const ff = await ruleFolder(h, 'F');
    const F = await h.vault.createRule({ folders: [ff], exclude: [g!], origin: ORIGIN });
    await h.engine.activate(f!, { slot: ruleSlotId(F.id) });
    // Three busy slots, each on the one account its rule leaves it.
    const busy = [
      { name: 'P', exclude: [g!, f!, q!], live: p! },
      { name: 'Q', exclude: [g!, f!, p!], live: q! },
      { name: 'X', exclude: [g!, f!, p!, q!], live: x! },
    ];
    for (const [k, { name, exclude, live }] of busy.entries()) {
      const dir = await ruleFolder(h, name);
      const rule = await h.vault.createRule({ folders: [dir], exclude });
      await h.engine.activate(live, { slot: ruleSlotId(rule.id) });
      await runSession(h, dir, 4001 + k);
    }
    // The second and third cannot land whatever else does; the first needs the main login to move
    // onto f, which the last frees by taking F's slot off it.
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'c0'))], include: [g!], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 'c1'))], include: [p!], exclude: [] },
      { scopes: [folder(await ruleFolder(h, 'c2'))], include: [q!], exclude: [] },
      { scopes: [folder(ff)], include: [], exclude: [f!], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['create', 'refused', 'refused', 'grow']);
    expect(plan.handOffs).toContainEqual({ slot: 'global', from: g, to: f });
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    const again = await h.engine.planImportRules(specs);
    for (const [i, verdict] of again.rules.entries()) {
      expect(verdict.kind, `spec ${i}: ${refusalOf(plan.rules[i])}`).not.toMatch(/create|grow/);
    }
  });

  it("moves a grown rule's slot onto an account the batch includes there that another rule reserves", async () => {
    for (const spare of [false, true]) {
      const h = await harness();
      const { g, x, z, w } = await accounts(h, 'g', 'x', 'z', 'w');
      if (spare) await accounts(h, 'v');
      await h.engine.activate(g!);
      await h.engine.includeInFolder(await ruleFolder(h, 'q'), [w!, z!]);
      const p = await ruleFolder(h, 'p');
      const r = await h.vault.createRule({ folders: [p], exclude: [g!], origin: ORIGIN });
      await h.engine.ensureRuleLive(r.id);
      expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBe(x);
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(p)], include: [z!], exclude: [g!], origin: ORIGIN },
        { scopes: [folder(await ruleFolder(h, 'n'))], include: [x!], exclude: [] },
      ];
      const plan = await h.engine.planImportRules(specs);
      expect(
        plan.rules.map((v) => v.kind),
        `spare ${spare}`,
      ).toEqual(['grow', 'create']);
      const res = await h.engine.importRules(specs);
      expect(res.plan, `spare ${spare}`).toEqual(plan);
      expect(res.handedOff, `spare ${spare}`).toEqual(plan.handOffs);
      expect(await h.engine.getActiveId(ruleSlotId(r.id)), `spare ${spare}`).toBe(z);
    }
  });
});

/** Write a login straight into a slot's live files, as a /login there would: credentials and the
 *  identity block, the rest of the identity file kept. */
async function liveLogin(
  h: Harness,
  ruleId: string | undefined,
  access: string,
  uuid: string,
): Promise<void> {
  const dir = ruleId === undefined ? undefined : groupProfileDir(h.paths.vaultDir, ruleId);
  const creds = dir === undefined ? h.paths.credentialsPath : join(dir, '.credentials.json');
  const ident = dir === undefined ? h.paths.claudeJsonPath : join(dir, '.claude.json');
  await writeFile(
    creds,
    JSON.stringify({
      claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt: NOW + HOUR },
    }),
  );
  const prior = JSON.parse(await readFile(ident, 'utf8').catch(() => '{}')) as object;
  await writeFile(
    ident,
    JSON.stringify({
      ...prior,
      oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.com` },
    }),
  );
}

describe('an account stored without tokens whose login runs here', () => {
  it('keeps that login when the import moves the slot off it', async () => {
    const h = await harness();
    const { g } = await accounts(h, 'g', 'y');
    await liveLogin(h, undefined, 'N-LIVE', 'u-n');
    const n = await h.engine.addPendingAccount('n', { accountUuid: 'u-n' });
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [n.id], exclude: [] },
    ];

    const res = await h.engine.importRules(specs);
    expect(res.handedOff).toEqual([{ slot: 'global', from: n.id, to: g }]);
    expect((await h.vault.readBundle(n.id)).claudeAiOauth.refreshToken).toBe('r-N-LIVE');
    expect((await h.engine.listAllAccounts()).find((a) => a.id === n.id)?.quarantined).toBeFalsy();
  });
});

describe('a reserved account whose login runs in the main login', () => {
  it('counts as live there in the real run as in the dry run, once the import stores its tokens', async () => {
    const h = await harness();
    const { a, x } = await accounts(h, 'a', 'x');
    await h.engine.activate(a!);
    const r1f = await ruleFolder(h, 'r1');
    const r1 = await h.vault.createRule({ folders: [r1f], include: [a!] });
    await h.engine.activate(x!, { slot: ruleSlotId(r1.id) });
    await h.vault.quarantine(a!, 'dead');
    await runSession(h, r1f, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [x!], exclude: [] },
    ];

    const plan = await h.engine.planImportRules(specs, { revived: [a!] });
    await h.engine.importBundle(a!, bundle('A2', 'u-a', NOW + 2 * HOUR));
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect((await h.engine.checkSlots()).map((v) => v.kind)).not.toContain(
      'account_in_multiple_slots',
    );
  });

  it('counts as live there by its token alone, once the import stores its new tokens', async () => {
    for (const identity of ['none', 'another account'] as const) {
      const h = await harness();
      const { g, a, x } = await accounts(h, 'g', 'a', 'x');
      await h.engine.activate(a!);
      const r1f = await ruleFolder(h, 'r1');
      const r1 = await h.vault.createRule({ folders: [r1f], include: [a!] });
      await h.engine.activate(x!, { slot: ruleSlotId(r1.id) });
      await h.vault.quarantine(a!, 'dead');
      await runSession(h, r1f, 4242);
      // The main login runs a's token, under no identity block, or under g's.
      const ident = JSON.parse(await readFile(h.paths.claudeJsonPath, 'utf8')) as {
        oauthAccount?: unknown;
      };
      if (identity === 'none') delete ident.oauthAccount;
      else ident.oauthAccount = (await h.vault.readBundle(g!)).oauthAccount;
      await writeFile(h.paths.claudeJsonPath, JSON.stringify(ident));
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(await ruleFolder(h, 'q'))], include: [x!], exclude: [] },
      ];

      const plan = await h.engine.planImportRules(specs, { revived: [a!] });
      await h.engine.importBundle(a!, bundle('A2', 'u-a', NOW + 2 * HOUR));
      const res = await h.engine.importRules(specs);
      expect(res.plan, `identity ${identity}`).toEqual(plan);
      expect(
        (await h.engine.checkSlots()).map((v) => v.kind),
        `identity ${identity}`,
      ).not.toContain('account_in_multiple_slots');
      // The main login was given the new tokens, so its old, spent copy is not left running there.
      const live = JSON.parse(await readFile(h.paths.credentialsPath, 'utf8')) as {
        claudeAiOauth: ClaudeOauth;
      };
      expect(live.claudeAiOauth.refreshToken, `identity ${identity}`).toBe('r-A2');
    }
  });

  it('keeps its stored tokens when the slot running it by its token alone cannot take the new ones', async () => {
    const h = await harness();
    const { a, x } = await accounts(h, 'g', 'a', 'x');
    await h.engine.activate(a!);
    const r1f = await ruleFolder(h, 'r1');
    const r1 = await h.vault.createRule({ folders: [r1f], include: [a!] });
    await h.engine.activate(x!, { slot: ruleSlotId(r1.id) });
    await h.vault.quarantine(a!, 'dead');
    await runSession(h, r1f, 4242);
    // The main login runs a's token under no identity block, and its credentials cannot be written.
    const ident = JSON.parse(await readFile(h.paths.claudeJsonPath, 'utf8')) as {
      oauthAccount?: unknown;
    };
    delete ident.oauthAccount;
    await writeFile(h.paths.claudeJsonPath, JSON.stringify(ident));
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [x!], exclude: [] },
    ];

    const write = vi
      .spyOn(CredentialStore.prototype, 'writeLiveCredentials')
      .mockRejectedValueOnce(new Error('EPERM: operation not permitted'));
    const replaced = await h.engine.importBundle(a!, bundle('A2', 'u-a', NOW + 2 * HOUR)).then(
      () => undefined,
      (e: unknown) => e,
    );
    write.mockRestore();
    // Replacing the stored tokens would leave the main login on the old copy, known as a by
    // nothing any more, so they are kept, and the main login still counts as a.
    expect(replaced).toBeInstanceOf(SwitchEngineError);
    expect((replaced as Error).message).toContain('not replaced');
    expect((await h.vault.readBundle(a!)).claudeAiOauth.refreshToken).toBe('r-A');
    // So the rule's slot, moved off x, is never handed onto a while a's login runs in the main one.
    const res = await h.engine.importRules(specs);
    expect(res.handedOff.map((m) => m.to)).not.toContain(a);
    const r1Live = JSON.parse(
      await readFile(join(groupProfileDir(h.paths.vaultDir, r1.id), '.credentials.json'), 'utf8'),
    ) as { claudeAiOauth: ClaudeOauth };
    expect(r1Live.claudeAiOauth.refreshToken).not.toMatch(/^r-A/);
    const main = JSON.parse(await readFile(h.paths.credentialsPath, 'utf8')) as {
      claudeAiOauth: ClaudeOauth;
    };
    expect(main.claudeAiOauth.refreshToken).toBe('r-A');
  });

  // The new tokens are stored once their blob is written: a failure in the registry write that
  // follows it inside the same store call counts as after, just as one in the step after the call.
  it.each([
    [
      'the step after storing them',
      () =>
        vi
          .spyOn(Vault.prototype, 'clearQuarantine')
          .mockRejectedValueOnce(new VaultError('the registry could not be written')),
    ],
    [
      'the registry write of the store itself',
      () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own this
        const sync = Vault.prototype.syncMetadata;
        let failed = false;
        return vi.spyOn(Vault.prototype, 'syncMetadata').mockImplementation(function (
          this: Vault,
          id: string,
          b: CredentialBundle,
        ) {
          if (failed || b.claudeAiOauth.refreshToken !== 'r-A2') return sync.call(this, id, b);
          failed = true;
          return Promise.reject(new VaultError('the registry could not be written'));
        });
      },
    ],
  ])(
    'keeps the slot running it on the new tokens once they are stored, though %s fails',
    async (_, fail) => {
      const h = await harness();
      const { a, x } = await accounts(h, 'a', 'x');
      await h.engine.activate(a!);
      const r1f = await ruleFolder(h, 'r1');
      const r1 = await h.vault.createRule({ folders: [r1f], include: [a!] });
      await h.engine.activate(x!, { slot: ruleSlotId(r1.id) });
      await runSession(h, r1f, 4242);
      // The main login runs a's token under no identity block, so only that token says it is a.
      const ident = JSON.parse(await readFile(h.paths.claudeJsonPath, 'utf8')) as {
        oauthAccount?: unknown;
      };
      delete ident.oauthAccount;
      await writeFile(h.paths.claudeJsonPath, JSON.stringify(ident));
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(await ruleFolder(h, 'q'))], include: [x!], exclude: [] },
      ];

      const plan = await h.engine.planImportRules(specs);
      // The file's tokens are newer; they are stored, and something after that fails.
      const lift = fail();
      const replaced = await h.engine.importBundle(a!, bundle('A2', 'u-a', NOW + 2 * HOUR)).then(
        () => undefined,
        (e: unknown) => e,
      );
      lift.mockRestore();
      expect(replaced).toBeInstanceOf(SwitchEngineError);
      expect((replaced as SwitchEngineError).code).toBe('import_unfinished');
      expect((await h.vault.readBundle(a!)).claudeAiOauth.refreshToken).toBe('r-A2');
      // The main login runs what is stored, so it is still known as a, and the real run is the plan.
      const main = JSON.parse(await readFile(h.paths.credentialsPath, 'utf8')) as {
        claudeAiOauth: ClaudeOauth;
      };
      expect(main.claudeAiOauth.refreshToken).toBe('r-A2');
      const res = await h.engine.importRules(specs);
      expect(res.plan).toEqual(plan);
      expect((await h.engine.checkSlots()).map((v) => v.kind)).not.toContain(
        'account_in_multiple_slots',
      );
    },
  );

  it('counts as live there when the file teaches this machine the login it runs', async () => {
    const h = await harness();
    const client = await h.engine.addAccount('client', {
      claudeAiOauth: { accessToken: 'C0', refreshToken: 'r-C0', expiresAt: NOW + HOUR },
      oauthAccount: { emailAddress: 'client@x.com' },
    });
    await accounts(h, 'other');
    const p = await ruleFolder(h, 'proj');
    const r = await h.vault.createRule({ folders: [p], include: [client.id], origin: ORIGIN });
    await h.engine.ensureRuleLive(r.id);
    // The rule's slot runs a login no account here is; the main login runs the client's.
    await liveLogin(h, r.id, 'ZED', 'u-zed');
    await liveLogin(h, undefined, 'C-LIVE', 'u-c');
    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(p), folder(await ruleFolder(h, 'proj2'))],
        include: [client.id],
        exclude: [],
        origin: ORIGIN,
      },
    ];

    const plan = await h.engine.planImportRules(specs, {
      logins: [{ id: client.id, accountUuid: 'u-c' }],
    });
    await h.engine.importBundle(client.id, {
      claudeAiOauth: { accessToken: 'C1', refreshToken: 'r-C1', expiresAt: NOW + 3 * HOUR },
      oauthAccount: { accountUuid: 'u-c', emailAddress: 'client@x.com' },
    });
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
  });
});

describe('a seat that cannot be made at run time', () => {
  it('leaves the rule and its running slot so that nothing moves the slot afterwards', async () => {
    for (const spare of [false, true]) {
      const h = await harness();
      const { w, y, v } = await accounts(h, 'w', 'y', 'v');
      const z = await h.engine.addAccount('z', bundle('Z1', 'u-z', NOW - HOUR));
      const t = spare ? (await accounts(h, 't')).t : undefined;
      await h.engine.activate(w!);
      const p = await ruleFolder(h, 'p');
      const r = await h.vault.createRule({ folders: [p], exclude: [v!], origin: ORIGIN });
      const slot = ruleSlotId(r.id);
      await h.engine.activate(y!, { slot });
      await runSession(h, p, 4242);
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(p)], include: [], exclude: [y!], origin: ORIGIN },
      ];
      const plan = await h.engine.planImportRules(specs);
      expect(plan.seats, `spare ${spare}`).toEqual([{ slot, from: y, to: z.id }]);

      failingFor(h, 'r-Z1');
      const res = await h.engine.importRules(specs);
      const now = await h.engine.getActiveId(slot);
      expect(now, `spare ${spare}`).toBe(spare ? t : y);
      expect(res.seated, `spare ${spare}`).toEqual(spare ? [{ slot, from: y, to: t }] : []);
      // What the daemon runs next leaves the slot where the import left it.
      const next = await h.engine.ensureRuleLive(r.id);
      expect(next.liveAccount, `spare ${spare}`).toBe(now);
    }
  });
});

describe('a planned move that fails once the rules are written', () => {
  it('puts back the rule it was for, so the running slot is left on an account its rule allows', async () => {
    const h = await harness();
    const { w, y, v, z } = await accounts(h, 'w', 'y', 'v', 'z');
    await h.engine.activate(w!);
    const p = await ruleFolder(h, 'p');
    const r = await h.vault.createRule({ folders: [p], exclude: [v!], origin: ORIGIN });
    const slot = ruleSlotId(r.id);
    await h.engine.activate(y!, { slot });
    await runSession(h, p, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p)], include: [], exclude: [y!], origin: ORIGIN },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.seats).toEqual([{ slot, from: y, to: z }]);

    // The switch's commit cannot be written, after the rule excluding y already is.
    const commit = vi
      .spyOn(Vault.prototype, 'setRuleActive')
      .mockRejectedValueOnce(new VaultError('the registry could not be written'));
    const res = await h.engine.importRules(specs);
    commit.mockRestore();
    expect(res.outcomes[0]).toMatchObject({ ok: false });
    expect((res.outcomes[0] as { message: string }).message).toContain('"z"');
    expect((await h.engine.getRule(r.id))?.exclude).toEqual([v]);
    expect(res.seated).toEqual([]);
    expect(await h.engine.getActiveId(slot)).toBe(y);
    // What the daemon runs next leaves the slot where the import left it.
    expect((await h.engine.ensureRuleLive(r.id)).liveAccount).toBe(y);
  });

  it('is found out before anything moves when the account it takes runs in a slot it leaves', async () => {
    const h = await harness();
    const { a, b, c, d } = await accounts(h, 'a', 'b', 'c', 'd');
    await h.engine.activate(a!);
    const pf = await ruleFolder(h, 'p');
    const pr = await h.vault.createRule({ folders: [pf], exclude: [c!, d!], origin: ORIGIN });
    await h.engine.activate(b!, { slot: ruleSlotId(pr.id) });
    await runSession(h, pf, 4242);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(pf)], include: [a!], exclude: [], origin: ORIGIN },
      { scopes: [folder(await ruleFolder(h, 'q'))], include: [b!], exclude: [] },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.handOffs).toContainEqual({ slot: 'global', from: a, to: c });
    expect(plan.handOffs).toContainEqual({ slot: ruleSlotId(pr.id), from: b, to: a });

    // Every token is past its end, and a's (live in the main login) will not refresh.
    h.advance(2 * HOUR);
    failingFor(h, 'r-A');
    const violations = (await h.engine.checkSlots()).map((x) => x.kind);
    const res = await h.engine.importRules(specs);
    // a is found unable to go live before anything is written: the rule that needs p's slot to
    // move onto it is refused, and p keeps b, which it may still hold.
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['grow', 'refused']);
    expect(refusalOf(res.plan.rules[1])).toContain('"a"');
    expect(res.handedOff).toEqual([{ slot: 'global', from: a, to: c }]);
    expect(res.outcomes[0]).toMatchObject({ ok: true });
    expect(await h.engine.getActiveId(ruleSlotId(pr.id))).toBe(b);
    expect((await h.engine.checkSlots()).map((x) => x.kind)).toEqual(violations);
  });

  it('that stops the run puts back the rules of the slots it never moved', async () => {
    const h = await harness();
    const { w, y1, y2, v } = await accounts(h, 'w', 'y1', 'y2', 'v', 'z1', 'z2');
    await h.engine.activate(w!);
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const r1 = await h.vault.createRule({ folders: [p1], exclude: [v!], origin: ORIGIN });
    const r2 = await h.vault.createRule({ folders: [p2], exclude: [v!], origin: ORIGIN2 });
    await h.engine.activate(y1!, { slot: ruleSlotId(r1.id) });
    await h.engine.activate(y2!, { slot: ruleSlotId(r2.id) });
    await runSession(h, p1, 4241);
    await runSession(h, p2, 4242);
    // Each rule now excludes the account its running slot is on, so both slots move.
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(p1)], include: [], exclude: [y1!], origin: ORIGIN },
      { scopes: [folder(p2)], include: [], exclude: [y2!], origin: ORIGIN2 },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.seats).toHaveLength(2);

    // The first move switches its slot, and then its bookkeeping cannot be written: the run stops.
    const bookkeeping = vi
      .spyOn(
        SwitchEngine.prototype as unknown as { writeLastSwitchAtMs: () => Promise<void> },
        'writeLastSwitchAtMs',
      )
      .mockRejectedValueOnce(new VaultError('the switch time could not be written'));
    const err = await h.engine.importRules(specs).then(
      () => undefined,
      (e: unknown) => e,
    );
    bookkeeping.mockRestore();
    expect(err).toBeInstanceOf(ImportInterruptedError);
    const stopped = err as ImportInterruptedError;
    const rules = [
      { rule: r1, was: y1!, at: 0 },
      { rule: r2, was: y2!, at: 1 },
    ];
    const moved = rules.filter(({ rule }) =>
      stopped.seated.some((s) => s.slot === ruleSlotId(rule.id)),
    );
    expect(moved).toHaveLength(1);
    for (const { rule, was, at } of rules) {
      const slot = ruleSlotId(rule.id);
      const now = await h.engine.getActiveId(slot);
      if (moved.some((m) => m.rule === rule)) {
        expect((await h.engine.getRule(rule.id))?.exclude).toEqual([v, was]);
      } else {
        // The slot it never moved keeps its account, and the rule that would forbid it is put back.
        expect(now).toBe(was);
        expect((await h.engine.getRule(rule.id))?.exclude).toEqual([v]);
        expect(stopped.outcomes[at]).toMatchObject({ ok: false });
      }
      // What the daemon runs next leaves every running slot where the import left it.
      expect((await h.engine.ensureRuleLive(rule.id)).liveAccount).toBe(now);
    }
  });
});

describe('removing an account handed to another machine', () => {
  it('is refused while sessions run in a folder slot it is live in', async () => {
    const h = await harness();
    const { u, x, z } = await accounts(h, 'u', 'x', 'z');
    await h.engine.activate(u!);
    const p = await ruleFolder(h, 'p');
    const made = await h.engine.includeInFolder(p, [x!, z!]);
    const slot = ruleSlotId(made.rule.id);
    expect(await h.engine.getActiveId(slot)).toBe(x);
    await runSession(h, p, 4242);
    const handed = (await h.vault.readBundle(x!)).claudeAiOauth.refreshToken;

    const err = await h.engine
      .removeAccount(x!, {
        refuseIfGloballyLive: true,
        refuseIfRunning: true,
        expectRefreshToken: handed,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(RefreshError);
    expect((err as Error).message).toContain('running session');
    expect(await h.engine.getActiveId(slot)).toBe(x);
    expect(await h.vault.getAccount(x!)).toBeDefined();
  });
});

describe('a write of the batch that fails after the decision', () => {
  it('makes no move that was only for the rule it could not write', async () => {
    const h = await harness();
    const { x, y } = await accounts(h, 'x', 'y');
    await h.engine.activate(x!);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [x!], exclude: [] },
    ];
    const plan = await h.engine.planImportRules(specs);
    expect(plan.handOffs).toEqual([{ slot: 'global', from: x, to: y }]);

    // Something changed the registry under the import: its one write is refused.
    const write = vi
      .spyOn(Vault.prototype, 'createRule')
      .mockRejectedValueOnce(new VaultError('the registry changed under the import'));
    const res = await h.engine.importRules(specs);
    write.mockRestore();
    expect(res.outcomes[0]).toMatchObject({ ok: false });
    expect(res.handedOff).toEqual([]);
    expect(await h.engine.getActiveId('global')).toBe(x);
  });
});

describe('two slots that trade accounts', () => {
  it('trades them through the one that may stand empty for a moment', async () => {
    const h = await harness();
    const { a0, a1, a2, a3 } = await accounts(h, 'a0', 'a1', 'a2', 'a3');
    await h.engine.activate(a0!);
    const pf = await ruleFolder(h, 'p');
    const qf = await ruleFolder(h, 'q');
    const p = await h.vault.createRule({ folders: [pf], exclude: [a2!], origin: ORIGIN });
    const q = await h.vault.createRule({ folders: [qf], exclude: [a1!], origin: ORIGIN2 });
    await h.engine.activate(a1!, { slot: ruleSlotId(p.id) });
    await h.engine.activate(a3!, { slot: ruleSlotId(q.id) });
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(pf)], include: [a3!, a0!], exclude: [a1!], origin: ORIGIN },
      { scopes: [folder(qf)], include: [a3!, a2!], exclude: [], origin: ORIGIN2 },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow', 'grow']);
    expect(plan.handOffs).toEqual([{ slot: 'global', from: a0, to: a1 }]);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(p.id), from: a1, to: a0 }]);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.handedOff).toEqual(plan.handOffs);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId('global')).toBe(a1);
    expect(await h.engine.getActiveId(ruleSlotId(p.id))).toBe(a0);
    const again = await h.engine.planImportRules(specs);
    expect(again.rules.map((v) => v.kind)).toEqual(['unchanged', 'unchanged']);
  });

  it('are given other accounts that free each in turn when neither may stand empty', async () => {
    const h = await harness();
    const { g, a0, a3, a5 } = await accounts(h, 'g', 'a0', 'a3', 'a5');
    await h.engine.activate(g!);
    const pf = await ruleFolder(h, 'p');
    const qf = await ruleFolder(h, 'q');
    const p = await h.vault.createRule({ folders: [pf], exclude: [g!], origin: ORIGIN });
    const q = await h.vault.createRule({ folders: [qf], exclude: [g!], origin: ORIGIN2 });
    await h.engine.activate(a0!, { slot: ruleSlotId(p.id) });
    await h.engine.activate(a3!, { slot: ruleSlotId(q.id) });
    await runSession(h, pf, 4241);
    await runSession(h, qf, 4242);
    // p must move onto a3, so q must move off it: the first account q could take is the a0 p
    // leaves, a trade no order makes with sessions in both, but q can take a5 instead.
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(pf)], include: [a3!], exclude: [a0!], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['grow']);
    expect(plan.handOffs).toEqual([{ slot: ruleSlotId(q.id), from: a3, to: a5 }]);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(p.id), from: a0, to: a3 }]);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.getActiveId(ruleSlotId(p.id))).toBe(a3);
    expect(await h.engine.getActiveId(ruleSlotId(q.id))).toBe(a5);
  });
});

describe('a rule slot the batch both empties and takes the account of', () => {
  it('is left empty when no session runs there, so the rule reserving its account lands', async () => {
    const h = await harness();
    const { a0, a1, a2 } = await accounts(h, 'a0', 'a1', 'a2');
    await h.engine.activate(a0!);
    const rf = await ruleFolder(h, 'r');
    const r = await h.vault.createRule({ folders: [rf], exclude: [a0!], origin: ORIGIN });
    await h.engine.activate(a1!, { slot: ruleSlotId(r.id) });
    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(await ruleFolder(h, 'n'))],
        include: [a1!, a0!],
        exclude: [a2!],
        origin: ORIGIN2,
      },
      { scopes: [folder(rf)], include: [], exclude: [a1!, a2!], origin: ORIGIN },
    ];

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules.map((v) => v.kind)).toEqual(['create', 'grow']);
    expect(plan.handOffs).toEqual([{ slot: 'global', from: a0, to: a2 }]);
    expect(plan.seats).toEqual([{ slot: ruleSlotId(r.id), from: a1, to: null }]);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(res.seated).toEqual(plan.seats);
    expect(await h.engine.getActiveId(ruleSlotId(r.id))).toBeNull();

    // With a session running there it may not be emptied: the rule reserving its account is the one
    // refused instead.
    const h2 = await harness();
    const ids = await accounts(h2, 'a0', 'a1', 'a2');
    await h2.engine.activate(ids.a0!);
    const rf2 = await ruleFolder(h2, 'r');
    const r2 = await h2.vault.createRule({ folders: [rf2], exclude: [ids.a0!], origin: ORIGIN });
    await h2.engine.activate(ids.a1!, { slot: ruleSlotId(r2.id) });
    await runSession(h2, rf2, 4242);
    const plan2 = await h2.engine.planImportRules([
      {
        scopes: [folder(await ruleFolder(h2, 'n'))],
        include: [ids.a1!, ids.a0!],
        exclude: [ids.a2!],
        origin: ORIGIN2,
      },
      { scopes: [folder(rf2)], include: [], exclude: [ids.a1!, ids.a2!], origin: ORIGIN },
    ]);
    expect(plan2.rules.map((v) => v.kind)).toEqual(['refused', 'refused']);
  });
});
