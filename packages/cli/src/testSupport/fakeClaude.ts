// A fake Claude Code for tests that run the real launcher and the real background host against a
// binary on PATH: an npm-style .cmd shim on Windows, a shell wrapper elsewhere, both running a
// CommonJS `.cjs` script, which stays CommonJS under any package type. It keeps a background service
// per config dir the way Claude Code was measured to (2.1.295, and again 2.1.296) — a roster and job
// rows per config dir, one shared registry, start times recorded — and does what that binary does
// with them (see the background-attach integration test for what each verb does). Run as an
// interactive session instead (FAKE_SESSION=1), it holds the login of its config dir and rotates it
// as Claude Code does, which is what the parallel-session tests drive.

import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The start time every live process here records, and the operating system reports for this one. */
export const LIVE_START = '134360864829411286';

/** The fake Claude Code. Live processes are the test runner's own pid, so they stay alive. Run
 *  with FAKE_SESSION=1 and no background verb, it is an interactive session instead: see the
 *  session branch at its end. */
export const FAKE_CLAUDE_SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const MAIN = process.env.FAKE_MAIN;
const PROFILES = process.env.FAKE_PROFILES;
const LIVE = Number(process.env.FAKE_LIVE_PID);
/** The start time recorded for every live process, as Claude Code records one. */
const LIVE_START = process.env.FAKE_LIVE_START;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
const writeRow = (c, short, row) => {
  fs.mkdirSync(path.dirname(rowPath(c, short)), { recursive: true });
  fs.writeFileSync(rowPath(c, short), JSON.stringify(row));
};
const configs = () => [MAIN, ...fs.readdirSync(PROFILES).map((n) => path.join(PROFILES, n))];
const entries = () => fs.readdirSync(reg).map((f) => ({ f, e: rd(path.join(reg, f)) })).filter((x) => x.e);
const args = process.argv.slice(2);
const log = (o) =>
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cfg: path.basename(cfg), argv: args, ...o }) + '\n');
const fail = (text) => { log({ refused: text }); process.stderr.write(text + '\n'); process.exit(1); };
/** The config dir whose service hosts a job, if any. */
const hostOf = (short) => configs().find((c) => roster(c).workers[short] !== undefined);
/** Kill a live job where it runs (the wake sweep): out of its service and the registry, its row there failed. */
const kill = (short) => {
  const c = hostOf(short);
  if (c === undefined) return;
  const r = roster(c); delete r.workers[short]; writeRoster(c, r);
  for (const { f, e } of entries()) if (e.jobId === short) fs.unlinkSync(path.join(reg, f));
  const row = rd(rowPath(c, short));
  if (row) { row.state = 'failed'; row.detail = 'exit 1 before init'; writeRow(c, short, row); }
  return path.basename(c);
};
/** Wake a job in this config dir's service, live and idle: the roster lists it by its job id, its
 *  worker recording the conversation it is woken into, as the registry does (a row cleared before
 *  its wake runs the conversation it ran last, not the id its job started with, measured). */
const host = (short, sid, cwd, current) => {
  const r = roster(cfg); r.workers[short] = { pid: LIVE, procStart: LIVE_START, sessionId: current || sid, cwd }; writeRoster(cfg, r);
  fs.writeFileSync(path.join(reg, String(900000 + Math.floor(Math.random() * 99999)) + '.json'),
    JSON.stringify({ pid: LIVE, procStart: LIVE_START, sessionId: current || sid, kind: 'bg', status: 'idle', jobId: short, cwd }));
};
const ownShorts = () => {
  const jobs = path.join(cfg, 'jobs');
  return fs.existsSync(jobs) ? fs.readdirSync(jobs).filter((s) => /^[0-9a-f]{8}$/.test(s)) : [];
};
/** This config dir's row a job id or any prefix of one names, or a full id it started with
 *  (attach and stop read only these). */
