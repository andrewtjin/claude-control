// Parallel sessions in the engine: where `--account` runs (plan and claim agreeing on every row),
// creating and joining a session, its crash points, the release, the sweep, and everything else the
// engine must never do to a session's slot while it runs.
//
// Processes are stand-ins: a set of live pids, an injected Windows process table, a fixture /proc.
// The fault seam stands for the process dying at a checkpoint.

import { describe, it, expect, afterEach } from 'vitest';
import { realpathSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { sandboxPaths, groupProfileDir, type Paths } from './paths.js';
import { leaseOccupants, leaseRuleId, occupantsPhrase } from './folderRules.js';
import { ruleSlotId } from './types.js';
import { LeaseHolderCapError, QuarantineError, SlotError } from './errors.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  LeaseHolder,
  LeaseOccupancyProbe,
  ProcessRow,
  ProcFs,
  StoredAccount,
} from './types.js';

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;
const HOST = 'BOX';
/** A Windows project folder the harness's engine sees as a directory, so a folder rule can be made
 *  wherever the tests run (a win32 engine cannot check a real folder of another platform). */
const FOLDER = 'C:\\work\\lease';

/** The real folder checks, with {@link FOLDER} standing as an existing directory. */
const bindFs: BindFs = {
  realpath: (p) => (p === FOLDER ? p : realpathSync.native(p)),
  isDirectory: (p) => {
    if (p === FOLDER) return true;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  cwd: () => process.cwd(),
  homedir: () => homedir(),
};

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  global: CredentialStore;
  /** Live pids; anything else is gone (ESRCH). */
  alive: Set<number>;
  table: ProcessRow[];
  /** How many times the engine read the process table. */
  tableReads: { count: number };
  /** The CLAUDE_CONFIG_DIR each stand-in process was started with (null: unset). A pid not here
   *  could not be read, as another user's process. */
  env: Map<number, string | null>;
  faults: { at?: string | undefined };
  refreshed: string[];
  build: (platform?: NodeJS.Platform, procFs?: ProcFs) => SwitchEngine;
}

/** An engine over a sandbox, with this process standing in as pid 1 started at NOW. */
async function harness(platform: NodeJS.Platform = 'win32', procFs?: ProcFs): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-lease-eng-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const alive = new Set<number>([1]);
  const table: ProcessRow[] = [];
  const tableReads = { count: 0 };
  const env = new Map<number, string | null>();
  const faults: { at?: string | undefined } = {};
  const refreshed: string[] = [];
  const build = (p: NodeJS.Platform = platform, fs: ProcFs | undefined = procFs): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh: (cur: ClaudeOauth) => {
        refreshed.push(cur.accessToken);
        return Promise.resolve({
          ...cur,
          accessToken: 'net-' + cur.accessToken,
          expiresAt: NOW + HOUR,
        });
      },
      clock: () => NOW,
      refreshSkewMs: 5 * 60_000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 4000, pollMs: 10 },
      platform: p,
      bindFs,
      faultAt: (checkpoint) => {
        if (faults.at === checkpoint) {
          faults.at = undefined;
          throw new Error(`died at ${checkpoint}`);
        }
      },
      leaseProcesses: {
        hostname: () => HOST,
        isAlive: (pid) => alive.has(pid),
        processTable: () => {
          tableReads.count++;
          return Promise.resolve(table);
        },
        processConfigDirs: (pids) =>
          Promise.resolve(new Map(pids.filter((p) => env.has(p)).map((p) => [p, env.get(p)!]))),
        ...(fs !== undefined ? { procFs: fs } : {}),
        self: { pid: 1, start: NOW },
      },
    });
  return {
    paths,
    engine: build(),
    vault: new Vault(paths.vaultDir, protector, () => NOW, undefined, platform),
    global: new CredentialStore(paths),
    alive,
    table,
    tableReads,
    env,
    faults,
    refreshed,
    build,
  };
}

function bundleFor(name: string): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: name, refreshToken: 'r-' + name, expiresAt: NOW + 10 * HOUR },
    oauthAccount: { accountUuid: 'uuid-' + name, emailAddress: name + '@x.com' },
  };
}

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

/** A Windows launcher holder for pid `pid` (alive by default). */
function launcher(h: Harness, pid: number, start = NOW + pid, live = true): LeaseHolder {
  if (live) h.alive.add(pid);
  // A launcher is cctl under node: never a Claude Code, whatever runs on the profile.
  h.table.push({
    pid,
    ppid: 1,
    startMs: start,
    name: 'node.exe',
    commandLine: 'node C:/npm/node_modules/@andrewtjin/cctl/dist/bin.js claude --account B',
  });
  return { pid, start, host: HOST, platform: 'win32', role: 'launcher' };
}

/** A Windows Claude Code child of `parent`. */
function child(
  h: Harness,
  pid: number,
  parent: number,
  start = NOW + pid,
  live = true,
): LeaseHolder {
  if (live) h.alive.add(pid);
  h.table.push({ pid, ppid: parent, startMs: start });
  return { pid, start, host: HOST, platform: 'win32', role: 'claude', parent };
}

const noWorkers: LeaseOccupancyProbe = () => Promise.resolve([]);

/** Shared accounts A (live in the global slot), B and C. */
async function seed(h: Harness): Promise<{ A: StoredAccount; B: StoredAccount; C: StoredAccount }> {
  const A = await h.engine.addAccount('A', bundleFor('A'));
  const B = await h.engine.addAccount('B', bundleFor('B'));
  const C = await h.engine.addAccount('C', bundleFor('C'));
  await h.engine.activate(A.id, { force: true });
  return { A, B, C };
}

/** The groups.json on disk, parsed, or undefined. */
async function rulesOnDisk(h: Harness): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/** Every lease on disk has at least one holder, and the file loads. */
async function fileLoadsWithHolders(h: Harness): Promise<void> {
  const rules = await h.vault.listRules();
  for (const r of rules) {
    if (r.lease !== undefined) expect(r.lease.holders.length).toBeGreaterThan(0);
  }
}

describe('planSessionSlot: where --account runs', () => {
  it('R1: live in the global slot is the global slot; it overrides only a rule that refuses it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    expect(await h.engine.planSessionSlot(A.id, { launchRuleId: null })).toEqual({
      kind: 'global',
      overrides: false,
    });
    const accepts = await h.vault.createRule({ folders: ['C:\\ok'], exclude: [B.id] });
    expect(await h.engine.planSessionSlot(A.id, { launchRuleId: accepts.id })).toEqual({
      kind: 'global',
      overrides: false,
    });
    const refuses = await h.vault.createRule({ folders: ['C:\\no'], exclude: [A.id] });
    expect(await h.engine.planSessionSlot(A.id, { launchRuleId: refuses.id })).toEqual({
      kind: 'global',
      overrides: true,
    });
  });

  it("R2: live in this launch's rule slot, or reserved and live in a rule including it", async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const rule = await h.vault.createRule({ folders: ['C:\\repo'], include: [C.id] });
    await h.engine.activate(C.id, { force: true, slot: ruleSlotId(rule.id) });
    // C is reserved to the rule and live there: from anywhere, that slot.
    expect(await h.engine.planSessionSlot(C.id, { launchRuleId: null })).toEqual({
      kind: 'rule',
      ruleId: rule.id,
    });
    // B shared, live in this launch's rule slot (the rule's fallback).
    const fallback = await h.vault.createRule({ folders: ['C:\\fb'], exclude: [A.id] });
    await h.engine.activate(B.id, { force: true, slot: ruleSlotId(fallback.id) });
    expect(await h.engine.planSessionSlot(B.id, { launchRuleId: fallback.id })).toEqual({
      kind: 'rule',
      ruleId: fallback.id,
    });
  });

  it("R2x: a shared account live in another rule's slot is refused", async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const fallback = await h.vault.createRule({ folders: ['C:\\fb'], exclude: [A.id] });
    await h.engine.activate(B.id, { force: true, slot: ruleSlotId(fallback.id) });
    const plan = await h.engine.planSessionSlot(B.id, { launchRuleId: null });
    expect(plan).toMatchObject({ kind: 'refused', code: 'live_in_other_rule' });
    expect(plan.kind === 'refused' && plan.message).toContain(
      'is a shared account live in the folder slot of C:\\fb',
    );
  });

  it('R4 and R5: a shared account live nowhere, or a reserved one live in none of its rules, gets a new parallel session', async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    await h.vault.createRule({ folders: ['C:\\x'], include: [C.id] });
    for (const id of [B.id, C.id]) {
      expect(await h.engine.planSessionSlot(id, { launchRuleId: null })).toEqual({
        kind: 'lease',
        ruleId: leaseRuleId(id),
        profileDir: groupProfileDir(h.paths.vaultDir, leaseRuleId(id)),
        join: false,
      });
    }
  });

  it('R6: a quarantined account live nowhere is refused', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.vault.quarantine(B.id, 'invalid_grant');
    expect(await h.engine.planSessionSlot(B.id, { launchRuleId: null })).toMatchObject({
      kind: 'refused',
      code: 'quarantined',
      message: 'B is quarantined (invalid_grant); log in again with: cctl accounts relogin B',
    });
  });

  it('R7: live in two slots is refused before anything else', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const rule = await h.vault.createRule({ folders: ['C:\\fb'], exclude: [B.id] });
    // A's login copied into the rule profile by hand: one account live twice.
    const profile = groupProfileDir(h.paths.vaultDir, rule.id);
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, '.credentials.json'), await readFile(h.paths.credentialsPath));
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: bundleFor('A').oauthAccount }),
    );
    const plan = await h.engine.planSessionSlot(A.id, { launchRuleId: null });
    expect(plan).toMatchObject({ kind: 'refused', code: 'live_twice' });
  });

  it('R8: every parallel-session row is refused on macOS; the global row still works', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const mac = h.build('darwin');
    expect(await mac.planSessionSlot(B.id, { launchRuleId: null })).toMatchObject({
      kind: 'refused',
      code: 'session_slot_unsupported',
    });
    expect(await mac.planSessionSlot(A.id, { launchRuleId: null })).toEqual({
      kind: 'global',
      overrides: false,
    });
  });

  it('R9: an unknown account is refused by id', async () => {
    const h = await harness();
    await seed(h);
    await expect(h.engine.planSessionSlot('nope', { launchRuleId: null })).rejects.toThrow(
      'no account with id "nope"',
    );
  });
});

