// Folder-bound slots on the SESSION path: which config dir a managed spawn binds to, which account
// it is attributed and spawned on, the refusals §8 requires, and the post-switch resume scoping that
// keeps a group hop from kicking global sessions (and vice versa).
//
// Driven through the real Daemon over a real socket via the shared session harness; the one seam is
// a group-aware fake switch engine, because a real one would need on-disk profiles these cases do
// not exercise.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectDirStem,
  ruleSlotId,
  type AccountView,
  type ActivateResult,
  type FolderRule,
  type RuleLiveResult,
  type RecoverResult,
  type ReauthResult,
  type SessionIdentity,
  type SlotId,
  type StoredAccount,
} from '@claude-control/switch-engine';
import type {
  AgentSdkClient,
  SessionHandle,
  SessionManager,
  SessionRecord,
} from '@claude-control/session-runtime';
import {
  createHarness,
  fakeManagedHandle,
  scriptedAgentSdkClient,
  waitFor,
  type FakeManagedHandle,
  type FakeSwitchEngine,
  type Harness,
} from './testing/sessionDaemonHarness.js';

const tempDirs: string[] = [];
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
  tempDirs.length = 0;
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-slots-'));
  tempDirs.push(dir);
  return dir;
}

const PROFILE_DIR = 'C:/profiles/g1';

/** A rule-aware fake engine: one shared pool (acct-x live global, acct-y idle) plus a folder rule
 *  `g1` including two reserved accounts (m1 live), on `boundFolder`. Only the seams these tests read
 *  are implemented; everything else throws so an unexpected call is loud. */
type GroupEngine = FakeSwitchEngine & { ensureRuleLiveCalls: string[] };

