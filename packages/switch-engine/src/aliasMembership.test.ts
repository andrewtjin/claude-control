// Alias bindings as the rest of the machine meets them: running-session detection, growing and
// shrinking a binding whose picture another process changed, an older folder-only build rewriting
// groups.json, hand-edited folder spellings, and the cost of a registry at its caps.
//
// Real sandbox dirs and a real SwitchEngine over a passthrough protector; the liveness probe and the
// transcript lookup (the `sessionIdentity` seam the CLI wires to the daemon's session catalog) are
// injected so every case is deterministic.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { folderBindingsPath, groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { readFolderBindingSnapshot } from './folderBindings.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  SessionIdentity,
  SessionIdentityLookup,
} from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
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
  /** What the injected transcript lookup reports, by lower-cased session id. */
  transcripts: Map<string, SessionIdentity>;
  folder: (name: string) => Promise<string>;
  /** A second engine over the same files (another process). */
  other: () => SwitchEngine;
}

/** `failRefreshFor`: tokens whose refresh fails (a transient network error), to make a member
 *  unable to take a slot over. `withIdentity`: wire the transcript lookup (production does). */
async function harness(
  opts: { failRefreshFor?: ReadonlySet<string>; withIdentity?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-alias-members-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const clock = (): number => NOW;
  const protector = new InsecurePassthroughProtector();
  const alive = new Set<number>();
  const transcripts = new Map<string, SessionIdentity>();
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
  const refresh = (cur: ClaudeOauth): Promise<ClaudeOauth> => {
    if ([...(opts.failRefreshFor ?? [])].some((t) => cur.accessToken.includes(t))) {
      return Promise.reject(new Error('ETIMEDOUT (simulated transient network failure)'));
    }
    return Promise.resolve({ ...cur, expiresAt: clock() + HOUR });
  };
  const lookup: SessionIdentityLookup = (_dir, ids) =>
    Promise.resolve(
      new Map(
        ids
          .map((id) => [id.toLowerCase(), transcripts.get(id.toLowerCase())] as const)
          .filter((e): e is readonly [string, SessionIdentity] => e[1] !== undefined),
      ),
    );
  const mkEngine = (): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 10 },
      platform: process.platform,
      bindFs,
      isProcessAlive: (pid) => alive.has(pid),
      bindEnforce: 'block',
      ...(opts.withIdentity === true ? { sessionIdentity: lookup } : {}),
    });
  return {
    root,
    paths,
    engine: mkEngine(),
    vault: new Vault(paths.vaultDir, protector, clock, undefined, process.platform),
    alive,
    transcripts,
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
    other: mkEngine,
  };
}

function bundleFor(access: string, expiresAt = NOW + 10 * HOUR): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt },
    oauthAccount: { accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' },
  };
}

/** A running Claude Code session file as 2.1.283 writes it (`sessions/<pid>.json`). */
async function runningSession(
  h: Harness,
  pid: number,
  rec: { cwd: string; sessionId?: string; name?: string; nameSource?: string },
): Promise<void> {
  const dir = join(h.paths.claudeDir, 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, kind: 'interactive', ...rec }));
  h.alive.add(pid);
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