describe('claimSessionSlot', () => {
  it('creates a parallel session: reserved, seated, schema 4, snapshot kind lease', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    const claim = await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    expect(claim).toMatchObject({
      kind: 'lease',
      ruleId: leaseRuleId(B.id),
      joined: false,
      holders: 1,
    });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
    expect(await h.engine.getActiveId(ruleSlotId(leaseRuleId(B.id)))).toBe(B.id);
    expect((await rulesOnDisk(h))?.schemaVersion).toBe(4);
    expect((await h.engine.listAccounts()).map((a) => a.id)).not.toContain(B.id);
    const snapshot = await h.engine.readSnapshot();
    expect(snapshot?.groups.find((g) => g.id === leaseRuleId(B.id))?.kind).toBe('lease');
    // The global slot never moved.
    expect((await h.global.readLiveCredentials())?.accessToken).toBe('A');
  });

  it('joins: one rule, two holders, the count of other terminals', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const second = await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    expect(second).toMatchObject({ kind: 'lease', joined: true, holders: 2, otherTerminals: 1 });
    expect((await h.vault.listRules()).filter((r) => r.lease !== undefined)).toHaveLength(1);
  });

  it('re-decides under the lock: an account that went live in the global slot claims nothing', async () => {
    const h = await harness();
    const { B } = await seed(h);
    expect((await h.engine.planSessionSlot(B.id, { launchRuleId: null })).kind).toBe('lease');
    await h.engine.activate(B.id, { force: true });
    expect(
      await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null }),
    ).toEqual({
      kind: 'global',
    });
    expect(await rulesOnDisk(h)).toBeUndefined();
  });

  it('rolls back a seat that fails: rule gone, no credentials, the account shared at its index', async () => {
    const h = await harness();
    const { B } = await seed(h);
    // B's stored token is also stored under another account, so seating it is refused.
    const twin = await h.engine.addAccount('twin', {
      claudeAiOauth: bundleFor('B').claudeAiOauth,
    });
    void twin;
    await expect(
      h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null }),
    ).rejects.toThrow();
    expect((await h.vault.listRules()).length).toBe(0);
    expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
    expect((await h.engine.listAccounts()).map((a) => a.label)).toEqual(['A', 'B', 'C', 'twin']);
  });

  it("a join from a reused pid replaces that pid's old record, and the file still loads", async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120, NOW + 1), { launchRuleId: null });
    // The same pid again, a later process: its old record is provably dead.
    const again: LeaseHolder = {
      pid: 4120,
      start: NOW + 99_000,
      host: HOST,
      platform: 'win32',
      role: 'launcher',
    };
    const claim = await h.engine.claimSessionSlot(B.id, again, { launchRuleId: null });
    expect(claim).toMatchObject({ kind: 'lease', holders: 1, otherTerminals: 0 });
    const rule = (await h.vault.listRules())[0]!;
    expect(rule.lease?.holders).toEqual([again]);
  });

  it('a join past the holder cap is refused and writes nothing', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 1000), { launchRuleId: null });
    const ruleId = leaseRuleId(B.id);
    await h.engine.addLeaseHolders(
      ruleId,
      Array.from({ length: 31 }, (_, i) => launcher(h, 2000 + i)),
    );
    const before = await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8');
    await expect(
      h.engine.claimSessionSlot(B.id, launcher(h, 9999), { launchRuleId: null }),
    ).rejects.toThrow(LeaseHolderCapError);
    expect(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')).toBe(before);
  });

  it('plan and claim agree on quarantine: a seated session joins, an unseated one is refused by both', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.vault.quarantine(B.id, 'invalid_grant');
    expect(await h.engine.planSessionSlot(B.id, { launchRuleId: null })).toMatchObject({
      kind: 'lease',
      join: true,
    });
    expect(
      await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null }),
    ).toMatchObject({ kind: 'lease', joined: true });
    // The seat goes (an interrupted teardown): both refuse rather than seat a dead login.
    await rm(join(groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id)), '.credentials.json'));
    expect(await h.engine.planSessionSlot(B.id, { launchRuleId: null })).toMatchObject({
      kind: 'refused',
      code: 'quarantined',
    });
    await expect(
      h.engine.claimSessionSlot(B.id, launcher(h, 6120), { launchRuleId: null }),
    ).rejects.toThrow(QuarantineError);
  });

  it('plan and claim reach the same kind on every row', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const rule = await h.vault.createRule({ folders: ['C:\\repo'], include: [C.id] });
    await h.engine.activate(C.id, { force: true, slot: ruleSlotId(rule.id) });
    for (const id of [A.id, B.id, C.id]) {
      const plan = await h.engine.planSessionSlot(id, { launchRuleId: null });
      const pid = 7000 + [A.id, B.id, C.id].indexOf(id);
      const claim = await h.engine.claimSessionSlot(id, launcher(h, pid), {
        launchRuleId: null,
      });
      expect(claim.kind).toBe(plan.kind);
    }
  });
});

describe('crash points of a parallel session', () => {
  const points = [
    'lease:after-create',
    'lease:after-activate',
    'lease:join-after-seat',
    'lease:after-adopt',
    'lease:after-clear',
  ] as const;

  /** Bring the session to the point where `point` can fire, then fire it. */
  async function crashAt(
    h: Harness,
    B: StoredAccount,
    point: (typeof points)[number],
  ): Promise<LeaseHolder> {
    const first = launcher(h, 4120);
    if (point === 'lease:after-create' || point === 'lease:after-activate') {
      h.faults.at = point;
      await expect(h.engine.claimSessionSlot(B.id, first, { launchRuleId: null })).rejects.toThrow(
        `died at ${point}`,
      );
      h.alive.delete(first.pid);
      return first;
    }
    await h.engine.claimSessionSlot(B.id, first, { launchRuleId: null });
    if (point === 'lease:join-after-seat') {
      // The seat is gone (a teardown that died after clearing), so a join seats it first.
      await rm(join(groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id)), '.credentials.json'));
      const second = launcher(h, 5120);
      h.faults.at = point;
      await expect(h.engine.claimSessionSlot(B.id, second, { launchRuleId: null })).rejects.toThrow(
        `died at ${point}`,
      );
      h.alive.delete(first.pid);
      h.alive.delete(second.pid);
      return first;
    }
    h.faults.at = point;
    await expect(h.engine.releaseLease(leaseRuleId(B.id), [first], noWorkers)).rejects.toThrow(
      `died at ${point}`,
    );
    h.alive.delete(first.pid);
    return first;
  }

  for (const point of points) {
    it(`${point}: the file loads, a sweep recovers it, a second sweep does nothing`, async () => {
      const h = await harness();
      const { B } = await seed(h);
      await crashAt(h, B, point);
      await fileLoadsWithHolders(h);
      const first = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
      await fileLoadsWithHolders(h);
      expect((await h.vault.listRules()).length).toBe(0);
      expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
      expect((await h.engine.listAccounts()).map((a) => a.id)).toContain(B.id);
      expect(first.ended.map((e) => e.accountId)).toEqual([B.id]);
      const second = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
      expect(second).toEqual({
        droppedHolders: 0,
        adoptedHolders: 0,
        ended: [],
        deferred: [],
        adopted: [],
      });
    });

    it(`${point}: a join instead of a sweep gets a seated slot with the freshest login`, async () => {
      const h = await harness();
      const { B } = await seed(h);
      await crashAt(h, B, point);
      const joiner = launcher(h, 8120);
      const claim = await h.engine.claimSessionSlot(B.id, joiner, { launchRuleId: null });
      expect(claim.kind).toBe('lease');
      const slot = ruleSlotId(leaseRuleId(B.id));
      expect(await h.engine.getActiveId(slot)).toBe(B.id);
      const live = await leaseStore(h.paths, B.id).readLiveCredentials();
      const stored = (await h.vault.readBundle(B.id)).claudeAiOauth;
      expect(live?.refreshToken).toBe(stored.refreshToken);
      await fileLoadsWithHolders(h);
    });
  }
});

