// Session-alias rules: includeInAlias, excludeInAlias, resetAlias, and the precedence rule that
// puts a named session on its alias rule ahead of its folder's.
//
// An alias rule is a folder rule whose scope is one session title in one exact folder, so it is held
// to the folder rule's contract: the same refusals (each naming the offender, each leaving nothing
// changed), the same hand-offs, the same running-session refusals (matched by the session's title
// and recorded folder), and the same crash safety — a fault injected after each step leaves a state a
// rerun, repairSlots or refreshSnapshot converges from, with no account ever live in two slots. The
// rules file is stamped schema 3 exactly while an alias scope exists.

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { MAX_RULES, Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, folderBindingsPath, type Paths } from './paths.js';
import { readFolderBindingSnapshot, type BindEnforceMode } from './folderBindings.js';
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

/** The raw `groups.json` the vault wrote. */
async function rulesFile(h: Harness): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Record a running session with a title the transcript lookup reports. */
async function runNamedSession(
  h: Harness,
  cwd: string,
  pid: number,
  sessionId: string,
  name: string | null,
): Promise<void> {
  const sessionsDir = join(h.paths.claudeDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `s${pid}.json`),
    JSON.stringify({
      pid,
      cwd,
      sessionId,
      ...(name !== null ? { name, nameSource: 'user' } : {}),
    }),
  );
  h.alive.add(pid);
}

describe('includeInAlias — creating a rule for a named session', () => {
  it('reserves the accounts, seats one, writes schema 3 and a snapshot carrying the alias key', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');

    const res = await h.engine.includeInAlias(repo, 'Auth Work', [A.id]);

    expect(res.created).toBe(true);
    expect(res.rule.folders).toEqual([]);
    expect(res.rule.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
    expect(res.rule.label).toBe(`session "Auth Work" in ${repo}`);
    expect(res.reserved).toEqual([A.id]);
    expect(await ruleIdsOf(h, A.id)).toEqual([res.rule.id]);
    expect(await liveIn(h, res.rule.id)).toBe('A');
    expect((await rulesFile(h)).schemaVersion).toBe(3);
    const snap = await snapshotOf(h);
    const row = snap.groups.find((g) => g.id === res.rule.id)!;
    expect(row.folders).toEqual([]);
    expect(row.aliases).toEqual([{ folder: repo, aliasKey: 'auth work', alias: 'Auth Work' }]);
    expect(row.members).toEqual(['A']);
    // B stays shared and keeps the global slot it may have had.
    expect(await ruleIdsOf(h, B.id)).toBeUndefined();
    await expectOneSlotPerAccount(h.engine);
  });

  it('reaches the same rule whatever the alias case or spacing, adding accounts to it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const first = await h.engine.includeInAlias(repo, 'Auth Work', [A.id]);

    const again = await h.engine.includeInAlias(repo, '  AUTH work ', [B.id]);

    expect(again.created).toBe(false);
    expect(again.rule.id).toBe(first.rule.id);
    expect(again.rule.include).toEqual([A.id, B.id]);
    // The alias stays as first entered.
    expect(again.rule.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
    expect(await h.engine.listRules()).toHaveLength(1);
  });

  it('gives one alias in two folders two rules (the folder tells them apart)', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const one = await h.folder('one');
    const two = await h.folder('two');

    const r1 = await h.engine.includeInAlias(one, 'x', [A.id]);
    const r2 = await h.engine.includeInAlias(two, 'x', [B.id]);

    expect(r1.rule.id).not.toBe(r2.rule.id);
    expect(await h.engine.listRules()).toHaveLength(2);
  });

  it('allows the home dir (an alias scope never captures subfolders), refuses cctl state', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const home = await h.folder('home');
    await expect(h.engine.includeInAlias(home, 'x', [A.id])).resolves.toMatchObject({
      created: true,
    });
    const err = await refusal(h.engine.includeInAlias(h.paths.vaultDir, 'y', [A.id]));
    expect(err.message).toContain('inside the cctl vault directory');
    const missing = await refusal(h.engine.includeInAlias(join(h.root, 'nope'), 'y', [A.id]));
    expect(missing.message).toContain('is not an existing directory');
  });

  it('refuses a blank, over-long, control- or bidi-carrying alias, creating nothing', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    for (const alias of ['   ', 'x'.repeat(201), 'a\u001b[31mb', 'a‮b']) {
      const err = await refusal(h.engine.includeInAlias(repo, alias, [A.id]));
      expect(err.message).toMatch(/alias/);
    }
    expect(await h.engine.listRules()).toEqual([]);
    expect(await sharedIds(h)).toContain(A.id);
  });

  it('counts the alias length in code points, as Claude Code does', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    // 195 ASCII characters and 5 emoji: 200 code points, 205 UTF-16 units — Claude Code keeps it.
    const alias = 'a'.repeat(195) + '\u{1F600}'.repeat(5);
    await expect(h.engine.includeInAlias(repo, alias, [A.id])).resolves.toMatchObject({
      created: true,
    });
  });

  it('refuses on macOS, like a folder rule', async () => {
    const h = await harness('darwin');
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const err = await refusal(h.engine.includeInAlias(repo, 'x', [A.id]));
    expect(err.message).toContain('not supported on macOS');
  });

  it('moves the global slot off an account it reserves', async () => {
    const h = await harness();
    const { A } = await seed(h);
    await h.engine.activate(A.id);
    const repo = await h.folder('repo');

    const res = await h.engine.includeInAlias(repo, 'x', [A.id]);

    expect(res.handedOff.map((x) => x.slot)).toEqual(['global']);
    expect(await liveInGlobal(h)).not.toBe('A');
    expect(await liveIn(h, res.rule.id)).toBe('A');
    await expectOneSlotPerAccount(h.engine);
  });

  it('a folder with a folder rule may also hold an alias rule; the two never merge', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const folderRule = await h.engine.includeInFolder(repo, [A.id]);
    const alias = await h.engine.includeInAlias(repo, 'x', [B.id]);

    expect(alias.rule.id).not.toBe(folderRule.rule.id);
    expect((await h.engine.getRule(folderRule.rule.id))?.include).toEqual([A.id]);
    expect(alias.rule.include).toEqual([B.id]);
  });
});