describe('running sessions of an alias binding', () => {
  it('a session resumed by title (derived name in its session file) blocks a dissolving unbind', async () => {
    const h = await harness({ withIdentity: true });
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'Auth Work', [B.id]);
    // `claude --resume "Auth Work"` records a DERIVED name; only the transcript knows the title.
    await runningSession(h, 44248, {
      cwd: repo,
      sessionId: 'S-1',
      name: 'repo-9e',
      nameSource: 'derived',
    });
    h.transcripts.set('s-1', { customTitle: 'Auth Work', folder: repo });

    await expect(h.engine.unbindAlias(repo, 'auth work')).rejects.toMatchObject({
      code: 'sessions_running',
    });
    expect(await h.engine.listGroups()).toHaveLength(1);
  });

  it('an unnamed session whose derived name equals the alias is not in the alias scope', async () => {
    const h = await harness({ withIdentity: true });
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'repo-4f', [B.id]);
    await runningSession(h, 5150, {
      cwd: repo,
      sessionId: 's-2',
      name: 'repo-4f',
      nameSource: 'derived',
    });
    h.transcripts.set('s-2', { customTitle: null, folder: repo });

    const res = await h.engine.unbindAlias(repo, 'repo-4f');
    expect(res.dissolved).toBe(true);
  });

  it('without a transcript lookup, only a name the operator set counts (never a derived one)', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    await h.engine.bindAlias(repo, 'repo-4f', [B.id]);
    await runningSession(h, 5151, { cwd: repo, name: 'repo-4f', nameSource: 'derived' });
    expect((await h.engine.unbindAlias(repo, 'repo-4f')).dissolved).toBe(true);

    await h.engine.bindAlias(repo, 'Named', [B.id]);
    await runningSession(h, 5152, { cwd: repo, name: 'Named', nameSource: 'user' });
    await expect(h.engine.unbindAlias(repo, 'Named')).rejects.toMatchObject({
      code: 'sessions_running',
    });
  });

  it('a session keys on its RECORDED folder: resumed from the repo root, it still belongs to its subfolder', async () => {
    const h = await harness({ withIdentity: true });
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const sub = await h.folder(join('repo', 'sub'));
    await h.engine.bindAlias(sub, 'Sub Alias', [B.id]);
    // Running in the root (where it was resumed from), recorded in the subfolder.
    await runningSession(h, 7001, {
      cwd: repo,
      sessionId: 's-3',
      name: 'repo-1a',
      nameSource: 'derived',
    });
    h.transcripts.set('s-3', { customTitle: 'Sub Alias', folder: sub });
    await expect(h.engine.unbindAlias(sub, 'Sub Alias')).rejects.toMatchObject({
      code: 'sessions_running',
    });
  });

  it('a failing transcript lookup falls back to the session file, never throws', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const failing = new SwitchEngine({
      paths: h.paths,
      protector: new InsecurePassthroughProtector(),
      liveCredentialChannel: new FileCredentialChannel(h.paths.credentialsPath),
      refresh: (c: ClaudeOauth) => Promise.resolve(c),
      clock: () => NOW,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 10 },
      isProcessAlive: (pid) => h.alive.has(pid),
      bindEnforce: 'block',
      sessionIdentity: () => Promise.reject(new Error('EBUSY')),
    });
    await failing.bindAlias(repo, 'Named', [B.id]);
    await runningSession(h, 7002, { cwd: repo, sessionId: 's', name: 'Named', nameSource: 'user' });
    await expect(failing.unbindAlias(repo, 'Named')).rejects.toMatchObject({
      code: 'sessions_running',
    });
  });
});

