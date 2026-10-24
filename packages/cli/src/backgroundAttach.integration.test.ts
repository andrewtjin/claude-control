// The routing of `cctl claude` for background sessions end to end on the production path: the real
// host (its file reads, its no-shell detached runner, the stop that waits for the exit, `rm`, the
// move lock and the recovery on disk, its reads verified against the start times recorded), the
// daemon's own move, and the launcher's spawn of the final command, against a fake `claude` put on
// PATH (an npm-style .cmd shim on Windows, a shell wrapper elsewhere, both running a CommonJS `.cjs`
// script, which stays CommonJS under any package type). The fake keeps a background service per
// config dir the way Claude Code was measured to (2.1.295, and again 2.1.296) — a roster and job rows
// per config dir, one shared registry, start times recorded — and does what that binary does with
// them: its stop returns before the session has exited; an attach, or an interactive --resume by id
// or by title, that wakes a row while the session runs in another service kills it there and takes it
// over (a steal); with nothing live, an interactive --resume runs it in the foreground whatever its
// row says; an attach by name matches this config dir's own row names, and opens only a session
// running here; a failed row echoes its error; a resume over a row saved with other options starts a
// copy; `rm` deletes a row and kills the session when it is live. Every command, steal, kill and copy
// is logged.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIRM_TIMEOUT_MS } from '@claude-control/daemon';
import {
  parseBackgroundRequest,
  routeBackgroundLaunch,
  runHolding,
  type RouteContext,
} from './backgroundAttach.js';
import { createClaudeBackgroundHost, moveLocksDir } from './backgroundHost.js';
import { buildLaunchEnv, findClaudeOnPath, resolveLaunchTarget, spawnClaude } from './launcher.js';
import { LIVE_START, makeFakeClaudeRig, type FakeClaudeRig } from './testSupport/fakeClaude.js';

const SID = 'c5f2097e-d500-42a0-9ddf-8a33f4f9a886';
const SHORT = 'c5f2097e';
let rig: FakeClaudeRig | undefined;
afterEach(async () => {
  if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 5 });
  rig = undefined;
});

/** The session runs in a config dir's service, with a row there in state running. */
async function runsIn(r: FakeClaudeRig, configDir: string, status: string): Promise<void> {
  await mkdir(join(configDir, 'daemon'), { recursive: true });
  await writeFile(
    join(configDir, 'daemon', 'roster.json'),
    JSON.stringify({
      workers: {
        [SHORT]: { pid: process.pid, procStart: LIVE_START, sessionId: SID, cwd: r.work },
      },
    }),
  );
  await writeFile(
    join(r.main, 'sessions', '100001.json'),
    JSON.stringify({
      pid: process.pid,
      procStart: LIVE_START,
      sessionId: SID,
      kind: 'bg',
      status,
      jobId: SHORT,
      cwd: r.work,
    }),
  );
}

async function row(
  configDir: string,
  state: string,
  respawnFlags: string[],
  cwd: string,
): Promise<void> {
  await mkdir(join(configDir, 'jobs', SHORT), { recursive: true });
  await writeFile(
    join(configDir, 'jobs', SHORT, 'state.json'),
    JSON.stringify({ state, sessionId: SID, name: 'bg eval', cwd, respawnFlags, detail: 'exit 1' }),
  );
}

/** Give the session's conversation a title, as Claude Code writes one. */
async function titled(r: FakeClaudeRig, title: string): Promise<void> {
  await mkdir(join(r.main, 'projects', 'proj'), { recursive: true });
  await writeFile(
    join(r.main, 'projects', 'proj', `${SID}.jsonl`),
    `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: SID })}\n`,
  );
}

interface Logged {
  cfg: string;
  argv: string[];
  steal?: string;
  killed?: string;
  copy?: boolean;
  prompt?: string;
  refused?: string;
  foreground?: boolean;
  picker?: boolean;
}

async function commands(r: FakeClaudeRig): Promise<Logged[]> {
  return (await readFile(r.log, 'utf8'))
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Logged);
}

