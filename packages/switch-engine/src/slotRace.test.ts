// Interleavings between a switch and a folder-rule change made by another process.
//
// An account is live in at most ONE slot, a reserved (included) account is never live in the global
// slot, and a rule's slot only ever holds an account in that rule's pool. A switch that was DECIDED
// against one registry picture (a daemon's auto-switch, a phone /switch) can reach the credential
// lock after another process (an operator's `cctl folder include|exclude|reset`, another switch)
// changed that picture. These tests pin the outcome: the late switch is refused or re-routed under
// the lock, never written into a slot its target no longer belongs to or is already live elsewhere
// than; and a switch interrupted after its live write recovers to a legal state even when its
// target has changed slot since.
//
// Interleavings are made deterministic by pausing ONE engine's next acquireLock call (the lock module
// is wrapped; nothing else is mocked). The paused engine has already done every read it does before
// the lock, which is exactly the state of a process that arrived at the lock while another held it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { ruleSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

// ---- lock pause: hold the NEXT acquireLock call until released ------------------------------------
const lockPause = vi.hoisted(() => ({ next: null as null | (() => Promise<void>) }));
vi.mock('./lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lock.js')>();
  return {
    ...real,
    acquireLock: async (...args: Parameters<typeof real.acquireLock>) => {
      const hook = lockPause.next;
      if (hook) {
        lockPause.next = null;
        await hook();
      }
      return real.acquireLock(...args);
    },
  };
});

/** Arm the pause: the next acquireLock (from whichever engine calls first) signals `arrived`, then
 *  waits for `release()` before really acquiring. */
function pauseNextLock(): { arrived: Promise<void>; release: () => void } {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  const released = new Promise<void>((r) => (release = r));
  lockPause.next = async () => {
    arrive();
    await released;
  };
  return { arrived, release };
}

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];

afterEach(async () => {
  lockPause.next = null;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  /** The GLOBAL slot's live credential store. */
  credStore: CredentialStore;
  folder: (name: string) => Promise<string>;
  /** Another engine over the SAME on-disk state — a second process (the daemon, another CLI),
   *  optionally with a fault injector. */
  other: (faultAt?: (checkpoint: string) => void) => SwitchEngine;
  setNow: (n: number) => void;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-race-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  let now = NOW;
  const clock = (): number => now;
  const protector = new InsecurePassthroughProtector();
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
  const refresh = (cur: ClaudeOauth): Promise<ClaudeOauth> =>
    Promise.resolve({
      ...cur,
      accessToken: 'refreshed-' + cur.accessToken,
      refreshToken: 'rotated-' + cur.refreshToken,
      expiresAt: clock() + HOUR,
    });
  const mkEngine = (faultAt?: (checkpoint: string) => void): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 60_000,
      lockOptions: { timeoutMs: 5000, pollMs: 10 },
      platform: process.platform,
      bindFs,
      isProcessAlive: () => false,
      bindEnforce: 'block',
      ...(faultAt ? { faultAt } : {}),
    });
  return {
    paths,
    engine: mkEngine(),
    vault: new Vault(paths.vaultDir, protector, clock, undefined, process.platform),
    credStore: new CredentialStore(paths),
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
    other: (faultAt) => mkEngine(faultAt),
    setNow: (n) => (now = n),
  };
}

function bundleFor(access: string): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt: NOW + 10 * HOUR },
    oauthAccount: { accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' },
  };
}

/** A credential store over one rule's profile dir — how a test inspects a rule slot's live files. */
function ruleStore(paths: Paths, ruleId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, ruleId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

async function seed(h: Harness) {
  const A = await h.engine.addAccount('A', bundleFor('A'));
  const B = await h.engine.addAccount('B', bundleFor('B'));
  const C = await h.engine.addAccount('C', bundleFor('C'));
  return { A, B, C };
}

/** Settle a promise to a tagged result so a racing call's outcome can be asserted, not thrown. */
function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: Error & { code?: string } }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err: err as Error & { code?: string } }),
  );
}

