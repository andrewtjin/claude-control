import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('PersistentThreadRegistry — settled() drains the write-behind', () => {
  it('resolves only after every queued record has reached disk', async () => {
    const dir = await tempDir();
    const reg = new PersistentThreadRegistry(dir);
    await reg.load();
    // Neither record is awaited — exactly how the gateway's write-behind calls it.
    void reg.record('u', 's1', { kind: 'thread', threadId: 't1' });
    void reg.record('u', 's2', { kind: 'dm' });
    await reg.settled();
    const fresh = new PersistentThreadRegistry(dir);
    await fresh.load();
    expect(fresh.get('u', 's1')).toEqual({ kind: 'thread', threadId: 't1' });
    expect(fresh.get('u', 's2')).toEqual({ kind: 'dm' });
  });

  it('resolves at once when nothing was ever recorded', async () => {
    const reg = new PersistentThreadRegistry(await tempDir());
    await expect(reg.settled()).resolves.toBeUndefined();
  });
});

describe('ThreadRegistry — latestForThread (reverse lookup)', () => {
  it('answers undefined for a thread no session was ever bound to', () => {
    const reg = new ThreadRegistry();
    reg.set('u1', 's1', { kind: 'thread', threadId: 't1' });
    expect(reg.latestForThread('t-unknown')).toBeUndefined();
  });

  it('maps a thread back to its (user, session)', () => {
    const reg = new ThreadRegistry();
    reg.set('u1', 's1', { kind: 'thread', threadId: 't1' });
    expect(reg.latestForThread('t1')).toEqual({ discordUserId: 'u1', sessionId: 's1' });
  });

  it('ignores DM entries entirely', () => {
    const reg = new ThreadRegistry();
    reg.set('u1', 's1', { kind: 'dm' });
    expect(reg.latestForThread('t1')).toBeUndefined();
  });

  it("the LAST session bound to a thread wins — the resume chain's newest link", () => {
    const reg = new ThreadRegistry();
    reg.set('u1', 's-old', { kind: 'thread', threadId: 't1' });
    reg.set('u1', 's-new', { kind: 'thread', threadId: 't1' });
    expect(reg.latestForThread('t1')).toEqual({ discordUserId: 'u1', sessionId: 's-new' });
  });

  it('last-wins order survives a snapshot/restore cycle', () => {
    const reg = new ThreadRegistry();
    reg.set('u1', 's-old', { kind: 'thread', threadId: 't1' });
    reg.set('u1', 's-new', { kind: 'thread', threadId: 't1' });
    const restored = ThreadRegistry.fromSnapshot(reg.snapshot());
    expect(restored.latestForThread('t1')).toEqual({ discordUserId: 'u1', sessionId: 's-new' });
  });
});

describe('PersistentThreadRegistry — a damaged file on disk', () => {
  it('loads an empty registry from invalid JSON, a 0-byte file, and a BOM-prefixed file', async () => {
    for (const content of ['{not json', '', '﻿{"version":1,"entries":[]}']) {
      const dir = await tempDir();
      await writeFile(join(dir, 'session-threads.json'), content, 'utf8');
      const reg = new PersistentThreadRegistry(dir);
      await expect(reg.load()).resolves.toBeUndefined();
      expect(reg.get('u1', 's1')).toBeUndefined();
      // The registry keeps working: the next record replaces the damaged file.
      await reg.record('u1', 's1', { kind: 'dm' });
      const reloaded = new PersistentThreadRegistry(dir);
      await reloaded.load();
      expect(reloaded.get('u1', 's1')).toEqual({ kind: 'dm' });
    }
  });

  it('drops damaged entries one by one and keeps the well-formed ones', async () => {
    const dir = await tempDir();
    const snapshot = {
      version: 1,
      entries: [
        null,
        42,
        { discordUserId: 'u1' },
        { discordUserId: 'u1', sessionId: 's-bad', target: { kind: 'thread' } },
        { discordUserId: 'u1', sessionId: 's-ok', target: { kind: 'thread', threadId: 't1' } },
        { discordUserId: 'u2', sessionId: 's-dm', target: { kind: 'dm' } },
      ],
    };
    await writeFile(join(dir, 'session-threads.json'), JSON.stringify(snapshot), 'utf8');
    const reg = new PersistentThreadRegistry(dir);
    await reg.load();
    expect(reg.get('u1', 's-ok')).toEqual({ kind: 'thread', threadId: 't1' });
    expect(reg.get('u2', 's-dm')).toEqual({ kind: 'dm' });
    expect(reg.get('u1', 's-bad')).toBeUndefined();
  });
});

describe('PersistentThreadRegistry — latestForThread across a restart', () => {
  it('still answers with the newest binding after reload from disk', async () => {
    const dir = await tempDir();
    const reg = new PersistentThreadRegistry(dir);
    await reg.load();
    await reg.record('u1', 's-old', { kind: 'thread', threadId: 't1' });
    await reg.record('u1', 's-new', { kind: 'thread', threadId: 't1' });
    const reloaded = new PersistentThreadRegistry(dir);
    await reloaded.load();
    expect(reloaded.latestForThread('t1')).toEqual({ discordUserId: 'u1', sessionId: 's-new' });
  });
});
