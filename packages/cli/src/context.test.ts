import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxPaths, type Paths } from '@claude-control/switch-engine';
import { buildEngine } from './context.js';

const tempDirs: string[] = [];
function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cctl-cli-context-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Run `body` with both console streams captured, so a test can assert which one a line reached
 *  without the assertion itself depending on the terminal the suite runs in. The spies are
 *  installed for the shortest possible window — anything written while they are up (vitest's own
 *  reporter included) is swallowed. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    await body();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr };
}

/** A sandbox whose registry cannot be parsed — the cheapest deterministic way to make the engine
 *  log through the adapter `buildEngine` gave it: the metadata sweep's read throws, and the
 *  no-throw wrapper turns that into exactly one warn line. */
function pathsWithUnreadableRegistry(): Paths {
  const paths = sandboxPaths(freshTempDir());
  mkdirSync(paths.vaultDir, { recursive: true });
  writeFileSync(join(paths.vaultDir, 'accounts.json'), '{ this is not json');
  return paths;
}

describe('buildEngine: where the engine writes its diagnostics', () => {
  it('keeps an engine warning off stdout, so a command can be piped', async () => {
    // A command's stdout is its OUTPUT — the accounts table, a `--json` document — and the engine
    // logs during plain reads. A warn line on stdout lands in the middle of that output and
    // breaks every non-human consumer of it, while being no more visible to the operator than it
    // is on stderr.
    //
    const engine = buildEngine(pathsWithUnreadableRegistry());

    const { stdout, stderr } = await captureConsole(async () => {
      await engine.backfillAccountMetadata();
    });

    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('account metadata sweep did not run');
  });

  it('renders to the stream the caller names, so a daemon keeps its whole log on one', async () => {
    // `cctl daemon run` writes nothing but log, and `cctl daemon run > daemon.log` is a
    // documented way to capture it. Its engine diagnostics therefore have to reach the SAME
    // stream its own logger uses (stdout) — on stderr they would escape the redirect and land
    // on the terminal, splitting the daemon's log across two places with nothing to say so.
    const engine = buildEngine(pathsWithUnreadableRegistry(), process.stdout);

    const { stdout, stderr } = await captureConsole(async () => {
      await engine.backfillAccountMetadata();
    });

    expect(stdout.join('')).toContain('account metadata sweep did not run');
    expect(stderr).toEqual([]);
  });
});