describe('a switch decided before an include reserved its target', () => {
  it('a global hop is refused, and the newly reserved account is live only in its rule slot', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    h.setNow(NOW + 10 * 60_000); // past the cadence window: an ordinary policy hop

    // The daemon decides to hop the GLOBAL slot to shared C and reaches the lock...
    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto', slot: 'global' }));
    await p.arrived;
    // ...while the operator's include holds it: C becomes reserved and is seated in its rule slot.
    const included = await h.engine.includeInFolder(work, [C.id]);
    expect(included.live.liveAccount).toBe(C.id);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('slot_mismatch');
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect((await ruleStore(h.paths, included.rule.id).readLiveCredentials())?.refreshToken).toBe(
      'r-C',
    );
    expect(await h.engine.checkSlots()).toEqual([]);
    // Nothing half-committed was left for the next start to trip over.
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('with the real lock: a hop started while an include holds the lock never lands in two slots', async () => {
    // No pause: the hop is started from inside the include (the checkpoint right after its
    // hand-off, used here only as a non-throwing signal) and simply waits on the real lock. Every
    // read that routes it now happens after the include released, so the outcome is fixed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const h = await harness();
      const { A, C } = await seed(h);
      const work = await h.folder('work');
      await h.engine.activate(A.id, { force: true });
      h.setNow(NOW + 10 * 60_000);

      const daemon = h.other();
      let hop: Promise<unknown> = Promise.resolve();
      const cli = h.other((checkpoint) => {
        if (checkpoint === 'include:after-hand-off') {
          hop = settle(daemon.activate(C.id, { origin: 'auto', slot: 'global' }));
        }
      });
      await cli.includeInFolder(work, [C.id]);
      const outcome = (await hop) as Awaited<ReturnType<typeof settle>>;

      expect(outcome.ok).toBe(false);
      expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
      expect(await h.engine.checkSlots()).toEqual([]);
    }
  });

  it('a hop that names no slot follows the target into its rule slot instead of the global slot', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    h.setNow(NOW + 10 * 60_000);

    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto' }));
    await p.arrived;
    const included = await h.engine.includeInFolder(work, [C.id]);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(true);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect(await h.engine.getActiveId(ruleSlotId(included.rule.id))).toBe(C.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('a rule-slot switch decided before an exclude of its target', () => {
  it('is refused, and the excluded account is never written into the slot', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    // An exclude-only rule: its slot inherits the shared pool minus A, and A is global anyway.
    const excluded = await h.engine.excludeInFolder(work, [A.id]);
    expect(excluded.live.liveAccount).toBe(B.id);
    const slot = ruleSlotId(excluded.rule.id);
    h.setNow(NOW + 10 * 60_000);

    // The daemon's per-slot auto-switch decides B -> C for the folder and reaches the lock...
    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto', slot }));
    await p.arrived;
    // ...while the operator excludes C from that folder.
    await h.engine.excludeInFolder(work, [C.id]);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('slot_mismatch');
    const store = ruleStore(h.paths, excluded.rule.id);
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-B');
    expect(await h.engine.getActiveId(slot)).toBe(B.id);
    expect(await h.engine.checkSlots()).toEqual([]);
    expect(await new IntentStore(join(h.paths.vaultDir, 'slots', excluded.rule.id)).read()).toBe(
      undefined,
    );
  });
});

describe('a switch decided before another slot took its target', () => {
  it('a global hop onto a shared account a rule slot has since taken is refused (live elsewhere)', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const excluded = await h.engine.excludeInFolder(work, [A.id]);
    expect(excluded.live.liveAccount).toBe(B.id);
    const slot = ruleSlotId(excluded.rule.id);
    h.setNow(NOW + 10 * 60_000);

    // The daemon decides to hop the GLOBAL slot onto C, which nothing holds yet...
    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto', slot: 'global' }));
    await p.arrived;
    // ...while the folder's slot is moved onto C (C is shared and the rule does not exclude it).
    await h.engine.activate(C.id, { force: true, slot });
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('live_elsewhere');
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect(await h.engine.getActiveId(slot)).toBe(C.id);
    expect(await h.engine.checkSlots()).toEqual([]);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('two rule slots that include the same account: the second hop onto it is refused', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const S = await h.engine.addAccount('S', bundleFor('S'));
    const work1 = await h.folder('work1');
    const work2 = await h.folder('work2');
    await h.engine.activate(A.id, { force: true });
    // Both folders include S; it is seated in the first, and the second inherits a shared account.
    const r1 = await h.engine.includeInFolder(work1, [S.id]);
    const r2 = await h.engine.includeInFolder(work2, [S.id]);
    const slot1 = ruleSlotId(r1.rule.id);
    const slot2 = ruleSlotId(r2.rule.id);
    expect(r1.live.liveAccount).toBe(S.id);
    expect(r2.live.liveAccount).toBe(B.id);
    // The first folder moves onto shared C, which frees S.
    await h.engine.activate(C.id, { force: true, slot: slot1 });
    h.setNow(NOW + 10 * 60_000);

    // The daemon decides to return the SECOND folder to its included S...
    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(S.id, { origin: 'auto', slot: slot2 }));
    await p.arrived;
    // ...while the operator puts S back in the FIRST folder's slot.
    await h.engine.activate(S.id, { force: true, slot: slot1 });
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('live_elsewhere');
    expect(await h.engine.getActiveId(slot1)).toBe(S.id);
    expect(await h.engine.getActiveId(slot2)).toBe(B.id);
    expect((await ruleStore(h.paths, r2.rule.id).readLiveCredentials())?.refreshToken).toBe('r-B');
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('a rule-slot switch decided before a reset dissolved the rule', () => {
  it('is refused, never re-seeds the dissolved profile, and the target can then go global alone', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const included = await h.engine.includeInFolder(work, [B.id, C.id]);
    expect(included.live.liveAccount).toBe(B.id);
    const slot = ruleSlotId(included.rule.id);
    const profileCreds = join(
      groupProfileDir(h.paths.vaultDir, included.rule.id),
      '.credentials.json',
    );
    h.setNow(NOW + 10 * 60_000);

    // The daemon's rule-slot auto-switch decides B -> C and reaches the lock...
    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto', slot }));
    await p.arrived;
    // ...while the operator's reset dissolves the rule: B and C are shared again.
    const reset = await h.engine.resetFolder(work);
    expect(reset.dissolved).toBe(true);
    expect(existsSync(profileCreds)).toBe(false);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('slot_mismatch');
    expect(existsSync(profileCreds)).toBe(false);
    expect(await new IntentStore(join(h.paths.vaultDir, 'slots', included.rule.id)).read()).toBe(
      undefined,
    );

    // C is shared now, so the next global policy hop may legitimately pick it — and then it is live
    // in exactly one place.
    h.setNow(NOW + 20 * 60_000);
    await h.engine.activate(C.id, { origin: 'auto', slot: 'global' });
    expect(existsSync(profileCreds)).toBe(false);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('a hop that names no slot lands the now-shared target in the global slot, not the old profile', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const included = await h.engine.includeInFolder(work, [B.id, C.id]);
    const profileCreds = join(
      groupProfileDir(h.paths.vaultDir, included.rule.id),
      '.credentials.json',
    );
    h.setNow(NOW + 10 * 60_000);

    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto' }));
    await p.arrived;
    await h.engine.resetFolder(work);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(true);
    expect(existsSync(profileCreds)).toBe(false);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('recovering a switch whose target changed slot after its live write', () => {
  /** An engine that dies right after a switch's live write, before its registry commit. */
  function crashAfterLiveWrite(h: Harness): SwitchEngine {
    return h.other((checkpoint) => {
      if (checkpoint === 'activate:after-live-write') throw new Error('crash');
    });
  }

  it('rolls a global switch back when its target has since been reserved, without throwing', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true })).rejects.toThrow('crash');
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-C');
    // C is reserved before anything recovers (the registry move another process made meanwhile).
    await h.vault.createRule({ folders: [work], include: [C.id] });

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.action).toBe('rolled_back');
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect(await h.vault.getActiveId()).toBe(A.id);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
    expect((await h.engine.checkSlots()).map((v) => v.kind)).not.toContain(
      'reserved_live_in_global',
    );
  });

  it('clears the global slot when the since-reserved target had no predecessor to restore', async () => {
    const h = await harness();
    const { C } = await seed(h);
    const work = await h.folder('work');

    // Nothing was live before the switch, so there is no rollback snapshot.
    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true })).rejects.toThrow('crash');
    await h.vault.createRule({ folders: [work], include: [C.id] });

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
    expect(await h.credStore.readOauthAccount()).toBeUndefined();
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it("rolls a rule-slot switch back to the previous account when its target has left the rule's pool", async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const included = await h.engine.includeInFolder(work, [B.id, C.id]);
    const slot = ruleSlotId(included.rule.id);
    const store = ruleStore(h.paths, included.rule.id);

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true, slot })).rejects.toThrow(
      'crash',
    );
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-C');
    // C leaves the pool before anything recovers: un-included (so shared again), then excluded.
    // Un-including alone would not do it — the rule inherits the shared pool.
    await h.vault.removeFromRule(included.rule.id, [C.id]);
    await h.vault.excludeAccounts(included.rule.id, [C.id]);

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.action).toBe('rolled_back');
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-B');
    expect((await h.vault.getRule(included.rule.id))?.activeId).toBe(B.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('rolls a rule-slot switch forward when its target was un-included but the rule still inherits it', async () => {
    // Un-including an account returns it to the shared pool, and a rule that does not exclude it
    // still inherits it, so the interrupted switch is still a legitimate one to finish.
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const included = await h.engine.includeInFolder(work, [B.id, C.id]);
    const slot = ruleSlotId(included.rule.id);
    const store = ruleStore(h.paths, included.rule.id);

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true, slot })).rejects.toThrow(
      'crash',
    );
    expect((await h.vault.removeFromRule(included.rule.id, [C.id])).released).toEqual([C.id]);

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.action).toBe('rolled_forward');
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-C');
    expect((await h.vault.getRule(included.rule.id))?.activeId).toBe(C.id);
    // C is shared now and live only in the folder's slot; the global slot kept A.
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('fails a rule slot closed when the departed target had no predecessor to restore', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const included = await h.engine.includeInFolder(work, [B.id, C.id]);
    const slot = ruleSlotId(included.rule.id);
    const store = ruleStore(h.paths, included.rule.id);
    // The profile holds no live login when the switch starts, so there is no rollback snapshot.
    await rm(join(groupProfileDir(h.paths.vaultDir, included.rule.id), '.credentials.json'));

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true, slot })).rejects.toThrow(
      'crash',
    );
    await h.vault.removeFromRule(included.rule.id, [C.id]);
    await h.vault.excludeAccounts(included.rule.id, [C.id]);

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    expect(await store.readLiveCredentials()).toBeUndefined();
    expect((await h.engine.checkSlots()).map((v) => v.kind)).not.toContain(
      'outside_pool_live_in_rule',
    );
  });

  it('rolls a rule-slot switch back when its target has since gone live in another slot', async () => {
    // The target was free when the switch began; by recovery it is live in the global slot. Rolling
    // forward would leave it live in two slots.
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const excluded = await h.engine.excludeInFolder(work, [A.id]);
    expect(excluded.live.liveAccount).toBe(B.id);
    const slot = ruleSlotId(excluded.rule.id);
    const store = ruleStore(h.paths, excluded.rule.id);

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true, slot })).rejects.toThrow(
      'crash',
    );
    // Another process logs C into the main config dir before anything recovers.
    await h.credStore.writeLiveCredentials(bundleFor('C').claudeAiOauth);
    await h.credStore.writeOauthAccount(bundleFor('C').oauthAccount!);

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.action).toBe('rolled_back');
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-B');
    expect((await h.vault.getRule(excluded.rule.id))?.activeId).toBe(B.id);
    expect(await new IntentStore(join(h.paths.vaultDir, 'slots', excluded.rule.id)).read()).toBe(
      undefined,
    );
  });
});
