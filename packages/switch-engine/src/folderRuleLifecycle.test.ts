// Folder-rule lifecycle: includeInFolder, excludeInFolder, resetFolder, ensureRuleLive.
//
// These exercise the operator-facing verbs that create, edit and tear down a folder rule and
// self-heal its slot: the refusals (each must name the offending account or folder, and each must
// leave nothing changed), the hand-offs an include makes when an account it reserves is live in a
// slot that may not hold it afterwards, accounts shared by several rules, which slot may hold whom,
// and the crash-safety contract — a fault injected after each step leaves a state a rerun, the next
// ensureRuleLive, repairSlots or refreshSnapshot converges from, with no account ever live in two
// slots.

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { MAX_RULE_ACCOUNTS, MAX_RULES, Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, folderBindingsPath, type Paths } from './paths.js';
import {
  readFolderBindingSnapshot,
  writeFolderBindingSnapshot,
  type BindEnforceMode,
} from './folderBindings.js';
import { ruleSlotId } from './types.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  FolderBindingSnapshot,
  StoredAccount,
} from './types.js';
import type { Protector } from './dpapi.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  protector: Protector;
  credStore: CredentialStore;
  clock: () => number;
  setNow: (n: number) => void;
  /** Pids the injected liveness probe reports as alive. */
  alive: Set<number>;
  /** A real directory under the sandbox, created and returned canonical. */
  folder: (name: string) => Promise<string>;
  /** Build another engine over the SAME on-disk state (a simulated process restart), optionally
   *  with a fault injector. */
  restart: (faultAt?: (cp: string) => void) => SwitchEngine;
  /** Change the enforcement mode the engine's snapshot resolver returns, simulating a live
   *  `cctl settings set bind-enforce <mode>` under a long-lived daemon. */
  setEnforce: (mode: BindEnforceMode) => void;
}

function makeRefresh(clock: () => number) {
  return (cur: ClaudeOauth): Promise<ClaudeOauth> =>
    Promise.resolve({
      ...cur,
      accessToken: 'refreshed-' + cur.accessToken,
      refreshToken: 'rotated-' + cur.refreshToken,
      expiresAt: clock() + HOUR,
    });
}

// The harness canonicalizes and containment-checks REAL sandbox directories (mkdtemp + realpath),
// so the engine's path rules must match the host filesystem: win32 on Windows, POSIX elsewhere.
// Windows-specific path semantics (drive letters, UNC, ADS) are covered with a mock fs in
// folderPath.test.ts, which is host-independent.
async function harness(platform: NodeJS.Platform = process.platform): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-rule-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });

  let now = NOW;
  const clock = (): number => now;
  const protector = new InsecurePassthroughProtector();
  const alive = new Set<number>();
  // Resolved at each snapshot write, not cached at construction, so a live change is honored by a
  // daemon-side rewrite (see the enforce-resolver test).
  let enforceMode: BindEnforceMode = 'block';
  // Real fs for canonicalization (the sandbox dirs exist), but a sandbox home so the "home dir is
  // refused" rule can be exercised without touching the real user home.
  const bindFs: BindFs = {
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    cwd: () => root,
    homedir: () => join(root, 'home'),
  };
  const mkEngine = (faultAt?: (cp: string) => void): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh: makeRefresh(clock),
      clock,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 60_000,
      lockOptions: { timeoutMs: 2000, pollMs: 10 },
      platform,
      bindFs,
      isProcessAlive: (pid) => alive.has(pid),
      bindEnforce: () => enforceMode,
      ...(faultAt ? { faultAt } : {}),
    });

  const engine = mkEngine();
  const vault = new Vault(paths.vaultDir, protector, clock, undefined, platform);
  return {
    root,
    paths,
    engine,
    vault,
    protector,
    credStore: new CredentialStore(paths),
    clock,
    setNow: (n) => (now = n),
    alive,
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
    restart: (faultAt) => mkEngine(faultAt),
    setEnforce: (mode) => {
      enforceMode = mode;
    },
  };
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function oauth(access: string, expiresAt: number, refresh = 'r-' + access): ClaudeOauth {
  return { accessToken: access, refreshToken: refresh, expiresAt };
}
function bundleFor(access: string, expiresAt: number): CredentialBundle {
  return {
    claudeAiOauth: oauth(access, expiresAt),
    oauthAccount: { accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' },
  };
}

/** The credential store over a rule's profile — how a test reads (or plants) what is live in that
 *  rule's slot without going through the engine it is checking. */
function ruleStore(paths: Paths, ruleId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, ruleId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** The access token physically live in a rule's slot, or undefined when the slot is empty. Every
 *  token in these tests is its account's label, so this names the account. */
async function liveIn(h: Harness, ruleId: string): Promise<string | undefined> {
  return (await ruleStore(h.paths, ruleId).readLiveCredentials())?.accessToken;
}

/** The access token physically live in the global slot. */
async function liveInGlobal(h: Harness): Promise<string | undefined> {
  return (await h.credStore.readLiveCredentials())?.accessToken;
}

/** Plant a newer token for `label` in a rule's slot, the way a session there rotating it would. */
async function rotateInSlot(
  h: Harness,
  ruleId: string,
  label: string,
  refresh: string,
): Promise<void> {
  const store = ruleStore(h.paths, ruleId);
  await store.writeLiveCredentials(oauth(label, NOW + 20 * HOUR, refresh));
  await store.writeOauthAccount({ accountUuid: 'uuid-' + label, emailAddress: label + '@x.com' });
}

/** Record a running Claude Code session with its cwd under `cwd`. */
async function runSession(h: Harness, cwd: string, pid: number): Promise<void> {
  const sessionsDir = join(h.paths.claudeDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `s${pid}.json`), JSON.stringify({ pid, cwd }));
  h.alive.add(pid);
}

/** The guard snapshot on disk; fails the test when none was written. */
async function snapshotOf(h: Harness): Promise<FolderBindingSnapshot> {
  const snap = await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir));
  expect(snap).toBeDefined();
  return snap!;
}

/** The ids of the shared pool (accounts.json), sorted. */
async function sharedIds(h: Harness): Promise<string[]> {
  return (await h.vault.listAccounts()).map((a) => a.id).sort();
}

/** The rule ids a stored account is reserved to (undefined for a shared account). */
async function ruleIdsOf(h: Harness, accountId: string): Promise<string[] | undefined> {
  return (await h.vault.listAllAccounts()).find((a) => a.id === accountId)?.ruleIds;
}

/** The one invariant the slot model exists to protect: no account is live in two slots, neither by
 *  the reconciled view callers read nor by the checker's physical (token-aware) one. */
async function expectOneSlotPerAccount(engine: SwitchEngine): Promise<void> {
  const live = [...(await engine.liveSlots()).values()].filter((v): v is string => v !== null);
  expect(new Set(live).size).toBe(live.length);
  const doubled = (await engine.checkSlots()).filter(
    (v) => v.kind === 'account_in_multiple_slots' || v.kind === 'token_in_multiple_slots',
  );
  expect(doubled).toEqual([]);
}

/** The error a call is refused with — one call, so its code and its message are asserted on the same
 *  refusal (a second call could be refused for a different reason). */
async function refusal(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected the call to be refused');
}

/** A shared account named `label` whose token is far from expiry, so no switch refreshes it. */
function addAccount(h: Harness, label: string): Promise<StoredAccount> {
  return h.engine.addAccount(label, bundleFor(label, NOW + 10 * HOUR));
}

/** Four shared accounts A/B/C/D. */
async function seed(h: Harness) {
  const A = await addAccount(h, 'A');
  const B = await addAccount(h, 'B');
  const C = await addAccount(h, 'C');
  const D = await addAccount(h, 'D');
  return { A, B, C, D };
}

