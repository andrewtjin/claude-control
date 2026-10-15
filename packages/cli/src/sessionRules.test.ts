// Integration tests for `cctl session include | exclude | reset`, and for the rule lines of
// `cctl session show`, end to end over real files: a temp Claude config dir with transcripts in
// Claude Code's layout, a temp vault driven through a real SwitchEngine (with a passthrough
// protector a test can read), the daemon database beside it, and the real guard reconcile writing
// the sandbox's settings.json. Nothing touches the developer's real ~/.claude, vault or daemon
// database.
//
// What only an end-to-end run proves: the folder an alias belongs to is read from the same places a
// real session exposes it (its own recorded folder when the alias is its own, also from a subfolder
// or a worktree it entered); the first alias rule installs the enforcement guard; the reports say
// what changed in the words the folder verbs use; a rule whose folder was moved and replaced by a
// link can still be removed by its old path; and the operator is told plainly when the session
// running the command is on another slot than its rule names.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store, bindGuardPath, projectDirStem } from '@claude-control/daemon';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  folderBindingsPath,
  groupProfileDir,
  ruleSlotId,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { CliFailure, daemonDbPath } from './context.js';
import { SESSION_ID_ENV, runSessionShow } from './sessionAliases.js';
import {
  runSessionExclude,
  runSessionInclude,
  runSessionReset,
  type SessionRuleDeps,
} from './sessionRules.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-01T00:00:00.000Z');

const S_CUR = 'aaaaaaaa-0000-4000-8000-000000000001'; // named "Auth Work" in repo
const S_AI = 'aaaaaaaa-0000-4000-8000-000000000002'; // generated title only, in repo
const S_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003'; // named "Side" in away

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: NOW + 100 * HOUR },
  oauthAccount: { accountUuid: 'uuid-' + token, emailAddress: token + '@example.com' },
});

const userLine = (cwd: string, tsMs: number): string =>
  JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'user', content: 'hi' },
  });
const customTitle = (t: string): string => JSON.stringify({ type: 'custom-title', customTitle: t });
const relocated = (cwd: string): string => JSON.stringify({ type: 'relocated', relocatedCwd: cwd });
const aiTitle = (t: string): string => JSON.stringify({ type: 'ai-title', aiTitle: t });

let root: string;
let paths: Paths;
let repo: string; // canonical
let away: string; // canonical
let engine: SwitchEngine;
let main: StoredAccount;
let work: StoredAccount;
let client: StoredAccount;

async function writeSession(folder: string, id: string, lines: string[], atMs: number) {
  const dir = join(paths.claudeDir, 'projects', projectDirStem(folder));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  await utimes(file, atMs / 1000, atMs / 1000);
}

/** An engine over the sandbox: passthrough protector, file live channel, a refresh that never goes
 *  to the network (every token is far from expiry anyway). */
function sandboxEngine(): SwitchEngine {
  return new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) => Promise.resolve(cur),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 5000, pollMs: 10 },
    isProcessAlive: () => false,
    bindEnforce: 'block',
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-session-rules-'));
  vi.stubEnv('CCTL_BIND_ENFORCE', 'block');
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('CCTL_LOG_FILE', undefined);
  paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'repo'), { recursive: true });
  await mkdir(join(root, 'away'), { recursive: true });
  repo = realpathSync.native(join(root, 'repo'));
  away = realpathSync.native(join(root, 'away'));
  engine = sandboxEngine();
  main = await engine.addAccount('main', bundle('a'));
  work = await engine.addAccount('work', bundle('b'));
  client = await engine.addAccount('client', bundle('c'));
  // `main` is the global live account (this box's current login).
  await engine.activate(main.id, { force: true });

  await writeSession(repo, S_CUR, [userLine(repo, NOW), customTitle('Auth Work')], NOW + HOUR);
  await writeSession(repo, S_AI, [userLine(repo, NOW), aiTitle('Fix the parser')], NOW + 2 * HOUR);
  await writeSession(away, S_OTHER, [userLine(away, NOW), customTitle('Side')], NOW + 3 * HOUR);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The deps a command runs with: the sandbox engine and paths, output collected, and no daemon to
 *  ask about (the older-daemon refusal is its own test). */
