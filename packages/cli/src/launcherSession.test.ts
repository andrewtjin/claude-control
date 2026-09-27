// Which session a `cctl claude` launch opens, read from Claude Code's own arguments — and the
// binding that session resolves to.
//
// The parse must read argv the way Claude Code 2.1.283 does, or a flag's VALUE would be taken for a
// flag (`--append-system-prompt --resume` resumes nothing) and a launch would be routed to the wrong
// account; where it cannot tell, it must say so rather than guess. It must also never touch the
// argv: the launcher spawns the caller's array as is. The table below pins each rule that matters;
// the resolution tests pin the session(s) each form opens, and the binding tests the precedence rule
// applied to them (the alias scope matched against each session's RECORDED folder).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDirStem, type StoredGroup } from '@claude-control/switch-engine';
import {
  parseClaudeSessionArgs,
  resolveLaunchSessions,
  type ClaudeSessionArgs,
  type LaunchSessionContext,
  type LaunchSessionDeps,
  type LaunchSessionFacts,
} from './launcher.js';
import { buildWhereView, resolveLaunchBinding, uncertainLaunchNote } from './bindCommands.js';
import { launchSessionStore } from './launchSessionStore.js';

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
    parsed({ resume: null, print: true }),
  ],
  [
    'a REQUIRED value is taken even when it looks like a flag',
    ['--append-system-prompt', '--resume', 'x'],
    parsed(),
  ],
  [
    'a REQUIRED value is taken even when it is --, so options after it still parse',
    ['--model', '--', '--resume', 'x'],
    parsed({ resume: 'x' }),
  ],
  [
    'the text after --name is the name even when dash-led',
    ['--name', '--resume'],
    parsed({ name: '--resume' }),
  ],
  ['--continue', ['--continue'], parsed({ continue: true })],
  ['-c', ['-c'], parsed({ continue: true })],
  ['combined short booleans -pc expand', ['-pc', 'hi'], parsed({ continue: true, print: true })],
  [
    'combined -cr: -c then -r taking the next token',
    ['-cr', 'Auth Work'],
    parsed({ continue: true, resume: 'Auth Work' }),
  ],
  [
    'combined -pn: -p then -n taking the next token',
    ['-pn', 'x'],
    parsed({ name: 'x', print: true }),
  ],
  [
    'combined -pcrX: -p, -c, then -r with the rest attached',
    ['-pcrX'],
    parsed({ continue: true, resume: 'X', print: true }),
  ],
  ['-nX attaches the name', ['-nX'], parsed({ name: 'X' })],
  ['-d2e is one flag, not -d with the value "2e"', ['-d2e', '-c'], parsed({ continue: true })],
  ['--name <v>', ['--name', 'Probe Alias'], parsed({ name: 'Probe Alias' })],
  ['-n <v>', ['-n', 'x'], parsed({ name: 'x' })],
  ['--name=<v>', ['--name=x y'], parsed({ name: 'x y' })],
  ['an empty --name names nothing', ['--name', ''], parsed()],
  ['an empty --name= names nothing', ['--name='], parsed()],
  ['the LAST --name wins, even an empty one', ['--name', 'x', '-n', ''], parsed()],
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
    'a variadic option with an attached value takes no further values (commander)',
    ['--add-dir=a', 'mcp', 'list'],
    parsed({ subcommand: 'mcp' }),
  ],
  [
    'a subcommand owns everything after it (mcp add --name is not a session name)',
    ['mcp', 'add', '--name', 'x'],
    parsed({ subcommand: 'mcp' }),
  ],
  [
    'an option unknown to the root table AFTER a subcommand belongs to the subcommand',
    ['mcp', 'add', '--transport', 'http', '--name', 'x'],
    parsed({ subcommand: 'mcp' }),
  ],
  [
    'a subcommand word AFTER a prompt is just text',
    ['look at', 'mcp', '--name', 'n'],
    parsed({ name: 'n' }),
  ],
  [
    'root options before the subcommand do not stop it being one',
    ['--name', 'x', 'mcp', 'list'],
    parsed({ name: 'x', subcommand: 'mcp' }),
  ],
  [
    'a first operand after -- still names a subcommand',
    ['--', 'mcp'],
    parsed({ subcommand: 'mcp' }),
  ],
  ['an operand before -- means the word after it is text', ['hi', '--', 'mcp'], parsed()],
  // Previously an unrecognized option was read as a boolean and the parse carried on; now the parse
  // refuses to guess whenever a session option follows one, because a newer Claude Code may give
  // that option a value and swallow the session option.
  [
    'an unrecognized option before a session option makes the parse uncertain',
    ['--some-new-flag', '--resume', 'x'],
    parsed({ resume: 'x', uncertain: 'unrecognized option "--some-new-flag"' }),
  ],
  [
    'an unrecognized option AFTER every session option leaves the parse certain',
    ['--resume', 'x', '--some-new-flag'],
    parsed({ resume: 'x' }),
  ],
  [
    'an unrecognized option with no session option after it leaves the parse certain',
    ['--some-new-flag', 'hello'],
    parsed(),
  ],
  [
    'a session option after -- still counts (the unknown option may have taken -- as its value)',
    ['--some-new-flag', '--', '--resume', 'x'],
    parsed({ uncertain: 'unrecognized option "--some-new-flag"' }),
  ],
  [
    'a session option the known tables swallowed still counts',
    ['--some-new-flag', '--model', '--resume', 'x'],
    parsed({ uncertain: 'unrecognized option "--some-new-flag"' }),
  ],
  [
    'an unrecognized short flag inside a combined token: its remaining letters may be session flags',
    ['-pzc'],
    parsed({ uncertain: 'unrecognized option "-z"', print: true }),
  ],
  [
    'an unrecognized short flag with no session letters and nothing after is certain',
    ['-zq'],
    parsed(),
  ],
  [
    'a boolean given =value is not an option commander knows',
    ['--continue=1', '--name', 'x'],
    parsed({ name: 'x', uncertain: 'unrecognized option "--continue"' }),
  ],
  [
    'the reason names the option, never its attached value',
    ['--new-flag=secret text', '-c'],
    parsed({ continue: true, uncertain: 'unrecognized option "--new-flag"' }),
  ],
  [
    'an unrecognized option before a subcommand word is uncertain when a session option follows',
    ['--some-new-flag', 'mcp', '--name', 'x'],
    parsed({ subcommand: 'mcp', uncertain: 'unrecognized option "--some-new-flag"' }),
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

  it('shortens a very long unrecognized option name in the reason', () => {
    const long = `--${'x'.repeat(200)}`;
    const reason = parseClaudeSessionArgs([long, '-c']).uncertain ?? '';
    expect(reason.length).toBeLessThan(80);
    expect(reason).toContain('...');
  });
});