describe('shrinking an alias binding under running sessions', () => {
  it('refuses, changing nothing, when every remaining account fails to take the slot over', async () => {
    // C's token is near expiry and its refresh fails transiently: it exists as a candidate but
    // cannot be seated.
    const h = await harness({ failRefreshFor: new Set(['C']), withIdentity: true });
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    const C = await h.engine.addAccount('C', bundleFor('C', NOW + 60_000));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth', [B.id, C.id]);
    expect(bound.live.liveMember).toBe(B.id);
    await runningSession(h, 4242, {
      cwd: repo,
      sessionId: 's-4',
      name: 'auth',
      nameSource: 'user',
    });
    h.transcripts.set('s-4', { customTitle: 'auth', folder: repo });

    await expect(h.engine.removeGroupMembers(bound.group.id, [B.id])).rejects.toMatchObject({
      code: 'sessions_running',
    });
    // Same contract as when no account remains at all: nothing cleared, B still a member.
    expect((await groupStore(h.paths, bound.group.id).readLiveCredentials())?.refreshToken).toBe(
      'r-B',
    );
    const g = (await h.engine.listGroups())[0]!;
    expect(g.members.map((m) => m.id).sort()).toEqual([B.id, C.id].sort());
  });

  it('with --force it clears the slot (fails closed) and releases the account', async () => {
    const h = await harness({ failRefreshFor: new Set(['C']), withIdentity: true });
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    const C = await h.engine.addAccount('C', bundleFor('C', NOW + 60_000));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth', [B.id, C.id]);
    await runningSession(h, 4243, {
      cwd: repo,
      sessionId: 's-5',
      name: 'auth',
      nameSource: 'user',
    });

    const res = await h.engine.removeGroupMembers(bound.group.id, [B.id], { force: true });
    expect(res.switchedTo).toBeNull();
    expect(await groupStore(h.paths, bound.group.id).readLiveCredentials()).toBeUndefined();
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('growing or shrinking ONE scope of a binding another process changed', () => {
  it('addGroupMembers with a sole-scope precondition refuses once a folder was bound to the same group', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const W = await h.engine.addAccount('W', bundleFor('W'));
    const C = await h.engine.addAccount('C', bundleFor('C'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const research = await h.folder('research');
    const bound = await h.engine.bindAlias(repo, 'Auth Work', [W.id]);
    // Another process: `cctl bind <research> W` reuses the {W} group (V1's exact-member-set rule).
    await h.other().bindFolder(research, [W.id]);

    await expect(
      h.engine.addGroupMembers(bound.group.id, [C.id], {
        soleScope: { kind: 'alias', folder: repo, alias: 'auth work' },
      }),
    ).rejects.toMatchObject({ code: 'binding_changed' });
    const g = (await h.engine.listGroups())[0]!;
    expect(g.members.map((m) => m.id)).toEqual([W.id]);
    expect(g.folders).toEqual([research]);
  });

  it('removeGroupMembers with a sole-scope precondition refuses the same way', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const W = await h.engine.addAccount('W', bundleFor('W'));
    const C = await h.engine.addAccount('C', bundleFor('C'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const research = await h.folder('research');
    const bound = await h.engine.bindAlias(repo, 'Auth Work', [W.id, C.id]);
    await h.other().bindFolder(research, [W.id, C.id]);

    await expect(
      h.engine.removeGroupMembers(bound.group.id, [C.id], {
        soleScope: { kind: 'alias', folder: repo, alias: 'Auth Work' },
      }),
    ).rejects.toMatchObject({ code: 'binding_changed' });
    expect((await h.engine.listGroups())[0]!.members).toHaveLength(2);
  });

  it('the precondition holds when the alias is still the only scope (case, spacing, separators)', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const W = await h.engine.addAccount('W', bundleFor('W'));
    const C = await h.engine.addAccount('C', bundleFor('C'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'Auth Work', [W.id]);
    const res = await h.engine.addGroupMembers(bound.group.id, [C.id], {
      soleScope: { kind: 'alias', folder: repo, alias: '  AUTH work ' },
    });
    expect(res.added).toEqual([C.id]);
  });
});

describe('unbinding reports the scope as it was stored', () => {
  it('names the stored folder and alias of THIS folder, not another folder’s spelling', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const one = await h.folder('one');
    const two = await h.folder('two');
    await h.engine.bindAlias(one, 'x', [B.id]);
    await h.engine.bindAlias(two, 'X  ', [B.id]); // same group, same key, another folder
    const res = await h.engine.unbindAlias(two, 'x');
    expect(res.folder).toBe(two);
    expect(res.alias).toBe('X  ');
    expect(res.dissolved).toBe(false);
  });

  it('refuses a missing alias folder with a readable reason', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    await h.engine.activate(A.id, { force: true });
    await expect(h.engine.bindAlias(join(h.root, 'nope'), 'x', [A.id])).rejects.toThrow(
      /: it is not an existing directory$/,
    );
  });
});

describe('groups.json written by a folder-only build', () => {
  it('is stamped schemaVersion 2 while any alias scope exists, and 1 again once none is left', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    const C = await h.engine.addAccount('C', bundleFor('C'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const research = await h.folder('research');
    const version = async (): Promise<unknown> =>
      (
        JSON.parse(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')) as {
          schemaVersion: unknown;
        }
      ).schemaVersion;

    await h.engine.bindFolder(research, [C.id]);
    expect(await version()).toBe(1); // folder bindings only: every folder-only build reads it
    await h.engine.bindAlias(repo, 'auth work', [B.id]);
    // A folder-only build refuses any schemaVersion but 1, so it fails closed instead of loading
    // the file and dropping the alias scopes it does not know on its next write.
    expect(await version()).toBe(2);
    await h.engine.unbindAlias(repo, 'auth work');
    expect(await version()).toBe(1);
  });

  it('an alias-only group whose aliases a folder-only build dropped still loads, routes nothing, and can be dissolved', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const W = await h.engine.addAccount('W', bundleFor('W'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth work', [W.id]);
    // What the folder-only build writes on its next group write: no `aliases`, schemaVersion 1.
    const path = join(h.paths.vaultDir, 'groups.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as {
      schemaVersion: number;
      groups: { aliases?: unknown }[];
    };
    file.schemaVersion = 1;
    delete file.groups[0]!.aliases;
    await writeFile(path, JSON.stringify(file));

    // Every command still works; the group routes nothing; its member stays reserved.
    const groups = await h.engine.listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.folders).toEqual([]);
    expect(groups[0]!.aliases).toBeUndefined();
    expect(await h.engine.resolveSessionBinding(repo, 'auth work')).toBeNull();
    expect(await h.engine.listAccounts()).toEqual([expect.objectContaining({ id: A.id })]);
    expect(await h.engine.checkSlots()).toEqual([]);
    // Binding the alias to the same account set again reuses the group (it gets its scope back)...
    const again = await h.engine.bindAlias(repo, 'auth work', [W.id]);
    expect(again.group.id).toBe(bound.group.id);
    expect(again.created).toBe(false);
  });

  it('a scope-less group is released by removing its accounts (it dissolves)', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const W = await h.engine.addAccount('W', bundleFor('W'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth work', [W.id]);
    const path = join(h.paths.vaultDir, 'groups.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { groups: { aliases?: unknown }[] };
    delete file.groups[0]!.aliases;
    await writeFile(path, JSON.stringify(file));

    const res = await h.engine.removeGroupMembers(bound.group.id, [W.id]);
    expect(res.dissolved).toBe(true);
    expect(await h.engine.listGroups()).toEqual([]);
    expect((await h.engine.listAccounts()).map((a) => a.id).sort()).toEqual([A.id, W.id].sort());
  });
});

describe('a hand-edited alias folder spelling', () => {
  it('still routes: the precedence rule and the guard snapshot compare canonical folders', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    const bound = await h.engine.bindAlias(repo, 'auth', [B.id]);
    // The same directory, spelled with forward slashes and a trailing separator (a hand edit or a
    // POSIX-style writer); on POSIX a doubled separator.
    const path = join(h.paths.vaultDir, 'groups.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as {
      groups: { aliases: { folder: string }[] }[];
    };
    const odd =
      process.platform === 'win32' ? repo.replace(/\\/g, '/') + '/' : repo.replace('/', '//') + '/';
    file.groups[0]!.aliases[0]!.folder = odd;
    await writeFile(path, JSON.stringify(file));

    expect((await h.engine.resolveSessionBinding(repo, 'Auth'))?.groupId).toBe(bound.group.id);
    await h.engine.refreshSnapshot();
    const snap = await readFolderBindingSnapshot(folderBindingsPath(h.paths.vaultDir));
    expect(snap?.groups[0]?.aliases?.[0]?.folder).toBe(repo);
  });
});

describe('a registry at its caps', () => {
  it('reads and switches without holding the lock for seconds', async () => {
    const h = await harness();
    const A = await h.engine.addAccount('A', bundleFor('A'));
    const B = await h.engine.addAccount('B', bundleFor('B'));
    await h.engine.activate(A.id, { force: true });
    const repo = await h.folder('repo');
    // 63 groups x 256 alias scopes with long aliases: the largest file the loader accepts.
    const groups = [];
    for (let g = 0; g < 63; g += 1) {
      const aliases = [];
      for (let a = 0; a < 256; a += 1) {
        aliases.push({
          folder: join(repo, `g${g}`, `f${a}`),
          alias: `g${g}-alias-${a}-${'x'.repeat(480)}`,
        });
      }
      groups.push({
        id: `00000000-0000-4000-8000-${String(g).padStart(12, '0')}`,
        label: `g${g}`,
        members: [
          { id: `m${g}`, label: `m${g}`, quarantined: false, createdAtMs: NOW, updatedAtMs: NOW },
        ],
        activeId: null,
        folders: [],
        aliases,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      });
    }
    await writeFile(
      join(h.paths.vaultDir, 'groups.json'),
      JSON.stringify({ schemaVersion: 2, generation: 1, groups }),
    );
    await h.vault.listGroups(); // warm (first parse)
    const t0 = performance.now();
    for (let i = 0; i < 5; i += 1) await h.vault.listGroups();
    const perRead = (performance.now() - t0) / 5;
    const t1 = performance.now();
    await h.engine.activate(B.id, { force: true });
    const activate = performance.now() - t1;
    // Measured before stored folders were memoized and keyed without filesystem probes: ~2 s per
    // read and ~17 s for one activate (the lock's stale window is 60 s). Generous bounds: a loaded
    // box must not flake, a regression back to per-alias canonicalization must fail.
    expect(perRead).toBeLessThan(700);
    expect(activate).toBeLessThan(5000);
  }, 120_000);
});
