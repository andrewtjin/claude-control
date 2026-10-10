// The routing of `cctl claude attach` / `--resume` end to end on the production path: the real host
// (its file reads, its no-shell runner, the stop that waits for the exit, the move lock on disk), the
// daemon's own move, and the launcher's spawn of the final attach, against a fake `claude` put on PATH
// (an npm-style .cmd shim on Windows, a node script elsewhere). The fake keeps a background service
// per config dir the way Claude Code does — a roster and job rows per config dir, one shared
// registry — and records every command, every copy a resume started, and every attach run under one
// config dir while the session ran in another's service (a steal).

import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIRM_TIMEOUT_MS } from '@claude-control/daemon';
import { routeBackgroundLaunch, runHolding, type RouteContext } from './backgroundAttach.js';
import { createClaudeBackgroundHost, moveLocksDir } from './backgroundHost.js';
import { buildLaunchEnv, findClaudeOnPath, resolveLaunchTarget, spawnClaude } from './launcher.js';

const SID = 'c5f2097e-d500-42a0-9ddf-8a33f4f9a886';
const SHORT = 'c5f2097e';

/** The fake Claude Code. Live processes are the test runner's own pid, so they stay alive. */
const FAKE = String.raw`
const fs = require('fs');
const path = require('path');
const MAIN = process.env.FAKE_MAIN;
const PROFILES = process.env.FAKE_PROFILES;
const LIVE = Number(process.env.FAKE_LIVE_PID);
const cfg = process.env.CLAUDE_CONFIG_DIR || MAIN;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const reg = path.join(MAIN, 'sessions');
const roster = (c) => rd(path.join(c, 'daemon', 'roster.json')) || { workers: {} };
const writeRoster = (c, r) => {
  fs.mkdirSync(path.join(c, 'daemon'), { recursive: true });
  fs.writeFileSync(path.join(c, 'daemon', 'roster.json'), JSON.stringify(r));
};
const rowPath = (c, short) => path.join(c, 'jobs', short, 'state.json');
const configs = () => [MAIN, ...fs.readdirSync(PROFILES).map((n) => path.join(PROFILES, n))];
const hostsOf = (sid) =>
  configs().filter((c) => Object.values(roster(c).workers).some((w) => w.sessionId === sid));
const args = process.argv.slice(2);
const log = (o) =>
  fs.appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({ cfg: path.basename(cfg), argv: args, ...o }) + '\n',
  );
if (args[0] === 'agents') {
  const out = [];
  const jobs = path.join(cfg, 'jobs');
  for (const short of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
    const row = rd(rowPath(cfg, short));
    if (!row) continue;
    const e = fs.readdirSync(reg).map((f) => rd(path.join(reg, f))).find((x) => x && x.sessionId === row.sessionId);
    out.push({ id: short, status: e ? e.status : 'idle', name: row.name });
  }
  log({});
  process.stdout.write(JSON.stringify(out));
} else if (args[0] === 'stop') {
  const short = args[1];
  const r = roster(cfg);
  const w = r.workers[short];
  if (w) {
    delete r.workers[short];
    writeRoster(cfg, r);
    for (const f of fs.readdirSync(reg)) {
      const e = rd(path.join(reg, f));
      if (e && e.sessionId === w.sessionId) fs.unlinkSync(path.join(reg, f));
    }
  }
  const row = rd(rowPath(cfg, short));
  if (row) { row.state = 'stopped'; fs.writeFileSync(rowPath(cfg, short), JSON.stringify(row)); }
  log({});
  process.stdout.write('stopped ' + short + '\n');
} else if (args[0] === '--bg' && args[1] === '--resume') {
  const sid = args[2];
  const short = sid.slice(0, 8);
  if (hostsOf(sid).length > 0) {
    log({ copy: true });
    process.stdout.write('note: session ' + short + ' is already running in the background, so this started a copy as 5e1d04b2.\n');
    process.exit(0);
  }
  let row = rd(rowPath(cfg, short));
  if (!row) {
    row = { sessionId: sid, cwd: process.cwd(), respawnFlags: args.slice(3), name: 'auto' };
    fs.mkdirSync(path.dirname(rowPath(cfg, short)), { recursive: true });
  }
  row.state = 'running';
  fs.writeFileSync(rowPath(cfg, short), JSON.stringify(row));
  const r = roster(cfg);
  r.workers[short] = { pid: LIVE, sessionId: sid, cwd: row.cwd };
  writeRoster(cfg, r);
  fs.writeFileSync(path.join(reg, String(900000 + Math.floor(Math.random() * 99999)) + '.json'),
    JSON.stringify({ pid: LIVE, sessionId: sid, kind: 'bg', status: 'idle', jobId: short, cwd: row.cwd }));
  log({ cwd: process.cwd() });
  process.stdout.write('backgrounded · ' + short + ' (idle — send a prompt to start)\n');
} else if (args[0] === 'attach') {
  const short = args[1];
  const elsewhere = configs().filter((c) => !same(c, cfg) && roster(c).workers[short] !== undefined);
  log(elsewhere.length > 0 ? { steal: elsewhere.map((c) => path.basename(c)) } : {});
  // The terminal shows up in the service's attach journal while it is open.
  const journal = path.join(cfg, 'daemon', 'attach-journal');
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, 'g.json'), JSON.stringify({ pid: process.pid }));
  setTimeout(() => { fs.rmSync(path.join(journal, 'g.json'), { force: true }); process.stdout.write('attached\n'); }, 400);
} else {
  log({ unexpected: true });
  process.exit(3);
}
`;