describe('includeInFolder — creating a rule', () => {
  it('reserves the accounts, materializes the profile, seats the first included account, and writes the snapshot', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const deep = await h.folder(join('work', 'deep'));

    const res = await h.engine.includeInFolder(work, [A.id, B.id]);

    expect(res.created).toBe(true);
    expect(res.rule).toMatchObject({ folders: [work], include: [A.id, B.id], exclude: [] });
    expect(res.reserved).toEqual([A.id, B.id]);
    expect(res.unexcluded).toEqual([]);
    expect(res.handedOff).toEqual([]);
    expect(res.live).toMatchObject({
      ruleId: res.rule.id,
      liveAccount: A.id,
      activated: true,
      noWorkingAccount: false,
    });
    expect(res.rule.activeId).toBe(A.id);
    // The rows moved out of the shared pool; the listing tags each with the rule including it.
    expect(await sharedIds(h)).toEqual([C.id, D.id].sort());
    expect(await ruleIdsOf(h, A.id)).toEqual([res.rule.id]);
    // A is live in the rule's own profile, which is the slot's config dir; nothing in global.
    const slot = ruleSlotId(res.rule.id);
    expect(h.engine.configDirForSlot(slot)).toBe(groupProfileDir(h.paths.vaultDir, res.rule.id));
    expect(await liveIn(h, res.rule.id)).toBe('A');
    expect(await h.engine.getActiveId(slot)).toBe(A.id);
    expect(await h.engine.getActiveId('global')).toBeNull();
    // The folder and everything under it resolve to the rule.
    expect(await h.engine.resolveFolderRule(deep)).toEqual({ ruleId: res.rule.id, folder: work });
    // The snapshot names the rule with its included accounts.
    const snap = await snapshotOf(h);
    expect(snap.groups.map((g) => g.id)).toEqual([res.rule.id]);
    expect(snap.groups[0]!.members).toEqual(['A', 'B']);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('labels the rule with the folder unless a label is given', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');

    const plain = await h.engine.includeInFolder(work, [A.id]);
    const named = await h.engine.includeInFolder(other, [B.id], { label: 'Client' });

    expect(plain.rule.label).toBe(work);
    expect(named.rule.label).toBe('Client');
  });

  it('is idempotent when the same accounts are included again', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]);
    h.setNow(NOW + 5 * 60_000);

    const again = await h.engine.includeInFolder(work, [A.id, B.id]);

    expect(again.created).toBe(false);
    expect(again.rule.id).toBe(first.rule.id);
    expect(again.rule.folders).toEqual([work]);
    expect(again.rule.include).toEqual([A.id, B.id]);
    // Nothing new was reserved, and the slot kept its account rather than being re-written.
    expect(again.reserved).toEqual([]);
    expect(again.live).toMatchObject({ liveAccount: A.id, activated: false });
  });

  it('adds to the include list of a folder that already has a rule (it does not replace it)', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]);

    // An include only ever adds to a folder's rule; it never replaces the accounts already there.
    const res = await h.engine.includeInFolder(work, [C.id, D.id]);

    expect(res.created).toBe(false);
    expect(res.rule.id).toBe(first.rule.id);
    expect(res.rule.include).toEqual([A.id, B.id, C.id, D.id]);
    expect(res.reserved).toEqual([C.id, D.id]);
    // The slot already runs on an included account, so it stays.
    expect(res.live).toMatchObject({ liveAccount: A.id, activated: false });
    expect(await h.engine.listRules()).toHaveLength(1);
    expect(await sharedIds(h)).toEqual([]);
  });

  it('gives a nested subfolder its own rule (longest match wins)', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const sub = await h.folder(join('work', 'sub'));
    const deep = await h.folder(join('work', 'sub', 'deep'));

    const outer = await h.engine.includeInFolder(work, [A.id, B.id]);
    const inner = await h.engine.includeInFolder(sub, [C.id, D.id]);

    expect(outer.rule.id).not.toBe(inner.rule.id);
    expect(await h.engine.listRules()).toHaveLength(2);
    expect((await h.engine.resolveFolderRule(work))?.ruleId).toBe(outer.rule.id);
    expect((await h.engine.resolveFolderRule(deep))?.ruleId).toBe(inner.rule.id);
    expect(await liveIn(h, inner.rule.id)).toBe('C');
  });

  it('returns the sessions whose pid is alive and cwd is within the folder', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    // One alive session inside the folder, one alive outside it, one dead inside.
    await runSession(h, join(work, 'x'), 4242);
    await runSession(h, join(h.root, 'elsewhere'), 4343);
    const sessionsDir = join(h.paths.claudeDir, 'sessions');
    await writeFile(join(sessionsDir, 'dead.json'), JSON.stringify({ pid: 9999, cwd: work }));

    const res = await h.engine.includeInFolder(work, [A.id, B.id]);
    expect(res.runningSessions.map((s) => s.pid)).toEqual([4242]);
  });
});

describe('includeInFolder — the slot moves onto an included account', () => {
  it('moves an existing rule slot off an inherited account onto a newly included available one', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    // An exclude-only rule runs on the inherited pool: A, the first available shared account.
    const excl = await h.engine.excludeInFolder(work, [D.id]);
    expect(excl.live.liveAccount).toBe(A.id);

    // A deliberate include puts the folder on its own account at once.
    const res = await h.engine.includeInFolder(work, [B.id]);

    expect(res.created).toBe(false);
    expect(res.handedOff).toEqual([]);
    expect(res.live).toMatchObject({ liveAccount: B.id, activated: true });
    expect(await liveIn(h, res.rule.id)).toBe('B');
    // A is free again and still shared; the pool lists the included account first.
    expect(await sharedIds(h)).toEqual([A.id, C.id, D.id].sort());
    const pool = await h.engine.slotPool(ruleSlotId(res.rule.id));
    expect(pool.map((e) => [e.account.id, e.source, e.liveElsewhere])).toEqual([
      [B.id, 'include', null],
      [A.id, 'inherited', null],
      [C.id, 'inherited', null],
    ]);
    await expectOneSlotPerAccount(h.engine);
  });

  it('keeps the account the folder already runs on when that is the one included', async () => {
    const h = await harness();
    const { A, D } = await seed(h);
    const work = await h.folder('work');
    await h.engine.excludeInFolder(work, [D.id]); // A live there as an inherited account

    const res = await h.engine.includeInFolder(work, [A.id]);

    // The folder's own slot may keep it: no hand-off, no re-write.
    expect(res.reserved).toEqual([A.id]);
    expect(res.handedOff).toEqual([]);
    expect(res.live).toMatchObject({ liveAccount: A.id, activated: false });
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('moves an excluded account to the include list and seats it', async () => {
    const h = await harness();
    const { C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.excludeInFolder(work, [C.id]); // A live there

    // The newer instruction wins: C is no longer excluded but included, and used first.
    const res = await h.engine.includeInFolder(work, [C.id]);

    expect(res.unexcluded).toEqual([C.id]);
    expect(res.reserved).toEqual([C.id]);
    expect(res.rule.include).toEqual([C.id]);
    expect(res.rule.exclude).toEqual([]);
    expect(res.live).toMatchObject({ liveAccount: C.id, activated: true });
    expect(await liveIn(h, res.rule.id)).toBe('C');
    expect(await sharedIds(h)).not.toContain(C.id);
  });
});

describe('includeInFolder — handing slots off a newly reserved account', () => {
  it('moves the global slot off an included account onto the best remaining shared one, adopting its rotation', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    await h.engine.activate(A.id); // A is the global live account
    // A session in the global slot rotated A's token since it was stored.
    await h.credStore.writeLiveCredentials(oauth('A', NOW + 20 * HOUR, 'rot-A'));
    const work = await h.folder('work');

    const res = await h.engine.includeInFolder(work, [A.id]);

    expect(res.handedOff).toEqual([{ slot: 'global', from: A.id, to: B.id }]);
    expect(await h.engine.getActiveId('global')).toBe(B.id);
    expect(await liveInGlobal(h)).toBe('B');
    // A is live only in its rule's slot, carrying the rotated token the hand-off saved.
    expect(await h.engine.getActiveId(ruleSlotId(res.rule.id))).toBe(A.id);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-A');
    expect((await ruleStore(h.paths, res.rule.id).readLiveCredentials())?.refreshToken).toBe(
      'rot-A',
    );
    await expectOneSlotPerAccount(h.engine);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('never hands the global slot an account live in a rule slot', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(A.id);
    const other = await h.folder('other');
    const excl = await h.engine.excludeInFolder(other, [D.id]);
    expect(excl.live.liveAccount).toBe(B.id); // A is live in global, so the rule took B
    const work = await h.folder('work');

    const res = await h.engine.includeInFolder(work, [A.id]);

    // B is first in pool order but live in the other folder's slot, so global takes C.
    expect(res.handedOff).toEqual([{ slot: 'global', from: A.id, to: C.id }]);
    expect(await liveInGlobal(h)).toBe('C');
    expect(await liveIn(h, excl.rule.id)).toBe('B');
    await expectOneSlotPerAccount(h.engine);
  });

  it('refuses (nothing changed) when the only other shared account is quarantined', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    await h.vault.quarantine(B.id, 'dead'); // B cannot hold global
    await h.engine.activate(A.id);
    const work = await h.folder('work');

    const err = await refusal(h.engine.includeInFolder(work, [A.id]));

    expect(err.code).toBe('no_shared_account_remains');
    expect(err.message).toContain('"A"');
    // Unchanged: A still shared and globally live, no rule.
    expect(await h.engine.listRules()).toEqual([]);
    expect(await sharedIds(h)).toEqual([A.id, B.id].sort());
    expect(await h.engine.getActiveId('global')).toBe(A.id);
    expect(await liveInGlobal(h)).toBe('A');
  });

  it('refuses (nothing changed) when the only other shared account is live in a rule slot', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    await h.engine.activate(A.id);
    const other = await h.folder('other');
    const excl = await h.engine.excludeInFolder(other, [A.id]); // B live there
    expect(excl.live.liveAccount).toBe(B.id);
    const work = await h.folder('work');

    const err = await refusal(h.engine.includeInFolder(work, [A.id]));

    // The global slot keeps the last shared account rather than take one a folder is using.
    expect(err.code).toBe('no_shared_account_remains');
    expect(await h.engine.listRules()).toHaveLength(1);
    expect(await sharedIds(h)).toEqual([A.id, B.id].sort());
    expect(await liveInGlobal(h)).toBe('A');
    expect(await liveIn(h, excl.rule.id)).toBe('B');
  });

  it("moves another rule's slot off a shared account it is about to stop holding", async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    const other = await h.folder('other');
    const excl = await h.engine.excludeInFolder(other, [D.id]);
    expect(excl.live.liveAccount).toBe(A.id); // A runs the other folder as an inherited account
    const work = await h.folder('work');

    const res = await h.engine.includeInFolder(work, [A.id]);

    // Reserved to work, A leaves the other folder's pool, so that slot moves to its next account.
    const otherSlot = ruleSlotId(excl.rule.id);
    expect(res.handedOff).toEqual([{ slot: otherSlot, from: A.id, to: B.id }]);
    expect(await liveIn(h, excl.rule.id)).toBe('B');
    expect((await h.engine.getRule(excl.rule.id))?.activeId).toBe(B.id);
    expect(await liveIn(h, res.rule.id)).toBe('A');
    await expectOneSlotPerAccount(h.engine);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it("refuses (nothing changed) when that other rule's slot has nothing else to move to", async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    const C = await addAccount(h, 'C');
    await h.engine.activate(B.id);
    const other = await h.folder('other');
    // The other folder's pool is A and B (C excluded); B is live in global, so it runs on A.
    const excl = await h.engine.excludeInFolder(other, [C.id]);
    expect(excl.live.liveAccount).toBe(A.id);
    const work = await h.folder('work');

    const err = await refusal(h.engine.includeInFolder(work, [A.id]));

    expect(err.code).toBe('no_account_remains');
    expect(err.message).toContain('"A"');
    expect(err.message).toContain(other);
    expect(await h.engine.listRules()).toHaveLength(1);
    expect(await sharedIds(h)).toContain(A.id);
    expect(await liveIn(h, excl.rule.id)).toBe('A');
    expect(await liveInGlobal(h)).toBe('B');
  });

  it('refuses an include over the account cap before moving the global slot off anyone', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    await addAccount(h, 'R'); // a ready global replacement
    const extra: string[] = [];
    for (let i = 0; i < MAX_RULE_ACCOUNTS; i += 1) {
      extra.push((await h.vault.addAccount(`M${i}`, bundleFor(`M${i}`, NOW + 10 * HOUR))).id);
    }
    await h.engine.activate(A.id);
    const work = await h.folder('work');

    // A plus the cap's worth of others is one account too many for a rule.
    await expect(h.engine.includeInFolder(work, [A.id, ...extra])).rejects.toThrow(
      `cannot include more than ${MAX_RULE_ACCOUNTS} accounts`,
    );
    // Nothing moved: A is still the global live account and no rule exists.
    expect(await h.engine.getActiveId('global')).toBe(A.id);
    expect(await liveInGlobal(h)).toBe('A');
    expect(await h.engine.listRules()).toEqual([]);
  });

  it('refuses a rule past the rule cap before moving the global slot off anyone', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    await addAccount(h, 'R');
    for (let i = 0; i < MAX_RULES; i += 1) {
      const x = await h.vault.addAccount(`X${i}`, bundleFor(`X${i}`, NOW + 10 * HOUR));
      await h.vault.createRule({ folders: [], include: [x.id] });
    }
    await h.engine.activate(A.id);
    const work = await h.folder('work');

    await expect(h.engine.includeInFolder(work, [A.id])).rejects.toThrow(
      `cannot create another folder rule (max ${MAX_RULES})`,
    );
    expect(await h.engine.getActiveId('global')).toBe(A.id);
    expect(await liveInGlobal(h)).toBe('A');
    expect(await h.engine.listRules()).toHaveLength(MAX_RULES);
  });
});