describe('nothing else touches a parallel session', () => {
  async function leased(
    h: Harness,
  ): Promise<{ A: StoredAccount; B: StoredAccount; C: StoredAccount }> {
    const accounts = await seed(h);
    await h.engine.claimSessionSlot(accounts.B.id, launcher(h, 4120), { launchRuleId: null });
    return accounts;
  }

  it("activate refuses the account, with or without a slot, naming the session's process", async () => {
    const h = await harness();
    const { B } = await leased(h);
    await expect(h.engine.activate(B.id)).rejects.toThrow(SlotError);
    await expect(h.engine.activate(B.id)).rejects.toThrow(
      /account "B" is in use by a parallel session \(pid 4120, since \d\d:\d\d\); it rejoins the pool when that session exits/,
    );
    await expect(h.engine.activate(B.id, { slot: 'global', force: true })).rejects.toMatchObject({
      code: 'leased',
    });
  });

  it('activate names every process when several terminals hold it', async () => {
    const h = await harness();
    const { B } = await leased(h);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120), child(h, 5188, 5120)]);
    await expect(h.engine.activate(B.id)).rejects.toThrow(
      'account "B" is in use by a parallel session on 2 terminals (pids 4188, 5188',
    );
  });

  it('configDirForAccount refuses a leased account and never hands out a lease profile', async () => {
    const h = await harness();
    const { B, C } = await leased(h);
    await expect(h.engine.configDirForAccount(B.id)).rejects.toMatchObject({ code: 'leased' });
    expect(await h.engine.configDirForAccount(C.id)).toBeUndefined();
  });

  it('ensureRuleLive never seats an empty session slot, never replaces or clears what is there', async () => {
    const h = await harness();
    const { B, C } = await leased(h);
    const ruleId = leaseRuleId(B.id);
    const profile = groupProfileDir(h.paths.vaultDir, ruleId);
    await rm(join(profile, '.credentials.json'));
    const empty = await h.engine.ensureRuleLive(ruleId);
    expect(empty).toMatchObject({ activated: false, noWorkingAccount: true });
    expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
    // A squatter (C's login) is not cleared by the self-heal.
    await writeFile(
      join(profile, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: bundleFor('C').claudeAiOauth }),
    );
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: bundleFor('C').oauthAccount }),
    );
    const squat = await h.engine.ensureRuleLive(ruleId);
    expect(squat).toMatchObject({ activated: false, noWorkingAccount: true });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('C');
    void C;
  });

  it('ensureRuleLive keeps a quarantined account seated and reports it as not working', async () => {
    const h = await harness();
    const { B } = await leased(h);
    await h.vault.quarantine(B.id, 'invalid_grant');
    const res = await h.engine.ensureRuleLive(leaseRuleId(B.id));
    expect(res).toMatchObject({ liveAccount: B.id, activated: false, noWorkingAccount: true });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
  });

  it('repairSlots never seats, evicts or re-seats the leased account', async () => {
    const h = await harness();
    const { B } = await leased(h);
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    // A profile no rule owns that holds a login: something for every repair run to fix, so each run
    // walks every step past the lease slot.
    const orphan = groupProfileDir(h.paths.vaultDir, 'orphan');
    const plantOrphan = async (): Promise<void> => {
      await mkdir(orphan, { recursive: true });
      await writeFile(
        join(orphan, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { ...bundleFor('C').claudeAiOauth, refreshToken: 'r-orphan' },
        }),
      );
    };
    // An empty seat stays empty.
    await rm(join(profile, '.credentials.json'));
    await plantOrphan();
    expect((await h.engine.repairSlots()).actions.join('\n')).toContain(
      'a profile no folder rule owns',
    );
    expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
    // A seated one with an older token than the vault's is not re-seated.
    await writeFile(
      join(profile, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { ...bundleFor('B').claudeAiOauth, refreshToken: 'old', expiresAt: NOW },
      }),
    );
    await plantOrphan();
    expect((await h.engine.repairSlots()).actions.join('\n')).toContain(
      'a profile no folder rule owns',
    );
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.refreshToken).toBe('old');
  });

  it('repair: another account logged in there that is also live elsewhere is adopted, cleared, and said', async () => {
    const h = await harness();
    const { A, B } = await leased(h);
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    // A /login inside the session put A's login (rotated) there; A is also live in the global slot.
    const rotated = {
      ...bundleFor('A').claudeAiOauth,
      accessToken: 'A2',
      refreshToken: 'r-A2',
      expiresAt: NOW + 20 * HOUR,
    };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: rotated }));
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: bundleFor('A').oauthAccount }),
    );
    const res = await h.engine.repairSlots();
    expect(res.actions.join('\n')).toContain(
      "a parallel session of B was logged in as A; that login's latest token was saved to A",
    );
    expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('r-A2');
  });

  it('repair: another account logged in there that is live nowhere else is adopted and kept, and said', async () => {
    const h = await harness();
    const { B, C } = await leased(h);
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    const rotated = {
      ...bundleFor('C').claudeAiOauth,
      accessToken: 'C2',
      refreshToken: 'r-C2',
      expiresAt: NOW + 20 * HOUR,
    };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: rotated }));
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: bundleFor('C').oauthAccount }),
    );
    const res = await h.engine.repairSlots();
    expect(res.actions.join('\n')).toContain('was logged in as C');
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.refreshToken).toBe('r-C2');
    expect((await h.vault.readBundle(C.id)).claudeAiOauth.refreshToken).toBe('r-C2');
  });

  it('refreshToken of a leased account is adopt-only: no network call', async () => {
    const h = await harness();
    const { B } = await leased(h);
    const res = await h.engine.refreshToken(B.id);
    expect(res.skippedReason).toBe('active_account');
    expect(h.refreshed).toEqual([]);
  });

  it('removeAccount refuses while held, and succeeds once the holders are gone and swept', async () => {
    const h = await harness();
    const { B } = await leased(h);
    await expect(h.engine.removeAccount(B.id)).rejects.toThrow(
      /^account "B" is in use by a parallel session \(pid 4120, since \d\d:\d\d\); exit it first$/,
    );
    h.alive.delete(4120);
    await h.engine.sweepLeases({ mode: 'full', probe: noWorkers, only: B.id });
    await h.engine.removeAccount(B.id);
    expect((await h.engine.listAllAccounts()).map((a) => a.id)).not.toContain(B.id);
  });
});

describe('releaseLease', () => {
  it('the last holder out adopts the rotation, clears the seat and restores the pool', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    // The session rotated its login while it ran.
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    const rotated = {
      ...bundleFor('B').claudeAiOauth,
      accessToken: 'B2',
      refreshToken: 'r-B2',
      expiresAt: NOW + 20 * HOUR,
    };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: rotated }));
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(res).toMatchObject({ ended: true, adoptedRotation: true });
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B2');
    expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
    expect((await rulesOnDisk(h))?.schemaVersion).toBe(2);
    expect((await h.engine.listAccounts()).map((a) => a.label)).toEqual(['A', 'B', 'C']);
  });

  it('a terminal leaving while another still runs reads no process table and keeps the session', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    const other = launcher(h, 5120);
    await h.engine.claimSessionSlot(B.id, other, { launchRuleId: null });
    h.tableReads.count = 0;
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(res).toMatchObject({ ended: false, remaining: 1 });
    expect(h.tableReads.count).toBe(0);
    expect((await h.vault.getRule(leaseRuleId(B.id)))?.lease?.holders.map((x) => x.pid)).toEqual([
      5120,
    ]);
  });

  it('a terminal leaving after the only other one died ends the session at once', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    // A second terminal on the session was closed without releasing: both its processes are gone.
    await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 5188, 5120)]);
    h.alive.delete(5120);
    h.alive.delete(5188);
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(res).toMatchObject({ ended: true });
    expect(await h.vault.getRule(leaseRuleId(B.id))).toBeUndefined();
  });

  it('two terminals releasing at once: exactly one teardown, and it ran the probe', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const one = launcher(h, 4120);
    const two = launcher(h, 5120);
    await h.engine.claimSessionSlot(B.id, one, { launchRuleId: null });
    await h.engine.claimSessionSlot(B.id, two, { launchRuleId: null });
    const probed: string[] = [];
    const probe =
      (who: string): LeaseOccupancyProbe =>
      () => {
        probed.push(who);
        return Promise.resolve([]);
      };
    const [r1, r2] = await Promise.all([
      h.engine.releaseLease(leaseRuleId(B.id), [one], probe('one')),
      h.engine.releaseLease(leaseRuleId(B.id), [two], probe('two')),
    ]);
    expect([r1.ended, r2.ended].filter(Boolean)).toHaveLength(1);
    expect(probed.sort()).toEqual(['one', 'two']);
    expect((await h.vault.listRules()).length).toBe(0);
  });

  it('a roster that cannot be read writes nothing; a failed read too', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const before = await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8');
    expect(
      await h.engine.releaseLease(leaseRuleId(B.id), [me], () => Promise.resolve('unreadable')),
    ).toMatchObject({ ended: false, deferred: 'roster_unreadable' });
    expect(
      await h.engine.releaseLease(leaseRuleId(B.id), [me], () => Promise.reject(new Error('io'))),
    ).toMatchObject({ ended: false, deferred: 'no_probe' });
    expect(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')).toBe(before);
  });

  it('background workers on the profile keep the session: they become its holders', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const worker: LeaseHolder = {
      pid: 6000,
      start: 0,
      host: HOST,
      platform: 'win32',
      role: 'background',
    };
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], () =>
      Promise.resolve([worker]),
    );
    expect(res).toMatchObject({ ended: false, deferredToBackground: true, remaining: 1 });
    expect((await h.vault.listRules())[0]?.lease?.holders).toEqual([worker]);
  });

  it('a slot whose switch cannot be settled is not torn down: credentials stay, slot_untrusted', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    // An intent whose record cannot be read: the slot cannot be settled.
    const state = join(h.paths.vaultDir, 'slots', leaseRuleId(B.id));
    await mkdir(state, { recursive: true });
    await writeFile(join(state, '.switch-intent.json'), '{not json');
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(res).toMatchObject({ ended: false, deferred: 'slot_untrusted' });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
    await fileLoadsWithHolders(h);
  });
});

