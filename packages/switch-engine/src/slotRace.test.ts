// Interleavings between a switch and a membership change made by another process.
//
// An account is live in at most ONE slot, and a reserved account is never live in the global slot.
// A switch that was DECIDED against one membership picture (a daemon's auto-switch, a phone /switch)
// can reach the credential lock after another process (an operator's `cctl bind` / `cctl unbind`)
// changed that picture. These tests pin the outcome: the late switch is refused or re-routed under
// the lock, never written into a slot its target no longer belongs to; and a switch interrupted
// after its live write recovers to a legal state even when its target has changed slot since.
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
import { groupSlotId } from './types.js';
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

/** A credential store over one group's profile dir — how a test inspects a group slot's live files. */
function groupStore(paths: Paths, groupId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, groupId);
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

describe('a switch decided before a bind reserved its target', () => {
  it('a global hop is refused, and the newly reserved account is live only in its group', async () => {
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
    // ...while the operator's bind holds it: C becomes reserved and is seated in its group.
    const bound = await h.engine.bindFolder(work, [C.id]);
    expect(bound.live.liveMember).toBe(C.id);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('slot_mismatch');
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect((await groupStore(h.paths, bound.group.id).readLiveCredentials())?.refreshToken).toBe(
      'r-C',
    );
    expect(await h.engine.checkSlots()).toEqual([]);
    // Nothing half-committed was left for the next start to trip over.
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('with the real lock: a hop started while a bind holds the lock never lands in two slots', async () => {
    // No pause: the hop is started from inside the bind (the checkpoint right after its global
    // hand-off, used here only as a non-throwing signal) and simply waits on the real lock. Every
    // read that routes it now happens after the bind released, so the outcome is fixed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const h = await harness();
      const { A, C } = await seed(h);
      const work = await h.folder('work');
      await h.engine.activate(A.id, { force: true });
      h.setNow(NOW + 10 * 60_000);

      const daemon = h.other();
      let hop: Promise<unknown> = Promise.resolve();
      const cli = h.other((checkpoint) => {
        if (checkpoint === 'bind:after-global-switch') {
          hop = settle(daemon.activate(C.id, { origin: 'auto', slot: 'global' }));
        }
      });
      await cli.bindFolder(work, [C.id]);
      const outcome = (await hop) as Awaited<ReturnType<typeof settle>>;

      expect(outcome.ok).toBe(false);
      expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
      expect(await h.engine.checkSlots()).toEqual([]);
    }
  });

  it('a hop that names no slot follows the target into its group instead of the global slot', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    h.setNow(NOW + 10 * 60_000);

    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto' }));
    await p.arrived;
    const bound = await h.engine.bindFolder(work, [C.id]);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(true);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-A');
    expect(await h.engine.getActiveId(groupSlotId(bound.group.id))).toBe(C.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('a group switch decided before an unbind dissolved the group', () => {
  it('is refused, never re-seeds the dissolved profile, and the target can then go global alone', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const bound = await h.engine.bindFolder(work, [B.id, C.id]);
    expect(bound.live.liveMember).toBe(B.id);
    const slot = groupSlotId(bound.group.id);
    const profileCreds = join(
      groupProfileDir(h.paths.vaultDir, bound.group.id),
      '.credentials.json',
    );
    h.setNow(NOW + 10 * 60_000);

    // The daemon's group auto-switch decides B -> C and reaches the lock...
    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto', slot }));
    await p.arrived;
    // ...while the operator's unbind dissolves the group: B and C are shared again.
    const unbound = await h.engine.unbindFolder(work);
    expect(unbound.dissolved).toBe(true);
    expect(existsSync(profileCreds)).toBe(false);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.code).toBe('slot_mismatch');
    expect(existsSync(profileCreds)).toBe(false);
    expect(await new IntentStore(join(h.paths.vaultDir, 'slots', bound.group.id)).read()).toBe(
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
    const bound = await h.engine.bindFolder(work, [B.id, C.id]);
    const profileCreds = join(
      groupProfileDir(h.paths.vaultDir, bound.group.id),
      '.credentials.json',
    );
    h.setNow(NOW + 10 * 60_000);

    const daemon = h.other();
    const p = pauseNextLock();
    const hop = settle(daemon.activate(C.id, { origin: 'auto' }));
    await p.arrived;
    await h.engine.unbindFolder(work);
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
    await h.vault.createGroup({ memberIds: [C.id], folders: [work] });

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
    await h.vault.createGroup({ memberIds: [C.id], folders: [work] });

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
    expect(await h.credStore.readOauthAccount()).toBeUndefined();
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('rolls a group switch back to the previous member when its target has left the group', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const bound = await h.engine.bindFolder(work, [B.id, C.id]);
    const slot = groupSlotId(bound.group.id);
    const gStore = groupStore(h.paths, bound.group.id);

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true, slot })).rejects.toThrow(
      'crash',
    );
    expect((await gStore.readLiveCredentials())?.refreshToken).toBe('r-C');
    await h.vault.releaseAccounts(bound.group.id, [C.id]);

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.action).toBe('rolled_back');
    expect((await gStore.readLiveCredentials())?.refreshToken).toBe('r-B');
    expect((await h.vault.getGroup(bound.group.id))?.activeId).toBe(B.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('fails a group slot closed when the departed target had no predecessor to restore', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(A.id, { force: true });
    const bound = await h.engine.bindFolder(work, [B.id, C.id]);
    const slot = groupSlotId(bound.group.id);
    const gStore = groupStore(h.paths, bound.group.id);
    // The profile holds no live login when the switch starts, so there is no rollback snapshot.
    await rm(join(groupProfileDir(h.paths.vaultDir, bound.group.id), '.credentials.json'));

    await expect(crashAfterLiveWrite(h).activate(C.id, { force: true, slot })).rejects.toThrow(
      'crash',
    );
    await h.vault.releaseAccounts(bound.group.id, [C.id]);

    const rec = await settle(h.other().recover());

    expect(rec.ok).toBe(true);
    expect(await gStore.readLiveCredentials()).toBeUndefined();
    expect((await h.engine.checkSlots()).map((v) => v.kind)).not.toContain(
      'nonmember_live_in_group',
    );
  });
});