// Claude Code 2.1.283's option table, restated from its bundle. Each group is checked against the
// launcher's parse so a table entry that drifts (dropped, or filed under the wrong arity) fails here.
const REQUIRED = [
  '--prefill',
  '--prefill-b64',
  '--deep-link-repo',
  '--deep-link-last-fetch',
  '--deep-link-cwd-b64',
  '--handle-uri',
  '--settings',
  '--managed-settings',
  '--setting-sources',
  '--client-data-url',
  '--watch-artifact',
  '--watch-artifact-no-autoreact',
  '--team-name',
  '--agent-id',
  '--agent-name',
  '--agent-color',
  '--parent-session-id',
  '--agent-type',
  '--model',
  '--agent',
  '--routine',
  '--effort',
  '--permission-mode',
  '--inherit-permission-mode',
  '--proactivity',
  '--debug-file',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-snapshot',
  '--append-subagent-system-prompt',
  '--append-subagent-system-prompt-file',
  '--plan-mode-instructions',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--json-schema',
  '--fallback-model',
  '--advisor',
  '--agents',
  '--plugin-dir',
  '--plugin-dir-no-mcp',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--sdk-url',
  '--exec',
  '-m',
  '--thinking',
  '--thinking-display',
  '--max-thinking-tokens',
  '--max-turns',
  '--max-budget-usd',
  '--task-budget',
  '--autocompact',
  '--rewind-files',
  '--resume-session-at',
  '--resume-drops-turn',
  '--workload',
  '--output-format',
  '--input-format',
  '--teammate-mode',
  '--messaging-socket-path',
  '--environment',
  '--pool',
  '--ref',
  '--on-branch',
  '--correlation-id',
  '--forward-home-settings',
  '--project-config-root',
  '--attach-serve',
];
const VARIADIC = [
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--file',
  '--channels',
  '--dangerously-load-development-channels',
];
const OPTIONAL = [
  '-d',
  '--debug',
  '--from-pr',
  '-w',
  '--worktree',
  '--teleport',
  '--cloud',
  '--remote',
  '--project',
  '--remote-control',
  '--rc',
  '--prompt-suggestions',
];
const BOOLEAN = [
  '-d2e',
  '--debug-to-stderr',
  '--verbose',
  '-p',
  '--print',
  '--bare',
  '--safe-mode',
  '--init',
  '--init-only',
  '--maintenance',
  '--include-hook-events',
  '--include-partial-messages',
  '--forward-subagent-text',
  '--session-mirror',
  '--await-claim',
  '--await-initialize',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--replay-user-messages',
  '--enable-auth-status',
  '--restricted',
  '--exclude-dynamic-system-prompt-sections',
  '--deep-link-origin',
  '--no-session-persistence',
  '--reply-on-resume',
  '--ide',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--chrome',
  '--no-chrome',
  '--tmux',
  '--enable-auto-mode',
  '--brief',
  '--ax-screen-reader',
  '--plan-mode-required',
  '-h',
  '--help',
  '-v',
  '--version',
];

