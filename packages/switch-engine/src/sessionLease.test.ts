// Parallel sessions in the engine: where `--account` runs (plan and claim agreeing on every row),
// creating and joining a session, its crash points, the release, the sweep, and everything else the
// engine must never do to a session's slot while it runs.
//
// Processes are stand-ins: a set of live pids, an injected Windows process table, a fixture /proc.
// The fault seam stands for the process dying at a checkpoint.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { sandboxPaths, groupProfileDir, type Paths } from './paths.js';
import { leaseRuleId } from './folderRules.js';
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
      faultAt: (checkpoint) => {
        if (faults.at === checkpoint) {
          faults.at = undefined;
          throw new Error(`died at ${checkpoint}`);
        }
      },
      leaseProcesses: {
        hostname: () => HOST,
        isAlive: (pid) => alive.has(pid),
        processTable: () => Promise.resolve(table),
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
  h.table.push({ pid, ppid: 1, startMs: start });
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

  it('activate names every session when several terminals hold it', async () => {
    const h = await harness();
    const { B } = await leased(h);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120), child(h, 5188, 5120)]);
    await expect(h.engine.activate(B.id)).rejects.toThrow(
      'account "B" is in use by 2 parallel sessions (pids 4188, 5188)',
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
      'a parallel session of B was logged in as A; that login was moved back to A',
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
      'account "B" is in use by a parallel session (pid 4120); exit it first',
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
  it('two phases: a holder added between them survives', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const me = launcher(h, 4120);
    await h.engine.claimSessionSlot(B.id, me, { launchRuleId: null });
    h.alive.delete(4120);
    const late = launcher(h, 5120);
    const probe: LeaseOccupancyProbe = async () => {
      // Runs in phase 1, without the lock: another terminal joins meanwhile.
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

  it('a lease left with no holder by a concurrent release uses its phase-1 probe', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const one = launcher(h, 4120);
    const two = launcher(h, 5120);
    await h.engine.claimSessionSlot(B.id, one, { launchRuleId: null });
    await h.engine.claimSessionSlot(B.id, two, { launchRuleId: null });
    // Terminal two was killed: phase 1 judges it dead.
    h.alive.delete(5120);
    const worker: LeaseHolder = {
      pid: 6000,
      start: 0,
      host: HOST,
      platform: 'win32',
      role: 'background',
    };
    const probe: LeaseOccupancyProbe = async () => {
      // Terminal one exits between the phases and releases its own holder; two is left on disk.
      await h.engine.releaseLease(leaseRuleId(B.id), [one], noWorkers);
      return [worker];
    };
    await h.engine.sweepLeases({ mode: 'full', probe });
    expect((await h.vault.listRules())[0]?.lease?.holders).toEqual([worker]);
  });

  it('quick: a dead launcher with no recorded child defers; with its child recorded and dead, it ends', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.claimSessionSlot(B.id, launcher(h, 4120), { launchRuleId: null });
    h.alive.delete(4120);
    const quick = await h.engine.sweepLeases({ mode: 'quick', probe: noWorkers });
    expect(quick.deferred.map((d) => d.reason)).toEqual(['unrecorded_child']);
    await h.engine.addLeaseHolders(leaseRuleId(B.id), [child(h, 4188, 4120, NOW + 4188, false)]);
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

  it('a holder on another host is foreign: never swept from here', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const remote: LeaseHolder = {
      pid: 812,
      start: 5,
      host: 'OTHER',
      platform: 'win32',
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