describe('sweepLeases', () => {
  it('two passes: a holder added between them survives', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    h.alive.delete(4120);
    const late = launcher(h, 5120);
    const probe: LeaseOccupancyProbe = async () => {
      // Runs in the first pass, without the lock: another terminal joins meanwhile.
      await h.engine.claimSessionSlot(B.id, late, { launchRuleId: null });
      return [];
    };
    const report = await h.engine.sweepLeases({ mode: 'full', probe });
    expect(report.ended).toEqual([]);
    expect((await h.vault.listRules())[0]?.lease?.holders).toEqual([late]);
  });

  it('an unreadable roster defers; no lease is written with zero holders', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({
      mode: 'full',
      probe: () => Promise.resolve('unreadable'),
    });
    expect(report.deferred).toEqual([{ accountId: B.id, label: 'B', reason: 'roster_unreadable' }]);
    await fileLoadsWithHolders(h);
    expect((await h.vault.listRules())[0]?.lease?.holders).toHaveLength(1);
  });

  it('a failed roster read is no result: defers and writes nothing', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({
      mode: 'full',
      probe: () => Promise.reject(new Error('x')),
    });
    expect(report.deferred.map((d) => d.reason)).toEqual(['no_probe']);
  });

  it('a lease left with no holder by a concurrent release uses its first-pass roster read', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const one = launcher(h, 4120);
    const two = launcher(h, 5120);
    await h.engine.claimSessionSlot(B.id, one, { launchRuleId: null });
    await h.engine.claimSessionSlot(B.id, two, { launchRuleId: null });
    // Terminal two was killed and a later process took its pid: the first pass, a full check, judges
    // it dead; the release below checks without a process query, cannot tell, and leaves it on disk.
    h.table.find((r) => r.pid === 5120)!.startMs = NOW + HOUR;
    const worker: LeaseHolder = {
      pid: 6000,
      start: 0,
      host: HOST,
      platform: 'win32',
      role: 'background',
    };
    const probe: LeaseOccupancyProbe = async () => {
      // Terminal one exits between the passes and releases its own holder; two is left on disk.
      await h.engine.releaseLease(leaseRuleId(B.id), [one], noWorkers);
      return [worker];
    };
    await h.engine.sweepLeases({ mode: 'full', probe });
    expect((await h.vault.listRules())[0]?.lease?.holders).toEqual([worker]);
  });

  it("quick: a dead launcher's unrecorded child holds the session; once nothing runs, it ends", async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    h.alive.delete(4120);
    // Its Claude Code runs, never recorded: the quick sweep reads the process table and finds it.
    h.alive.add(4188);
    h.table.push({ pid: 4188, ppid: 4120, startMs: NOW + 4188 });
    const quick = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(quick.adopted.map((a) => a.pid)).toEqual([4188]);
    h.alive.delete(4188);
    const again = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(again.ended.map((e) => e.accountId)).toEqual([B.id]);
  });

  it("full, win32: a dead launcher's live child is found and holds the session; a reused parent pid's older process is not", async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120, NOW + 4120), { launchRuleId: null });
    h.alive.delete(4120);
    // A process "child" of 4120 started long before the launcher: another program's, not ours.
    h.alive.add(3000);
    h.table.push({ pid: 3000, ppid: 4120, startMs: NOW - HOUR });
    // The real child, started after the launcher, never recorded.
    h.alive.add(4188);
    h.table.push({ pid: 4188, ppid: 4120, startMs: NOW + 4200 });
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.adopted.map((a) => a.pid)).toEqual([4188]);
    expect((await h.vault.listRules())[0]?.lease?.holders.map((x) => x.pid)).toEqual([4188]);
    // Once it exits too, the next sweep ends the session.
    h.alive.delete(4188);
    const after = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(after.ended).toHaveLength(1);
  });

  it('full, linux: a process whose environment names the profile is found', async () => {
    const env = new Map<number, string>();
    const fs: ProcFs = {
      stat: (pid) =>
        pid === 812
          ? { ppid: 700, startTicks: 5000 }
          : pid === 813
            ? { ppid: 812, startTicks: 5001 }
            : undefined,
      bootId: () => 'boot-1',
      pidNs: () => 'pid:[1]',
      configDirOf: (pid) => env.get(pid),
      pids: () => [812, 813],
    };
    const h = await harness('linux', fs);
    const { B } = await seed(h);
    const me: LeaseHolder = {
      pid: 812,
      start: 5000,
      host: HOST,
      platform: 'linux',
      bootId: 'boot-1',
      pidNs: 'pid:[1]',
      role: 'launcher',
    };
    h.alive.add(812);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    h.alive.delete(812);
    h.alive.add(813);
    env.set(813, groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id)));
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.adopted.map((a) => a.pid)).toEqual([813]);
  });

  it('a fault after the adoption leaves the rule, and its slot still holds the account', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    h.alive.delete(4120);
    h.faults.at = 'lease:after-adopt';
    await expect(h.engine.sweepLeases({ mode: 'full', probe: noWorkers })).rejects.toThrow(
      'died at',
    );
    expect((await h.vault.listRules()).map((r) => r.id)).toEqual([leaseRuleId(B.id)]);
    expect((await h.engine.liveSlots()).get(ruleSlotId(leaseRuleId(B.id)))).toBe(B.id);
  });

  it('listLeases names a dead holder whose pid another program now has', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120, NOW + 4120), { launchRuleId: null });
    // pid 4120 now belongs to a process started an hour later.
    h.table.splice(0, h.table.length, { pid: 4120, ppid: 1, startMs: NOW + HOUR });
    const [view] = await h.engine.listLeases({ mode: 'full' });
    expect(view?.holders[0]).toMatchObject({ pid: 4120, state: 'dead', reused: true });
    const [quick] = await h.engine.listLeases({ mode: 'quick' });
    expect(quick?.holders[0]?.state).toBe('alive');
  });

  it('a holder of another platform (a WSL distro on this machine) is foreign: never swept from here', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const remote: LeaseHolder = {
      pid: 812,
      start: 5,
      host: HOST,
      platform: 'linux',
      role: 'launcher',
    };
    await h.engine.claimSessionSlot(B.id, remote, { launchRuleId: null });
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended).toEqual([]);
    expect((await h.engine.leaseOf(B.id))?.holders[0]?.state).toBe('foreign');
  });

  it('a removed session that another rule includes stays reserved there', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const folder = await h.vault.createRule({ folders: ['C:\\repo'], include: [B.id] });
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    h.alive.delete(4120);
    await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect((await h.engine.listAllAccounts()).find((a) => a.id === B.id)?.ruleIds).toEqual([
      folder.id,
    ]);
  });
});

