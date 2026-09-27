// Integration tests for `cctl session bind` / `cctl session unbind`, and for the binding line of
// `cctl session show` and the alias rows of `cctl bindings`, end to end over real files: a temp
// Claude config dir with transcripts in Claude Code's layout, a temp vault driven through a real
// SwitchEngine (with a passthrough protector a test can read), the daemon database beside it, and
// the real guard reconcile writing the sandbox's settings.json. Nothing touches the developer's real
// ~/.claude, vault or daemon database.
//
// What only an end-to-end run proves: the defaults (alias = this session's custom title, account =
// the one it runs on now) are read from the same places a real session exposes them; a bind of an
// already-bound alias GROWS it (and refuses when that would grow other scopes); the first alias bind
// installs the enforcement guard; and the operator is told plainly when the session running the
// command is now outside its binding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store, bindGuardPath, projectDirStem } from '@claude-control/daemon';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  folderBindingsPath,
  groupProfileDir,
  groupSlotId,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { CliFailure, daemonDbPath } from './context.js';
import { SESSION_ID_ENV, runSessionShow, type SessionAliasDeps } from './sessionAliases.js';
import { runSessionBind, runSessionUnbind } from './sessionBinding.js';
import { renderBindingGroups } from './render.js';

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
  root = await mkdtemp(join(tmpdir(), 'cctl-session-binding-'));
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

function harness(over: Partial<SessionAliasDeps> = {}) {
  const written: string[] = [];
  const deps: SessionAliasDeps = {
    paths,
    env: {},
    cwd: repo,
    platform: process.platform,
    write: (t) => written.push(t),
    note: () => {},
    engine,
    ...over,
  };
  return { deps, text: () => written.join('') };
}

/** Inside session S_CUR, on the global slot (no CLAUDE_CONFIG_DIR): what `cctl` sees when run
 *  from a Bash tool of that session. */
const inCurrentSession = () => ({ env: { [SESSION_ID_ENV]: S_CUR } });