function harness(over: Partial<SessionRuleDeps> = {}) {
  const written: string[] = [];
  const deps: SessionRuleDeps = {
    paths,
    env: {},
    cwd: repo,
    platform: process.platform,
    write: (t) => written.push(t),
    note: () => {},
    engine,
    refuseOnOlderDaemon: () => Promise.resolve(),
    ...over,
  };
  return { deps, text: () => written.join('') };
}

/** Inside session S_CUR, on the global slot (no CLAUDE_CONFIG_DIR): what `cctl` sees when run
 *  from a Bash tool of that session. */
const inCurrentSession = () => ({ env: { [SESSION_ID_ENV]: S_CUR } });

/** The one alias rule, or fails the test. */
async function onlyRule() {
  const rules = await engine.listRules();
  expect(rules).toHaveLength(1);
  return rules[0]!;
}

describe('cctl session include', () => {
  it('creates a rule for the named session, installs the guard, and tells this session how to use it', async () => {
    const h = harness(inCurrentSession());
    await runSessionInclude('Auth Work', 'work', {}, h.deps);
    const out = h.text();

    const rule = await onlyRule();
    expect(rule.folders).toEqual([]);
    expect(rule.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
    expect(rule.include).toEqual([work.id]);
    expect(out).toContain(
      `Created a rule for session "Auth Work" in ${repo}: it uses work first, then the shared pool.`,
    );
    expect(out).toContain("live in the session's slot: work (included)");
    expect(out).toContain(`profile: ${groupProfileDir(paths.vaultDir, rule.id)}`);
    expect(await engine.getActiveId(ruleSlotId(rule.id))).toBe(work.id);
    // main, the global account, is untouched: an include never defaults to the account in use.
    expect(await engine.getActiveId('global')).toBe(main.id);
    // This session runs on the global slot, which its rule accepts; it is told how to move.
    expect(out).toContain('This session runs on the global slot, which its rule accepts');
    expect(out).toContain(`cctl claude --resume ${S_CUR}`);

    // The FIRST rule installed the guard...
    const settings = await readFile(join(paths.claudeDir, 'settings.json'), 'utf8');
    expect(settings).toContain('bind-guard.cjs');
    expect(existsSync(bindGuardPath(dirname(paths.vaultDir)))).toBe(true);
    // ...and the snapshot it reads carries the alias key and the alias as entered.
    const snap = JSON.parse(await readFile(folderBindingsPath(paths.vaultDir), 'utf8')) as {
      groups: { aliases?: unknown }[];
    };
    expect(snap.groups[0]?.aliases).toEqual([
      { folder: repo, aliasKey: 'auth work', alias: 'Auth Work' },
    ]);
  });

  it('uses the session’s own folder for its own alias, even from a subfolder cwd', async () => {
    const sub = join(repo, 'src');
    await mkdir(sub, { recursive: true });
    const h = harness({ ...inCurrentSession(), cwd: sub });
    await runSessionInclude('auth work', 'work', {}, h.deps);
    expect((await onlyRule()).aliases).toEqual([{ folder: repo, alias: 'auth work' }]);
  });

  it('an alias that is not this session’s own lives in the cwd (or --cwd)', async () => {
    const h = harness(inCurrentSession());
    await runSessionInclude('Side', 'work,client', { cwd: away, label: 'Side work' }, h.deps);
    const rule = await onlyRule();
    expect(rule.label).toBe('Side work');
    expect(rule.aliases).toEqual([{ folder: away, alias: 'Side' }]);
    expect(rule.include).toEqual([work.id, client.id]);
    // Not about this session: no note.
    expect(h.text()).not.toContain('This session');
  });

  it('inside a session that entered a worktree: rules it there, and show and the guard agree', async () => {
    // EnterWorktree MOVES the transcript into the worktree's project directory (its first cwd stays
    // the repository), the session's tools run in the worktree, and resumed from the repository its
    // hooks get CLAUDE_PROJECT_DIR = the repository.
    const S_REL = 'aaaaaaaa-0000-4000-8000-0000000000e1';
    await mkdir(join(repo, '.claude', 'worktrees', 'w1'), { recursive: true });
    const wt = realpathSync.native(join(repo, '.claude', 'worktrees', 'w1'));
    await writeSession(
      wt,
      S_REL,
      [userLine(repo, NOW), relocated(wt), userLine(wt, NOW), customTitle('Rel X'), relocated(wt)],
      NOW + 4 * HOUR,
    );
    const inRelocated = { env: { [SESSION_ID_ENV]: S_REL }, cwd: wt };

    const h = harness(inRelocated);
    await runSessionExclude('Rel X', 'main', {}, h.deps);
    expect((await onlyRule()).aliases).toEqual([{ folder: wt, alias: 'Rel X' }]);
    expect(h.text()).toContain(`cctl claude --resume ${S_REL}`);

    const show = harness(inRelocated);
    await runSessionShow(undefined, { json: true }, show.deps);
    const binding = (
      JSON.parse(show.text()) as { sessions: { binding?: Record<string, unknown> }[] }
    ).sessions[0]?.binding;
    expect(binding).toMatchObject({ via: 'alias', folder: wt, slot: 'global', inScope: false });

    // The guard, as Claude Code runs it for this session's next prompt after a resume from the repo:
    // the rule excludes main, the account the global slot holds, so the prompt is refused.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo.split('\\').join('/'),
    };
    for (const k of ['CLAUDE_CONFIG_DIR', 'CCTL_BIND_OVERRIDE', 'CCTL_LAUNCH_EXPLICIT'])
      delete env[k];
    const r = spawnSync(process.execPath, [bindGuardPath(dirname(paths.vaultDir))], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: S_REL,
        cwd: wt,
        prompt: 'go on',
        transcript_path: join(paths.claudeDir, 'projects', projectDirStem(wt), `${S_REL}.jsonl`),
        session_title: 'Rel X',
      }),
      env,
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    const decision = JSON.parse(r.stdout || '{}') as { decision?: string; reason?: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('excludes main');
    expect(decision.reason).toContain(`cctl claude --resume ${S_REL}`);
  });

  it('a second include of the same alias (any case) adds to its rule', async () => {
    await runSessionInclude('Side', 'work', { cwd: away }, harness().deps);
    const again = harness();
    await runSessionInclude('side', 'client', { cwd: away }, again.deps);
    expect((await onlyRule()).include).toEqual([work.id, client.id]);
    expect(again.text()).toContain(`Included client in the rule for session "Side" in ${away}.`);
  });

  it('names its accounts always: an empty list is a usage error, nothing is created', async () => {
    await expect(runSessionInclude('Side', ' , ', { cwd: away }, harness().deps)).rejects.toThrow(
      /session include needs at least one account/,
    );
    await expect(runSessionInclude('  ', 'work', {}, harness().deps)).rejects.toThrow(
      /name the session alias/,
    );
    expect(await engine.listRules()).toEqual([]);
  });

  it('turns an engine refusal into a CLI failure, changing nothing', async () => {
    const attempt = runSessionInclude('x', 'work', { cwd: join(root, 'missing') }, harness().deps);
    await expect(attempt).rejects.toBeInstanceOf(CliFailure);
    await expect(
      runSessionInclude('x', 'work', { cwd: join(root, 'missing') }, harness().deps),
    ).rejects.toThrow(/is not an existing directory/);
    expect(await engine.listRules()).toEqual([]);
  });

  it('refuses beside a daemon that cannot honor alias rules, before reading anything', async () => {
    const h = harness({
      refuseOnOlderDaemon: () => Promise.reject(new CliFailure('the running daemon predates')),
    });
    await expect(runSessionInclude('Side', 'work', { cwd: away }, h.deps)).rejects.toThrow(
      'the running daemon predates',
    );
    expect(await engine.listRules()).toEqual([]);
  });
});