describe('includeInFolder — one account included by several folders', () => {
  it('adds an account already reserved to another rule (those folders share it)', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]);

    // Several folders may include one account: they share it.
    const res = await h.engine.includeInFolder(other, [A.id, C.id]);

    expect(res.rule.include).toEqual([A.id, C.id]);
    // Only C moved out of the shared pool; A was reserved already.
    expect(res.reserved).toEqual([C.id]);
    expect(res.handedOff).toEqual([]);
    expect(await ruleIdsOf(h, A.id)).toEqual([first.rule.id, res.rule.id]);
    // A stays live where it is; the second folder takes its next included account.
    expect(await liveIn(h, first.rule.id)).toBe('A');
    expect(res.live).toMatchObject({ liveAccount: C.id, activated: true });
    await expectOneSlotPerAccount(h.engine);
  });

  it('never seats a shared include in both slots; the second folder takes another available account', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id]);

    const second = await h.engine.includeInFolder(other, [A.id]);

    // A is included by both but live in the first; the second falls back to the inherited pool.
    expect(second.live).toMatchObject({ liveAccount: B.id, activated: true });
    const pool = await h.engine.slotPool(ruleSlotId(second.rule.id));
    expect(pool[0]).toMatchObject({
      account: { id: A.id },
      source: 'include',
      liveElsewhere: ruleSlotId(first.rule.id),
    });
    // Nor can it be forced in: an account is live in one slot at a time.
    const err = await refusal(
      h.engine.activate(A.id, { slot: ruleSlotId(second.rule.id), force: true }),
    );
    expect(err.code).toBe('live_elsewhere');
    expect(await liveIn(h, second.rule.id)).toBe('B');
    await expectOneSlotPerAccount(h.engine);
  });

  it('lets the second folder take the account once the first releases it', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id]);
    await h.engine.includeInFolder(other, [A.id]);
    // The second folder's only other accounts are excluded, so while A is busy it has none.
    const second = await h.engine.excludeInFolder(other, [B.id, C.id, D.id], { force: true });
    expect(second.live).toMatchObject({ liveAccount: null, noWorkingAccount: true });

    await h.engine.resetFolder(work);

    // A is still reserved (the second folder includes it), and free: the self-heal seats it.
    expect(await ruleIdsOf(h, A.id)).toEqual([second.rule.id]);
    const res = await h.engine.ensureRuleLive(second.rule.id);
    expect(res).toMatchObject({ liveAccount: A.id, activated: true, noWorkingAccount: false });
    expect(await liveIn(h, second.rule.id)).toBe('A');
    expect(await liveIn(h, first.rule.id)).toBeUndefined();
    await expectOneSlotPerAccount(h.engine);
  });

  it('switches a shared include in the slot it is live in, and asks for a slot when it is live in none', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]);
    const second = await h.engine.includeInFolder(other, [A.id, C.id]);

    // Live in the first folder: an unnamed switch to A is a heal there, not a move.
    await h.engine.activate(A.id);
    expect(await liveIn(h, first.rule.id)).toBe('A');
    expect(await liveIn(h, second.rule.id)).toBe('C');

    // Live in neither: no single slot is right, so the caller must name one.
    await h.engine.activate(B.id, { force: true });
    const err = await refusal(h.engine.activate(A.id));
    expect(err.code).toBe('slot_ambiguous');
    expect(err.message).toContain(work);
    expect(err.message).toContain(other);

    await h.engine.activate(A.id, { slot: ruleSlotId(second.rule.id), force: true });
    expect(await liveIn(h, second.rule.id)).toBe('A');
    await expectOneSlotPerAccount(h.engine);
  });
});

