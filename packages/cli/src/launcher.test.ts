// Tests for the `cctl claude` launcher core.
//
// The spawn tests use a FAKE claude: a tiny script run by the real node binary that prints its argv
// and a few selected env vars as JSON, then exits with a code it is told. That proves the launcher
// passes arguments through verbatim with NO shell (spaces, quotes, unicode, and the cmd/pwsh
// metacharacters & | ^ all survive), applies the env rules, and propagates the child's exit code —
// on the same spawn path production uses. The resolution helpers are tested purely (no spawn).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bannerContextForLaunch,
  buildLaunchEnv,
  configDirPointsIntoProfiles,
  findClaudeOnPath,
  resolveLaunchTarget,
  spawnClaude,
  unwrapNpmCmdShim,
  type LaunchSlot,
} from './launcher.js';

// A fake claude: prints argv + selected env as JSON, exits with FAKE_EXIT (default 0).
const FAKE_CLAUDE = `
const picked = {};
for (const k of ['CLAUDE_CONFIG_DIR', 'CCTL_LAUNCH_EXPLICIT', 'CCTL_BIND_OVERRIDE']) {
  if (k in process.env) picked[k] = process.env[k];
}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: picked }));
process.exit(process.env.FAKE_EXIT ? Number(process.env.FAKE_EXIT) : 0);
`;

interface FakeOutput {
  argv: string[];
  env: Record<string, string>;
}

describe('resolveLaunchTarget', () => {
  it('runs a .exe directly with no prefix args', () => {
    const t = resolveLaunchTarget('C:\\bin\\claude.exe', { platform: 'win32' });
    expect(t).toEqual({ kind: 'run', command: 'C:\\bin\\claude.exe', prefixArgs: [] });
  });

  it('unwraps a .cmd npm shim to node <entry.js>', () => {
    const shim =
      '@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
    const t = resolveLaunchTarget('C:\\npm\\claude.cmd', {
      platform: 'win32',
      readFileSync: () => shim,
      nodePath: 'C:\\node\\node.exe',
    });
    expect(t).toEqual({
      kind: 'run',
      command: 'C:\\node\\node.exe',
      prefixArgs: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
    });
  });

  it('refuses a .bat shim', () => {
    const t = resolveLaunchTarget('C:\\bin\\claude.bat', { platform: 'win32' });
    expect(t.kind).toBe('refused');
    if (t.kind === 'refused') expect(t.reason).toContain('.bat');
  });

  it('refuses a .ps1 shim', () => {
    const t = resolveLaunchTarget('C:\\bin\\claude.ps1', { platform: 'win32' });
    expect(t.kind).toBe('refused');
  });

  it('refuses a .cmd whose shim shape is unrecognized', () => {
    const t = resolveLaunchTarget('C:\\bin\\claude.cmd', {
      platform: 'win32',
      readFileSync: () => '@echo nothing useful here\r\n',
    });
    expect(t.kind).toBe('refused');
    if (t.kind === 'refused') expect(t.reason).toContain('could not unwrap');
  });

  it('runs any candidate directly on POSIX (shebang scripts and symlinks run under spawn)', () => {
    const t = resolveLaunchTarget('/usr/local/bin/claude', { platform: 'linux' });
    expect(t).toEqual({ kind: 'run', command: '/usr/local/bin/claude', prefixArgs: [] });
  });
});

