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
    // First-run + at-a-glance status surfaces.
    expect(names).toContain('setup');
    expect(names).toContain('status');
  });

  it('offers --reconfigure and --relay on setup', () => {
    const setup = buildProgram().commands.find((c) => c.name() === 'setup');
    expect(setup?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--reconfigure', '--relay']),
    );
  });

  it('gives pair an optional code argument and a --relay override', () => {
    const pair = buildProgram().commands.find((c) => c.name() === 'pair');
    expect(pair?.options.map((o) => o.long)).toContain('--relay');
    // The optional [code] argument keeps pairing usable both interactively and as `cctl pair <code>`.
    expect(pair?.registeredArguments.map((a) => a.name())).toContain('code');
  });

  it('nests account subcommands', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const subs = accounts?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['add', 'list', 'remove']);
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

  it('nests install, uninstall, and status alongside run under daemon', () => {
    const daemon = buildProgram().commands.find((c) => c.name() === 'daemon');
    const subs = daemon?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['install', 'run', 'status', 'uninstall']);
  });

  it('reports its version', () => {
    expect(buildProgram().version()).toBe('0.1.0');
  });
});
