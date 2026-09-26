// Folder-bound group lifecycle: bindFolder, unbindFolder, ensureGroupLive.
//
// These exercise the operator-facing verbs that create a group from a folder, tear one down, and
// self-heal a group's slot — including the §7 refusals (each of which must name the offending
// account or folder), the global-slot hand-off when a globally-live account is reserved, and the
// crash-safety contract: a fault injected after each step leaves a state the next
// ensureGroupLive/refreshSnapshot converges from, with no account ever live in two slots.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, folderBindingsPath, type Paths } from './paths.js';
import { readFolderBindingSnapshot } from './folderBindings.js';
import { groupSlotId } from './types.js';
import { realpathSync, statSync } from 'node:fs';
import type { ClaudeOauth, CredentialBundle } from './types.js';
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

async function harness(platform: NodeJS.Platform = 'win32'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-bind-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });

  let now = NOW;
  const clock = (): number => now;
  const protector = new InsecurePassthroughProtector();
  const alive = new Set<number>();
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

function groupStore(paths: Paths, groupId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, groupId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** Four shared accounts A/B/C/D, all far from expiry so a bind never triggers a refresh. */
async function seed(h: Harness) {
  const A = await h.engine.addAccount('A', bundleFor('A', NOW + 10 * HOUR));
  const B = await h.engine.addAccount('B', bundleFor('B', NOW + 10 * HOUR));
  const C = await h.engine.addAccount('C', bundleFor('C', NOW + 10 * HOUR));
  const D = await h.engine.addAccount('D', bundleFor('D', NOW + 10 * HOUR));
  return { A, B, C, D };
}

describe('bindFolder — creating a group', () => {
  it('moves rows, materializes the profile, makes the first member live, and writes the snapshot last', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');

    const res = await h.engine.bindFolder(work, [A.id, B.id]);

    expect(res.created).toBe(true);
    expect(res.group.folders).toContain(work);
    expect(res.movedOffGlobal).toBeNull();
    expect(res.live.liveMember).toBe(A.id);
    // Rows moved out of the shared pool into the group; only C and D remain shared.
    expect((await h.vault.listAccounts()).map((a) => a.id).sort()).toEqual([C.id, D.id].sort());
    // A is live in the group's profile, nothing in global.
    const gid = res.group.id;
    expect((await groupStore(h.paths, gid).readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.engine.getActiveId('global')).toBeNull();
    // The snapshot exists and names the group.
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups.map((g) => g.id)).toContain(gid);
    expect(snap.groups[0]!.members.sort()).toEqual(['A', 'B']);
  });

  it('is idempotent when the same folder is bound to the same set again', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const first = await h.engine.bindFolder(work, [A.id, B.id]);
    h.setNow(NOW + 5 * 60_000);
    const again = await h.engine.bindFolder(work, [A.id, B.id]);
    expect(again.created).toBe(false);
    expect(again.group.id).toBe(first.group.id);
    expect(again.group.folders).toEqual([work]);
  });

  it('allows a nested subfolder to bind to a different account set (longest match wins)', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const sub = await h.folder(join('work', 'sub'));
    const outer = await h.engine.bindFolder(work, [A.id, B.id]);
    const inner = await h.engine.bindFolder(sub, [C.id, D.id]);
    expect(outer.group.id).not.toBe(inner.group.id);
    expect((await h.vault.listGroups()).length).toBe(2);
  });
});

describe('bindFolder — the global-slot hand-off', () => {
  it('moves global off a to-be-member and onto a remaining shared account', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(A.id); // A is the global live account
    const work = await h.folder('work');

    const res = await h.engine.bindFolder(work, [A.id]);

    expect(res.movedOffGlobal).toBe(A.id);
    expect(res.globalSwitchedTo).not.toBeNull();
    expect([B.id, C.id, D.id]).toContain(res.globalSwitchedTo);
    // A is now live only in its group, and the global slot holds the replacement.
    expect(await h.engine.getActiveId(groupSlotId(res.group.id))).toBe(A.id);
    expect(await h.engine.getActiveId('global')).toBe(res.globalSwitchedTo);
    // No account is live in two slots.
    const live = [...(await h.engine.liveSlots()).values()].filter((v): v is string => v !== null);
    expect(new Set(live).size).toBe(live.length);
  });

  it('refuses (nothing changed) when the only usable shared account would be reserved away', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A', NOW + 10 * HOUR));
    const B = await h.engine.addAccount('B', bundleFor('B', NOW + 10 * HOUR));
    await h.vault.quarantine(B.id, 'dead'); // B cannot hold global
    await h.engine.activate(A.id);
    const work = await h.folder('work');

    await expect(h.engine.bindFolder(work, [A.id])).rejects.toMatchObject({
      code: 'no_shared_account_remains',
    });
    // Unchanged: A still shared and globally live, no group.
    expect((await h.vault.listGroups()).length).toBe(0);
    expect(await h.engine.getActiveId('global')).toBe(A.id);
  });
});