describe('includeInFolder / excludeInFolder — refusals name the offender', () => {
  it('refuses an unknown account and an empty account list, creating nothing', async () => {
    const h = await harness();
    await seed(h);
    const work = await h.folder('work');

    for (const verb of ['include', 'exclude'] as const) {
      const run = (ids: string[]): Promise<unknown> =>
        verb === 'include'
          ? h.engine.includeInFolder(work, ids)
          : h.engine.excludeInFolder(work, ids);
      const unknown = await refusal(run(['no-such-id']));
      expect(unknown.code).toBe('unknown_account');
      expect(unknown.message).toContain('no-such-id');
      // Nothing ever stands in for a missing account — least of all the one in use.
      const none = await refusal(run([]));
      expect(none.code).toBe('no_accounts_named');
      expect(none.message).toContain('named explicitly');
    }
    expect(await h.engine.listRules()).toEqual([]);
  });

  it('refuses the home dir, the vault dir, a nonexistent dir, and a filesystem root', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const refused = [
      join(h.root, 'home'),
      h.paths.vaultDir,
      join(h.root, 'nope'),
      parse(h.root).root,
    ];
    for (const folder of refused) {
      expect((await refusal(h.engine.includeInFolder(folder, [A.id]))).code).toBe('bind_refused');
      expect((await refusal(h.engine.excludeInFolder(folder, [A.id]))).code).toBe('bind_refused');
    }
    expect(await h.engine.listRules()).toEqual([]);
    expect(await sharedIds(h)).toEqual([A.id, B.id, C.id, D.id].sort());
  });

  it('refuses on macOS', async () => {
    const h = await harness('darwin');
    const { A } = await seed(h);
    const work = await h.folder('work');
    expect((await refusal(h.engine.includeInFolder(work, [A.id]))).code).toBe(
      'group_slot_unsupported',
    );
    expect((await refusal(h.engine.excludeInFolder(work, [A.id]))).code).toBe(
      'group_slot_unsupported',
    );
    expect(await h.engine.listRules()).toEqual([]);
  });
});

describe('excludeInFolder', () => {
  it('refuses an account this rule includes, naming it, with nothing changed', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id]);

    const err = await refusal(h.engine.excludeInFolder(work, [A.id]));

    expect(err.message).toContain('"A" is included by this folder rule');
    expect(await h.engine.getRule(inc.rule.id)).toMatchObject({ include: [A.id], exclude: [] });
    expect(await liveIn(h, inc.rule.id)).toBe('A');
  });

  it('refuses an account reserved to another folder, naming it, with nothing changed', async () => {
    const h = await harness();
    const { A, D } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    await h.engine.includeInFolder(work, [A.id]);

    // On a folder with no rule: no rule is created.
    const fresh = await refusal(h.engine.excludeInFolder(other, [A.id]));
    expect(fresh.message).toContain('"A" is reserved to');
    expect(fresh.message).toContain(work);
    expect(await h.engine.listRules()).toHaveLength(1);

    // On a folder with a rule: the rule is left as it was.
    const excl = await h.engine.excludeInFolder(other, [D.id]);
    const existing = await refusal(h.engine.excludeInFolder(other, [A.id]));
    expect(existing.message).toContain('only a shared account can be excluded');
    expect((await h.engine.getRule(excl.rule.id))?.exclude).toEqual([D.id]);
  });

  it('gives an exclude-only folder its own slot, seated with an available account not live in global', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(A.id);
    const work = await h.folder('work');

    const res = await h.engine.excludeInFolder(work, [D.id]);

    expect(res.created).toBe(true);
    expect(res.movedOff).toBeNull();
    expect(res.rule).toMatchObject({ folders: [work], include: [], exclude: [D.id] });
    // A is first in the pool but live in global, so the folder runs on B.
    expect(res.live).toMatchObject({ liveAccount: B.id, activated: true });
    expect(await liveIn(h, res.rule.id)).toBe('B');
    expect(await liveInGlobal(h)).toBe('A');
    // Excluding reserves nothing.
    expect(await sharedIds(h)).toEqual([A.id, B.id, C.id, D.id].sort());
    const pool = await h.engine.slotPool(ruleSlotId(res.rule.id));
    expect(pool.map((e) => [e.account.id, e.liveElsewhere])).toEqual([
      [A.id, 'global'],
      [B.id, null],
      [C.id, null],
    ]);
    await expectOneSlotPerAccount(h.engine);
  });

  it('moves the slot to the next available account when the live one is excluded', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    await h.engine.excludeInFolder(work, [D.id]); // B live there

    const res = await h.engine.excludeInFolder(work, [B.id]);

    expect(res.created).toBe(false);
    expect(res.movedOff).toBe(B.id);
    expect(res.rule.exclude).toEqual([D.id, B.id]);
    expect(res.live).toMatchObject({ liveAccount: C.id, activated: true });
    expect(await liveIn(h, res.rule.id)).toBe('C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('with nothing left to switch to, refuses while a session runs and writes nothing', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const excl = await h.engine.excludeInFolder(work, [A.id]); // B live there
    await runSession(h, work, 7777);

    const err = await refusal(h.engine.excludeInFolder(work, [B.id]));

    expect(err.code).toBe('sessions_running');
    expect(err.message).toContain('excluding "B"');
    expect(err.message).toContain(work);
    expect((await h.engine.getRule(excl.rule.id))?.exclude).toEqual([A.id]);
    expect(await liveIn(h, excl.rule.id)).toBe('B');
  });

  it('with nothing left to switch to, forced, adopts the rotation and clears the slot', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const excl = await h.engine.excludeInFolder(work, [A.id]); // B live there
    await runSession(h, work, 7777);
    await rotateInSlot(h, excl.rule.id, 'B', 'rot-B');

    const res = await h.engine.excludeInFolder(work, [B.id], { force: true });

    expect(res.movedOff).toBe(B.id);
    expect(res.rule.exclude).toEqual([A.id, B.id]);
    expect(res.live).toMatchObject({
      liveAccount: null,
      activated: false,
      noWorkingAccount: true,
      clearedSquatter: true,
    });
    expect(res.runningSessions.map((s) => s.pid)).toEqual([7777]);
    // The slot fails closed, and clearing it cost B nothing: its rotated token reached the vault.
    expect(await liveIn(h, excl.rule.id)).toBeUndefined();
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('rot-B');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('with nothing left to switch to and no session running, clears the slot without force', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const excl = await h.engine.excludeInFolder(work, [A.id]);

    const res = await h.engine.excludeInFolder(work, [B.id]);

    expect(res.live).toMatchObject({ liveAccount: null, noWorkingAccount: true });
    expect(res.runningSessions).toEqual([]);
    expect(await liveIn(h, excl.rule.id)).toBeUndefined();
    // The emptied slot's record is cleared with it, so nothing reads B as live there any more.
    expect((await h.engine.getRule(excl.rule.id))?.activeId).toBeNull();
    expect((await h.engine.liveSlots()).get(ruleSlotId(excl.rule.id))).toBeNull();
    // B left the folder's slot, so the global slot may take it again — and B is then live in that
    // one slot alone, by every reader.
    await h.engine.activate(B.id, { force: true });
    expect(await liveInGlobal(h)).toBe('B');
    expect(await h.engine.checkSlots()).toEqual([]);
    const live = [...(await h.engine.liveSlots()).values()].filter((v) => v === B.id);
    expect(live).toHaveLength(1);
  });

  it('an account whose slot was emptied is placed by where it is live next, not the stale record', async () => {
    // A slot that could seat nothing is cleared; were its record left naming the evicted account,
    // every reader falling back on it would put that account live in an empty slot — and route its
    // sessions to a profile with no login.
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    const work = await h.folder('work');
    const other = await h.folder('other');
    const inc = await h.engine.includeInFolder(work, [A.id]);
    await h.engine.excludeInFolder(work, [B.id]);
    const second = await h.engine.includeInFolder(other, [A.id]);
    // Removing A from the work folder leaves it nothing it may use: its slot is cleared.
    const reset = await h.engine.resetFolder(work, [A.id]);
    expect(reset.dissolved).toBe(false);
    expect((await h.engine.getRule(inc.rule.id))?.activeId).toBeNull();

    await h.engine.activate(A.id, { force: true });

    const slots = await h.engine.liveSlots();
    expect(slots.get(ruleSlotId(second.rule.id))).toBe(A.id);
    expect(slots.get(ruleSlotId(inc.rule.id))).toBeNull();
    expect(await h.engine.configDirForAccount(A.id)).toBe(
      groupProfileDir(h.paths.vaultDir, second.rule.id),
    );
    expect((await h.engine.liveSlotToken(A.id))?.slot).toBe(ruleSlotId(second.rule.id));
  });
});