describe('the option table matches Claude Code 2.1.283', () => {
  // The options the launcher once missed. Measured for --prefill and --plan-mode-instructions: Claude
  // Code opened a NEW, UNNAMED session, while reading them as booleans routed by "Auth Work".
  const ONCE_MISSING = [
    '--prefill',
    '--prefill-b64',
    '--deep-link-repo',
    '--deep-link-last-fetch',
    '--deep-link-cwd-b64',
    '--managed-settings',
    '--client-data-url',
    '--watch-artifact',
    '--watch-artifact-no-autoreact',
    '--inherit-permission-mode',
    '--system-prompt-snapshot',
    '--append-subagent-system-prompt',
    '--append-subagent-system-prompt-file',
    '--plan-mode-instructions',
    '--permission-prompts',
    '--plugin-dir-no-mcp',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--thinking-display',
    '--resume-drops-turn',
    '--messaging-socket-path',
    '--environment',
    '--pool',
    '--ref',
    '--on-branch',
    '--correlation-id',
    '--forward-home-settings',
    '--project-config-root',
    '--attach-serve',
  ];
  it.each(ONCE_MISSING)('%s <value> consumes its value; the next token is not --name', (opt) => {
    // Claude Code: opt = "--name", "Auth Work" is the prompt, the session is unnamed.
    expect(parseClaudeSessionArgs([opt, '--name', 'Auth Work'])).toEqual(parsed());
  });
  it.each(ONCE_MISSING)('%s <value> consumes its value; the next token is not --resume', (opt) => {
    expect(parseClaudeSessionArgs([opt, '--resume', 'Auth Work'])).toEqual(parsed());
  });

  it.each(REQUIRED)('%s takes a REQUIRED value (even a dash-led one)', (opt) => {
    expect(parseClaudeSessionArgs([opt, '-c', '--resume', 'x'])).toEqual(parsed({ resume: 'x' }));
  });
  it.each(VARIADIC)('%s is VARIADIC: it keeps taking values until an option', (opt) => {
    expect(parseClaudeSessionArgs([opt, '-c', 'mcp', '--name', 'n'])).toEqual(
      parsed({ name: 'n' }),
    );
  });
  it.each(OPTIONAL)(
    '%s takes an OPTIONAL value only when it does not look like an option',
    (opt) => {
      expect(parseClaudeSessionArgs([opt, 'v', '-c'])).toEqual(parsed({ continue: true }));
      expect(parseClaudeSessionArgs([opt, '-c'])).toEqual(parsed({ continue: true }));
    },
  );
  it.each(BOOLEAN)('%s is a known boolean: never uncertain, never takes a value', (opt) => {
    const print = opt === '-p' || opt === '--print' ? { print: true as const } : {};
    expect(parseClaudeSessionArgs([opt, 'mcp', '--name', 'n'])).toEqual(
      parsed({ subcommand: 'mcp', ...print }),
    );
  });
});

describe('subcommands and paths that open no session', () => {
  it.each([
    'gateway',
    'auth',
    'project',
    'setup-token',
    'agents',
    'ultrareview',
    'auto-mode',
    'remote-control',
    'rc',
    'doctor',
    'sandbox',
    'update',
    'upgrade',
    'install',
    'import',
    'import-conversations',
    'mcp',
    'plugin',
    'plugins',
  ])('%s is a root subcommand: nothing after it opens a session', (sub) => {
    expect(parseClaudeSessionArgs([sub, '--name', 'Auth Work'])).toEqual(
      parsed({ subcommand: sub }),
    );
    // And as the first operand after root options.
    expect(parseClaudeSessionArgs(['-p', sub, '--name', 'Auth Work']).subcommand).toBe(sub);
  });

  // Not root commands in 2.1.283: `claude config --name "Auth Work"` starts a session NAMED "Auth
  // Work" with the prompt "config".
  it.each(['login', 'logout', 'config', 'migrate-installer', 'eval'])(
    '%s is only prompt text in 2.1.283, so a following --name still names the session',
    (word) => {
      expect(parseClaudeSessionArgs([word, '--name', 'Auth Work'])).toEqual(
        parsed({ name: 'Auth Work' }),
      );
    },
  );

  it.each([
    'remote-control',
    'rc',
    'remote',
    'sync',
    'bridge',
    'logs',
    'attach',
    'stop',
    'kill',
    'respawn',
    'rm',
  ])('the fast path %s is decided on the first word only', (word) => {
    expect(parseClaudeSessionArgs([word, '--name', 'Auth Work'])).toEqual(
      parsed({ subcommand: word }),
    );
  });

  it.each(['remote', 'sync', 'bridge', 'logs', 'attach', 'stop', 'kill', 'respawn', 'rm'])(
    'the fast-path word %s later in the argv is prompt text',
    (word) => {
      expect(parseClaudeSessionArgs(['-p', word, '--name', 'Auth Work'])).toEqual(
        parsed({ name: 'Auth Work', print: true }),
      );
    },
  );

  it.each([
    [['daemon', '--name', 'x']],
    [['--dangerously-skip-permissions', 'daemon', '--name', 'x']],
    [['--allow-dangerously-skip-permissions', '--dangerously-skip-permissions', 'daemon']],
  ])('daemon after only the skip-permission flags is a fast path: %j', (args) => {
    expect(parseClaudeSessionArgs(args)).toEqual(parsed({ subcommand: 'daemon' }));
  });

  it('daemon after any other option is prompt text', () => {
    expect(parseClaudeSessionArgs(['-p', 'daemon', '--name', 'x'])).toEqual(
      parsed({ name: 'x', print: true }),
    );
  });

  it.each([
    [['--bg', '--resume', 'Auth Work']],
    [['--resume', 'Auth Work', '--background']],
    [['--name', '--bg']],
    [['--', '--bg']],
  ])('--bg / --background anywhere takes the background path, which is uncertain: %j', (args) => {
    const got = parseClaudeSessionArgs(args);
    expect(got.uncertain).toMatch(/^"--(bg|background)" starts a background session$/);
  });
});

/** Facts for a session a stand-in store returns (with its project directory when given). */
const facts = (
  customTitle: string | null,
  folder: string | null = 'C:\\work',
  aiTitle: string | null = null,
  dirName?: string,
): LaunchSessionFacts => ({
  customTitle,
  aiTitle,
  folder,
  ...(dirName !== undefined ? { dirName } : {}),
});