describe('bindFolder — refusals name the offender', () => {
  it('refuses an account already reserved to a different group, naming it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const other = await h.folder('other');
    await h.engine.bindFolder(work, [A.id, B.id]);
    // A is reserved to {A,B}; a request for {A,C} is a different set.
    await expect(h.engine.bindFolder(other, [A.id, C.id])).rejects.toMatchObject({
      code: 'account_reserved_elsewhere',
    });
    await expect(h.engine.bindFolder(other, [A.id, C.id])).rejects.toThrow(/"A"/);
  });

  it('refuses re-binding a folder already bound to a different set, naming the folder', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    await h.engine.bindFolder(work, [A.id, B.id]);
    await expect(h.engine.bindFolder(work, [C.id, D.id])).rejects.toMatchObject({
      code: 'folder_bound_elsewhere',
    });
  });

  it('refuses the home dir, the vault dir, a nonexistent dir, and an unknown account', async () => {
    const h = await harness();
    const { A } = await seed(h);
    await expect(h.engine.bindFolder(join(h.root, 'home'), [A.id])).rejects.toMatchObject({
      code: 'bind_refused',
    });
    await expect(h.engine.bindFolder(h.paths.vaultDir, [A.id])).rejects.toMatchObject({
      code: 'bind_refused',
    });
    await expect(h.engine.bindFolder(join(h.root, 'nope'), [A.id])).rejects.toMatchObject({
      code: 'bind_refused',
    });
    const work = await h.folder('work');
    await expect(h.engine.bindFolder(work, ['no-such-id'])).rejects.toMatchObject({
      code: 'unknown_account',
    });
    await expect(h.engine.bindFolder(work, [])).rejects.toMatchObject({ code: 'bind_no_accounts' });
  });

  it('refuses on macOS', async () => {
    const h = await harness('darwin');
    const { A } = await seed(h);
    const work = await h.folder('work');
    await expect(h.engine.bindFolder(work, [A.id])).rejects.toMatchObject({
      code: 'group_slot_unsupported',
    });
  });
});

describe('bindFolder — running sessions under the folder', () => {
  it('returns the sessions whose pid is alive and cwd is within the folder', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const sessionsDir = join(h.paths.claudeDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    // One alive session inside the folder, one alive outside it, one dead inside.
    await writeFile(
      join(sessionsDir, 's1.json'),
      JSON.stringify({ pid: 4242, cwd: join(work, 'x') }),
    );
    await writeFile(
      join(sessionsDir, 's2.json'),
      JSON.stringify({ pid: 4343, cwd: join(h.root, 'elsewhere') }),
    );
    await writeFile(join(sessionsDir, 's3.json'), JSON.stringify({ pid: 9999, cwd: work }));
    h.alive.add(4242);
    h.alive.add(4343);

    const res = await h.engine.bindFolder(work, [A.id, B.id]);
    expect(res.runningSessions.map((s) => s.pid)).toEqual([4242]);
  });
});

describe('ensureGroupLive', () => {
  it('activates the first eligible member, skipping a quarantined one', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const group = await h.vault.createGroup({ memberIds: [A.id, B.id], folders: [work] });
    await h.vault.quarantine(A.id, 'dead');

    const res = await h.engine.ensureGroupLive(group.id);
    expect(res.liveMember).toBe(B.id);
    expect((await groupStore(h.paths, group.id).readLiveCredentials())?.accessToken).toBe('B');
  });

  it('reports no working account when every member is quarantined', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const group = await h.vault.createGroup({ memberIds: [A.id, B.id], folders: [work] });
    await h.vault.quarantine(A.id, 'dead');
    await h.vault.quarantine(B.id, 'dead');

    const res = await h.engine.ensureGroupLive(group.id);
    expect(res.liveMember).toBeNull();
    expect(res.noWorkingAccount).toBe(true);
  });

  it('re-activates when the live file went missing', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const group = await h.vault.createGroup({ memberIds: [A.id, B.id], folders: [work] });
    await h.engine.ensureGroupLive(group.id); // A live
    // Wipe the profile's live credentials (a corrupted/removed seat).
    await rm(join(groupProfileDir(h.paths.vaultDir, group.id), '.credentials.json'), {
      force: true,
    });

    const res = await h.engine.ensureGroupLive(group.id);
    expect(res.liveMember).toBe(A.id);
    expect((await groupStore(h.paths, group.id).readLiveCredentials())?.accessToken).toBe('A');
  });
});