describe('resolveSessionRule — the precedence rule over rules', () => {
  it('the alias rule of the recorded folder outranks the folder rule; others get the folder rule', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const sub = await h.folder(join('repo', 'sub'));
    const folderRule = await h.engine.includeInFolder(repo, [A.id]);
    const aliasRule = await h.engine.includeInAlias(repo, 'Auth Work', [B.id]);

    expect(await h.engine.resolveSessionRule(repo, 'auth work')).toMatchObject({
      ruleId: aliasRule.rule.id,
      via: 'alias',
    });
    expect(await h.engine.resolveSessionRule(repo, 'other')).toMatchObject({
      ruleId: folderRule.rule.id,
      via: 'folder',
    });
    expect(await h.engine.resolveSessionRule(repo, null)).toMatchObject({
      ruleId: folderRule.rule.id,
    });
    // Exact folder: the same title in a subfolder runs under the folder rule.
    expect(await h.engine.resolveSessionRule(sub, 'auth work')).toMatchObject({
      ruleId: folderRule.rule.id,
    });
    // A session resumed from the subfolder but recorded in repo keeps its alias rule.
    expect(await h.engine.resolveSessionRule(sub, 'auth work', repo)).toMatchObject({
      ruleId: aliasRule.rule.id,
    });
    // Recorded in no folder an alias rule can name: the folder rule.
    expect(await h.engine.resolveSessionRule(repo, 'auth work', null)).toMatchObject({
      ruleId: folderRule.rule.id,
    });
  });

  it('a recorded folder spelled through a link still finds the alias rule of the folder it names', async () => {
    // A transcript records the cwd Claude Code ran with, which can be a junction or link to the
    // folder the alias rule stores canonically.
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    const other = await h.folder('other');
    const link = join(dirname(repo), 'repo-link');
    symlinkSync(repo, link, 'junction');
    await h.engine.includeInFolder(repo, [A.id]);
    const aliasRule = await h.engine.includeInAlias(repo, 'Auth Work', [B.id]);
    expect(await h.engine.resolveSessionRule(other, 'auth work', link)).toMatchObject({
      ruleId: aliasRule.rule.id,
      via: 'alias',
    });
  });

  it('an alias rule with no folder rule beside it: other sessions there run on the global slot', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    expect(await h.engine.resolveSessionRule(repo, 'y')).toBeNull();
    expect(await h.engine.resolveFolderRule(repo)).toBeNull();
  });
});

