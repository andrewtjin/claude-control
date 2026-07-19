// `cctl doctor` — environment sanity checks.
//
// The check RUNNERS do IO (filesystem, DPAPI, PATH); the RENDERER and the pass/fail
// summary are pure so their output is unit-tested. Each check reports a human detail so a
// failure is actionable, never a bare boolean.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultLiveCredentialChannel,
  defaultProtector,
  type Paths,
} from '@claude-control/switch-engine';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Render checks as `[ok]/[!!]` lines (green/red when a color palette is injected). Pure. */
export function renderDoctor(checks: DoctorCheck[], palette: Palette = PLAIN_PALETTE): string {
  return checks
    .map((c) => `${c.ok ? palette.green('[ok]') : palette.red('[!!]')} ${c.name}: ${c.detail}`)
    .join('\n');
}

/** Count outcomes. Pure. */
export function summarize(checks: DoctorCheck[]): { passed: number; failed: number } {
  const failed = checks.filter((c) => !c.ok).length;
  return { passed: checks.length - failed, failed };
}

/** Vault encryption availability, verified by a REAL protect/unprotect round-trip through
 *  this platform's protector (win32: DPAPI · darwin: Keychain+AES-GCM). On an unsupported
 *  platform the factory's error IS the report — the gap is stated, never silent. */
export async function checkVaultProtection(
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck> {
  const label = platform === 'win32' ? 'DPAPI' : platform === 'darwin' ? 'Keychain' : platform;
  try {
    const p = defaultProtector(platform);
    const probe = Buffer.from('cctl-doctor-probe');
    const ok = (await p.unprotect(await p.protect(probe))).equals(probe);
    return {
      name: 'vault-crypto',
      ok,
      detail: ok ? `${label} protect/unprotect round-trip works` : `${label} round-trip mismatch`,
    };
  } catch (err) {
    return { name: 'vault-crypto', ok: false, detail: (err as Error).message };
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

/** Whether someone is currently logged in — read through this platform's live-credential
 *  channel, so on macOS this probes the CLI's Keychain item (which doubles as the live check
 *  of the item-name/shape assumptions), not a file that never exists there. */
export async function checkLiveLogin(
  paths: Paths,
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck> {
  const where = platform === 'darwin' ? "the CLI's Keychain item" : paths.credentialsPath;
  try {
    const live = await defaultLiveCredentialChannel(paths, platform).readLiveCredentials();
    return {
      name: 'login',
      ok: live !== undefined,
      detail:
        live !== undefined
          ? `live credentials found in ${where}`
          : `no live credentials in ${where} - run \`claude\` and log in first`,
    };
  } catch (err) {
    return {
      name: 'login',
      ok: false,
      detail: `error reading ${where}: ${(err as Error).message}`,
    };
  }
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
export async function runDoctor(paths: Paths): Promise<DoctorCheck[]> {
  return [
    await checkVaultProtection(),
    checkVault(paths),
    await checkLiveLogin(paths),
    checkClaudeJson(paths),
    { name: 'lock', ok: true, detail: join(paths.vaultDir, '.lock') },
  ];
}