/** Which config dirs hold a job row of the session. */
async function rowsOf(r: FakeClaudeRig): Promise<string[]> {
  const out: string[] = [];
  for (const [name, dir] of [
    ['main', r.main],
    ['rule-x', r.profile],
  ] as const) {
    const jobs = await readdir(join(dir, 'jobs')).catch(() => [] as string[]);
    if (jobs.includes(SHORT)) out.push(name);
  }
  return out;
}

/** The host `cctl claude` builds, over the rig: this process stands in for every live session, and
 *  the operating system reports it started when the fake records it started. */
function hostOf(r: FakeClaudeRig): ReturnType<typeof createClaudeBackgroundHost> {
  return createClaudeBackgroundHost({
    mainConfigDir: r.main,
    mainConfigDirInEnv: true,
    moveLockDir: moveLocksDir(r.root),
    profilesRoot: join(r.root, 'profiles'),
    env: r.env,
    processStarts: (pids) =>
      Promise.resolve(new Map(pids.filter((p) => p === process.pid).map((p) => [p, LIVE_START]))),
  });
}

/** Route `cctl claude <args>` from the work folder (which belongs to the profile's rule), then run
 *  what it decided the way `cctl claude` does: the real launcher's env and spawn, the lock held
 *  until the terminal it started shows up. */
async function cctlClaude(
  r: FakeClaudeRig,
  args: string[],
): Promise<{ lines: string[]; exit: number | undefined; decision: string }> {
  const host = hostOf(r);
  const lines: string[] = [];
  const ctx: RouteContext = {
    host,
    cwd: r.work,
    platform: process.platform,
    sameFolder: (a, b) => a.toLowerCase() === b.toLowerCase(),
    titleFolders: (cwd) => Promise.resolve([cwd]),
    homeOf: () => Promise.resolve({ configDir: r.profile, movable: true }),
    launchConfigDir: () => Promise.resolve(r.profile),
    view: (c) =>
      Promise.resolve(
        c === null
          ? { account: 'Shared', slot: 'the global slot' }
          : { account: 'Inc', slot: 'the folder slot of work' },
      ),
    daemonRunning: false,
    say: (l) => lines.push(l),
    shield: (fn) => fn(() => {}),
    lockWaitMs: 1_000,
    timing: {
      clock: () => performance.now(),
      confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 50))),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    },
  };
  const request = parseBackgroundRequest(args);
  if (request === undefined) throw new Error(`not a background request: ${args.join(' ')}`);
  const decision = await routeBackgroundLaunch(request, ctx, { kind: 'follow' });
  if (decision.kind === 'refuse') return { lines, exit: undefined, decision: decision.message };
  const configDir = decision.kind === 'open' ? decision.configDir : r.profile;
  const candidate = findClaudeOnPath({
    platform: process.platform,
    pathEnv: r.env.PATH!,
    pathExt: '.EXE;.CMD',
  });
  const target = resolveLaunchTarget(candidate!, { platform: process.platform });
  if (target.kind !== 'run') throw new Error(target.reason);
  const env = buildLaunchEnv({
    baseEnv: r.env,
    slot:
      configDir === null
        ? { kind: 'global', label: 'Shared', context: 'global' }
        : { kind: 'group', profileDir: configDir, label: 'Inc', context: 'rule' },
    dropInheritedConfigDir: true,
    profilesRoot: join(r.root, 'profiles'),
  });
  const named = host.configEnv(configDir);
  if (named !== undefined) env.CLAUDE_CONFIG_DIR = named;
  const exit = await runHolding(host, decision.hold, (spawned) =>
    spawnClaude({
      command: target.command,
      args: [...target.prefixArgs, ...(decision.kind === 'open' ? decision.args : args)],
      env,
      onSpawn: spawned,
    }),
  );
  return { lines, exit, decision: decision.kind };
}