function groupEngine(boundFolder: string, liveInRule = 'm1'): GroupEngine {
  const accounts: AccountView[] = [
    { id: 'acct-x', label: 'main', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
    { id: 'acct-y', label: 'spare', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
    {
      id: 'm1',
      label: 'Member One',
      quarantined: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      ruleIds: ['g1'],
    },
    {
      id: 'm2',
      label: 'Member Two',
      quarantined: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      ruleIds: ['g1'],
    },
  ];
  const live = new Map<SlotId, string | null>([
    ['global', 'acct-x'],
    [ruleSlotId('g1'), liveInRule],
  ]);
  const engine: GroupEngine = {
    activeId: 'acct-x',
    activations: [],
    accounts: accounts.filter((a) => a.ruleIds === undefined),
    ensureRuleLiveCalls: [] as string[],
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate(id: string, options?: { origin?: string }): Promise<ActivateResult> {
      engine.activations.push({ accountId: id, origin: options?.origin });
      const view = accounts.find((a) => a.id === id);
      if (view?.ruleIds !== undefined) live.set(ruleSlotId(view.ruleIds[0]!), id);
      else {
        engine.activeId = id;
        live.set('global', id);
      }
      return Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      });
    },
    listAccounts: (): Promise<StoredAccount[]> =>
      Promise.resolve(accounts.filter((a) => a.ruleIds === undefined)),
    listAllAccounts: (): Promise<AccountView[]> => Promise.resolve(accounts),
    getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
      Promise.resolve(live.get(slot) ?? null),
    ensureRuleLive: (ruleId: string): Promise<RuleLiveResult> => {
      engine.ensureRuleLiveCalls.push(ruleId);
      return Promise.resolve({
        ruleId,
        liveAccount: live.get(ruleSlotId(ruleId)) ?? null,
        activated: false,
        noWorkingAccount: false,
      });
    },
    configDirForAccount: (accountId: string): Promise<string | undefined> =>
      Promise.resolve(
        accounts.find((a) => a.id === accountId)?.ruleIds !== undefined ? PROFILE_DIR : undefined,
      ),
    configDirForSlot: (slot: SlotId): string | undefined =>
      slot === ruleSlotId('g1') ? PROFILE_DIR : undefined,
    slotForConfigDir: (configDir: string | null | undefined): Promise<SlotId> =>
      Promise.resolve(configDir === PROFILE_DIR ? ruleSlotId('g1') : 'global'),
    resolveFolderRule: (cwd: string): Promise<{ ruleId: string; folder: string } | null> =>
      Promise.resolve(cwd === boundFolder ? { ruleId: 'g1', folder: boundFolder } : null),
    reauthenticate: (id: string): Promise<ReauthResult> =>
      Promise.resolve({
        account: { id, label: id, quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
        healedLiveLogin: false,
        identityVerified: true,
      }),
  };
  return engine;
}

describe('Daemon: folder-bound slots on the session path', () => {
  it('binds a spawn in a bound cwd to the group profile, on the group live member, tagged with its slot', async () => {
    const boundFolder = await sandbox();
    const capturedConfigDirs: Array<string | undefined> = [];
    const engine = groupEngine(boundFolder);
    harness = await createHarness({
      switchEngine: engine,
      createAgentSdkClient: (configDir?: string): AgentSdkClient => {
        capturedConfigDirs.push(configDir);
        return scriptedAgentSdkClient([]);
      },
    });
    await harness.daemon.start();

    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'go', idempotencyKey: 's1', cwd: boundFolder },
    });
    await waitFor(() => harness!.store.getSession('spawned-session') !== undefined);

    // The SDK client was bound to the group's profile dir, not the shared config dir.
    expect(capturedConfigDirs).toEqual([PROFILE_DIR]);
    // The group was ensured live before the spawn read its credentials.
    expect(engine.ensureRuleLiveCalls).toContain('g1');
    // Spawned + attributed on the group's live member (m1), never the payload's (absent) account.
    const spawn = harness.sessionManager as unknown as {
      spawnCalls: Array<{ accountId?: string }>;
    };
    expect(spawn.spawnCalls[0]?.accountId).toBe('m1');
    // The mirrored row carries the group slot.
    expect(harness.store.getSession('spawned-session')?.slot).toBe(ruleSlotId('g1'));
  });

  it('binds a spawn in a ruled cwd to the rule profile while an inherited shared account holds it', async () => {
    // Every included account is out, so the folder's slot runs on a shared account it inherits.
    // The session must still run in the folder's profile (that is where the slot is), on the account
    // live there — not fall back to the global slot because the account is a shared one.
    const boundFolder = await sandbox();
    const capturedConfigDirs: Array<string | undefined> = [];
    const engine = groupEngine(boundFolder, 'acct-y');
    harness = await createHarness({
      switchEngine: engine,
      createAgentSdkClient: (configDir?: string): AgentSdkClient => {
        capturedConfigDirs.push(configDir);
        return scriptedAgentSdkClient([]);
      },
    });
    await harness.daemon.start();

    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'go', idempotencyKey: 's1', cwd: boundFolder },
    });
    await waitFor(() => harness!.store.getSession('spawned-session') !== undefined);

    expect(capturedConfigDirs).toEqual([PROFILE_DIR]);
    const spawn = harness.sessionManager as unknown as {
      spawnCalls: Array<{ accountId?: string }>;
    };
    expect(spawn.spawnCalls[0]?.accountId).toBe('acct-y');
    expect(harness.store.getSession('spawned-session')?.slot).toBe(ruleSlotId('g1'));
  });

  it('binds an explicit reserved account to its group profile even with no cwd', async () => {
    const engine = groupEngine('C:/unused');
    const captured: Array<string | undefined> = [];
    harness = await createHarness({
      switchEngine: engine,
      createAgentSdkClient: (configDir?: string): AgentSdkClient => {
        captured.push(configDir);
        return scriptedAgentSdkClient([]);
      },
    });
    await harness.daemon.start();

    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'go', idempotencyKey: 's1', accountId: 'm2' },
    });
    await waitFor(() => harness!.store.getSession('spawned-session') !== undefined);

    expect(captured).toEqual([PROFILE_DIR]);
    const spawn = harness.sessionManager as unknown as {
      spawnCalls: Array<{ accountId?: string }>;
    };
    expect(spawn.spawnCalls[0]?.accountId).toBe('m2');
    expect(harness.store.getSession('spawned-session')?.slot).toBe(ruleSlotId('g1'));
  });

  it('refuses an explicit shared account that is not the live global account', async () => {
    const engine = groupEngine('C:/unused');
    harness = await createHarness({ switchEngine: engine });
    await harness.daemon.start();

    // acct-y is a known shared account, but acct-x is live globally — spawning acct-y would switch
    // the global slot out from under everyone, so it is refused.
    const sent = harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'go', idempotencyKey: 's1', accountId: 'acct-y' },
    });
    await waitFor(() =>
      harness!.sent.some((e) => e.type === 'error' && e.payload.relatesTo === sent.id),
    );
    const err = harness.sent.find((e) => e.type === 'error' && e.payload.relatesTo === sent.id);
    expect(err?.type === 'error' && err.payload.code).toBe('spawn_failed');
    expect(err?.type === 'error' && err.payload.message).toMatch(/shared account/);
    // Nothing was spawned.
    expect(harness.store.getSession('spawned-session')).toBeUndefined();
  });

  it('spawns an explicit shared account that IS live globally on the global slot (no profile bind)', async () => {
    const engine = groupEngine('C:/unused');
    const captured: Array<string | undefined> = [];
    harness = await createHarness({
      switchEngine: engine,
      createAgentSdkClient: (configDir?: string): AgentSdkClient => {
        captured.push(configDir);
        return scriptedAgentSdkClient([]);
      },
    });
    await harness.daemon.start();

    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'go', idempotencyKey: 's1', accountId: 'acct-x' },
    });
    await waitFor(() => harness!.store.getSession('spawned-session') !== undefined);

    // No config dir bound — a shared, globally-live account runs in the shared/global config dir.
    expect(captured).toEqual([undefined]);
    // Global slot: the mirror stores 'global'.
    expect(harness.store.getSession('spawned-session')?.slot).toBe('global');
    const spawn = harness.sessionManager as unknown as {
      spawnCalls: Array<{ accountId?: string }>;
    };
    expect(spawn.spawnCalls[0]?.accountId).toBe('acct-x');
  });

  it("a group /switch resumes only that group's parked sessions, never the global ones", async () => {
    const boundFolder = await sandbox();
    const engine = groupEngine(boundFolder);
    const manager = mintingSessionManager();
    harness = await createHarness({ switchEngine: engine, sessionManager: manager });
    await harness.daemon.start();

    // One session bound to the group (group:g1), one plain global session.
    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'rg', prompt: 'go', idempotencyKey: 'sg', cwd: boundFolder },
    });
    await waitFor(() => manager.handles.get('sess-1') !== undefined);
    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'rh', prompt: 'go', idempotencyKey: 'sh' },
    });
    await waitFor(() => manager.handles.get('sess-2') !== undefined);

    const groupSession = manager.handles.get('sess-1') as FakeManagedHandle;
    const globalSession = manager.handles.get('sess-2') as FakeManagedHandle;
    groupSession.setParked(true);
    globalSession.setParked(true);

    // Switch the GROUP to its other member. Only the group's parked session may be kicked.
    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: { requestId: 'sw', targetAccountId: 'm2', reason: 'manual', idempotencyKey: 'swk' },
    });
    await waitFor(() => groupSession.kicks === 1);
    // The global session's park is untouched — it runs on a different account entirely.
    expect(globalSession.kicks).toBe(0);
  });
});

