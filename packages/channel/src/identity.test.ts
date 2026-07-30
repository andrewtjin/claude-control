import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createParentOf,
  MAX_ANCESTOR_HOPS,
  readSessionRegistry,
  resolveIdentity,
  type ParentOf,
  type SessionRegistryEntry,
} from './identity.js';

// Real temp dirs and real registry files throughout — the whole point of this module is that it
// reads what Claude Code actually wrote, so a stubbed filesystem would prove nothing.
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Write a real `<pid>.json` registry file per entry, in Claude Code's own shape. */
async function registry(
  entries: Array<Partial<SessionRegistryEntry> & { pid: number }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cctl-channel-identity-'));
  dirs.push(root);
  const sessionsDir = join(root, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  for (const entry of entries) {
    await writeFile(
      join(sessionsDir, `${entry.pid}.json`),
      JSON.stringify({
        pid: entry.pid,
        sessionId: entry.sessionId,
        cwd: entry.cwd ?? 'C:\\repo',
        startedAt: 1,
        kind: 'interactive',
        status: 'idle',
        ...(entry.name === undefined ? {} : { name: entry.name }),
      }),
      'utf8',
    );
  }
  return sessionsDir;
}

/** A parent lookup backed by a plain pid->ppid map, plus a call counter so tests can prove the
 *  expensive path was never entered. */
function chainOf(map: Record<number, number>): { parentOf: ParentOf; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    parentOf: (pid) => {
      calls.push(pid);
      return Promise.resolve(map[pid]);
    },
  };
}

describe('readSessionRegistry', () => {
  it('reads every well-formed file and skips the rest', async () => {
    const sessionsDir = await registry([
      { pid: 100, sessionId: 'aaa', cwd: 'C:\\a', name: 'work' },
      { pid: 200, sessionId: 'bbb' },
    ]);
    // A torn write, a non-JSON neighbour, and a record with no sessionId must all be ignored
    // rather than fail the scan — the directory belongs to Claude Code, not to us.
    await writeFile(join(sessionsDir, '300.json'), '{"pid":300,', 'utf8');
    await writeFile(join(sessionsDir, 'notes.txt'), 'ignore me', 'utf8');
    await writeFile(join(sessionsDir, '400.json'), JSON.stringify({ pid: 400 }), 'utf8');

    const entries = await readSessionRegistry(sessionsDir);
    expect(entries.map((e) => e.sessionId).sort()).toEqual(['aaa', 'bbb']);
    expect(entries.find((e) => e.pid === 100)).toEqual({
      pid: 100,
      sessionId: 'aaa',
      cwd: 'C:\\a',
      name: 'work',
    });
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await readSessionRegistry(join(tmpdir(), 'cctl-channel-no-such-dir-9999'))).toEqual([]);
  });
});

describe('resolveIdentity — verified environment', () => {
  it('accepts CLAUDE_CODE_SESSION_ID only when a registry file confirms it', async () => {
    const sessionsDir = await registry([
      { pid: 4242, sessionId: 'sess-a', cwd: 'C:\\repo\\a', name: 'work-ee' },
    ]);
    const { parentOf, calls } = chainOf({});

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'sess-a' },
      sessionsDir,
      pid: 1,
      parentPid: 4242,
      parentOf,
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'sess-a',
      source: 'env',
      pid: 4242,
      cwd: 'C:\\repo\\a',
      name: 'work-ee',
      ambiguous: false,
    });
    // The ancestor walk must stay OFF the verified path: it is the slow half of this module and
    // the MCP handshake is waiting on it.
    expect(calls).toEqual([]);
  });

  it('honours CLAUDE_CONFIG_DIR when locating the registry', async () => {
    const sessionsDir = await registry([{ pid: 7, sessionId: 'sess-cfg' }]);
    const claudeDir = join(sessionsDir, '..');

    const result = await resolveIdentity({
      env: { CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_SESSION_ID: 'sess-cfg' },
      platform: 'win32',
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'sess-cfg', source: 'env' });
  });

  it('falls through to ancestry when the env var names an unknown session', async () => {
    // A stale id inherited from a session that has since exited is a real shape; trusting it
    // would address injections to a dead session.
    const sessionsDir = await registry([{ pid: 900, sessionId: 'live' }]);
    const { parentOf } = chainOf({ 500: 900 });

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'ghost' },
      sessionsDir,
      pid: 1,
      parentPid: 500,
      parentOf,
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'live', source: 'ancestry' });
  });
});

