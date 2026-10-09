// The folder-rule docs against the code they describe: the guard's documented messages are the
// ones the guard prints, and the documented move cadence is the daemon's. Docs wrap lines, so the
// text is compared with its whitespace collapsed.

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVE_INTERVAL_MS, writeBindGuard } from '@claude-control/daemon';
import { snapshotIdentityKey } from '@claude-control/switch-engine';

const CLI_MD = new URL('../../../docs/CLI.md', import.meta.url);

/** The doc's text with every run of whitespace collapsed to one space. */
function docText(): string {
  return readFileSync(CLI_MD, 'utf8').replace(/\s+/g, ' ');
}

/** What the guard prints for a session on the global slot in a ruled folder while the global slot
 *  holds the account with `uuid`: the rule includes A and B and excludes the shared D (C is a shared
 *  account it keeps). Returns the folder as the guard named it, to swap for the doc's example. */
async function guardSays(uuid: string): Promise<{ folder: string; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cctl-docs-'));
  try {
    const folder = join(dir, 'work');
    mkdirSync(folder);
    const canonical = realpathSync.native(folder);
    const snapshotPath = join(dir, 'folder-bindings.json');
    const identityFile = join(dir, '.claude.json');
    const key = (label: string, ruleIds: string[]) => ({
      label,
      accountKey: snapshotIdentityKey(`uuid-${label}`),
      ruleIds,
    });
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        enforce: 'block',
        mainConfigDir: dir,
        mainIdentityFile: identityFile,
        accounts: [key('A', ['r']), key('B', ['r']), key('C', []), key('D', [])],
        groups: [
          {
            id: 'r',
            label: 'work',
            profileDir: join(dir, 'profile'),
            folders: [canonical],
            members: ['A', 'B'],
            excluded: [{ label: 'D', accountKey: snapshotIdentityKey('uuid-D') }],
          },
        ],
      }),
    );
    await writeFile(identityFile, JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
    const guard = join(dir, 'guard.cjs');
    await writeBindGuard(guard, snapshotPath);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: canonical };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_CODE_SESSION_KIND;
    delete env.CLAUDE_JOB_DIR;
    const run = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'docs' }),
      env,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(run.stdout) as { reason?: string; systemMessage?: string };
    return { folder: canonical, out: parsed.reason ?? parsed.systemMessage ?? '' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('docs/CLI.md on folder rules', () => {
  it("shows the guard's one-time notice for an accepted account as the guard prints it", async () => {
    const { folder, out } = await guardSays('uuid-C');
    expect(docText()).toContain(out.replace(folder, 'C:\\work').replace(/\s+/g, ' '));
  });

  it("shows the guard's refusal of an excluded account as the guard prints it", async () => {
    const { folder, out } = await guardSays('uuid-D');
    expect(docText()).toContain(out.replace(folder, 'C:\\work').replace(/\s+/g, ' '));
  });

  it('states the move cadence the daemon uses', () => {
    expect(DEFAULT_MOVE_INTERVAL_MS).toBe(60 * 60_000);
    expect(docText()).toContain('A session moves at most once an hour');
  });
});