describe('unwrapNpmCmdShim', () => {
  it('resolves a %dp0%-relative cli.js against the shim directory', () => {
    const entry = unwrapNpmCmdShim(
      'C:\\Users\\me\\AppData\\npm\\claude.cmd',
      '"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    );
    expect(entry).toBe(
      'C:\\Users\\me\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    );
  });

  it('handles a %~dp0 spelling and an .mjs entry', () => {
    const entry = unwrapNpmCmdShim('C:\\n\\claude.cmd', '"%~dp0\\dist\\cli.mjs" %*');
    expect(entry).toBe('C:\\n\\dist\\cli.mjs');
  });

  it('accepts an absolute quoted .js path', () => {
    const entry = unwrapNpmCmdShim('C:\\n\\claude.cmd', 'node "C:\\pkg\\claude\\cli.js" %*');
    expect(entry).toBe('C:\\pkg\\claude\\cli.js');
  });

  it('returns undefined for an unrecognized shim', () => {
    expect(unwrapNpmCmdShim('C:\\n\\claude.cmd', 'echo hi')).toBeUndefined();
  });
});

describe('findClaudeOnPath', () => {
  it('prefers claude.exe over claude.cmd within the SAME PATH dir (Windows)', () => {
    const present = new Set(['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe']);
    const found = findClaudeOnPath({
      platform: 'win32',
      pathEnv: 'C:\\bin',
      pathExt: '.EXE;.CMD',
      existsSync: (p) => present.has(p),
    });
    expect(found).toBe('C:\\bin\\claude.exe');
  });

  it('an earlier PATH dir wins over a later one regardless of extension (Windows) — matches how the shell resolves bare `claude`, so cctl launches the same binary', () => {
    // A claude.cmd in the FIRST PATH dir must beat a claude.exe in a later dir: the extension
    // preference is within a directory, not across directories.
    const present = new Set(['C:\\npm\\claude.cmd', 'C:\\bin\\claude.exe']);
    const found = findClaudeOnPath({
      platform: 'win32',
      pathEnv: 'C:\\npm;C:\\bin',
      pathExt: '.EXE;.CMD',
      existsSync: (p) => present.has(p),
    });
    expect(found).toBe('C:\\npm\\claude.cmd');
  });

  it('falls back to claude.cmd when no exe exists (Windows)', () => {
    const present = new Set(['C:\\npm\\claude.cmd']);
    const found = findClaudeOnPath({
      platform: 'win32',
      pathEnv: 'C:\\npm',
      pathExt: '.EXE;.CMD',
      existsSync: (p) => present.has(p),
    });
    expect(found).toBe('C:\\npm\\claude.cmd');
  });

  it('finds a bare executable on POSIX', () => {
    const present = new Set(['/usr/local/bin/claude']);
    const found = findClaudeOnPath({
      platform: 'linux',
      pathEnv: '/usr/bin:/usr/local/bin',
      existsSync: (p) => present.has(p),
    });
    expect(found).toBe('/usr/local/bin/claude');
  });

  it('returns undefined when nothing matches', () => {
    expect(
      findClaudeOnPath({ platform: 'linux', pathEnv: '/usr/bin', existsSync: () => false }),
    ).toBeUndefined();
  });
});

describe('buildLaunchEnv', () => {
  const groupSlot: LaunchSlot = {
    kind: 'group',
    profileDir: 'C:\\profiles\\g1',
    label: 'work',
    context: 'binding',
  };

  const EXPLICIT_TOKEN = '0123456789abcdef0123456789abcdef';
  const OVERRIDE_TOKEN = 'fedcba9876543210fedcba9876543210';

  it('group slot pins CLAUDE_CONFIG_DIR and carries the --account/--override tokens', () => {
    const env = buildLaunchEnv({
      baseEnv: { PATH: 'x' },
      slot: groupSlot,
      explicitToken: EXPLICIT_TOKEN,
      overrideToken: OVERRIDE_TOKEN,
      dropInheritedConfigDir: false,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:\\profiles\\g1');
    // The knobs carry the per-launch token, not a bare "1" the guard could not distinguish from
    // an inherited value.
    expect(env.CCTL_LAUNCH_EXPLICIT).toBe(EXPLICIT_TOKEN);
    expect(env.CCTL_BIND_OVERRIDE).toBe(OVERRIDE_TOKEN);
    expect(env.PATH).toBe('x');
  });

  it('group slot without --account does not set CCTL_LAUNCH_EXPLICIT', () => {
    const env = buildLaunchEnv({
      baseEnv: {},
      slot: groupSlot,
      dropInheritedConfigDir: false,
    });
    expect(env.CCTL_LAUNCH_EXPLICIT).toBeUndefined();
    expect(env.CCTL_BIND_OVERRIDE).toBeUndefined();
  });

  it('clears any inherited guard knobs so they never leak into a launch', () => {
    const env = buildLaunchEnv({
      baseEnv: { CCTL_LAUNCH_EXPLICIT: '1', CCTL_BIND_OVERRIDE: '1', CCTL_BIND_ENFORCE: 'off' },
      slot: { kind: 'global', label: 'main', context: 'global' },
      dropInheritedConfigDir: false,
    });
    expect(env.CCTL_LAUNCH_EXPLICIT).toBeUndefined();
    expect(env.CCTL_BIND_OVERRIDE).toBeUndefined();
    // A stale enforcement mode must not travel past the launch either.
    expect(env.CCTL_BIND_ENFORCE).toBeUndefined();
  });

  it('global slot drops an inherited CLAUDE_CONFIG_DIR only when told to', () => {
    const dropped = buildLaunchEnv({
      baseEnv: { CLAUDE_CONFIG_DIR: 'C:\\profiles\\g1' },
      slot: { kind: 'global', label: 'main', context: 'global' },
      dropInheritedConfigDir: true,
    });
    expect(dropped.CLAUDE_CONFIG_DIR).toBeUndefined();

    const kept = buildLaunchEnv({
      baseEnv: { CLAUDE_CONFIG_DIR: 'C:\\some\\other' },
      slot: { kind: 'global', label: 'main', context: 'global' },
      dropInheritedConfigDir: false,
    });
    expect(kept.CLAUDE_CONFIG_DIR).toBe('C:\\some\\other');
  });
});

describe('configDirPointsIntoProfiles', () => {
  const deps = { platform: process.platform, cwd: process.cwd(), realpath: (p: string) => p };

  it('is true for a dir inside the profiles root and false outside', () => {
    const sep = process.platform === 'win32' ? '\\' : '/';
    const root = process.platform === 'win32' ? 'C:\\data\\profiles' : '/data/profiles';
    expect(configDirPointsIntoProfiles(`${root}${sep}g1`, root, deps)).toBe(true);
    const outside = process.platform === 'win32' ? 'C:\\data\\other' : '/data/other';
    expect(configDirPointsIntoProfiles(outside, root, deps)).toBe(false);
  });

  it('is false for an unset config dir', () => {
    const root = process.platform === 'win32' ? 'C:\\data\\profiles' : '/data/profiles';
    expect(configDirPointsIntoProfiles(undefined, root, deps)).toBe(false);
  });
});

describe('bannerContextForLaunch', () => {
  const globalSlot: LaunchSlot = { kind: 'global', label: 'acct@example', context: 'global' };
  const groupSlot: LaunchSlot = {
    kind: 'group',
    label: 'work',
    context: 'C:\\repo binding',
    profileDir: 'C:\\data\\profiles\\g1',
  };

  it('names an inherited CLAUDE_CONFIG_DIR that survives a global launch (not dropped)', () => {
    // A non-profile inherited dir is NOT dropped, so the child runs on it — the banner must say so
    // instead of claiming the global slot.
    const ctx = bannerContextForLaunch(globalSlot, 'C:\\custom\\store', false);
    expect(ctx).toContain('C:\\custom\\store');
    expect(ctx).toContain('not the global slot');
  });

  it('leaves the context unchanged when the inherited dir is being dropped', () => {
    expect(bannerContextForLaunch(globalSlot, 'C:\\data\\profiles\\g1', true)).toBe('global');
  });

  it('leaves the context unchanged when no CLAUDE_CONFIG_DIR is inherited', () => {
    expect(bannerContextForLaunch(globalSlot, undefined, false)).toBe('global');
    expect(bannerContextForLaunch(globalSlot, '', false)).toBe('global');
  });

  it('never touches a group slot (it pins its own CLAUDE_CONFIG_DIR)', () => {
    expect(bannerContextForLaunch(groupSlot, 'C:\\custom\\store', false)).toBe('C:\\repo binding');
  });
});

describe('spawnClaude (real spawn via a fake claude)', () => {
  let dir: string;
  let fakeScript: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-launch-'));
    fakeScript = join(dir, 'fake-cli.js');
    await writeFile(fakeScript, FAKE_CLAUDE, 'utf8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Run the fake claude (node + script) capturing its printed JSON. Uses a pipe stdio so the test
   *  can read stdout; production inherits stdio, but the argv/env/exit-code path is identical. */
  function runFake(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; out: FakeOutput }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fakeScript, ...args], { env, shell: false });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({ code: code ?? -1, out: JSON.parse(stdout) as FakeOutput }),
      );
    });
  }

  it('passes arguments through verbatim with no shell (spaces, quotes, unicode, & | ^)', async () => {
    const args = [
      '--model',
      'a b c',
      'quote"inside',
      'amp&pipe|caret^',
      'café 研究',
      '--flag=with space',
    ];
    const { out } = await runFake(args, { ...process.env });
    expect(out.argv).toEqual(args);
  });

  it('applies the group env (CLAUDE_CONFIG_DIR + explicit token) to the child', async () => {
    const token = 'abcabcabcabcabcabcabcabcabcabcab';
    const env = buildLaunchEnv({
      baseEnv: { ...process.env },
      slot: { kind: 'group', profileDir: 'C:\\profiles\\g1', label: 'work', context: 'binding' },
      explicitToken: token,
      dropInheritedConfigDir: false,
    });
    const { out } = await runFake([], env);
    expect(out.env.CLAUDE_CONFIG_DIR).toBe('C:\\profiles\\g1');
    expect(out.env.CCTL_LAUNCH_EXPLICIT).toBe(token);
    expect(out.env.CCTL_BIND_OVERRIDE).toBeUndefined();
  });

  it('propagates the child exit code', async () => {
    const code = await spawnClaude({
      command: process.execPath,
      args: [fakeScript],
      env: { ...process.env, FAKE_EXIT: '7' },
    });
    expect(code).toBe(7);
  });

  it('unwraps and runs a synthetic .cmd shim end to end', async () => {
    // A real npm-style shim pointing at the fake cli.js next to it.
    const cmdPath = join(dir, 'claude.cmd');
    await writeFile(cmdPath, `"%_prog%" "%dp0%\\fake-cli.js" %*\r\n`, 'utf8');
    const target = resolveLaunchTarget(cmdPath, { platform: 'win32', nodePath: process.execPath });
    expect(target).toEqual({ kind: 'run', command: process.execPath, prefixArgs: [fakeScript] });
    if (target.kind !== 'run') throw new Error('unreachable');
    const captured = await new Promise<FakeOutput>((resolve, reject) => {
      const child = spawn(target.command, [...target.prefixArgs, 'hello', 'x y'], {
        env: { ...process.env },
        shell: false,
      });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(stdout) as FakeOutput));
    });
    expect(captured.argv).toEqual(['hello', 'x y']);
  });
});