describe('resetFolder — dissolving a rule', () => {
  it('releases its accounts, clears the live seat and slot state, keeps the profile, and drops it from the snapshot', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);
    const profileDir = groupProfileDir(h.paths.vaultDir, inc.rule.id);
    const stateDir = join(h.paths.vaultDir, 'slots', inc.rule.id);
    expect(existsSync(stateDir)).toBe(true);

    const res = await h.engine.resetFolder(work);

    expect(res).toMatchObject({ folder: work, dissolved: true, runningSessions: [] });
    expect(res.released.sort()).toEqual([A.id, B.id].sort());
    expect(await sharedIds(h)).toEqual([A.id, B.id, C.id, D.id].sort());
    expect(await h.engine.listRules()).toEqual([]);
    // Profile dir kept (its history), but its login gone and its recovery state discarded.
    expect(existsSync(profileDir)).toBe(true);
    expect(existsSync(join(profileDir, '.credentials.json'))).toBe(false);
    expect(await ruleStore(h.paths, inc.rule.id).readOauthAccount()).toBeUndefined();
    expect(existsSync(stateDir)).toBe(false);
    expect((await snapshotOf(h)).groups).toEqual([]);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('refuses while a session runs under the folder, naming it, and proceeds with force', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);
    await runSession(h, work, 7777);

    const err = await refusal(h.engine.resetFolder(work));
    expect(err.code).toBe('sessions_running');
    expect(err.message).toContain(work);
    expect(await liveIn(h, inc.rule.id)).toBe('A');

    const res = await h.engine.resetFolder(work, undefined, { force: true });
    expect(res.dissolved).toBe(true);
    expect(res.runningSessions.map((s) => s.pid)).toEqual([7777]);
  });

  it('adopts a profile-side token rotation into the vault before clearing', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in profile
    await rotateInSlot(h, inc.rule.id, 'A', 'rot-A');

    const res = await h.engine.resetFolder(work);

    expect(res.adoptedRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-A');
  });

  it('drops only that folder from a migrated multi-folder rule, keeping its slot live', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const also = await h.folder('also');
    // A rule gets one folder when it is made; only a file migrated from the older set-bound
    // schema can give one rule two folders.
    const rows = await h.vault.listAccounts();
    const ruleId = randomUUID();
    await writeFile(
      join(h.paths.vaultDir, 'groups.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        groups: [
          {
            id: ruleId,
            label: 'legacy',
            members: rows.filter((r) => r.id === A.id || r.id === B.id),
            activeId: null,
            folders: [work, also],
            createdAtMs: NOW,
            updatedAtMs: NOW,
          },
        ],
      }),
    );
    expect(await h.engine.getRule(ruleId)).toMatchObject({ include: [A.id, B.id], exclude: [] });
    expect(await sharedIds(h)).toEqual([C.id, D.id].sort());
    await h.engine.ensureRuleLive(ruleId);

    const res = await h.engine.resetFolder(work);

    expect(res).toMatchObject({ dissolved: false, released: [], adoptedRotation: false });
    expect(res.rule?.folders).toEqual([also]);
    expect(await liveIn(h, ruleId)).toBe('A');
    expect((await snapshotOf(h)).groups.flatMap((g) => g.folders)).toEqual([also]);
    expect(await h.engine.resolveFolderRule(work)).toBeNull();

    // Its last folder dissolves it.
    const last = await h.engine.resetFolder(also);
    expect(last.dissolved).toBe(true);
    expect(last.released.sort()).toEqual([A.id, B.id].sort());
  });
});

describe('resetFolder — removing named accounts', () => {
  it('removes an exclusion, leaving the include list and the slot alone', async () => {
    const h = await harness();
    const { A, D } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id]);
    await h.engine.excludeInFolder(work, [D.id]);

    const res = await h.engine.resetFolder(work, [D.id]);

    expect(res).toMatchObject({ dissolved: false, released: [] });
    expect(res.rule).toMatchObject({ include: [A.id], exclude: [] });
    expect(await sharedIds(h)).toContain(D.id);
    expect(await liveIn(h, inc.rule.id)).toBe('A');
  });

  it('returns an account no rule includes any more to the shared pool', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);

    const res = await h.engine.resetFolder(work, [B.id]);

    expect(res.released).toEqual([B.id]);
    expect(res.rule?.include).toEqual([A.id]);
    expect(await sharedIds(h)).toContain(B.id);
    expect(await ruleIdsOf(h, B.id)).toBeUndefined();
    expect(await liveIn(h, inc.rule.id)).toBe('A');
    expect((await snapshotOf(h)).groups[0]!.members).toEqual(['A']);
  });

  it('keeps a released live account in the slot as an inherited one, out of the global slot', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);

    const res = await h.engine.resetFolder(work, [A.id]);

    // Shared again and not excluded, A may stay where it is live; the slot is not churned.
    expect(res.released).toEqual([A.id]);
    expect(await liveIn(h, inc.rule.id)).toBe('A');
    expect(await h.engine.checkSlots()).toEqual([]);
    // ...which keeps it out of the global slot until the folder moves off it.
    const err = await refusal(h.engine.activate(A.id));
    expect(err.code).toBe('live_elsewhere');
    expect(await liveInGlobal(h)).toBeUndefined();
  });

  it('keeps an account reserved while another rule still includes it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]);
    await h.engine.includeInFolder(other, [A.id, C.id]);

    const res = await h.engine.resetFolder(other, [A.id]);

    expect(res.released).toEqual([]);
    expect(res.rule?.include).toEqual([C.id]);
    expect(await sharedIds(h)).not.toContain(A.id);
    expect(await ruleIdsOf(h, A.id)).toEqual([first.rule.id]);
  });

  it('moves the slot off a live account it un-includes while another rule still reserves it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in work
    const second = await h.engine.includeInFolder(other, [A.id, C.id]); // C live in other

    const res = await h.engine.resetFolder(work, [A.id]);

    // Reserved to the other folder only, A may no longer be live in this one.
    expect(res).toMatchObject({ dissolved: false, released: [] });
    expect(res.rule?.include).toEqual([B.id]);
    expect(await liveIn(h, first.rule.id)).toBe('B');
    expect(await liveIn(h, second.rule.id)).toBe('C');
    expect(await ruleIdsOf(h, A.id)).toEqual([second.rule.id]);
    expect(await h.engine.checkSlots()).toEqual([]);
    // A is free now, so the folder that still includes it can switch to it.
    await h.engine.activate(A.id, { force: true });
    expect(await liveIn(h, second.rule.id)).toBe('A');
    await expectOneSlotPerAccount(h.engine);
  });

  it('dissolves a rule left with nothing to include or exclude', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id]);

    const res = await h.engine.resetFolder(work, [A.id]);

    expect(res).toMatchObject({ dissolved: true, released: [A.id] });
    expect(await h.engine.listRules()).toEqual([]);
    expect(await sharedIds(h)).toContain(A.id);
    expect(await liveIn(h, inc.rule.id)).toBeUndefined();
  });

  it('refuses a folder with no rule, and an account the rule does not name, naming each', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const inc = await h.engine.includeInFolder(work, [A.id]);

    const noRule = await refusal(h.engine.resetFolder(other));
    expect(noRule.code).toBe('not_ruled');
    expect(noRule.message).toContain(other);

    const notIn = await refusal(h.engine.resetFolder(work, [C.id]));
    expect(notIn.code).toBe('not_in_rule');
    expect(notIn.message).toContain('"C"');

    expect((await refusal(h.engine.resetFolder(work, ['no-such-id']))).code).toBe(
      'unknown_account',
    );
    expect((await refusal(h.engine.resetFolder(work, []))).code).toBe('no_accounts_named');
    expect(await h.engine.getRule(inc.rule.id)).toMatchObject({ include: [A.id], exclude: [] });
    expect(await liveIn(h, inc.rule.id)).toBe('A');
  });

  it('clears the rule of a folder that has since been deleted', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id]);
    await rm(work, { recursive: true, force: true });

    const res = await h.engine.resetFolder(work);

    expect(res.dissolved).toBe(true);
    expect(await sharedIds(h)).toContain(A.id);
  });
});

