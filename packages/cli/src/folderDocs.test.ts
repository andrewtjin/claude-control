// The folder-rule docs against the code they describe: the guard's documented messages are the
// ones the guard prints, the documented move cadence is the daemon's, and where `--account` runs is
// where the engine runs it. Docs wrap lines, so the text is compared with its whitespace collapsed.

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVE_INTERVAL_MS, writeBindGuard } from '@claude-control/daemon';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  Vault,
  ruleSlotId,
  sandboxPaths,
  snapshotIdentityKey,
  type ClaudeOauth,
  type CredentialBundle,
} from '@claude-control/switch-engine';

const CLI_MD = new URL('../../../docs/CLI.md', import.meta.url);
const README_MD = new URL('../../../README.md', import.meta.url);

/** The doc's text with every run of whitespace collapsed to one space. */
function docText(doc: URL = CLI_MD): string {
  return readFileSync(doc, 'utf8').replace(/\s+/g, ' ');
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

describe('the parallel-session docs', () => {
  it('a reserved account runs in the slot of the rule it is reserved to, a named session one included', () => {
    const text = docText();
    // A named session's rule has no folder, so "a folder it is reserved to" would send a reader to
    // "a slot of its own", which `--account` does not give there.
    expect(text).toContain(
      'in the slot of a folder or named session `work` is reserved to (a rule that includes it), ' +
        "when it is live there, from any folder. The session then follows that rule's switches",
    );
    expect(text).not.toContain('in the slot of a folder `work` is reserved to');
  });

  /** A credential bundle for a stand-in account `name`. */
  const bundle = (name: string): CredentialBundle => ({
    claudeAiOauth: {
      accessToken: name,
      refreshToken: `r-${name}`,
      expiresAt: Date.now() + 10 * 3_600_000,
    },
    oauthAccount: { accountUuid: `uuid-${name}`, emailAddress: `${name}@example.com` },
  });

  /** A real engine over a throwaway vault, with Windows rules so the folders below are valid on
   *  any machine: A (live in the global slot), work, B, C and fresh (live nowhere), all shared. A
   *  folder rule for C:\research, and a rule of its own for the named session 'auth work' recorded
   *  there. */
  async function rows() {
    const root = await mkdtemp(join(tmpdir(), 'cctl-docs-rows-'));
    const paths = sandboxPaths(root);
    mkdirSync(paths.claudeDir, { recursive: true });
    const protector = new InsecurePassthroughProtector();
    const engine = new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh: (cur: ClaudeOauth) => Promise.resolve(cur),
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 10 },
      platform: 'win32',
    });
    const vault = new Vault(paths.vaultDir, protector, Date.now, undefined, 'win32');
    const A = await engine.addAccount('A', bundle('A'));
    const work = await engine.addAccount('work', bundle('work'));
    const C = await engine.addAccount('C', bundle('C'));
    const fresh = await engine.addAccount('fresh', bundle('fresh'));
    const B = await engine.addAccount('B', bundle('B'));
    await engine.activate(A.id, { force: true });
    const folder = await vault.createRule({ folders: ['C:\\research'], exclude: [A.id] });
    const named = await vault.createRule({
      folders: [],
      aliases: [{ folder: 'C:\\research', alias: 'auth work' }],
      exclude: [A.id],
    });
    return { root, engine, vault, A, B, work, C, fresh, folder, named };
  }

  it('lists every row of where --account runs as the engine decides it', async () => {
    const text = docText();
    const list = /Where it runs: (.*?) While a parallel session runs:/.exec(text)?.[1] ?? '';
    // One bullet per slot the engine runs a launch in; the refusals follow the list.
    expect(list.split(/(?:^| )- /).filter((b) => b.trim() !== '')).toHaveLength(4);
    const { root, engine, vault, A, B, work, C, fresh, folder, named } = await rows();
    const plan = (id: string, launchRuleId: string | null) =>
      engine.planSessionSlot(id, { launchRuleId });
    try {
      // Live in the global slot: there, whatever rule the launch runs under.
      expect(list).toContain('on the global slot when `work` is live there');
      expect(await plan(A.id, named.id)).toMatchObject({ kind: 'global' });

      // Live in the slot of the rule the launch runs under: the folder's, or the named session's.
      expect(list).toContain(
        'in the slot of the rule this launch runs under when `work` is live there: this ' +
          "folder's rule, or the rule of the named session its arguments open",
      );
      await engine.activate(work.id, { force: true, slot: ruleSlotId(folder.id) });
      expect(await plan(work.id, folder.id)).toEqual({ kind: 'rule', ruleId: folder.id });

      // The folder's slot, while the launch opens the named session with a rule of its own.
      expect(text).toContain(
        "That covers this folder's own slot too when the launch opens a named session whose " +
          'rule has a slot of its own.',
      );
      expect(await plan(work.id, named.id)).toMatchObject({
        kind: 'refused',
        code: 'live_in_other_rule',
      });

      // A shared account live in another rule's slot.
      expect(text).toContain(
        'Live in the slot of any other rule, `work` is refused: a shared account serving ' +
          "another folder's or named session's slot",
      );
      expect(await plan(work.id, null)).toMatchObject({ code: 'live_in_other_rule' });

      // Reserved and live in a rule that does not include it: C takes over the folder's slot while
      // shared, then is reserved to C:\mine (the state until a repair evicts it).
      expect(text).toContain('or a reserved account live in a rule that does not include it');
      await engine.activate(C.id, { force: true, slot: ruleSlotId(folder.id) });
      const mine = await vault.createRule({ folders: ['C:\\mine'], include: [C.id] });
      expect(await plan(C.id, null)).toMatchObject({ code: 'live_in_other_rule' });

      // The named session's own slot runs it for a launch that opens that session, and only then.
      await engine.activate(work.id, { force: true, slot: ruleSlotId(named.id) });
      expect(await plan(work.id, named.id)).toEqual({ kind: 'rule', ruleId: named.id });
      expect(await plan(work.id, folder.id)).toMatchObject({ code: 'live_in_other_rule' });

      // Reserved and live in a rule that includes it: there, from any folder.
      await engine.activate(B.id, { force: true, slot: ruleSlotId(folder.id) });
      await engine.activate(C.id, { force: true, slot: ruleSlotId(mine.id) });
      expect(await plan(C.id, null)).toEqual({ kind: 'rule', ruleId: mine.id });
      expect(await plan(C.id, folder.id)).toEqual({ kind: 'rule', ruleId: mine.id });

      // Live in no rule's slot: a parallel-session slot of its own, under any rule.
      expect(list).toContain(
        "otherwise, when `work` is live in no folder's or named session's slot, in a " +
          'parallel-session slot of its own',
      );
      for (const launch of [null, folder.id, named.id]) {
        expect(await plan(fresh.id, launch)).toMatchObject({ kind: 'lease', join: false });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the README says the same rows', () => {
    const text = docText(README_MD);
    expect(text).toContain(
      'Where `work` is already live in the global slot, the slot of the rule this launch runs ' +
        'under, or that of a folder or named session it is reserved to, it runs there',
    );
    expect(text).toContain(
      "Live in any other folder's or named session's slot, it is refused until that slot " +
        'switches away. Live in none, it gets a slot of its own',
    );
  });
});