interface Rig {
  root: string;
  main: string;
  profile: string;
  work: string;
  env: NodeJS.ProcessEnv;
  log: string;
}

let rig: Rig | undefined;
afterEach(async () => {
  if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 5 });
  rig = undefined;
});

/** A sandbox with a main config dir, one folder profile, a work folder and the fake on PATH. */
async function makeRig(): Promise<Rig> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'cctl-bgattach-')));
  const bin = join(root, 'bin');
  const main = join(root, 'main');
  const profiles = join(root, 'profiles');
  const profile = join(profiles, 'rule-x');
  const work = join(root, 'work');
  for (const d of [bin, join(main, 'sessions'), profile, work]) await mkdir(d, { recursive: true });
  await writeFile(join(bin, 'fake.js'), FAKE, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\fake.js" %*\r\n');
  } else {
    await writeFile(join(bin, 'claude'), `#!${process.execPath}\n${FAKE}`, 'utf8');
    await chmod(join(bin, 'claude'), 0o755);
  }
  const log = join(root, 'log.jsonl');
  await writeFile(log, '');
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    PATHEXT: '.EXE;.CMD',
    SystemRoot: process.env.SystemRoot,
    FAKE_MAIN: main,
    FAKE_PROFILES: profiles,
    FAKE_LIVE_PID: String(process.pid),
    FAKE_LOG: log,
  };
  return { root, main, profile, work, env, log };
}

/** The session runs in a config dir's service, with a row there in state running. */
async function runsIn(r: Rig, configDir: string, status: string): Promise<void> {
  await mkdir(join(configDir, 'daemon'), { recursive: true });
  await writeFile(
    join(configDir, 'daemon', 'roster.json'),
    JSON.stringify({ workers: { [SHORT]: { pid: process.pid, sessionId: SID, cwd: r.work } } }),
  );
  await writeFile(
    join(r.main, 'sessions', '100001.json'),
    JSON.stringify({
      pid: process.pid,
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

async function commands(
  r: Rig,
): Promise<Array<{ cfg: string; argv: string[]; steal?: string[]; copy?: boolean }>> {
  return (await readFile(r.log, 'utf8'))
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { cfg: string; argv: string[]; steal?: string[]; copy?: boolean });
}

/** Route a request from the work folder (which belongs to the profile's rule), then run what it
 *  decided the way `cctl claude` does: the real launcher's env and spawn, the lock held until the
 *  attach shows up. */
async function openFromWork(
  r: Rig,
  ref: { verb: 'attach' | 'resume'; ref: string },
): Promise<{
  lines: string[];
  exit: number | undefined;
}> {
  const host = createClaudeBackgroundHost({
    mainConfigDir: r.main,
    moveLockDir: moveLocksDir(r.root),
    profilesRoot: join(r.root, 'profiles'),
    env: r.env,
  });
  const lines: string[] = [];
  const ctx: RouteContext = {
    host,
    cwd: r.work,
    platform: process.platform,
    sameFolder: (a, b) => a.toLowerCase() === b.toLowerCase(),
    homeOf: () => Promise.resolve({ configDir: r.profile, movable: true }),
    view: (c) =>
      Promise.resolve(
        c === null
          ? { account: 'Shared', slot: 'the global slot' }
          : { account: 'Inc', slot: 'the folder slot of work' },
      ),
    daemonRunning: false,
    say: (l) => lines.push(l),
    lockWaitMs: 1_000,
    timing: {
      clock: () => performance.now(),
      confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 50))),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    },
  };
  const decision = await routeBackgroundLaunch(ref, ctx, { kind: 'follow' });
  if (decision.kind !== 'open')
    return { lines: [...lines, JSON.stringify(decision)], exit: undefined };
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
      decision.configDir === null
        ? { kind: 'global', label: 'Shared', context: 'global' }
        : { kind: 'group', profileDir: decision.configDir, label: 'Inc', context: 'rule' },
    dropInheritedConfigDir: false,
  });
  const exit = await runHolding(host, decision.hold, () =>
    spawnClaude({ command: target.command, args: [...target.prefixArgs, ...decision.args], env }),
  );
  return { lines, exit };
}