/** A stand-in session store that records every lookup it is asked. */
function store(answers: {
  byId?: Record<string, LaunchSessionFacts>;
  atPath?: Record<string, LaunchSessionFacts>;
  titled?: LaunchSessionFacts[];
  continued?: LaunchSessionFacts[];
}) {
  const asked: string[] = [];
  const deps: LaunchSessionDeps = {
    sessionById: (id) => {
      asked.push(`id:${id}`);
      return Promise.resolve(answers.byId?.[id] ?? null);
    },
    sessionAtPath: (file) => {
      asked.push(`path:${file}`);
      return Promise.resolve(answers.atPath?.[file] ?? null);
    },
    sessionsTitled: (text) => {
      asked.push(`title:${text}`);
      return Promise.resolve(answers.titled ?? []);
    },
    continueSessions: () => {
      asked.push('continue');
      return Promise.resolve(answers.continued ?? []);
    },
  };
  return { deps, asked };
}

/** The resolver's context: launch folder C:\work, with these alias keys bound. */
const ctx = (...bound: string[]): LaunchSessionContext => ({
  launchFolder: 'C:\\work',
  boundAliasKeys: new Set(bound),
  platform: 'win32',
});

/** The candidates a launch resolves to (failing on an uncertain result). */
async function candidates(args: string[], deps: LaunchSessionDeps, context: LaunchSessionContext) {
  const got = await resolveLaunchSessions(parseClaudeSessionArgs(args), deps, context);
  if (got.kind !== 'candidates') throw new Error(`uncertain: ${got.reason}`);
  return got.candidates;
}

