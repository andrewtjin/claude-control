// Which session a `cctl claude` launch opens, read from Claude Code's own arguments — and the
// binding that session resolves to.
//
// The parse must read argv the way Claude Code's option parser (commander) does, or a flag's VALUE
// would be taken for a flag (`--append-system-prompt --resume` resumes nothing) and a launch would be
// routed to the wrong account. It must also never touch the argv: the launcher spawns the caller's
// array as is. The table below pins each commander rule that matters; the resolution tests pin the
// alias each form yields and the precedence rule applied to it.

import { describe, expect, it } from 'vitest';
import type { StoredGroup } from '@claude-control/switch-engine';
import {
  parseClaudeSessionArgs,
  resolveLaunchAlias,
  type ClaudeSessionArgs,
  type LaunchAliasDeps,
} from './launcher.js';
import { buildWhereView, resolveLaunchBinding } from './bindCommands.js';

const ID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';

/** Expected parse: every field defaulted, overridden per row. */
const parsed = (over: Partial<ClaudeSessionArgs> = {}): ClaudeSessionArgs => ({
  continue: false,
  fork: false,
  ...over,
});

const TABLE: Array<[string, string[], ClaudeSessionArgs]> = [
  ['no arguments: a new unnamed session', [], parsed()],
  ['a prompt only', ['fix the bug'], parsed()],
  ['--resume <title>', ['--resume', 'Auth Work'], parsed({ resume: 'Auth Work' })],
  ['-r <title>', ['-r', 'auth work'], parsed({ resume: 'auth work' })],
  ['--resume=<title>', ['--resume=Auth Work'], parsed({ resume: 'Auth Work' })],
  ['--resume= (empty attached value)', ['--resume='], parsed({ resume: '' })],
  ['-r<title> (attached short value)', ['-rAuth'], parsed({ resume: 'Auth' })],
  // commander hands a short option everything after the flag letter, '=' included.
  ['-r=<title> keeps the = (commander semantics)', ['-r=x'], parsed({ resume: '=x' })],
  ['--resume <uuid>', ['--resume', ID], parsed({ resume: ID })],
  ['bare --resume (the picker)', ['--resume'], parsed({ resume: null })],
  [
    'bare --resume before another flag: the flag is not its value',
    ['--resume', '--model', 'opus'],
    parsed({ resume: null }),
  ],
  [
    'an OPTIONAL value is not taken when dash-led (-p after -r)',
    ['-r', '-p', 'hello'],
    parsed({ resume: null }),
  ],
  [
    'a REQUIRED value is taken even when it looks like a flag',
    ['--append-system-prompt', '--resume', 'x'],
    parsed(),
  ],
  [
    'the text after --name is the name even when dash-led',
    ['--name', '--resume'],
    parsed({ name: '--resume' }),
  ],
  ['--continue', ['--continue'], parsed({ continue: true })],
  ['-c', ['-c'], parsed({ continue: true })],
  ['combined short booleans -pc expand', ['-pc', 'hi'], parsed({ continue: true })],
  [
    'combined -cr: -c then -r taking the next token',
    ['-cr', 'Auth Work'],
    parsed({ continue: true, resume: 'Auth Work' }),
  ],
  ['--name <v>', ['--name', 'Probe Alias'], parsed({ name: 'Probe Alias' })],
  ['-n <v>', ['-n', 'x'], parsed({ name: 'x' })],
  ['--name=<v>', ['--name=x y'], parsed({ name: 'x y' })],
  ['--session-id <uuid>', ['--session-id', ID], parsed({ sessionId: ID })],
  [
    'resume + fork (a fork keeps the title)',
    ['--resume', 'Auth Work', '--fork-session'],
    parsed({ resume: 'Auth Work', fork: true }),
  ],
  [
    'fork with a chosen session id',
    ['-r', ID, '--fork-session', '--session-id', 'ffffffff-0000-4000-8000-000000000000'],
    parsed({ resume: ID, fork: true, sessionId: 'ffffffff-0000-4000-8000-000000000000' }),
  ],
  ['the last --resume wins', ['-r', 'a', '--resume', 'b'], parsed({ resume: 'b' })],
  ['options after the prompt still parse', ['do it', '--resume', 'x'], parsed({ resume: 'x' })],
  ['-- ends options: the rest is the prompt', ['--', '--resume', 'x'], parsed()],
  ['options before -- still count', ['--name', 'n', '--', '-c'], parsed({ name: 'n' })],
  [
    'a variadic option swallows its non-dash values',
    ['--add-dir', 'a', 'b', '--resume', 'x'],
    parsed({ resume: 'x' }),
  ],
  [
    'a variadic option does not swallow a flag',
    ['--allowedTools', 'Bash', 'Edit', '-c'],
    parsed({ continue: true }),
  ],
  [
    'a subcommand owns everything after it (mcp add --name is not a session name)',
    ['mcp', 'add', '--name', 'x'],
    parsed({ subcommand: 'mcp' }),
  ],
  [
    'a subcommand word AFTER a prompt is just text',
    ['look at', 'mcp', '--name', 'n'],
    parsed({ name: 'n' }),
  ],
  [
    'an unknown option is read as a boolean',
    ['--some-new-flag', '--resume', 'x'],
    parsed({ resume: 'x' }),
  ],
  ['--model value is skipped', ['--model', '-c'], parsed()],
  ['--debug with an optional filter', ['--debug', 'api', '-c'], parsed({ continue: true })],
];

