import { describe, expect, it } from 'vitest';
import { isSupportedShell, renderShellInit, SUPPORTED_SHELLS } from './shellInit.js';

describe('renderShellInit', () => {
  it('powershell: a claude function that splats @args to cctl claude', () => {
    const out = renderShellInit('powershell');
    expect(out).toContain('function claude {');
    expect(out).toContain('cctl claude @args');
    expect(out).toContain('$PROFILE'); // install instruction
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

  it('every supported shell renders non-empty text mentioning cctl claude', () => {
    for (const shell of SUPPORTED_SHELLS) {
      const out = renderShellInit(shell);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain('cctl claude');
    }
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
