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
  ruleSlotId,
  type AccountView,
  type ActivateResult,
  type RuleLiveResult,
  type RecoverResult,
  type ReauthResult,
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
