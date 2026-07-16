// The registry that ties everything together: spawns/attaches sessions through the two
// backends, keeps an in-memory index of live handles, and mirrors state to disk so a
// daemon restart can tell "still running" apart from "was running when we died".
//
// Persistence is deliberately dumb — one JSON array, atomically rewritten on every
// state-affecting event — because the registry is small (a handful of concurrent sessions
// at most) and correctness under a crash mid-write matters far more than write throughput.

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionHandle, SessionRecord, SessionState } from './types.js';
import { startManagedSession } from './managedSession.js';
import type { AgentSdkClient } from './managedSession.js';
import { attachObservedSession } from './observedSession.js';
import type { PtyFactory } from './observedSession.js';

// ---------------------------------------------------------------------------
// On-disk persistence
// ---------------------------------------------------------------------------

/** Rename with a short bounded retry on EPERM/EBUSY. Windows can transiently reject a
 *  rename onto an existing file with one of these codes immediately after a prior rename
 *  to the same path settles — typically another process (an AV scanner, the search
 *  indexer) holds a fleeting handle on the file that was just replaced. This is a known
 *  Node-on-Windows quirk (the same reason libraries like write-file-atomic retry here);
 *  the file itself was never corrupted by it, the rename call just needs to be retried. A
 *  genuine permissions problem keeps failing past the retry budget and still surfaces. */
async function renameWithRetry(tmp: string, target: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= maxAttempts || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 15));
    }
  }
}

/** Write `data` to `target` via write-temp-then-rename in the same directory, so a crash
 *  mid-write can never leave a half-written registry — a reader sees either the whole old
 *  file or the whole new one, never a truncated in-between. */
async function atomicWriteFile(target: string, data: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(
    dirname(target),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, target);
}

/** Read and parse the registry file, tolerating "doesn't exist yet" (first run) as empty.
 *  Any other read/parse failure propagates — a corrupt registry should be loud, not
 *  silently treated as empty (that would lose every in-flight session's record). */
async function readRegistry(path: string): Promise<SessionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as SessionRecord[]) : [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  /** Directory holding `sessions.json`. Created if missing. */
  stateDir: string;
  /** Injectable clock so tests get deterministic `startedAtMs` values. */
  now?: () => number;
}

export interface SpawnManagedOptions {
  /** Caller-supplied id (e.g. for tests); a UUID is generated when omitted. */
  id?: string;
  client: AgentSdkClient;
  prompt: string;
  resumeSessionId?: string;
  cwd?: string;
  accountId?: string;
}

export interface AttachObservedOptions {
  id?: string;
  ptyFactory: PtyFactory;
  command: string;
  args?: string[];
  cwd?: string;
  accountId?: string;
}