describe('excludeInAlias', () => {
  it('gives a named session a slot of its own that avoids the excluded accounts', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    await h.engine.activate(A.id);
    const repo = await h.folder('repo');

    const res = await h.engine.excludeInAlias(repo, 'x', [A.id]);

    expect(res.created).toBe(true);
    expect(res.rule.exclude).toEqual([A.id]);
    expect(res.rule.include).toEqual([]);
    // Its slot takes an available inherited account, never the excluded one.
    expect(res.live.liveAccount).not.toBe(A.id);
    expect(res.live.liveAccount).not.toBeNull();
    expect(await ruleIdsOf(h, B.id)).toBeUndefined();
    await expectOneSlotPerAccount(h.engine);
  });

  it('refuses an account the rule includes, naming it, with nothing changed', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    const before = await rulesFile(h);
    const err = await refusal(h.engine.excludeInAlias(repo, 'x', [A.id]));
    expect(err.message).toContain('"A"');
    expect(await rulesFile(h)).toEqual(before);
  });
});

describe('resetAlias', () => {
  it('removes the rule: rows return, the seat is cleared, the snapshot drops it, schema back to 2', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const created = await h.engine.includeInAlias(repo, 'Auth Work', [A.id]);

    const res = await h.engine.resetAlias(repo, 'auth WORK');

    expect(res).toMatchObject({ dissolved: true, folder: repo, alias: 'Auth Work' });
    expect(res.released).toEqual([A.id]);
    expect(await sharedIds(h)).toContain(A.id);
    expect(await liveIn(h, created.rule.id)).toBeUndefined();
    expect(await h.engine.listRules()).toEqual([]);
    expect((await snapshotOf(h)).groups).toEqual([]);
    const file = await rulesFile(h);
    expect(file.schemaVersion).toBe(2);
  });

  it('drops named accounts, keeping the rule; dropping the last one removes it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id, B.id]);

    const partial = await h.engine.resetAlias(repo, 'x', [A.id]);
    expect(partial.dissolved).toBe(false);
    expect(partial.rule?.include).toEqual([B.id]);
    expect(partial.released).toEqual([A.id]);
    await expectOneSlotPerAccount(h.engine);

    const last = await h.engine.resetAlias(repo, 'x', [B.id]);
    expect(last.dissolved).toBe(true);
    expect(await h.engine.listRules()).toEqual([]);
  });

  it('refuses an alias with no rule (another alias, another folder), naming it', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const other = await h.folder('other');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    for (const [folder, alias] of [
      [repo, 'y'],
      [other, 'x'],
    ] as const) {
      const err = await refusal(h.engine.resetAlias(folder, alias));
      expect(err.code).toBe('not_ruled');
      expect(err.message).toContain(`session "${alias}" in ${folder} has no rule`);
    }
  });

  it('removes the rule of a folder that has since been deleted', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const gone = await h.folder('gone');
    await h.engine.includeInAlias(gone, 'x', [A.id]);
    await rm(gone, { recursive: true, force: true });
    await expect(h.engine.resetAlias(gone, 'x')).resolves.toMatchObject({ dissolved: true });
  });

  it('refuses while a session of that alias runs there, unless forced', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    await runNamedSession(h, repo, 4242, 'b1b1b1b1-0000-4000-8000-000000000001', 'X');

    const err = await refusal(h.engine.resetAlias(repo, 'x'));
    expect(err.code).toBe('sessions_running');
    expect(await h.engine.listRules()).toHaveLength(1);

    await expect(h.engine.resetAlias(repo, 'x', undefined, { force: true })).resolves.toMatchObject(
      { dissolved: true },
    );
  });

  it('a session there that is named otherwise does not hold it back', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    await runNamedSession(h, repo, 4243, 'b1b1b1b1-0000-4000-8000-000000000002', 'other');
    await expect(h.engine.resetAlias(repo, 'x')).resolves.toMatchObject({ dissolved: true });
  });

  it('adopts a profile-side token rotation into the vault before clearing', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const created = await h.engine.includeInAlias(repo, 'x', [A.id]);
    await rotateInSlot(h, created.rule.id, 'A', 'rotated-in-profile');

    const res = await h.engine.resetAlias(repo, 'x');

    expect(res.adoptedRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rotated-in-profile');
  });
});

