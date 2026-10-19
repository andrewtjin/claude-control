import { describe, it, expect } from 'vitest';
import {
  AUTH_LOGIN_TIMEOUT_MS,
  createClaudeSpawner,
  detectAuthLogin,
  loginForRelogin,
  reloginRecoveryHint,
  safeLoginEmail,
  type ClaudeRun,
  type ClaudeRunOptions,
  type ClaudeSpawner,
  type ReloginTarget,
} from './claudeAuthLogin.js';

// Nothing here runs the real `claude`: every login-flow test drives a stub spawner, and the one
// block that exercises real process mechanics spawns `node` instead.

/** Help text shaped like `claude auth login --help` on a build that has the subcommand. */
const AUTH_HELP =
  'Usage: claude auth login [options]\n\nSign in to your Anthropic account\n\nOptions:\n' +
  '  --claudeai       Use Claude subscription (default)\n' +
  '  --console        Use Anthropic Console (API usage billing) account\n' +
  '  --email <email>  Pre-populate email address on the login page\n' +
  '  --sso            Force SSO login flow\n  -h, --help       Display help for command\n';
/** The same help on a build whose `auth login` predates `--email`. */
const AUTH_HELP_NO_EMAIL = AUTH_HELP.replace(/ {2}--email[^\n]*\n/, '');
/** What a build with no `auth` subcommand prints instead: its general help. */
const GENERAL_HELP =
  'Usage: claude [options] [command] [prompt]\n\nOptions:\n  -p, --print  Print response and exit\n';

const ok = (output = ''): ClaudeRun => ({ status: 0, signal: null, output, timedOut: false });

/** A stub spawner answering the probe with `help` (or `probe`, when given whole) and every
 *  other run with `login`, recording each call. */
function stubSpawner(opts: { help?: string; probe?: ClaudeRun; login?: ClaudeRun } = {}) {
  const calls: { args: string[]; options: ClaudeRunOptions }[] = [];
  const spawner: ClaudeSpawner = (args, options) => {
    calls.push({ args: [...args], options });
    if (args.includes('--help')) return Promise.resolve(opts.probe ?? ok(opts.help ?? AUTH_HELP));
    return Promise.resolve(opts.login ?? ok());
  };
  return { spawner, calls };
}

const target: ReloginTarget = { id: 'id-1', label: 'work', emailAddress: 'me@example.com' };
const env = { CLAUDE_CONFIG_DIR: '/sandbox/relogin-x' };

