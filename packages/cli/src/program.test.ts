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
    expect(names).toContain('timeline');
    expect(names).toContain('settings');
    expect(names).toContain('pair');
    expect(names).toContain('session');
  });

  it('nests account subcommands including in-place relogin', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const subs = accounts?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['add', 'list', 'relogin', 'remove']);
  });

  it('nests session subcommands', () => {
    const session = buildProgram().commands.find((c) => c.name() === 'session');
    const subs = session?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['label', 'register', 'status', 'watch']);
  });

  it('offers --session on the register/label/watch session commands', () => {
    const session = buildProgram().commands.find((c) => c.name() === 'session');
    for (const name of ['register', 'label', 'watch']) {
      const cmd = session?.commands.find((c) => c.name() === name);
      expect(cmd?.options.map((o) => o.long)).toContain('--session');
    }
  });

  it('offers the --fresh capture flag on accounts add', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const add = accounts?.commands.find((c) => c.name() === 'add');
    expect(add?.options.map((o) => o.long)).toContain('--fresh');
  });

  it('offers the --force cadence override on switch', () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'switch');
    expect(cmd?.options.map((o) => o.long)).toContain('--force');
  });

  it('nests a real daemon run subcommand with pairing, relay, and auto-switch flags', () => {
    const daemon = buildProgram().commands.find((c) => c.name() === 'daemon');
    const run = daemon?.commands.find((c) => c.name() === 'run');
    expect(run).toBeDefined();
    expect(run?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--pair', '--relay', '--auto-switch', '--greedy']),
    );
  });

  it('reports its version', () => {
    expect(buildProgram().version()).toBe('0.1.0');
  });
});
