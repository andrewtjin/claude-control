// A switch writes a slot's live login in two files: the credentials (`.credentials.json`) and then
// the identity block (`oauthAccount` in `.claude.json`). Every reader decides WHO is live from the
// identity block, so a slot left holding one account's credentials under another account's identity
// is invisible to them — and the next switch's rotation adoption then stores the live token in the
// bundle the identity names, which is the wrong account's. These tests pin two defences (the third,
// rotation adoption refusing a token it cannot attribute, is in liveTokenOwnership.test.ts):
//
//   - a switch that fails after its credentials landed puts the previous login back before the
//     error surfaces (credentials AND identity);
//   - a switch that could not be undone (the undo failed, or the process died between the writes)
//     stays pending, and the next locked operation on that slot settles it — not only a restart.
//
// Failures are injected at the real write boundary: fsutil's atomicWriteFile is wrapped so chosen
// writes fail the way a Windows sharing violation does. Nothing else is mocked.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { groupSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle, OauthAccount } from './types.js';

// ---- write faults: fail chosen atomic writes by target path ---------------------------------------
interface WriteFault {
  target: string;
  /** Matching writes to let through before failing. */
  skip: number;
  /** How many matching writes to fail after the skipped ones. */
  times: number;
}
const faults = vi.hoisted(() => ({ rules: [] as WriteFault[] }));
vi.mock('./fsutil.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./fsutil.js')>();
  return {
    ...real,
    atomicWriteFile: async (...args: Parameters<typeof real.atomicWriteFile>) => {
      const rule = faults.rules.find((r) => r.target === args[0] && (r.skip > 0 || r.times > 0));
      if (rule !== undefined) {
        if (rule.skip > 0) {
          rule.skip -= 1;
        } else {
          rule.times -= 1;
          const err: NodeJS.ErrnoException = new Error('EPERM: operation not permitted, rename');
          err.code = 'EPERM';
          throw err;
        }
      }
      return real.atomicWriteFile(...args);
    },
  };
});

/** Fail the next `times` writes to `target`, after letting `skip` of them through. */
function failWrites(target: string, opts: { skip?: number; times?: number } = {}): void {
  faults.rules.push({ target, skip: opts.skip ?? 0, times: opts.times ?? 1 });
}

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];

afterEach(async () => {
  faults.rules = [];
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  paths: Paths;
  /** A fresh engine over the same on-disk state — the daemon, another CLI, or a restart. */
  mk: (faultAt?: (checkpoint: string) => void, now?: number) => SwitchEngine;
  vault: Vault;
  /** The GLOBAL slot's live files. */
  global: CredentialStore;
  folder: (name: string) => Promise<string>;
  refresh: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-torn-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
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
  const protector = new InsecurePassthroughProtector();
  const refreshImpl: RefreshFn = (c: ClaudeOauth) =>
    Promise.resolve({
      ...c,
      accessToken: 'refreshed-' + c.accessToken,
      refreshToken: 'rotated-' + c.refreshToken,
      expiresAt: NOW + 9 * HOUR,
    });
  const refresh = vi.fn(refreshImpl);
  const mk = (faultAt?: (checkpoint: string) => void, now = NOW): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock: () => now,
      refreshSkewMs: 5 * 60_000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      bindFs,
      isProcessAlive: () => false,
      bindEnforce: 'block',
      ...(faultAt ? { faultAt } : {}),
    });
  return {
    paths,
    mk,
    vault: new Vault(paths.vaultDir, protector, () => NOW, undefined, process.platform),
    global: new CredentialStore(paths),
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
    refresh,
  };
}

function identity(t: string): OauthAccount {
  return { accountUuid: 'uuid-' + t, emailAddress: t + '@x.com' };
}

/** P's token expires earlier than T's (T was minted later) — the ordinary case after a refresh, and
 *  the one where rotation adoption's direction guard lets a wrong token through. */
function bundle(t: string, expiresAt: number): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: 'at-' + t, refreshToken: 'rt-' + t, expiresAt },
    oauthAccount: identity(t),
  };
}

