// Interleavings between a switch and the alias-binding membership ops made by another process:
// bindAlias (which creates or reuses a group), addGroupMembers, removeGroupMembers, and an alias
// unbind that dissolves its group.
//
// The invariants are the V1 ones: an account is live in at most ONE slot, a reserved account is never
// live in the global slot, a non-member is never written into a group's profile, and a dissolved
// group's profile never regains live credentials. activate() decides its slot under the credential
// lock and activateInSlot checks the target's candidacy before any live write, so a switch decided
// against an older membership picture is refused or follows its target — for these ops exactly as
// for bindFolder / unbindFolder.
//
// Interleavings are made deterministic by pausing ONE engine's next acquireLock call (the lock module
// is wrapped; nothing else is mocked): the paused engine has done every read it does before the lock,
// which is the state of a process that arrived at the lock while another process held it. One case
// runs without any pause, with the real filesystem lock, to show the interleaving is also safe when
// it happens for real.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
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
  credStore: CredentialStore;
  folder: (name: string) => Promise<string>;
  /** A second engine over the SAME on-disk state: another process (the daemon, another CLI). */
  other: (faultAt?: (cp: string) => void) => SwitchEngine;
  setNow: (n: number) => void;
}

/** Real sandbox dirs (so canonicalization and profile links behave as in production), an in-memory
 *  clock, and a refresh that always succeeds. */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-alias-race-'));
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
    Promise.resolve({ ...cur, expiresAt: clock() + HOUR });
  const mkEngine = (faultAt?: (cp: string) => void): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 60_000,
      lockOptions: { timeoutMs: 10_000, pollMs: 5 },
      platform: process.platform,
      bindFs,
      isProcessAlive: () => false,
      bindEnforce: 'block',
      ...(faultAt ? { faultAt } : {}),
    });
  return {
    paths,
    engine: mkEngine(),
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

/** The live-credentials store of a group's profile (what a session on that slot reads). */
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
  await h.engine.activate(A.id, { force: true });
  // Past the cadence guard: every hop below is an ordinary policy hop.
  h.setNow(NOW + 10 * 60_000);
  return { A, B, C };
}

