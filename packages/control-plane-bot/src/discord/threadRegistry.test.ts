import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadRegistry, PersistentThreadRegistry } from './threadRegistry.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thread-registry-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('ThreadRegistry — pure map', () => {
  it('keys by user AND session so ids never cross users', () => {
    const reg = new ThreadRegistry();
    reg.set('userA', 'sess-1', { kind: 'thread', threadId: 't-a' });
    reg.set('userB', 'sess-1', { kind: 'dm' });
    expect(reg.get('userA', 'sess-1')).toEqual({ kind: 'thread', threadId: 't-a' });
    expect(reg.get('userB', 'sess-1')).toEqual({ kind: 'dm' });
    expect(reg.get('userA', 'unknown')).toBeUndefined();
  });

  it('round-trips through a snapshot, including a sessionId containing the separator', () => {
    const reg = new ThreadRegistry();
    reg.set('u1', 'weird session id', { kind: 'thread', threadId: 't' });
    const restored = ThreadRegistry.fromSnapshot(reg.snapshot());
    expect(restored.get('u1', 'weird session id')).toEqual({ kind: 'thread', threadId: 't' });
  });

  it('tolerates a missing snapshot as an empty registry', () => {
    const reg = ThreadRegistry.fromSnapshot(undefined);
    expect(reg.get('u', 's')).toBeUndefined();
  });
});

describe('PersistentThreadRegistry — survives a restart', () => {
  it('persists a recorded target and reloads it in a fresh instance', async () => {
    const dir = await tempDir();
    const first = new PersistentThreadRegistry(dir);
    await first.load();
    await first.record('user-1', 'sess-1', { kind: 'thread', threadId: 'thread-99' });

    // Simulate a bot restart: a brand-new instance over the same state dir.
    const second = new PersistentThreadRegistry(dir);
    await second.load();
    expect(second.get('user-1', 'sess-1')).toEqual({ kind: 'thread', threadId: 'thread-99' });
  });

  it('remembers a DM fallback so it is never re-attempted as a thread', async () => {
    const dir = await tempDir();
    const reg = new PersistentThreadRegistry(dir);
    await reg.load();
    await reg.record('user-1', 'sess-2', { kind: 'dm' });
    const reloaded = new PersistentThreadRegistry(dir);
    await reloaded.load();
    expect(reloaded.get('user-1', 'sess-2')).toEqual({ kind: 'dm' });
  });

  it('serializes a burst of records without losing any (no write race)', async () => {
    const dir = await tempDir();
    const reg = new PersistentThreadRegistry(dir);
    await reg.load();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reg.record('user-1', `sess-${i}`, { kind: 'thread', threadId: `t-${i}` }),
      ),
    );
    const reloaded = new PersistentThreadRegistry(dir);
    await reloaded.load();
    for (let i = 0; i < 12; i++) {
      expect(reloaded.get('user-1', `sess-${i}`)).toEqual({ kind: 'thread', threadId: `t-${i}` });
    }
  });
});