describe('unbindFolder', () => {
  it('dissolves on the last folder: rows return, profile creds cleared, profile dir kept, snapshot updated', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]);
    const profileDir = groupProfileDir(h.paths.vaultDir, bind.group.id);

    const res = await h.engine.unbindFolder(work);
    expect(res.dissolved).toBe(true);
    expect(res.releasedMembers.sort()).toEqual([A.id, B.id].sort());
    // Members are shared again.
    expect((await h.vault.listAccounts()).map((a) => a.id).sort()).toContain(A.id);
    expect((await h.vault.listGroups()).length).toBe(0);
    // Profile dir kept, but its live credentials removed.
    expect(existsSync(profileDir)).toBe(true);
    expect(existsSync(join(profileDir, '.credentials.json'))).toBe(false);
    // Snapshot has no groups.
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups).toEqual([]);
  });

  it('refuses a non-forced dissolve when a session runs under the folder, and proceeds with force', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.bindFolder(work, [A.id, B.id]);
    const sessionsDir = join(h.paths.claudeDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 's.json'), JSON.stringify({ pid: 7777, cwd: work }));
    h.alive.add(7777);

    await expect(h.engine.unbindFolder(work)).rejects.toMatchObject({ code: 'sessions_running' });
    await expect(h.engine.unbindFolder(work)).rejects.toThrow(/work/);
    // Force proceeds.
    const res = await h.engine.unbindFolder(work, { force: true });
    expect(res.dissolved).toBe(true);
  });

  it('removes one of several folders and keeps the group live', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const also = await h.folder('also');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]);
    await h.engine.bindFolder(also, [A.id, B.id]); // second folder, same set

    const res = await h.engine.unbindFolder(work);
    expect(res.dissolved).toBe(false);
    expect(res.group?.folders).toEqual([also]);
    // The slot is still live.
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(A.id);
  });

  it('adopts a profile-side token rotation into the vault before clearing', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]); // A live in profile
    // Simulate a CLI rotation inside the profile: a newer token for A.
    const gStore = groupStore(h.paths, bind.group.id);
    await gStore.writeLiveCredentials(oauth('A', NOW + 20 * HOUR, 'rot-A'));
    await gStore.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    const res = await h.engine.unbindFolder(work);
    expect(res.adoptedRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-A');
  });

  it('refuses unbinding a folder that is not bound', async () => {
    const h = await harness();
    await seed(h);
    const work = await h.folder('work');
    await expect(h.engine.unbindFolder(work)).rejects.toMatchObject({ code: 'not_bound' });
  });
});

describe('bindFolder — crash safety (fault after each step converges)', () => {
  it('after the global switch, before the row move: reruns and never lands in two slots', async () => {
    const h = await harness();
    const { A } = await seed(h);
    await h.engine.activate(A.id);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'bind:after-global-switch') throw new Error('boom');
    });
    await expect(faulted.bindFolder(work, [A.id])).rejects.toThrow('boom');

    // Fresh process: A is shared and nowhere live; global holds the replacement. Re-running converges.
    const fresh = h.restart();
    expect(await fresh.getActiveId('global')).not.toBe(A.id);
    const res = await fresh.bindFolder(work, [A.id]);
    expect(res.live.liveMember).toBe(A.id);
    expect(await fresh.checkSlots()).toEqual([]);
  });

  it('after the row move, before ensure-live: ensureGroupLive converges', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'bind:after-row-move') throw new Error('boom');
    });
    await expect(faulted.bindFolder(work, [A.id, B.id])).rejects.toThrow('boom');

    // The group exists (rows moved) but its slot has no live member yet.
    const fresh = h.restart();
    const group = (await h.vault.listGroups())[0];
    expect(group).toBeDefined();
    const res = await fresh.ensureGroupLive(group!.id);
    expect(res.liveMember).toBe(A.id);
    expect(await fresh.checkSlots()).toEqual([]);
  });

  it('after ensure-live, before the snapshot: refreshSnapshot writes it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const faulted = h.restart((cp) => {
      if (cp === 'bind:after-ensure-live') throw new Error('boom');
    });
    await expect(faulted.bindFolder(work, [A.id, B.id])).rejects.toThrow('boom');
    // The slot is live but the snapshot was never written.
    expect(existsSync(folderBindingsPath(h.paths.vaultDir))).toBe(false);

    const fresh = h.restart();
    await fresh.refreshSnapshot();
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups.length).toBe(1);
    expect(await fresh.checkSlots()).toEqual([]);
  });
});

describe('unbindFolder — crash safety', () => {
  it.each([['unbind:after-adopt'], ['unbind:after-clear-live'], ['unbind:after-release']])(
    'a fault at %s leaves a state a rerun dissolves cleanly',
    async (cp) => {
      const h = await harness();
      const { A, B } = await seed(h);
      const work = await h.folder('work');
      await h.engine.bindFolder(work, [A.id, B.id]);
      const faulted = h.restart((c) => {
        if (c === cp) throw new Error('boom');
      });
      await expect(faulted.unbindFolder(work)).rejects.toThrow('boom');

      const fresh = h.restart();
      // A rerun (idempotent) completes the dissolve; if the group already dissolved it reports not_bound.
      try {
        const res = await fresh.unbindFolder(work);
        expect(res.dissolved).toBe(true);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('not_bound');
      }
      // Either way, nothing is left live in two slots.
      const live = [...(await fresh.liveSlots()).values()].filter((v): v is string => v !== null);
      expect(new Set(live).size).toBe(live.length);
    },
  );
});
