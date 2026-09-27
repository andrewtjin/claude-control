// Alias-scoped groups: bindAlias / unbindAlias, and growing / shrinking a group's member set
// (addGroupMembers / removeGroupMembers).
//
// An alias binding is a SCOPE on a V1 group, beside folder scopes, so everything here is held to the
// V1 contract: the same reuse-by-exact-member-set, the same "unbind there first" refusals (each
// naming the offender), the same global hand-off, and the same crash-safety — a fault injected at
// EVERY labelled checkpoint leaves a state that ensureGroupLive / repairSlots / a rerun converges
// from, with no account ever live in two slots. checkSlots / repairSlots must treat a group with no
// folder (alias scopes only) exactly like any other group.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { folderBindingsPath, groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { readFolderBindingSnapshot } from './folderBindings.js';
import { groupSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  credStore: CredentialStore;
  /** Pids the injected liveness probe reports as alive. */
  alive: Set<number>;
  /** A real directory under the sandbox, created and returned canonical. */
  folder: (name: string) => Promise<string>;
  /** Another engine over the SAME on-disk state (a simulated restart), optionally faulting. */
  restart: (faultAt?: (cp: string) => void) => SwitchEngine;
  setNow: (n: number) => void;
}

// Same construction as groupBinding.test.ts: real sandbox dirs (so canonicalization and the profile
// junctions behave as in production), an in-memory clock, a sandbox home, and a liveness probe the
// test controls.
async function harness(platform: NodeJS.Platform = process.platform): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-alias-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  let now = NOW;
  const clock = (): number => now;
  const protector = new InsecurePassthroughProtector();
  const alive = new Set<number>();
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
  const mkEngine = (faultAt?: (cp: string) => void): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 60_000,
      lockOptions: { timeoutMs: 2000, pollMs: 10 },
      platform,
      bindFs,
      isProcessAlive: (pid) => alive.has(pid),
      bindEnforce: 'block',
      ...(faultAt ? { faultAt } : {}),
    });
  return {
    root,
    paths,
    engine: mkEngine(),
    vault: new Vault(paths.vaultDir, protector, clock, undefined, platform),
    credStore: new CredentialStore(paths),
    alive,
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
    restart: (faultAt) => mkEngine(faultAt),
    setNow: (n) => (now = n),
  };
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function oauth(access: string, expiresAt: number, refresh = 'r-' + access): ClaudeOauth {
  return { accessToken: access, refreshToken: refresh, expiresAt };
}
function bundleFor(access: string): CredentialBundle {
  return {
    claudeAiOauth: oauth(access, NOW + 10 * HOUR),
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
/** Write live credentials + identity into a slot's config dir — a simulated `/login`. */
async function login(store: CredentialStore, access: string, o: ClaudeOauth): Promise<void> {
  await store.writeLiveCredentials(o);
  await store.writeOauthAccount({ accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' });
}

async function seed(h: Harness) {
  const A = await h.engine.addAccount('A', bundleFor('A'));
  const B = await h.engine.addAccount('B', bundleFor('B'));
  const C = await h.engine.addAccount('C', bundleFor('C'));
  const D = await h.engine.addAccount('D', bundleFor('D'));
  return { A, B, C, D };
}

/** Write a Claude Code session file (`<main>/sessions/<pid>.json`) the running-session scan reads. */
async function session(
  h: Harness,
  pid: number,
  cwd: string,
  name?: string,
  alive = true,
): Promise<void> {
  const dir = join(h.paths.claudeDir, 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `s-${pid}`, cwd, ...(name !== undefined ? { name } : {}) }),
  );
  if (alive) h.alive.add(pid);
}

/** The core invariant, read physically (checkSlots matches each slot's live identity against the
 *  whole registry, so it sees an account wherever it sits): no account live in two slots, no reserved
 *  account in global, no non-member in a group profile. Asserted straight after a crash, BEFORE any
 *  repair, it proves the step order itself is safe at that point — not merely repairable later. */
async function expectSlotsClean(engine: SwitchEngine): Promise<void> {
  expect(await engine.checkSlots()).toEqual([]);
}

/** Converge a possibly-interrupted state the way the daemon would: self-heal every group slot,
 *  repair, and rewrite the snapshot; afterwards the system must be clean. */
async function converge(engine: SwitchEngine, vault: Vault): Promise<void> {
  for (const g of await vault.listGroups()) await engine.ensureGroupLive(g.id);
  await engine.repairSlots();
  await engine.refreshSnapshot();
  expect(await engine.checkSlots()).toEqual([]);
  expect((await engine.getGuardSnapshotFreshness()).fresh).toBe(true);
}

describe('bindAlias — creating and reusing a group', () => {
  it('creates an alias-only group: rows move, the slot goes live, the snapshot carries the key', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const repo = await h.folder('repo');

    const res = await h.engine.bindAlias(repo, 'Auth Work', [A.id, B.id]);

    expect(res.created).toBe(true);
    expect(res.folder).toBe(repo);
    expect(res.alias).toBe('Auth Work');
    expect(res.group.folders).toEqual([]);
    expect(res.group.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
    expect(res.live.liveMember).toBe(A.id);
    expect((await h.vault.listAccounts()).map((a) => a.id).sort()).toEqual([C.id, D.id].sort());
    expect((await groupStore(h.paths, res.group.id).readLiveCredentials())?.accessToken).toBe('A');
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    // The key the guard compares, plus the alias as bound for its messages.
    expect(snap.groups[0]?.aliases).toEqual([
      { folder: repo, aliasKey: 'auth work', alias: 'Auth Work' },
    ]);
    expect(snap.groups[0]?.folders).toEqual([]);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('is idempotent for the same set, whatever the alias case/spacing', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const first = await h.engine.bindAlias(repo, 'Auth Work', [A.id]);
    const again = await h.engine.bindAlias(repo, '  AUTH work ', [A.id]);
    expect(again.created).toBe(false);
    expect(again.group.id).toBe(first.group.id);
    // The stored alias keeps the spelling it was first bound with.
    expect(again.group.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
  });

  it('reuses the folder-bound group with exactly the requested set, adding the alias scope', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const repo = await h.folder('repo');
    const byFolder = await h.engine.bindFolder(work, [A.id, B.id]);
    const byAlias = await h.engine.bindAlias(repo, 'x', [B.id, A.id]);
    expect(byAlias.created).toBe(false);
    expect(byAlias.group.id).toBe(byFolder.group.id);
    expect(byAlias.group.folders).toEqual([work]);
    expect(byAlias.group.aliases).toEqual([{ folder: repo, alias: 'x' }]);
    expect((await h.vault.listGroups()).length).toBe(1);
  });

  it('binds one alias in two folders to two different sets (the folder disambiguates)', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const one = await h.folder('one');
    const two = await h.folder('two');
    const g1 = await h.engine.bindAlias(one, 'shared name', [A.id]);
    const g2 = await h.engine.bindAlias(two, 'shared name', [B.id]);
    expect(g1.group.id).not.toBe(g2.group.id);
    expect(await h.engine.resolveSessionBinding(one, 'Shared Name')).toMatchObject({
      groupId: g1.group.id,
      via: 'alias',
    });
    expect(await h.engine.resolveSessionBinding(two, 'shared name')).toMatchObject({
      groupId: g2.group.id,
      via: 'alias',
    });
  });

  it('allows the home dir (an alias scope never captures subfolders)', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const res = await h.engine.bindAlias(join(h.root, 'home'), 'notes', [A.id]);
    expect(res.created).toBe(true);
  });

  it('resolveSessionBinding: the alias outranks the folder binding of the same folder', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const folderGroup = await h.engine.bindFolder(work, [A.id]);
    const aliasGroup = await h.engine.bindAlias(work, 'auth', [B.id]);
    expect(await h.engine.resolveSessionBinding(work, 'AUTH')).toEqual({
      groupId: aliasGroup.group.id,
      via: 'alias',
      folder: work,
      aliasKey: 'auth',
    });
    expect(await h.engine.resolveSessionBinding(work, 'other')).toMatchObject({
      groupId: folderGroup.group.id,
      via: 'folder',
    });
    expect(await h.engine.resolveSessionBinding(work, null)).toMatchObject({
      groupId: folderGroup.group.id,
    });
  });
});

