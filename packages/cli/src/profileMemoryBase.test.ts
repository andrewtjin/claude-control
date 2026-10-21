// Every way cctl starts Claude Code on a folder profile gives the session the main dir as its memory
// base. A profile's `projects` is a link to the main dir's, and Claude Code asks before every memory
// write whose path runs through a link; with the main dir as the base, the same memory files are
// reached with no link and saved without asking. These run on a real profile layout: a temp main dir
// and a profile whose `projects` is a junction (a directory symlink off Windows) to it, read by the
// real readlink, as a launch reads the profile cctl made.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSdkQueryOptions,
  type AgentSdkClient,
  type CreateAgentSdkClientDeps,
} from '@claude-control/session-runtime';
import { MEMORY_BASE_ENV, noopLogger } from '@claude-control/switch-engine';
import { createClaudeBackgroundHost, type ClaudeRunResult } from './backgroundHost.js';
import { makeAgentSdkClientFactory } from './daemonRun.js';
import { renderWhere, type WhereView } from './folderRender.js';
import { buildLaunchEnv, type LaunchSlot } from './launcher.js';

/** A main config dir and a folder profile linking its `projects` to the main dir's. */
interface Layout {
  base: string;
  main: string;
  root: string;
  profile: string;
}

let layout: Layout;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'cctl-profile-membase-'));
  const main = join(base, 'main');
  const root = join(base, 'profiles');
  const profile = join(root, 'rule-1');
  mkdirSync(join(main, 'projects'), { recursive: true });
  mkdirSync(profile, { recursive: true });
  symlinkSync(join(main, 'projects'), join(profile, 'projects'), 'junction');
  layout = { base, main, root, profile };
});

afterEach(() => {
  rmSync(layout.base, { recursive: true, force: true });
});

/** Paths compared separator- and case-blind, as Windows names them. */
const same = (a: string | undefined): string | undefined =>
  a
    ?.replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();

