import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderDoctor,
  summarize,
  checkVaultProtection,
  checkNodeVersion,
  healthUrlFromRelay,
  probeRelay,
  MIN_NODE_VERSION,
  type DoctorCheck,
  type ProbeFetch,
} from './doctor.js';

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
  it('reports a real protector round-trip on a supported platform', { timeout: 30_000 }, () => {
    // Runs the REAL platform protector: DPAPI here on Windows, Keychain on a Mac. Either
    // way the check must pass on any supported dev machine.
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    const result = checkVaultProtection();
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/round-trip works/);
  });

  it('names the gap on an unsupported platform instead of failing silently', () => {
    const result = checkVaultProtection('freebsd');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/freebsd/);
    expect(result.detail).toMatch(/win32 \(DPAPI\), darwin \(Keychain\)/);
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
