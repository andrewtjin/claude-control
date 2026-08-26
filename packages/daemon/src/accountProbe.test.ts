// AccountProbe: every collaborator is a fake EXCEPT the filesystem. The throwaway config dir
// is a real directory under a real temp root, because the two things most worth proving here —
// that a rotated credential is read back before the dir dies, and that the dir dies on every
// path — are claims about actual files. The SDK client is always fake: this suite must never
// spawn a Claude Code subprocess or spend a real turn.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockTimeoutError, RefreshError } from '@claude-control/switch-engine';
import type {
  ClaudeOauth,
  CredentialBundle,
  RefreshTokenResult,
  ReloginResult,
  StoredAccount,
} from '@claude-control/switch-engine';
import type {
  AgentSdkClient,
  AgentSdkEvent,
  AgentSdkQueryOptions,
} from '@claude-control/session-runtime';
import {
  AccountProbe,
  PROBE_COOLDOWN_MS,
  PROBE_MODEL,
  PROBE_PROMPT,
  type AccountProbeOptions,
  type ProbeCandidate,
} from './accountProbe.js';

const CANDIDATE: ProbeCandidate = { accountId: 'acct-new', label: 'spare' };

function oauth(refreshToken: string): ClaudeOauth {
  return { accessToken: `access-${refreshToken}`, refreshToken, expiresAt: 4_000_000 };
}

function bundle(refreshToken = 'rt-1'): CredentialBundle {
  return {
    claudeAiOauth: oauth(refreshToken),
    oauthAccount: { accountUuid: 'uuid-new', emailAddress: 'spare@example.com' },
  };
}

