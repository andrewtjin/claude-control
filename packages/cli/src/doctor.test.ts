import { describe, it, expect } from 'vitest';
import { renderDoctor, summarize, checkVaultProtection, type DoctorCheck } from './doctor.js';

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
