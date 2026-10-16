// Whether this terminal can host the full-screen view.
//
// Two things are needed: a person at both ends (keys in, a screen out), and a terminal that
// understands what the view draws with (cursor addressing, the alternate screen). A terminal that
// passes the first and fails the second (an Emacs shell buffer, the legacy Windows console) is
// still a terminal, and gets the plain output a pipe gets rather than a screen of escape codes.

import { spawnSync } from 'node:child_process';

/** Whether a person is at both ends of this process: input and output are both a terminal. The
 *  full-screen view needs both — keys in, a screen out — and anything less (a pipe, a file, CI)
 *  gets plain output. */
export function isInteractiveTerminal(
  stdin: { isTTY?: boolean | undefined } = process.stdin,
  stdout: { isTTY?: boolean | undefined } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * Why this terminal cannot draw the full-screen view, or undefined when it can.
 *
 * - `TERM=dumb` is a terminal that says it cannot move the cursor: an Emacs `M-x shell` buffer
 *   runs its shell on a pseudo-terminal with that setting, so both ends are TTYs, yet every frame
 *   would be appended to the buffer as text.
 * - The legacy Windows console ("Use legacy console", `HKCU\Console` `ForceV2` = 0) has no VT
 *   processing; Node emulates a few sequences, but not the alternate screen, so the view would
 *   wipe the visible console and leave its last frame behind on exit. A terminal that sets its
 *   own marker (Windows Terminal's `WT_SESSION`, `TERM_PROGRAM`, `TERM`) speaks VT whatever that
 *   setting says, and the registry is not asked.
 *
 * `readForceV2` reads the console setting (injectable; the default asks `reg`).
 */
export function fullScreenBlocker(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readForceV2: () => number | undefined = readConsoleForceV2,
): string | undefined {
  if (env.TERM === 'dumb') {
    return 'this terminal (TERM=dumb) cannot move the cursor, which the full-screen view needs';
  }
  if (platform !== 'win32') return undefined;
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined || env.TERM !== undefined) {
    return undefined;
  }
  return readForceV2() === 0
    ? 'this is the legacy Windows console, which has no alternate screen for the full-screen ' +
        'view (turn off "Use legacy console" in its properties, or use Windows Terminal)'
    : undefined;
}

/** The `ForceV2` value out of `reg query HKCU\Console /v ForceV2` output, or undefined when the
 *  value is absent (the modern console, the default). */
export function parseForceV2(output: string): number | undefined {
  const match = /ForceV2\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
  return match ? Number.parseInt(match[1]!, 16) : undefined;
}

/** The console's `ForceV2` setting, or undefined when it is absent or cannot be read. */
function readConsoleForceV2(): number | undefined {
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Console', '/v', 'ForceV2'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000,
    });
    return typeof result.stdout === 'string' ? parseForceV2(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}
