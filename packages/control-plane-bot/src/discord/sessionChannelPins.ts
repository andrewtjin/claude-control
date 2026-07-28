// The discordUserId → own-channel-choice store behind `/thread-here`, with atomic persistence.
//
// Session-thread routing used to be answerable only by an operator editing env vars and
// redeploying, which makes "put my session threads in this channel" a support ticket. This store is
// the other authority: a user pins a channel from inside Discord and it outranks the deployment's
// configuration for that user alone (see sessionChannels.ts for the precedence and why the user
// wins). A choice made in a chat window has to survive a bot restart or it is not a setting, so it
// is persisted rather than held in memory.
//
// The stored value is a tri-state by design — a channel, an explicit `dm`, or NO entry — because
// `dm` must be distinguishable from "never chose anything". Only a recorded DM choice can beat a
// deployment fallback channel; an absent entry has to defer to it. That is the same reasoning
// threadRegistry.ts applies to its own `dm` variant: a remembered decision, not a missing one.
//
// Keyed by discordUserId alone: this is one standing preference per user, with nothing to compose
// the key from. Reads never touch disk (routing consults this on the first frame of every new
// session); writes serialize onto a queue, because unlike bindings — written once per pairing —
// `/thread-here` is available to every paired user at any moment, so two users writing this one
// file within a tick is ordinary rather than exotic, and that is precisely the temp-file/rename
// race the queue plus the atomic writer's EPERM retry exist to close on Windows.

import { join } from 'node:path';
import { atomicWriteFile, readJsonIfExists } from '../fsutil.js';
import type { SessionChannelPin } from './sessionChannels.js';

/** On-disk shape. Versioned so a future field addition can migrate rather than mis-parse, and a
 *  flat array (not a nested object) so the file stays diff-friendly and trivial to eyeball when an
 *  operator is working out why one user's output lands somewhere unexpected. */
interface PinSnapshot {
  version: 1;
  entries: Array<{ discordUserId: string; pin: SessionChannelPin }>;
}

/** Validate a persisted pin before it becomes a routing decision. The file is small, human-readable
 *  and sits beside two others an operator may hand-edit, so a malformed entry is plausible — and an
 *  unvalidated one would flow into `chooseSessionChannel` as a pin that is neither a channel nor a
 *  DM, silently taking precedence over the deployment config and resolving to nothing. Dropping the
 *  entry degrades that user to the deployment's own answer, which is the safe direction. */
function isPin(value: unknown): value is SessionChannelPin {
  if (typeof value !== 'object' || value === null) return false;
  const pin = value as { kind?: unknown; channelId?: unknown };
  if (pin.kind === 'dm') return true;
  return pin.kind === 'channel' && typeof pin.channelId === 'string';
}

/** Pure in-memory map of discordUserId → their own destination choice. Snapshot/restore make it
 *  persistable without the persistence concern leaking into the routing logic. */
export class SessionChannelPinStore {
  private readonly map = new Map<string, SessionChannelPin>();

  get(discordUserId: string): SessionChannelPin | undefined {
    return this.map.get(discordUserId);
  }

  /** Replace this user's standing choice. One preference per user, so a later pin simply wins —
   *  and the key is the acting user's own id at every call site, which is what makes writing
   *  another user's routing structurally impossible rather than merely unimplemented. */
  set(discordUserId: string, pin: SessionChannelPin): void {
    this.map.set(discordUserId, pin);
  }

  /** Drop a user's choice, returning them to the deployment's own routing. Exists for the
   *  persistence layer's failure rollback (below), not for any command: `/thread-here action:clear`
   *  RECORDS a `dm` pin rather than deleting, because "back to my DMs" has to outrank a deployment
   *  channel and only a stored decision can do that. */
  delete(discordUserId: string): void {
    this.map.delete(discordUserId);
  }

  /** Serializable snapshot of every pin — the exact thing persisted to disk. */
  snapshot(): PinSnapshot {
    const entries: PinSnapshot['entries'] = [];
    for (const [discordUserId, pin] of this.map) entries.push({ discordUserId, pin });
    return { version: 1, entries };
  }

  /** Rebuild from a persisted snapshot. A missing, garbage, or partially-malformed snapshot yields
   *  whatever entries are well-formed and drops the rest — a lost pin degrades that user to the
   *  deployment's routing (worst case, their output arrives in their DMs, where they can see it and
   *  re-pin), which is strictly better than refusing to start the bot. */
  static fromSnapshot(snap: PinSnapshot | undefined): SessionChannelPinStore {
    const store = new SessionChannelPinStore();
    if (snap && Array.isArray(snap.entries)) {
      for (const entry of snap.entries) {
        if (entry && typeof entry.discordUserId === 'string' && isPin(entry.pin)) {
          store.set(entry.discordUserId, entry.pin);
        }
      }
    }
    return store;
  }
}

/** A SessionChannelPinStore backed by an atomically-persisted JSON file. Loaded once at startup;
 *  every `record` mutates memory then persists, with writes serialized onto a queue so two users
 *  pinning at the same moment never race the final rename (harmless on POSIX, EPERM-prone on
 *  Windows — the exact hazard the atomic writer's retry and this queue together close). */
export class PersistentSessionChannelPinStore {
  private readonly path: string;
  private store = new SessionChannelPinStore();
  private loaded = false;
  /** Serializes persistence; a failed write is swallowed at the queue level so one bad write never
   *  wedges every write after it, but each `record` caller still awaits its OWN write's real
   *  success/failure (the returned promise is the un-swallowed one). That matters more here than
   *  for the thread registry: the caller is a slash command that must answer the user with a
   *  confirmation or an honest failure, and it can only tell them apart if the write's outcome
   *  actually reaches it. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.path = join(stateDir, 'session-channel-pins.json');
  }

  /** Load the persisted pins. Safe to call more than once; only the first read hits disk. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const snap = await readJsonIfExists<PinSnapshot>(this.path);
    this.store = SessionChannelPinStore.fromSnapshot(snap);
  }

  get(discordUserId: string): SessionChannelPin | undefined {
    return this.store.get(discordUserId);
  }

  /** Record (and persist) a user's own choice. Returns once THIS write has settled, so a caller
   *  reporting success to the user is reporting something that reached the disk.
   *
   *  The memory mutation happens INSIDE the queued unit and is rolled back if the write fails —
   *  unlike the thread registry, which mutates first and keeps the value regardless. The
   *  difference is who is listening: a failed registry write leaves a session delivering to the
   *  thread it already created, which is harmless, whereas this store's caller tells a human
   *  "nothing was changed" and that sentence has to be true. Doing the read-modify-write inside the
   *  queue is also what makes the rollback safe — a second `record` for the same user cannot
   *  interleave between the mutation and its restore. */
  async record(discordUserId: string, pin: SessionChannelPin): Promise<void> {
    const next = this.writeQueue.then(async () => {
      const previous = this.store.get(discordUserId);
      this.store.set(discordUserId, pin);
      try {
        await atomicWriteFile(this.path, JSON.stringify(this.store.snapshot(), null, 2));
      } catch (err) {
        if (previous === undefined) this.store.delete(discordUserId);
        else this.store.set(discordUserId, previous);
        throw err;
      }
    });
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}
