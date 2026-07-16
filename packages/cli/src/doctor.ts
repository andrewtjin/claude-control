// `cctl doctor` — environment sanity checks.
//
// The check RUNNERS do IO (filesystem, DPAPI, PATH); the RENDERER and the pass/fail
// summary are pure so their output is unit-tested. Each check reports a human detail so a
// failure is actionable, never a bare boolean.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DpapiProtector, type Paths } from '@claude-control/switch-engine';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Render checks as `[ok]/[!!]` lines. Pure. */
export function renderDoctor(checks: DoctorCheck[]): string {
  return checks.map((c) => `${c.ok ? '[ok]' : '[!!]'} ${c.name}: ${c.detail}`).join('\n');
}

/** Count outcomes. Pure. */
export function summarize(checks: DoctorCheck[]): { passed: number; failed: number } {
  const failed = checks.filter((c) => !c.ok).length;
  return { passed: checks.length - failed, failed };
}

/** DPAPI availability, verified by a real protect/unprotect round-trip (Windows only). */
export function checkDpapi(): DoctorCheck {
  if (process.platform !== 'win32') {
    return { name: 'dpapi', ok: false, detail: 'not on Windows (vault encryption unavailable)' };
  }
  try {
    const p = new DpapiProtector();
    const probe = Buffer.from('cctl-doctor-probe');
    const ok = p.unprotect(p.protect(probe)).equals(probe);
    return {
      name: 'dpapi',
      ok,
      detail: ok ? 'protect/unprotect round-trip works' : 'round-trip mismatch',
    };
  } catch (err) {
    return { name: 'dpapi', ok: false, detail: `DPAPI error: ${(err as Error).message}` };
  }
}

/** The vault directory is present or creatable. */
export function checkVault(paths: Paths): DoctorCheck {
  const ok = existsSync(paths.vaultDir);
  return {
    name: 'vault',
    ok: true, // absence is fine (first run); report it, don't fail
    detail: ok ? paths.vaultDir : `${paths.vaultDir} (will be created on first account add)`,
  };
}

/** Whether someone is currently logged in (live credentials present). */
export function checkLiveLogin(paths: Paths): DoctorCheck {
  const ok = existsSync(paths.credentialsPath);
  return {
    name: 'login',
    ok,
    detail: ok
      ? 'live credentials found'
      : `no ${paths.credentialsPath} — run \`claude\` and log in first`,
  };
}

/** The `~/.claude.json` config the switch touches is present. */
export function checkClaudeJson(paths: Paths): DoctorCheck {
  const ok = existsSync(paths.claudeJsonPath);
  return {
    name: 'config',
    ok,
    detail: ok ? paths.claudeJsonPath : `${paths.claudeJsonPath} not found`,
  };
}

/** Run every check for the given paths. */
export function runDoctor(paths: Paths): DoctorCheck[] {
  return [
    checkDpapi(),
    checkVault(paths),
    checkLiveLogin(paths),
    checkClaudeJson(paths),
    { name: 'lock', ok: true, detail: join(paths.vaultDir, '.lock') },
  ];
}