describe('running sessions of an alias rule', () => {
  it('counts a session titled so in exactly that folder, and one whose title cannot be learned', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const elsewhere = await h.folder('elsewhere');
    await runNamedSession(h, repo, 10, 'c0c0c0c0-0000-4000-8000-000000000001', 'X');
    await runNamedSession(h, elsewhere, 11, 'c0c0c0c0-0000-4000-8000-000000000002', 'x');
    // An unnamed session in the folder: with no transcript lookup its title is unknown.
    await runNamedSession(h, repo, 12, 'c0c0c0c0-0000-4000-8000-000000000003', null);

    const res = await h.engine.includeInAlias(repo, 'x', [A.id]);

    expect(res.runningSessions.map((s) => s.pid).sort()).toEqual([10, 12]);
    expect(res.runningSessions.find((s) => s.pid === 12)?.unidentified).toBe(true);
    expect(res.runningSessions.find((s) => s.pid === 10)?.unidentified).toBeUndefined();
  });
});

describe('checkSlots / repairSlots understand an alias-only rule', () => {
  it('evicts an account its pool does not hold from the rule slot', async () => {
    const h = await harness();
    const { B } = await seed(h);
    const repo = await h.folder('repo');
    const created = await h.engine.excludeInAlias(repo, 'x', [B.id]);
    // B is excluded there; plant it in the slot.
    await rotateInSlot(h, created.rule.id, 'B', 'r-B');

    expect((await h.engine.checkSlots()).length).toBeGreaterThan(0);
    await h.engine.repairSlots();
    // The slot now holds an account its pool does (the shared pool less B).
    expect(['A', 'C', 'D']).toContain(await liveIn(h, created.rule.id));
    await expectOneSlotPerAccount(h.engine);
  });
});

describe('alias rules — a fault after each step converges', () => {
  const steps = ['include:after-hand-off', 'include:after-row-move', 'include:after-ensure-live'];
  for (const step of steps) {
    it(`includeInAlias dies at ${step}; a rerun completes it`, async () => {
      const h = await harness();
      const { A } = await seed(h);
      await h.engine.activate(A.id);
      const repo = await h.folder('repo');
      const faulted = h.restart((cp) => {
        if (cp === step) throw new Error('boom');
      });
      await expect(faulted.includeInAlias(repo, 'x', [A.id])).rejects.toThrow('boom');
      await expectOneSlotPerAccount(h.engine);
      const res = await h.restart().includeInAlias(repo, 'x', [A.id]);
      expect(await liveIn(h, res.rule.id)).toBe('A');
      await h.engine.refreshSnapshotIfStale();
      expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
      expect(await h.engine.checkSlots()).toEqual([]);
    });
  }

  for (const step of ['reset:after-adopt', 'reset:after-clear-live', 'reset:after-release']) {
    it(`resetAlias dies at ${step}; a rerun completes it`, async () => {
      const h = await harness();
      const { A } = await seed(h);
      const repo = await h.folder('repo');
      await h.engine.includeInAlias(repo, 'x', [A.id]);
      const faulted = h.restart((cp) => {
        if (cp === step) throw new Error('boom');
      });
      await expect(faulted.resetAlias(repo, 'x')).rejects.toThrow('boom');
      await expectOneSlotPerAccount(h.engine);
      const rerun = h.restart();
      if ((await rerun.listRules()).length > 0) await rerun.resetAlias(repo, 'x');
      expect(await rerun.listRules()).toEqual([]);
      expect(await sharedIds(h)).toContain(A.id);
      await rerun.refreshSnapshotIfStale();
      expect(await rerun.checkSlots()).toEqual([]);
    });
  }
});