describe('bindAlias — the global-slot hand-off', () => {
  it('moves global off a to-be-member onto a remaining shared account', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(A.id);
    const repo = await h.folder('repo');
    const res = await h.engine.bindAlias(repo, 'x', [A.id]);
    expect(res.movedOffGlobal).toBe(A.id);
    expect([B.id, C.id, D.id]).toContain(res.globalSwitchedTo);
    expect(await h.engine.getActiveId(groupSlotId(res.group.id))).toBe(A.id);
    expect(await h.engine.getActiveId('global')).toBe(res.globalSwitchedTo);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('refuses (nothing changed) when no usable shared account would remain', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.vault.quarantine(B.id, 'dead');
    await h.engine.activate(A.id);
    const repo = await h.folder('repo');
    await expect(h.engine.bindAlias(repo, 'x', [A.id])).rejects.toMatchObject({
      code: 'no_shared_account_remains',
    });
    expect((await h.vault.listGroups()).length).toBe(0);
    expect(await h.engine.getActiveId('global')).toBe(A.id);
  });
});

describe('bindAlias — refusals name the offender', () => {
  it('refuses an account reserved to a different set ("unbind it there first")', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const repo = await h.folder('repo');
    await h.engine.bindFolder(work, [A.id, B.id]);
    const attempt = h.engine.bindAlias(repo, 'x', [A.id, C.id]);
    await expect(attempt).rejects.toMatchObject({ code: 'account_reserved_elsewhere' });
    await expect(h.engine.bindAlias(repo, 'x', [A.id, C.id])).rejects.toThrow(
      /"A" is already reserved to .*work.*unbind it there first/,
    );
  });

  it('refuses re-binding an alias already bound to a different set (any case), naming it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'Auth Work', [A.id]);
    await expect(h.engine.bindAlias(repo, 'auth WORK', [B.id])).rejects.toMatchObject({
      code: 'alias_bound_elsewhere',
    });
    await expect(h.engine.bindAlias(repo, 'auth WORK', [B.id])).rejects.toThrow(
      /session "auth WORK" in .* is already bound to A; unbind it first/,
    );
  });

  it('refuses a blank, over-long, or control/bidi-carrying alias', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    for (const bad of ['   ', 'x'.repeat(513), 'a\u001b[31mb', 'a\nb', 'a‮b', 'a\u0000b']) {
      await expect(h.engine.bindAlias(repo, bad, [A.id])).rejects.toMatchObject({
        code: 'bind_refused',
      });
    }
    expect((await h.vault.listGroups()).length).toBe(0);
  });

  it('refuses an alias longer than Claude Code keeps a session name, which no session could match', async () => {
    // Measured: `claude --name "<278 characters>"` records only the first 200 characters.
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const attempt = h.engine.bindAlias(repo, 'x'.repeat(201), [A.id]);
    await expect(attempt).rejects.toMatchObject({ code: 'bind_refused' });
    await expect(h.engine.bindAlias(repo, 'x'.repeat(201), [A.id])).rejects.toThrow(
      /cannot be longer than 200 characters: Claude Code keeps only the first 200/,
    );
    expect((await h.vault.listGroups()).length).toBe(0);
    // 200 characters fit, whatever surrounds them (the resume rule trims).
    const fits = await h.engine.bindAlias(repo, `  ${'y'.repeat(200)}  `, [A.id]);
    expect(fits.alias).toBe(`  ${'y'.repeat(200)}  `);
  });

  it('counts that length in code points, as Claude Code does: an alias of emoji it stores whole binds', async () => {
    // Measured: 195 ASCII characters and 5 emoji (200 code points, 205 UTF-16 units) are stored
    // whole; 201 code points are stored as the first 200 code points.
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const whole = `${'a'.repeat(195)}${'\u{1F600}'.repeat(5)}`;
    expect(whole.length).toBe(205);
    await expect(h.engine.bindAlias(repo, whole, [A.id])).resolves.toMatchObject({
      alias: whole,
    });
    const cut = `${'b'.repeat(196)}${'\u{1F600}'.repeat(5)}`;
    await expect(h.engine.bindAlias(repo, cut, [A.id])).rejects.toThrow(
      /cannot be longer than 200 characters/,
    );
  });

  it('refuses a nonexistent folder and one inside cctl state; unknown/empty accounts; macOS', async () => {
    const h = await harness();
    const { A } = await seed(h);
    await expect(h.engine.bindAlias(join(h.root, 'nope'), 'x', [A.id])).rejects.toMatchObject({
      code: 'bind_refused',
    });
    await expect(h.engine.bindAlias(h.paths.vaultDir, 'x', [A.id])).rejects.toMatchObject({
      code: 'bind_refused',
    });
    const repo = await h.folder('repo');
    await expect(h.engine.bindAlias(repo, 'x', ['no-such-id'])).rejects.toMatchObject({
      code: 'unknown_account',
    });
    await expect(h.engine.bindAlias(repo, 'x', [])).rejects.toMatchObject({
      code: 'bind_no_accounts',
    });
    const mac = await harness('darwin');
    const macA = await mac.engine.addAccount('A', bundleFor('A'));
    await expect(
      mac.engine.bindAlias(await mac.folder('repo'), 'x', [macA.id]),
    ).rejects.toMatchObject({ code: 'group_slot_unsupported' });
  });
});

