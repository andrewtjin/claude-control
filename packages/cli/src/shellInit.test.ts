import { describe, expect, it } from 'vitest';
import {
  isSupportedShell,
  parsePowerShellWrapper,
  POWERSHELL_WRAPPER_MARKER,
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

  it('powershell (with target): forwards piped stdin only when the call has pipeline input', () => {
    // A PowerShell function does not auto-forward pipeline input to a native command, so `... | claude
    // -p` would deliver empty stdin unless the wrapper pipes $input in — guarded so an interactive
    // no-pipe launch still inherits the console.
    const out = renderShellInit('powershell', {
      nodePath: 'node.exe',
      cctlEntry: 'C:\\cctl\\bin.js',
    });
    expect(out).toContain('if ($MyInvocation.ExpectingInput) {');
    expect(out).toContain('$input | & ');
    // The else-branch invokes the child WITHOUT piping $input, so the console stdin is inherited.
    expect(out).toContain('  } else {');
  });

  it('powershell (fallback): forwards piped stdin through the shim form too', () => {
    const out = renderShellInit('powershell');
    expect(out).toContain('if ($MyInvocation.ExpectingInput) {');
    expect(out).toContain('$input | cctl claude @args');
  });

  it('powershell (both forms): warns that a literal double quote is mangled on PowerShell < 7.3', () => {
    const withTarget = renderShellInit('powershell', {
      nodePath: 'node.exe',
      cctlEntry: 'C:\\cctl\\bin.js',
    });
    const fallback = renderShellInit('powershell');
    for (const out of [withTarget, fallback]) {
      expect(out).toContain('double quote');
      expect(out).toContain('7.3');
    }
  });

  it('powershell (both forms): forces UTF-8 on the stdin pipe so non-ASCII input is not turned into "?"', () => {
    // Windows PowerShell 5.1 encodes a native-command pipe with $OutputEncoding (default ASCII), so a
    // forwarded $input carrying non-ASCII text would arrive with every such byte replaced by "?". The
    // wrapper must set $OutputEncoding to UTF-8 inside the ExpectingInput branch, before the pipe.
    for (const out of [
      renderShellInit('powershell', { nodePath: 'node.exe', cctlEntry: 'C:\\cctl\\bin.js' }),
      renderShellInit('powershell'),
    ]) {
      const branch = out.slice(out.indexOf('if ($MyInvocation.ExpectingInput) {'));
      const encodingLine = branch.indexOf(
        '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      );
      const pipeLine = branch.indexOf('$input |');
      expect(encodingLine).toBeGreaterThanOrEqual(0);
      // The encoding is set BEFORE the pipe, or it does not take effect for it.
      expect(encodingLine).toBeLessThan(pipeLine);
    }
  });

  it('powershell (both forms): warns that empty-string arguments are dropped on PowerShell < 7.3', () => {
    // `& native @args` under Legacy native-argument passing drops an empty-string argument entirely, so
    // `claude -p ""` silently degrades to `claude -p`. The wrapper cannot fix this in place on 5.1, so
    // it must document it alongside the double-quote caveat.
    for (const out of [
      renderShellInit('powershell', { nodePath: 'node.exe', cctlEntry: 'C:\\cctl\\bin.js' }),
      renderShellInit('powershell'),
    ]) {
      // The exact wrapping differs between the two headers, so match the load-bearing tokens.
      expect(out).toContain('empty-string');
      expect(out).toContain('dropped');
    }
  });

  it('powershell: the emitted wrapper carries the stable detector marker', () => {
    expect(renderShellInit('powershell')).toContain(POWERSHELL_WRAPPER_MARKER);
    expect(
      renderShellInit('powershell', { nodePath: 'node.exe', cctlEntry: 'C:\\cctl\\bin.js' }),
    ).toContain(POWERSHELL_WRAPPER_MARKER);
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

describe('parsePowerShellWrapper', () => {
  it('round-trips the node/entry paths out of an emitted node-direct wrapper', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const entry = 'C:\\Users\\me\\npm\\cctl\\dist\\bin.js';
    const parsed = parsePowerShellWrapper(
      renderShellInit('powershell', { nodePath: node, cctlEntry: entry }),
    );
    expect(parsed).toEqual({ kind: 'node-direct', nodePath: node, cctlEntry: entry });
  });

  it('un-doubles single quotes embedded in a path', () => {
    const out = renderShellInit('powershell', {
      nodePath: "C:\\o'brien\\node.exe",
      cctlEntry: 'C:\\cctl\\bin.js',
    });
    expect(parsePowerShellWrapper(out)).toEqual({
      kind: 'node-direct',
      nodePath: "C:\\o'brien\\node.exe",
      cctlEntry: 'C:\\cctl\\bin.js',
    });
  });

  it('reports the shim (fallback) form as having no embedded paths', () => {
    expect(parsePowerShellWrapper(renderShellInit('powershell'))).toEqual({ kind: 'shim' });
  });

  it('returns undefined when no cctl wrapper marker is present', () => {
    expect(parsePowerShellWrapper('function foo { echo hi }\n')).toBeUndefined();
    // A bash wrapper is not a PowerShell wrapper.
    expect(parsePowerShellWrapper(renderShellInit('bash'))).toBeUndefined();
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
