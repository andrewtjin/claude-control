import { describe, it, expect } from 'vitest';
import {
  FOLDER_RULES_REPORT_ROW,
  FOLDER_RULES_SUPPORTED,
  olderDaemonReason,
  reportSupportsFolderRules,
} from './folderRulesSupport.js';
import type { SettingsReport } from './settings.js';

const report = (rows: { name: string; value: string }[]): SettingsReport => ({
  startedAtMs: 1,
  settings: rows.map((r) => ({ ...r, source: 'default' as const })),
});
const supported = { name: FOLDER_RULES_REPORT_ROW, value: FOLDER_RULES_SUPPORTED };
const alive = { state: 'alive', writtenAtMs: 1, ageMs: 1 } as const;

describe('reportSupportsFolderRules', () => {
  it('reads the folder-rules row the daemon writes', () => {
    expect(reportSupportsFolderRules(report([supported]))).toBe(true);
    expect(reportSupportsFolderRules(report([{ name: 'daemon build', value: 'v0.5.2' }]))).toBe(
      false,
    );
    expect(reportSupportsFolderRules(report([{ ...supported, value: 'off' }]))).toBe(false);
    expect(reportSupportsFolderRules(undefined)).toBe(false);
  });
});

describe('olderDaemonReason', () => {
  it('names a live daemon without the row, its build and the fix', () => {
    const reason = olderDaemonReason(report([{ name: 'daemon build', value: 'v0.5.2' }]), alive);
    expect(reason).toContain('(v0.5.2)');
    expect(reason).toContain('predates folder rules');
    expect(reason).toContain('cctl daemon restart');
  });

  it('treats a live daemon with no readable report as older', () => {
    expect(olderDaemonReason(undefined, alive)).toContain('predates folder rules');
  });

  it('has nothing to say about a daemon that honors rules, or one not running', () => {
    expect(olderDaemonReason(report([supported]), alive)).toBeUndefined();
    expect(olderDaemonReason(report([]), { state: 'never' })).toBeUndefined();
    expect(
      olderDaemonReason(report([]), { state: 'stale', writtenAtMs: 1, ageMs: 10_000_000 }),
    ).toBeUndefined();
    expect(
      olderDaemonReason(report([]), {
        state: 'stopped',
        writtenAtMs: 1,
        stoppedAtMs: 2,
        ageMs: 1,
      }),
    ).toBeUndefined();
  });
});