function groupStore(paths: Paths, groupId: string): CredentialStore {
  const dir = groupProfileDir(paths.vaultDir, groupId);
  return new CredentialStore({
    claudeDir: dir,
    credentialsPath: join(dir, '.credentials.json'),
    claudeJsonPath: join(dir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** Seed P (live in global), T and R — all shared, all far from expiry. */
async function seed(h: Harness) {
  const e = h.mk();
  const P = await e.addAccount('P', bundle('P', NOW + 2 * HOUR));
  const T = await e.addAccount('T', bundle('T', NOW + 8 * HOUR));
  const R = await e.addAccount('R', bundle('R', NOW + 8 * HOUR));
  await e.activate(P.id, { force: true });
  return { P, T, R };
}

/** The refresh tokens each seeded account's bundle holds. */
async function storedTokens(
  h: Harness,
  ids: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, id] of Object.entries(ids)) {
    out[name] = (await h.vault.readBundle(id)).claudeAiOauth.refreshToken;
  }
  return out;
}

/** Who the global slot's two live files name: the refresh token's suffix and the identity's. */
async function globalLive(h: Harness): Promise<{ creds?: string; identity?: string }> {
  const creds = (await h.global.readLiveCredentials())?.refreshToken;
  const uuid = (await h.global.readOauthAccount())?.accountUuid;
  return {
    ...(creds !== undefined ? { creds: creds.replace(/^rt-/, '') } : {}),
    ...(uuid !== undefined ? { identity: uuid.replace(/^uuid-/, '') } : {}),
  };
}

describe('a switch whose identity write fails after its credentials landed', () => {
  it('is undone before the error surfaces: the previous login is whole again, nothing pending', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    failWrites(h.paths.claudeJsonPath);

    await expect(h.mk().activate(T.id, { force: true })).rejects.toMatchObject({ code: 'EPERM' });

    expect(await globalLive(h)).toEqual({ creds: 'P', identity: 'P' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
    const e = h.mk();
    expect(await e.getActiveId('global')).toBe(P.id);
    expect(await e.checkSlots()).toEqual([]);
  });

  it('never lets the next switch store the target token in the previous account bundle', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    failWrites(h.paths.claudeJsonPath);
    await expect(h.mk().activate(T.id, { force: true })).rejects.toThrow();

    // The daemon keeps running and makes its next ordinary switch.
    await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
    expect(await globalLive(h)).toEqual({ creds: 'R', identity: 'R' });
  });

  it('never leaves the target live in two slots when it is bound right after', async () => {
    const h = await harness();
    const { T } = await seed(h);
    failWrites(h.paths.claudeJsonPath);
    await expect(h.mk().activate(T.id, { force: true })).rejects.toThrow();

    const e = h.mk();
    const bound = await e.bindFolder(await h.folder('repo'), [T.id]);

    const inGroup = (await groupStore(h.paths, bound.group.id).readLiveCredentials())?.refreshToken;
    const inGlobal = (await h.global.readLiveCredentials())?.refreshToken;
    expect(inGroup).toBe('rt-T');
    expect(inGlobal).not.toBe('rt-T');
    expect(await e.checkSlots()).toEqual([]);
  });

  it('undoes a failed group-slot switch inside the profile and leaves the global slot alone', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    const bound = await h.mk().bindFolder(await h.folder('repo'), [T.id, R.id]);
    const slot = groupSlotId(bound.group.id);
    const gStore = groupStore(h.paths, bound.group.id);
    const before = {
      creds: (await gStore.readLiveCredentials())?.refreshToken,
      identity: (await gStore.readOauthAccount())?.accountUuid,
    };
    const liveId = await h.mk().getActiveId(slot);
    const other = liveId === T.id ? R : T;
    failWrites(join(groupProfileDir(h.paths.vaultDir, bound.group.id), '.claude.json'));

    await expect(h.mk().activate(other.id, { force: true, slot })).rejects.toThrow();

    expect({
      creds: (await gStore.readLiveCredentials())?.refreshToken,
      identity: (await gStore.readOauthAccount())?.accountUuid,
    }).toEqual(before);
    expect(await h.mk().getActiveId(slot)).toBe(liveId);
    expect(await globalLive(h)).toEqual({ creds: 'P', identity: 'P' });
    expect(await h.mk().getActiveId('global')).toBe(P.id);
    expect(await new IntentStore(join(h.paths.vaultDir, 'slots', bound.group.id)).read()).toBe(
      undefined,
    );
    expect(await h.mk().checkSlots()).toEqual([]);
  });
});

describe('a switch undone because its read-back found another writer', () => {
  it('keeps that token live, stores it in no bundle, and withdraws the identity the switch wrote', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    // A session running on P started refreshing P's token just before the switch; its rotation lands
    // after the switch wrote T's credentials and identity, and before the read-back.
    const pRotation = { accessToken: 'at-P2', refreshToken: 'rt-P2', expiresAt: NOW + 9 * HOUR };
    const racing = h.mk((checkpoint) => {
      if (checkpoint === 'activate:after-live-write') {
        writeFileSync(h.paths.credentialsPath, JSON.stringify({ claudeAiOauth: pRotation }));
      }
    });

    await expect(racing.activate(T.id, { force: true })).rejects.toThrow(/read-back/);

    // Nothing says whose rotation it is but the block the switch itself wrote: no bundle takes it,
    // nothing overwrites it, and that block is gone.
    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
    expect(await globalLive(h)).toEqual({ creds: 'P2' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
    expect(await h.vault.getActiveId()).toBe(P.id);

    // Claude Code re-derives the block from the token; the next switch then saves P's rotation.
    await h.global.writeOauthAccount(identity('P'));
    await h.mk().activate(R.id, { force: true, origin: 'auto' });
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P2', T: 'rt-T' });
  });
});

describe('a failed switch whose undo fails too', () => {
  /** The identity write fails, and so does the undo's restore of the credentials (the second write
   *  to the credentials file) — the slot is left torn, with the switch still pending. */
  async function tornByFailedUndo(h: Harness, targetId: string): Promise<void> {
    failWrites(h.paths.claudeJsonPath);
    failWrites(h.paths.credentialsPath, { skip: 1 });
    await expect(h.mk().activate(targetId, { force: true })).rejects.toThrow();
  }

  it('stays pending, and the next locked operation settles it before reading the slot', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await tornByFailedUndo(h, T.id);
    expect(await globalLive(h)).toEqual({ creds: 'T', identity: 'P' });
    expect((await new IntentStore(h.paths.vaultDir).read())?.phase).toBe('writing');

    // No restart: the same long-running process makes its next switch.
    await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
    expect(await globalLive(h)).toEqual({ creds: 'R', identity: 'R' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('is settled by a restart: both live files name one account afterwards', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await tornByFailedUndo(h, T.id);

    const e = h.mk();
    const rec = await e.recover();
    expect(rec.recovered).toBe(true);
    const live = await globalLive(h);
    expect(live.creds).toBe(live.identity);
    expect(await e.getActiveId('global')).toBe(live.creds === 'T' ? T.id : P.id);

    await e.activate(R.id, { force: true, origin: 'auto' });
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });
});

describe('a process that dies between the credentials and identity writes', () => {
  const dieBetweenWrites = (checkpoint: string): void => {
    if (checkpoint === 'activate:after-credentials-write') throw new Error('process died');
  };

  it('leaves the switch pending, and the next locked operation settles it', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await expect(h.mk(dieBetweenWrites).activate(T.id, { force: true })).rejects.toThrow(
      'process died',
    );
    expect(await globalLive(h)).toEqual({ creds: 'T', identity: 'P' });

    await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
    expect(await globalLive(h)).toEqual({ creds: 'R', identity: 'R' });
  });

  it('a bind of the target right after the crash moves it off the global slot first', async () => {
    const h = await harness();
    const { T } = await seed(h);
    await expect(h.mk(dieBetweenWrites).activate(T.id, { force: true })).rejects.toThrow(
      'process died',
    );

    const e = h.mk();
    await e.bindFolder(await h.folder('repo'), [T.id]);

    expect((await h.global.readLiveCredentials())?.refreshToken).not.toBe('rt-T');
    expect(await e.checkSlots()).toEqual([]);
  });

  it('recover() leaves both live files naming one account, and the registry agreeing', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await expect(h.mk(dieBetweenWrites).activate(T.id, { force: true })).rejects.toThrow(
      'process died',
    );

    const e = h.mk();
    await e.recover();

    const live = await globalLive(h);
    expect(live.creds).toBe(live.identity);
    expect(await e.getActiveId('global')).toBe(live.creds === 'T' ? T.id : P.id);
    expect(await h.vault.getActiveId()).toBe(live.creds === 'T' ? T.id : P.id);
  });
});

describe('a pending switch whose live .claude.json stays unwritable', () => {
  const dieBetweenWrites = (checkpoint: string): void => {
    if (checkpoint === 'activate:after-credentials-write') throw new Error('process died');
  };

  /** A switch to T dies between its writes (T's credentials under P's identity, intent `writing`),
   *  and from then on another program keeps the global `.claude.json` open. Q is idle and inside the
   *  refresh window, so the daemon's usage poll refreshes it. */
  async function pendingWhileIdentityLocked(h: Harness) {
    const ids = await seed(h);
    const Q = await h.mk().addAccount('Q', bundle('Q', NOW + 60_000));
    await expect(h.mk(dieBetweenWrites).activate(ids.T.id, { force: true })).rejects.toThrow(
      'process died',
    );
    expect((await new IntentStore(h.paths.vaultDir).read())?.phase).toBe('writing');
    failWrites(h.paths.claudeJsonPath, { times: 1_000 });
    return { ...ids, Q };
  }

  it('recover() puts the previous login back, which needs no identity write', async () => {
    const h = await harness();
    const { P, T } = await pendingWhileIdentityLocked(h);

    const res = await h.mk().recover();

    expect(res).toMatchObject({ recovered: true, action: 'rolled_back' });
    expect(await globalLive(h)).toEqual({ creds: 'P', identity: 'P' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
    expect(await h.vault.getActiveId()).toBe(P.id);
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });

  it('an idle-account refresh and a relogin of an account that is not live both go through', async () => {
    const h = await harness();
    const { R, Q } = await pendingWhileIdentityLocked(h);

    await expect(h.mk().refreshToken(Q.id)).resolves.toMatchObject({ refreshed: true });

    const dir = join(h.paths.vaultDir, '..', 'relogin-tmp');
    await mkdir(dir, { recursive: true });
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-R9', refreshToken: 'rt-R9', expiresAt: NOW + 9 * HOUR },
      }),
    );
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: identity('R') }));
    await expect(h.mk().reloginFromConfigDir(R.id, dir)).resolves.toMatchObject({
      healedLiveLogin: false,
    });
    expect((await h.vault.readBundle(R.id)).claudeAiOauth.refreshToken).toBe('rt-R9');
  });
});

