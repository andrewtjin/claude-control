// `cctl stats` end to end over real files: a sandboxed vault with a folder rule, the daemon database
// beside it and a transcript in Claude Code's on-disk layout. Proves the command joins the store's
// recorded slot spans into the attribution, so a hand-started session in a ruled folder is billed to
// the rule's account rather than the global one. Nothing here reads the developer's real ~/.claude,
// vault or daemon database.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, projectDirStem } from '@claude-control/daemon';
import {
  InsecurePassthroughProtector,
  Vault,
  defaultPaths,
  type CredentialBundle,
  type Paths,
} from '@claude-control/switch-engine';
import { daemonDbPath } from './context.js';
import { buildProgram } from './program.js';

const SESSION = 'eeeeeeee-0000-4000-8000-000000000001';
const HOUR = 3_600_000;

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: 999 },
  oauthAccount: { accountUuid: 'uuid-' + token, emailAddress: token + '@example.com' },
});

let root: string;
let paths: Paths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-stats-'));
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('CCTL_BIND_ENFORCE', 'block');
  vi.stubEnv('CCTL_LOG_FILE', undefined);
  paths = defaultPaths();
  // Every path the command resolves must land in the sandbox.
  expect(paths.vaultDir.startsWith(root)).toBe(true);
  expect(paths.claudeDir.startsWith(root)).toBe(true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** Run `cctl stats`, returning what it printed. */
async function runStats(): Promise<string> {
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    await buildProgram().parseAsync(['stats'], { from: 'user' });
  } finally {
    stdout.mockRestore();
  }
  return out.join('');
}

describe('cctl stats', () => {
  // The data root of a macOS host is fixed under the real home: nothing to sandbox there.
  it.skipIf(process.platform === 'darwin')(
    'bills a hand-started session in a ruled folder to the rule slot account, by its recorded span',
    async () => {
      const now = Date.now();
      const vault = new Vault(paths.vaultDir, new InsecurePassthroughProtector());
      const shared = await vault.addAccount('shared-acct', bundle('a'));
      const reserved = await vault.addAccount('rule-acct', bundle('b'));
      const folder = join(root, 'ruled');
      await mkdir(folder, { recursive: true });
      const rule = await vault.createRule({ include: [reserved.id], folders: [folder] });
      const ruleSlot = `group:${rule.id}`;

      // Each account live in its own slot; the session was never registered, so its recorded span
      // is the only record that it ran in the rule's slot.
      const store = new Store(daemonDbPath(paths));
      try {
        store.replaceActivationIntervals([
          {
            accountId: shared.id,
            startedAtMs: now - 2 * HOUR,
            endedAtMs: null,
            origin: null,
            slot: 'global',
          },
          {
            accountId: reserved.id,
            startedAtMs: now - 2 * HOUR,
            endedAtMs: null,
            origin: null,
            slot: ruleSlot,
          },
        ]);
        store.recordSessionSlot(SESSION, ruleSlot, now - 2 * HOUR);
      } finally {
        store.close();
      }

      const dir = join(paths.claudeDir, 'projects', projectDirStem(folder));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${SESSION}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now - HOUR).toISOString(),
          message: {
            id: 'msg_1',
            model: 'claude-sonnet-5',
            usage: {
              input_tokens: 1234,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }) + '\n',
        'utf8',
      );

      const out = await runStats();
      const byAccount = out.slice(out.indexOf('By account'), out.indexOf('By model'));
      expect(byAccount).toContain('rule-acct');
      expect(byAccount).not.toContain('shared-acct');
    },
  );
});