describe('accounts relogin of an account a parallel session holds', () => {
  it('heals the parallel-session profile, where the account is live, and nothing else', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const capture = join(h.paths.vaultDir, '..', 'relogin-B');
    await mkdir(capture, { recursive: true });
    const store = new CredentialStore({
      claudeDir: capture,
      credentialsPath: join(capture, '.credentials.json'),
      claudeJsonPath: join(capture, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials({
      accessToken: 'B-fresh',
      refreshToken: 'r-B-fresh',
      expiresAt: NOW + 30 * HOUR,
    });
    await store.writeOauthAccount({ accountUuid: 'uuid-B', emailAddress: 'B@x.com' });
    const res = await h.engine.reloginFromConfigDir(B.id, capture);
    expect(res.healedLiveLogin).toBe(true);
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B-fresh');
    expect((await h.global.readLiveCredentials())?.accessToken).toBe('A');
  });
});

/** A Linux /proc stand-in: stat starts by pid, environments by pid, one boot and namespace, and
 *  each process's arguments where `argv` gives them (unreadable otherwise). */
function linuxProc(
  starts: Map<number, number>,
  env: Map<number, string>,
  argv: Map<number, string[]> = new Map(),
): ProcFs {
  return {
    stat: (pid) => {
      const start = starts.get(pid);
      return start === undefined ? undefined : { ppid: 1, startTicks: start, state: 'S' };
    },
    bootId: () => 'boot-1',
    pidNs: () => 'pid:[1]',
    configDirOf: (pid) => env.get(pid),
    pids: () => [...new Set([...starts.keys(), ...env.keys()])],
    cmdlineOf: (pid) => argv.get(pid),
  };
}

/** A Linux holder recorded on the harness host. */
function linuxHolder(
  pid: number,
  start: number,
  role: LeaseHolder['role'],
  parent?: number,
): LeaseHolder {
  return {
    pid,
    start,
    host: HOST,
    platform: 'linux',
    bootId: 'boot-1',
    pidNs: 'pid:[1]',
    role,
    ...(parent !== undefined ? { parent } : {}),
  };
}

describe('a process that outlives its Claude Code on the session profile', () => {
  it('linux: the release records it as the holder, and a quick sweep from another terminal keeps it', async () => {
    const starts = new Map([
      [812, 5000],
      [813, 5001],
      [900, 5002],
    ]);
    const env = new Map<number, string>();
    const h = await harness('linux', linuxProc(starts, env));
    const { B } = await seed(h);
    const me = linuxHolder(812, 5000, 'launcher');
    const kid = linuxHolder(813, 5001, 'claude', 812);
    h.alive.add(812);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    // Claude Code started a background `claude -p` that inherited the profile, then exited.
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    env.set(900, profile);
    h.alive.add(900);
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(released).toMatchObject({ ended: false, heldBy: [900] });
    h.alive.delete(812);
    const quick = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(quick.ended).toEqual([]);
    expect((await h.vault.listRules())[0]?.lease?.holders.map((x) => x.pid)).toEqual([900]);
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
  });

  it('linux: a quick sweep never ends a session whose dead holders left a process on its profile', async () => {
    const starts = new Map([
      [812, 5000],
      [813, 5001],
      [900, 5002],
    ]);
    const env = new Map<number, string>();
    const h = await harness('linux', linuxProc(starts, env));
    const { B } = await seed(h);
    h.alive.add(812);
    await h.engine.claimSessionSlot(B.id, linuxHolder(812, 5000, 'launcher'), {
      launchRuleId: null,
    });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [linuxHolder(813, 5001, 'claude', 812)]);
    h.alive.delete(812);
    env.set(900, groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id)));
    h.alive.add(900);
    const quick = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(quick.ended).toEqual([]);
    expect(quick.adopted.map((a) => a.pid)).toEqual([900]);
  });

  it('win32: a quick sweep reads the process table before ending a session, and keeps a live descendant', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120)]);
    h.alive.delete(4120);
    h.alive.delete(4188);
    // A detached helper Claude Code started, still running after both exited.
    h.alive.add(5000);
    h.table.push({ pid: 5000, ppid: 4188, startMs: NOW + 5000 });
    const quick = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(quick.ended).toEqual([]);
    expect(quick.adopted.map((a) => a.pid)).toEqual([5000]);
  });

  it("win32: the last terminal's release keeps a live descendant of its Claude Code as the holder", async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    h.alive.delete(4188);
    h.alive.add(5000);
    h.table.push({ pid: 5000, ppid: 4188, startMs: NOW + 5000 });
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(released).toMatchObject({ ended: false, heldBy: [5000] });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
    // Once it exits too, the next sweep ends the session.
    h.alive.delete(4120);
    h.alive.delete(5000);
    const after = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(after.ended.map((e) => e.accountId)).toEqual([B.id]);
  });

  it('a process table that cannot be read is no evidence: the end is deferred, nothing is cleared', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    h.alive.delete(4120);
    for (const mode of ['full', 'quick'] as const) {
      const report = await h.engine.sweepLeases({
        mode,
        probe: noWorkers,
        processTable: () => Promise.reject(new Error('timed out')),
      });
      expect(report.ended).toEqual([]);
      expect(report.deferred.map((d) => d.reason)).toEqual(['processes_unreadable']);
    }
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
  });

  it("a dead holder's pid taken over by a later process: that process's children are not the session's", async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120, NOW + 4120), { launchRuleId: null });
    // pid 4120 now runs a process started an hour later, with children of its own.
    h.table.splice(0, h.table.length, { pid: 4120, ppid: 700, startMs: NOW + HOUR });
    h.table.push({ pid: 9001, ppid: 4120, startMs: NOW + HOUR + 10 });
    h.table.push({ pid: 9002, ppid: 9001, startMs: NOW + HOUR + 20 });
    h.alive.add(9001);
    h.alive.add(9002);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.adopted).toEqual([]);
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
  });

  it('one session whose end fails does not stop the sweep from ending the others', async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.engine.claimSessionSlot(C.id, launcher(h, 5120), { launchRuleId: null });
    h.alive.delete(4120);
    h.alive.delete(5120);
    // B's profile .claude.json is a directory now: any read of it fails, as a locked file would.
    const bProfile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    await rm(join(bProfile, '.claude.json'), { force: true });
    await mkdir(join(bProfile, '.claude.json'));
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([C.id]);
    expect(report.deferred).toEqual([{ accountId: B.id, label: 'B', reason: 'teardown_failed' }]);
  });
});

describe('ending a parallel session never loses its login', () => {
  it('a torn .claude.json is set aside, and a session whose login is stored still ends', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    await writeFile(join(profile, '.claude.json'), '{"oauthAccount":{"accountUu');
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
    expect(await readFile(join(profile, '.claude.json.corrupt'), 'utf8')).toContain('accountUu');
  });

  it('a rotated login that cannot be adopted is kept, not cleared: login_unadopted', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    const rotated = {
      accessToken: 'B9',
      refreshToken: 'r-B9',
      expiresAt: NOW + 11 * HOUR,
    };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: rotated }));
    // The identity block is gone: nothing says whose login this is, so it is not adopted.
    await writeFile(join(profile, '.claude.json'), '{}');
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended).toEqual([]);
    expect(report.deferred.map((d) => d.reason)).toEqual(['login_unadopted']);
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.refreshToken).toBe('r-B9');
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B');
  });

  it('a torn .credentials.json is kept too: it may hold the only copy of a rotated token', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    await writeFile(join(profile, '.credentials.json'), '{"claudeAiOauth":{"accessTo');
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(res).toMatchObject({ ended: false, deferred: 'login_unadopted' });
    expect(await readFile(join(profile, '.credentials.json'), 'utf8')).toContain('accessTo');
  });

  it('a rotation the end will adopt is no lost login: doctor is not told to re-login for it', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    const rotated = { accessToken: 'B9', refreshToken: 'r-B9', expiresAt: NOW + 11 * HOUR };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: rotated }));
    expect(await h.engine.leaseHoldsUnstoredLogin(leaseRuleId(B.id))).toBe(false);
    // With its identity block gone, nothing says whose it is: that one would be lost.
    await writeFile(join(profile, '.claude.json'), '{}');
    expect(await h.engine.leaseHoldsUnstoredLogin(leaseRuleId(B.id))).toBe(true);
  });

  it('a live token older than the stored login holds nothing worth keeping: the session ends', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    // The grant a re-login replaced: the vault's copy is newer.
    const older = { accessToken: 'B0', refreshToken: 'r-B0', expiresAt: NOW + HOUR };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: older }));
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B');
  });
});

describe('what a join and a refusal say about who else is on the session', () => {
  it('counts a live Claude Code whose terminal was killed, and a background session; never a dead holder', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120)]);
    h.alive.delete(4120);
    await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    const worker: LeaseHolder = {
      pid: 6000,
      start: 0,
      host: HOST,
      platform: 'win32',
      role: 'background',
    };
    h.alive.add(6000);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [worker]);
    const claim = await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    expect(claim).toMatchObject({ kind: 'lease', otherTerminals: 1, otherBackground: 1 });
  });

  it('a deferred end leaves dead holders on disk; a join does not count them as other terminals', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const one = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, one, { launchRuleId: null });
    await h.engine.releaseLease(leaseRuleId(B.id), [one], () => Promise.resolve('unreadable'));
    h.alive.delete(4120);
    const claim = await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    expect(claim).toMatchObject({ kind: 'lease', otherTerminals: 0 });
  });

  it('a refusal for several terminals waits for the last of them, not "that session"', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120), child(h, 5188, 5120)]);
    await expect(h.engine.activate(B.id)).rejects.toThrow(
      /account "B" is in use by a parallel session on 2 terminals \(pids 4188, 5188, since \d\d:\d\d\); it rejoins the pool when the last of them exits/,
    );
  });

  it('a join leaves room for the Claude Code its launcher records next', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 1000), { launchRuleId: null });
    await h.engine.addLeaseHolders(
      leaseRuleId(B.id),
      Array.from({ length: 30 }, (_, i) => launcher(h, 2000 + i)),
    );
    // 31 recorded: a join would make 32, and its Claude Code a 33rd that could never be recorded.
    await expect(
      h.engine.claimSessionSlot(B.id, launcher(h, 9999), { launchRuleId: null }),
    ).rejects.toThrow(LeaseHolderCapError);
  });

  it('a seat that fails on a join says why, not that the account changed slots', async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await rm(join(groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id)), '.credentials.json'));
    // C stores B's login: a shared token every seat refuses, however often it is retried.
    await h.vault.writeBundle(C.id, bundleFor('B'));
    const err = await h.engine
      .claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null })
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain('changed slots');
    expect(String(err)).toContain('could not log B in to its parallel-session slot');
  });
});