describe('cctl session bind', () => {
  it('defaults the alias and account from the current session, installs the guard, and warns this session', async () => {
    const h = harness(inCurrentSession());
    await runSessionBind(undefined, undefined, {}, h.deps);
    const out = h.text();

    const group = (await engine.listGroups())[0]!;
    expect(group.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
    expect(group.members.map((m) => m.id)).toEqual([main.id]);
    expect(out).toContain(`Bound session "Auth Work" in ${repo} to main.`);
    // main was the global live account: it moved off global first.
    expect(out).toContain('global slot switched off main');
    expect(await engine.getActiveId('global')).not.toBe(main.id);
    expect(await engine.getActiveId(groupSlotId(group.id))).toBe(main.id);
    expect(out).toContain(`profile ready on main: ${groupProfileDir(paths.vaultDir, group.id)}`);
    // This session runs in the global slot, the binding now names the alias group: say so plainly.
    expect(out).toContain('This session is now outside its binding');
    // THIS session is resumed by its id: its alias may be shared by other sessions.
    expect(out).toContain(`cctl claude --resume ${S_CUR}`);

    // The FIRST alias bind installed the guard (the first-bind gap must not reopen for aliases)...
    const settings = await readFile(join(paths.claudeDir, 'settings.json'), 'utf8');
    expect(settings).toContain('bind-guard.cjs');
    expect(existsSync(bindGuardPath(dirname(paths.vaultDir)))).toBe(true);
    // ...and the snapshot it reads carries the alias key.
    const snap = JSON.parse(await readFile(folderBindingsPath(paths.vaultDir), 'utf8')) as {
      groups: { aliases: unknown }[];
    };
    // The key the guard compares, plus the alias as bound for its messages.
    expect(snap.groups[0]?.aliases).toEqual([
      { folder: repo, aliasKey: 'auth work', alias: 'Auth Work' },
    ]);
  });

  it('uses the session’s own folder for its own alias, even from a subfolder cwd', async () => {
    const sub = join(repo, 'src');
    await mkdir(sub, { recursive: true });
    const h = harness({ ...inCurrentSession(), cwd: sub });
    await runSessionBind(undefined, 'work', {}, h.deps);
    expect((await engine.listGroups())[0]?.aliases).toEqual([{ folder: repo, alias: 'Auth Work' }]);
  });

  it('refuses a session that only has a generated title: name it first', async () => {
    const h = harness({ env: { [SESSION_ID_ENV]: S_AI } });
    const attempt = runSessionBind(undefined, undefined, {}, h.deps);
    await expect(attempt).rejects.toBeInstanceOf(CliFailure);
    await expect(runSessionBind(undefined, undefined, {}, h.deps)).rejects.toThrow(
      /only the generated title "Fix the parser".*name it first: \/rename <alias>/,
    );
    expect(await engine.listGroups()).toEqual([]);
  });

  it('refuses without an alias outside a session, and without accounts outside a session', async () => {
    const h = harness();
    await expect(runSessionBind(undefined, undefined, {}, h.deps)).rejects.toThrow(
      /not a Claude Code session .*CLAUDE_CODE_SESSION_ID is unset/,
    );
    await expect(runSessionBind('x', undefined, {}, h.deps)).rejects.toThrow(
      /pass the accounts to bind/,
    );
    expect(await engine.listGroups()).toEqual([]);
  });

  it('binds an explicit alias in --cwd to an explicit account list', async () => {
    const h = harness();
    await runSessionBind('Side', 'work,client', { cwd: away, label: 'Side work' }, h.deps);
    const group = (await engine.listGroups())[0]!;
    expect(group.label).toBe('Side work');
    expect(group.aliases).toEqual([{ folder: away, alias: 'Side' }]);
    expect(group.members.map((m) => m.id).sort()).toEqual([work.id, client.id].sort());
    expect(h.text()).toContain(`Bound session "Side" in ${away} to work, client.`);
    // Not run inside a session: no note about "this session".
    expect(h.text()).not.toContain('This session');
  });

  it('GROWS an already-bound alias: the accounts are added to its binding', async () => {
    const h = harness();
    await runSessionBind('Side', 'work', { cwd: away }, h.deps);
    const again = harness();
    await runSessionBind('side', 'client', { cwd: away }, again.deps);
    const groups = await engine.listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.id).sort()).toEqual([work.id, client.id].sort());
    expect(again.text()).toContain(
      `Added client to session "side" in ${away}; it is now bound to work, client.`,
    );
  });

  it('grows with the current session’s account by default (moving global off it)', async () => {
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    const h = harness(inCurrentSession()); // on the global slot, whose live account is main
    await runSessionBind(undefined, undefined, {}, h.deps);
    const group = (await engine.listGroups())[0]!;
    expect(group.members.map((m) => m.id).sort()).toEqual([main.id, work.id].sort());
    expect(h.text()).toContain('global slot switched off main');
    expect(await engine.getActiveId('global')).toBe(client.id);
  });

  it('says nothing changed when every account is already bound', async () => {
    await runSessionBind('Side', 'work', { cwd: away }, harness().deps);
    const h = harness();
    await runSessionBind('Side', 'work', { cwd: away }, h.deps);
    expect(h.text()).toContain('is already bound to work; nothing changed.');
  });

  it('refuses to grow a binding that also carries other scopes, explaining why', async () => {
    // work's group holds a folder binding AND (by reuse of the exact set) the alias.
    await engine.bindFolder(away, [work.id]);
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    expect((await engine.listGroups())[0]?.folders).toEqual([away]);
    await expect(runSessionBind('Auth Work', 'client', {}, harness().deps)).rejects.toThrow(
      new RegExp(`together with ${away.replace(/\\/g, '\\\\')}.*would add them to those too`),
    );
  });

  it('turns an engine refusal into a CLI failure (an account reserved elsewhere)', async () => {
    await engine.bindFolder(away, [work.id, client.id]);
    await expect(runSessionBind('x', 'work', {}, harness().deps)).rejects.toThrow(
      /"work" is already reserved to .*unbind it there first/,
    );
  });

  it('shows the alias scope in the bindings listing', async () => {
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    const g = (await engine.listGroups())[0]!;
    const text = renderBindingGroups([
      {
        label: g.label,
        folders: g.folders,
        aliases: g.aliases ?? [],
        members: [{ label: 'work', live: true, quarantined: false, excluded: false }],
        profileDir: 'P',
        noWorkingAccount: false,
      },
    ]);
    expect(text).toContain(`session: "Auth Work" in ${repo}`);
  });
});