// `cctl claude` and its routed background opens both build their env here.
describe('buildLaunchEnv and the memory base', () => {
  const globalSlot: LaunchSlot = { kind: 'global', label: 'personal', context: 'global' };

  it("gives a group slot's session its profile and the main dir as memory base", () => {
    const env = buildLaunchEnv({
      baseEnv: { PATH: 'x' },
      slot: { kind: 'group', profileDir: layout.profile, label: 'SPAR', context: 'rule' },
      dropInheritedConfigDir: false,
      profilesRoot: layout.root,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(layout.profile);
    expect(same(env[MEMORY_BASE_ENV])).toBe(same(layout.main));
    expect(env.PATH).toBe('x');
  });

  it('drops an inherited memory base with the profile CLAUDE_CONFIG_DIR it came with', () => {
    const env = buildLaunchEnv({
      baseEnv: { CLAUDE_CONFIG_DIR: layout.profile, [MEMORY_BASE_ENV]: layout.main, PATH: 'x' },
      slot: globalSlot,
      dropInheritedConfigDir: true,
      profilesRoot: layout.root,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(MEMORY_BASE_ENV in env).toBe(false);
    expect(env.PATH).toBe('x');
  });

  it('drops an inherited memory base from a global launch on another config dir', () => {
    const sandbox = join(layout.base, 'sandbox');
    const env = buildLaunchEnv({
      baseEnv: { CLAUDE_CONFIG_DIR: sandbox, [MEMORY_BASE_ENV]: layout.main },
      slot: globalSlot,
      dropInheritedConfigDir: false,
      profilesRoot: layout.root,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(sandbox);
    expect(MEMORY_BASE_ENV in env).toBe(false);
  });
});

describe('background service commands', () => {
  /** A host whose every Claude Code command is recorded with its environment. */
  function host(
    env: NodeJS.ProcessEnv,
    profilesRoot: string | undefined,
  ): {
    host: ReturnType<typeof createClaudeBackgroundHost>;
    envs: NodeJS.ProcessEnv[];
  } {
    const envs: NodeJS.ProcessEnv[] = [];
    const h = createClaudeBackgroundHost({
      mainConfigDir: layout.main,
      moveLockDir: join(layout.base, 'locks'),
      env,
      run: (_args, o): Promise<ClaudeRunResult> => {
        envs.push(o.env);
        return Promise.resolve({ code: 0, stdout: '[]', stderr: '' });
      },
      ...(profilesRoot !== undefined ? { profilesRoot } : {}),
    });
    return { host: h, envs };
  }

  it("gives a profile's service the main dir as its memory base", async () => {
    const { host: h, envs } = host({ PATH: '/bin' }, layout.root);
    await h.activity(layout.profile);
    expect(same(envs[0]?.CLAUDE_CONFIG_DIR)).toBe(same(layout.profile));
    expect(same(envs[0]?.[MEMORY_BASE_ENV])).toBe(same(layout.main));
  });

  it("gives the main dir's service none, whatever was inherited", async () => {
    const { host: h, envs } = host(
      { PATH: '/bin', CLAUDE_CONFIG_DIR: layout.profile, [MEMORY_BASE_ENV]: layout.main },
      layout.root,
    );
    await h.activity(null);
    expect(envs[0]?.[MEMORY_BASE_ENV]).toBeUndefined();
  });

  it('sets none without a profiles root to recognize a profile by', async () => {
    const { host: h, envs } = host({ PATH: '/bin' }, undefined);
    await h.activity(layout.profile);
    expect(envs[0]?.[MEMORY_BASE_ENV]).toBeUndefined();
  });
});

describe('daemon-managed sessions', () => {
  /** The deps the factory hands the SDK client, captured without constructing it. */
  function capture(): {
    deps: CreateAgentSdkClientDeps[];
    create: (d: CreateAgentSdkClientDeps) => AgentSdkClient;
  } {
    const deps: CreateAgentSdkClientDeps[] = [];
    return {
      deps,
      create: (d) => {
        deps.push(d);
        return {} as AgentSdkClient;
      },
    };
  }

  it('runs a folder-bound session with its profile and the main dir as memory base', () => {
    const { deps, create } = capture();
    makeAgentSdkClientFactory(noopLogger, create, layout.root)(layout.profile);
    const shape = buildSdkQueryOptions({ accountId: 'member-1' }, deps[0] ?? {});
    expect(shape.env?.CLAUDE_CONFIG_DIR).toBe(layout.profile);
    expect(same(shape.env?.[MEMORY_BASE_ENV])).toBe(same(layout.main));
  });

  it('gives a session on any other config dir none, even when the daemon inherited one', () => {
    const { deps, create } = capture();
    const sandbox = join(layout.base, 'sandbox');
    process.env[MEMORY_BASE_ENV] = layout.main;
    try {
      makeAgentSdkClientFactory(noopLogger, create, layout.root)(sandbox);
    } finally {
      delete process.env[MEMORY_BASE_ENV];
    }
    const shape = buildSdkQueryOptions({ accountId: 'member-1' }, deps[0] ?? {});
    expect(shape.env?.CLAUDE_CONFIG_DIR).toBe(sandbox);
    expect(shape.env !== undefined && MEMORY_BASE_ENV in shape.env).toBe(false);
  });
});

describe('cctl folder where', () => {
  const rule = (memoryBase?: string): NonNullable<WhereView['rule']> => ({
    label: 'SPAR',
    folders: ['C:\\work'],
    include: ['research'],
    exclude: [],
    live: null,
    pool: [],
    profileDir: 'C:\\profiles\\rule-1',
    matchedFolder: 'C:\\work',
    ...(memoryBase !== undefined ? { memoryBase } : {}),
  });
  const global = { live: null, pool: [] };

  it('prints the memory base in the env lines and the VS Code snippet', () => {
    const out = renderWhere(
      { folder: 'C:\\work', rule: rule('C:\\Users\\me\\.claude'), global },
      undefined,
      'win32',
    );
    expect(out).toContain(`${MEMORY_BASE_ENV}=C:\\Users\\me\\.claude`);
    expect(out).toContain(`"name": "${MEMORY_BASE_ENV}"`);
    expect(out).toContain('"value": "C:\\\\Users\\\\me\\\\.claude"');
  });

  it('prints only CLAUDE_CONFIG_DIR for a profile that needs no memory base', () => {
    const out = renderWhere({ folder: 'C:\\work', rule: rule(), global }, undefined, 'win32');
    expect(out).toContain('CLAUDE_CONFIG_DIR=C:\\profiles\\rule-1');
    expect(out).not.toContain(MEMORY_BASE_ENV);
  });
});