describe('the rest of the engine around a parallel session', () => {
  it('a quarantined reserved account live in its folder slot is refused, as seating it always was', async () => {
    const h = await harness();
    const { C } = await seed(h);
    const rule = await h.vault.createRule({ folders: ['C:\\repo'], include: [C.id] });
    await h.engine.activate(C.id, { force: true, slot: ruleSlotId(rule.id) });
    await h.vault.quarantine(C.id, 'invalid_grant');
    expect(await h.engine.planSessionSlot(C.id, { launchRuleId: null })).toMatchObject({
      kind: 'refused',
      code: 'quarantined',
    });
  });

  it("a shared account live in a named session's slot is told how to free it: session exclude", async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const rule = await h.vault.createRule({
      folders: [],
      aliases: [{ folder: 'C:\\research', alias: 'auth work' }],
      exclude: [A.id],
    });
    await h.engine.activate(B.id, { force: true, slot: ruleSlotId(rule.id) });
    const plan = await h.engine.planSessionSlot(B.id, { launchRuleId: null });
    expect(plan).toMatchObject({ kind: 'refused', code: 'live_in_other_rule' });
    const message = plan.kind === 'refused' ? plan.message : '';
    expect(message).toContain('live in the slot of session');
    expect(message).toContain("cctl session exclude 'auth work' 'B' --cwd 'C:\\research'");
    expect(message).not.toContain('switch that slot');
  });

  it("a refusal names the launch's own rule, never 'there' for the folder the launch is in", async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    // B is live in this folder's slot, and the launch opens a named session of this folder whose
    // rule has a slot of its own: the folder's slot is not the launch's.
    const folder = await h.vault.createRule({ folders: ['C:\\research'], exclude: [A.id] });
    const named = await h.vault.createRule({
      folders: [],
      aliases: [{ folder: 'C:\\research', alias: 'auth work' }],
      exclude: [A.id],
    });
    await h.engine.activate(B.id, { force: true, slot: ruleSlotId(folder.id) });
    const plan = await h.engine.planSessionSlot(B.id, { launchRuleId: named.id });
    expect(plan).toMatchObject({ kind: 'refused', code: 'live_in_other_rule' });
    const message = plan.kind === 'refused' ? plan.message : '';
    expect(message).toContain('is a shared account live in the folder slot of C:\\research');
    expect(message).toContain(
      'this launch runs in the slot of session "auth work" in C:\\research',
    );
    expect(message).not.toMatch(/\b(here|there)\b/);
    // With no rule over the launch, it says so.
    const anywhere = await h.engine.planSessionSlot(B.id, { launchRuleId: null });
    expect(anywhere.kind === 'refused' && anywhere.message).toContain(
      'this launch runs under no folder or session rule',
    );
  });

  it('a reserved account live in a rule that does not include it is not called a shared one', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    // Live in another rule's slot while still shared, then reserved: the state until a repair
    // evicts it.
    const other = await h.vault.createRule({ folders: ['C:\\other'], exclude: [A.id] });
    await h.engine.activate(C.id, { force: true, slot: ruleSlotId(other.id) });
    await h.vault.createRule({ folders: ['C:\\mine'], include: [C.id] });
    const plan = await h.engine.planSessionSlot(C.id, { launchRuleId: null });
    expect(plan).toMatchObject({ kind: 'refused', code: 'live_in_other_rule' });
    const message = plan.kind === 'refused' ? plan.message : '';
    expect(message).toContain('is reserved to other rules and live in the folder slot of');
    expect(message).not.toContain('shared account');
  });

  it('renaming a leased account renames its parallel session', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.engine.renameAccount(B.id, 'Bx');
    expect((await h.vault.listRules())[0]?.label).toBe('Bx');
  });

  it("emptying a folder's slot is not refused for a parallel session that merely works in that folder", async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    const folder = FOLDER;
    await h.engine.includeInFolder(folder, [C.id]);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    // B's Claude Code runs in that folder: the shared roster lists it with that cwd.
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, process.pid, 4120)]);
    await mkdir(join(h.paths.claudeDir, 'sessions'), { recursive: true });
    await writeFile(
      join(h.paths.claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, cwd: folder, sessionId: 's1' }),
    );
    const reset = await h.engine.resetFolder(folder);
    expect(reset).toMatchObject({ dissolved: true, runningSessions: [] });
  });
});

describe('only a Claude Code keeps a session after its terminals exit', () => {
  it('linux: a dev server that inherited the profile does not hold it; a backgrounded claude -p does', async () => {
    const starts = new Map([
      [812, 5000],
      [813, 5001],
      [900, 5002],
      [901, 5003],
    ]);
    const env = new Map<number, string>();
    const argv = new Map<number, string[]>([
      [900, ['node', '/home/u/app/node_modules/.bin/vite']],
      [901, ['/home/u/.local/bin/claude', '-p', 'summarize']],
    ]);
    const h = await harness('linux', linuxProc(starts, env, argv));
    const { B } = await seed(h);
    const me = linuxHolder(812, 5000, 'launcher');
    const kid = linuxHolder(813, 5001, 'claude', 812);
    h.alive.add(812);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    const profile = groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id));
    env.set(900, profile);
    env.set(901, profile);
    h.alive.add(900);
    h.alive.add(901);
    // The claude -p holds it; the dev server is never recorded.
    const held = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(held).toMatchObject({ ended: false, heldBy: [901] });
    // Once the claude -p exits, the next sweep ends it under the dev server, which keeps running.
    h.alive.delete(812);
    h.alive.delete(901);
    env.delete(901);
    const swept = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(swept.adopted).toEqual([]);
    expect(swept.ended.map((e) => e.accountId)).toEqual([B.id]);
  });

  it('linux: the last terminal out ends the session though a dev server still runs on its profile', async () => {
    const starts = new Map([
      [812, 5000],
      [813, 5001],
      [900, 5002],
    ]);
    const env = new Map<number, string>();
    const argv = new Map<number, string[]>([[900, ['sleep', '900']]]);
    const h = await harness('linux', linuxProc(starts, env, argv));
    const { B } = await seed(h);
    const me = linuxHolder(812, 5000, 'launcher');
    const kid = linuxHolder(813, 5001, 'claude', 812);
    h.alive.add(812);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    env.set(900, groupProfileDir(h.paths.vaultDir, leaseRuleId(B.id)));
    h.alive.add(900);
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(released).toMatchObject({ ended: true });
    expect(released.heldBy).toBeUndefined();
  });

  it('win32: a descendant that is no Claude Code is walked through but never holds the session', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    h.alive.delete(4188);
    // Claude Code started a shell, which started a dev server and a claude -p.
    for (const pid of [5000, 5001, 5002]) h.alive.add(pid);
    h.table.push({
      pid: 5000,
      ppid: 4188,
      startMs: NOW + 5000,
      name: 'bash.exe',
      commandLine: 'C:/Program Files/Git/bin/bash.exe -c "npm run dev & claude -p hi"',
    });
    h.table.push({
      pid: 5001,
      ppid: 5000,
      startMs: NOW + 5001,
      name: 'node.exe',
      commandLine: 'node.exe C:/repo/node_modules/vite/bin/vite.js',
    });
    h.table.push({
      pid: 5002,
      ppid: 5000,
      startMs: NOW + 5002,
      name: 'claude.exe',
      commandLine: 'C:/Users/u/.local/bin/claude.exe -p hi',
    });
    const held = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(held).toMatchObject({ ended: false, heldBy: [5002] });
    // With only the dev server left, a sweep ends the session.
    h.alive.delete(4120);
    h.alive.delete(5002);
    h.table.splice(
      h.table.findIndex((r) => r.pid === 5002),
      1,
    );
    const swept = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(swept.adopted).toEqual([]);
    expect(swept.ended.map((e) => e.accountId)).toEqual([B.id]);
  });
});

/** The profile of an account's parallel session, as a process started on it names it. */
function leaseProfile(h: Harness, accountId: string): string {
  return groupProfileDir(h.paths.vaultDir, leaseRuleId(accountId));
}

/** A Windows Claude Code row (claude.exe) in the stand-in table, alive. */
function claudeRow(h: Harness, pid: number, ppid: number, startMs: number): void {
  h.alive.add(pid);
  h.table.push({ pid, ppid, startMs, name: 'claude.exe', commandLine: 'claude.exe -p hi' });
}

