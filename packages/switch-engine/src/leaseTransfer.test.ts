// Moving accounts between machines while a parallel session runs here: an import never seats, moves
// or clears a parallel session's slot, never puts its account live in a second slot, never counts
// the session as a rule of its own, and leaves its rule, holders and schema version as they were,
// in its dry run as in its real run, and when a claim lands between two of its holds of the lock.
// The engine side of an export never removes an account a session runs on.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault, MAX_RULES } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { leaseRuleId } from './folderRules.js';
import { SlotError } from './errors.js';
import { ruleSlotId } from './types.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  ImportRuleSpec,
  LeaseHolder,
  RuleScopeRef,
} from './types.js';

// What runs in the gap between two holds of the lock an import makes: a claim of a parallel
// session, as another terminal's `cctl claude --account` would make it there.
const gap = vi.hoisted(() => ({ next: undefined as undefined | (() => Promise<void>) }));
vi.mock('./lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lock.js')>();
  return {
    ...real,
    yieldLock: async (lockDir: string): Promise<void> => {
      const run = gap.next;
      gap.next = undefined;
      if (run !== undefined) await run();
      return real.yieldLock(lockDir);
    },
  };
});

// Real switches and seats through the lock and the files; a loaded machine runs these past the
// suite's default.
vi.setConfig({ testTimeout: 120_000 });

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;
const HOST = 'BOX';
/** Parallel sessions exist on these two; the platform the engine and its holders are recorded as. */
const PLATFORM: 'win32' | 'linux' = process.platform === 'win32' ? 'win32' : 'linux';

let dirs: string[] = [];
afterEach(async () => {
  gap.next = undefined;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
}

/** An engine over a sandbox, whose process seams say every recorded holder still runs. */
async function harness(): Promise<Harness> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'ce-lease-xfer-')));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const engine = new SwitchEngine({
    paths,
    protector,
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) =>
      Promise.resolve({ ...cur, accessToken: 'net-' + cur.accessToken, expiresAt: NOW + HOUR }),
    clock: () => NOW,
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 4000, pollMs: 10 },
    platform: PLATFORM,
    leaseProcesses: {
      hostname: () => HOST,
      isAlive: () => true,
      // Readable, and running nothing on any profile, so the last terminal out can end its session.
      processTable: () => Promise.resolve([{ pid: 1, ppid: 0, startMs: NOW }]),
      processConfigDirs: () => Promise.resolve(new Map()),
      procFs: {
        stat: () => undefined,
        bootId: () => undefined,
        pidNs: () => undefined,
        configDirOf: () => undefined,
        pids: () => [],
      },
      self: { pid: 1, start: NOW },
    },
  });
  return { root, paths, engine, vault: new Vault(paths.vaultDir, protector, () => NOW) };
}

function bundleFor(name: string, expiresAt = NOW + 10 * HOUR): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: name, refreshToken: 'r-' + name, expiresAt },
    oauthAccount: { accountUuid: 'uuid-' + name, emailAddress: name + '@x.com' },
  };
}

/** A `cctl claude --account` launcher in another terminal. */
function launcher(pid: number): LeaseHolder {
  return { pid, start: NOW + pid, host: HOST, platform: PLATFORM, role: 'launcher' };
}

/** A real folder in the sandbox, for a rule. */
async function ruleFolder(h: Harness, name: string): Promise<string> {
  const dir = join(h.root, 'work', name);
  await mkdir(dir, { recursive: true });
  return realpathSync.native(dir);
}

const folder = (f: string): RuleScopeRef => ({ kind: 'folder', folder: f });