describe('cctl session exclude', () => {
  it('gives a named session a slot of its own off the excluded accounts', async () => {
    const h = harness();
    await runSessionExclude('Side', 'main', { cwd: away }, h.deps);
    const rule = await onlyRule();
    expect(rule.exclude).toEqual([main.id]);
    expect(h.text()).toContain(
      `Created a rule for session "Side" in ${away} that excludes main; it uses the rest of the ` +
        'shared pool, in its own slot.',
    );
    expect(h.text()).toContain('main stays usable everywhere else.');
    expect(await engine.getActiveId(ruleSlotId(rule.id))).not.toBe(main.id);
  });
});

describe('cctl session reset', () => {
  it('removes the rule; the session goes back to its folder’s rule (here the global slot)', async () => {
    await runSessionInclude('Auth Work', 'work', {}, harness().deps);
    const h = harness();
    await runSessionReset('auth work', undefined, {}, h.deps);
    expect(await engine.listRules()).toEqual([]);
    expect(h.text()).toContain(
      `Removed the rule for session "Auth Work" in ${repo}. That session now uses the global ` +
        'slot and the shared pool.',
    );
    expect(h.text()).toContain('returned to the shared pool: work');
    expect((await engine.listAccounts()).map((a) => a.id)).toContain(work.id);
  });

  it('names the folder rule a session falls back to', async () => {
    await engine.includeInFolder(repo, [client.id]);
    await runSessionInclude('Auth Work', 'work', {}, harness().deps);
    const h = harness();
    await runSessionReset('Auth Work', undefined, {}, h.deps);
    expect(h.text()).toContain(`That session now uses the folder rule on ${repo}.`);
  });

  it('drops named accounts, keeping the rule', async () => {
    await runSessionInclude('Side', 'work,client', { cwd: away }, harness().deps);
    const h = harness();
    await runSessionReset('Side', 'client', { cwd: away }, h.deps);
    expect((await onlyRule()).include).toEqual([work.id]);
    expect(h.text()).toContain(`Removed client from what session "Side" in ${away} includes.`);
  });

  it('drops an exclusion, saying the session may use the account again', async () => {
    await runSessionExclude('Side', 'main,client', { cwd: away }, harness().deps);
    const h = harness();
    await runSessionReset('Side', 'client', { cwd: away }, h.deps);
    expect((await onlyRule()).exclude).toEqual([main.id]);
    expect(h.text()).toContain(
      `Removed client from what session "Side" in ${away} excludes: the session may use it again.`,
    );
  });

  it('refuses an alias with no rule', async () => {
    await expect(runSessionReset('nope', undefined, {}, harness().deps)).rejects.toThrow(
      new RegExp(`session "nope" in .* has no rule`),
    );
  });

  // A ruled folder can be moved and a link left at its old path. The old path then resolves to
  // the new home, where nothing has a rule, while the rule still names the old path.
  it('removes the rule of a folder moved and replaced by a link, by its old path', async () => {
    const old = join(root, 'proj');
    await mkdir(old, { recursive: true });
    const oldCanon = realpathSync.native(old);
    await runSessionInclude('X', 'work', { cwd: oldCanon }, harness().deps);
    const moved = join(root, 'proj-moved');
    await rename(old, moved);
    await symlink(moved, old, process.platform === 'win32' ? 'junction' : 'dir');

    const h = harness({ cwd: root });
    await runSessionReset('X', undefined, { cwd: old }, h.deps);
    expect(await engine.listRules()).toEqual([]);
    expect(h.text()).toContain(`Removed the rule for session "X" in ${oldCanon}.`);
  });
});