describe('spawnClaude signal shielding', () => {
  it('installs no-op SIGINT/SIGBREAK handlers while the child runs and removes them on close', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
    const fakeSpawn = vi.fn(() => fakeChild) as unknown as typeof spawn;
    const on = vi.fn();
    const off = vi.fn();
    const signals = { on, off };

    const promise = spawnClaude({
      command: 'x',
      args: [],
      env: {},
      deps: { spawn: fakeSpawn, signals, platform: 'win32' },
    });

    // Handlers installed before the child closes.
    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGBREAK', expect.any(Function));
    expect(off).not.toHaveBeenCalled();

    fakeChild.emit('close', 0, null);
    await expect(promise).resolves.toBe(0);
    // Removed on close, and the SAME handler references.
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(off).toHaveBeenCalledWith('SIGBREAK', expect.any(Function));
  });

  it('maps a signal-kill (no numeric code) to 128 + signal number', async () => {
    const fakeChild = new EventEmitter();
    const fakeSpawn = vi.fn(() => fakeChild) as unknown as typeof spawn;
    const promise = spawnClaude({
      command: 'x',
      args: [],
      env: {},
      deps: { spawn: fakeSpawn, signals: { on: () => {}, off: () => {} }, platform: 'linux' },
    });
    fakeChild.emit('close', null, 'SIGINT');
    await expect(promise).resolves.toBe(130);
  });
});