const ownRow = (ref) => {
  const short = /^[0-9a-f]{1,8}$/.test(ref) ? ownShorts().find((s) => s.startsWith(ref)) : ownShorts().find((s) => (rd(rowPath(cfg, s)) || {}).sessionId === ref);
  return short === undefined ? undefined : { short, row: rd(rowPath(cfg, short)) };
};
/** This config dir's row by its name, as attach matches a name: this config dir's own rows only. */
const ownRowNamed = (ref) => {
  const short = ownShorts().find((s) => String((rd(rowPath(cfg, s)) || {}).name || '').toLowerCase() === ref.toLowerCase());
  return short === undefined ? undefined : { short, row: rd(rowPath(cfg, short)) };
};
/** This config dir's row of a conversation: the one its job started with, or runs after /clear. */
const ownRowOf = (sid) => {
  const short = ownShorts().find((s) => { const r = rd(rowPath(cfg, s)) || {}; return r.sessionId === sid || r.resumeSessionId === sid; });
  return short === undefined ? undefined : { short, row: rd(rowPath(cfg, short)) };
};
/** The conversation a title names: its last custom-title line, as --resume <title> matches it. */
const byTitle = (title) => {
  const projects = path.join(MAIN, 'projects');
  for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    for (const f of fs.readdirSync(path.join(projects, dir))) {
      const lines = fs.readFileSync(path.join(projects, dir, f), 'utf8').split('\n');
      const named = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.type === 'custom-title');
      const last = named[named.length - 1];
      if (last && String(last.customTitle).trim().toLowerCase() === title.trim().toLowerCase()) return f.replace(/\.jsonl$/, '');
    }
  }
  return undefined;
};
/** Open a job in a terminal: wake it here when it runs nowhere, stealing it when it runs elsewhere. */
const open = (short, row, extra) => {
  if (row.state === 'failed') fail('Session ' + short + " can't start — " + (row.detail || 'failed'));
  const where = hostOf(short);
  let steal;
  if (where !== undefined && !same(where, cfg)) steal = kill(short);
  if (where === undefined || steal !== undefined) { host(short, row.sessionId, row.cwd, row.resumeSessionId); row.state = 'running'; writeRow(cfg, short, row); }
  log({ ...(steal ? { steal } : {}), ...extra });
  // The terminal shows up in the service's attach journal while it is open.
  const journal = path.join(cfg, 'daemon', 'attach-journal');
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, 'g' + process.pid + '.json'), JSON.stringify({ pid: process.pid }));
  setTimeout(() => { fs.rmSync(path.join(journal, 'g' + process.pid + '.json'), { force: true }); process.stdout.write('attached\n'); }, 400);
};
if (args[0] === 'agents') {
  const out = [];
  const jobs = path.join(cfg, 'jobs');
  for (const short of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
    const row = rd(rowPath(cfg, short));
    if (!row) continue;
    const e = entries().map((x) => x.e).find((x) => x.jobId === short);
    out.push({ id: short, status: e ? e.status : 'idle', name: row.name });
  }
  log({});
  process.stdout.write(JSON.stringify(out));
} else if (args[0] === 'stop') {
  const own = ownRow(args[1]);
  if (own === undefined) fail("No job matching '" + args[1] + "'. Run 'claude agents' to list running sessions.");
  const where = hostOf(own.short);
  // A wake of nothing: a stop under a config dir whose row is stopped reaches the session anywhere.
  let killed;
  if (where !== undefined && !same(where, cfg)) killed = kill(own.short);
  if (own.row.state !== 'failed') { own.row.state = 'stopped'; writeRow(cfg, own.short, own.row); }
  log(killed ? { killed } : {});
  process.stdout.write('stopped ' + own.short + '\n');
  if (where !== undefined && same(where, cfg)) {
    // Claude Code returns before the session has exited: it goes half a second later.
    spawn(process.execPath, ['-e', 'setTimeout(()=>{' +
      'const fs=require("fs"),p=require("path");' +
      'const r=JSON.parse(fs.readFileSync(p.join(' + JSON.stringify(cfg) + ',"daemon","roster.json"),"utf8"));' +
      'delete r.workers[' + JSON.stringify(own.short) + '];' +
      'fs.writeFileSync(p.join(' + JSON.stringify(cfg) + ',"daemon","roster.json"),JSON.stringify(r));' +
      'for(const f of fs.readdirSync(' + JSON.stringify(reg) + ')){try{const e=JSON.parse(fs.readFileSync(p.join(' + JSON.stringify(reg) + ',f),"utf8"));if(e.jobId===' + JSON.stringify(own.short) + ')fs.unlinkSync(p.join(' + JSON.stringify(reg) + ',f))}catch{}}' +
      '},500)'], { detached: true, stdio: 'ignore' }).unref();
  }
} else if (args[0] === 'rm') {
  const own = ownRow(args[1]);
  if (own === undefined) fail("No job matching '" + args[1] + "'");
  const killed = hostOf(own.short) !== undefined ? kill(own.short) : undefined;
  fs.rmSync(path.dirname(rowPath(cfg, own.short)), { recursive: true, force: true });
  log({ ...(killed ? { killed } : {}), ...(own.row.worktreePath ? { worktreeDeleted: own.row.worktreePath } : {}) });
  process.stdout.write('removed ' + own.short + '\n');
} else if (args[0] === '--bg' && args[1] === '--resume') {
  const sid = args[2];
  const short = sid.slice(0, 8);
  const flags = args.slice(3);
  const row = rd(rowPath(cfg, short));
  const conversation = row && row.sessionId === sid ? row.resumeSessionId || sid : sid;
  const live = entries().some(({ e }) => e.sessionId === conversation);
  if (live || (row && flags.length > 0 && JSON.stringify(row.respawnFlags) !== JSON.stringify(flags))) {
    log({ copy: true });
    process.stdout.write('note: session ' + short + ' is already running in the background, so this started a copy as 5e1d04b2.\n');
    process.exit(0);
  }
  const next = row || { sessionId: sid, cwd: process.cwd(), respawnFlags: flags, name: 'auto' };
  next.state = 'running';
  writeRow(cfg, short, next);
  // A row woken by the id its job started with runs the conversation it ran last.
  host(short, next.sessionId, next.cwd, next.resumeSessionId);
  log({ cwd: process.cwd() });
  process.stdout.write('backgrounded · ' + short + ' (idle — send a prompt to start)\n');
} else if (args[0] === 'attach') {
  const own = ownRow(args[1]);
  if (own !== undefined) open(own.short, own.row, {});
  else {
    // A name: this config dir's own row names, and only a session running here.
    const named = ownRowNamed(args[1]);
    if (named === undefined) fail("No job matching '" + args[1] + "'. Run 'claude agents' to list running sessions.");
    const where = hostOf(named.short);
    if (where === undefined || !same(where, cfg)) fail('The background service has no process for session ' + named.short + '. A name opens only a running session.');
    open(named.short, named.row, {});
  }
} else if (args[0] === '--resume') {
  // By id, or by the conversation's title.
  const sid = UUID.test(args[1]) ? args[1] : byTitle(args[1]);
  if (sid === undefined) { log({ picker: true }); process.exit(0); }
  const prompt = args.length > 2 ? { prompt: args.slice(2).join(' ') } : {};
  const live = entries().find(({ e }) => e.sessionId === sid && e.kind === 'bg');
  // Nothing live: run in the foreground here, whatever row this config dir holds (failed or not).
  if (live === undefined) { log({ foreground: true, ...prompt }); process.exit(0); }
  const own = ownRowOf(sid);
  if (own === undefined) fail('That session is running in the background. Run claude agents to find it and open it.');
  open(own.short, own.row, prompt);
} else if (process.env.FAKE_SESSION === '1') {
  // An interactive session on CLAUDE_CONFIG_DIR's login, as Claude Code runs one: it reads the
  // credentials there, and on a timer rotates them (a new access and refresh token, a later
  // expiry) with a temp file and a rename, as Claude Code writes them. It records itself in
  // FAKE_RUN_DIR (<pid>.json: its config dir and every token it held) and exits when <pid>.exit
  // appears there, or after FAKE_EXIT_AFTER_MS.
  const credPath = path.join(cfg, '.credentials.json');
  const runDir = process.env.FAKE_RUN_DIR;
  const seen = [];
  const note = () => {
    const cur = rd(credPath);
    if (cur && cur.claudeAiOauth) seen.push(cur.claudeAiOauth.refreshToken);
    if (runDir) fs.writeFileSync(path.join(runDir, process.pid + '.json'), JSON.stringify({ cfg, ppid: process.ppid, seen }));
  };
  note();
  log({ session: true });
  let n = 0;
  const every = Number(process.env.FAKE_ROTATE_AFTER_MS || 0);
  if (every > 0) setInterval(() => {
    const cur = rd(credPath);
    if (!cur || !cur.claudeAiOauth) return;
    n += 1;
    const o = cur.claudeAiOauth;
    const next = { ...cur, claudeAiOauth: { ...o,
      accessToken: o.accessToken.replace(/~r[0-9.]+$/, '') + '~r' + process.pid + '.' + n,
      refreshToken: o.refreshToken.replace(/~r[0-9.]+$/, '') + '~r' + process.pid + '.' + n,
      expiresAt: o.expiresAt + 60000 } };
    const tmp = credPath + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, credPath);
    note();
  }, every);
  const after = Number(process.env.FAKE_EXIT_AFTER_MS || 0);
  if (after > 0) setTimeout(() => process.exit(0), after);
  setInterval(() => { if (runDir && fs.existsSync(path.join(runDir, process.pid + '.exit'))) process.exit(0); }, 25);
} else {
  log({ unexpected: true });
  process.exit(3);
}
`;

/** A sandbox with the fake Claude Code on PATH (see {@link makeFakeClaudeRig}). */
export interface FakeClaudeRig {
  root: string;
  main: string;
  profile: string;
  work: string;
  env: NodeJS.ProcessEnv;
  log: string;
  /** The directory the fake's bin lives in (its `claude` shim and `fake.cjs`). */
  bin: string;
  /** The fake as the shims run it: under `node_modules/@anthropic-ai/claude-code`, where npm
   *  installs Claude Code. A fake started from this path is taken for a Claude Code. */
  script: string;
}

/** A sandbox with a main config dir, one folder profile, a work folder and the fake on PATH. The
 *  sandbox root declares itself an ES module package, as some temp trees do: the fake must still
 *  run, being a .cjs. */
export async function makeFakeClaudeRig(prefix = 'cctl-bgattach-'): Promise<FakeClaudeRig> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), prefix)));
  const bin = join(root, 'bin');
  const main = join(root, 'main');
  const profiles = join(root, 'profiles');
  const profile = join(profiles, 'rule-x');
  const work = join(root, 'work');
  for (const d of [bin, join(main, 'sessions'), profile, work]) await mkdir(d, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(bin, 'fake.cjs'), FAKE_CLAUDE_SCRIPT, 'utf8');
  // The shims run a copy laid out where npm installs Claude Code, so a process check that tells a
  // Claude Code by its command line takes the fake for one.
  const pkg = join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(pkg, { recursive: true });
  const script = join(pkg, 'cli.cjs');
  await writeFile(script, FAKE_CLAUDE_SCRIPT, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(
      join(bin, 'claude.cmd'),
      '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.cjs" %*\r\n',
    );
  } else {
    await writeFile(
      join(bin, 'claude'),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      'utf8',
    );
    await chmod(join(bin, 'claude'), 0o755);
  }
  const log = join(root, 'log.jsonl');
  await writeFile(log, '');
  const env: NodeJS.ProcessEnv = {
    PATH: process.platform === 'win32' ? bin : `${bin}:/usr/bin:/bin`,
    PATHEXT: '.EXE;.CMD',
    SystemRoot: process.env.SystemRoot,
    FAKE_MAIN: main,
    FAKE_PROFILES: profiles,
    FAKE_LIVE_PID: String(process.pid),
    FAKE_LIVE_START: LIVE_START,
    FAKE_LOG: log,
  };
  return { root, main, profile, work, env, log, bin, script };
}