/** The live files of an account's parallel-session slot. */
function leaseStore(paths: Paths, accountId: string): CredentialStore {
  const dir = groupProfileDir(paths.vaultDir, leaseRuleId(accountId));
  return new CredentialStore({
    claudeDir: dir,
    credentialsPath: join(dir, '.credentials.json'),
    claudeJsonPath: join(dir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** Start a parallel session on `accountId` from another terminal, as `cctl claude --account` does. */
async function claim(h: Harness, accountId: string, pid = 4120): Promise<void> {
  const res = await h.engine.claimSessionSlot(accountId, launcher(pid), { launchRuleId: null });
  expect(res.kind).toBe('lease');
}

/** groups.json as on disk. */
async function rulesFile(h: Harness): Promise<{ schemaVersion: number; rules: unknown[] }> {
  return JSON.parse(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')) as {
    schemaVersion: number;
    rules: unknown[];
  };
}

/** The parallel session of `accountId` is as it was claimed: its rule, its one holder, its account
 *  live in its slot and in no other, and the file still at the schema a parallel session needs. */
async function sessionIntact(h: Harness, accountId: string, pid = 4120): Promise<void> {
  const rule = (await h.engine.listRules()).find((r) => r.id === leaseRuleId(accountId));
  expect(rule?.lease?.holders).toEqual([launcher(pid)]);
  expect(rule?.include).toEqual([accountId]);
  expect(await h.engine.getActiveId(ruleSlotId(leaseRuleId(accountId)))).toBe(accountId);
  const elsewhere = [...(await h.engine.liveSlots())].filter(
    ([slot, id]) => id === accountId && slot !== ruleSlotId(leaseRuleId(accountId)),
  );
  expect(elsewhere).toEqual([]);
  expect((await rulesFile(h)).schemaVersion).toBe(4);
  expect(await h.engine.checkSlots()).toEqual([]);
}

describe.skipIf(process.platform === 'darwin')('an import while a parallel session runs', () => {
  it('agrees with its dry run, leaves the session whole, and reports an exclusion it cannot make yet', async () => {
    const h = await harness();
    const g = await h.engine.addAccount('g', bundleFor('G'));
    const x = await h.engine.addAccount('x', bundleFor('X'));
    const y = await h.engine.addAccount('y', bundleFor('Y'));
    await h.engine.activate(g.id, { force: true });
    await claim(h, x.id);
    const specs: ImportRuleSpec[] = [
      // A rule reserving the account the session runs on: it may not go live there meanwhile.
      { scopes: [folder(await ruleFolder(h, 'p1'))], include: [x.id], exclude: [] },
      // A rule excluding it: only a shared account can be excluded, and it is shared again only
      // once the session ends.
      { scopes: [folder(await ruleFolder(h, 'p2'))], include: [], exclude: [x.id] },
      // A rule that excludes it beside one it can.
      { scopes: [folder(await ruleFolder(h, 'p3'))], include: [], exclude: [x.id, y.id] },
    ];

    const plan = await h.engine.planImportRules(specs);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(plan.rules.map((v) => v.kind)).toEqual(['create', 'unchanged', 'create']);
    const unchanged = plan.rules[1]!;
    expect(unchanged.kind === 'unchanged' && unchanged.reason).toContain('a parallel session');
    expect(unchanged.kind === 'unchanged' && unchanged.leftOut).toEqual([
      { id: x.id, why: 'leased-here' },
    ]);
    const grown = plan.rules[2]!;
    expect(grown.kind === 'create' && grown.leftOut).toEqual([{ id: x.id, why: 'leased-here' }]);
    expect(res.outcomes.map((o) => o?.ok)).toEqual([true, undefined, true]);

    // Two rules made beside the session; the one reserving x is not on x.
    const rules = await h.engine.listRules();
    expect(rules).toHaveLength(3);
    const p1 = rules.find((r) => r.include.includes(x.id) && r.lease === undefined)!;
    expect(await h.engine.getActiveId(ruleSlotId(p1.id))).not.toBe(x.id);
    expect(res.seated.concat(res.handedOff).some((s) => s.to === x.id)).toBe(false);
    await sessionIntact(h, x.id);
  });

  it('counts a parallel session against the rule cap as the vault does, in its dry run and its real run', async () => {
    const h = await harness();
    const g = await h.engine.addAccount('g', bundleFor('G'));
    const x = await h.engine.addAccount('x', bundleFor('X'));
    await h.engine.activate(g.id, { force: true });
    for (let i = 0; i < MAX_RULES - 1; i += 1) {
      const m = await h.vault.addAccount(`m${i}`, bundleFor(`M${i}`));
      await h.vault.createRule({ folders: [], include: [m.id] });
    }
    await claim(h, x.id);
    const specs: ImportRuleSpec[] = [
      { scopes: [folder(await ruleFolder(h, 'p'))], include: [], exclude: [g.id] },
    ];
    const cap = `cannot create another folder rule (max ${MAX_RULES})`;

    const plan = await h.engine.planImportRules(specs);
    expect(plan.rules[0]).toMatchObject({ kind: 'refused', message: cap });
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    expect(await h.engine.listRules()).toHaveLength(MAX_RULES);
    await sessionIntact(h, x.id);
  });

  it('does not grow the session into a rule of the file, whatever identity the file names', async () => {
    const h = await harness();
    const g = await h.engine.addAccount('g', bundleFor('G'));
    const x = await h.engine.addAccount('x', bundleFor('X'));
    await h.engine.activate(g.id, { force: true });
    await claim(h, x.id);
    const specs: ImportRuleSpec[] = [
      {
        scopes: [folder(await ruleFolder(h, 'p'))],
        include: [],
        exclude: [g.id],
        origin: leaseRuleId(x.id),
      },
    ];
    const plan = await h.engine.planImportRules(specs);
    const res = await h.engine.importRules(specs);
    expect(res.plan).toEqual(plan);
    // Not the session's rule grown with the file's folder: a rule of its own, which no rule may be
    // known by an identity that is not a rule id.
    expect(plan.rules[0]).toMatchObject({
      kind: 'refused',
      message: 'a rule origin must be a rule id',
    });
    expect((await h.engine.listRules()).map((r) => r.id)).toEqual([leaseRuleId(x.id)]);
    await sessionIntact(h, x.id);
  });

  it('writes newer tokens of the account a session runs on into its slot, as a re-login would, and nothing else', async () => {
    const h = await harness();
    const g = await h.engine.addAccount('g', bundleFor('G'));
    const x = await h.engine.addAccount('x', bundleFor('X'));
    await h.engine.activate(g.id, { force: true });
    await claim(h, x.id);

    // A later grant of the same login, from the other machine.
    const later = bundleFor('X', NOW + 20 * HOUR);
    later.claudeAiOauth = { ...later.claudeAiOauth, accessToken: 'X2', refreshToken: 'r-X2' };
    const res = await h.engine.importBundle(x.id, later);
    expect(res).toMatchObject({ replaced: true, reason: 'newer' });
    expect((await leaseStore(h.paths, x.id).readLiveCredentials())?.accessToken).toBe('X2');
    expect((await h.vault.readBundle(x.id)).claudeAiOauth.accessToken).toBe('X2');
    expect(await h.engine.getActiveId('global')).toBe(g.id);
    await sessionIntact(h, x.id);
  });
});

describe.skipIf(process.platform === 'darwin')(
  'a parallel session claimed between two holds of an import',
  () => {
    it('keeps its account out of the slot the import then seats', async () => {
      const h = await harness();
      const g = await h.engine.addAccount('g', bundleFor('G'));
      const x = await h.engine.addAccount('x', bundleFor('X'));
      const y = await h.engine.addAccount('y', bundleFor('Y'));
      await h.engine.activate(g.id, { force: true });
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(await ruleFolder(h, 'p'))], include: [x.id], exclude: [] },
      ];
      // Without the session, the new rule's slot is seated with x, the account it reserves.
      const plan = await h.engine.planImportRules(specs);
      expect(plan.rules[0]?.kind).toBe('create');

      // x is reserved to the rule by the batch and live in none of its slots: a launch on it in the
      // gap before the seat gets a parallel session.
      gap.next = () => claim(h, x.id);
      const res = await h.engine.importRules(specs);
      expect(gap.next).toBeUndefined();
      expect(res.outcomes[0]?.ok).toBe(true);
      const rule = (await h.engine.listRules()).find((r) => r.lease === undefined)!;
      // The seat went by the slots as they stood then: x is the session's, so the slot takes y.
      expect(await h.engine.getActiveId(ruleSlotId(rule.id))).toBe(y.id);
      expect(res.seated.some((s) => s.to === x.id)).toBe(false);
      await sessionIntact(h, x.id);
    });

    it('fails the move onto its account and puts the rule that needed the move back', async () => {
      const h = await harness();
      const g = await h.engine.addAccount('g', bundleFor('G'));
      const y = await h.engine.addAccount('y', bundleFor('Y'));
      await h.engine.activate(g.id, { force: true });
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(await ruleFolder(h, 'p'))], include: [g.id], exclude: [] },
      ];
      // The plan moves the global slot off g, which the rule reserves, onto y.
      const plan = await h.engine.planImportRules(specs);
      expect(plan.rules[0]?.kind).toBe('create');

      // y, live nowhere, gets a parallel session in the gap before that move.
      gap.next = () => claim(h, y.id);
      const res = await h.engine.importRules(specs);
      expect(gap.next).toBeUndefined();
      expect(res.outcomes[0]?.ok).toBe(false);
      expect(res.handedOff).toEqual([]);
      // Nothing moved: g stays on the main login, the rule no longer reserves it, and y runs only in
      // its session.
      expect(await h.engine.getActiveId('global')).toBe(g.id);
      expect((await h.engine.listRules()).some((r) => r.include.includes(g.id))).toBe(false);
      await sessionIntact(h, y.id);
    });
  },
);