describe('resolveLaunchSessions', () => {
  // Claude Code's action handler is `if (opts.continue) { ...continue the latest... } else if
  // (opts.resume ...)` in BOTH the interactive and the print path. Measured: with the latest
  // session titled "Other", `claude -p -c --resume "Auth Work"` (either order) opened "Other".
  it.each([
    [['-c', '--resume', 'Auth Work']],
    [['--resume', 'Auth Work', '-c']],
    [['--continue', '-r', 'Auth Work']],
    [['-cr', 'Auth Work']],
  ])('%j opens the LATEST session: --continue beats --resume', async (argv) => {
    const { deps, asked } = store({ continued: [facts('Other')] });
    expect(await candidates(argv, deps, ctx('auth work', 'other'))).toEqual([
      { title: 'Other', folder: 'C:\\work' },
    ]);
    expect(asked).toEqual(['continue']);
  });

  // Measured: `claude -p --name "" --resume "Auth Work"` resumed "Auth Work" with its title intact.
  it('an empty --name does not override the resumed session’s title', async () => {
    const { deps } = store({ titled: [facts('Auth Work')] });
    expect(
      await candidates(['--name', '', '--resume', 'Auth Work'], deps, ctx('auth work')),
    ).toEqual([{ title: 'Auth Work', folder: 'C:\\work' }]);
  });

  it('--resume <title>: every match, each under its own title and recorded folder', async () => {
    const { deps, asked } = store({
      titled: [facts('Auth Work', 'C:\\work\\sub'), facts('auth work ', 'C:\\work-other')],
    });
    expect(await candidates(['-r', 'Auth Work'], deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: 'C:\\work\\sub' },
      { title: 'auth work ', folder: 'C:\\work-other' },
    ]);
    expect(asked).toEqual(['title:Auth Work']);
  });

  it('a match found only by its GENERATED title opens unnamed', async () => {
    const { deps } = store({ titled: [facts(null, 'C:\\work', 'Fix Parser')] });
    expect(await candidates(['-r', 'Fix Parser'], deps, ctx('fix parser'))).toEqual([
      { title: null, folder: 'C:\\work' },
    ]);
  });

  it('a resume title bound nowhere reads nothing: no match could route by alias', async () => {
    const { deps, asked } = store({ titled: [facts('Unbound')] });
    expect(await candidates(['-r', 'Unbound'], deps, ctx('auth work'))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('a --name bound nowhere reads nothing, whatever it resumes or continues', async () => {
    for (const args of [
      ['-c', '-n', 'x'],
      ['-r', 'Auth Work', '-n', 'x'],
      ['-r', ID, '-n', 'x'],
    ]) {
      const { deps, asked } = store({ continued: [facts('Auth Work')] });
      expect(await candidates(args, deps, ctx('auth work'))).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it('a bound --name renames what opens: the resume text need not be bound', async () => {
    const { deps, asked } = store({
      titled: [facts('Unbound', 'C:\\a'), facts(null, 'C:\\b', 'unbound')],
    });
    expect(
      await candidates(['-r', 'Unbound', '--name', 'Auth Work'], deps, ctx('auth work')),
    ).toEqual([
      { title: 'Auth Work', folder: 'C:\\a' },
      { title: 'Auth Work', folder: 'C:\\b' },
    ]);
    expect(asked).toEqual(['title:Unbound']);
  });

  it('--resume <uuid> is that session (only that one looked up); unknown -> none', async () => {
    const { deps, asked } = store({ byId: { [ID]: facts('Auth Work', 'C:\\x') } });
    expect(await candidates(['--resume', ID], deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: 'C:\\x' },
    ]);
    expect(asked).toEqual([`id:${ID}`]);
    const none = store({});
    expect(await candidates(['--resume', ID], none.deps, ctx('auth work'))).toEqual([]);
  });

  // Claude Code: `isAbsolute(v) && v.endsWith('.jsonl')` resumes FROM THAT FILE, never matched as a
  // title. Measured: `-p --resume <abs path of the "Auth Work" transcript>` resumed that session.
  it('--resume <absolute .jsonl> is that transcript, not a title', async () => {
    const file = 'C:\\t\\a.jsonl';
    const { deps, asked } = store({ atPath: { [file]: facts('Auth Work', 'C:\\t') } });
    expect(await candidates(['--resume', file], deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: 'C:\\t' },
    ]);
    expect(asked).toEqual([`path:${file}`]);
  });

  it('a relative .jsonl, or a POSIX-absolute one on Windows rules, is judged per platform', async () => {
    const rel = store({});
    await candidates(['--resume', 'a.jsonl'], rel.deps, ctx('a.jsonl'));
    expect(rel.asked).toEqual(['title:a.jsonl']);
    const posixAbs = store({});
    await candidates(['--resume', '/t/a.jsonl'], posixAbs.deps, {
      ...ctx('/t/a.jsonl'),
      platform: 'linux',
    });
    expect(posixAbs.asked).toEqual(['path:/t/a.jsonl']);
    const winOnPosix = store({});
    await candidates(['--resume', 'C:\\t\\a.jsonl'], winOnPosix.deps, {
      ...ctx('c:\\t\\a.jsonl'),
      platform: 'linux',
    });
    expect(winOnPosix.asked).toEqual(['title:C:\\t\\a.jsonl']);
  });

  it('a bare --resume or a blank title opens the picker: nothing nameable, nothing read', async () => {
    for (const args of [['--resume'], ['--resume', '  '], ['--resume=']]) {
      const { deps, asked } = store({});
      expect(await candidates(args, deps, ctx('auth work', ''))).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it('--name wins on a new session, a resume, or a fork', async () => {
    const { deps } = store({ byId: { [ID]: facts('old') } });
    expect(await candidates(['--name', 'new'], deps, ctx('new'))).toEqual([
      { title: 'new', folder: 'C:\\work' },
    ]);
    expect(await candidates(['-r', ID, '--fork-session', '-n', 'n'], deps, ctx('n'))).toEqual([
      { title: 'n', folder: 'C:\\work' },
    ]);
  });

  it('an interactive title search leaves out sessions started by -p or the SDK; a -p launch keeps them', async () => {
    // Measured: interactive `claude --resume "<title>"` reports no match for a session whose
    // transcript records entrypoint "sdk-cli".
    const sdk = { ...facts('Auth Work'), entrypoint: 'sdk-cli' };
    const tui = { ...facts('Auth Work', 'C:\\tui'), entrypoint: 'cli' };
    const { deps } = store({ titled: [sdk, tui] });
    expect(await candidates(['-r', 'Auth Work'], deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: 'C:\\tui' },
    ]);
    expect(await candidates(['-p', '-r', 'Auth Work'], deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: 'C:\\work' },
      { title: 'Auth Work', folder: 'C:\\tui' },
    ]);
  });

  it('a fork keeps the resumed title but is a new conversation of the LAUNCH folder', async () => {
    // Measured: a fork of a session recorded in repo/sub, launched from repo, is written to repo's
    // project directory with every cwd rewritten to repo.
    const { deps } = store({ titled: [facts('Auth Work', 'C:\\work\\sub')] });
    expect(await candidates(['-r', 'Auth Work', '--fork-session'], deps, ctx('auth work'))).toEqual(
      [{ title: 'Auth Work', folder: 'C:\\work' }],
    );
    const byId = store({ byId: { [ID]: facts('Auth Work', 'C:\\elsewhere') } });
    expect(await candidates(['--fork-session', '-r', ID], byId.deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: 'C:\\work' },
    ]);
  });

  it('-c --fork-session: every session --continue may open becomes a conversation of the launch folder', async () => {
    const { deps } = store({
      continued: [facts('Other', 'C:\\a-b'), facts('Auth Work', 'C:\\a_b', null, 'C--a-b')],
    });
    expect(await candidates(['-c', '--fork-session'], deps, ctx('auth work'))).toEqual([
      { title: 'Other', folder: 'C:\\work' },
      { title: 'Auth Work', folder: 'C:\\work' },
    ]);
  });

  it('--fork-session without --resume or --continue changes nothing', async () => {
    const { deps } = store({ byId: { [ID]: facts('Existing', 'C:\\old') } });
    expect(await candidates(['--session-id', ID, '--fork-session'], deps, ctx('existing'))).toEqual(
      [{ title: 'Existing', folder: 'C:\\old' }],
    );
  });

  it('an existing session carries its project directory for the fallback', async () => {
    const { deps } = store({ titled: [facts('Auth Work', null, null, 'C--work')] });
    expect(await candidates(['-r', 'Auth Work'], deps, ctx('auth work'))).toEqual([
      { title: 'Auth Work', folder: null, dirName: 'C--work' },
    ]);
  });

  it('--session-id alone names an existing session, else a new one; a malformed id none', async () => {
    const { deps } = store({ byId: { [ID]: facts('Existing', 'C:\\old') } });
    expect(await candidates(['--session-id', ID], deps, ctx('existing'))).toEqual([
      { title: 'Existing', folder: 'C:\\old' },
    ]);
    const fresh = store({});
    expect(await candidates(['--session-id', ID, '-n', 'n'], fresh.deps, ctx('n'))).toEqual([
      { title: 'n', folder: 'C:\\work' },
    ]);
    const bad = store({});
    expect(await candidates(['--session-id', 'not-a-uuid'], bad.deps, ctx('x'))).toEqual([]);
    expect(bad.asked).toEqual([]);
  });

  it('a subcommand opens no session and reads nothing', async () => {
    const { deps, asked } = store({});
    expect(await candidates(['mcp', 'list'], deps, ctx('x'))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('a plain launch is a new session in the launch folder', async () => {
    const { deps, asked } = store({});
    expect(await candidates(['hello'], deps, ctx('x'))).toEqual([
      { title: null, folder: 'C:\\work' },
    ]);
    expect(asked).toEqual([]);
  });

  it('an uncertain parse is reported, never resolved', async () => {
    const { deps, asked } = store({});
    const got = await resolveLaunchSessions(
      parseClaudeSessionArgs(['--new-flag', '-r', 'Auth Work']),
      deps,
      ctx('auth work'),
    );
    expect(got).toEqual({ kind: 'uncertain', reason: 'unrecognized option "--new-flag"' });
    expect(asked).toEqual([]);
  });
});

// Groups for the binding tests: a folder binding of C:\work, and an alias-only group binding
// "auth work" in C:\work. Win32 spellings, since the rule's folder keys are platform-specific.
const member = (id: string) => ({
  id,
  label: id,
  quarantined: false,
  createdAtMs: 1,
  updatedAtMs: 1,
});
const group = (
  id: string,
  folders: string[],
  aliases: Array<{ folder: string; alias: string }> = [],
): StoredGroup => ({
  id,
  label: id,
  members: [member(id)],
  activeId: id,
  folders,
  ...(aliases.length > 0 ? { aliases } : {}),
  createdAtMs: 1,
  updatedAtMs: 1,
});
const GROUPS: StoredGroup[] = [
  group('folder', ['C:\\work']),
  group('alias', [], [{ folder: 'C:\\work', alias: 'Auth Work' }]),
];

/** A store that fails the test if anything is looked up. */
const throwing: LaunchSessionDeps = {
  sessionById: () => Promise.reject(new Error('store must not be read')),
  sessionAtPath: () => Promise.reject(new Error('store must not be read')),
  sessionsTitled: () => Promise.reject(new Error('store must not be read')),
  continueSessions: () => Promise.reject(new Error('store must not be read')),
};

describe('resolveLaunchBinding', () => {
  // The launcher now finds the session Claude Code will resume and matches the alias scope against
  // THAT session's recorded folder, so the stand-in store supplies a session recorded in C:\work.
  it('routes a resume of the bound alias to the alias group, outranking the folder binding', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--resume', ' auth WORK '],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', 'C:\\work')] }).deps,
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias' });
    expect(res.alias).toBe('Auth Work');
    expect(res.note).toBeNull();
  });

  it('routes another launch in the same folder by the folder rule', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--name', 'other'],
      groups: GROUPS,
      platform: 'win32',
      sessions: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder' });
  });

  it('a new session named after a bound alias routes to it with no read', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--name', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias' });
  });

  it('reads and parses nothing when no binding has an alias scope', async () => {
    // Even arguments that would otherwise be uncertain print no note: no title could matter.
    for (const args of [['-c'], ['-r', 'Auth Work'], ['--new-flag', '-c'], ['--bg']]) {
      const res = await resolveLaunchBinding({
        folder: 'C:\\elsewhere',
        args,
        groups: [GROUPS[0]!],
        platform: 'win32',
        sessions: throwing,
      });
      expect(res).toEqual({ binding: null, alias: null, note: null });
    }
  });

  // Previously the catalog was read only when an alias was bound in the launch folder itself. A
  // session resumed from one folder can now be recorded in another, so any bound alias key can
  // matter; the title check alone decides whether to read.
  it('reads nothing when the resumed title is bound nowhere', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\elsewhere',
      args: ['-r', 'Unbound Title'],
      groups: GROUPS,
      platform: 'win32',
      sessions: throwing,
    });
    expect(res).toEqual({ binding: null, alias: null, note: null });
  });

  it('an alias bound in the PARENT folder does not apply to a session recorded in a subfolder', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work\\sub',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', 'C:\\work\\sub')] }).deps,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder', folder: 'C:\\work' });
  });

  it('--continue resolves through the store', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--continue'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ continued: [facts('Auth Work', 'C:\\work')] }).deps,
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias' });
  });

  it('matches the alias scope against the RECORDED folder, not the launch folder', async () => {
    const groups = [
      group('root', ['C:\\repo']),
      group('sub', [], [{ folder: 'C:\\repo\\sub', alias: 'X' }]),
      group('rootAlias', [], [{ folder: 'C:\\repo', alias: 'Y' }]),
    ];
    // A session recorded in C:\repo\sub, resumed by title from C:\repo -> the (C:\repo\sub, X) scope.
    const sub = await resolveLaunchBinding({
      folder: 'C:\\repo',
      args: ['-r', 'X'],
      groups,
      platform: 'win32',
      sessions: store({ titled: [facts('X', 'C:\\repo\\sub')] }).deps,
    });
    expect(sub.binding).toMatchObject({ groupId: 'sub', via: 'alias', folder: 'C:\\repo\\sub' });
    // A same-titled session recorded in the prefix sibling C:\repo-other is NOT the (C:\repo, Y)
    // scope's session: it launches by the folder rule of the launch folder.
    const other = await resolveLaunchBinding({
      folder: 'C:\\repo',
      args: ['-r', 'Y'],
      groups,
      platform: 'win32',
      sessions: store({ titled: [facts('Y', 'C:\\repo-other')] }).deps,
    });
    expect(other.binding).toMatchObject({ groupId: 'root', via: 'folder' });
  });

  it('canonicalizes a recorded folder before matching it', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', 'c:/WORK/')] }).deps,
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias' });
    // The launcher's own canonicalizer is the one used when given.
    const seen: string[] = [];
    await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', 'D:\\junction')] }).deps,
      canonicalFolder: (f) => {
        seen.push(f);
        return 'C:\\work';
      },
    });
    expect(seen).toEqual(['D:\\junction']);
  });

  it('a session that records no folder cannot route by alias', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', null)] }).deps,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder' });
  });

  it('with no trusted folder, its project directory stands for the launch folder only when it can', async () => {
    // The guard's fallback exactly (switch-engine recordedFolderFor): the directory named after the
    // launch folder as Claude Code spells it (here a link to the launch folder) counts as the launch
    // folder's; a directory the launch folder's name cannot produce counts for no folder.
    const here = await resolveLaunchBinding({
      folder: 'C:\\work',
      launchSpelling: 'C:\\link',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', null, null, 'C--link')] }).deps,
    });
    expect(here.binding).toMatchObject({ groupId: 'alias', via: 'alias', folder: 'C:\\work' });
    const elsewhere = await resolveLaunchBinding({
      folder: 'C:\\work',
      launchSpelling: 'C:\\link',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({ titled: [facts('Auth Work', null, null, 'C--work-sub')] }).deps,
    });
    expect(elsewhere.binding).toMatchObject({ groupId: 'folder', via: 'folder' });
  });

  it('a fork of a bound conversation launched from ANOTHER folder follows that folder', async () => {
    const groups = [group('sub', [], [{ folder: 'C:\\repo\\sub', alias: 'X' }])];
    const sessions = store({ titled: [facts('X', 'C:\\repo\\sub')] }).deps;
    const resumed = await resolveLaunchBinding({
      folder: 'C:\\repo',
      args: ['-r', 'X'],
      groups,
      platform: 'win32',
      sessions,
    });
    expect(resumed.binding).toMatchObject({ groupId: 'sub', via: 'alias' });
    const forked = await resolveLaunchBinding({
      folder: 'C:\\repo',
      args: ['-r', 'X', '--fork-session'],
      groups,
      platform: 'win32',
      sessions,
    });
    expect(forked.binding).toBeNull();
    // Forked in its own folder it stays bound.
    const here = await resolveLaunchBinding({
      folder: 'C:\\repo\\sub',
      args: ['-r', 'X', '--fork-session'],
      groups,
      platform: 'win32',
      sessions,
    });
    expect(here.binding).toMatchObject({ groupId: 'sub', via: 'alias' });
  });

  it('several candidates that map to DIFFERENT targets launch by the folder rule', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({
        titled: [facts('Auth Work', 'C:\\work'), facts('Auth Work', 'C:\\elsewhere')],
      }).deps,
    });
    expect(res).toEqual({
      binding: { groupId: 'folder', via: 'folder', folder: 'C:\\work' },
      alias: null,
      note: null,
    });
  });

  it('several candidates that map to ONE target route to it', async () => {
    const groups = [
      group('folder', ['C:\\work']),
      group(
        'alias',
        [],
        [
          { folder: 'C:\\work', alias: 'Auth Work' },
          { folder: 'C:\\work\\sub', alias: 'Auth Work' },
        ],
      ),
    ];
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['-r', 'Auth Work'],
      groups,
      platform: 'win32',
      sessions: store({
        titled: [facts('Auth Work', 'C:\\work'), facts('auth work', 'C:\\work\\sub')],
      }).deps,
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias', folder: 'C:\\work' });
    // All-global candidates agree too: an unbound launch folder with every match unbound.
    const global = await resolveLaunchBinding({
      folder: 'C:\\free',
      args: ['-r', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: store({
        titled: [facts('Auth Work', 'C:\\free'), facts(null, 'C:\\free2', 'auth work')],
      }).deps,
    });
    expect(global.binding).toBeNull();
  });

  it('an uncertain parse launches by the folder rule and returns the note', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--new-flag', '--resume', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder' });
    expect(res.note).toBe(
      'cctl: could not tell which session these arguments open (unrecognized option ' +
        '"--new-flag"); launching by the folder rule — the enforcement guard checks the session ' +
        'Claude Code opens\n',
    );
  });

  it('--bg launches by the folder rule with the note', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--bg', '--resume', 'Auth Work'],
      groups: GROUPS,
      platform: 'win32',
      sessions: throwing,
    });
    expect(res.binding).toMatchObject({ groupId: 'folder', via: 'folder' });
    expect(res.note).toContain('"--bg" starts a background session');
  });

  // End to end for the forms Claude Code measured differently than the launcher once read them.
  const ALIAS_ONLY = [group('alias', [], [{ folder: 'C:\\work', alias: 'Auth Work' }])];
  it('-c --resume "Auth Work" when the latest session is unbound "Other" belongs on the global slot', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['-c', '--resume', 'Auth Work'],
      groups: ALIAS_ONLY,
      platform: 'win32',
      sessions: store({ continued: [facts('Other')], titled: [facts('Auth Work')] }).deps,
    });
    expect(res.binding).toBeNull();
  });

  it('--prefill --resume "Auth Work" opens a NEW unnamed session, which belongs on the global slot', async () => {
    const res = await resolveLaunchBinding({
      folder: 'C:\\work',
      args: ['--prefill', '--resume', 'Auth Work'],
      groups: ALIAS_ONLY,
      platform: 'win32',
      sessions: throwing,
    });
    expect(res.binding).toBeNull();
  });
});

