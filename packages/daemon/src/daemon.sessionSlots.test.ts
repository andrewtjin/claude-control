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
  groupSlotId,
  projectDirStem,
  type AccountView,
  type ActivateResult,
  type GroupLiveResult,
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

/** A group-aware fake engine: one shared pool (acct-x live global, acct-y idle) plus a group `g1`
 *  of two reserved members (m1 live), bound to `boundFolder`. Only the seams these tests read are
 *  implemented; everything else throws so an unexpected call is loud. */
type GroupEngine = FakeSwitchEngine & { ensureGroupLiveCalls: string[] };

function groupEngine(boundFolder: string): GroupEngine {
  const accounts: AccountView[] = [
    { id: 'acct-x', label: 'main', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
    { id: 'acct-y', label: 'spare', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
    {
      id: 'm1',
      label: 'Member One',
      quarantined: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      groupId: 'g1',
    },
    {
      id: 'm2',
      label: 'Member Two',
      quarantined: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      groupId: 'g1',
    },
  ];
  const live = new Map<SlotId, string | null>([
    ['global', 'acct-x'],
    [groupSlotId('g1'), 'm1'],
  ]);
  const engine: GroupEngine = {
    activeId: 'acct-x',
    activations: [],
    accounts: accounts.filter((a) => a.groupId === undefined),
    ensureGroupLiveCalls: [] as string[],
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate(id: string, options?: { origin?: string }): Promise<ActivateResult> {
      engine.activations.push({ accountId: id, origin: options?.origin });
      const view = accounts.find((a) => a.id === id);
      if (view?.groupId !== undefined) live.set(groupSlotId(view.groupId), id);
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
      Promise.resolve(accounts.filter((a) => a.groupId === undefined)),
    listAllAccounts: (): Promise<AccountView[]> => Promise.resolve(accounts),
    getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
      Promise.resolve(live.get(slot) ?? null),
    ensureGroupLive: (groupId: string): Promise<GroupLiveResult> => {
      engine.ensureGroupLiveCalls.push(groupId);
      return Promise.resolve({
        groupId,
        liveMember: live.get(groupSlotId(groupId)) ?? null,
        activated: false,
        noWorkingAccount: false,
      });
    },
    configDirForAccount: (accountId: string): Promise<string | undefined> =>
      Promise.resolve(
        accounts.find((a) => a.id === accountId)?.groupId !== undefined ? PROFILE_DIR : undefined,
      ),
    slotForConfigDir: (configDir: string | null | undefined): Promise<SlotId> =>
      Promise.resolve(configDir === PROFILE_DIR ? groupSlotId('g1') : 'global'),
    resolveCwdBinding: (cwd: string): Promise<{ groupId: string } | null> =>
      Promise.resolve(cwd === boundFolder ? { groupId: 'g1' } : null),
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
    expect(engine.ensureGroupLiveCalls).toContain('g1');
    // Spawned + attributed on the group's live member (m1), never the payload's (absent) account.
    const spawn = harness.sessionManager as unknown as {
      spawnCalls: Array<{ accountId?: string }>;
    };
    expect(spawn.spawnCalls[0]?.accountId).toBe('m1');
    // The mirrored row carries the group slot.
    expect(harness.store.getSession('spawned-session')?.slot).toBe(groupSlotId('g1'));
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
    expect(harness.store.getSession('spawned-session')?.slot).toBe(groupSlotId('g1'));
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

/**
 * {@link groupEngine} plus a second group `g2` (one member m3, live) bound by the ALIAS "auth work"
 * in `boundFolder` — the same folder `g1` is folder-bound to. `resolveSessionBinding` answers by the
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
    groupId: 'g2',
  };
  return {
    ...base,
    listAllAccounts: async (): Promise<AccountView[]> => [...(await base.listAllAccounts!()), m3],
    getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
      slot === groupSlotId('g2') ? Promise.resolve('m3') : base.getActiveId(slot),
    ensureGroupLive: (groupId: string): Promise<GroupLiveResult> => {
      if (groupId !== 'g2') return base.ensureGroupLive!(groupId);
      base.ensureGroupLiveCalls.push(groupId);
      return Promise.resolve({
        groupId,
        liveMember: 'm3',
        activated: false,
        noWorkingAccount: false,
      });
    },
    configDirForAccount: (accountId: string): Promise<string | undefined> =>
      accountId === 'm3'
        ? Promise.resolve(ALIAS_PROFILE_DIR)
        : base.configDirForAccount!(accountId),
    slotForConfigDir: (configDir: string | null | undefined): Promise<SlotId> =>
      configDir === ALIAS_PROFILE_DIR
        ? Promise.resolve(groupSlotId('g2'))
        : base.slotForConfigDir!(configDir),
    resolveSessionBinding: (
      folder: string,
      title: string | null,
      recordedFolder?: string | null,
    ): Promise<{ groupId: string } | null> =>
      Promise.resolve(
        // undefined = recorded where it runs; null = recorded in no folder an alias can name.
        (recordedFolder === undefined ? folder : recordedFolder) === boundFolder &&
          title !== null &&
          title.trim().toLowerCase() === 'auth work'
          ? { groupId: 'g2' }
          : folder === boundFolder
            ? { groupId: 'g1' }
            : null,
      ),
  };
}

describe('Daemon: a managed spawn that resumes a NAMED session follows its alias binding', () => {
  async function spawnResuming(opts: {
    identityOf?: (sessionId: string, boundFolder: string) => Promise<SessionIdentity | null>;
    resumeSessionId?: string;
  }): Promise<{ captured: Array<string | undefined>; engine: GroupEngine; accountId?: string }> {
    const boundFolder = await sandbox();
    const identityOf = opts.identityOf;
    const engine = aliasAwareEngine(boundFolder);
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

  it('resuming a session titled with a bound alias lands on the alias group’s profile and member', async () => {
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
    expect(res.engine.ensureGroupLiveCalls).toContain('g2');
    expect(harness!.store.getSession('spawned-session')?.slot).toBe(groupSlotId('g2'));
  });

  it('resuming an unnamed session (or another title) keeps the folder binding', async () => {
    const unnamed = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: (_id, boundFolder) => Promise.resolve({ customTitle: null, folder: boundFolder }),
    });
    expect(unnamed.captured).toEqual([PROFILE_DIR]);
    expect(unnamed.accountId).toBe('m1');
  });

  it('a same-titled session RECORDED in another folder keeps the folder binding of the spawn folder', async () => {
    // The alias binding covers the conversations recorded in the bound folder; a session titled the
    // same but recorded elsewhere (resumed into this folder) is not one of them.
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: () => Promise.resolve({ customTitle: 'Auth Work', folder: 'C:/elsewhere' }),
    });
    expect(res.captured).toEqual([PROFILE_DIR]);
    expect(res.accountId).toBe('m1');
  });

  it('a transcript that exists but cannot be read has an unknown title: the folder binding decides', async () => {
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

  it('a title lookup that fails falls back to the folder binding (the guard judges the real title)', async () => {
    const res = await spawnResuming({
      resumeSessionId: SDK_ID,
      identityOf: () => Promise.reject(new Error('transcript unreadable')),
    });
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