/** Settle to a tagged result, so a racing call's refusal is observed rather than thrown. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: Error }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err: err as Error }),
  );
}

describe('a switch decided before an alias bind reserved its target', () => {
  it('a global hop to an account a new alias binding reserves never leaves it live in global', async () => {
    const h = await harness();
    const { C } = await seed(h);
    const repo = await h.folder('repo');

    // The daemon decides to hop the GLOBAL slot to shared account C and reaches the lock...
    const p = pauseNextLock();
    const hop = settle(h.other().activate(C.id, { origin: 'auto', slot: 'global' }));
    await p.arrived;
    // ...while the operator's `cctl session bind "auth" C` holds it: C becomes the only member of a
    // new alias group and is seated live in its profile.
    const bound = await h.engine.bindAlias(repo, 'auth', [C.id]);
    expect(bound.live.liveMember).toBe(C.id);
    p.release();
    const outcome = await hop;

    // The hop was decided for the global slot, which C no longer belongs to: refused, not written.
    expect(outcome.ok).toBe(false);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).not.toBe('r-C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('a hop that names no slot follows its target into the alias group, never into global', async () => {
    const h = await harness();
    const { C } = await seed(h);
    const repo = await h.folder('repo');

    const p = pauseNextLock();
    const hop = settle(h.other().activate(C.id, { origin: 'auto' }));
    await p.arrived;
    const bound = await h.engine.bindAlias(repo, 'auth', [C.id]);
    p.release();
    await hop;

    expect((await h.credStore.readLiveCredentials())?.refreshToken).not.toBe('r-C');
    expect((await groupStore(h.paths, bound.group.id).readLiveCredentials())?.refreshToken).toBe(
      'r-C',
    );
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('with the real lock: a hop started mid-bind never lands the account in two slots', async () => {
    // No pause: engine B (the operator's bind) runs a real bindAlias, and the instant it passes its
    // global hand-off (a fault checkpoint used only as a non-throwing signal) engine A (the daemon)
    // starts a real activate() of the same account, racing the groups.json write for real.
    const breaches: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      const h = await harness();
      const { C } = await seed(h);
      const repo = await h.folder('repo');
      const daemon = h.other();
      let hop: Promise<string> = Promise.resolve('not started');
      const cli = h.other((cp) => {
        if (cp === 'bind:after-global-switch') {
          hop = daemon.activate(C.id, { origin: 'auto' }).then(
            () => 'ok',
            (e: Error) => e.name,
          );
        }
      });
      await cli.bindAlias(repo, 'auth', [C.id]);
      const hopResult = await hop;
      const violations = await h.engine.checkSlots();
      if (violations.length > 0) {
        breaches.push(`round ${round} (hop ${hopResult}): ${violations.map((v) => v.kind).join()}`);
      }
    }
    expect(breaches).toEqual([]);
  }, 120_000);

  it('recovery after the late hop does not throw and leaves every slot legal', async () => {
    const h = await harness();
    const { C } = await seed(h);
    const repo = await h.folder('repo');
    const p = pauseNextLock();
    const hop = settle(h.other().activate(C.id, { origin: 'auto', slot: 'global' }));
    await p.arrived;
    await h.engine.bindAlias(repo, 'auth', [C.id]);
    p.release();
    await hop;

    // A restart (daemon start / `cctl recover`) must find nothing it cannot resolve.
    const restarted = await settle(h.other().recover());
    expect(restarted.ok).toBe(true);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('a switch decided before an alias binding grew to take its target', () => {
  it('a global hop to an account added to the binding is refused and never lands in global', async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth', [B.id]);

    const p = pauseNextLock();
    const hop = settle(h.other().activate(C.id, { origin: 'auto', slot: 'global' }));
    await p.arrived;
    // `cctl session bind "auth" C` on an already-bound alias grows the group.
    await h.engine.addGroupMembers(bound.group.id, [C.id]);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).not.toBe('r-C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('a group switch decided before its target left the alias binding', () => {
  it('is refused: the departed account is never written into the group, and can then go global', async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth', [B.id, C.id]);
    expect(bound.live.liveMember).toBe(B.id);

    // The daemon's per-slot auto-switch hops the alias group's slot B -> C...
    const p = pauseNextLock();
    const hop = settle(
      h.other().activate(C.id, { origin: 'auto', slot: `group:${bound.group.id}` }),
    );
    await p.arrived;
    // ...while `cctl session unbind "auth" --accounts C` returns C to the shared pool.
    await h.engine.removeGroupMembers(bound.group.id, [C.id]);
    p.release();
    const outcome = await hop;

    expect(outcome.ok).toBe(false);
    expect((await groupStore(h.paths, bound.group.id).readLiveCredentials())?.refreshToken).toBe(
      'r-B',
    );
    expect(await h.engine.checkSlots()).toEqual([]);

    // C is shared now, so a later global hop may legitimately pick it: still one slot only.
    h.setNow(NOW + 20 * 60_000);
    await h.engine.activate(C.id, { origin: 'auto' });
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('a group switch decided before an alias unbind dissolved its group', () => {
  it('never re-seeds the dissolved profile, even after the account goes global', async () => {
    const h = await harness();
    const { B, C } = await seed(h);
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth', [B.id, C.id]);
    const profile = groupProfileDir(h.paths.vaultDir, bound.group.id);

    const p = pauseNextLock();
    const hop = settle(h.other().activate(C.id, { origin: 'auto' }));
    await p.arrived;
    const unbound = await h.engine.unbindAlias(repo, 'auth');
    expect(unbound.dissolved).toBe(true);
    expect(existsSync(join(profile, '.credentials.json'))).toBe(false);
    p.release();
    await hop;

    // The next policy hop takes the now-shared C global.
    h.setNow(NOW + 20 * 60_000);
    await h.engine.activate(C.id, { origin: 'auto' });
    const orphan = existsSync(join(profile, '.credentials.json'))
      ? (JSON.parse(readFileSync(join(profile, '.credentials.json'), 'utf8')) as {
          claudeAiOauth: ClaudeOauth;
        })
      : undefined;
    // C's single-use refresh token is never live in the dissolved profile AND in global.
    expect(orphan).toBeUndefined();
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});