describe('win32: a Claude Code on the profile is found by its own environment', () => {
  it('a backgrounded claude -p whose shell exited still holds the session: the release keeps it', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    h.alive.delete(4188);
    // Claude Code ran `bash -c "claude -p hi &"`: bash (5000) exited and left the table, so the
    // survivor's parent id names a process the table no longer has.
    claudeRow(h, 5002, 5000, NOW + 5002);
    h.env.set(5002, leaseProfile(h, B.id));
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(released).toMatchObject({ ended: false, heldBy: [5002] });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.accessToken).toBe('B');
    const holders = (await h.vault.listRules())[0]?.lease?.holders;
    expect(holders?.map((x) => [x.pid, x.role, x.found])).toEqual([[5002, 'claude', true]]);
  });

  it("the launcher's own grandchild counts though its Claude Code was never recorded", async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    // Its Claude Code (4188, never recorded) exited; one it started still runs on the profile.
    claudeRow(h, 5002, 4188, NOW + 5002);
    h.env.set(5002, leaseProfile(h, B.id));
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(released).toMatchObject({ ended: false, heldBy: [5002] });
  });

  it('a Claude Code started on another profile does not hold it, wherever it sits in the tree', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    h.alive.delete(4188);
    // A direct child of the session's Claude Code, started with another account's config dir.
    claudeRow(h, 5000, 4188, NOW + 5000);
    h.env.set(5000, 'C:/Users/me/.claude');
    // An unrelated one with no config dir at all.
    claudeRow(h, 5100, 300, NOW + 5100);
    h.env.set(5100, null);
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    expect(released).toMatchObject({ ended: true });
  });

  it('an environment that cannot be read is judged by the table: an untraceable Claude Code started since keeps the session', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    h.alive.delete(4188);
    claudeRow(h, 5002, 5000, NOW + 5002);
    // An older one with no parent either was not started from this session.
    claudeRow(h, 3000, 2999, NOW - HOUR);
    const report = await h.engine.sweepLeases({
      mode: 'full',
      probe: noWorkers,
      processConfigDirs: () => Promise.reject(new Error('timed out')),
    });
    expect(report.ended).toEqual([]);
    // The release did not run: the sweep sees both recorded holders gone (4120 is still alive).
    h.alive.delete(4120);
    const after = await h.engine.sweepLeases({
      mode: 'full',
      probe: noWorkers,
      processConfigDirs: () => Promise.reject(new Error('timed out')),
    });
    expect(after.adopted.map((a) => a.pid)).toEqual([5002]);
    expect(after.ended).toEqual([]);
  });

  it("an orphaned Claude Code whose parent's pid was taken over is the session's only when its environment says so", async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120, NOW + 4120), { launchRuleId: null });
    h.alive.delete(4120);
    // A later process took over 4120, started a Claude Code on another account's profile and
    // exited: its child carries ppid 4120 and started after the launcher, like a real child would.
    h.table.splice(0, h.table.length);
    claudeRow(h, 9001, 4120, NOW + HOUR);
    h.env.set(9001, 'C:/Users/me/.claude');
    // The session's own Claude Code, never recorded, under a shell whose pid was reused since; an
    // unrelated Claude Code sits under that shell's pid too.
    claudeRow(h, 4188, 4120, NOW + 4200);
    h.env.set(4188, leaseProfile(h, B.id));
    h.alive.add(5000);
    h.table.push({
      pid: 5000,
      ppid: 4188,
      startMs: NOW + 2 * HOUR,
      name: 'bash.exe',
      commandLine: 'bash',
    });
    claudeRow(h, 6000, 5000, NOW + HOUR + 30);
    h.env.set(6000, 'C:/Users/other/.claude');
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.adopted.map((a) => a.pid)).toEqual([4188]);
    h.alive.delete(4188);
    const after = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(after.ended.map((e) => e.accountId)).toEqual([B.id]);
  });

  it('a survivor holds the session though the roster could not be read: the release names it', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    claudeRow(h, 5002, 5000, NOW + 5002);
    h.env.set(5002, leaseProfile(h, B.id));
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me], () =>
      Promise.resolve('unreadable'),
    );
    expect(released).toMatchObject({ ended: false, heldBy: [5002] });
    expect(released.deferred).toBeUndefined();
  });
});

describe("emptying a folder's slot counts every session that may run on it", () => {
  /** A folder whose slot includes C, B's parallel session, and the shared roster listing this
   *  process as a session working in that folder. */
  async function setup(h: Harness): Promise<{ B: StoredAccount; folder: string }> {
    const { B, C } = await seed(h);
    const folder = FOLDER;
    await h.engine.includeInFolder(folder, [C.id]);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await mkdir(join(h.paths.claudeDir, 'sessions'), { recursive: true });
    await writeFile(
      join(h.paths.claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, cwd: folder, sessionId: 's1' }),
    );
    return { B, folder };
  }

  it('a Claude Code started under the parallel session (on its profile) is left out', async () => {
    const h = await harness();
    const { B, folder } = await setup(h);
    // Nested under the session's Claude Code, never recorded; its environment names the profile.
    h.env.set(process.pid, leaseProfile(h, B.id));
    const reset = await h.engine.resetFolder(folder);
    expect(reset).toMatchObject({ dissolved: true, runningSessions: [] });
  });

  it('a stale holder on that pid with another start is not the session there: it counts', async () => {
    const h = await harness();
    const { B, folder } = await setup(h);
    // B's record of a Claude Code that exited five hours ago, on the pid a session in this folder
    // runs on now (the table shows that pid started much later).
    h.alive.add(process.pid);
    h.table.push({ pid: process.pid, ppid: 1, startMs: NOW + 77, name: 'claude.exe' });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [
      { pid: process.pid, start: NOW - 5 * HOUR, host: HOST, platform: 'win32', role: 'claude' },
    ]);
    await expect(h.engine.resetFolder(folder)).rejects.toThrow(/running session/);
  });

  it('a holder of another machine or platform never matches a pid here', async () => {
    const h = await harness();
    const { B, folder } = await setup(h);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [
      {
        pid: process.pid,
        start: 5,
        host: 'OTHERBOX',
        platform: 'linux',
        role: 'claude',
        bootId: 'b',
        pidNs: 'pid:[1]',
      },
    ]);
    await expect(h.engine.resetFolder(folder)).rejects.toThrow(/running session/);
  });
});

describe('who holds a session, counted by what runs it', () => {
  it('a refusal counts terminals, not recorded pids: two terminals with one Claude Code recorded', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120)]);
    await expect(h.engine.activate(B.id)).rejects.toThrow(
      /account "B" is in use by a parallel session on 2 terminals \(pids 5120, 4188, since \d\d:\d\d\); it rejoins the pool when the last of them exits/,
    );
  });

  it('removing an account several terminals hold names them all and asks to exit them', async () => {
    const h = await harness();
    const { B } = await seed(h);
    for (const pid of [4120, 5120, 6120]) {
      await h.engine.claimSessionSlot(B.id, launcher(h, pid), { launchRuleId: null });
      await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, pid + 68, pid)]);
    }
    h.alive.add(7000);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [
      { pid: 7000, start: 0, host: HOST, platform: 'win32', role: 'background' },
    ]);
    await expect(h.engine.removeAccount(B.id)).rejects.toThrow(
      /account "B" is in use by a parallel session on 3 terminals and 1 background session \(pids 4188, 5188, 6188, 7000, since \d\d:\d\d\); exit them first/,
    );
  });

  it('a Claude Code left running after the terminals exited is no terminal', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    h.alive.delete(4188);
    claudeRow(h, 5000, 4188, NOW + 5000);
    h.env.set(5000, leaseProfile(h, B.id));
    await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], noWorkers);
    h.alive.delete(4120);
    const [view] = await h.engine.listLeases({ mode: 'quick' });
    const running = view!.holders.filter((x) => x.state !== 'dead');
    expect(leaseOccupants(running)).toEqual({ terminals: 0, background: 0, leftover: 1 });
    expect(occupantsPhrase(leaseOccupants(running))).toBe('1 Claude Code process left running');
    const claim = await h.engine.claimSessionSlot(B.id, launcher(h, 6120), { launchRuleId: null });
    expect(claim).toMatchObject({ kind: 'lease', otherTerminals: 0, otherLeftover: 1 });
  });

  it('a join keeps room for the Claude Code of every terminal still starting, not only its own', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 1000), { launchRuleId: null });
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 1001, 1000)]);
    // 14 full terminals: 28 records, plus the first one's two.
    for (let i = 0; i < 13; i += 1) {
      await h.engine.addLeaseHolders(leaseRuleId(B.id), [
        launcher(h, 2000 + i * 2),
        child(h, 2001 + i * 2, 2000 + i * 2),
      ]);
    }
    // A terminal joins with 28 recorded: 29, and its Claude Code makes 30.
    await h.engine.claimSessionSlot(B.id, launcher(h, 8000), { launchRuleId: null });
    // Another joins before that one recorded its Claude Code: 30, plus room for two Claude Codes.
    await h.engine.claimSessionSlot(B.id, launcher(h, 8100), { launchRuleId: null });
    // A third would leave one of those two with no room: refused.
    await expect(
      h.engine.claimSessionSlot(B.id, launcher(h, 8200), { launchRuleId: null }),
    ).rejects.toThrow(LeaseHolderCapError);
    // Both earlier terminals can still record their Claude Code.
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 8001, 8000)]);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 8101, 8100)]);
  });

  it('win32: a join counts no dead holder whose pid another process took over', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const kid = child(h, 4188, 4120);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [kid]);
    await h.engine.releaseLease(leaseRuleId(B.id), [me, kid], () => Promise.resolve('unreadable'));
    // Both pids now run unrelated processes started long after.
    for (const row of h.table) {
      if (row.pid === 4120 || row.pid === 4188) row.startMs += 500_000;
    }
    const claim = await h.engine.claimSessionSlot(B.id, launcher(h, 5120), { launchRuleId: null });
    expect(claim).toMatchObject({ kind: 'lease', otherTerminals: 0 });
  });
});

describe('a background holder is judged by the roster that names it', () => {
  it('a worker no readable roster lists any more is gone, whatever its pid runs now', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const worker: LeaseHolder = {
      pid: 6000,
      start: NOW + 6000,
      host: HOST,
      platform: 'win32',
      role: 'background',
    };
    h.alive.add(6000);
    h.table.push({ pid: 6000, ppid: 1, startMs: NOW + 6000, name: 'node.exe', commandLine: 'x' });
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me], () =>
      Promise.resolve([worker]),
    );
    expect(released).toMatchObject({ deferredToBackground: true });
    // The roster no longer lists it; its pid still answers (another process, or not reaped yet).
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
  });
});

