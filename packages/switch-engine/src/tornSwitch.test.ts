// A switch writes the live login in two files: the credentials (`.credentials.json`) and then the
// identity block (`oauthAccount` in `.claude.json`). Every reader decides WHO is live from the
// identity block, so live files holding one account's credentials under another account's identity
// are invisible to them — and the next switch's rotation adoption then stores the live token in the
// bundle the identity names, which is the wrong account's. These tests pin two defences (the third,
// rotation adoption refusing a token it cannot attribute, is in liveTokenOwnership.test.ts):
//
//   - a switch that fails after its credentials landed puts the previous login back before the
//     error surfaces (credentials AND identity);
//   - a switch that could not be undone (the undo failed, or the process died between the writes)
//     stays pending, and the next locked operation settles it — not only a restart. That includes
//     the intent an older build leaves behind, which it records as "refreshed".
//
// Failures are injected at the real write boundary: fsutil's atomicWriteFile is wrapped so chosen
// writes fail the way a Windows sharing violation does. Nothing else is mocked.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { Vault } from './vault.js';
import { sandboxPaths, type Paths } from './paths.js';
import type { ClaudeOauth, CredentialBundle, OauthAccount, SwitchIntent } from './types.js';

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
  mk: () => SwitchEngine;
  vault: Vault;
  /** The live files. */
  live: CredentialStore;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-torn-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const refresh: RefreshFn = (c: ClaudeOauth) =>
    Promise.resolve({
      ...c,
      accessToken: 'refreshed-' + c.accessToken,
      refreshToken: 'rotated-' + c.refreshToken,
      expiresAt: NOW + 9 * HOUR,
    });
  const mk = (): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock: () => NOW,
      refreshSkewMs: 5 * 60_000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
    });
  return {
    paths,
    mk,
    vault: new Vault(paths.vaultDir, protector, () => NOW),
    live: new CredentialStore(paths),
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

/** Seed P (live), T and R — all far from expiry. */
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

/** Who the two live files name: the refresh token's suffix and the identity's. */
async function liveLogin(h: Harness): Promise<{ creds?: string; identity?: string }> {
  const creds = (await h.live.readLiveCredentials())?.refreshToken;
  const uuid = (await h.live.readOauthAccount())?.accountUuid;
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

    expect(await liveLogin(h)).toEqual({ creds: 'P', identity: 'P' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
    expect(await h.vault.readRollback()).toBeUndefined();
    expect(await h.mk().getActiveId()).toBe(P.id);
    expect(await h.vault.getActiveId()).toBe(P.id);
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
    expect(await liveLogin(h)).toEqual({ creds: 'R', identity: 'R' });
  });
});

describe('a switch that fails after both live writes landed', () => {
  it('puts the previous login back when the registry commit fails', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // The commit is the first registry write of this switch (no adoption, no refresh, no metadata).
    failWrites(join(h.paths.vaultDir, 'accounts.json'));

    await expect(h.mk().activate(T.id, { force: true })).rejects.toMatchObject({ code: 'EPERM' });

    expect(await liveLogin(h)).toEqual({ creds: 'P', identity: 'P' });
    expect(await h.vault.getActiveId()).toBe(P.id);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('removes the target identity when the previous login had none, rather than keep it', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // The previous login carried no identity block (a credentials-only capture, say).
    await h.live.clearOauthAccount();
    failWrites(join(h.paths.vaultDir, 'accounts.json'));

    await expect(h.mk().activate(T.id, { force: true })).rejects.toThrow();

    // Restoring P's credentials under T's identity would recreate the very mismatch this undoes.
    expect(await liveLogin(h)).toEqual({ creds: 'P' });
    expect(await h.vault.getActiveId()).toBe(P.id);
  });
});

describe('a failed switch whose undo fails too', () => {
  /** The identity write fails, and so does the undo's restore of the credentials (the second write
   *  to the credentials file) — the live files are left torn, with the switch still pending. */
  async function tornByFailedUndo(h: Harness, targetId: string): Promise<void> {
    failWrites(h.paths.claudeJsonPath);
    failWrites(h.paths.credentialsPath, { skip: 1 });
    await expect(h.mk().activate(targetId, { force: true })).rejects.toThrow();
  }

  it('stays pending, and the next locked operation settles it before reading the live login', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await tornByFailedUndo(h, T.id);
    expect(await liveLogin(h)).toEqual({ creds: 'T', identity: 'P' });
    expect((await new IntentStore(h.paths.vaultDir).read())?.phase).toBe('writing');

    // No restart: the same long-running process makes its next switch.
    await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
    expect(await liveLogin(h)).toEqual({ creds: 'R', identity: 'R' });
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('is settled by a restart: both live files name one account afterwards', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await tornByFailedUndo(h, T.id);

    const e = h.mk();
    const rec = await e.recover();
    expect(rec.recovered).toBe(true);
    const live = await liveLogin(h);
    expect(live.creds).toBe(live.identity);
    expect(await e.getActiveId()).toBe(live.creds === 'T' ? T.id : P.id);

    await e.activate(R.id, { force: true, origin: 'auto' });
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });
});

// A process that dies between the two live writes leaves exactly these files: the previous login's
// rollback snapshot, the target's credentials under the previous identity, and the intent. This build
// records that intent as "writing"; older builds (0.5.1 and before) recorded "refreshed" at the same
// point, and their recovery cleared it as if nothing had been written. Both must be settled.
describe.each<{ phase: SwitchIntent['phase']; by: string }>([
  { phase: 'writing', by: 'this build' },
  { phase: 'refreshed', by: 'an older build' },
])('a process that died between the two live writes ($by, phase "$phase")', ({ phase }) => {
  async function diedBetweenWrites(h: Harness) {
    const ids = await seed(h);
    await h.vault.writeRollback(await h.vault.readBundle(ids.P.id));
    await h.live.writeLiveCredentials((await h.vault.readBundle(ids.T.id)).claudeAiOauth);
    await new IntentStore(h.paths.vaultDir).write({
      phase,
      targetId: ids.T.id,
      prevActiveId: ids.P.id,
      hasRollback: true,
      startedAtMs: NOW,
    });
    expect(await liveLogin(h)).toEqual({ creds: 'T', identity: 'P' });
    return ids;
  }

  it('is settled by the next locked operation: the next switch keeps every bundle its own', async () => {
    const h = await harness();
    const { P, T, R } = await diedBetweenWrites(h);

    await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-P',
      T: 'rt-T',
      R: 'rt-R',
    });
    expect(await liveLogin(h)).toEqual({ creds: 'R', identity: 'R' });
  });

  it('is settled by recover(): both live files name one account, and the registry agrees', async () => {
    const h = await harness();
    const { P, T } = await diedBetweenWrites(h);

    const e = h.mk();
    const rec = await e.recover();

    expect(rec.action).not.toBe('cleared');
    const live = await liveLogin(h);
    expect(live.creds).toBe(live.identity);
    const expected = live.creds === 'T' ? T.id : P.id;
    expect(await e.getActiveId()).toBe(expected);
    expect(await h.vault.getActiveId()).toBe(expected);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });

  it('is settled before a background refresh reads who is live', async () => {
    const h = await harness();
    const { P, T } = await diedBetweenWrites(h);

    // The daemon's poller asks about the account the torn identity names.
    await h.mk().refreshToken(P.id);

    const live = await liveLogin(h);
    expect(live.creds).toBe(live.identity);
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });
});