describe('parseClaudeSessionArgs', () => {
  it.each(TABLE)('%s', (_name, args, want) => {
    expect(parseClaudeSessionArgs(args)).toEqual(want);
  });

  it('never alters the argv it reads (the launcher spawns that exact array)', () => {
    for (const [, args] of TABLE) {
      const frozen = Object.freeze([...args]);
      const before = JSON.stringify(frozen);
      // A frozen array throws on any write in strict mode, so a mutation cannot pass silently.
      parseClaudeSessionArgs(frozen);
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });
});

describe('resolveLaunchAlias', () => {
  /** Catalog stand-ins that record what was asked. */
  function deps(titles: Record<string, string | null>, latest: string | null) {
    const asked: string[] = [];
    const d: LaunchAliasDeps = {
      customTitleById: (id) => {
        asked.push(`id:${id}`);
        return Promise.resolve(titles[id] ?? null);
      },
      latestCustomTitleInFolder: () => {
        asked.push('latest');
        return Promise.resolve(latest);
      },
    };
    return { d, asked };
  }

  it('--resume <title> is the title itself (no catalog read)', async () => {
    const { d, asked } = deps({}, null);
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['-r', 'Auth Work']), d)).toBe(
      'Auth Work',
    );
    expect(asked).toEqual([]);
  });

  it('--resume <uuid> is that session’s custom title from the catalog', async () => {
    const { d, asked } = deps({ [ID]: 'Auth Work' }, null);
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['--resume', ID]), d)).toBe('Auth Work');
    expect(asked).toEqual([`id:${ID}`]);
    // An unknown or unnamed id yields no alias.
    const none = deps({}, null);
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['--resume', ID]), none.d)).toBeNull();
  });

  it('a bare --resume (the picker) has no alias to route by', async () => {
    const { d } = deps({}, 'x');
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['--resume']), d)).toBeNull();
  });

  it('--continue is the most recent session in the folder', async () => {
    const { d, asked } = deps({}, 'Auth Work');
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['-c']), d)).toBe('Auth Work');
    expect(asked).toEqual(['latest']);
  });

  it('--name wins, on a new session, a resume, or a fork', async () => {
    const { d, asked } = deps({ [ID]: 'old' }, 'latest');
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['--name', 'new']), d)).toBe('new');
    expect(
      await resolveLaunchAlias(parseClaudeSessionArgs(['-r', ID, '--fork-session', '-n', 'n']), d),
    ).toBe('n');
    expect(asked).toEqual([]);
  });

  it('a fork keeps the resumed title', async () => {
    const { d } = deps({}, null);
    expect(
      await resolveLaunchAlias(parseClaudeSessionArgs(['-r', 'Auth Work', '--fork-session']), d),
    ).toBe('Auth Work');
  });

  it('--session-id alone names an existing session, else none', async () => {
    const { d } = deps({ [ID]: 'Existing' }, null);
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['--session-id', ID]), d)).toBe(
      'Existing',
    );
    expect(
      await resolveLaunchAlias(parseClaudeSessionArgs(['--session-id', 'not-a-uuid']), d),
    ).toBeNull();
  });

  it('a subcommand or a plain launch has no alias', async () => {
    const { d } = deps({}, 'x');
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['mcp', 'list']), d)).toBeNull();
    expect(await resolveLaunchAlias(parseClaudeSessionArgs(['hello']), d)).toBeNull();
  });
});

