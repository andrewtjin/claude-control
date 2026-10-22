// Parallel sessions (`cctl claude --account`) end to end: a real engine over a sandboxed vault, real
// processes as holders (judged by the real process checks: kill-0, the Windows process table, /proc),
// and a fake Claude Code on PATH that holds its config dir's login and rotates it the way Claude Code
// does. `cctl claude` itself runs in-process, through the real launcher and the real spawn.
//
// Each case asserts what the vault, the rules file, the profile and the guard snapshot hold after the
// processes are done: a session's last rotation adopted into its own account, the profile cleared, the
// account back in the pool at its place, no rule left behind.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialStore,
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  Vault,
  childHolder,
  folderBindingsPath,
  groupProfileDir,
  leaseRuleId,
  readProcessStarts,
  ruleSlotId,
  selfHolder,
  type CredentialBundle,
  type LeaseHolder,
  type LeaseOccupancyProbe,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';
import {
  AttributionJournal,
  Store,
  bindGuardPath,
  buildTurnAttributor,
  writeBindGuard,
} from '@claude-control/daemon';
import { backgroundHostOptions, createClaudeBackgroundHost } from './backgroundHost.js';
import { createLeaseOccupancyProbe } from './leaseProbe.js';
import { buildProgram } from './program.js';
import { CliFailure, reportFatal } from './context.js';
import { makeFakeClaudeRig, type FakeClaudeRig } from './testSupport/fakeClaude.js';

// The CLI reads its paths and its engine from these, so `cctl claude` runs against the sandbox.
const sandbox = vi.hoisted(() => ({
  paths: undefined as Paths | undefined,
  engine: undefined as SwitchEngine | undefined,
}));
vi.mock('@claude-control/switch-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@claude-control/switch-engine')>()),
  defaultPaths: () => {
    if (sandbox.paths === undefined) throw new Error('test ran outside its sandbox');
    return sandbox.paths;
  },
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => {
    if (sandbox.engine === undefined) throw new Error('test ran outside its sandbox');
    return sandbox.engine;
  },
}));
// No cctl install of this machine's is consulted: the fence is tested on its own.
vi.mock('./installLookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./installLookup.js')>()),
  defaultInstallLookup: () => ({
    onPath: () => undefined,
    autostart: () => undefined,
    versionOf: () => undefined,
  }),
}));

const HOUR = 3_600_000;
const SID = 'c5f2097e-d500-42a0-9ddf-8a33f4f9a886';
const SHORT = 'c5f2097e';

interface World {
  rig: FakeClaudeRig;
  paths: Paths;
  engine: SwitchEngine;
  runDir: string;
  probe: LeaseOccupancyProbe;
  A: StoredAccount;
  W: StoredAccount;
  V: StoredAccount;
  children: ChildProcess[];
  /** Processes started by another process here (a launcher's own child), killed after the case. */
  strays: number[];
}

let world: World | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (world !== undefined) {
    for (const c of world.children) if (c.exitCode === null) c.kill('SIGKILL');
    for (const pid of world.strays) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(world.rig.root, { recursive: true, force: true, maxRetries: 10 });
  }
  world = undefined;
  sandbox.paths = undefined;
  sandbox.engine = undefined;
});

/** A login as a bundle: tokens named after the account, far from expiry. */
function bundleOf(name: string): CredentialBundle {
  return {
    claudeAiOauth: {
      accessToken: `a-${name}`,
      refreshToken: `r-${name}`,
      expiresAt: Date.now() + 10 * HOUR,
    },
    oauthAccount: { accountUuid: `uuid-${name}`, emailAddress: `${name}@example.test` },
  };
}

/** A sandbox with shared accounts A (live in the global slot), W and V, a real engine over it, and
 *  the fake Claude Code on PATH. */
