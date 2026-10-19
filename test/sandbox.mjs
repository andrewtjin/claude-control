// Runs before every test file: gives the file a throwaway home and arms the live-state guard.
//
// The machines this suite runs on are often the same ones cctl manages for real, with a live
// Claude login, a vault and a running daemon. Tests are supposed to inject their own paths, but a
// single test that forgets one (or mocks one path and not the next) lands on the real profile. So
// the sandbox is the process environment itself, not something each test opts into:
//
//  - Every variable a home or data path is derived from points into a fresh temp folder, and
//    variables naming real cctl or Claude locations are removed. Paths resolved from the
//    environment, in this process or in any child spawned with it, stay inside the sandbox.
//  - liveGuard.mjs then refuses any write that still reaches the real locations, in this process
//    and (through NODE_OPTIONS) in node children. A refusal fails the test file that caused it,
//    even when the code under test caught the error.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const PROTECTED_ENV = 'CCTL_TEST_PROTECTED_PATHS';
const TRIP_LOG_ENV = 'CCTL_TEST_GUARD_LOG';
/** Marks a process whose environment is already a sandbox, so a nested setup (a worker reused
 *  across files) never mistakes the sandbox for the real profile. */
const SANDBOX_ENV = 'CCTL_TEST_SANDBOX';

/** Variables that name real cctl or Claude state directly; a test that needs one sets its own. */
const REMOVED_VARS = ['CLAUDE_CONFIG_DIR', 'CCTL_BOT_STATE_DIR', 'CCTL_LOG_FILE'];

/**
 * The real locations to guard, read from the account (which ignores the environment) and from the
 * environment as it was before the sandbox replaced it.
 */
function realLocations(env) {
  const home = userInfo().homedir;
  const tree = (p) => (p?.trim() ? [{ kind: 'tree', path: p }] : []);
  const prefix = (p) => (p?.trim() ? [{ kind: 'prefix', path: p }] : []);
  const dataRoots = [
    env.LOCALAPPDATA,
    join(home, 'AppData', 'Local'),
    env.XDG_DATA_HOME,
    join(home, '.local', 'share'),
    join(home, 'Library', 'Application Support'),
  ].filter((r) => r?.trim());
  const configRoots = [env.XDG_CONFIG_HOME, join(home, '.config')].filter((r) => r?.trim());
  return [
    // The Claude login: the config dir and the identity file beside it (plus its temp/backups).
    ...tree(join(home, '.claude')),
    ...prefix(join(home, '.claude.json')),
    ...tree(env.CLAUDE_CONFIG_DIR),
    // cctl's vault, registry, daemon database, installed hooks and logs.
    ...dataRoots.flatMap((r) => tree(join(r, 'claude-control'))),
    ...tree(join(home, '.claude-control-bot')),
    ...tree(env.CCTL_BOT_STATE_DIR),
    ...prefix(env.CCTL_LOG_FILE),
    // Autostart entries cctl installs.
    ...configRoots.flatMap((r) => tree(join(r, 'systemd', 'user'))),
    ...tree(join(home, 'Library', 'LaunchAgents')),
    ...tree(
      env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    ),
  ];
}

/** Point every home and data variable at `home`, creating the folders code expects to exist. */
function sandboxEnvironment(env, home) {
  const vars = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
  for (const [name, value] of Object.entries(vars)) {
    mkdirSync(value, { recursive: true });
    env[name] = value;
  }
  for (const name of REMOVED_VARS) delete env[name];
}

const env = process.env;
const nested = env[SANDBOX_ENV] === '1';
const priorProtected = (() => {
  try {
    return JSON.parse(env[PROTECTED_ENV] ?? '[]');
  } catch {
    return [];
  }
})();
// A nested setup keeps the list the first one made; adding locations read from a sandboxed
// environment would only guard the previous sandbox.
const protectedPaths = nested ? priorProtected : [...priorProtected, ...realLocations(env)];

const root = mkdtempSync(join(tmpdir(), 'cctl-test-home-'));
const tripLog = join(root, 'guard-trips.log');
sandboxEnvironment(env, join(root, 'home'));
env[SANDBOX_ENV] = '1';
env[PROTECTED_ENV] = JSON.stringify(protectedPaths);
env[TRIP_LOG_ENV] = tripLog;

// Node children inherit the environment, so preload the guard into them as well. A file URL keeps
// spaces in the checkout path out of NODE_OPTIONS' own word splitting.
const guardUrl = new URL('./liveGuard.mjs', import.meta.url).href;
const preload = `--import=${guardUrl}`;
if (!(env.NODE_OPTIONS ?? '').includes(preload)) {
  env.NODE_OPTIONS = [env.NODE_OPTIONS, preload].filter(Boolean).join(' ');
}

const { installLiveGuard } = await import(guardUrl);
installLiveGuard();

afterAll(() => {
  let trips = '';
  try {
    trips = readFileSync(tripLog, 'utf8');
  } catch {
    // No log means no refusals.
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A handle still open on Windows leaves the folder for the OS temp cleanup.
  }
  if (trips.trim() !== '') {
    throw new Error(`this file tried to write real Claude/cctl state:\n${trips}`);
  }
});