describe('resolveIdentity — ancestry fallback', () => {
  it('matches the one live session on the chain', async () => {
    const sessionsDir = await registry([{ pid: 900, sessionId: 'only', cwd: 'C:\\only' }]);
    const { parentOf } = chainOf({ 50: 60, 60: 900 });

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 10,
      parentPid: 50,
      parentOf,
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'only',
      source: 'ancestry',
      pid: 900,
      cwd: 'C:\\only',
      name: undefined,
      ambiguous: false,
    });
  });

  it('takes the NEAREST ancestor and flags ambiguity when a session nests inside another', async () => {
    // The measured hazard: an outer Claude Code session spawned an inner one, so BOTH are
    // ancestors of this MCP server. The inner (nearest) session owns us.
    const sessionsDir = await registry([
      { pid: 200, sessionId: 'inner' },
      { pid: 100, sessionId: 'outer' },
    ]);
    const { parentOf } = chainOf({ 300: 200, 200: 100, 100: 1 });

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 400,
      parentPid: 300,
      parentOf,
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'inner', source: 'ancestry', pid: 200 });
    expect(result).toHaveProperty('ambiguous', true);
  });

  it('does not flag ambiguity for a single match even on a long chain', async () => {
    const sessionsDir = await registry([{ pid: 100, sessionId: 'outer' }]);
    const { parentOf } = chainOf({ 300: 200, 200: 100, 100: 1 });

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 400,
      parentPid: 300,
      parentOf,
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'outer', ambiguous: false });
  });

  it('terminates on a recycled-pid cycle instead of spinning', async () => {
    const sessionsDir = await registry([{ pid: 999, sessionId: 'unrelated' }]);
    const { parentOf, calls } = chainOf({ 100: 200, 200: 100 });

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 1,
      parentPid: 100,
      parentOf,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'no ancestor of pid 1 is a live Claude Code session (walked 2 hop(s))',
    });
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('stops at the hop cap on an unbounded chain', async () => {
    const sessionsDir = await registry([{ pid: 999999, sessionId: 'far-away' }]);
    // Every pid claims a fresh parent, so only MAX_ANCESTOR_HOPS bounds the walk.
    const parentOf: ParentOf = (pid) => Promise.resolve(pid + 1);

    const result = await resolveIdentity({ env: {}, sessionsDir, pid: 1, parentPid: 2, parentOf });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain(`walked ${MAX_ANCESTOR_HOPS} hop(s)`);
  });
});

describe('resolveIdentity — fail closed', () => {
  it('refuses when the process tree is invisible rather than guessing the only session', async () => {
    // Exactly one session is running, and it is almost certainly ours. "Almost certainly" is
    // what this module is not allowed to do.
    const sessionsDir = await registry([{ pid: 900, sessionId: 'tempting' }]);

    const result = await resolveIdentity({ env: {}, sessionsDir, pid: 1, parentPid: undefined });

    expect(result).toEqual({
      ok: false,
      reason: 'no CLAUDE_CODE_SESSION_ID and this process has no visible ancestors',
    });
  });

  it('mentions the unverifiable env var when there is also no visible ancestry', async () => {
    const sessionsDir = await registry([{ pid: 900, sessionId: 'live' }]);

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'ghost' },
      sessionsDir,
      pid: 1,
      parentPid: undefined,
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('ghost');
  });

  it('refuses when there is no session registry at all', async () => {
    const missing = join(tmpdir(), 'cctl-channel-absent-registry');
    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'x' },
      sessionsDir: missing,
    });
    expect(result).toEqual({
      ok: false,
      reason: `no readable Claude Code session registry files under ${missing}`,
    });
  });
});

describe('createParentOf', () => {
  // The one test that exercises the real platform mechanism: Node already knows this process's
  // parent, so the platform lookup has a checkable right answer. Both assertions share one
  // lookup because on Windows each `createParentOf` costs a full process-table query.
  it("resolves this process's real parent, and reports nothing for a pid that cannot exist", async () => {
    const parentOf = createParentOf();
    expect(await parentOf(process.pid)).toBe(process.ppid);
    expect(await parentOf(0x7ffffff0)).toBeUndefined();
  }, 90_000); // fast. // rather than tight — the point is that the mechanism is exercised for real, not that it is // Spawns a real process-table query; slow on a loaded Windows box, so the bound is patient
});
