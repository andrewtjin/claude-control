import { describe, it, expect } from 'vitest';
import { renderDoctor, summarize, checkDpapi, type DoctorCheck } from './doctor.js';

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

describe('checkDpapi', () => {
  it('reports a real DPAPI round-trip on Windows, or unavailability elsewhere', () => {
    const result = checkDpapi();
    if (process.platform === 'win32') {
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/round-trip/);
    } else {
      expect(result.ok).toBe(false);
    }
  });
});