describe('bindAlias — running sessions in the scope', () => {
  it('reports only live sessions in EXACTLY the folder whose name matches the alias', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await session(h, 101, repo, 'AUTH work'); // in scope (alias key match)
    await session(h, 102, repo, 'other'); // another title
    await session(h, 103, repo); // no name of its own, no transcript lookup: its title is unknown
    await session(h, 104, join(repo, 'sub'), 'auth work'); // a subfolder is not the alias scope
    await session(h, 105, repo, 'auth work', false); // dead
    await session(h, 106, join(repo, 'sub')); // unknown title, but not in the alias folder
    const res = await h.engine.bindAlias(repo, 'Auth Work', [A.id]);
    // The unknown one in the alias folder MAY be the conversation: reported, and marked as such.
    const seen = [...res.runningSessions].sort((x, y) => x.pid - y.pid);
    expect(seen.map((s) => [s.pid, s.unidentified ?? false])).toEqual([
      [101, false],
      [103, true],
    ]);
  });
});

describe('unbindAlias', () => {
  it('dissolves on the last scope: rows return, profile creds cleared, snapshot updated', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'Auth Work', [A.id, B.id]);
    const profileDir = groupProfileDir(h.paths.vaultDir, bind.group.id);

    const res = await h.engine.unbindAlias(repo, 'auth work');
    expect(res.dissolved).toBe(true);
    expect(res.alias).toBe('Auth Work');
    expect(res.releasedMembers.sort()).toEqual([A.id, B.id].sort());
    expect((await h.vault.listGroups()).length).toBe(0);
    expect(existsSync(profileDir)).toBe(true);
    expect(existsSync(join(profileDir, '.credentials.json'))).toBe(false);
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups).toEqual([]);
  });

  it('keeps the group when it has other scopes, dropping only the alias', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    const repo = await h.folder('repo');
    const bind = await h.engine.bindFolder(work, [A.id]);
    await h.engine.bindAlias(repo, 'x', [A.id]);
    const res = await h.engine.unbindAlias(repo, 'X');
    expect(res.dissolved).toBe(false);
    expect(res.group?.aliases).toBeUndefined();
    expect(res.group?.folders).toEqual([work]);
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(A.id);
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups[0]?.aliases).toEqual([]);
  });

  it('unbindFolder of a group that also holds an alias no longer dissolves it', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const work = await h.folder('work');
    const repo = await h.folder('repo');
    await h.engine.bindFolder(work, [A.id]);
    await h.engine.bindAlias(repo, 'x', [A.id]);
    const res = await h.engine.unbindFolder(work);
    expect(res.dissolved).toBe(false);
    expect(res.group?.folders).toEqual([]);
    expect(res.group?.aliases).toEqual([{ folder: repo, alias: 'x' }]);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('refuses a non-forced dissolve while a named session runs in the scope; force proceeds', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'x', [A.id]);
    await session(h, 7777, repo, 'X');
    await expect(h.engine.unbindAlias(repo, 'x')).rejects.toMatchObject({
      code: 'sessions_running',
    });
    await expect(h.engine.unbindAlias(repo, 'x')).rejects.toThrow(/session "x" in .*repo/);
    const res = await h.engine.unbindAlias(repo, 'x', { force: true });
    expect(res.dissolved).toBe(true);
    expect(res.runningSessions.map((s) => s.pid)).toEqual([7777]);
  });

  it('refuses an alias that is not bound (other alias, other folder)', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const other = await h.folder('other');
    await h.engine.bindAlias(repo, 'x', [A.id]);
    await expect(h.engine.unbindAlias(repo, 'y')).rejects.toMatchObject({ code: 'not_bound' });
    await expect(h.engine.unbindAlias(other, 'x')).rejects.toMatchObject({ code: 'not_bound' });
  });

  it('unbinds the alias of a folder that has since been deleted', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'x', [A.id]);
    await rm(repo, { recursive: true, force: true });
    const res = await h.engine.unbindAlias(repo, 'x');
    expect(res.dissolved).toBe(true);
  });

  it('adopts a profile-side rotation into the vault before clearing', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
    await login(groupStore(h.paths, bind.group.id), 'A', oauth('A', NOW + 20 * HOUR, 'rot-A'));
    const res = await h.engine.unbindAlias(repo, 'x');
    expect(res.adoptedRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-A');
  });
});

