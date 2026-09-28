// A session id can exist in more than one project directory (a relocation leaves a copy behind).
// `cctl claude --resume <id>` — the command an enforcement block prints — must open the copy Claude
// Code opens: the one inside the launch folder's resume search scope. Routing by the newest copy
// machine-wide instead sends the block's own hint to whichever unbound folder holds a newer copy, so
// the guard blocks the resumed session again on the same command: a loop.
//
// Each test drives the REAL launcher decision (resolveLaunchBinding over launchSessionContext, the
// exact wiring `cctl claude` uses, reading real transcript files) and then the REAL generated guard
// (writeBindGuard) with the payload and env Claude Code 2.1.283 sends, on the slot the launcher chose
// — the same harness as aliasRouting.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBindGuard } from '@claude-control/daemon';
import {
  aliasKey,
  canonicalizeFolder,
  projectDirStem,
  type StoredGroup,
} from '@claude-control/switch-engine';
import { launchSessionContext, resolveLaunchBinding } from './bindCommands.js';

/** Session ids as Claude Code writes them; the last character varies per test. */
const SID = 'aaaaaaaa-0000-4000-8000-00000000000';

let root: string;
let claudeDir: string;
let profiles: Record<string, string>;
let guardScript: string;
let snapshotPath: string;

function canon(p: string): string {
  const r = canonicalizeFolder(p, {
    platform: process.platform,
    cwd: process.cwd(),
    realpath: (x) => realpathSync.native(x),
  });
  if (!r.ok) throw new Error(r.reason);
  return r.path;
}

/** A real folder under the sandbox, canonical. */
function dir(...parts: string[]): string {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return canon(p);
}

interface AliasSpec {
  groupId: string;
  member: string;
  folder: string;
  alias: string;
}

/** Write the guard snapshot and return the vault StoredGroup[] for a set of alias-only groups. */
function bindAliases(specs: AliasSpec[]): StoredGroup[] {
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      enforce: 'block',
      mainConfigDir: canon(claudeDir),
      groups: specs.map((s) => ({
        id: s.groupId,
        label: s.groupId,
        profileDir: profiles[s.groupId]!,
        folders: [],
        aliases: [{ folder: s.folder, aliasKey: aliasKey(s.alias), alias: s.alias }],
        members: [s.member],
      })),
    }),
  );
  return specs.map((s) => ({
    id: s.groupId,
    label: s.groupId,
    members: [
      { id: s.member, label: s.member, quarantined: false, createdAtMs: 1, updatedAtMs: 1 },
    ],
    activeId: s.member,
    folders: [],
    aliases: [{ folder: s.folder, alias: s.alias }],
    createdAtMs: 1,
    updatedAtMs: 1,
  }));
}

/** The transcript file of session `id` whose project directory is named after `dirOf`. */
const transcriptPath = (dirOf: string, id: string): string =>
  join(claudeDir, 'projects', projectDirStem(dirOf), `${id}.jsonl`);