function storedAccount(): StoredAccount {
  return {
    id: CANDIDATE.accountId,
    label: CANDIDATE.label,
    quarantined: false,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

/** A fake SDK client that yields a scripted event stream and records what it was asked. The
 *  `onQuery` hook lets a test act on the seeded config dir mid-turn — which is how the CLI's
 *  credential rotation is simulated without a subprocess. */
interface FakeClient extends AgentSdkClient {
  queries: Array<{ prompt: string; opts: AgentSdkQueryOptions }>;
  interrupts: number;
  ends: number;
}

interface FakeClientScript {
  events?: AgentSdkEvent[];
  /** Never completes until `end()` is called — the hung-turn case. */
  hang?: boolean;
  onQuery?: () => Promise<void> | void;
}

function fakeClient(script: FakeClientScript = {}): FakeClient {
  const events = script.events ?? [{ type: 'turn_result', ok: true, summary: 'OK' }];
  let release: (() => void) | undefined;
  const client: FakeClient = {
    queries: [],
    interrupts: 0,
    ends: 0,
    query(prompt, opts) {
      client.queries.push({ prompt, opts });
      return (async function* stream(): AsyncGenerator<AgentSdkEvent> {
        await script.onQuery?.();
        if (script.hang) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return;
        }
        for (const event of events) yield event;
      })();
    },
    interrupt(): Promise<void> {
      client.interrupts += 1;
      return Promise.resolve();
    },
    end(): Promise<void> {
      client.ends += 1;
      release?.();
      return Promise.resolve();
    },
  };
  return client;
}

describe('AccountProbe', () => {
  let root: string;
  let now: number;
  let readBundle: ReturnType<typeof vi.fn>;
  let refreshToken: ReturnType<typeof vi.fn>;
  let reloginFromConfigDir: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'account-probe-'));
    now = 1_000_000;
    readBundle = vi.fn((): Promise<CredentialBundle> => Promise.resolve(bundle()));
    refreshToken = vi.fn((accountId: string): Promise<RefreshTokenResult> =>
      Promise.resolve({ accountId, refreshed: true, expiresAt: 4_000_000 }),
    );
    reloginFromConfigDir = vi.fn((): Promise<ReloginResult> =>
      Promise.resolve({ account: storedAccount(), healedLiveLogin: false }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeProbe(overrides: Partial<AccountProbeOptions> = {}): {
    probe: AccountProbe;
    dirs: string[];
  } {
    const dirs: string[] = [];
    const probe = new AccountProbe({
      vault: { readBundle },
      engine: { refreshToken, reloginFromConfigDir },
      configDirRoot: root,
      createClient: (configDir) => {
        dirs.push(configDir);
        return fakeClient();
      },
      clock: () => now,
      ...overrides,
    });
    return { probe, dirs };
  }

  /** Every probe dir this suite creates lives directly under `root`, so an empty root is proof
   *  the throwaway dir was deleted — including its `.credentials.json`. */
  async function rootIsEmpty(): Promise<boolean> {
    return (await readdir(root)).length === 0;
  }

  it('runs one cheap tool-less turn under the account config dir and reports success', async () => {
    let seeded: string | undefined;
    let client: FakeClient | undefined;
    const { probe, dirs } = makeProbe({
      createClient: (configDir) => {
        dirs.push(configDir);
        client = fakeClient({
          onQuery: async () => {
            // Proof the bind is real: the credentials are on disk in the dir the client was
            // handed, at the moment the turn runs.
            seeded = await readFile(join(configDir, '.credentials.json'), 'utf8');
          },
        });
        return client;
      },
    });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([CANDIDATE.accountId]);

    // Refreshed in the vault first, never activated.
    expect(refreshToken).toHaveBeenCalledWith(CANDIDATE.accountId);
    expect(seeded).toContain('rt-1');
    const query = client?.queries[0];
    expect(query?.prompt).toBe(PROBE_PROMPT);
    expect(query?.opts).toMatchObject({
      accountId: CANDIDATE.accountId,
      cwd: dirs[0],
      model: PROBE_MODEL,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'dontAsk',
    });
    expect(await rootIsEmpty()).toBe(true);
  });

  it('harvests a rotated refresh token into the vault BEFORE deleting the dir', async () => {
    // The CLI rotating the single-use token inside the throwaway dir is the whole hazard: miss
    // it and the vault is left holding a spent token.
    let dirAtHarvest: string | undefined;
    let credentialsAtHarvest: string | undefined;
    reloginFromConfigDir.mockImplementation(async (_id: string, configDir: string) => {
      dirAtHarvest = configDir;
      credentialsAtHarvest = await readFile(join(configDir, '.credentials.json'), 'utf8');
      return { account: storedAccount(), healedLiveLogin: false };
    });
    const { probe, dirs } = makeProbe({
      createClient: (configDir) => {
        dirs.push(configDir);
        return fakeClient({
          onQuery: () =>
            writeFile(
              join(configDir, '.credentials.json'),
              JSON.stringify({ claudeAiOauth: oauth('rt-2') }),
              'utf8',
            ),
        });
      },
    });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([CANDIDATE.accountId]);

    expect(dirAtHarvest).toBe(dirs[0]);
    expect(credentialsAtHarvest).toContain('rt-2');
    expect(await rootIsEmpty()).toBe(true);
  });

  it('does not rewrite the vault when the turn left the token untouched', async () => {
    const { probe } = makeProbe();
    await probe.probeUnknown([CANDIDATE]);
    expect(reloginFromConfigDir).not.toHaveBeenCalled();
  });

  it('fails the probe when a rotated token could NOT be persisted', async () => {
    // The turn itself succeeded, but the vault now holds a spent token — reporting success
    // would hand auto-switch an account whose credentials are dead.
    reloginFromConfigDir.mockRejectedValue(new Error('vault write failed'));
    const { probe } = makeProbe({
      createClient: (configDir) =>
        fakeClient({
          onQuery: () =>
            writeFile(
              join(configDir, '.credentials.json'),
              JSON.stringify({ claudeAiOauth: oauth('rt-2') }),
              'utf8',
            ),
        }),
    });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(await rootIsEmpty()).toBe(true);
  });

  it('reports a failed SDK turn as a failure and still deletes the dir', async () => {
    const { probe } = makeProbe({
      createClient: () =>
        fakeClient({ events: [{ type: 'error', message: 'credit balance too low' }] }),
    });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(await rootIsEmpty()).toBe(true);
  });

  it('treats a stream that ends with no result as a failure (nothing reached the API)', async () => {
    const { probe } = makeProbe({ createClient: () => fakeClient({ events: [] }) });
    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(await rootIsEmpty()).toBe(true);
  });

  it('abandons a hung turn at the timeout, tears the client down, and deletes the dir', async () => {
    // Real (short) wall-clock timeout rather than fake timers: the deadline races a real
    // promise, which is exactly the mechanism under test.
    let client: FakeClient | undefined;
    const { probe } = makeProbe({
      timeoutMs: 40,
      createClient: () => {
        client = fakeClient({ hang: true });
        return client;
      },
    });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(client?.interrupts).toBe(1);
    expect(client?.ends).toBe(1);
    expect(await rootIsEmpty()).toBe(true);
  });

  it('refuses to probe the account that is currently live', async () => {
    // The live account's refresh token is the one the running CLI holds; spending it in a
    // throwaway dir strands that session. The engine's own answer is the guard.
    refreshToken.mockResolvedValue({
      accountId: CANDIDATE.accountId,
      refreshed: false,
      skippedReason: 'active_account',
      expiresAt: 4_000_000,
    });
    const created: string[] = [];
    const { probe } = makeProbe({
      createClient: (configDir) => {
        created.push(configDir);
        return fakeClient();
      },
    });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(created).toEqual([]);
    // No dir is even created, so nothing token-bearing was ever written.
    expect(await rootIsEmpty()).toBe(true);
  });

  it('probes at most one candidate per cycle', async () => {
    const { probe, dirs } = makeProbe();
    const second: ProbeCandidate = { accountId: 'acct-other', label: 'other' };
    await expect(probe.probeUnknown([CANDIDATE, second])).resolves.toEqual([CANDIDATE.accountId]);
    expect(dirs).toHaveLength(1);
  });

  it('never runs two probes concurrently', async () => {
    let live = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const { probe } = makeProbe({
      createClient: () =>
        fakeClient({
          onQuery: async () => {
            live += 1;
            peak = Math.max(peak, live);
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            live -= 1;
          },
        }),
    });

    const first = probe.probeUnknown([CANDIDATE]);
    // The first probe is parked inside its turn; a second call must decline rather than queue.
    await vi.waitFor(() => expect(live).toBe(1));
    await expect(
      probe.probeUnknown([{ accountId: 'acct-other', label: 'other' }]),
    ).resolves.toEqual([]);
    release?.();
    await first;
    expect(peak).toBe(1);
  });

  it('holds one account to the cooldown floor after a successful probe', async () => {
    const { probe, dirs } = makeProbe();
    await probe.probeUnknown([CANDIDATE]);
    expect(dirs).toHaveLength(1);

    now += PROBE_COOLDOWN_MS - 1;
    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(dirs).toHaveLength(1);

    now += 1;
    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([CANDIDATE.accountId]);
    expect(dirs).toHaveLength(2);
  });

  it('doubles the backoff on consecutive failures', async () => {
    const cooldownMs = 1000;
    let attempts = 0;
    const { probe } = makeProbe({
      cooldownMs,
      createClient: () => {
        attempts += 1;
        return fakeClient({ events: [{ type: 'turn_result', ok: false, summary: 'no' }] });
      },
    });

    await probe.probeUnknown([CANDIDATE]); // failure 1 -> next attempt at +1000
    now += cooldownMs;
    await probe.probeUnknown([CANDIDATE]); // failure 2 -> next attempt at +2000
    expect(attempts).toBe(2);

    now += cooldownMs;
    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    expect(attempts).toBe(2); // still inside the doubled window

    now += cooldownMs;
    await probe.probeUnknown([CANDIDATE]);
    expect(attempts).toBe(3);
  });

  it('exempts an overloaded endpoint and a lock timeout from the backoff', async () => {
    // Neither says anything about THIS account, so neither may push it toward the day-long cap.
    const cooldownMs = 1000;
    refreshToken.mockRejectedValueOnce(new RefreshError('token endpoint overloaded', 'http_529'));
    refreshToken.mockRejectedValueOnce(new LockTimeoutError('another process holds the lock'));
    const { probe, dirs } = makeProbe({ cooldownMs });

    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    now += cooldownMs;
    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([]);
    now += cooldownMs;
    // Two blameless failures later the account is still on the plain floor, not at 4x it.
    await expect(probe.probeUnknown([CANDIDATE])).resolves.toEqual([CANDIDATE.accountId]);
    expect(dirs).toHaveLength(1); // only the third attempt got as far as seeding a dir
  });

  it('does nothing when no candidate is eligible', async () => {
    const { probe } = makeProbe();
    await expect(probe.probeUnknown([])).resolves.toEqual([]);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(true);
  });
});