describe('activate — which slot may hold whom', () => {
  it('never puts a reserved account in the global slot, writing nothing', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    await h.engine.activate(B.id);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id]);
    h.setNow(NOW + HOUR);

    const err = await refusal(h.engine.activate(A.id, { slot: 'global', force: true }));

    expect(err.code).toBe('slot_mismatch');
    expect(err.message).toContain('"A"');
    expect(await liveInGlobal(h)).toBe('B');
    expect(await h.engine.getActiveId('global')).toBe(B.id);
  });

  it('never puts a shared account live in a rule slot in the global slot, writing nothing', async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const excl = await h.engine.excludeInFolder(work, [D.id]); // B live there
    h.setNow(NOW + HOUR);

    for (const opts of [{ slot: 'global' as const, force: true }, { force: true }]) {
      const err = await refusal(h.engine.activate(B.id, opts));
      expect(err.code).toBe('live_elsewhere');
      expect(err.message).toContain('"B"');
    }
    expect(await liveInGlobal(h)).toBe('A');
    expect(await h.engine.getActiveId('global')).toBe(A.id);
    expect(await liveIn(h, excl.rule.id)).toBe('B');
  });

  it('refuses a rule slot an account it excludes or one reserved only to another rule', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    await h.engine.includeInFolder(other, [B.id]);
    const excl = await h.engine.excludeInFolder(work, [D.id]); // A live there
    const slot = ruleSlotId(excl.rule.id);
    h.setNow(NOW + HOUR);

    const excluded = await refusal(h.engine.activate(D.id, { slot, force: true }));
    expect(excluded.code).toBe('slot_mismatch');
    expect(excluded.message).toContain('that folder excludes it');
    const foreign = await refusal(h.engine.activate(B.id, { slot, force: true }));
    expect(foreign.code).toBe('slot_mismatch');
    expect(foreign.message).toContain('reserved to other folders');
    expect(await liveIn(h, excl.rule.id)).toBe('A');
    expect((await h.engine.getRule(excl.rule.id))?.activeId).toBe(A.id);

    // A shared account the rule does not exclude is in its pool, so the slot may take it.
    await h.engine.activate(C.id, { slot, force: true });
    expect(await liveIn(h, excl.rule.id)).toBe('C');
    expect((await h.engine.getRule(excl.rule.id))?.activeId).toBe(C.id);
  });
});

describe('ensureRuleLive', () => {
  it('keeps a legitimate live account without re-writing it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);

    const res = await h.engine.ensureRuleLive(inc.rule.id);

    expect(res).toEqual({
      ruleId: inc.rule.id,
      liveAccount: A.id,
      activated: false,
      noWorkingAccount: false,
    });
  });

  it('heals a recorded active account that drifted from the live login', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);
    // A login inside the profile put B live without telling the registry.
    const store = ruleStore(h.paths, inc.rule.id);
    await store.writeLiveCredentials(oauth('B', NOW + 10 * HOUR));
    await store.writeOauthAccount({ accountUuid: 'uuid-B', emailAddress: 'B@x.com' });
    expect((await h.engine.checkSlots()).map((v) => v.kind)).toEqual(['rule_active_mismatch']);

    const res = await h.engine.ensureRuleLive(inc.rule.id);

    // B may be there, so it is kept and committed rather than switched away from.
    expect(res).toMatchObject({ liveAccount: B.id, activated: false });
    expect((await h.engine.getRule(inc.rule.id))?.activeId).toBe(B.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('re-seats the recorded account first when the live file went missing', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);
    h.setNow(NOW + HOUR);
    await h.engine.activate(B.id); // B, second in pool order, is the recorded account
    await rm(join(groupProfileDir(h.paths.vaultDir, inc.rule.id), '.credentials.json'), {
      force: true,
    });

    const res = await h.engine.ensureRuleLive(inc.rule.id);

    expect(res).toMatchObject({ liveAccount: B.id, activated: true });
    expect(await liveIn(h, inc.rule.id)).toBe('B');
  });

  it('skips a quarantined included account, falling back to the inherited pool when all are out', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const rule = await h.vault.createRule({ folders: [work], include: [A.id, B.id] });
    await h.vault.quarantine(A.id, 'dead');

    expect((await h.engine.ensureRuleLive(rule.id)).liveAccount).toBe(B.id);

    // Every included account out: the folder inherits the shared pool rather than going dark.
    await h.vault.quarantine(B.id, 'dead');
    const res = await h.engine.ensureRuleLive(rule.id);
    expect(res).toMatchObject({ liveAccount: C.id, activated: true, noWorkingAccount: false });
    expect(await liveIn(h, rule.id)).toBe('C');
  });

  it('reports no working account when nothing in the pool can be seated', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const rule = await h.vault.createRule({
      folders: [work],
      include: [A.id, B.id],
      exclude: [C.id, D.id],
    });
    await h.vault.quarantine(A.id, 'dead');
    await h.vault.quarantine(B.id, 'dead');

    const res = await h.engine.ensureRuleLive(rule.id);

    expect(res).toEqual({
      ruleId: rule.id,
      liveAccount: null,
      activated: false,
      noWorkingAccount: true,
    });
    expect(await liveIn(h, rule.id)).toBeUndefined();
  });

  it('prefers auto-switch targets, using a globally excluded account only as a last resort', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    const C = await addAccount(h, 'C');
    await h.engine.setAutoSwitchExcluded(A.id, true);
    const work = await h.folder('work');
    const other = await h.folder('other');

    // A is first in the pool but excluded from auto-switch: the unattended choice is B.
    const first = await h.engine.excludeInFolder(work, [C.id]);
    expect(first.live.liveAccount).toBe(B.id);

    // With B busy and C excluded there, A is all the other folder has: used rather than none.
    const second = await h.engine.excludeInFolder(other, [C.id]);
    expect(second.live).toMatchObject({ liveAccount: A.id, noWorkingAccount: false });
    await expectOneSlotPerAccount(h.engine);
  });

  it('treats an included account as an auto target even when it is globally excluded', async () => {
    const h = await harness();
    const { B } = await seed(h);
    await h.engine.setAutoSwitchExcluded(B.id, true);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [B.id]);

    // The inclusion overrides the global exclusion inside the folder.
    expect(inc.live.liveAccount).toBe(B.id);
    const pool = await h.engine.slotPool(ruleSlotId(inc.rule.id));
    expect(pool[0]).toMatchObject({ account: { id: B.id }, source: 'include', autoTarget: true });
  });

  it('replaces a quarantined live account when another is available, and keeps it when none is', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);
    await h.vault.quarantine(A.id, 'dead');

    const replaced = await h.engine.ensureRuleLive(inc.rule.id);
    expect(replaced).toMatchObject({ liveAccount: B.id, activated: true });

    // A folder whose only account is the quarantined live one keeps it: clearing it gains nothing.
    const lone = await h.engine.includeInFolder(other, [C.id]);
    await h.engine.excludeInFolder(other, [D.id]);
    await h.vault.quarantine(C.id, 'dead');
    const kept = await h.engine.ensureRuleLive(lone.rule.id);
    // A dead login is no working account: the folder must be reported (and alerted on) as having
    // none, though the login stays in place.
    expect(kept).toMatchObject({ liveAccount: C.id, activated: false, noWorkingAccount: true });
    expect(await liveIn(h, lone.rule.id)).toBe('C');
  });

  it('clears a login outside the pool after adopting its rotation when nothing can be seated', async () => {
    const h = await harness();
    const A = await addAccount(h, 'A');
    const B = await addAccount(h, 'B');
    const C = await addAccount(h, 'C');
    const work = await h.folder('work');
    const other = await h.folder('other');
    await h.engine.includeInFolder(other, [A.id]);
    // The work folder excludes everything shared, and A is reserved elsewhere: an empty pool.
    const excl = await h.engine.excludeInFolder(work, [B.id, C.id]);
    expect(excl.live).toMatchObject({ liveAccount: null, noWorkingAccount: true });
    expect(excl.live.clearedSquatter).toBeUndefined();
    // An excluded account's login (rotated since it was stored) turns up in the profile.
    await rotateInSlot(h, excl.rule.id, 'B', 'rot-B');
    expect((await h.engine.checkSlots()).map((v) => v.kind)).toEqual(['outside_pool_live_in_rule']);

    const res = await h.engine.ensureRuleLive(excl.rule.id);

    expect(res).toMatchObject({
      liveAccount: null,
      activated: false,
      noWorkingAccount: true,
      clearedSquatter: true,
    });
    expect(await liveIn(h, excl.rule.id)).toBeUndefined();
    expect((await h.vault.readBundle(B.id)).claudeAiOauth.refreshToken).toBe('rot-B');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('evicts an account also live in the slot that may hold it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const owner = await h.engine.includeInFolder(other, [A.id]);
    const excl = await h.engine.excludeInFolder(work, [B.id]); // C live there
    // A copy of A's login lands in the work profile: A is now live in two slots.
    const store = ruleStore(h.paths, excl.rule.id);
    await store.writeLiveCredentials(oauth('A', NOW + 10 * HOUR));
    await store.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });
    expect((await h.engine.checkSlots()).map((v) => v.kind)).toContain('account_in_multiple_slots');

    const res = await h.engine.ensureRuleLive(excl.rule.id);

    // The work slot goes back to an account of its own pool; A stays where it belongs.
    expect(res).toMatchObject({ liveAccount: excl.live.liveAccount, activated: true });
    expect(await liveIn(h, excl.rule.id)).not.toBe('A');
    expect(await liveIn(h, owner.rule.id)).toBe('A');
    await expectOneSlotPerAccount(h.engine);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('refuses a rule that no longer exists', async () => {
    const h = await harness();
    await seed(h);
    expect((await refusal(h.engine.ensureRuleLive('no-such-rule'))).code).toBe('rule_gone');
  });
});