const ALIAS_PROFILE_DIR = 'C:/profiles/g2';

/** A rule as the daemon lists it; only the scope fields matter to these cases. */
function ruleFixture(id: string, over: Partial<FolderRule>): FolderRule {
  return {
    id,
    label: id,
    folders: [],
    include: [],
    exclude: [],
    activeId: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

/**
 * {@link groupEngine} plus a second rule `g2` (one included account m3, live) for the session ALIAS
 * "auth work" in `boundFolder` — the folder `g1` rules. `resolveSessionRule` answers by the
 * precedence rule: that alias recorded in that folder -> g2, anything else run in the folder -> g1.
 */
function aliasAwareEngine(boundFolder: string): GroupEngine {
  const base = groupEngine(boundFolder);
  const m3: AccountView = {
    id: 'm3',
    label: 'Alias Member',
    quarantined: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ruleIds: ['g2'],
  };
  return {
    ...base,
    listRules: (): Promise<FolderRule[]> =>
      Promise.resolve([
        ruleFixture('g1', { folders: [boundFolder], include: ['m1', 'm2'] }),
        ruleFixture('g2', {
          aliases: [{ folder: boundFolder, alias: 'Auth Work' }],
          include: ['m3'],
        }),
      ]),
    listAllAccounts: async (): Promise<AccountView[]> => [...(await base.listAllAccounts!()), m3],
    getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
      slot === ruleSlotId('g2') ? Promise.resolve('m3') : base.getActiveId(slot),
    ensureRuleLive: (ruleId: string): Promise<RuleLiveResult> => {
      if (ruleId !== 'g2') return base.ensureRuleLive!(ruleId);
      base.ensureRuleLiveCalls.push(ruleId);
      return Promise.resolve({
        ruleId,
        liveAccount: 'm3',
        activated: false,
        noWorkingAccount: false,
      });
    },
    configDirForAccount: (accountId: string): Promise<string | undefined> =>
      accountId === 'm3'
        ? Promise.resolve(ALIAS_PROFILE_DIR)
        : base.configDirForAccount!(accountId),
    configDirForSlot: (slot: SlotId): string | undefined =>
      slot === ruleSlotId('g2') ? ALIAS_PROFILE_DIR : base.configDirForSlot!(slot),
    slotForConfigDir: (configDir: string | null | undefined): Promise<SlotId> =>
      configDir === ALIAS_PROFILE_DIR
        ? Promise.resolve(ruleSlotId('g2'))
        : base.slotForConfigDir!(configDir),
    resolveSessionRule: (
      folder: string,
      title: string | null,
      recordedFolder?: string | null,
    ): Promise<{ ruleId: string; folder: string } | null> =>
      Promise.resolve(
        // undefined = recorded where it runs; null = recorded in no folder an alias can name.
        (recordedFolder === undefined ? folder : recordedFolder) === boundFolder &&
          title !== null &&
          title.trim().toLowerCase() === 'auth work'
          ? { ruleId: 'g2', folder: boundFolder }
          : folder === boundFolder
            ? { ruleId: 'g1', folder: boundFolder }
            : null,
      ),
  };
}

describe('Daemon: a managed spawn that resumes a NAMED session follows its alias rule', () => {
  async function spawnResuming(opts: {
    identityOf?: (sessionId: string, boundFolder: string) => Promise<SessionIdentity | null>;
    resumeSessionId?: string;
    /** Build the engine without any alias rule (only the folder rule g1). */
    noAliasRules?: boolean;
  }): Promise<{ captured: Array<string | undefined>; engine: GroupEngine; accountId?: string }> {
    const boundFolder = await sandbox();
    const identityOf = opts.identityOf;
    const engine =
      opts.noAliasRules === true
        ? {
            ...aliasAwareEngine(boundFolder),
            listRules: (): Promise<FolderRule[]> =>
              Promise.resolve([
                ruleFixture('g1', { folders: [boundFolder], include: ['m1', 'm2'] }),
              ]),
          }
        : aliasAwareEngine(boundFolder);
    const captured: Array<string | undefined> = [];
    harness = await createHarness({
      switchEngine: engine,
      createAgentSdkClient: (configDir?: string): AgentSdkClient => {
        captured.push(configDir);
        return scriptedAgentSdkClient([]);
      },
      ...(identityOf !== undefined
        ? { sessionIdentityOf: (id: string) => identityOf(id, boundFolder) }
        : {}),
    });
    await harness.daemon.start();
    harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: {
        requestId: 'r1',
        prompt: 'go on',
        idempotencyKey: 's1',
        cwd: boundFolder,
        ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      },
    });
    await waitFor(() => harness!.store.getSession('spawned-session') !== undefined);
    const spawn = harness.sessionManager as unknown as {
      spawnCalls: Array<{ accountId?: string }>;
    };
    return {
      captured,
      engine,
      ...(spawn.spawnCalls[0]?.accountId !== undefined
        ? { accountId: spawn.spawnCalls[0].accountId }
        : {}),
    };
  }

  const SDK_ID = '11111111-2222-4333-8444-555555555555';

  it('resuming a session titled with a ruled alias lands on the alias rule’s profile and account', async () => {
    const asked: string[] = [];
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: (id, boundFolder) => {
        asked.push(id);
        return Promise.resolve({ customTitle: 'Auth Work', folder: boundFolder });
      },
    });
    // The title was looked up by the resume anchor (a raw SDK id passes through unchanged).
    expect(asked).toEqual([SDK_ID]);
    expect(res.captured).toEqual([ALIAS_PROFILE_DIR]);
    expect(res.accountId).toBe('m3');
    expect(res.engine.ensureRuleLiveCalls).toContain('g2');
    expect(harness!.store.getSession('spawned-session')?.slot).toBe(ruleSlotId('g2'));
  });

  it('resuming an unnamed session (or another title) keeps the folder rule', async () => {
    const unnamed = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: (_id, boundFolder) => Promise.resolve({ customTitle: null, folder: boundFolder }),
    });
    expect(unnamed.captured).toEqual([PROFILE_DIR]);
    expect(unnamed.accountId).toBe('m1');
  });

  it('a same-titled session RECORDED in another folder keeps the folder rule of the spawn folder', async () => {
    // The alias rule covers the conversations recorded in its folder; a session titled the same but
    // recorded elsewhere (resumed into this folder) is not one of them.
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: () => Promise.resolve({ customTitle: 'Auth Work', folder: 'C:/elsewhere' }),
    });
    expect(res.captured).toEqual([PROFILE_DIR]);
    expect(res.accountId).toBe('m1');
  });

  it('a transcript that exists but cannot be read has an unknown title: the folder rule decides', async () => {
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: (_id, boundFolder) =>
        Promise.resolve({
          customTitle: null,
          folder: null,
          dirName: projectDirStem(boundFolder),
          unreadable: true,
        }),
    });
    expect(res.captured).toEqual([PROFILE_DIR]);
  });

  it('with no trusted recorded folder, the transcript counts for the spawn folder only when its project directory can stand for it', async () => {
    // The same fallback every reader applies (switch-engine recordedFolderFor).
    const here = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: (_id, boundFolder) =>
        Promise.resolve({
          customTitle: 'Auth Work',
          folder: null,
          dirName: projectDirStem(boundFolder),
        }),
    });
    expect(here.captured).toEqual([ALIAS_PROFILE_DIR]);
    await harness?.dispose();
    harness = undefined;
    const elsewhere = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: () =>
        Promise.resolve({ customTitle: 'Auth Work', folder: null, dirName: 'C--elsewhere' }),
    });
    expect(elsewhere.captured).toEqual([PROFILE_DIR]);
  });

  it('a title lookup that fails falls back to the folder rule (the guard judges the real title)', async () => {
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: () => Promise.reject(new Error('transcript unreadable')),
    });
    expect(res.captured).toEqual([PROFILE_DIR]);
  });

  it('with no alias rule anywhere, a resumed spawn never reads a transcript', async () => {
    const asked: string[] = [];
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      noAliasRules: true,
      identityOf: (id, boundFolder) => {
        asked.push(id);
        return Promise.resolve({ customTitle: 'Auth Work', folder: boundFolder });
      },
    });
    expect(asked).toEqual([]);
    expect(res.captured).toEqual([PROFILE_DIR]);
  });

  it('a fresh spawn (nothing resumed) never asks for a title', async () => {
    const asked: string[] = [];
    const res = await spawnResuming({
      identityOf: (id, boundFolder) => {
        asked.push(id);
        return Promise.resolve({ customTitle: 'Auth Work', folder: boundFolder });
      },
    });
    expect(asked).toEqual([]);
    expect(res.captured).toEqual([PROFILE_DIR]);
  });
});