describe('addGroupMembers', () => {
  it('grows the set: rows move in, the live member keeps the slot, the snapshot names the new member', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
    const res = await h.engine.addGroupMembers(bind.group.id, [B.id, C.id]);
    expect(res.added.sort()).toEqual([B.id, C.id].sort());
    expect(res.group.members.map((m) => m.id).sort()).toEqual([A.id, B.id, C.id].sort());
    expect(res.live.liveMember).toBe(A.id);
    expect(res.live.activated).toBe(false);
    expect((await h.vault.listAccounts()).map((a) => a.id)).not.toContain(B.id);
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups[0]?.members.sort()).toEqual(['A', 'B', 'C']);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('skips accounts already members (a no-op grow changes nothing)', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
    const genBefore = await h.engine.getGroupsGeneration();
    const res = await h.engine.addGroupMembers(bind.group.id, [A.id]);
    expect(res.added).toEqual([]);
    expect(await h.engine.getGroupsGeneration()).toBe(genBefore);
  });

  it('moves global off a globally-live account being added, and refuses when none would remain', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
    await h.engine.activate(B.id); // B is global
    const res = await h.engine.addGroupMembers(bind.group.id, [B.id]);
    expect(res.movedOffGlobal).toBe(B.id);
    expect([C.id, D.id]).toContain(res.globalSwitchedTo);
    expect(await h.engine.checkSlots()).toEqual([]);

    // Now C is global; make D unusable so adding C would leave global with nothing.
    h.setNow(NOW + HOUR);
    await h.engine.activate(C.id);
    await h.vault.quarantine(D.id, 'dead');
    await expect(h.engine.addGroupMembers(bind.group.id, [C.id])).rejects.toMatchObject({
      code: 'no_shared_account_remains',
    });
    // Nothing changed: C still shared and globally live.
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect((await h.vault.getGroup(bind.group.id))?.members.map((m) => m.id)).not.toContain(C.id);
  });

  it('refuses an account reserved to another group (named), an unknown account, an unknown group', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const work = await h.folder('work');
    const g1 = await h.engine.bindAlias(repo, 'x', [A.id]);
    await h.engine.bindFolder(work, [B.id]);
    await expect(h.engine.addGroupMembers(g1.group.id, [B.id])).rejects.toThrow(
      /"B" is already reserved to .*work.*unbind it there first/,
    );
    await expect(h.engine.addGroupMembers(g1.group.id, ['nope'])).rejects.toMatchObject({
      code: 'unknown_account',
    });
    await expect(h.engine.addGroupMembers('no-group', [B.id])).rejects.toMatchObject({
      code: 'not_bound',
    });
    await expect(h.engine.addGroupMembers(g1.group.id, [])).rejects.toMatchObject({
      code: 'bind_no_accounts',
    });
  });
});