describe('a pending switch whose slot cannot be settled at all', () => {
  const dieBetweenWrites = (checkpoint: string): void => {
    if (checkpoint === 'activate:after-credentials-write') throw new Error('process died');
  };

  it('refuses only what depends on it, is reported, and settles once its files are free', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    const Q = await h.mk().addAccount('Q', bundle('Q', NOW + 60_000));
    const G1 = await h.mk().addAccount('G1', bundle('G1', NOW + 8 * HOUR));
    const G2 = await h.mk().addAccount('G2', bundle('G2', NOW + 8 * HOUR));
    const bound = await h.mk().bindFolder(await h.folder('repo'), [G1.id, G2.id]);
    const slot = groupSlotId(bound.group.id);
    await expect(h.mk(dieBetweenWrites).activate(T.id, { force: true })).rejects.toThrow(
      'process died',
    );
    // Neither of the global slot's live files can be replaced: nothing can finish or undo it.
    failWrites(h.paths.claudeJsonPath, { times: 1_000 });
    failWrites(h.paths.credentialsPath, { times: 1_000 });
    const unsettledError = { code: 'switch_unsettled' };

    // The daemon still starts, and says where and why.
    const rec = await h.mk().recover();
    expect(rec).toMatchObject({ recovered: false, action: 'unsettled' });
    expect(rec.detail).toContain('a switch of the global slot to "T"');
    expect(rec.detail).toContain('EPERM');
    expect((await new IntentStore(h.paths.vaultDir).read())?.phase).toBe('writing');

    // What writes that slot, or depends on the two accounts the switch was between, is refused.
    await expect(h.mk().activate(R.id, { force: true })).rejects.toMatchObject(unsettledError);
    await expect(h.mk().captureCurrentLogin('N')).rejects.toMatchObject(unsettledError);
    await expect(h.mk().refreshToken(P.id)).rejects.toMatchObject(unsettledError);
    await expect(h.mk().removeAccount(T.id)).rejects.toMatchObject(unsettledError);
    // Anything else goes on: another account's refresh, a switch inside a folder's own slot.
    await expect(h.mk().refreshToken(Q.id)).resolves.toMatchObject({ refreshed: true });
    const inGroup = (await h.mk().getActiveId(slot)) === G1.id ? G2 : G1;
    await expect(h.mk().activate(inGroup.id, { force: true, slot })).resolves.toMatchObject({
      ok: true,
    });

    // Reported by the repair (under the lock), and by an unlocked check once no switch that could
    // still be running is that old — never while one may be in flight.
    const reported: unknown = expect.objectContaining({
      kind: 'unsettled_switch',
      slot: 'global',
      accountId: T.id,
    });
    expect((await h.mk().repairSlots()).remaining).toContainEqual(reported);
    expect(await h.mk(undefined, NOW + 10 * 60_000).checkSlots()).toContainEqual(reported);
    expect(await h.mk().checkSlots()).not.toContainEqual(reported);

    // The other program lets go; the next operation on the slot settles it.
    faults.rules = [];
    await h.mk().activate(R.id, { force: true, origin: 'auto' });
    expect(await globalLive(h)).toEqual({ creds: 'R', identity: 'R' });
    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
    expect(await h.mk().checkSlots()).toEqual([]);
  });

  it('a record of one that cannot be read blocks that slot and is reported', async () => {
    const h = await harness();
    const { R } = await seed(h);
    writeFileSync(join(h.paths.vaultDir, '.switch-intent.json'), '{"phase":');

    const rec = await h.mk().recover();
    expect(rec).toMatchObject({ recovered: false, action: 'unsettled' });
    expect(rec.detail).toContain('could not be read');
    await expect(h.mk().activate(R.id, { force: true })).rejects.toMatchObject({
      code: 'switch_unsettled',
    });
    expect(await h.mk().checkSlots()).toContainEqual(
      expect.objectContaining({ kind: 'unsettled_switch', slot: 'global' }),
    );
  });
});