describe('uncertainLaunchNote', () => {
  it('strips terminal control sequences an operator-supplied option name carries', () => {
    const note = uncertainLaunchNote('unrecognized option "--x\u001b[31m\r\nFAKE"');
    expect(note).not.toContain('\u001b');
    expect(note).not.toContain('\r');
    expect(note.indexOf('\n')).toBe(note.length - 1);
  });
});

// The same decisions against real transcripts on disk, through the store the launcher uses.
describe('resolveLaunchBinding over real transcripts', () => {
  let claudeDir: string;
  let base: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'cctl-launch-claude-'));
    base = mkdtempSync(join(tmpdir(), 'cctl-launch-work-'));
  });
  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  /** Write one transcript for a session recorded in `cwd` with these extra lines. */
  function transcript(cwd: string, id: string, lines: object[]): string {
    const dir = join(claudeDir, 'projects', projectDirStem(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const body = [{ type: 'user', cwd, message: { role: 'user', content: 'hi' } }, ...lines];
    writeFileSync(file, body.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }
  const aliasGroup = (folder: string, alias: string): StoredGroup =>
    group('alias', [], [{ folder, alias }]);

  // Claude Code resumes by `(customTitle ?? aiTitle)`, but only a custom title binds and the guard
  // sees an ai-titled session as UNNAMED. Measured: with "Fix Parser" bound to W and the only "Fix
  // Parser" session ai-titled, routing it to W had the guard BLOCK it; plain `claude --resume "Fix
  // Parser"` ran fine on the global account. The launcher must route it as the unnamed session it is.
  it('a resume that matches only a GENERATED title routes by the folder rule', async () => {
    const folder = join(base, 'w');
    mkdirSync(folder);
    transcript(folder, 'aaaaaaaa-0000-4000-8000-000000000009', [
      { type: 'ai-title', aiTitle: 'Fix Parser' },
    ]);
    const res = await resolveLaunchBinding({
      folder,
      args: ['--resume', 'Fix Parser'],
      groups: [aliasGroup(folder, 'Fix Parser')],
      platform: process.platform,
      sessions: launchSessionStore({
        claudeDir,
        cwd: folder,
        platform: process.platform,
        gitWorktrees: () => Promise.resolve([]),
      }),
    });
    expect(res.binding).toBeNull();
  });

  it('--resume <absolute transcript path> routes by that transcript’s own title', async () => {
    const folder = join(base, 'w');
    mkdirSync(folder);
    const file = transcript(folder, 'aaaaaaaa-0000-4000-8000-000000000001', [
      { type: 'custom-title', customTitle: 'Auth Work' },
    ]);
    const res = await resolveLaunchBinding({
      folder: join(base, 'launched-elsewhere'),
      args: ['--resume', file],
      groups: [aliasGroup(folder, 'Auth Work')],
      platform: process.platform,
      sessions: launchSessionStore({ claudeDir, cwd: base, platform: process.platform }),
    });
    expect(res.binding).toMatchObject({ groupId: 'alias', via: 'alias', folder });
    expect(res.alias).toBe('Auth Work');
  });

  it('with two or more worktrees, a title resumed from the repo reaches a subfolder session', async () => {
    const repo = join(base, 'repo');
    const sub = join(repo, 'sub');
    const other = join(base, 'repo-other');
    for (const d of [sub, other]) mkdirSync(d, { recursive: true });
    transcript(sub, 'aaaaaaaa-0000-4000-8000-000000000002', [
      { type: 'custom-title', customTitle: 'X' },
    ]);
    transcript(other, 'aaaaaaaa-0000-4000-8000-000000000003', [
      { type: 'custom-title', customTitle: 'Y' },
    ]);
    const sessions = launchSessionStore({
      claudeDir,
      cwd: repo,
      platform: process.platform,
      gitWorktrees: () => Promise.resolve([repo, join(base, 'repo-wt')]),
    });
    const groups = [
      group('sub', [], [{ folder: sub, alias: 'X' }]),
      group('root', [], [{ folder: repo, alias: 'Y' }]),
    ];
    const routed = await resolveLaunchBinding({
      folder: repo,
      args: ['--resume', 'x'],
      groups,
      platform: process.platform,
      sessions,
    });
    expect(routed.binding).toMatchObject({ groupId: 'sub', via: 'alias', folder: sub });
    // "Y" lives in the prefix sibling repo-other: Claude Code's search reaches it, but it is not the
    // (repo, Y) scope's session, so the launch stays on the folder rule (here: global).
    const notRouted = await resolveLaunchBinding({
      folder: repo,
      args: ['--resume', 'Y'],
      groups,
      platform: process.platform,
      sessions,
    });
    expect(notRouted.binding).toBeNull();
  });
});

describe('buildWhereView', () => {
  const live = new Map<`group:${string}` | 'global', string | null>([
    ['group:folder', 'work'],
    ['group:alias', 'research'],
  ]);
  const WHERE_GROUPS: StoredGroup[] = [
    {
      ...group('folder', ['C:\\work']),
      label: 'Work',
      members: [member('work')],
      activeId: 'work',
    },
    {
      ...group('alias', [], [{ folder: 'C:\\work', alias: 'Auth Work' }]),
      label: 'Research',
      members: [member('research')],
      activeId: 'research',
    },
  ];

  it('lists the aliases bound in exactly this folder beside the folder rule', () => {
    const view = buildWhereView('c:\\WORK', WHERE_GROUPS, live, 'win32', 'C:\\vault');
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
    const view = buildWhereView('C:\\work\\sub', WHERE_GROUPS, live, 'win32', 'C:\\vault');
    expect(view.bound?.groupLabel).toBe('Work');
    expect(view.aliases).toBeUndefined();
  });

  it('an unbound folder with an alias scope shows only the alias', () => {
    const only = [WHERE_GROUPS[1]!];
    const view = buildWhereView('C:\\work', only, live, 'win32', 'C:\\vault');
    expect(view.bound).toBeNull();
    expect(view.aliases?.map((a) => a.alias)).toEqual(['Auth Work']);
  });
});