async function setup(): Promise<World> {
  const rig = await makeFakeClaudeRig('cctl-lease-');
  const paths: Paths = {
    claudeDir: rig.main,
    credentialsPath: join(rig.main, '.credentials.json'),
    claudeJsonPath: join(rig.root, 'home', '.claude.json'),
    vaultDir: join(rig.root, 'vault'),
  };
  await mkdir(join(rig.root, 'home'), { recursive: true });
  const runDir = join(rig.root, 'runs');
  await mkdir(runDir, { recursive: true });
  const engine = new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 30_000, pollMs: 10 },
    refresh: () => Promise.reject(new Error('no network in tests')),
  });
  sandbox.paths = paths;
  sandbox.engine = engine;
  const A = await engine.addAccount('A', bundleOf('A'));
  const W = await engine.addAccount('W', bundleOf('W'));
  const V = await engine.addAccount('V', bundleOf('V'));
  await engine.activate(A.id, { force: true });
  const probe = createLeaseOccupancyProbe(createClaudeBackgroundHost(backgroundHostOptions(paths)));
  world = { rig, paths, engine, runDir, probe, A, W, V, children: [], strays: [] };
  return world;
}

/** Wait until `check` holds, polling. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** What a fake Claude Code recorded: its config dir and every refresh token it held, last one last. */
async function fakeRecord(w: World, pid: number): Promise<{ cfg: string; seen: string[] }> {
  return JSON.parse(await readFile(join(w.runDir, `${pid}.json`), 'utf8')) as {
    cfg: string;
    seen: string[];
  };
}

/** Start a fake Claude Code session on a config dir, rotating its login every `rotateMs`. Waits
 *  until it has rotated at least once. */
async function startFake(w: World, configDir: string, rotateMs = 60): Promise<ChildProcess> {
  const child = spawn(process.execPath, [w.rig.script], {
    env: {
      ...process.env,
      ...w.rig.env,
      PATH: process.env.PATH,
      FAKE_SESSION: '1',
      FAKE_ROTATE_AFTER_MS: String(rotateMs),
      FAKE_RUN_DIR: w.runDir,
      CLAUDE_CONFIG_DIR: configDir,
    },
    stdio: 'ignore',
  });
  w.children.push(child);
  const pid = child.pid!;
  await until(async () => {
    try {
      return (await fakeRecord(w, pid)).seen.length >= 2;
    } catch {
      return false;
    }
  });
  return child;
}

/** Ask a fake to exit, and wait until it has. */
async function stopFake(w: World, child: ChildProcess): Promise<void> {
  await writeFile(join(w.runDir, `${child.pid!}.exit`), '');
  await until(() => child.exitCode !== null || child.signalCode !== null);
}

/** A process standing in for a `cctl claude` launcher: it runs until killed, and with `withFake`
 *  starts a fake Claude Code as its own child (whose pid it writes to a file). The child is started
 *  detached: node puts an attached child in a job that ends with its parent on Windows, and the case
 *  this stands for is a Claude Code that outlives its killed launcher. */
async function startLauncher(
  w: World,
  withFake?: { configDir: string },
): Promise<{ proc: ChildProcess; holder: LeaseHolder; childPid?: number }> {
  const script = join(w.rig.bin, 'launcher.cjs');
  if (!existsSync(script)) {
    await writeFile(
      script,
      [
        "const { spawn } = require('child_process');",
        "const fs = require('fs');",
        "if (process.argv[2] === 'with-fake') {",
        "  const c = spawn(process.execPath, [process.argv[3]], { env: process.env, stdio: 'ignore', detached: true });",
        '  fs.writeFileSync(process.argv[4], String(c.pid));',
        '}',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
  }
  const pidFile = join(w.runDir, `launcher-${Date.now()}-${Math.random()}.pid`);
  const args = withFake ? [script, 'with-fake', w.rig.script, pidFile] : [script];
  const proc = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ...w.rig.env,
      PATH: process.env.PATH,
      FAKE_SESSION: '1',
      FAKE_ROTATE_AFTER_MS: '60',
      FAKE_RUN_DIR: w.runDir,
      ...(withFake ? { CLAUDE_CONFIG_DIR: withFake.configDir } : {}),
    },
    stdio: 'ignore',
  });
  w.children.push(proc);
  const { parent: _parent, ...rest } = childHolder(proc.pid!, process.pid);
  const holder: LeaseHolder = { ...rest, role: 'launcher' };
  if (!withFake) return { proc, holder };
  await until(() => existsSync(pidFile));
  const childPid = Number(await readFile(pidFile, 'utf8'));
  w.strays.push(childPid);
  await until(async () => {
    try {
      return (await fakeRecord(w, childPid)).seen.length >= 2;
    } catch {
      return false;
    }
  });
  return { proc, holder, childPid };
}