describe('alias scopes in groups.json', () => {
  it('rejects the same (folder, alias key) pair in two rules, and keeps unknown fields of an entry', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    const file = await rulesFile(h);
    const rules = file.rules as Array<Record<string, unknown>>;
    // A newer build's field on the alias entry survives this build rewriting the file.
    (rules[0]!.aliases as Array<Record<string, unknown>>)[0]!.future = 'kept';
    await writeFile(join(h.paths.vaultDir, 'groups.json'), JSON.stringify(file));
    await h.engine.includeInAlias(repo, 'X ', [(await addAccount(h, 'E')).id]);
    const after = await rulesFile(h);
    const entry = (
      (after.rules as Array<Record<string, unknown>>)[0]!.aliases as Array<Record<string, unknown>>
    )[0]!;
    expect(entry).toEqual({ future: 'kept', folder: repo, alias: 'x' });

    // A duplicate pair in a second rule is refused on load, by name.
    const dup = structuredClone(after);
    const second = structuredClone((dup.rules as Array<Record<string, unknown>>)[0]!);
    second.id = randomUUID();
    second.include = [];
    second.exclude = [];
    second.aliases = [{ folder: repo, alias: '  X' }];
    (dup.rules as unknown[]).push(second);
    await writeFile(join(h.paths.vaultDir, 'groups.json'), JSON.stringify(dup));
    await expect(h.vault.listRules()).rejects.toThrow('has more than one rule');
  });

  it('refuses malformed alias entries and a schema it does not know', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    const good = await rulesFile(h);
    const bad: Array<[unknown, string]> = [
      ['nope', 'aliases is not an array'],
      [[5], 'is not an object'],
      [[{ folder: '', alias: 'x' }], 'has no string folder'],
      [[{ folder: repo, alias: '  ' }], 'has no alias'],
      [[{ folder: repo, alias: 'x'.repeat(513) }], 'longer than 512'],
      [[{ folder: repo, alias: 'a\u0000b' }], 'NUL'],
    ];
    for (const [aliases, message] of bad) {
      const file = structuredClone(good);
      (file.rules as Array<Record<string, unknown>>)[0]!.aliases = aliases;
      await writeFile(join(h.paths.vaultDir, 'groups.json'), JSON.stringify(file));
      await expect(h.vault.listRules()).rejects.toThrow(message);
    }
    await writeFile(
      join(h.paths.vaultDir, 'groups.json'),
      JSON.stringify({ ...good, schemaVersion: 5 }),
    );
    await expect(h.vault.listRules()).rejects.toThrow('unsupported schemaVersion');
  });

  it('an alias longer than Claude Code keeps still loads (so it can be seen and reset)', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    await h.engine.includeInAlias(repo, 'x', [A.id]);
    const file = await rulesFile(h);
    (file.rules as Array<Record<string, unknown>>)[0]!.aliases = [
      { folder: repo, alias: 'y'.repeat(300) },
    ];
    await writeFile(join(h.paths.vaultDir, 'groups.json'), JSON.stringify(file));
    const rules = await h.vault.listRules();
    expect(rules[0]!.aliases?.[0]?.alias).toHaveLength(300);
    await expect(h.engine.resetAlias(repo, 'y'.repeat(300))).resolves.toMatchObject({
      dissolved: true,
    });
  });
});