// Groups for the resolution tests: a folder binding of C:\work, and an alias-only group binding
// "auth work" in C:\work. Win32 spellings, since the rule's folder keys are platform-specific.
const member = (id: string) => ({
  id,
  label: id,
  quarantined: false,
  createdAtMs: 1,
  updatedAtMs: 1,
});
const GROUPS: StoredGroup[] = [
  {
    id: 'folder',
    label: 'Work',
    members: [member('work')],
    activeId: 'work',
    folders: ['C:\\work'],
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  {
    id: 'alias',
    label: 'Research',
    members: [member('research')],
    activeId: 'research',
    folders: [],
    aliases: [{ folder: 'C:\\work', alias: 'Auth Work' }],
    createdAtMs: 1,
    updatedAtMs: 1,
  },
];

describe('resolveLaunchBinding', () => {
  const throwing: LaunchAliasDeps = {
    customTitleById: () => Promise.reject(new Error('catalog must not be read')),
    latestCustomTitleInFolder: () => Promise.reject(new Error('catalog must not be read')),
  };

  it('routes a resume of the bound alias to the alias group, outranking the folder binding', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--resume', ' auth WORK '],
      groups: GROUPS,
      platform: 'win32',
      aliasDeps: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias' });
    expect(res.alias).toBe(' auth WORK ');
  });

  it('routes another launch in the same folder by the folder rule', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--name', 'other'],
      groups: GROUPS,
      platform: 'win32',
      aliasDeps: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder' });
  });

  it('reads the catalog only when an alias is bound in the launch folder', async () => {
    // C:\elsewhere has no alias scope, so even `-c` needs no catalog read (the throwing deps prove it).
    const res = await resolveLaunchBinding({
      folder: 'C:\\elsewhere',
      args: ['-c'],
      groups: GROUPS,
      platform: 'win32',
      aliasDeps: throwing,
    });
    expect(res).toEqual({ binding: null, alias: null });
  });

  it('an alias bound in the PARENT folder does not apply in a subfolder', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work\\sub',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      aliasDeps: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder', folder: 'C:\\work' });
  });

  it('--continue resolves through the catalog', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--continue'],
      groups: GROUPS,
      platform: 'win32',
      aliasDeps: {
        customTitleById: () => Promise.resolve(null),
        latestCustomTitleInFolder: () => Promise.resolve('Auth Work'),
      },
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias' });
  });
});

describe('buildWhereView', () => {
  const live = new Map<`group:${string}` | 'global', string | null>([
    ['group:folder', 'work'],
    ['group:alias', 'research'],
  ]);

  it('lists the aliases bound in exactly this folder beside the folder rule', () => {
    const view = buildWhereView('c:\\WORK', GROUPS, live, 'win32', 'C:\\vault');
    expect(view.bound).toMatchObject({ groupLabel: 'Work', matchedFolder: 'C:\\work' });
    expect(view.aliases).toEqual([
      {
        alias: 'Auth Work',
        groupLabel: 'Research',
        members: ['research'],
        liveMemberLabel: 'research',
      },
    ]);
  });

  it('a subfolder inherits the folder rule but not the alias scope', () => {
    const view = buildWhereView('C:\\work\\sub', GROUPS, live, 'win32', 'C:\\vault');
    expect(view.bound?.groupLabel).toBe('Work');
    expect(view.aliases).toBeUndefined();
  });

  it('an unbound folder with an alias scope shows only the alias', () => {
    const only = [GROUPS[1]!];
    const view = buildWhereView('C:\\work', only, live, 'win32', 'C:\\vault');
    expect(view.bound).toBeNull();
    expect(view.aliases?.map((a) => a.alias)).toEqual(['Auth Work']);
  });
});
