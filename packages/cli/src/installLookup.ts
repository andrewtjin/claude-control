// Where the cctl installs on this machine are, and what version each is: the one a shell runs (the
// first `cctl` on PATH), the one the PowerShell `claude` wrapper runs, and the one the autostart
// registration starts. Read before a parallel session is taken, since an older install cannot read
// the rules file while one exists (see folderRulesSupport.ts). File reads only, plus the autostart
// query.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { queryAutostart } from './autostart.js';
import type { InstallLookup } from './folderRulesSupport.js';
import { unwrapNpmCmdShim } from './launcher.js';
import { readPowerShellWrappers } from './shellInit.js';

/** The package a cctl install is published as. */
const PACKAGE_NAME = '@andrewtjin/cctl';

/** The names a `cctl` command can have in one PATH directory, in the order a shell tries them. */
function commandNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['cctl.cmd', 'cctl.ps1', 'cctl.exe', 'cctl'] : ['cctl'];
}

/** The first `cctl` on PATH, without running anything. */
export function findCctlOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const raw = env.PATH ?? env.Path ?? '';
  for (const dir of raw.split(platform === 'win32' ? ';' : delimiter)) {
    if (dir.trim() === '') continue;
    for (const name of commandNames(platform)) {
      const candidate = join(dir.trim(), name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The version in the cctl `package.json` at or above `start`, or undefined. */
function packageVersionAbove(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const file = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // No package.json here, or not one that reads: keep walking up.
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * The version of the cctl install a command shim or an entry script belongs to: a script (or a link
 * to one) by the package it sits in; an npm `.cmd` shim by the script it runs; any other shim by the
 * package npm puts beside it (`node_modules/@andrewtjin/cctl`). Undefined when none of that reads.
 */
export function cctlVersionOf(path: string): string | undefined {
  let target = path;
  try {
    target = realpathSync.native(path);
  } catch {
    return undefined;
  }
  if (/\.(c|m)?js$/i.test(target)) return packageVersionAbove(dirname(target));
  if (/\.cmd$/i.test(target)) {
    try {
      const entry = unwrapNpmCmdShim(target, readFileSync(target, 'utf8'));
      if (entry !== undefined) return packageVersionAbove(dirname(entry));
    } catch {
      // Fall through to the npm layout beside the shim.
    }
  }
  return (
    packageVersionAbove(join(dirname(target), 'node_modules', '@andrewtjin', 'cctl')) ??
    packageVersionAbove(join(dirname(target), '..', 'lib', 'node_modules', '@andrewtjin', 'cctl'))
  );
}

/** The cctl entry scripts the PowerShell `claude` wrappers in effect run: each profile's last
 *  wrapper (see readPowerShellWrappers), where it runs an install by path rather than PATH. */
export function wrapperEntriesOf(env: NodeJS.ProcessEnv = process.env): string[] {
  return readPowerShellWrappers(env).flatMap(({ wrapper }) =>
    wrapper.kind === 'node-direct' ? [wrapper.cctlEntry] : [],
  );
}

/** The real machine's installs. */
export function defaultInstallLookup(): InstallLookup {
  return {
    onPath: () => findCctlOnPath(),
    wrapperEntries: () => (process.platform === 'win32' ? wrapperEntriesOf() : []),
    autostart: () => {
      const q = queryAutostart();
      return q.supported && q.registered && q.execute !== undefined
        ? { noun: q.noun, execute: q.execute }
        : undefined;
    },
    versionOf: cctlVersionOf,
  };
}
