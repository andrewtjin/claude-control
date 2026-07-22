#!/usr/bin/env node
// Prepublish smoke test: proves the bundle actually boots standalone, not just that esbuild
// exited zero. Copies ONLY dist/bin.js into a throwaway directory outside the workspace — no
// pnpm symlinks, no node_modules at all — then runs it with --version and --help, the same way
// a fresh `npm i -g @andrewtjin/cctl` install would be invoked. If the bundle secretly
// still depended on a workspace-relative resolve (a missed `external`, a path that only
// resolves inside this monorepo), it fails here instead of on a user's machine.
//
// Deliberately does NOT run `doctor`: doctor's checks (DPAPI, vault, ConPTY) are Windows-only
// surfaces and this runs on CI's ubuntu runner too.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '../dist/bin.js');

if (!existsSync(bundlePath)) {
  process.stderr.write(`error: ${bundlePath} does not exist — run the build first.\n`);
  process.exit(1);
}

// A prefix under the OS temp dir, well outside the repo/workspace, so nothing here can
// accidentally resolve back into packages/*/node_modules.
const cleanDir = mkdtempSync(join(tmpdir(), 'cctl-smoke-'));
copyFileSync(bundlePath, join(cleanDir, 'bin.js'));

let failed = false;
try {
  for (const args of [['--version'], ['--help']]) {
    const result = spawnSync(process.execPath, [join(cleanDir, 'bin.js'), ...args], {
      cwd: cleanDir,
      encoding: 'utf8',
    });
    const label = `bin.js ${args.join(' ')}`;
    if (result.error) {
      failed = true;
      process.stderr.write(`error: ${label} failed to spawn: ${result.error.message}\n`);
      continue;
    }
    if (result.status !== 0) {
      failed = true;
      process.stderr.write(
        `error: ${label} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\n`,
      );
      continue;
    }
    process.stdout.write(`ok: ${label} -> ${result.stdout.trim()}\n`);
  }
} finally {
  // Never leaves the copied bundle behind, pass or fail.
  rmSync(cleanDir, { recursive: true, force: true });
}

if (failed) {
  process.stderr.write('smoke test failed.\n');
  process.exit(1);
}
process.stdout.write('smoke test passed: bundle boots standalone.\n');
