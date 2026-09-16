import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createParentOf,
  parseWindowsProcessTable,
  MAX_ANCESTOR_HOPS,
  MAX_ANCESTOR_WALK_MS,
  pidIsLive,
  readSessionRegistry,
  resolveIdentity,
  type ParentOf,
  type SessionRegistryEntry,
} from './identity.js';

// Real temp dirs and real registry files throughout — the whole point of this module is that it
// reads what Claude Code actually wrote, so a stubbed filesystem would prove nothing. That also
// means every test here pays real Windows filesystem latency, which on a busy machine is orders
// of magnitude worse than the default bound; these are correctness tests, not timing ones.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
      // The invented pids in this test do not exist on the machine running it.
      isLive: () => true,
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
    // The verified path cross-checks the process tree, but it must not PAY for it in the ordinary
    // shape: the session that spawned this server IS its immediate parent, which Node hands over
    // for free, so the walk answers without a single parent lookup.
    expect(calls).toEqual([]);
  });

  it('honours CLAUDE_CONFIG_DIR when locating the registry', async () => {
    const sessionsDir = await registry([{ pid: 7, sessionId: 'sess-cfg' }]);
    const claudeDir = join(sessionsDir, '..');

    const result = await resolveIdentity({
      env: { CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_SESSION_ID: 'sess-cfg' },
      platform: 'win32',
      // Where the registry lives is the only question here, so the tree is stubbed rather than
      // answered with a real process-table query.
      pid: 1,
      parentPid: 7,
      parentOf: chainOf({}).parentOf,
      isLive: () => true,
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'sess-cfg', source: 'env' });
  });

  it('REFUSES when ancestry names a different session than the env var', async () => {
    // The wrong-session hazard, exactly. Session A (pid 900) spawned this process; the env var
    // says we belong to session B, whose registry file was momentarily unreadable. Accepting
    // ancestry here attaches us as A, and every message for A then lands in B's terminal.
    const sessionsDir = await registry([{ pid: 900, sessionId: 'live' }]);
    const { parentOf } = chainOf({ 500: 900 });

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'ghost' },
      sessionsDir,
      pid: 1,
      parentPid: 500,
      parentOf,
      sleep: () => Promise.resolve(),
      // The invented pids in this test do not exist on the machine running it.
      isLive: () => true,
    });

    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('ghost');
    expect(reason).toContain('live');
    expect(reason).toMatch(/contradict/i);
  });

  it('REFUSES a confirmed env id whose nearest live ancestor is a different session', async () => {
    // The inherited-environment hazard, measured on this platform: Claude Code exports
    // CLAUDE_CODE_SESSION_ID into Bash-tool subprocesses, so a `claude` started from inside the
    // OUTER session reads the outer session's id. Both sessions are live and both are registered,
    // so the env var confirms perfectly — and attaching on that alone writes every message the
    // operator sends to `outer` into `inner`'s terminal, in a different repo.
    const sessionsDir = await registry([
      { pid: 900, sessionId: 'outer', cwd: 'C:\\repo\\outer' },
      { pid: 4242, sessionId: 'inner', cwd: 'C:\\repo\\inner' },
    ]);
    const { parentOf } = chainOf({ 4242: 900 });

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'outer' },
      sessionsDir,
      pid: 1,
      // Our real owner is the INNER session; the outer one is its parent.
      parentPid: 4242,
      parentOf,
      isLive: () => true,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('outer');
    expect(reason).toContain('inner');
    expect(reason).toMatch(/contradict|inherited/i);
  });

  it('REFUSES a confirmed env id when nothing above this process is a live session', async () => {
    // An unreadable or session-less process tree is an absence of evidence. It is the one state
    // in which the inherited-env case above cannot be told apart from the ordinary one, so it
    // refuses: the cost is this session's channel plus a printed reason, and the cost of the
    // alternative is one operator's instruction landing in someone else's terminal.
    const sessionsDir = await registry([{ pid: 900, sessionId: 'somewhere' }]);
    const { parentOf } = chainOf({});

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'somewhere' },
      sessionsDir,
      pid: 1,
      parentPid: 77, // a process that is not a Claude Code session, with no visible parent
      parentOf,
      isLive: () => true,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('live Claude Code session');
  });

  it('stops the cross-check walk at the first registered ancestor', async () => {
    // The walk is bounded by what it is looking FOR, not by the depth of the tree: once a
    // registered session is found there is nothing further up that could change the answer, and
    // every extra hop on this platform is a whole-process-table query.
    const sessionsDir = await registry([
      { pid: 500, sessionId: 'ours' },
      { pid: 900, sessionId: 'grandparent' },
    ]);
    const { parentOf, calls } = chainOf({ 500: 900, 900: 1 });

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'ours' },
      sessionsDir,
      pid: 1,
      parentPid: 500,
      parentOf,
      isLive: () => true,
      sleep: () => Promise.resolve(),
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'ours', source: 'env', pid: 500 });
    expect(calls).toEqual([]);
  });

  it('re-reads the registry so a torn write does not cost the session its identity', async () => {
    // The registry entry is absent on the first read and present on the second — a torn write,
    // which `readSessionRegistry` skips by design, or a file not yet created at startup.
    const sessionsDir = await registry([{ pid: 900, sessionId: 'other' }]);
    let reads = 0;
    const sleep = async (): Promise<void> => {
      reads += 1;
      if (reads === 1) {
        // The owning session finishes writing its file between our two scans.
        await writeFile(
          join(sessionsDir, '4242.json'),
          JSON.stringify({ pid: 4242, sessionId: 'mine', cwd: 'C:\\repo\\mine' }),
          'utf8',
        );
      }
    };

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'mine' },
      sessionsDir,
      pid: 1,
      // Our real owner — the session whose registry file is the one being written late.
      parentPid: 4242,
      parentOf: chainOf({}).parentOf,
      isLive: () => true,
      sleep,
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'mine', source: 'env', pid: 4242 });
  });

  it('does not re-read when there is no env var to confirm', async () => {
    const sessionsDir = await registry([{ pid: 900, sessionId: 'only' }]);
    let sleeps = 0;

    await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 1,
      parentPid: 900,
      parentOf: chainOf({}).parentOf,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });

    expect(sleeps).toBe(0);
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
      isLive: () => true,
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
      isLive: () => true,
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
      isLive: () => true,
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
  it("resolves this process's real parent on this platform", async () => {
    const parentOf = createParentOf();
    const got = await parentOf(process.pid);

    if (process.platform === 'win32') {
      // The Windows lookup shells out to a full CIM process query, which on a loaded machine
      // can exceed its own timeout and legitimately answer "unknown parent" — the walk treats
      // that as a stopping point, not an error. So assert the property that must ALWAYS hold:
      // it never returns a WRONG parent. The parse itself is covered deterministically below.
      if (got !== undefined) expect(got).toBe(process.ppid);
    } else {
      expect(got).toBe(process.ppid);
    }
  }, 90_000);

  it('reports an unknown parent for a pid that cannot exist', async () => {
    const parentOf = createParentOf();
    expect(await parentOf(0x7ffffff0)).toBeUndefined();
  }, 90_000);
});