/** Write a transcript shaped like Claude Code 2.1.283's for a named session recorded in `cwd`. */
function ccTranscript(cwd: string, id: string, opts: { title: string; dirOf?: string }): string {
  const file = transcriptPath(opts.dirOf ?? cwd, id);
  mkdirSync(join(file, '..'), { recursive: true });
  const lines: object[] = [
    { type: 'custom-title', customTitle: opts.title, sessionId: id },
    { type: 'agent-name', agentName: opts.title, sessionId: id },
    { type: 'queue-operation', operation: 'enqueue', sessionId: id, content: 'hi' },
    { type: 'queue-operation', operation: 'dequeue', sessionId: id },
    {
      type: 'user',
      message: { role: 'user', content: 'hi' },
      entrypoint: 'cli',
      cwd,
      sessionId: id,
    },
    { type: 'assistant', message: { role: 'assistant', content: 'OK' }, cwd, sessionId: id },
    { type: 'custom-title', customTitle: opts.title, sessionId: id },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** The group id (or 'global') `cctl claude <args>` run in `cwd` routes to. */
async function launchGroup(
  cwd: string,
  args: string[],
  groups: StoredGroup[],
  worktrees: string[] = [],
): Promise<string> {
  const decision = await resolveLaunchBinding({
    ...launchSessionContext({
      cwd,
      claudeDir,
      platform: process.platform,
      gitWorktrees: () => Promise.resolve(worktrees),
    }),
    args,
    groups,
    platform: process.platform,
  });
  return decision.binding?.groupId ?? 'global';
}

/** Run the real guard on `slot` (a group id whose profile is used, or 'global') for a session. */
function guard(opts: { slot: string; projectDir: string; title?: string; transcript: string }): {
  decision?: string;
  reason?: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CCTL_BIND_OVERRIDE', 'CCTL_LAUNCH_EXPLICIT'])
    delete env[k];
  env.CLAUDE_PROJECT_DIR = opts.projectDir.replace(/\\/g, '/');
  if (opts.slot !== 'global') env.CLAUDE_CONFIG_DIR = profiles[opts.slot]!;
  const payload: Record<string, unknown> = {
    hook_event_name: 'UserPromptSubmit',
    session_id: basename(opts.transcript, '.jsonl'),
    prompt: 'go on',
    cwd: opts.projectDir,
    transcript_path: opts.transcript,
  };
  if (opts.title !== undefined) payload.session_title = opts.title;
  const r = spawnSync(process.execPath, [guardScript], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
  });
  expect(r.stderr).toBe('');
  return r.stdout === '' ? {} : (JSON.parse(r.stdout) as Record<string, string>);
}

/** The argv of the resume command a block reason prints (an id, or a single-quoted alias). */
function hintArgs(reason: string | undefined): string[] {
  const m = /cctl claude --resume (.*)$/.exec(reason ?? '');
  if (m === null) throw new Error(`no resume command in: ${reason}`);
  const arg = m[1]!;
  const quoted = /^'(.*)'$/.exec(arg);
  if (quoted === null) return ['--resume', arg];
  const text = quoted[1]!;
  return [
    '--resume',
    process.platform === 'win32' ? text.replace(/''/g, "'") : text.replace(/'\\''/g, "'"),
  ];
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cctl-alias-dupid-'));
  claudeDir = join(root, 'claude');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  profiles = { A: dir('profiles', 'A'), B: dir('profiles', 'B') };
  guardScript = join(root, 'bind-guard.cjs');
  snapshotPath = join(root, 'folder-bindings.json');
  await writeBindGuard(guardScript, snapshotPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('two transcript copies of one id (a relocation left it in two places)', () => {
  it('the guard judges the bound copy; following --resume <id> routes to the binding, not the newer unbound copy', async () => {
    const repo = dir('repo');
    const other = dir('other');
    const groups = bindAliases([{ groupId: 'A', member: 'alpha', folder: repo, alias: 'X' }]);
    const id = `${SID}2`;
    // The copy in the bound folder (older).
    const boundCopy = ccTranscript(repo, id, { title: 'X' });
    // A copy of the SAME id in an unbound folder, made newer.
    const unboundCopy = ccTranscript(other, id, { title: 'X', dirOf: other });
    utimesSync(boundCopy, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    utimesSync(unboundCopy, new Date(), new Date());

    // The session runs in the bound folder on the shared account, and is blocked: the printed
    // command names the session by id.
    const blocked = guard({ slot: 'global', projectDir: repo, title: 'X', transcript: boundCopy });
    expect(blocked.decision).toBe('block');
    const args = hintArgs(blocked.reason);
    expect(args).toEqual(['--resume', id]);

    // Following that command from the folder it was blocked in must land on the binding and be
    // allowed there — never loop back to the shared slot via the newer out-of-scope copy.
    const to = await launchGroup(repo, args, groups);
    expect(to).toBe('A');
    expect(guard({ slot: to, projectDir: repo, title: 'X', transcript: boundCopy })).toEqual({});
  });

  it('copies of one id in two DIFFERENTLY bound folders both in scope: the launcher falls back to the folder rule', async () => {
    // From the repository root (two worktrees) Claude Code's resume scope reaches both the subfolder
    // and the prefix-sibling copy; they map to different bindings, so the launcher cannot tell which
    // Claude Code will open and leaves the pick to the guard.
    const repo = dir('repo');
    const sub = dir('repo', 'sub');
    const other = dir('repo-other');
    const groups = bindAliases([
      { groupId: 'A', member: 'alpha', folder: sub, alias: 'X' },
      { groupId: 'B', member: 'beta', folder: other, alias: 'X' },
    ]);
    const id = `${SID}3`;
    ccTranscript(sub, id, { title: 'X' });
    ccTranscript(other, id, { title: 'X', dirOf: other });
    const worktrees = [repo, join(root, 'repo-wt')];

    expect(await launchGroup(repo, ['--resume', id], groups, worktrees)).toBe('global');
  });
});