/** Run plain `claude <args>` under a config dir, as an operator's own shell would. */
async function plainClaude(r: FakeClaudeRig, configDir: string, args: string[]): Promise<number> {
  const candidate = findClaudeOnPath({
    platform: process.platform,
    pathEnv: r.env.PATH!,
    pathExt: '.EXE;.CMD',
  });
  const target = resolveLaunchTarget(candidate!, { platform: process.platform });
  if (target.kind !== 'run') throw new Error(target.reason);
  return spawnClaude({
    command: target.command,
    args: [...target.prefixArgs, ...args],
    env: { ...r.env, CLAUDE_CONFIG_DIR: configDir },
  });
}

const show = (ran: Logged[]): string[] => ran.map((c) => `${c.cfg} ${c.argv.join(' ')}`);
const harm = (ran: Logged[]): Logged[] =>
  ran.filter((c) => c.steal !== undefined || c.killed !== undefined || c.copy === true);

describe('cctl claude reaching a background session, against a fake claude on PATH', () => {
  it('idle on the global slot with a stale failed row in the folder profile: moved, then attached there, its rows only there', async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'idle');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    // Left failed by an earlier steal.
    await row(rig.profile, 'failed', ['--name=bg eval'], rig.work);
    const { lines, exit } = await cctlClaude(rig, ['attach', SHORT]);
    expect(exit).toBe(0);
    expect(lines.at(-1)).toContain('moved background session "bg eval" (c5f2097e)');
    const ran = await commands(rig);
    expect(show(ran)).toEqual([
      'main agents --json',
      `main stop ${SHORT}`,
      `main rm ${SHORT}`,
      `rule-x rm ${SHORT}`,
      `rule-x --bg --resume ${SID} --name=bg eval`,
      `rule-x attach ${SHORT}`,
    ]);
    expect(harm(ran)).toEqual([]);
    expect(await rowsOf(rig)).toEqual(['rule-x']);
    // The lock is gone once the attach has shown up, so the daemon is not held off.
    const relock = await createClaudeBackgroundHost({
      mainConfigDir: rig.main,
      moveLockDir: moveLocksDir(rig.root),
    }).lockSession(SID, 0);
    expect(relock).toBeDefined();
    relock!.release();
  }, 60_000);

  it('after the move, the commands that used to reach it from the global slot find no row there', async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'idle');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    expect((await cctlClaude(rig, ['attach', SHORT])).exit).toBe(0);
    for (const args of [
      ['stop', SHORT],
      ['rm', SHORT],
      ['attach', SHORT],
      ['attach', 'c5f2'],
      ['--resume', SID],
    ]) {
      await plainClaude(rig, rig.main, args);
    }
    const ran = await commands(rig);
    expect(harm(ran)).toEqual([]);
    expect(
      ran.filter((c) => c.cfg === 'main' && c.refused !== undefined).map((c) => c.argv[0]),
    ).toEqual(['stop', 'rm', 'attach', 'attach', '--resume']);
    expect(await rowsOf(rig)).toEqual(['rule-x']);
  }, 60_000);

  it('the same by title with --resume, from the folder the session works in', async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'idle');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'failed', ['--name=bg eval'], rig.work);
    await mkdir(join(rig.main, 'projects', 'proj'), { recursive: true });
    await writeFile(
      join(rig.main, 'projects', 'proj', `${SID}.jsonl`),
      JSON.stringify({ type: 'custom-title', customTitle: 'bg eval', sessionId: SID }) + '\n',
    );
    const { exit } = await cctlClaude(rig, ['--resume', 'bg eval']);
    expect(exit).toBe(0);
    const ran = await commands(rig);
    expect(ran.at(-1)).toMatchObject({ cfg: 'rule-x', argv: ['attach', SHORT] });
    expect(harm(ran)).toEqual([]);
  }, 60_000);

  it('a prompt given with --resume <id> reaches the session where it is opened', async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.profile, 'busy');
    await row(rig.profile, 'running', ['--name=bg eval'], rig.work);
    const { exit } = await cctlClaude(rig, ['--resume', SID, 'carry on with step 2']);
    expect(exit).toBe(0);
    const ran = await commands(rig);
    expect(ran).toEqual([
      {
        cfg: 'rule-x',
        argv: ['--resume', SID, 'carry on with step 2'],
        prompt: 'carry on with step 2',
      },
    ]);
  }, 60_000);

  it('busy on the global slot: attached there, never stopped, though the profile holds a stopped row', async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'busy');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'stopped', ['--name=bg eval'], rig.work);
    const { lines, exit } = await cctlClaude(rig, ['attach', SHORT]);
    expect(exit).toBe(0);
    expect(lines[0]).toContain('stays on Shared (the global slot) for now: it is in a turn.');
    const ran = await commands(rig);
    expect(show(ran)).toEqual([`main attach ${SHORT}`]);
    expect(harm(ran)).toEqual([]);
  }, 60_000);

  it('what cctl never runs: a plain attach under the profile, whose row is stopped, takes the session from the global slot', async () => {
    // The hazard every routing decision above avoids, as the fake (like the binary) has it.
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'busy');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'stopped', ['--name=bg eval'], rig.work);
    expect(await plainClaude(rig, rig.profile, ['attach', 'c5f2'])).toBe(0);
    expect(await commands(rig)).toEqual([
      { cfg: 'rule-x', argv: ['attach', 'c5f2'], steal: 'main' },
    ]);
  }, 60_000);

  it('what cctl never runs either: a plain --resume by title under the profile, whose row is stopped, takes it too', async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'busy');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'stopped', ['--name=bg eval'], rig.work);
    await titled(rig, 'bg eval');
    expect(await plainClaude(rig, rig.profile, ['--resume', 'bg eval'])).toBe(0);
    expect(harm(await commands(rig))).toMatchObject([{ cfg: 'rule-x', steal: 'main' }]);
  }, 60_000);

  it('with nothing live, a plain --resume runs it in the foreground, and an attach by name opens only one running there', async () => {
    rig = await makeFakeClaudeRig();
    await row(rig.profile, 'stopped', ['--name=bg eval'], rig.work);
    expect(await plainClaude(rig, rig.profile, ['--resume', SID])).toBe(0);
    expect(await plainClaude(rig, rig.profile, ['attach', 'bg eval'])).toBe(1);
    const ran = await commands(rig);
    expect(ran[0]).toMatchObject({ cfg: 'rule-x', foreground: true });
    expect(ran[1]?.refused).toContain('A name opens only a running session');
    expect(harm(ran)).toEqual([]);
  }, 60_000);

  it('a move cut off half way, its process gone: cctl claude --resume <id> brings it back, then opens it where it belongs', async () => {
    rig = await makeFakeClaudeRig();
    // The move stopped it and removed its row, then its process was ended before the resume: what
    // it saved as it committed is all that is left.
    await row(rig.main, 'stopped', ['-n', 'bg eval'], rig.work);
    await rm(join(rig.main, 'jobs'), { recursive: true, force: true });
    await hostOf(rig).saveRecovery({
      configDir: null,
      sessionId: SID,
      job: { short: SHORT, sessionId: SID },
      options: ['--name=bg eval'],
      cwd: rig.work,
    });
    const { lines, exit } = await cctlClaude(rig, ['--resume', SID]);
    expect(exit).toBe(0);
    expect(lines[0]).toBe(
      `cctl: brought background session ${SID} back on Shared (the global slot), where a move found it.`,
    );
    const ran = await commands(rig);
    expect(show(ran)).toEqual([
      // Back where it was, from its folder, with what it saved.
      `main --bg --resume ${SID} --name=bg eval`,
      'main agents --json',
      `main stop ${SHORT}`,
      `main rm ${SHORT}`,
      `rule-x --bg --resume ${SID} --name=bg eval`,
      `rule-x attach ${SHORT}`,
    ]);
    expect(ran[0]).toMatchObject({ cwd: rig.work });
    expect(harm(ran)).toEqual([]);
    expect(await hostOf(rig).recoveryOf(SID)).toBeUndefined();
  }, 60_000);

  it('a failed row after /clear in the folder profile is woken by the id its job started with, then attached', async () => {
    rig = await makeFakeClaudeRig();
    const NEW = 'a579c3c9-9210-4268-84cf-e73a20d40b60';
    await mkdir(join(rig.profile, 'jobs', SHORT), { recursive: true });
    await writeFile(
      join(rig.profile, 'jobs', SHORT, 'state.json'),
      JSON.stringify({
        state: 'failed',
        sessionId: SID,
        resumeSessionId: NEW,
        name: 'bg eval',
        cwd: rig.work,
        respawnFlags: ['--name=bg eval'],
        detail: 'exit 1 before init',
      }),
    );
    const { exit } = await cctlClaude(rig, ['attach', SHORT]);
    expect(exit).toBe(0);
    expect(show(await commands(rig))).toEqual([
      `rule-x --bg --resume ${SID}`,
      `rule-x attach ${SHORT}`,
    ]);
    // Woken in place: no new job named after the conversation it runs.
    expect(await readdir(join(rig.profile, 'jobs'))).toEqual([SHORT]);
    // Found where it runs now, under its job id, so the next attach just opens it there.
    expect((await cctlClaude(rig, ['attach', SHORT])).exit).toBe(0);
    expect(show(await commands(rig)).slice(2)).toEqual([`rule-x attach ${SHORT}`]);
    expect(harm(await commands(rig))).toEqual([]);
  }, 60_000);

  it('a move after /clear cut off before its rows went: cctl claude --resume <conversation> brings it back, says so, then moves it where it belongs', async () => {
    rig = await makeFakeClaudeRig();
    const NEW = 'a579c3c9-9210-4268-84cf-e73a20d40b60';
    // The move stopped it on the global slot and was cut off there: its row there is stopped, and
    // what the move saved names the conversation it runs and the job that ran it.
    await mkdir(join(rig.main, 'jobs', SHORT), { recursive: true });
    await writeFile(
      join(rig.main, 'jobs', SHORT, 'state.json'),
      JSON.stringify({
        state: 'stopped',
        sessionId: SID,
        resumeSessionId: NEW,
        name: 'bg eval',
        cwd: rig.work,
        respawnFlags: ['--name=bg eval'],
      }),
    );
    await hostOf(rig).saveRecovery({
      configDir: null,
      sessionId: NEW,
      job: { short: SHORT, sessionId: SID },
      options: ['--name=bg eval'],
      cwd: rig.work,
    });
    const { lines, exit } = await cctlClaude(rig, ['--resume', NEW]);
    expect(exit).toBe(0);
    expect(lines[0]).toBe(
      `cctl: brought background session ${NEW} back on Shared (the global slot), where a move found it.`,
    );
    expect(show(await commands(rig))).toEqual([
      // Its row woken by the id its job started with, into the conversation it ran last.
      `main --bg --resume ${SID}`,
      'main agents --json',
      `main stop ${SHORT}`,
      `main rm ${SHORT}`,
      `rule-x --bg --resume ${NEW} --name=bg eval`,
      `rule-x attach ${NEW.slice(0, 8)}`,
    ]);
    expect(harm(await commands(rig))).toEqual([]);
    expect(await hostOf(rig).recoveryOf(NEW)).toBeUndefined();
  }, 60_000);

  it("Claude Code's picker under the profile is refused while its stopped row could take the session from the global slot", async () => {
    rig = await makeFakeClaudeRig();
    await runsIn(rig, rig.main, 'busy');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'stopped', ['--name=bg eval'], rig.work);
    const { exit, decision } = await cctlClaude(rig, ['--resume']);
    expect(exit).toBeUndefined();
    expect(decision).toContain(`open it with: cctl claude attach ${SHORT}`);
    expect(await commands(rig)).toEqual([]);
  }, 60_000);
});
