import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderDoctor,
  summarize,
  checkVaultProtection,
  checkNodeVersion,
  checkSessionRuntime,
  checkSlots,
  checkGuardSnapshot,
  checkGuardHook,
  checkVersionSkew,
  checkPowerShellWrapper,
  powerShellProfilePaths,
  healthUrlFromRelay,
  probeRelay,
  checkLiveLogin,
  MIN_NODE_VERSION,
  type DoctorCheck,
  type ProbeFetch,
} from './doctor.js';
import { renderShellInit } from './shellInit.js';
import { sandboxPaths, type LiveCredentialChannel } from '@claude-control/switch-engine';

// This file lives at packages/cli/src/, so two levels up is packages/, where the publishable
// bundle lives at cctl-publish/package.json (see dependencyClosure.test.ts for the same idiom).
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const checks: DoctorCheck[] = [
  { name: 'dpapi', ok: true, detail: 'works' },
  { name: 'login', ok: false, detail: 'no credentials' },
];

describe('renderDoctor', () => {
  it('renders ok/fail markers with details', () => {
    const out = renderDoctor(checks);
    expect(out).toContain('[ok] dpapi: works');
    expect(out).toContain('[!!] login: no credentials');
  });
});

describe('summarize', () => {
  it('counts passed and failed', () => {
    expect(summarize(checks)).toEqual({ passed: 1, failed: 1 });
  });
});

