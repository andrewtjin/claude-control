// The sessionId → delivery-target registry (thread-per-session), with atomic persistence.
//
// Thread-per-session needs a durable answer to "where does this session's output go?".
// The first `session.status` for a session creates a Discord thread; every later output/status for
// that session must land in the SAME thread — including across a bot restart, when the in-memory
// map is gone. So the mapping is persisted: sessionId → { thread <id> } | { dm }.
//
// The `dm` variant records a FALLBACK: if thread creation failed (no per-user channel configured
// yet, a permissions error, Discord being Discord), delivery falls back to the user's DM and we
// REMEMBER that — otherwise every subsequent frame would re-attempt (and re-fail) thread creation,
// spamming the logs and racing. Fallback is a decision made once and honoured for the session's
// life. Nothing here throws on a create failure; the fallback IS the never-crash, never-drop path.
//
// The registry data structure is pure (a Map with snapshot/restore); the live side effect of thread
// CREATION lives in the gateway. Persistence is via the package's own atomic writer (temp+rename,
// Windows EPERM retry) with writes serialized so bursts of new sessions can't race the final rename.

import { join } from 'node:path';
import { atomicWriteFile, readJsonIfExists } from '../fsutil.js';

/** Where a session's frames are delivered. `thread` once a Discord thread exists for it; `dm` when
 *  thread creation was not possible and we fell back to (and pinned) the user's direct messages. */
export type DeliveryTarget = { kind: 'thread'; threadId: string } | { kind: 'dm' };

/** On-disk shape. Versioned so a future field addition can migrate rather than mis-parse. A flat
 *  array (not a nested object) keeps the file diff-friendly and trivial to reason about. */
interface RegistrySnapshot {
  version: 1;
  entries: Array<{ discordUserId: string; sessionId: string; target: DeliveryTarget }>;
}

/** Separator inside a composite key: NUL is a byte no Discord id or sessionId can contain
 *  (sessionIds CAN contain spaces — see the snapshot round-trip test), so the join is
 *  unambiguous. Written as the ESCAPE sequence, never a raw byte: a literal NUL in source
 *  makes grep-family tools classify the whole file as binary and silently skip it. */
const KEY_SEPARATOR = '\u0000';

/** Composite key: two different users could, in principle, run daemons that mint the same sessionId
 *  string, so the user id is part of the identity — never route one user's session to another's. */
function key(discordUserId: string, sessionId: string): string {
  return `${discordUserId}${KEY_SEPARATOR}${sessionId}`;
}

/** Pure in-memory map of (user, session) → delivery target. Snapshot/restore make it persistable
 *  without the persistence concern leaking into the routing logic. */
export class ThreadRegistry {
  private readonly map = new Map<string, DeliveryTarget>();

  get(discordUserId: string, sessionId: string): DeliveryTarget | undefined {
    return this.map.get(key(discordUserId, sessionId));
  }

  set(discordUserId: string, sessionId: string, target: DeliveryTarget): void {
    this.map.set(key(discordUserId, sessionId), target);
  }

  /** The most recent (user, session) bound to a thread — the reverse of `get`, for routing a
   *  message TYPED in a thread back to the session it belongs to. A thread accumulates several
   *  sessions over its life (each resume binds a NEW sessionId to the same thread), and the newest
   *  binding is the conversation the user is continuing, so the LAST match wins: Map iteration is
   *  insertion-ordered, `set` never reorders an existing key, and a resumed session is always
   *  recorded after its predecessor — both in memory and through a snapshot/restore cycle. */
  latestForThread(threadId: string): { discordUserId: string; sessionId: string } | undefined {
    let found: { discordUserId: string; sessionId: string } | undefined;
    for (const [k, target] of this.map) {
      if (target.kind !== 'thread' || target.threadId !== threadId) continue;
      const sep = k.indexOf(KEY_SEPARATOR);
      found = { discordUserId: k.slice(0, sep), sessionId: k.slice(sep + 1) };
    }
    return found;
  }

  /** Serializable snapshot of every mapping — the exact thing persisted to disk. */
  snapshot(): RegistrySnapshot {
    const entries: RegistrySnapshot['entries'] = [];
    for (const [k, target] of this.map) {
      const sep = k.indexOf(KEY_SEPARATOR);
      entries.push({ discordUserId: k.slice(0, sep), sessionId: k.slice(sep + 1), target });
    }
    return { version: 1, entries };
  }

  /** Rebuild a registry from a persisted snapshot (missing/garbage snapshots yield an empty one —
   *  a lost thread map degrades to fresh threads/DM fallback, never a crash). */
  static fromSnapshot(snap: RegistrySnapshot | undefined): ThreadRegistry {
    const reg = new ThreadRegistry();
    if (snap && Array.isArray(snap.entries)) {
      for (const e of snap.entries) reg.set(e.discordUserId, e.sessionId, e.target);
    }
    return reg;
  }
}

/** A ThreadRegistry backed by an atomically-persisted JSON file. Loaded once at startup; every
 *  `record` mutates memory then persists, with writes serialized onto a queue so two near-
 *  simultaneous new sessions never race the final rename (harmless on POSIX, EPERM-prone on
 *  Windows — the exact hazard the atomic writer's retry and this queue together close). */
export class PersistentThreadRegistry {
  private readonly path: string;
  private registry = new ThreadRegistry();
  private loaded = false;
  /** Serializes persistence; a failed write is swallowed at the queue level so one bad write never
   *  wedges every write after it, but each `record` caller still awaits its OWN write's real
   *  success/failure (the returned promise is the un-swallowed one). */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.path = join(stateDir, 'session-threads.json');
  }

  /** Load the persisted map. Safe to call more than once; only the first read hits disk. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const snap = await readJsonIfExists<RegistrySnapshot>(this.path);
    this.registry = ThreadRegistry.fromSnapshot(snap);
  }

  get(discordUserId: string, sessionId: string): DeliveryTarget | undefined {
    return this.registry.get(discordUserId, sessionId);
  }

  /** See {@link ThreadRegistry.latestForThread} — the reverse lookup, over the persisted map. */
  latestForThread(threadId: string): { discordUserId: string; sessionId: string } | undefined {
    return this.registry.latestForThread(threadId);
  }

  /** Record (and persist) a session's delivery target. Returns once THIS write has settled. */
  async record(discordUserId: string, sessionId: string, target: DeliveryTarget): Promise<void> {
    this.registry.set(discordUserId, sessionId, target);
    const snapshot = JSON.stringify(this.registry.snapshot(), null, 2);
    const next = this.writeQueue.then(() => atomicWriteFile(this.path, snapshot));
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every write queued so far has settled — success or swallowed failure. The
   *  gateway records write-behind so delivery never waits on disk; this is the matching drain
   *  for whoever must observe, or remove, the state dir afterwards. */
  settled(): Promise<void> {
    return this.writeQueue;
  }
}