describe('alias scopes in the vault', () => {
  it('round-trips: an alias rule is created, its scope removed only while another remains', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const created = await h.vault.createRule({
      folders: [repo],
      aliases: [{ folder: repo, alias: 'Auth Work' }],
      include: [A.id],
    });
    expect(created.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
    expect((await rulesFile(h)).schemaVersion).toBe(3);

    // The folder keeps the rule; the alias goes, and with it the field and schema 3.
    const kept = await h.vault.removeAliasFromRule(created.id, {
      folder: repo,
      alias: 'AUTH work',
    });
    expect(kept.aliases).toBeUndefined();
    const file = await rulesFile(h);
    expect(file.schemaVersion).toBe(2);
    expect('aliases' in (file.rules as Array<Record<string, unknown>>)[0]!).toBe(false);
    await expect(
      h.vault.removeAliasFromRule(created.id, { folder: repo, alias: 'Auth Work' }),
    ).rejects.toThrow('is not in folder rule');
  });

  it('resetting one scope of a rule holding a folder and an alias removes only that scope', async () => {
    // Only a hand edit puts both kinds of scope in one rule, and the vault loads it as valid.
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const other = await h.folder('other');
    const created = await h.vault.createRule({
      folders: [repo],
      aliases: [{ folder: other, alias: 'x' }],
      include: [A.id],
    });
    await expect(h.engine.resetAlias(other, 'x')).resolves.toMatchObject({ dissolved: false });
    const [kept] = await h.engine.listRules();
    expect(kept).toMatchObject({ id: created.id, folders: [repo], include: [A.id] });
    expect(kept?.aliases).toBeUndefined();
    expect(await ruleIdsOf(h, A.id)).toEqual([created.id]);
  });

  it('refuses removing the last scope of an alias-only rule (removing the rule is separate)', async () => {
    const h = await harness();
    const { A } = await seed(h);
    const repo = await h.folder('repo');
    const created = await h.vault.createRule({
      folders: [],
      aliases: [{ folder: repo, alias: 'x' }],
      include: [A.id],
    });
    await expect(
      h.vault.removeAliasFromRule(created.id, { folder: repo, alias: 'x' }),
    ).rejects.toThrow('is the last scope');
  });

  it('write guards key exactly like the load validator: another spelling of a held pair is refused', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const repo = await h.folder('repo');
    await h.vault.createRule({
      folders: [],
      aliases: [{ folder: repo, alias: 'x' }],
      include: [A.id],
    });
    const trailing = repo + (process.platform === 'win32' ? '\\' : '/');
    await expect(
      h.vault.createRule({
        folders: [],
        aliases: [{ folder: trailing, alias: ' X ' }],
        include: [B.id],
      }),
    ).rejects.toThrow('already has a folder rule');
    // The file the refused write would have produced never reached disk: it still loads.
    expect(await h.vault.listRules()).toHaveLength(1);
  });

  it('an alias rule past the rule cap is refused before the global slot moves off its account', async () => {
    const h = await harness();
    const { A } = await seed(h);
    for (let i = 0; i < MAX_RULES; i += 1) {
      const x = await h.vault.addAccount(`X${i}`, bundleFor(`X${i}`, NOW + 10 * HOUR));
      await h.vault.createRule({ folders: [], include: [x.id] });
    }
    await h.engine.activate(A.id);
    const repo = await h.folder('repo');

    await expect(h.engine.includeInAlias(repo, 'x', [A.id])).rejects.toThrow(
      `cannot create another folder rule (max ${MAX_RULES})`,
    );
    expect(await h.engine.getActiveId('global')).toBe(A.id);
    expect(await liveInGlobal(h)).toBe('A');
  });
});