describe('includeInFolder — crash safety (a fault after each step converges)', () => {
  it('after the hand-off, before the rule write: a rerun completes and never lands in two slots', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'include:after-hand-off') throw new Error('boom');
    });
    await expect(faulted.includeInFolder(work, [A.id])).rejects.toThrow('boom');

    // Fresh process: A is shared and live nowhere; global holds the replacement.
    const fresh = h.restart();
    expect(await fresh.listRules()).toEqual([]);
    expect(await sharedIds(h)).toContain(A.id);
    expect(await fresh.getActiveId('global')).toBe(B.id);
    await expectOneSlotPerAccount(fresh);

    const res = await fresh.includeInFolder(work, [A.id]);
    expect(res.handedOff).toEqual([]);
    expect(res.live.liveAccount).toBe(A.id);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });

  // Not repairSlots: an empty slot breaks no invariant, so seating it is the self-heal's job.
  it.each([['rerun'], ['ensureRuleLive']])(
    'after the rule write, before ensure-live: %s converges',
    async (how) => {
      const h = await harness();
      const { A, B } = await seed(h);
      await h.engine.activate(A.id);
      const work = await h.folder('work');
      const faulted = h.restart((cp) => {
        if (cp === 'include:after-row-move') throw new Error('boom');
      });
      await expect(faulted.includeInFolder(work, [A.id, B.id])).rejects.toThrow('boom');

      // The rule exists (rows moved, global handed off) but its slot is still empty.
      const fresh = h.restart();
      const rule = (await fresh.listRules())[0]!;
      expect(rule.include).toEqual([A.id, B.id]);
      expect(await liveIn(h, rule.id)).toBeUndefined();
      expect(await liveInGlobal(h)).not.toBe('A');
      await expectOneSlotPerAccount(fresh);

      if (how === 'rerun') await fresh.includeInFolder(work, [A.id, B.id]);
      else await fresh.ensureRuleLive(rule.id);

      expect(await liveIn(h, rule.id)).toBe('A');
      await fresh.refreshSnapshotIfStale();
      expect((await fresh.getGuardSnapshotFreshness()).fresh).toBe(true);
      expect(await fresh.checkSlots()).toEqual([]);
      await expectOneSlotPerAccount(fresh);
    },
  );

  it('after ensure-live, before the snapshot: refreshSnapshot writes it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'include:after-ensure-live') throw new Error('boom');
    });
    await expect(faulted.includeInFolder(work, [A.id, B.id])).rejects.toThrow('boom');
    // The slot is live but the snapshot was never written.
    expect(existsSync(folderBindingsPath(h.paths.vaultDir))).toBe(false);

    const fresh = h.restart();
    await fresh.refreshSnapshot();
    const snap = await snapshotOf(h);
    expect(snap.groups.map((g) => g.members)).toEqual([['A', 'B']]);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });

  it('after ensure-live, before the snapshot: a routine repair with no slot breach writes it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'include:after-ensure-live') throw new Error('boom');
    });
    await expect(faulted.includeInFolder(work, [A.id, B.id])).rejects.toThrow('boom');

    // Every slot is legal, so the repair has nothing to move — but the guard would otherwise keep
    // reading a snapshot that does not know the folder has a rule.
    const fresh = h.restart();
    expect(await fresh.checkSlots()).toEqual([]);
    const repair = await fresh.repairSlots();
    expect(repair.actions).toEqual(['rewrote the stale folder-bindings snapshot']);

    expect(await fresh.getGuardSnapshotFreshness()).toMatchObject({ present: true, fresh: true });
    expect((await snapshotOf(h)).groups.flatMap((g) => g.folders)).toEqual([work]);
    await expectOneSlotPerAccount(fresh);
  });
});

describe('excludeInFolder — crash safety', () => {
  it.each([['rerun'], ['ensureRuleLive'], ['repairSlots']])(
    'after the rule write, with the excluded account still live: %s moves it',
    async (how) => {
      const h = await harness();
      const { A, B, C, D } = await seed(h);
      await h.engine.activate(A.id);
      const work = await h.folder('work');
      const excl = await h.engine.excludeInFolder(work, [D.id]); // B live there
      const faulted = h.restart((cp) => {
        if (cp === 'exclude:after-rule-write') throw new Error('boom');
      });
      await expect(faulted.excludeInFolder(work, [B.id])).rejects.toThrow('boom');

      // The exclusion is committed while B is still live there: the checker names it.
      const fresh = h.restart();
      expect((await fresh.getRule(excl.rule.id))?.exclude).toEqual([D.id, B.id]);
      const before = await fresh.checkSlots();
      expect(before).toMatchObject([
        { kind: 'outside_pool_live_in_rule', accountId: B.id, ruleId: excl.rule.id },
      ]);

      if (how === 'rerun') {
        const res = await fresh.excludeInFolder(work, [B.id]);
        expect(res.movedOff).toBe(B.id);
      } else if (how === 'ensureRuleLive') await fresh.ensureRuleLive(excl.rule.id);
      else expect((await fresh.repairSlots()).remaining).toEqual([]);

      expect(await liveIn(h, excl.rule.id)).toBe('C');
      expect((await fresh.getRule(excl.rule.id))?.activeId).toBe(C.id);
      expect(await fresh.checkSlots()).toEqual([]);
      await expectOneSlotPerAccount(fresh);
    },
  );

  it('after a new rule is written, before its slot is seated: ensureRuleLive and a snapshot refresh converge', async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'exclude:after-rule-write') throw new Error('boom');
    });
    await expect(faulted.excludeInFolder(work, [D.id])).rejects.toThrow('boom');

    const fresh = h.restart();
    const rule = (await fresh.listRules())[0]!;
    expect(rule).toMatchObject({ include: [], exclude: [D.id], activeId: null });
    expect(await fresh.checkSlots()).toEqual([]);
    expect((await fresh.ensureRuleLive(rule.id)).liveAccount).toBe(B.id);
    expect(await fresh.refreshSnapshotIfStale()).toBe(true);
    expect((await snapshotOf(h)).groups).toMatchObject([{ id: rule.id, members: [] }]);
    await expectOneSlotPerAccount(fresh);
  });

  it('after ensure-live, before the snapshot: refreshSnapshotIfStale writes it', async () => {
    const h = await harness();
    const { D } = await seed(h);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'exclude:after-ensure-live') throw new Error('boom');
    });
    await expect(faulted.excludeInFolder(work, [D.id])).rejects.toThrow('boom');

    const fresh = h.restart();
    expect((await fresh.getGuardSnapshotFreshness()).fresh).toBe(false);
    expect(await fresh.refreshSnapshotIfStale()).toBe(true);
    expect((await snapshotOf(h)).groups.flatMap((g) => g.folders)).toEqual([work]);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });
});