describe('Daemon: an explicit shared account resuming a NAMED session follows its alias rule', () => {
  const SDK_ID = '11111111-2222-4333-8444-555555555555';

  /** Spawn the resume of session "Auth Work" (recorded in the ruled folder) on the shared account
   *  acct-y, live in the given rule slot. Resolves with the config dirs spawned on and the error
   *  answered, if any. */
  async function spawnSharedResuming(liveIn: 'g1' | 'g2'): Promise<{
    captured: Array<string | undefined>;
    error: string | undefined;
  }> {
    const boundFolder = await sandbox();
    const base = aliasAwareEngine(boundFolder);
    const engine: GroupEngine = {
      ...base,
      getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
        slot === ruleSlotId(liveIn) ? Promise.resolve('acct-y') : base.getActiveId(slot),
      configDirForSlot: (slot: SlotId): string | undefined =>
        slot === ruleSlotId('g2') ? ALIAS_PROFILE_DIR : base.configDirForSlot!(slot),
    };
    const captured: Array<string | undefined> = [];
    harness = await createHarness({
      switchEngine: engine,
      createAgentSdkClient: (configDir?: string): AgentSdkClient => {
        captured.push(configDir);
        return scriptedAgentSdkClient([]);
      },
      sessionIdentityOf: () => Promise.resolve({ customTitle: 'Auth Work', folder: boundFolder }),
    });
    await harness.daemon.start();
    const sent = harness.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: {
        requestId: 'r1',
        prompt: 'go on',
        idempotencyKey: 's1',
        cwd: boundFolder,
        accountId: 'acct-y',
        resumeSessionId: SDK_ID,
      },
    });
    await waitFor(
      () =>
        harness!.store.getSession('spawned-session') !== undefined ||
        harness!.sent.some((e) => e.type === 'error' && e.payload.relatesTo === sent.id),
    );
    const err = harness.sent.find((e) => e.type === 'error' && e.payload.relatesTo === sent.id);
    return { captured, error: err?.type === 'error' ? err.payload.message : undefined };
  }

  it('live in the alias rule slot: spawned there', async () => {
    const res = await spawnSharedResuming('g2');
    expect(res.error).toBeUndefined();
    expect(res.captured).toEqual([ALIAS_PROFILE_DIR]);
    expect(harness!.store.getSession('spawned-session')?.slot).toBe(ruleSlotId('g2'));
  });

  it('live only in the folder rule slot: refused, never spawned where the guard refuses it', async () => {
    const res = await spawnSharedResuming('g1');
    expect(res.captured).toEqual([]);
    expect(res.error).toMatch(/slot of this session's rule/);
    expect(harness!.store.getSession('spawned-session')).toBeUndefined();
  });
});

/** A session manager that mints a distinct id per spawn (`sess-1`, `sess-2`, …) so two managed
 *  sessions can coexist — the shared fake reuses one id, which cannot express this case. */
function mintingSessionManager(): SessionManager & { handles: Map<string, SessionHandle> } {
  const handles = new Map<string, SessionHandle>();
  const records: SessionRecord[] = [];
  let n = 0;
  return {
    handles,
    spawnManaged(opts) {
      n += 1;
      const id = `sess-${n}`;
      const handle = fakeManagedHandle(id);
      handles.set(id, handle);
      records.push({
        id,
        kind: 'managed',
        state: handle.getState(),
        startedAtMs: 0,
        ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
      return Promise.resolve(handle);
    },
    attachObserved: () => Promise.reject(new Error('unused')),
    get: (id: string) => handles.get(id),
    list: () => records,
    recover: () => Promise.resolve([]),
    resumeOrphan: (sessionId) => {
      const handle = fakeManagedHandle(sessionId);
      handles.set(sessionId, handle);
      return Promise.resolve(handle);
    },
    prune: () => Promise.resolve([]),
  };
}
