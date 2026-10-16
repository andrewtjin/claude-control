// Whether this terminal can host the full-screen view: a person at both ends, and a terminal that
// understands cursor addressing and the alternate screen.

import { describe, it, expect, vi } from 'vitest';
import { fullScreenBlocker, isInteractiveTerminal, parseForceV2 } from './terminalSupport.js';

describe('isInteractiveTerminal', () => {
  it('needs a terminal at both ends', () => {
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractiveTerminal({}, { isTTY: true })).toBe(false);
  });
});

describe('fullScreenBlocker', () => {
  const never = vi.fn(() => undefined);

  it('blocks a dumb terminal (an Emacs shell buffer), which cannot move the cursor', () => {
    expect(fullScreenBlocker({ TERM: 'dumb' }, 'linux', never)).toMatch(/TERM=dumb/);
    expect(fullScreenBlocker({ TERM: 'xterm-256color' }, 'linux', never)).toBeUndefined();
  });

  it('blocks the legacy Windows console, which drops the alternate screen', () => {
    expect(fullScreenBlocker({}, 'win32', () => 0)).toMatch(/legacy console/);
    expect(fullScreenBlocker({}, 'win32', () => 1)).toBeUndefined();
    expect(fullScreenBlocker({}, 'win32', () => undefined)).toBeUndefined();
  });

  it('does not ask the registry inside a terminal that is known to speak VT', () => {
    const ask = vi.fn(() => 0);
    expect(fullScreenBlocker({ WT_SESSION: 'x' }, 'win32', ask)).toBeUndefined();
    expect(fullScreenBlocker({ TERM_PROGRAM: 'vscode' }, 'win32', ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('reads the ForceV2 value out of reg query output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Console\r\n    ForceV2    REG_DWORD    0x0\r\n\r\n';
    expect(parseForceV2(out)).toBe(0);
    expect(parseForceV2(out.replace('0x0', '0x1'))).toBe(1);
    expect(parseForceV2('ERROR: The system was unable to find the specified registry key')).toBe(
      undefined,
    );
  });
});
