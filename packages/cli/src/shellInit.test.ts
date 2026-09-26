import { describe, expect, it } from 'vitest';
import {
  isSupportedShell,
  renderShellInit,
  resolveShellInitTarget,
  SUPPORTED_SHELLS,
} from './shellInit.js';

describe('renderShellInit', () => {
  it('powershell (no target): a claude function that splats @args to cctl claude, with a quoting caveat', () => {
    const out = renderShellInit('powershell');
    expect(out).toContain('function claude {');
    expect(out).toContain('cctl claude @args');
    expect(out).toContain('$PROFILE'); // install instruction
    // Without a resolvable node entry we cannot bypass the .cmd shim, so we must warn the operator.
    expect(out).toContain('Double-quote');
  });

  it('powershell (with target): invokes node on the cctl entry directly, bypassing the .cmd shim', () => {
    const out = renderShellInit('powershell', {
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cctlEntry:
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@andrewtjin\\cctl\\dist\\bin.js',
    });
    expect(out).toContain('function claude {');
    // The wrapper must call node + the entry, not the `cctl` shim, so PowerShell never re-enters cmd.exe.
    expect(out).toContain(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@andrewtjin\\cctl\\dist\\bin.js' claude @args",
    );
    expect(out).not.toContain('cctl claude @args');
    expect(out).toContain('never the npm .cmd shim');
  });

  it('powershell (with target): single-quotes escape embedded quotes so a path cannot be reinterpreted', () => {
    const out = renderShellInit('powershell', {
      nodePath: "C:\\o'brien\\node.exe",
      cctlEntry: 'C:\\cctl\\bin.js',
    });
    // A single quote inside a PowerShell single-quoted literal is escaped by doubling.
    expect(out).toContain("& 'C:\\o''brien\\node.exe' 'C:\\cctl\\bin.js' claude @args");
  });

  it('bash: a claude() function forwarding "$@" via command cctl', () => {
    const out = renderShellInit('bash');
    expect(out).toContain('claude() {');
    expect(out).toContain('command cctl claude "$@"');
    expect(out).toContain('~/.bashrc');
  });

  it('zsh names ~/.zshrc in its install instruction', () => {
    expect(renderShellInit('zsh')).toContain('~/.zshrc');
  });

  it('fish: a function forwarding $argv', () => {
    const out = renderShellInit('fish');
    expect(out).toContain('function claude');
    expect(out).toContain('command cctl claude $argv');
    expect(out).toContain('config.fish');
  });

  it('every supported shell renders non-empty text mentioning cctl or the node entry', () => {
    for (const shell of SUPPORTED_SHELLS) {
      const out = renderShellInit(shell);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain('cctl');
    }
  });
});

describe('resolveShellInitTarget', () => {
  it('resolves node + entry from the running process shape (node <bin.js>)', () => {
    const t = resolveShellInitTarget({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      argv: [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\cctl\\dist\\bin.js',
        'shell-init',
        'powershell',
      ],
    });
    expect(t).toEqual({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cctlEntry: 'C:\\cctl\\dist\\bin.js',
    });
  });

  it('accepts .cjs and .mjs entries', () => {
    expect(
      resolveShellInitTarget({ execPath: 'node', argv: ['node', '/a/bin.cjs'] })?.cctlEntry,
    ).toBe('/a/bin.cjs');
    expect(
      resolveShellInitTarget({ execPath: 'node', argv: ['node', '/a/bin.mjs'] })?.cctlEntry,
    ).toBe('/a/bin.mjs');
  });

  it('falls back (undefined) when argv[1] is not a JS entry — e.g. a standalone executable', () => {
    expect(
      resolveShellInitTarget({
        execPath: 'C:\\cctl\\cctl.exe',
        argv: ['C:\\cctl\\cctl.exe', 'shell-init'],
      }),
    ).toBeUndefined();
    expect(resolveShellInitTarget({ execPath: 'node', argv: ['node'] })).toBeUndefined();
  });

  it('falls back (undefined) when execPath is empty', () => {
    expect(resolveShellInitTarget({ execPath: '', argv: ['', '/a/bin.js'] })).toBeUndefined();
  });
});

describe('isSupportedShell', () => {
  it('accepts the four supported shells and rejects others', () => {
    expect(isSupportedShell('powershell')).toBe(true);
    expect(isSupportedShell('bash')).toBe(true);
    expect(isSupportedShell('zsh')).toBe(true);
    expect(isSupportedShell('fish')).toBe(true);
    expect(isSupportedShell('cmd')).toBe(false);
    expect(isSupportedShell('')).toBe(false);
  });
});