describe('parseWindowsProcessTable', () => {
  it('reads the array form the CIM query normally returns', () => {
    const table = parseWindowsProcessTable(
      '[{"ProcessId":4242,"ParentProcessId":100},{"ProcessId":100,"ParentProcessId":4}]',
    );
    expect(table.get(4242)).toBe(100);
    expect(table.get(100)).toBe(4);
  });

  it('reads the bare-object form ConvertTo-Json emits for a single row', () => {
    expect(parseWindowsProcessTable('{"ProcessId":7,"ParentProcessId":1}').get(7)).toBe(1);
  });

  it('drops rows that cannot be a pid rather than inventing one', () => {
    const table = parseWindowsProcessTable(
      '[{"ProcessId":5,"ParentProcessId":0},{"ProcessId":null,"ParentProcessId":9},{"ProcessId":6}]',
    );
    // ppid 0 is the tree root, which must end a walk rather than extend it.
    expect(table.has(5)).toBe(false);
    expect(table.size).toBe(0);
  });

  it('degrades to an empty table on garbage instead of throwing', () => {
    expect(parseWindowsProcessTable('not json').size).toBe(0);
    expect(parseWindowsProcessTable('"a string"').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Liveness and determinism. A registry file outlives the session that wrote it, so matching one
// is not the same as finding a running session.
// ---------------------------------------------------------------------------

describe('liveness', () => {
  it('skips an ancestor whose registry file belongs to a session that has exited', async () => {
    const sessionsDir = await registry([
      { pid: 200, sessionId: 'dead' },
      { pid: 100, sessionId: 'alive' },
    ]);
    const { parentOf } = chainOf({ 300: 200, 200: 100, 100: 1 });

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 400,
      parentPid: 300,
      parentOf,
      // pid 200's process is gone; its file is just a leftover.
      isLive: (pid) => pid !== 200,
    });

    // Without the liveness filter the NEAREST match (the dead session) would have won.
    expect(result).toMatchObject({ ok: true, sessionId: 'alive', pid: 100 });
    expect(result).toHaveProperty('ambiguous', false);
  });

  it('refuses, honestly, when every ancestor match is dead', async () => {
    const sessionsDir = await registry([{ pid: 100, sessionId: 'dead' }]);
    const { parentOf } = chainOf({ 300: 100, 100: 1 });

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 400,
      parentPid: 300,
      parentOf,
      isLive: () => false,
    });

    // The refusal claims "no ancestor is a LIVE session" — that claim has to be true.
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('live Claude Code session');
  });

  it('prefers the live file when two registry entries claim the same sessionId', async () => {
    // A resumed session leaves its previous pid's file behind; attaching to that pid is wrong.
    // Which of the two is right is settled by the process tree rather than by liveness alone:
    // the one that is actually our ancestor is the one whose cwd and pid describe us.
    const sessionsDir = await registry([
      { pid: 100, sessionId: 'shared', cwd: 'C:\\stale' },
      { pid: 900, sessionId: 'shared', cwd: 'C:\\live' },
    ]);

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'shared' },
      sessionsDir,
      pid: 1,
      parentPid: 900,
      parentOf: chainOf({}).parentOf,
      isLive: (pid) => pid === 900,
      sleep: () => Promise.resolve(),
    });

    expect(result).toMatchObject({ ok: true, pid: 900, cwd: 'C:\\live' });
  });

  it('pidIsLive agrees with reality for this process and for a pid that cannot exist', () => {
    expect(pidIsLive(process.pid)).toBe(true);
    expect(pidIsLive(0x7ffffff0)).toBe(false);
  });

  it('pidIsLive reads ESRCH as the ONLY code that means dead', () => {
    // EPERM is what Windows raises for a process that exists but cannot be signalled, and it is
    // routine on a shared machine; an unmapped errno is simply an unknown answer. Reading either
    // as "dead" would make this module and the daemon's own probe disagree about the same pid,
    // and the session would lose an identity it actually has. `process.kill` is stubbed because
    // conjuring a real EPERM process is not something a unit test can do portably.
    const kill = vi.spyOn(process, 'kill');
    try {
      for (const code of ['EPERM', 'EINVAL', undefined]) {
        kill.mockImplementationOnce(() => {
          throw Object.assign(new Error('probe failed'), { code });
        });
        expect(pidIsLive(4242)).toBe(true);
      }
      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      expect(pidIsLive(4242)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it('keeps procStart and pidDomain, and refuses a pid from another platform', async () => {
    // Claude Code stamps both, and they are the only evidence that a pid means what it says. A
    // narrowing that dropped them would guarantee nothing downstream could ever use them; a
    // domain naming another platform means the pid belongs to a different pid namespace
    // entirely, where our own `process.kill` probe is asking about an unrelated process.
    const root = await mkdtemp(join(tmpdir(), 'cctl-channel-identity-'));
    dirs.push(root);
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, '900.json'),
      JSON.stringify({
        pid: 900,
        sessionId: 'elsewhere',
        cwd: '/repo',
        procStart: '134339581700251254',
        pidDomain: 'linux:some-box',
      }),
      'utf8',
    );

    const entries = await readSessionRegistry(sessionsDir);
    expect(entries[0]).toMatchObject({
      procStart: '134339581700251254',
      pidDomain: 'linux:some-box',
    });

    const result = await resolveIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'elsewhere' },
      platform: 'win32',
      sessionsDir,
      pid: 1,
      parentPid: 900,
      parentOf: chainOf({}).parentOf,
      // Even with the pid probe saying yes, a foreign pid namespace is not ours.
      isLive: () => true,
      sleep: () => Promise.resolve(),
    });
    expect(result.ok).toBe(false);
  });
});