describe('removeGroupMembers', () => {
  it('removes a member that is not live: rows return, the live member keeps the slot', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id, B.id]); // A live
    const res = await h.engine.removeGroupMembers(bind.group.id, [B.id]);
    expect(res.dissolved).toBe(false);
    expect(res.switchedTo).toBeUndefined();
    expect(res.group?.members.map((m) => m.id)).toEqual([A.id]);
    expect((await h.vault.listAccounts()).map((a) => a.id)).toContain(B.id);
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(A.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('switches a leaving LIVE member off first; its rotated token is adopted; it is live nowhere after', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id, B.id]); // A live
    // A session rotated A's token inside the profile.
    await login(groupStore(h.paths, bind.group.id), 'A', oauth('A', NOW + 20 * HOUR, 'rot-A'));
    const res = await h.engine.removeGroupMembers(bind.group.id, [A.id]);
    expect(res.switchedTo).toBe(B.id);
    expect(res.adoptedRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-A');
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(B.id);
    // A is shared again and not live anywhere (global was empty and stays so).
    expect(await h.engine.getActiveId('global')).not.toBe(A.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('clears the slot when no remaining member can take it (refusing without force while sessions run)', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id, B.id]); // A live
    await h.vault.quarantine(B.id, 'dead');
    await session(h, 555, repo, 'x');
    await expect(h.engine.removeGroupMembers(bind.group.id, [A.id])).rejects.toMatchObject({
      code: 'sessions_running',
    });
    const res = await h.engine.removeGroupMembers(bind.group.id, [A.id], { force: true });
    expect(res.switchedTo).toBeNull();
    expect(
      existsSync(join(groupProfileDir(h.paths.vaultDir, bind.group.id), '.credentials.json')),
    ).toBe(false);
    expect(res.group?.members.map((m) => m.id)).toEqual([B.id]);
    await expectSlotsClean(h.engine);
  });

  it('removing every member dissolves the group with V1 unbind semantics', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id, B.id]);
    await session(h, 556, repo, 'X');
    await expect(h.engine.removeGroupMembers(bind.group.id, [A.id, B.id])).rejects.toMatchObject({
      code: 'sessions_running',
    });
    const res = await h.engine.removeGroupMembers(bind.group.id, [A.id, B.id], { force: true });
    expect(res.dissolved).toBe(true);
    expect(res.group).toBeUndefined();
    expect(res.removed.sort()).toEqual([A.id, B.id].sort());
    expect((await h.vault.listGroups()).length).toBe(0);
    const snap = (await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir)))!;
    expect(snap.groups).toEqual([]);
  });

  it('refuses an account that is not a member, naming it', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
    await expect(h.engine.removeGroupMembers(bind.group.id, [C.id])).rejects.toMatchObject({
      code: 'not_a_member',
    });
    await expect(h.engine.removeGroupMembers(bind.group.id, [C.id])).rejects.toThrow(/"C"/);
  });
});

