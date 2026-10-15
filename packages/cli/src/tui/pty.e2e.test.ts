// One end-to-end run of the full-screen view in a real pseudo-terminal: the built `cctl tui` is
// started in a PTY over an empty sandboxed data dir, draws its screen, reads a single `q` without
// Enter (which only works in raw mode) and exits cleanly.
//
// node-pty is a native module this workspace does not install, so the test runs only where it can
// be required (a rig that puts it on NODE_PATH, for one) and the built CLI exists; everywhere else
// it is skipped, never failed. On Windows the winpty backend is used: it passes the drawn text
// through intact, where ConPTY re-encodes it.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The slice of node-pty this test uses. */
interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  kill(): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      useConpty?: boolean;
    },
  ): PtyProcess;
}

/** node-pty when it can be loaded (CommonJS resolution, so NODE_PATH is honored), else undefined. */
function loadPty(): PtyModule | undefined {
  try {
    return createRequire(import.meta.url)('node-pty') as PtyModule;
  } catch {
    return undefined;
  }
}

const pty = loadPty();
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin.js');
const ESC = String.fromCharCode(27);

describe.skipIf(pty === undefined || !existsSync(BIN))('cctl tui in a real terminal', () => {
  it(
    'draws, quits on a single q, and leaves the alternate screen',
    { timeout: 60_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'cctl-tui-pty-'));
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        LOCALAPPDATA: root,
        XDG_DATA_HOME: root,
        HOME: root,
        USERPROFILE: root,
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        NO_COLOR: '1',
      };
      let output = '';
      const term = pty!.spawn(process.execPath, [BIN, 'tui'], {
        name: 'xterm-256color',
        cols: 100,
        rows: 20,
        cwd: root,
        env,
        useConpty: false,
      });
      let done = false;
      const exited = new Promise<number>((resolve) =>
        term.onExit((e) => {
          done = true;
          resolve(e.exitCode);
        }),
      );
      term.onData((d) => {
        output += d;
      });
      try {
        const deadline = Date.now() + 30_000;
        while (!(output.includes('[Accounts]') && output.includes('No accounts yet'))) {
          if (Date.now() > deadline)
            throw new Error(`no screen drawn; got: ${JSON.stringify(output)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        term.write('q');
        const code = await Promise.race([
          exited,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error('cctl tui did not exit on q')), 20_000),
          ),
        ]);
        expect(code).toBe(0);
        // A POSIX PTY passes the screen switches through as written; winpty redraws its console
        // instead, so there the exit on a bare `q` is the evidence the input was raw.
        if (process.platform !== 'win32') {
          expect(output).toContain(`${ESC}[?1049h`);
          expect(output.lastIndexOf(`${ESC}[?1049l`)).toBeGreaterThan(
            output.lastIndexOf('[Accounts]'),
          );
        }
      } finally {
        // Only a process still running is killed: node-pty's Windows agent throws when asked to
        // kill one that has already exited.
        if (!done) term.kill();
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );
});