export interface SessionManager {
  spawnManaged(opts: SpawnManagedOptions): Promise<SessionHandle>;
  attachObserved(opts: AttachObservedOptions): Promise<SessionHandle>;
  /** Live handle for a session spawned/attached in this process. `undefined` for a
   *  session that only exists as a persisted (possibly orphaned) record. */
  get(id: string): SessionHandle | undefined;
  list(): SessionRecord[];
  /**
   * Startup reconciliation: any persisted record that is not in a terminal state and has
   * no live handle in this process gets stamped `orphaned` — its owning process is gone,
   * most likely a previous daemon run that crashed mid-session. Returns the records that
   * were changed (empty on a clean start). Safe to call more than once; a no-op after the
   * first call finds nothing left to reconcile.
   */
  recover(): Promise<SessionRecord[]>;
}

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['done', 'failed', 'orphaned']);

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const clock = opts.now ?? Date.now;
  const registryPath = join(opts.stateDir, 'sessions.json');
  const handles = new Map<string, SessionHandle>();
  const records = new Map<string, SessionRecord>();
  // Registry is loaded lazily (on first real operation) rather than in this synchronous
  // factory function, so construction never does IO and callers control when the first
  // await happens.
  let loaded = false;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    for (const record of await readRegistry(registryPath)) {
      records.set(record.id, record);
    }
  }

  // Session events can fire in a tight burst (a turn producing several status changes
  // back to back), and each one wants to persist. Without serialization, two overlapping
  // atomicWriteFile calls to the same target race on the final rename — harmless on POSIX
  // (rename atomically replaces even an open file) but Windows can reject the second
  // rename with EPERM/EBUSY while the first is still settling. Chaining every persist()
  // onto this queue guarantees writes to `sessions.json` are never concurrent, regardless
  // of how many callers ask for one at once. A failed write is swallowed at the queue
  // level (`.catch`) so one bad write never wedges every write after it — but the
  // `next` promise returned to *this* call's own caller still carries the real
  // success/failure, so `await persist()` callers are not lied to.
  let writeQueue: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const snapshot = JSON.stringify(Array.from(records.values()), null, 2);
    const next = writeQueue.then(() => atomicWriteFile(registryPath, snapshot));
    writeQueue = next.catch(() => undefined);
    return next;
  }

  /** Wire a freshly-created handle's status/summary events back into its record, keeping
   *  the on-disk registry current without callers having to remember to do it. */
  function trackHandle(handle: SessionHandle, record: SessionRecord): void {
    handles.set(handle.id, handle);
    records.set(handle.id, record);
    handle.onEvent((event) => {
      const current = records.get(handle.id);
      if (!current) return;
      let changed = false;
      if (event.kind === 'status' && current.state !== event.state) {
        current.state = event.state;
        changed = true;
      }
      if (event.kind === 'summary' && current.summary !== event.text) {
        current.summary = event.text;
        changed = true;
      }
      if (!changed) return;
      // Fire-and-forget: a persist failure here must not break event delivery to the
      // handle's other subscribers. The in-memory record is already correct; the next
      // state-changing event will retry the write.
      void persist().catch(() => undefined);
    });
  }

  return {
    async spawnManaged(spawnOpts): Promise<SessionHandle> {
      await ensureLoaded();
      const id = spawnOpts.id ?? randomUUID();
      const handle = startManagedSession({
        id,
        client: spawnOpts.client,
        prompt: spawnOpts.prompt,
        ...(spawnOpts.resumeSessionId !== undefined
          ? { resumeSessionId: spawnOpts.resumeSessionId }
          : {}),
        ...(spawnOpts.cwd !== undefined ? { cwd: spawnOpts.cwd } : {}),
        ...(spawnOpts.accountId !== undefined ? { accountId: spawnOpts.accountId } : {}),
      });
      const record: SessionRecord = {
        id,
        kind: 'managed',
        state: handle.getState(),
        startedAtMs: clock(),
        ...(spawnOpts.accountId !== undefined ? { accountId: spawnOpts.accountId } : {}),
        ...(spawnOpts.resumeSessionId !== undefined ? { resumeId: spawnOpts.resumeSessionId } : {}),
        ...(spawnOpts.cwd !== undefined ? { cwd: spawnOpts.cwd } : {}),
      };
      // Subscribe before any further await so no early status event can be missed.
      trackHandle(handle, record);
      await persist();
      return handle;
    },

    async attachObserved(attachOpts): Promise<SessionHandle> {
      await ensureLoaded();
      const id = attachOpts.id ?? randomUUID();
      const handle = attachObservedSession({
        id,
        ptyFactory: attachOpts.ptyFactory,
        command: attachOpts.command,
        ...(attachOpts.args !== undefined ? { args: attachOpts.args } : {}),
        ...(attachOpts.cwd !== undefined ? { cwd: attachOpts.cwd } : {}),
        ...(attachOpts.accountId !== undefined ? { accountId: attachOpts.accountId } : {}),
      });
      const record: SessionRecord = {
        id,
        kind: 'observed',
        state: handle.getState(),
        startedAtMs: clock(),
        ...(attachOpts.accountId !== undefined ? { accountId: attachOpts.accountId } : {}),
        ...(attachOpts.cwd !== undefined ? { cwd: attachOpts.cwd } : {}),
      };
      trackHandle(handle, record);
      await persist();
      return handle;
    },

    get(id): SessionHandle | undefined {
      return handles.get(id);
    },

    list(): SessionRecord[] {
      return Array.from(records.values());
    },

    async recover(): Promise<SessionRecord[]> {
      await ensureLoaded();
      const orphaned: SessionRecord[] = [];
      for (const record of records.values()) {
        if (handles.has(record.id)) continue; // live in this process, not orphaned
        if (TERMINAL_STATES.has(record.state)) continue; // already settled
        record.state = 'orphaned';
        orphaned.push(record);
      }
      if (orphaned.length > 0) await persist();
      return orphaned;
    },
  };
}