describe('checkSlots / repairSlots understand an alias-only group', () => {
  it('evicts a non-member squatter from an alias-only group profile', async () => {
    const h = await harness();
    const { A, C } = await seed(h);
    const repo = await h.folder('repo');
    const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
    await login(groupStore(h.paths, bind.group.id), 'C', oauth('C', NOW + 10 * HOUR));
    const before = await h.engine.checkSlots();
    expect(before.some((v) => v.kind === 'nonmember_live_in_group' && v.accountId === C.id)).toBe(
      true,
    );
    await h.engine.repairSlots();
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(A.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('moves global off a reserved alias-group member that squats there', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'x', [A.id]);
    await login(h.credStore, 'A', oauth('A', NOW + 20 * HOUR, 'rot-global-A'));
    expect((await h.engine.checkSlots()).some((v) => v.kind === 'reserved_live_in_global')).toBe(
      true,
    );
    await h.engine.repairSlots();
    expect(await h.engine.getActiveId('global')).not.toBe(A.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Crash safety: a fault at EVERY checkpoint converges, and no account is ever live in two slots.
// ---------------------------------------------------------------------------

describe('bindAlias — crash at every fault point converges', () => {
  it.each([['bind:after-global-switch'], ['bind:after-row-move'], ['bind:after-ensure-live']])(
    'a fault at %s',
    async (cp) => {
      const h = await harness();
      const { A, B } = await seed(h);
      await h.engine.activate(A.id); // exercise the global hand-off too
      const repo = await h.folder('repo');
      const faulted = h.restart((c) => {
        if (c === cp) throw new Error('boom');
      });
      await expect(faulted.bindAlias(repo, 'x', [A.id, B.id])).rejects.toThrow('boom');
      const fresh = h.restart();
      await expectSlotsClean(fresh);
      // The interrupted state self-heals, and rerunning the bind completes it.
      await converge(fresh, h.vault);
      const res = await fresh.bindAlias(repo, 'x', [A.id, B.id]);
      expect(res.live.noWorkingAccount).toBe(false);
      expect(await fresh.getActiveId('global')).not.toBe(A.id);
      expect(await fresh.checkSlots()).toEqual([]);
    },
  );
});

describe('unbindAlias — crash at every fault point converges', () => {
  it.each([['unbind:after-adopt'], ['unbind:after-clear-live'], ['unbind:after-release']])(
    'a fault at %s',
    async (cp) => {
      const h = await harness();
      const { A, B } = await seed(h);
      const repo = await h.folder('repo');
      await h.engine.bindAlias(repo, 'x', [A.id, B.id]);
      const faulted = h.restart((c) => {
        if (c === cp) throw new Error('boom');
      });
      await expect(faulted.unbindAlias(repo, 'x')).rejects.toThrow('boom');
      const fresh = h.restart();
      await expectSlotsClean(fresh);
      try {
        expect((await fresh.unbindAlias(repo, 'x')).dissolved).toBe(true);
      } catch (err) {
        // Released already: the group is gone, so the scope is simply not bound any more.
        expect((err as { code?: string }).code).toBe('not_bound');
      }
      await converge(fresh, h.vault);
      expect((await h.vault.listGroups()).length).toBe(0);
    },
  );
});

describe('addGroupMembers — crash at every fault point converges', () => {
  it.each([['grow:after-global-switch'], ['grow:after-row-move'], ['grow:after-ensure-live']])(
    'a fault at %s',
    async (cp) => {
      const h = await harness();
      const { A, B } = await seed(h);
      const repo = await h.folder('repo');
      const bind = await h.engine.bindAlias(repo, 'x', [A.id]);
      await h.engine.activate(B.id); // B is global: adding it exercises the hand-off
      const faulted = h.restart((c) => {
        if (c === cp) throw new Error('boom');
      });
      await expect(faulted.addGroupMembers(bind.group.id, [B.id])).rejects.toThrow('boom');
      const fresh = h.restart();
      await expectSlotsClean(fresh);
      await converge(fresh, h.vault);
      await fresh.addGroupMembers(bind.group.id, [B.id]);
      expect((await h.vault.getGroup(bind.group.id))?.members.map((m) => m.id).sort()).toEqual(
        [A.id, B.id].sort(),
      );
      expect(await fresh.getActiveId('global')).not.toBe(B.id);
      expect(await fresh.checkSlots()).toEqual([]);
    },
  );
});

describe('removeGroupMembers — crash at every fault point converges', () => {
  it.each([['shrink:after-switch-off'], ['shrink:after-release']])(
    'removing the LIVE member, a fault at %s',
    async (cp) => {
      const h = await harness();
      const { A, B } = await seed(h);
      const repo = await h.folder('repo');
      const bind = await h.engine.bindAlias(repo, 'x', [A.id, B.id]); // A live
      const faulted = h.restart((c) => {
        if (c === cp) throw new Error('boom');
      });
      await expect(faulted.removeGroupMembers(bind.group.id, [A.id])).rejects.toThrow('boom');
      const fresh = h.restart();
      await expectSlotsClean(fresh);
      try {
        await fresh.removeGroupMembers(bind.group.id, [A.id]);
      } catch (err) {
        // Already released: A is no longer a member.
        expect((err as { code?: string }).code).toBe('not_a_member');
      }
      await converge(fresh, h.vault);
      expect((await h.vault.getGroup(bind.group.id))?.members.map((m) => m.id)).toEqual([B.id]);
      expect(await fresh.getActiveId(groupSlotId(bind.group.id))).toBe(B.id);
    },
  );

  it.each([['unbind:after-adopt'], ['unbind:after-clear-live'], ['unbind:after-release']])(
    'removing EVERY member (dissolve), a fault at %s',
    async (cp) => {
      const h = await harness();
      const { A, B } = await seed(h);
      const repo = await h.folder('repo');
      const bind = await h.engine.bindAlias(repo, 'x', [A.id, B.id]);
      const faulted = h.restart((c) => {
        if (c === cp) throw new Error('boom');
      });
      await expect(faulted.removeGroupMembers(bind.group.id, [A.id, B.id])).rejects.toThrow('boom');
      const fresh = h.restart();
      await expectSlotsClean(fresh);
      try {
        expect((await fresh.removeGroupMembers(bind.group.id, [A.id, B.id])).dissolved).toBe(true);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('not_bound');
      }
      await converge(fresh, h.vault);
      expect((await h.vault.listGroups()).length).toBe(0);
    },
  );
});