describe.skipIf(process.platform === 'darwin')(
  'removing an account handed to another machine',
  () => {
    it('is refused while a parallel session runs on it, before anything is touched', async () => {
      const h = await harness();
      const g = await h.engine.addAccount('g', bundleFor('G'));
      const x = await h.engine.addAccount('x', bundleFor('X'));
      await h.engine.activate(g.id, { force: true });
      await claim(h, x.id);
      const err = await h.engine
        .removeAccount(x.id, {
          refuseIfGloballyLive: true,
          refuseIfRunning: true,
          expectRefreshToken: 'r-X',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SlotError);
      expect((err as SlotError).code).toBe('leased');
      expect((await h.engine.listAllAccounts()).map((a) => a.label).sort()).toEqual(['g', 'x']);
      await sessionIntact(h, x.id);
    });
  },
);

describe.skipIf(process.platform === 'darwin')(
  'another stored account logged in inside a parallel session',
  () => {
    /** g live in the global slot, a parallel session on x, and inside it a /login as y: y's newer
     *  login now sits in x's slot. */
    async function loggedInInside(h: Harness): Promise<{ x: string; y: string }> {
      const g = await h.engine.addAccount('g', bundleFor('G'));
      const x = await h.engine.addAccount('x', bundleFor('X'));
      const y = await h.engine.addAccount('y', bundleFor('Y'));
      await h.engine.activate(g.id, { force: true });
      await claim(h, x.id);
      const store = leaseStore(h.paths, x.id);
      await store.writeLiveCredentials({
        accessToken: 'Y2',
        refreshToken: 'r-Y2',
        expiresAt: NOW + 20 * HOUR,
      });
      await store.writeOauthAccount(bundleFor('Y').oauthAccount!);
      return { x: x.id, y: y.id };
    }

    /** y's login is still the one in x's slot, y is live in no other slot, and x's session keeps
     *  its rule and holder. */
    async function stillInSession(h: Harness, x: string, y: string): Promise<void> {
      const slot = ruleSlotId(leaseRuleId(x));
      expect((await leaseStore(h.paths, x).readLiveCredentials())?.refreshToken).toBe('r-Y2');
      const liveIn = [...(await h.engine.liveSlots())].filter(([, id]) => id === y);
      expect(liveIn.map(([s]) => s)).toEqual([slot]);
      const rule = (await h.engine.listRules()).find((r) => r.id === leaseRuleId(x));
      expect(rule?.lease?.holders).toEqual([launcher(4120)]);
      expect(rule?.include).toEqual([x]);
    }

    const handOffs: Array<
      [string, (h: Harness, y: string, dir: string) => Promise<Array<{ slot: string }>>]
    > = [
      [
        'an import',
        async (h, y, dir) => {
          const specs: ImportRuleSpec[] = [{ scopes: [folder(dir)], include: [y], exclude: [] }];
          const plan = await h.engine.planImportRules(specs);
          const res = await h.engine.importRules(specs);
          expect(res.plan).toEqual(plan);
          expect(res.outcomes[0]?.ok).toBe(true);
          return [...plan.handOffs, ...plan.seats, ...res.handedOff, ...res.seated];
        },
      ],
      [
        'a folder include',
        async (h, y, dir) => (await h.engine.includeInFolder(dir, [y])).handedOff,
      ],
      [
        'a session include',
        async (h, y, dir) => (await h.engine.includeInAlias(dir, 'job', [y])).handedOff,
      ],
    ];

    it.each(handOffs)(
      '%s reserving it never moves that slot, and it is live in one slot only until the session ends',
      async (_name, reserve) => {
        const h = await harness();
        const { x, y } = await loggedInInside(h);
        const moved = await reserve(h, y, await ruleFolder(h, 'p'));
        expect(moved.map((m) => m.slot)).not.toContain(ruleSlotId(leaseRuleId(x)));
        await stillInSession(h, x, y);
        const rule = (await h.engine.listRules()).find((r) => r.lease === undefined)!;
        expect(rule.include).toEqual([y]);
        // Neither the daemon's repair nor seating the new rule takes y while the session holds it.
        await h.engine.repairSlots();
        await h.engine.ensureRuleLive(rule.id);
        await stillInSession(h, x, y);

        // The session ends: y's login is saved with y, and only then does the rule's slot take it.
        const released = await h.engine.releaseLease(leaseRuleId(x), [launcher(4120)], () =>
          Promise.resolve([]),
        );
        expect(released).toMatchObject({ ended: true });
        expect((await h.vault.readBundle(y)).claudeAiOauth.refreshToken).toBe('r-Y2');
        await h.engine.ensureRuleLive(rule.id);
        const liveIn = [...(await h.engine.liveSlots())].filter(([, id]) => id === y);
        expect(liveIn.map(([s]) => s)).toEqual([ruleSlotId(rule.id)]);
      },
    );

    it('a removal of it for another machine is refused while the session has only its launcher', async () => {
      const h = await harness();
      const { x, y } = await loggedInInside(h);
      // The launcher has not recorded its Claude Code yet: the session is starting, not over.
      const err = await h.engine
        .removeAccount(y, { refuseIfGloballyLive: true, refuseIfRunning: true })
        .catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('sessions_running');
      expect((await h.engine.listAllAccounts()).map((a) => a.label).sort()).toEqual([
        'g',
        'x',
        'y',
      ]);
      await stillInSession(h, x, y);
    });
  },
);