describe('checkVaultProtection', () => {
  // 30s: the Windows path spawns powershell.exe (~2s alone, much slower under parallel
  // suite load) — same allowance the real-DPAPI tests in dpapi.test.ts carry.
  it(
    'reports a real protector round-trip on a supported platform',
    { timeout: 30_000 },
    async () => {
      // Runs the REAL platform protector: DPAPI here on Windows, Keychain on a Mac. Either
      // way the check must pass on any supported dev machine. Gated off other platforms
      // because the default file-key path would probe the REAL key file location — the
      // file-key branch is covered below with a sandboxed path instead.
      if (process.platform !== 'win32' && process.platform !== 'darwin') return;
      const result = await checkVaultProtection();
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/round-trip works/);
    },
  );

  it('round-trips through the file-key protector on OS-secret-store-less platforms', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-doctor-'));
    try {
      const result = await checkVaultProtection('linux', join(dir, 'vault.key'));
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/file-key \(linux\) protect\/unprotect round-trip works/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('checkNodeVersion', () => {
  // The floor is the first UNFLAGGED node:sqlite (22.13.0), not the flagged introduction
  // (22.5.0) — this check exists because npm's own `engines` enforcement is advisory, so a
  // user on an old-but-flagged Node can still get this far and needs an actionable message.
  it('is the unflagged-node:sqlite floor', () => {
    expect(MIN_NODE_VERSION).toBe('22.13.0');
  });

  // The publishable package's own `engines.node` must not advertise a floor doctor itself
  // knows is broken (node:sqlite still flagged) — npm's engine check is advisory by default,
  // so a stale floor there would let exactly the crashing versions install.
  it('publishable package.json declares a floor at least as high as this check', () => {
    const publishedManifest = JSON.parse(
      readFileSync(join(PACKAGES_DIR, 'cctl-publish', 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    const declaredFloor = publishedManifest.engines?.node?.replace(/^>=\s*/, '');
    expect(declaredFloor).toBeDefined();
    expect(checkNodeVersion(declaredFloor, MIN_NODE_VERSION).ok).toBe(true);
  });

  it('passes for versions at or above the floor', () => {
    expect(checkNodeVersion('v22.13.0').ok).toBe(true);
    expect(checkNodeVersion('v24.16.0').ok).toBe(true);
    expect(checkNodeVersion('v23.4.0').ok).toBe(true);
  });

  it('fails for a version that ships node:sqlite only behind the flag', () => {
    // 22.5–22.12: node:sqlite exists but needs --experimental-sqlite, which cctl cannot pass.
    const result = checkNodeVersion('v22.6.0');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('22.13.0');
    expect(result.detail).toContain('--experimental-sqlite');
  });

  it('fails an ancient version', () => {
    expect(checkNodeVersion('v20.11.0').ok).toBe(false);
  });

  it('reports an unparseable version instead of silently passing', () => {
    const result = checkNodeVersion('not-a-version');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('could not parse');
  });

  it('honors an injected floor', () => {
    expect(checkNodeVersion('v22.13.0', '23.0.0').ok).toBe(false);
    expect(checkNodeVersion('v23.0.0', '23.0.0').ok).toBe(true);
  });
});

describe('checkSessionRuntime', () => {
  const MANIFEST = JSON.stringify({ platforms: { 'win32-x64': { binary: 'claude.exe' } } });

  it('passes and names the binary a remote session would run', () => {
    const check = checkSessionRuntime({
      platform: 'win32',
      arch: 'x64',
      readManifest: () => MANIFEST,
      resolveFromSdk: () => 'C:/n_m/claude.exe',
    });
    expect(check.name).toBe('session-runtime');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('C:/n_m/claude.exe');
  });

  it('fails with the reason when the native binary is missing', () => {
    // The `--omit=optional` install: every other doctor check passes and only /run is broken,
    // which is exactly the state this check exists to make visible locally.
    const check = checkSessionRuntime({
      platform: 'win32',
      arch: 'x64',
      readManifest: () => MANIFEST,
      resolveFromSdk: () => {
        throw new Error('Cannot find module');
      },
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('/run');
    expect(check.detail).toContain('--omit=optional');
  });
});

describe('healthUrlFromRelay', () => {
  it('maps ws→http and wss→https and appends /health', () => {
    expect(healthUrlFromRelay('ws://127.0.0.1:8765')).toBe('http://127.0.0.1:8765/health');
    expect(healthUrlFromRelay('wss://relay.example.com')).toBe('https://relay.example.com/health');
  });

  it('does not double a trailing slash', () => {
    expect(healthUrlFromRelay('ws://127.0.0.1:8765/')).toBe('http://127.0.0.1:8765/health');
  });
});

describe('probeRelay', () => {
  it('reports reachable on a 200', async () => {
    const fetchFn: ProbeFetch = () => Promise.resolve({ ok: true, status: 200 });
    const result = await probeRelay('ws://127.0.0.1:8765', { fetchFn });
    expect(result.reachable).toBe(true);
    expect(result.detail).toContain('healthy');
  });

  it('reports unreachable (with the status) on a non-200', async () => {
    const fetchFn: ProbeFetch = () => Promise.resolve({ ok: false, status: 502 });
    const result = await probeRelay('ws://127.0.0.1:8765', { fetchFn });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain('502');
  });

  it('reports unreachable (with the error) when the request throws', async () => {
    const fetchFn: ProbeFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const result = await probeRelay('ws://127.0.0.1:8765', { fetchFn });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('probes the derived /health url', async () => {
    let seen = '';
    const fetchFn: ProbeFetch = (url) => {
      seen = url;
      return Promise.resolve({ ok: true, status: 200 });
    };
    await probeRelay('wss://relay.example.com', { fetchFn });
    expect(seen).toBe('https://relay.example.com/health');
  });
});

describe('checkLiveLogin (darwin)', () => {
  const paths = sandboxPaths('root');
  // Inject a fake channel so the check never touches real `security(1)`, which on a Mac could
  // raise the Keychain GUI prompt this check has no way to answer. `target` defaults to the
  // shipped default so the existing assertions read naturally, but callers can override it to
  // prove `checkLiveLogin` reports the CHANNEL's target, not a value it recomputed itself.
  const fakeChannel = (
    creds: unknown,
    target: { service: string; account: string } = {
      service: 'Claude Code-credentials',
      account: 'login-user',
    },
  ): LiveCredentialChannel => ({
    // `checkLiveLogin` only checks `!== undefined`, so test callers pass a partial credential
    // shape; cast just this return value rather than the whole object, so `target`'s shape is
    // still checked structurally against `LiveCredentialChannel`.
    readLiveCredentials: () =>
      Promise.resolve(creds) as ReturnType<LiveCredentialChannel['readLiveCredentials']>,
    writeLiveCredentials: () => Promise.resolve(),
    target,
  });

  it('names the effective Keychain service/account so a wrong item name self-diagnoses', async () => {
    const res = await checkLiveLogin(paths, 'darwin', fakeChannel(undefined));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('service="Claude Code-credentials"');
    // The hint stays attribute-only and points at the env override, never a token read.
    expect(res.detail).toMatch(/attribute-only/);
    expect(res.detail).toMatch(/CLAUDE_CLI_KEYCHAIN_SERVICE/);
  });

  it('reports found credentials against the same named target', async () => {
    const res = await checkLiveLogin(paths, 'darwin', fakeChannel({ accessToken: 'x' }));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('service="Claude Code-credentials"');
  });

  it('reports the CHANNEL target, not a value recomputed independently of it', async () => {
    // A channel configured with a non-default target (as an operator's env override would
    // produce) must show up verbatim in `detail`. If `checkLiveLogin` ever went back to
    // recomputing the target itself instead of reading `channel.target`, this target would
    // never appear and the assertion below would fail.
    const custom = { service: 'Custom-Item', account: 'alt-user' };
    const res = await checkLiveLogin(paths, 'darwin', fakeChannel(undefined, custom));
    expect(res.detail).toContain('service="Custom-Item"');
    expect(res.detail).toContain('account="alt-user"');
    expect(res.detail).not.toContain('Claude Code-credentials');
  });
});

describe('checkSlots', () => {
  it('passes when there are no violations', async () => {
    const check = await checkSlots({ checkSlots: () => Promise.resolve([]) });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('no slot invariant');
  });

  it('fails and names each violation', async () => {
    const check = await checkSlots({
      checkSlots: () =>
        Promise.resolve([
          { kind: 'reserved_live_in_global', detail: 'work@me.com is live in global' },
        ]),
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('reserved_live_in_global');
    expect(check.detail).toContain('work@me.com');
  });

  it('fails cleanly when the check throws', async () => {
    const check = await checkSlots({
      checkSlots: () => Promise.reject(new Error('lock busy')),
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('lock busy');
  });
});

describe('checkGuardSnapshot', () => {
  const baseGroups = [{ id: 'g1' }];

  it('passes when there are no bindings and no snapshot', async () => {
    const check = await checkGuardSnapshot({
      readSnapshot: () => Promise.resolve(undefined),
      getGroupsGeneration: () => Promise.resolve(0),
      listGroups: () => Promise.resolve([]),
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('nothing to enforce');
  });

  it('fails when bindings exist but the snapshot is missing', async () => {
    const check = await checkGuardSnapshot({
      readSnapshot: () => Promise.resolve(undefined),
      getGroupsGeneration: () => Promise.resolve(3),
      listGroups: () => Promise.resolve(baseGroups as never),
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('no guard snapshot');
  });

  it('passes when the snapshot generation matches', async () => {
    const check = await checkGuardSnapshot({
      readSnapshot: () => Promise.resolve({ generation: 4, enforce: 'block' } as never),
      getGroupsGeneration: () => Promise.resolve(4),
      listGroups: () => Promise.resolve(baseGroups as never),
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('fresh');
  });

  it('fails when the snapshot lags the groups generation', async () => {
    const check = await checkGuardSnapshot({
      readSnapshot: () => Promise.resolve({ generation: 2, enforce: 'warn' } as never),
      getGroupsGeneration: () => Promise.resolve(6),
      listGroups: () => Promise.resolve(baseGroups as never),
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('STALE');
  });
});

describe('checkGuardHook', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-guardhook-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes when the guard command is present in settings.json', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const claudeDir = join(dir, 'claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: '"node" "x\bind-guard.cjs"' }] },
          ],
        },
      }),
    );
    const check = checkGuardHook(sandboxPaths(dir), true);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('installed');
  });

  it('fails when bindings exist but the guard is not installed', () => {
    const check = checkGuardHook(sandboxPaths(dir), true);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('NOT enforced');
  });

  it('passes (optional) when there are no bindings and no guard', () => {
    const check = checkGuardHook(sandboxPaths(dir), false);
    expect(check.ok).toBe(true);
  });
});

describe('checkVersionSkew', () => {
  it('passes when no daemon is running', () => {
    expect(checkVersionSkew('1.0.0', undefined, false).ok).toBe(true);
    expect(checkVersionSkew('1.0.0', '0.9.0', false).ok).toBe(true);
  });

  it('passes when the builds match', () => {
    const check = checkVersionSkew('1.0.0', '1.0.0', true);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('both 1.0.0');
  });

  it('fails on a live-daemon build mismatch with a restart hint', () => {
    const check = checkVersionSkew('1.0.0', '0.9.0', true);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('0.9.0');
    expect(check.detail).toContain('cctl daemon restart');
  });
});

describe('powerShellProfilePaths', () => {
  it('returns nothing without a USERPROFILE', () => {
    expect(powerShellProfilePaths({})).toEqual([]);
    expect(powerShellProfilePaths({ USERPROFILE: '' })).toEqual([]);
  });

  it('covers both PowerShell editions under the home Documents folder', () => {
    const paths = powerShellProfilePaths({ USERPROFILE: 'C:\\Users\\me' });
    // Windows PowerShell 5.1 (WindowsPowerShell) and PowerShell 7 (PowerShell) both.
    expect(paths.some((p) => p.includes('WindowsPowerShell'))).toBe(true);
    expect(
      paths.some((p) => p.includes(join('PowerShell', 'Microsoft.PowerShell_profile.ps1'))),
    ).toBe(true);
    expect(paths.every((p) => p.startsWith(join('C:\\Users\\me', 'Documents')))).toBe(true);
  });

  it('also covers a OneDrive-redirected Documents folder', () => {
    const paths = powerShellProfilePaths({
      USERPROFILE: 'C:\\Users\\me',
      OneDrive: 'C:\\Users\\me\\OneDrive',
    });
    expect(paths.some((p) => p.startsWith(join('C:\\Users\\me\\OneDrive', 'Documents')))).toBe(
      true,
    );
  });
});

describe('checkPowerShellWrapper', () => {
  it('passes when no profile carries a wrapper', () => {
    expect(checkPowerShellWrapper(undefined).ok).toBe(true);
    expect(checkPowerShellWrapper('function foo { echo hi }\n').ok).toBe(true);
  });

  it('passes on the shim form (no embedded paths to go stale)', () => {
    const check = checkPowerShellWrapper(renderShellInit('powershell'));
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('shim');
  });

  it('passes when the node-direct wrapper points at existing paths', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const entry = 'C:\\npm\\cctl\\dist\\bin.js';
    const text = renderShellInit('powershell', { nodePath: node, cctlEntry: entry });
    const check = checkPowerShellWrapper(text, (p) => p === node || p === entry);
    expect(check.ok).toBe(true);
  });

  it('fails when the embedded node path no longer exists, naming it and the fix', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const entry = 'C:\\npm\\cctl\\dist\\bin.js';
    const text = renderShellInit('powershell', { nodePath: node, cctlEntry: entry });
    // Simulate a node move/upgrade: the entry still exists, the node binary does not.
    const check = checkPowerShellWrapper(text, (p) => p === entry);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(node);
    expect(check.detail).toContain('cctl shell-init powershell');
  });

  it('fails when the embedded cctl entry no longer exists (reinstall/relocate)', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const entry = 'C:\\npm\\cctl\\dist\\bin.js';
    const text = renderShellInit('powershell', { nodePath: node, cctlEntry: entry });
    const check = checkPowerShellWrapper(text, (p) => p === node);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(entry);
  });
});