describe('resetFolder — crash safety', () => {
  it.each([
    ['reset:after-adopt', { dissolved: true }],
    ['reset:after-clear-live', { dissolved: true }],
    ['reset:after-release', { code: 'not_ruled' }],
  ])('a fault at %s leaves a state a rerun completes cleanly', async (cp, expected) => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]);
    const faulted = h.restart((c) => {
      if (c === cp) throw new Error('boom');
    });
    await expect(faulted.resetFolder(work)).rejects.toThrow('boom');

    const fresh = h.restart();
    await expectOneSlotPerAccount(fresh);
    // A rerun completes the dissolve; once the rule is already gone it reports not_ruled.
    const rerun = await fresh.resetFolder(work).then(
      (res) => ({ dissolved: res.dissolved }),
      (err: { code?: string }) => ({ code: err.code }),
    );
    expect(rerun).toEqual(expected);
    // Either way the rule is gone, its accounts are shared, its seat is empty, and the guard
    // converges on the next stale check.
    expect(await fresh.listRules()).toEqual([]);
    expect(await sharedIds(h)).toEqual(expect.arrayContaining([A.id, B.id]));
    expect(await liveIn(h, inc.rule.id)).toBeUndefined();
    await fresh.refreshSnapshotIfStale();
    expect((await snapshotOf(h)).groups).toEqual([]);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });

  it('after the rule write that un-includes a live account another rule reserves: repairSlots moves it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    const first = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in work
    await h.engine.includeInFolder(other, [A.id, C.id]);
    const faulted = h.restart((cp) => {
      if (cp === 'reset:after-rule-write') throw new Error('boom');
    });
    await expect(faulted.resetFolder(work, [A.id])).rejects.toThrow('boom');

    // Committed: work no longer includes A, which is still live there.
    const fresh = h.restart();
    expect((await fresh.getRule(first.rule.id))?.include).toEqual([B.id]);
    expect(await fresh.checkSlots()).toMatchObject([
      { kind: 'outside_pool_live_in_rule', accountId: A.id, ruleId: first.rule.id },
    ]);
    // The rerun has nothing left to remove; the self-heal is what moves the slot.
    expect((await refusal(fresh.resetFolder(work, [A.id]))).code).toBe('not_in_rule');

    const repair = await fresh.repairSlots();
    expect(repair.remaining).toEqual([]);
    expect(await liveIn(h, first.rule.id)).toBe('B');
    expect((await fresh.getGuardSnapshotFreshness()).fresh).toBe(true);
    await expectOneSlotPerAccount(fresh);
  });

  it('after the rule write that releases an account: the snapshot converges', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id, B.id]);
    const faulted = h.restart((cp) => {
      if (cp === 'reset:after-rule-write') throw new Error('boom');
    });
    await expect(faulted.resetFolder(work, [B.id])).rejects.toThrow('boom');

    const fresh = h.restart();
    expect(await sharedIds(h)).toContain(B.id);
    // The guard still names B until the snapshot is rewritten.
    expect((await fresh.getGuardSnapshotFreshness()).fresh).toBe(false);
    expect(await fresh.refreshSnapshotIfStale()).toBe(true);
    expect((await snapshotOf(h)).groups.map((g) => g.members)).toEqual([['A']]);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });
});

describe('removeAccount — crash safety', () => {
  it('after clearing the seat, before the registry drop: a rerun completes and the rule re-seats', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id, B.id]); // A live
    const faulted = h.restart((cp) => {
      if (cp === 'remove:after-clear-live') throw new Error('boom');
    });
    await expect(faulted.removeAccount(A.id)).rejects.toThrow('boom');

    // A is whole (row and bundle) with an empty seat.
    const fresh = h.restart();
    expect(await ruleIdsOf(h, A.id)).toEqual([inc.rule.id]);
    expect(await liveIn(h, inc.rule.id)).toBeUndefined();

    await fresh.removeAccount(A.id);
    expect((await fresh.listAllAccounts()).map((a) => a.id)).not.toContain(A.id);
    expect((await fresh.ensureRuleLive(inc.rule.id)).liveAccount).toBe(B.id);
    expect((await snapshotOf(h)).groups.map((g) => g.members)).toEqual([['B']]);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });

  it('after the registry drop that dissolves a rule: the snapshot converges', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id]);
    const faulted = h.restart((cp) => {
      if (cp === 'remove:after-registry-drop') throw new Error('boom');
    });
    await expect(faulted.removeAccount(A.id)).rejects.toThrow('boom');

    const fresh = h.restart();
    expect(await fresh.listRules()).toEqual([]);
    expect(await liveIn(h, inc.rule.id)).toBeUndefined();
    // The guard still enforces the dissolved rule until its snapshot is rewritten.
    expect((await fresh.getGuardSnapshotFreshness()).fresh).toBe(false);
    expect(await fresh.refreshSnapshotIfStale()).toBe(true);
    expect((await snapshotOf(h)).groups).toEqual([]);
    expect(await fresh.checkSlots()).toEqual([]);
    await expectOneSlotPerAccount(fresh);
  });
});

describe('the guard snapshot follows every rule change', () => {
  it('names included accounts in include order, and an exclude-only rule with none', async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');

    const inc = await h.engine.includeInFolder(work, [B.id, A.id]);
    const excl = await h.engine.excludeInFolder(other, [D.id]);

    const snap = await snapshotOf(h);
    expect(snap.groups).toMatchObject([
      {
        id: inc.rule.id,
        label: work,
        folders: [work],
        members: ['B', 'A'],
        profileDir: realpathSync.native(groupProfileDir(h.paths.vaultDir, inc.rule.id)),
      },
      { id: excl.rule.id, folders: [other], members: [] },
    ]);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
  });

  it('follows a reset: un-including drops the name, a dissolve drops the rule', async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    await h.engine.includeInFolder(work, [A.id, B.id]);
    const excl = await h.engine.excludeInFolder(other, [D.id]);

    await h.engine.resetFolder(work, [A.id]);
    expect((await snapshotOf(h)).groups.map((g) => g.members)).toEqual([['B'], []]);

    await h.engine.resetFolder(work);
    expect((await snapshotOf(h)).groups.map((g) => g.id)).toEqual([excl.rule.id]);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
  });

  it('removing the last included account drops the dissolved rule and empties its slot', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    const inc = await h.engine.includeInFolder(work, [A.id]);

    await h.engine.removeAccount(A.id);

    expect((await snapshotOf(h)).groups).toEqual([]);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
    expect(await liveIn(h, inc.rule.id)).toBeUndefined();
    expect(existsSync(join(h.paths.vaultDir, 'slots', inc.rule.id))).toBe(false);
  });

  it('removing one included account rewrites the names the guard shows', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id, B.id]);

    await h.engine.removeAccount(B.id);

    expect((await snapshotOf(h)).groups.map((g) => g.members)).toEqual([['A']]);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
  });

  it('renaming an included account rewrites the names the guard shows', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id, B.id]);

    await h.engine.renameAccount(B.id, 'Research');

    expect((await snapshotOf(h)).groups[0]!.members).toEqual(['A', 'Research']);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
  });

  it('refreshSnapshotIfStale rewrites a stale snapshot once and leaves a fresh one alone', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'include:after-ensure-live') throw new Error('boom');
    });
    await expect(faulted.includeInFolder(work, [A.id, B.id])).rejects.toThrow('boom');

    const fresh = h.restart();
    expect(await fresh.refreshSnapshotIfStale()).toBe(true);
    expect((await fresh.getGuardSnapshotFreshness()).fresh).toBe(true);
    expect(await fresh.refreshSnapshotIfStale()).toBe(false);
  });
});

describe('guard snapshot enforce mode is resolved at write time', () => {
  it('a daemon-side snapshot rewrite reflects a live enforce change, not the construction-time value', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id, B.id]);

    // Written under the construction-time default.
    expect((await snapshotOf(h)).enforce).toBe('block');

    // Operator changes the mode live; a later daemon-side rewrite (refreshSnapshot stands in for any
    // maintainSlots/repairSlots write) must carry the NEW mode. A cached value would revert it.
    h.setEnforce('off');
    await h.engine.refreshSnapshot();
    expect((await snapshotOf(h)).enforce).toBe('off');

    // And the dangerous direction: turning enforcement back ON is honored just the same.
    h.setEnforce('block');
    await h.engine.refreshSnapshot();
    expect((await snapshotOf(h)).enforce).toBe('block');
  });
});

describe('getGuardSnapshotFreshness is by content, not generation', () => {
  it('stays fresh after a routine rule-slot switch that bumps the generation', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id, B.id]);

    const before = await h.engine.getGuardSnapshotFreshness();
    expect(before).toMatchObject({ present: true, fresh: true });
    const genBefore = await h.engine.getRulesGeneration();

    // Switch the rule's live account. This bumps the rules generation (active account + metadata
    // writes) but changes NOTHING the guard reads (folders, profile dir, included labels, enforce),
    // and does not rewrite the snapshot — so a generation-based check would cry STALE. Advance past
    // the per-slot switch cadence so the hop is allowed.
    h.setNow(NOW + HOUR);
    await h.engine.activate(B.id);
    expect(await h.engine.getRulesGeneration()).toBeGreaterThan(genBefore);

    expect(await h.engine.getGuardSnapshotFreshness()).toMatchObject({
      present: true,
      fresh: true,
    });
  });

  it('reports STALE when the on-disk snapshot no longer matches a guard-relevant field', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.includeInFolder(work, [A.id, B.id]);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);

    // Simulate a snapshot that lags a real change to a guard-relevant field (here the enforce mode):
    // rewrite the stored snapshot with a different enforce, leaving the registry as is. Because
    // freshness compares guard-relevant CONTENT, this must report stale even though the generation is
    // untouched — the case a content check must still catch.
    const stored = await snapshotOf(h);
    await writeFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir), {
      ...stored,
      enforce: stored.enforce === 'off' ? 'block' : 'off',
    });

    expect(await h.engine.getGuardSnapshotFreshness()).toMatchObject({
      present: true,
      fresh: false,
    });
  });
});