describe('cctl claude opening a background session, against a fake claude on PATH', () => {
  it('idle on the global slot with a stale failed row in the folder profile: moved, then attached there', async () => {
    rig = await makeRig();
    await runsIn(rig, rig.main, 'idle');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    // Left failed by an earlier move back: saved with the same options, spelled the way a move
    // replays them.
    await row(rig.profile, 'failed', ['--name=bg eval'], rig.work);
    const { lines, exit } = await openFromWork(rig, { verb: 'attach', ref: SHORT });
    expect(exit).toBe(0);
    expect(lines[0]).toContain('moved background session "bg eval" (c5f2097e)');
    const ran = await commands(rig);
    expect(ran.map((c) => `${c.cfg} ${c.argv.join(' ')}`)).toEqual([
      'main agents --json',
      `main stop ${SHORT}`,
      `rule-x --bg --resume ${SID}`,
      `rule-x attach ${SHORT}`,
    ]);
    expect(ran.filter((c) => c.steal !== undefined || c.copy === true)).toEqual([]);
    const profileRoster = JSON.parse(
      await readFile(join(rig.profile, 'daemon', 'roster.json'), 'utf8'),
    ) as { workers: Record<string, unknown> };
    expect(Object.keys(profileRoster.workers)).toEqual([SHORT]);
    // The lock is gone once the attach has shown up, so the daemon is not held off.
    const relock = await createClaudeBackgroundHost({
      mainConfigDir: rig.main,
      moveLockDir: moveLocksDir(rig.root),
    }).lockSession(SID, 0);
    expect(relock).toBeDefined();
    relock!.release();
  }, 60_000);

  it('the same by title with --resume, from the folder the session works in', async () => {
    rig = await makeRig();
    await runsIn(rig, rig.main, 'idle');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'failed', ['--name=bg eval'], rig.work);
    await mkdir(join(rig.main, 'projects', 'proj'), { recursive: true });
    await writeFile(
      join(rig.main, 'projects', 'proj', `${SID}.jsonl`),
      JSON.stringify({ type: 'custom-title', customTitle: 'bg eval', sessionId: SID }) + '\n',
    );
    const { exit } = await openFromWork(rig, { verb: 'resume', ref: 'bg eval' });
    expect(exit).toBe(0);
    const ran = await commands(rig);
    expect(ran.at(-1)).toMatchObject({ cfg: 'rule-x', argv: ['attach', SHORT] });
    expect(ran.filter((c) => c.steal !== undefined || c.copy === true)).toEqual([]);
  }, 60_000);

  it('busy on the global slot: attached there, never stopped', async () => {
    rig = await makeRig();
    await runsIn(rig, rig.main, 'busy');
    await row(rig.main, 'running', ['-n', 'bg eval'], rig.work);
    await row(rig.profile, 'stopped', ['--name=bg eval'], rig.work);
    const { lines, exit } = await openFromWork(rig, { verb: 'attach', ref: SHORT });
    expect(exit).toBe(0);
    expect(lines[0]).toContain('stays on Shared (the global slot) for now: it is in a turn.');
    const ran = await commands(rig);
    expect(ran.map((c) => `${basename(c.cfg)} ${c.argv.join(' ')}`)).toEqual([
      `main attach ${SHORT}`,
    ]);
    expect(ran.filter((c) => c.steal !== undefined)).toEqual([]);
  }, 60_000);
});