/** Run the login step against a stub, collecting what it printed. */
async function login(
  stub: ReturnType<typeof stubSpawner>,
  opts: { forceWindow?: boolean; target?: ReloginTarget; timeoutMs?: number } = {},
) {
  let printed = '';
  const result = await loginForRelogin(opts.target ?? target, env, opts.forceWindow ?? false, {
    spawner: stub.spawner,
    write: (text) => (printed += text),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { result, printed };
}

describe('safeLoginEmail', () => {
  it.each(['me@example.com', 'first.last+tag@mail.example.co.uk', 'a_b-c@x-y.io', 'A1@B2.COM'])(
    'passes the ordinary address %s through unchanged',
    (email) => {
      expect(safeLoginEmail(email)).toBe(email);
    },
  );

  // Each of these would either let cmd.exe interpret part of the value (`&`, `|`, `>`, `^`, `"`,
  // `%VAR%`, a line break) or split it into extra arguments (whitespace), or read as a flag.
  it.each([
    ['a command separator', 'a@b.com&calc'],
    ['a pipe', 'a@b.com|calc'],
    ['a redirect', 'a@b.com>out.txt'],
    ['a caret escape', 'a^@b.com'],
    ['a double quote in the local part', 'a"b@example.com'],
    ['a closing quote and new command', 'x@y.com" & calc & "'],
    ['a percent variable', 'a%PATH%@b.com'],
    ['a space', 'a b@example.com'],
    ['a trailing space', 'me@example.com '],
    ['a tab', 'a\tb@example.com'],
    ['a newline', 'me@example.com\ncalc'],
    ['unicode letters', 'jösé@example.com'],
    ['a unicode domain', 'me@exämple.com'],
    ['a leading dash', '-x@example.com'],
    ['a leading-dash domain label', 'me@-example.com'],
    ['two at signs', 'a@b@example.com'],
    ['no at sign', 'example.com'],
    ['no dot in the domain', 'me@localhost'],
    ['an empty local part', '@example.com'],
    ['a trailing dot', 'me@example.'],
    ['a parenthesis', 'me(x)@example.com'],
    ['an empty string', ''],
  ])('refuses %s', (_why, email) => {
    expect(safeLoginEmail(email)).toBeUndefined();
  });

  it('refuses an absent email and one longer than any real address', () => {
    expect(safeLoginEmail(undefined)).toBeUndefined();
    expect(safeLoginEmail(`${'a'.repeat(250)}@b.com`)).toBeUndefined();
  });
});

describe('detectAuthLogin', () => {
  it('probes `auth login --help` with captured output, the given env and a timeout', async () => {
    const stub = stubSpawner();
    await detectAuthLogin(stub.spawner, env);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.args).toEqual(['auth', 'login', '--help']);
    expect(stub.calls[0]?.options.env).toBe(env);
    expect(stub.calls[0]?.options.capture).toBe(true);
    expect(stub.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it('reports support, with --email, when the help lists both flags', async () => {
    expect(await detectAuthLogin(stubSpawner().spawner, env)).toEqual({
      kind: 'supported',
      email: true,
    });
  });

  it('reports support without --email when the help does not list it', async () => {
    const stub = stubSpawner({ help: AUTH_HELP_NO_EMAIL });
    expect(await detectAuthLogin(stub.spawner, env)).toEqual({ kind: 'supported', email: false });
  });

  it('reports no support when the CLI answers with its general help', async () => {
    const stub = stubSpawner({ help: GENERAL_HELP });
    expect(await detectAuthLogin(stub.spawner, env)).toEqual({ kind: 'unsupported' });
  });

  // A help text that names --claudeai is not enough on its own: an error exit means the command
  // did not run as asked, whatever it printed.
  it('reports no support on a non-zero exit, even if the output names --claudeai', async () => {
    const stub = stubSpawner({ probe: { ...ok(AUTH_HELP), status: 1 } });
    expect(await detectAuthLogin(stub.spawner, env)).toEqual({ kind: 'unsupported' });
  });

  it('reports an error when `claude` cannot be started', async () => {
    const stub = stubSpawner({
      probe: {
        status: null,
        signal: null,
        output: '',
        timedOut: false,
        error: new Error('ENOENT'),
      },
    });
    expect(await detectAuthLogin(stub.spawner, env)).toEqual({
      kind: 'error',
      message: 'could not launch `claude`: ENOENT',
    });
  });

  // Through the Windows shim a missing `claude` is cmd.exe's own error, not a spawn error. Read
  // as an older CLI it would open a window that cannot start either.
  it('reports an error, not an older CLI, when the shell cannot find `claude`', async () => {
    const notFound =
      "'claude' is not recognized as an internal or external command,\r\n" +
      'operable program or batch file.\r\n';
    for (const probe of [
      { ...ok(notFound), status: 1 },
      { ...ok(''), status: 9009 },
    ]) {
      const stub = stubSpawner({ probe });
      expect(await detectAuthLogin(stub.spawner, env)).toEqual({
        kind: 'error',
        message: 'could not launch `claude` (is it on PATH?)',
      });
    }
  });

  it('reports an error when the probe does not answer in time', async () => {
    const stub = stubSpawner({
      probe: { status: null, signal: 'SIGTERM', output: '', timedOut: true },
    });
    const support = await detectAuthLogin(stub.spawner, env);
    expect(support.kind).toBe('error');
    expect(support.kind === 'error' && support.message).toContain('did not answer within');
  });
});

describe('loginForRelogin', () => {
  it('runs `claude auth login --claudeai --email <stored email>` with inherited stdio', async () => {
    const stub = stubSpawner();
    const { result } = await login(stub);
    expect(result).toEqual({ flow: 'browser' });
    expect(stub.calls.map((c) => c.args)).toEqual([
      ['auth', 'login', '--help'],
      ['auth', 'login', '--claudeai', '--email', 'me@example.com'],
    ]);
    const run = stub.calls[1]?.options;
    expect(run?.capture).toBe(false);
    expect(run?.env).toBe(env);
    expect(run?.timeoutMs).toBe(AUTH_LOGIN_TIMEOUT_MS);
  });

  it('tells the user which account to sign in as and to switch the browser account first', async () => {
    const { printed } = await login(stubSpawner());
    expect(printed).toContain('Re-logging in "work" (id-1) through the browser.');
    expect(printed).toContain('Sign in as me@example.com');
    expect(printed).toContain(
      'If the browser is signed in to a different claude.ai account, switch accounts there first.',
    );
    expect(printed).toContain('paste the code here if asked');
    // The window's instructions belong to the other flow only.
    expect(printed).not.toContain('/login');
  });

  it('omits --email when the help does not list it', async () => {
    const stub = stubSpawner({ help: AUTH_HELP_NO_EMAIL });
    await login(stub);
    expect(stub.calls[1]?.args).toEqual(['auth', 'login', '--claudeai']);
  });

  it('omits --email when the stored email is not safe for a command line', async () => {
    const stub = stubSpawner();
    const { result, printed } = await login(stub, {
      target: { ...target, emailAddress: 'me@example.com&calc' },
    });
    expect(result).toEqual({ flow: 'browser' });
    expect(stub.calls[1]?.args).toEqual(['auth', 'login', '--claudeai']);
    // No argument anywhere carries any part of the refused value.
    expect(stub.calls.flatMap((c) => c.args).some((a) => a.includes('calc'))).toBe(false);
    // Printing it is harmless (it never reaches a shell), and still tells the user who to be.
    expect(printed).toContain('Sign in as me@example.com&calc');
  });

  it('omits --email, and says so generically, when the account has no stored email', async () => {
    const stub = stubSpawner();
    const { printed } = await login(stub, { target: { id: 'id-2', label: 'old' } });
    expect(stub.calls[1]?.args).toEqual(['auth', 'login', '--claudeai']);
    expect(printed).toContain('Sign in as the account this entry belongs to');
  });

  it('falls back to the interactive window, with one line, when `auth login` is missing', async () => {
    const stub = stubSpawner({ help: GENERAL_HELP });
    const { result, printed } = await login(stub);
    expect(result).toEqual({ flow: 'window' });
    expect(stub.calls.map((c) => c.args)).toEqual([['auth', 'login', '--help'], []]);
    expect(stub.calls[1]?.options).toEqual({ env, capture: false });
    expect(printed).toContain(
      'This Claude Code has no `claude auth login`; falling back to an interactive window.\n',
    );
    expect(printed).toContain('A throwaway Claude window will open.');
    expect(printed).toContain('/login - pick the SAME account');
    expect(printed).toContain('/exit');
  });

  it('opens the window directly, without probing, when the window is forced', async () => {
    const stub = stubSpawner();
    const { result, printed } = await login(stub, { forceWindow: true });
    expect(result).toEqual({ flow: 'window' });
    expect(stub.calls.map((c) => c.args)).toEqual([[]]);
    expect(printed).not.toContain('falling back');
    expect(printed).toContain('A throwaway Claude window will open.');
  });

  it('reports a window that could not be started', async () => {
    const stub = stubSpawner({
      login: {
        status: null,
        signal: null,
        output: '',
        timedOut: false,
        error: new Error('ENOENT'),
      },
    });
    const { result } = await login(stub, { forceWindow: true });
    expect(result).toEqual({ flow: 'window', failure: 'could not launch `claude`: ENOENT' });
  });

  // The window's exit status is not a verdict: the capture that follows decides.
  it('leaves a window that exited non-zero to the capture to judge', async () => {
    const stub = stubSpawner({ login: { ...ok(), status: 1 } });
    expect((await login(stub, { forceWindow: true })).result).toEqual({ flow: 'window' });
  });

  it('fails a login run that exits non-zero, with the other ways in, and opens no window', async () => {
    const stub = stubSpawner({ login: { ...ok(), status: 1 } });
    const { result } = await login(stub);
    expect(result.flow).toBe('browser');
    expect(result.failure).toContain(
      '`claude auth login` exited with code 1; the login did not complete',
    );
    expect(result.failure).toContain('`cctl accounts relogin work --window`');
    expect(result.failure).toContain('`cctl accounts reauth work`');
    expect(stub.calls).toHaveLength(2); // probe + the one login, no window after it
  });

  it('fails a login run stopped by a signal', async () => {
    const stub = stubSpawner({ login: { ...ok(), status: null, signal: 'SIGKILL' } });
    const { result } = await login(stub);
    expect(result.failure).toContain('`claude auth login` was stopped (SIGKILL)');
  });

  it('fails a login run that timed out, naming the limit', async () => {
    const stub = stubSpawner({
      login: { status: null, signal: 'SIGTERM', output: '', timedOut: true },
    });
    const { result } = await login(stub);
    expect(result.failure).toContain(
      '`claude auth login` did not finish within 15 minutes, so it was stopped',
    );
    expect(result.failure).toContain('--window');
  });

  it('passes a custom timeout through to the login run', async () => {
    const stub = stubSpawner();
    await login(stub, { timeoutMs: 1234 });
    expect(stub.calls[1]?.options.timeoutMs).toBe(1234);
  });

  it('fails a login run that could not be started', async () => {
    const stub = stubSpawner({
      login: {
        status: null,
        signal: null,
        output: '',
        timedOut: false,
        error: new Error('EACCES'),
      },
    });
    const { result } = await login(stub);
    expect(result.failure).toContain('could not launch `claude auth login`: EACCES');
  });

  it('fails, rather than guessing a flow, when the probe itself errors', async () => {
    const stub = stubSpawner({
      probe: { status: null, signal: 'SIGTERM', output: '', timedOut: true },
    });
    const { result } = await login(stub);
    expect(result.failure).toContain('did not answer within');
    expect(result.failure).toContain('--window');
    expect(stub.calls).toHaveLength(1);
  });
});

describe('reloginRecoveryHint', () => {
  it('explains a wrong-account login and how to recover from it', () => {
    const hint = reloginRecoveryHint(target, 'relogin_identity_mismatch');
    expect(hint).toContain('The browser was signed in to a different claude.ai account.');
    expect(hint).toContain('Switch it to me@example.com on claude.ai and re-run.');
    expect(hint).toContain('`cctl accounts relogin work --window`');
    expect(hint).toContain('`cctl accounts reauth work`');
  });

  it('falls back to a generic account name when no email is stored', () => {
    const hint = reloginRecoveryHint({ id: 'id-2', label: 'old' }, 'relogin_identity_mismatch');
    expect(hint).toContain('Switch it to the right account on claude.ai');
  });

  it('offers just the other ways in for a login that left nothing to capture', () => {
    const hint = reloginRecoveryHint(target, 'no_capture_login');
    expect(hint).not.toContain('different claude.ai account');
    expect(hint).toContain('Re-run, or log in through an interactive window');
    expect(hint).toContain('`cctl accounts reauth work`');
  });
});

// The real process mechanics, against `node` (never `claude`).
describe('createClaudeSpawner', () => {
  const node = createClaudeSpawner('node');

  it('collects output and the exit status when capturing', async () => {
    const run = await node(['--version'], { env: process.env, capture: true });
    expect(run.status).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(run.output.trim()).toBe(process.version);
  });

  it('reports a command that does not exist without throwing', async () => {
    const run = await createClaudeSpawner('cctl-no-such-binary-for-tests')([], {
      env: process.env,
      capture: true,
    });
    // Off Windows the spawn itself fails; through the Windows shell the shell reports it.
    if (process.platform === 'win32') expect(run.status).not.toBe(0);
    else expect(run.error).toBeDefined();
  });

  // The run outlives its timeout by far. `close` waits for every process holding the output pipe,
  // so this resolving well before the script would end proves the WHOLE tree was stopped — on
  // Windows that includes the CLI under the shell, which killing only the child would leave alive.
  it('stops the whole process tree on timeout and says so', async () => {
    const started = Date.now();
    const run = await node(['-e', 'setTimeout(Object,60000)'], {
      env: process.env,
      capture: true,
      timeoutMs: 300,
    });
    expect(run.timedOut).toBe(true);
    expect(run.status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  // Ctrl+C at the paste prompt reaches this process too; it must outlive the child so the caller
  // can still delete the throwaway dir. The handlers live exactly as long as the run.
  it('swallows Ctrl+C in this process only while an inherited run is going', async () => {
    const watched: NodeJS.Signals[] =
      process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT'];
    const before = watched.map((sig) => process.listenerCount(sig));
    const pending = node(['-e', 'setTimeout(Object,200)'], { env: process.env, capture: false });
    expect(watched.map((sig) => process.listenerCount(sig))).toEqual(before.map((n) => n + 1));
    expect((await pending).status).toBe(0);
    expect(watched.map((sig) => process.listenerCount(sig))).toEqual(before);
  });

  it('leaves Ctrl+C alone for a captured run, which has no terminal to share', async () => {
    const before = process.listenerCount('SIGINT');
    const pending = node(['--version'], { env: process.env, capture: true });
    expect(process.listenerCount('SIGINT')).toBe(before);
    await pending;
  });

  it('removes its handlers when the command cannot be started', async () => {
    const before = process.listenerCount('SIGINT');
    await createClaudeSpawner('cctl-no-such-binary-for-tests')([], {
      env: process.env,
      capture: false,
    });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('does not mark a run that ends before its timeout as timed out', async () => {
    const run = await node(['--version'], { env: process.env, capture: true, timeoutMs: 60_000 });
    expect(run.status).toBe(0);
    expect(run.timedOut).toBe(false);
  });
});