describe('cctl session show — Rule and Slot', () => {
  interface ShowJson {
    sessions: { sessionId: string; binding?: Record<string, unknown> }[];
  }

  it('the current session on the global slot is told its rule accepts it, and how to move', async () => {
    await runSessionInclude('Auth Work', 'work', {}, harness().deps);
    const rule = await onlyRule();
    const h = harness(inCurrentSession());
    await runSessionShow(undefined, { json: true }, h.deps);
    const binding = (JSON.parse(h.text()) as ShowJson).sessions[0]?.binding;
    expect(binding).toMatchObject({
      via: 'alias',
      alias: 'Auth Work',
      folder: repo,
      ruleId: rule.id,
      members: ['work'],
      requiredSlot: ruleSlotId(rule.id),
      slot: 'global',
      slotSource: 'env',
      inScope: false,
    });

    const text = harness(inCurrentSession());
    await runSessionShow(undefined, {}, text.deps);
    expect(text.text()).toContain(`by its alias "Auth Work" in ${repo}`);
    expect(text.text()).toContain('it runs on the global slot, which its rule accepts');
    expect(text.text()).toContain(`to use work, resume it with: cctl claude --resume ${S_CUR}`);
  });

  it('the current session on its rule’s profile is on its own slot', async () => {
    await runSessionInclude('Auth Work', 'work', {}, harness().deps);
    const rule = await onlyRule();
    const h = harness({
      env: {
        [SESSION_ID_ENV]: S_CUR,
        CLAUDE_CONFIG_DIR: groupProfileDir(paths.vaultDir, rule.id),
      },
    });
    await runSessionShow(undefined, { json: true }, h.deps);
    expect((JSON.parse(h.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      inScope: true,
      slotSource: 'env',
    });
  });

  it('a session on ANOTHER rule’s slot is called out, with the command that resumes it', async () => {
    const folderRule = await engine.includeInFolder(away, [client.id]);
    await runSessionInclude('Auth Work', 'work', {}, harness().deps);
    const h = harness({
      env: {
        [SESSION_ID_ENV]: S_CUR,
        CLAUDE_CONFIG_DIR: groupProfileDir(paths.vaultDir, folderRule.rule.id),
      },
    });
    await runSessionShow(undefined, {}, h.deps);
    expect(h.text()).toContain(`NOT its rule's slot: it runs on the folder slot of ${away}`);
    expect(h.text()).toContain(`cctl claude --resume ${S_CUR}`);
  });

  it('another session is judged by the slot the daemon last recorded for it, else unknown', async () => {
    await runSessionInclude('Side', 'client', { cwd: away }, harness().deps);
    const rule = await onlyRule();
    const unknown = harness();
    await runSessionShow('Side', { json: true, cwd: away }, unknown.deps);
    expect((JSON.parse(unknown.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      inScope: null,
      slot: null,
    });

    const store = new Store(daemonDbPath(paths));
    try {
      store.recordSessionSlot(S_OTHER, 'global', NOW);
      store.recordSessionSlot(S_OTHER, ruleSlotId(rule.id), NOW + HOUR);
    } finally {
      store.close();
    }
    const recorded = harness();
    await runSessionShow('Side', { json: true, cwd: away }, recorded.deps);
    expect((JSON.parse(recorded.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      inScope: true,
      slotSource: 'recorded',
      slot: ruleSlotId(rule.id),
    });
  });

  it('a session no rule applies to reports none (the global slot)', async () => {
    const h = harness();
    await runSessionShow('Side', { json: true, cwd: away }, h.deps);
    expect((JSON.parse(h.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      via: null,
      ruleId: null,
      requiredSlot: 'global',
    });
    const text = harness();
    await runSessionShow('Side', { cwd: away }, text.deps);
    expect(text.text()).toContain('Rule      none: it runs on the global slot and the shared pool');
  });

  it('a generated-title session in an alias-ruled folder is not under the alias rule', async () => {
    await runSessionInclude('Fix the parser', 'work', {}, harness().deps);
    const h = harness();
    await runSessionShow(S_AI, { json: true }, h.deps);
    // Only CUSTOM titles count: the generated title equal to the alias does not route the session.
    expect((JSON.parse(h.text()) as ShowJson).sessions[0]?.binding).toMatchObject({ via: null });
  });
});