/** Whether a pid still runs. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The account's stored refresh token, read through a second handle on the same vault. */
async function storedRefresh(w: World, id: string): Promise<string> {
  const vault = new Vault(w.paths.vaultDir, new InsecurePassthroughProtector());
  return (await vault.readBundle(id)).claudeAiOauth.refreshToken;
}

/** This test process as a launcher holder, recorded the way `cctl claude` records itself. */
function thisLauncher(): LeaseHolder {
  return selfHolder('launcher');
}

/** The parallel-session profile of an account, and its live login file. */
function leaseProfile(w: World, accountId: string): string {
  return groupProfileDir(w.paths.vaultDir, leaseRuleId(accountId));
}

/** The rules file on disk, or undefined. */
async function rulesFile(
  w: World,
): Promise<{ schemaVersion: number; rules: Array<{ id: string }> } | undefined> {
  try {
    return JSON.parse(await readFile(join(w.paths.vaultDir, 'groups.json'), 'utf8')) as {
      schemaVersion: number;
      rules: Array<{ id: string }>;
    };
  } catch {
    return undefined;
  }
}

/** Everything a session that ended must leave: its last rotation in its own account's bundle, its
 *  profile logged out, no parallel-session rule, the account shared again at its place. */
async function expectEnded(w: World, account: StoredAccount, lastRefresh: string): Promise<void> {
  expect(await storedRefresh(w, account.id)).toBe(lastRefresh);
  expect(existsSync(join(leaseProfile(w, account.id), '.credentials.json'))).toBe(false);
  const file = await rulesFile(w);
  expect(file?.rules.some((r) => r.id.startsWith('session-')) ?? false).toBe(false);
  expect(file?.schemaVersion ?? 2).toBe(2);
  expect((await w.engine.listAccounts()).map((a) => a.label)).toEqual(['A', 'W', 'V']);
  const snapshot = await w.engine.readSnapshot();
  expect(snapshot?.groups.some((g) => g.kind === 'lease') ?? false).toBe(false);
}

/** Run one `cctl` command in-process from `cwd`, with stdout and stderr captured. */
async function runCli(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
    return { out: out.join(''), err: err.join(''), exited: false };
  } catch (e) {
    if (e instanceof CliFailure) {
      reportFatal(e);
      process.exitCode = undefined;
      return { out: out.join(''), err: err.join(''), exited: true };
    }
    throw e;
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    cwdSpy.mockRestore();
    process.exitCode = undefined;
  }
}

/** Put the fake on PATH for `cctl claude`, as a session that rotates and then exits by itself. */
function fakeOnPath(w: World, exitAfterMs: number): void {
  vi.stubEnv('PATH', `${w.rig.bin}${delimiter}${process.env.PATH ?? ''}`);
  for (const [k, v] of Object.entries(w.rig.env)) {
    if (k.startsWith('FAKE_') && v !== undefined) vi.stubEnv(k, v);
  }
  vi.stubEnv('FAKE_SESSION', '1');
  vi.stubEnv('FAKE_ROTATE_AFTER_MS', '60');
  vi.stubEnv('FAKE_EXIT_AFTER_MS', String(exitAfterMs));
  vi.stubEnv('FAKE_RUN_DIR', w.runDir);
}