describe('cctl session unbind', () => {
  it('drops this session’s alias binding by default, dissolving it', async () => {
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    const h = harness(inCurrentSession());
    await runSessionUnbind(undefined, {}, h.deps);
    expect(await engine.listGroups()).toEqual([]);
    expect(h.text()).toContain(`Unbound session "Auth Work" in ${repo} and dissolved its binding.`);
    expect((await engine.listAccounts()).map((a) => a.id)).toContain(work.id);
  });

  it('shrinks the account list with --accounts', async () => {
    await runSessionBind('Side', 'work,client', { cwd: away }, harness().deps);
    const h = harness();
    await runSessionUnbind('Side', { cwd: away, accounts: 'client' }, h.deps);
    expect((await engine.listGroups())[0]?.members.map((m) => m.id)).toEqual([work.id]);
    expect(h.text()).toContain(
      `Removed client from session "Side" in ${away}; it is now bound to work.`,
    );
  });

  it('removing every account with --accounts dissolves the binding', async () => {
    await runSessionBind('Side', 'work', { cwd: away }, harness().deps);
    const h = harness();
    await runSessionUnbind('Side', { cwd: away, accounts: 'work' }, h.deps);
    expect(await engine.listGroups()).toEqual([]);
    expect(h.text()).toContain('dissolved its binding');
  });

  it('keeps the other scopes when the alias was not the last one', async () => {
    await engine.bindFolder(away, [work.id]);
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    const h = harness();
    await runSessionUnbind('Auth Work', {}, h.deps);
    expect((await engine.listGroups())[0]?.folders).toEqual([away]);
    expect(h.text()).toContain(`Its accounts stay bound to ${away}.`);
  });

  it('refuses an alias that is not bound, and shrinking a multi-scope binding', async () => {
    await expect(runSessionUnbind('nope', {}, harness().deps)).rejects.toThrow(/is not bound/);
    await engine.bindFolder(away, [work.id]);
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    await expect(
      runSessionUnbind('Auth Work', { accounts: 'work' }, harness().deps),
    ).rejects.toThrow(/would remove them from those too/);
  });
});

describe('cctl session show — Bound to', () => {
  interface ShowJson {
    sessions: { sessionId: string; binding?: Record<string, unknown> }[];
  }

  it('the current session on the wrong slot is OUT of scope, with the resume hint', async () => {
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    const group = (await engine.listGroups())[0]!;
    const h = harness(inCurrentSession());
    await runSessionShow(undefined, { json: true }, h.deps);
    const binding = (JSON.parse(h.text()) as ShowJson).sessions[0]?.binding;
    expect(binding).toMatchObject({
      via: 'alias',
      alias: 'Auth Work',
      folder: repo,
      groupId: group.id,
      members: ['work'],
      requiredSlot: groupSlotId(group.id),
      slot: 'global',
      slotSource: 'env',
      inScope: false,
    });

    const text = harness(inCurrentSession());
    await runSessionShow(undefined, {}, text.deps);
    expect(text.text()).toContain(`by alias "Auth Work" in ${repo}`);
    expect(text.text()).toContain('OUT of scope: it runs on the shared account');
    expect(text.text()).toContain(`cctl claude --resume ${S_CUR}`);
  });

  it('the current session on its bound profile is in scope', async () => {
    await runSessionBind('Auth Work', 'work', {}, harness().deps);
    const group = (await engine.listGroups())[0]!;
    const h = harness({
      env: {
        [SESSION_ID_ENV]: S_CUR,
        CLAUDE_CONFIG_DIR: groupProfileDir(paths.vaultDir, group.id),
      },
    });
    await runSessionShow(undefined, { json: true }, h.deps);
    expect((JSON.parse(h.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      inScope: true,
      slotSource: 'env',
    });
  });

  it('another session is judged by the slot the daemon last recorded for it, else unknown', async () => {
    await runSessionBind('Side', 'client', { cwd: away }, harness().deps);
    const group = (await engine.listGroups())[0]!;
    const unknown = harness();
    await runSessionShow('Side', { json: true, cwd: away }, unknown.deps);
    expect((JSON.parse(unknown.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      inScope: null,
      slot: null,
    });

    const store = new Store(daemonDbPath(paths));
    try {
      store.recordSessionSlot(S_OTHER, 'global', NOW);
      store.recordSessionSlot(S_OTHER, groupSlotId(group.id), NOW + HOUR);
    } finally {
      store.close();
    }
    const recorded = harness();
    await runSessionShow('Side', { json: true, cwd: away }, recorded.deps);
    expect((JSON.parse(recorded.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      inScope: true,
      slotSource: 'recorded',
      slot: groupSlotId(group.id),
    });
  });

  it('an unbound session reports nothing bound (the shared account)', async () => {
    const h = harness();
    await runSessionShow('Side', { json: true, cwd: away }, h.deps);
    expect((JSON.parse(h.text()) as ShowJson).sessions[0]?.binding).toMatchObject({
      via: null,
      groupId: null,
      requiredSlot: 'global',
    });
  });

  it('a generated-title session in an alias-bound folder is not bound by the alias', async () => {
    await runSessionBind('Fix the parser', 'work', {}, harness().deps);
    const h = harness();
    await runSessionShow(S_AI, { json: true }, h.deps);
    // Only CUSTOM titles bind: the generated title equal to the alias does not route the session.
    expect((JSON.parse(h.text()) as ShowJson).sessions[0]?.binding).toMatchObject({ via: null });
  });
});