describe('a re-login heals a parallel-session slot whose credentials file is torn', () => {
  it('the torn file is set aside, the fresh login written, and the next check ends the session', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const profile = leaseProfile(h, B.id);
    await writeFile(join(profile, '.credentials.json'), '{"claudeAiOauth":{"accessTo');
    expect(await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers)).toMatchObject({
      deferred: 'login_unadopted',
    });
    const capture = join(h.paths.vaultDir, '..', 'relogin-B');
    await mkdir(capture, { recursive: true });
    const store = new CredentialStore({
      claudeDir: capture,
      credentialsPath: join(capture, '.credentials.json'),
      claudeJsonPath: join(capture, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials({
      accessToken: 'B-fresh',
      refreshToken: 'r-B-fresh',
      expiresAt: NOW + 30 * HOUR,
    });
    await store.writeOauthAccount({ accountUuid: 'uuid-B', emailAddress: 'B@x.com' });
    const res = await h.engine.reloginFromConfigDir(B.id, capture);
    expect(res.healedLiveLogin).toBe(true);
    expect(await readFile(join(profile, '.credentials.json.corrupt'), 'utf8')).toContain(
      'accessTo',
    );
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
  });
});

describe('linux: a holder that exited but was not reaped', () => {
  it('reads as exited, not as a pid another program took over', async () => {
    const proc = linuxProc(new Map([[812, 5000]]), new Map());
    const zombie: ProcFs = {
      ...proc,
      stat: (pid) => (pid === 812 ? { ppid: 1, startTicks: 5000, state: 'Z' } : undefined),
    };
    const h = await harness('linux', zombie);
    const { B } = await seed(h);
    h.alive.add(812);
    await h.engine.claimSessionSlot(B.id, linuxHolder(812, 5000, 'launcher'), {
      launchRuleId: null,
    });
    const [view] = await h.engine.listLeases({ mode: 'quick' });
    expect(view?.holders.map((x) => [x.state, x.reused === true])).toEqual([['dead', false]]);
  });
});

describe("win32: another user's process is no Claude Code of the session", () => {
  it('an untraceable process whose command line cannot be read, started since, does not hold it', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    // A service started after the session, its parent gone: nothing here can read what it runs.
    h.alive.add(7100);
    h.table.push({ pid: 7100, ppid: 7000, startMs: NOW + HOUR, name: 'svchost.exe' });
    const released = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(released).toMatchObject({ ended: true });
  });
});

describe('a re-login frees a parallel session that holds a login cctl does not store', () => {
  /** A throwaway config dir holding a fresh login of `name`, as `cctl accounts relogin` or
   *  `accounts add --fresh` captures it. */
  async function freshLoginOf(h: Harness, name: string): Promise<string> {
    const capture = join(h.paths.vaultDir, '..', `capture-${name}`);
    await mkdir(capture, { recursive: true });
    const store = new CredentialStore({
      claudeDir: capture,
      credentialsPath: join(capture, '.credentials.json'),
      claudeJsonPath: join(capture, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials({
      accessToken: `${name}-fresh`,
      refreshToken: `r-${name}-fresh`,
      expiresAt: NOW + 30 * HOUR,
    });
    await store.writeOauthAccount({ accountUuid: `uuid-${name}`, emailAddress: `${name}@x.com` });
    return capture;
  }

  /** A session on B inside which the user ran /login as U, an account no row here is: nothing can
   *  save that login, so its release defers. */
  async function strandedByUnknownLogin(): Promise<{
    h: Harness;
    B: StoredAccount;
    slot: CredentialStore;
  }> {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const slot = leaseStore(h.paths, B.id);
    await slot.writeLiveCredentials({
      accessToken: 'U',
      refreshToken: 'r-U',
      expiresAt: NOW + 20 * HOUR,
    });
    await slot.writeOauthAccount({ accountUuid: 'uuid-U', emailAddress: 'U@x.com' });
    expect(await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers)).toMatchObject({
      ended: false,
      deferred: 'login_unadopted',
    });
    expect(await h.engine.leaseHoldsUnstoredLogin(leaseRuleId(B.id))).toBe(true);
    return { h, B, slot };
  }

  it('the release defers, the re-login it advises rewrites the slot, and the next check ends it', async () => {
    const { h, B, slot } = await strandedByUnknownLogin();
    const res = await h.engine.reloginFromConfigDir(B.id, await freshLoginOf(h, 'B'));
    expect(res.healedLiveLogin).toBe(true);
    expect((await slot.readLiveCredentials())?.refreshToken).toBe('r-B-fresh');
    expect(await h.engine.getActiveId(ruleSlotId(leaseRuleId(B.id)))).toBe(B.id);
    expect((await h.global.readLiveCredentials())?.accessToken).toBe('A');

    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B-fresh');
    expect(await slot.readLiveCredentials()).toBeUndefined();
  });

  it("leaves another stored account's login there alone: ending the session saves that one", async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    const slot = leaseStore(h.paths, B.id);
    await slot.writeLiveCredentials({
      accessToken: 'C2',
      refreshToken: 'r-C2',
      expiresAt: NOW + 20 * HOUR,
    });
    await slot.writeOauthAccount(bundleFor('C').oauthAccount!);
    const res = await h.engine.reloginFromConfigDir(B.id, await freshLoginOf(h, 'B'));
    expect(res.healedLiveLogin).toBe(false);
    expect((await slot.readLiveCredentials())?.refreshToken).toBe('r-C2');
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B-fresh');

    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
    expect((await h.vault.readBundle(C.id)).claudeAiOauth.refreshToken).toBe('r-C2');
  });

  it('adding the account of that login instead keeps it, and the next check ends the session', async () => {
    const { h, B, slot } = await strandedByUnknownLogin();
    const U = await h.engine.captureFromConfigDir('U', await freshLoginOf(h, 'U'));
    h.alive.delete(4120);
    const report = await h.engine.sweepLeases({ mode: 'full', probe: noWorkers });
    expect(report.ended.map((e) => e.accountId)).toEqual([B.id]);
    expect((await h.vault.readBundle(U.id)).claudeAiOauth.refreshToken).toBe('r-U-fresh');
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B');
    expect(await slot.readLiveCredentials()).toBeUndefined();
  });
});

describe('ending a parallel session whose account has no stored login', () => {
  /** A session on B whose Claude Code rotated B's login to B9, after B's stored login was lost (its
   *  bundle file gone): B9 is then the only copy of B's login. `identity` is what the slot's
   *  .claude.json says; `token` the login it holds. */
  async function sessionOnBundlelessB(
    opts: { identity?: object; refreshToken?: string } = {},
  ): Promise<{ h: Harness; B: StoredAccount; C: StoredAccount; me: LeaseHolder }> {
    const h = await harness();
    const { B, C } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    const profile = leaseProfile(h, B.id);
    const rotated = {
      accessToken: 'B9',
      refreshToken: opts.refreshToken ?? 'r-B9',
      expiresAt: NOW + 11 * HOUR,
    };
    await writeFile(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: rotated }));
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify(opts.identity ?? { oauthAccount: bundleFor('B').oauthAccount }),
    );
    await rm(join(h.paths.vaultDir, B.id, 'cred.enc'));
    return { h, B, C, me };
  }

  it("stores the slot's login as the account's own, then ends the session", async () => {
    const { h, B, me } = await sessionOnBundlelessB();
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(res).toMatchObject({ ended: true, adoptedRotation: true });
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('r-B9');
    expect(await leaseStore(h.paths, B.id).readLiveCredentials()).toBeUndefined();
  });

  it.each([
    ['names no account', { oauthAccount: {} }],
    [
      'names another login of the same email',
      { oauthAccount: { accountUuid: 'uuid-Z', emailAddress: 'B@x.com' } },
    ],
  ])('keeps the slot when its identity block %s: login_unadopted', async (_why, identity) => {
    const { h, B, me } = await sessionOnBundlelessB({ identity });
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(res).toMatchObject({ ended: false, deferred: 'login_unadopted' });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.refreshToken).toBe('r-B9');
    expect(await h.vault.hasBundle(B.id)).toBe(false);
  });

  it('keeps the slot when the stored login cannot be read, and never writes over it', async () => {
    const { h, B, me } = await sessionOnBundlelessB();
    const bundleFile = join(h.paths.vaultDir, B.id, 'cred.enc');
    await writeFile(bundleFile, 'not a bundle');
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(res).toMatchObject({ ended: false, deferred: 'login_unadopted' });
    expect((await leaseStore(h.paths, B.id).readLiveCredentials())?.refreshToken).toBe('r-B9');
    expect(await readFile(bundleFile, 'utf8')).toBe('not a bundle');
  });

  it("never stores another account's token as its own: that login is kept with its owner", async () => {
    // The slot holds C's stored token under B's identity.
    const { h, B, C, me } = await sessionOnBundlelessB({ refreshToken: 'r-C' });
    const res = await h.engine.releaseLease(leaseRuleId(B.id), [me], noWorkers);
    expect(res).toMatchObject({ ended: true, adoptedRotation: false });
    expect(await h.vault.hasBundle(B.id)).toBe(false);
    expect((await h.vault.readBundle(C.id)).claudeAiOauth.refreshToken).toBe('r-C');
  });
});