describe('a parallel session, end to end', () => {
  it(
    '1. cctl claude --account: run, rotate, exit; the rotation is adopted and everything is put back',
    { timeout: 120_000 },
    async () => {
      const w = await setup();
      fakeOnPath(w, 800);
      const r = await runCli(['claude', '--account', 'W'], w.rig.work);
      expect(r.exited).toBe(false);
      expect(r.err).toContain('cctl: Claude Code on W (parallel session, this terminal only)');
      const profile = leaseProfile(w, w.W.id);
      const names = (await readdir(w.runDir)).filter((n) => /^\d+\.json$/.test(n));
      expect(names).toHaveLength(1);
      const last = await fakeRecord(w, Number(names[0]!.slice(0, -5)));
      expect(last.cfg.toLowerCase()).toBe(profile.toLowerCase());
      expect(last.seen.length).toBeGreaterThan(1);
      await expectEnded(w, w.W, last.seen.at(-1)!);
      // The global slot never moved.
      expect((await new CredentialStore(w.paths).readLiveCredentials())?.accessToken).toBe('a-A');
    },
  );

  it(
    '2. two terminals on one account share one session; the last one out adopts and frees it',
    { timeout: 180_000 },
    async () => {
      const w = await setup();
      const one = await startLauncher(w);
      await w.engine.claimSessionSlot(w.W.id, one.holder, { launchRuleId: null });
      const profile = leaseProfile(w, w.W.id);
      const fake1 = await startFake(w, profile);
      const kid1 = childHolder(fake1.pid!, one.proc.pid!);
      await w.engine.addLeaseHolders(leaseRuleId(w.W.id), [kid1]);
      const two = await startLauncher(w);
      const joined = await w.engine.claimSessionSlot(w.W.id, two.holder, { launchRuleId: null });
      expect(joined).toMatchObject({ kind: 'lease', joined: true, otherTerminals: 1 });
      const fake2 = await startFake(w, profile);
      const kid2 = childHolder(fake2.pid!, two.proc.pid!);
      await w.engine.addLeaseHolders(leaseRuleId(w.W.id), [kid2]);
      const rules = (await w.engine.listRules()).filter((r) => r.lease !== undefined);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.lease!.holders).toHaveLength(4);

      await stopFake(w, fake1);
      const first = await w.engine.releaseLease(leaseRuleId(w.W.id), [one.holder, kid1], w.probe);
      expect(first).toMatchObject({ ended: false, remaining: 2 });
      // The second session still holds a working login.
      const before = (await fakeRecord(w, fake2.pid!)).seen.length;
      await until(async () => (await fakeRecord(w, fake2.pid!)).seen.length > before + 1);
      expect(existsSync(join(profile, '.credentials.json'))).toBe(true);

      await stopFake(w, fake2);
      const last = await w.engine.releaseLease(leaseRuleId(w.W.id), [two.holder, kid2], w.probe);
      expect(last).toMatchObject({ ended: true, adoptedRotation: true });
      // The second session rotated last: its last token is the login the vault keeps.
      await expectEnded(w, w.W, (await fakeRecord(w, fake2.pid!)).seen.at(-1)!);
    },
  );

  it(
    '3. two accounts at once: two profiles, each rotation adopted into its own account',
    { timeout: 180_000 },
    async () => {
      const w = await setup();
      const lw = await startLauncher(w);
      const lv = await startLauncher(w);
      await w.engine.claimSessionSlot(w.W.id, lw.holder, { launchRuleId: null });
      await w.engine.claimSessionSlot(w.V.id, lv.holder, { launchRuleId: null });
      const fw = await startFake(w, leaseProfile(w, w.W.id));
      const fv = await startFake(w, leaseProfile(w, w.V.id));
      await stopFake(w, fw);
      await stopFake(w, fv);
      await w.engine.releaseLease(leaseRuleId(w.W.id), [lw.holder], w.probe);
      await w.engine.releaseLease(leaseRuleId(w.V.id), [lv.holder], w.probe);
      const lastW = (await fakeRecord(w, fw.pid!)).seen.at(-1)!;
      const lastV = (await fakeRecord(w, fv.pid!)).seen.at(-1)!;
      expect(lastW.startsWith('r-W~r')).toBe(true);
      expect(lastV.startsWith('r-V~r')).toBe(true);
      expect(await storedRefresh(w, w.W.id)).toBe(lastW);
      expect(await storedRefresh(w, w.V.id)).toBe(lastV);
      expect(await rulesFile(w)).toMatchObject({ schemaVersion: 2, rules: [] });
    },
  );

  it(
    '4. a hard kill of the launcher and its Claude Code: one full sweep adopts and frees the account',
    { timeout: 180_000 },
    async () => {
      const w = await setup();
      const l = await startLauncher(w);
      await w.engine.claimSessionSlot(w.W.id, l.holder, { launchRuleId: null });
      const fake = await startFake(w, leaseProfile(w, w.W.id));
      await w.engine.addLeaseHolders(leaseRuleId(w.W.id), [childHolder(fake.pid!, l.proc.pid!)]);
      l.proc.kill('SIGKILL');
      fake.kill('SIGKILL');
      await until(() => !running(l.proc.pid!) && !running(fake.pid!));
      // A kill can land between the fake's rotation and its record of it, so the login the session
      // left is the one on its profile, not the last one it recorded.
      const left = JSON.parse(
        await readFile(join(leaseProfile(w, w.W.id), '.credentials.json'), 'utf8'),
      ) as { claudeAiOauth: { refreshToken: string } };
      const report = await w.engine.sweepLeases({ mode: 'full', probe: w.probe });
      expect(report.ended.map((e) => e.accountId)).toEqual([w.W.id]);
      await expectEnded(w, w.W, left.claudeAiOauth.refreshToken);
    },
  );

  it(
    '5. only the launcher killed: the session stays while Claude Code runs, and ends after it exits',
    { timeout: 180_000 },
    async () => {
      const w = await setup();
      const l = await startLauncher(w);
      await w.engine.claimSessionSlot(w.W.id, l.holder, { launchRuleId: null });
      const fake = await startFake(w, leaseProfile(w, w.W.id));
      await w.engine.addLeaseHolders(leaseRuleId(w.W.id), [childHolder(fake.pid!, l.proc.pid!)]);
      l.proc.kill('SIGKILL');
      await until(() => !running(l.proc.pid!));
      const kept = await w.engine.sweepLeases({ mode: 'full', probe: w.probe });
      expect(kept.ended).toEqual([]);
      expect((await w.engine.leaseOf(w.W.id))?.holders.map((h) => h.pid)).toEqual([fake.pid]);
      await stopFake(w, fake);
      const freed = await w.engine.sweepLeases({ mode: 'full', probe: w.probe });
      expect(freed.ended.map((e) => e.accountId)).toEqual([w.W.id]);
      await expectEnded(w, w.W, (await fakeRecord(w, fake.pid!)).seen.at(-1)!);
    },
  );

  it(
    '6. the launcher killed before its Claude Code was recorded: a quick check finds it before it ends anything',
    { timeout: 180_000 },
    async () => {
      const w = await setup();
      const profile = leaseProfile(w, w.W.id);
      // The slot must exist before the launcher's child starts on it: claim with a stand-in holder
      // first, then hand the session to the real launcher.
      const placeholder = await startLauncher(w);
      await w.engine.claimSessionSlot(w.W.id, placeholder.holder, { launchRuleId: null });
      const l = await startLauncher(w, { configDir: profile });
      await w.engine.claimSessionSlot(w.W.id, l.holder, { launchRuleId: null });
      await w.engine.releaseLease(leaseRuleId(w.W.id), [placeholder.holder], w.probe);
      l.proc.kill('SIGKILL');
      await until(() => !running(l.proc.pid!));
      // Every recorded holder is gone, so even a quick check looks for what still runs on the
      // profile (the process table on Windows, /proc on Linux) before it would end the session.
      const quick = await w.engine.sweepLeases({ mode: 'quick', probe: w.probe });
      expect(quick.adopted.map((a) => a.pid)).toEqual([l.childPid]);
      expect(quick.ended).toEqual([]);
      await writeFile(join(w.runDir, `${l.childPid!}.exit`), '');
      await until(() => !running(l.childPid!));
      const freed = await w.engine.sweepLeases({ mode: 'full', probe: w.probe });
      expect(freed.ended.map((e) => e.accountId)).toEqual([w.W.id]);
      await expectEnded(w, w.W, (await fakeRecord(w, l.childPid!)).seen.at(-1)!);
    },
  );

  it(
    '7. pid reuse: a live pid with another start is judged dead; a launch on a recorded pid replaces it',
    { timeout: 120_000 },
    async () => {
      const w = await setup();
      const other = await startLauncher(w);
      // The record of a process that had this pid an hour before the one running now.
      const stale: LeaseHolder = {
        ...other.holder,
        start: process.platform === 'win32' ? other.holder.start - HOUR : other.holder.start + 1,
      };
      await w.engine.claimSessionSlot(w.W.id, stale, { launchRuleId: null });
      const swept = await w.engine.sweepLeases({ mode: 'full', probe: w.probe });
      expect(swept.ended.map((e) => e.accountId)).toEqual([w.W.id]);
      // A new launch that now owns a recorded pid replaces that record, and the file still loads.
      await w.engine.claimSessionSlot(w.W.id, stale, { launchRuleId: null });
      await w.engine.claimSessionSlot(w.W.id, other.holder, { launchRuleId: null });
      const holders = (await w.engine.listRules()).find((r) => r.lease !== undefined)?.lease
        ?.holders;
      expect(holders).toEqual([other.holder]);
    },
  );

  it(
    '8. cctl switch racing a parallel session: never live in two slots, the switch lands first or is refused',
    { timeout: 300_000 },
    async () => {
      const w = await setup();
      const self = thisLauncher();
      for (let i = 0; i < 50; i += 1) {
        const jitter = (): Promise<void> => new Promise((r) => setTimeout(r, Math.random() * 15));
        const [switched, claimed] = await Promise.all([
          jitter().then(() =>
            w.engine.activate(w.W.id, { force: true }).then(
              () => 'switched' as const,
              (err: { code?: string }) => err.code ?? 'error',
            ),
          ),
          jitter().then(() => w.engine.claimSessionSlot(w.W.id, self, { launchRuleId: null })),
        ]);
        const live = [...(await w.engine.liveSlots()).values()].filter((id) => id === w.W.id);
        expect(live.length).toBeLessThanOrEqual(1);
        if (switched === 'switched') {
          // The switch landed first: the claim then found the account live in the global slot.
          expect(claimed.kind).toBe('global');
        } else {
          // The claim landed first: the switch was refused, naming the session.
          expect(switched).toBe('leased');
          expect(claimed.kind).toBe('lease');
        }
        if (claimed.kind === 'lease') {
          await w.engine.releaseLease(claimed.ruleId, [self], w.probe);
        }
        await w.engine.activate(w.A.id, { force: true });
      }
    },
  );

  it(
    '10. the real guard lets a parallel-session profile through in a ruled folder, for a named session',
    { timeout: 120_000 },
    async () => {
      const w = await setup();
      const ruled = w.rig.work;
      const vault = new Vault(w.paths.vaultDir, new InsecurePassthroughProtector());
      await vault.createRule({ folders: [ruled], exclude: [w.A.id] });
      await vault.createRule({
        folders: [],
        aliases: [{ folder: ruled, alias: 'x' }],
        exclude: [w.A.id],
      });
      await w.engine.claimSessionSlot(w.W.id, thisLauncher(), { launchRuleId: null });
      const script = bindGuardPath(w.rig.root);
      await writeBindGuard(script, folderBindingsPath(w.paths.vaultDir));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: ruled,
        CLAUDE_CONFIG_DIR: leaseProfile(w, w.W.id),
      };
      delete env.CCTL_BIND_OVERRIDE;
      delete env.CCTL_LAUNCH_EXPLICIT;
      const result = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [script], { env });
          let stdout = '';
          child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout }));
          child.stdin.end(
            JSON.stringify({
              hook_event_name: 'UserPromptSubmit',
              session_id: 's',
              session_title: 'x',
            }),
          );
        },
      );
      expect(result).toEqual({ code: 0, stdout: '' });
    },
  );

  it(
    '11. what --account refuses leaves no trace: no rule, no login in a profile, the schema as it was',
    { timeout: 180_000 },
    async () => {
      const w = await setup();
      fakeOnPath(w, 500);
      // A session running in the global slot's background service.
      const procStart = (await readProcessStarts(process.platform)([process.pid])).get(process.pid);
      await mkdir(join(w.rig.main, 'daemon'), { recursive: true });
      await writeFile(
        join(w.rig.main, 'daemon', 'roster.json'),
        JSON.stringify({
          workers: {
            [SHORT]: {
              pid: process.pid,
              ...(procStart ? { procStart } : {}),
              sessionId: SID,
              cwd: w.rig.work,
            },
          },
        }),
      );
      await writeFile(
        join(w.rig.main, 'sessions', '100001.json'),
        JSON.stringify({
          pid: process.pid,
          ...(procStart ? { procStart } : {}),
          sessionId: SID,
          kind: 'bg',
          status: 'busy',
          jobId: SHORT,
          cwd: w.rig.work,
        }),
      );
      await mkdir(join(w.rig.main, 'jobs', SHORT), { recursive: true });
      await writeFile(
        join(w.rig.main, 'jobs', SHORT, 'state.json'),
        JSON.stringify({
          state: 'running',
          sessionId: SID,
          name: 'bg',
          cwd: w.rig.work,
          respawnFlags: [],
        }),
      );
      const before = await rulesFile(w);
      for (const args of [
        ['--bg', 'go'],
        ['attach', SHORT],
        ['--resume', SID],
      ]) {
        const r = await runCli(['claude', '--account', 'W', ...args], w.rig.work);
        expect(r.exited).toBe(true);
        expect(await rulesFile(w)).toEqual(before);
        expect(existsSync(join(leaseProfile(w, w.W.id), '.credentials.json'))).toBe(false);
      }
    },
  );

  it(
    "12. billing: a parallel session's turns are billed to its account, also after the session ended",
    { timeout: 120_000 },
    async () => {
      const w = await setup();
      const me = thisLauncher();
      const claimedAt = Date.now();
      await w.engine.claimSessionSlot(w.W.id, me, { launchRuleId: null });
      const turnAt = Date.now() + 1;
      await w.engine.releaseLease(leaseRuleId(w.W.id), [me], w.probe);
      expect(await w.engine.leaseOf(w.W.id)).toBeUndefined();
      const store = new Store(':memory:');
      try {
        await new AttributionJournal({ store, vaultDir: w.paths.vaultDir }).sync();
        const attribute = buildTurnAttributor({
          intervals: store.listActivationIntervals(),
          slotSpans: [
            { sessionId: 's1', slot: ruleSlotId(leaseRuleId(w.W.id)), startedAtMs: claimedAt },
          ],
        });
        expect(attribute({ sessionId: 's1', tsMs: turnAt })).toBe(w.W.id);
        // A session on the global slot meanwhile is A's.
        expect(attribute({ sessionId: 'other', tsMs: turnAt })).toBe(w.A.id);
      } finally {
        store.close();
      }
    },
  );
});