describe('a failed switch whose undo fails too, settled later', () => {
  it('is finished as an undo: the switch its caller was told failed is never completed', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // The identity write fails, and so does the undo's restore of the credentials.
    failWrites(h.paths.claudeJsonPath);
    failWrites(h.paths.credentialsPath, { skip: 1 });
    await expect(h.mk().activate(T.id, { force: true })).rejects.toThrow();
    expect(await globalLive(h)).toEqual({ creds: 'T', identity: 'P' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toMatchObject({ undo: true });

    const rec = await h.mk().recover();

    expect(rec).toMatchObject({ recovered: true, action: 'rolled_back' });
    expect(await globalLive(h)).toEqual({ creds: 'P', identity: 'P' });
    expect(await h.vault.getActiveId()).toBe(P.id);
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });
});
describe('an intent an older build left at phase "refreshed"', () => {
  /** What an older build leaves when it dies between the two live writes: the target's credentials
   *  live under the previous identity, the intent still at "refreshed", the rollback snapshot kept. */
  async function olderBuildTornState(h: Harness) {
    const ids = await seed(h);
    const p = await h.vault.readBundle(ids.P.id);
    await h.vault.writeRollback(p);
    await h.global.writeLiveCredentials((await h.vault.readBundle(ids.T.id)).claudeAiOauth);
    await new IntentStore(h.paths.vaultDir).write({
      phase: 'refreshed',
      targetId: ids.T.id,
      prevActiveId: ids.P.id,
      hasRollback: true,
      startedAtMs: NOW,
    });
    return ids;
  }

  it('is treated as possibly written: recover() settles the slot instead of just clearing', async () => {
    const h = await harness();
    const { P, T } = await olderBuildTornState(h);

    const e = h.mk();
    const rec = await e.recover();

    expect(rec.action).not.toBe('cleared');
    const live = await globalLive(h);
    expect(live.creds).toBe(live.identity);
    expect(await e.getActiveId('global')).toBe(live.creds === 'T' ? T.id : P.id);
  });

  it('the next switch after recovery keeps every bundle its own', async () => {
    const h = await harness();
    const { P, T, R } = await olderBuildTornState(h);
    const e = h.mk();
    await e.recover();
    await e.activate(R.id, { force: true, origin: 'auto' });
    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
  });
});
