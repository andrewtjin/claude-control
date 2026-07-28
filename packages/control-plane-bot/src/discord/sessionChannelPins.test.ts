// The persisted per-user `/thread-here` choice.
//
// Three properties carry the feature and are what these tests defend:
//   1. the tri-state is real — an explicit DM choice is distinguishable from never having chosen,
//      because only the first may outrank a deployment's fallback channel
//   2. one user's write never reaches another user's routing
//   3. a choice made in a chat window survives a restart, and a write that did NOT reach the disk
//      is reported as a failure rather than silently believed — the command replies "nothing was
//      changed" on a failed write, and that sentence has to be true of memory as well as of disk

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionChannelPinStore, PersistentSessionChannelPinStore } from './sessionChannelPins.js';

const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const CHANNEL_A = '333333333333333333';
const CHANNEL_B = '444444444444444444';
const PIN_FILE = 'session-channel-pins.json';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-channel-pins-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('SessionChannelPinStore — pure map', () => {
  it('returns undefined for a user who has never pinned anything', () => {
    const store = new SessionChannelPinStore();
    store.set(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    expect(store.get(USER_B)).toBeUndefined();
  });

  // The distinction the whole revocation path rests on: absent defers to the deployment, `dm`
  // overrules it.
  it('keeps a channel pin and a DM pin distinguishable', () => {
    const store = new SessionChannelPinStore();
    store.set(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    store.set(USER_B, { kind: 'dm' });
    expect(store.get(USER_A)).toEqual({ kind: 'channel', channelId: CHANNEL_A });
    expect(store.get(USER_B)).toEqual({ kind: 'dm' });
  });

  it("replaces a user's earlier pin with their later one", () => {
    const store = new SessionChannelPinStore();
    store.set(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    store.set(USER_A, { kind: 'channel', channelId: CHANNEL_B });
    expect(store.get(USER_A)).toEqual({ kind: 'channel', channelId: CHANNEL_B });
  });

  it('round-trips every pin through a snapshot', () => {
    const store = new SessionChannelPinStore();
    store.set(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    store.set(USER_B, { kind: 'dm' });
    const restored = SessionChannelPinStore.fromSnapshot(store.snapshot());
    expect(restored.get(USER_A)).toEqual({ kind: 'channel', channelId: CHANNEL_A });
    expect(restored.get(USER_B)).toEqual({ kind: 'dm' });
  });

  it('tolerates a missing snapshot as an empty store', () => {
    expect(SessionChannelPinStore.fromSnapshot(undefined).get(USER_A)).toBeUndefined();
  });

  // An entry that is neither a channel nor a DM would still WIN the precedence contest against the
  // deployment config and then resolve to nothing, so it must not survive the load.
  it('drops a malformed entry and keeps the well-formed ones around it', () => {
    const snapshot = {
      version: 1 as const,
      entries: [
        { discordUserId: USER_A, pin: { kind: 'nonsense' } },
        { discordUserId: USER_B, pin: { kind: 'channel', channelId: CHANNEL_B } },
      ],
    } as unknown as Parameters<typeof SessionChannelPinStore.fromSnapshot>[0];
    const store = SessionChannelPinStore.fromSnapshot(snapshot);
    expect(store.get(USER_A)).toBeUndefined();
    expect(store.get(USER_B)).toEqual({ kind: 'channel', channelId: CHANNEL_B });
  });
});

describe('PersistentSessionChannelPinStore — survives a restart', () => {
  it('reloads every pin from disk into a second store over the same state dir', async () => {
    const dir = await tempDir();
    const first = new PersistentSessionChannelPinStore(dir);
    await first.load();
    await first.record(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    await first.record(USER_B, { kind: 'dm' });

    // Simulate a bot restart: a brand-new instance over the same state dir.
    const second = new PersistentSessionChannelPinStore(dir);
    await second.load();
    expect(second.get(USER_A)).toEqual({ kind: 'channel', channelId: CHANNEL_A });
    expect(second.get(USER_B)).toEqual({ kind: 'dm' });
  });

  it("one user pinning a channel never changes another user's routing", async () => {
    const dir = await tempDir();
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    await store.record(USER_A, { kind: 'channel', channelId: CHANNEL_A });

    const reloaded = new PersistentSessionChannelPinStore(dir);
    await reloaded.load();
    expect(reloaded.get(USER_B)).toBeUndefined();
  });

  it('starts empty when the state file does not exist', async () => {
    const dir = await tempDir();
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    expect(store.get(USER_A)).toBeUndefined();
  });

  it('starts empty rather than throwing when the state file has the wrong shape', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, PIN_FILE), JSON.stringify({ version: 1, entries: 'nope' }), 'utf8');
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    expect(store.get(USER_A)).toBeUndefined();
  });

  // Every paired user can run /thread-here at any moment, so two writes to this one file inside a
  // tick is ordinary — and an unserialized temp-file/rename pair is what loses one of them.
  it('serializes concurrent writes so every pin survives on disk', async () => {
    const dir = await tempDir();
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    const users = Array.from(
      { length: 12 },
      (_, i) => `1000000000000000${`${i}`.padStart(2, '0')}`,
    );
    await Promise.all(
      users.map((user, i) =>
        store.record(user, { kind: 'channel', channelId: `${CHANNEL_A}${i}` }),
      ),
    );

    const reloaded = new PersistentSessionChannelPinStore(dir);
    await reloaded.load();
    for (const [i, user] of users.entries()) {
      expect(reloaded.get(user)).toEqual({ kind: 'channel', channelId: `${CHANNEL_A}${i}` });
    }
  });

  // A directory where the file belongs makes the rename fail for real, without mocking the writer.
  it('surfaces a write failure to the caller whose write failed', async () => {
    const dir = await tempDir();
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    // Blocked only after the load, so this is a WRITE failure and not a read failure wearing its
    // clothes.
    await mkdir(join(dir, PIN_FILE));
    await expect(store.record(USER_A, { kind: 'channel', channelId: CHANNEL_A })).rejects.toThrow();
  });

  // The command answers "nothing was changed" on a failed write, so the in-memory answer must not
  // quietly disagree with the disk for the rest of the process's life.
  it('leaves routing untouched in memory when the write failed', async () => {
    const dir = await tempDir();
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    await mkdir(join(dir, PIN_FILE));
    await expect(store.record(USER_A, { kind: 'dm' })).rejects.toThrow();
    expect(store.get(USER_A)).toBeUndefined();
  });

  it('keeps accepting writes after one has failed', async () => {
    const dir = await tempDir();
    const blocked = join(dir, PIN_FILE);
    const store = new PersistentSessionChannelPinStore(dir);
    await store.load();
    await mkdir(blocked);
    await expect(store.record(USER_A, { kind: 'channel', channelId: CHANNEL_A })).rejects.toThrow();

    await rm(blocked, { recursive: true });
    await store.record(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    await store.record(USER_B, { kind: 'dm' });

    const reloaded = new PersistentSessionChannelPinStore(dir);
    await reloaded.load();
    expect(reloaded.get(USER_A)).toEqual({ kind: 'channel', channelId: CHANNEL_A });
    expect(reloaded.get(USER_B)).toEqual({ kind: 'dm' });
  });
});