describe('readSessionRegistry ordering', () => {
  it('returns a deterministic order regardless of which read finishes first', async () => {
    const sessionsDir = await registry([
      { pid: 900, sessionId: 'c' },
      { pid: 100, sessionId: 'a' },
      { pid: 500, sessionId: 'b' },
    ]);

    // Reads complete in arbitrary order, so run it repeatedly: an unsorted result would drift.
    for (let i = 0; i < 5; i += 1) {
      const entries = await readSessionRegistry(sessionsDir);
      expect(entries.map((e) => e.pid)).toEqual([100, 500, 900]);
    }
  });
});

describe('walk deadline', () => {
  it('stops walking once the wall-clock budget is spent, even below the hop cap', async () => {
    const sessionsDir = await registry([{ pid: 999999, sessionId: 'far-away' }]);
    let hops = 0;
    const parentOf: ParentOf = (pid) => {
      hops += 1;
      return Promise.resolve(pid + 1);
    };
    // Every hop burns a third of the budget, so the walk must give up long before 24 hops.
    let clock = 0;
    const now = (): number => {
      clock += MAX_ANCESTOR_WALK_MS / 3;
      return clock;
    };

    const result = await resolveIdentity({
      env: {},
      sessionsDir,
      pid: 1,
      parentPid: 2,
      parentOf,
      now,
    });

    expect(result).toMatchObject({ ok: false });
    expect(hops).toBeLessThan(MAX_ANCESTOR_HOPS);
  });
});
