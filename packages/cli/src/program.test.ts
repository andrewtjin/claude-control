import { describe, it, expect } from 'vitest';
import { buildProgram } from './program.js';

describe('buildProgram', () => {
  it('exposes the expected command surface', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toContain('accounts');
    expect(names).toContain('switch');
    expect(names).toContain('recover');
    expect(names).toContain('doctor');
    // Daemon-backed placeholders are present so the surface is discoverable.
    expect(names).toContain('usage');
    expect(names).toContain('pair');
  });

  it('nests account subcommands', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const subs = accounts?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['add', 'list', 'remove']);
  });

  it('reports its version', () => {
    expect(buildProgram().version()).toBe('0.1.0');
  });
});
