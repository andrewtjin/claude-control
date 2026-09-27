// The launcher and the enforcement guard must agree on which binding a session belongs to: when
// they do not, a legitimately bound session is blocked on the very command the block tells the
// operator to run, or a bound conversation leaves its binding.
//
// Each test drives the REAL launcher decision (resolveLaunchBinding over launchSessionContext — the
// exact wiring `cctl claude` uses — reading real transcript files) and then the REAL generated guard
// script (writeBindGuard) with the UserPromptSubmit payload and env Claude Code 2.1.283 sends for the
// session that opens, on the slot the launcher chose. Transcript shapes are the measured ones:
//   - a named `-p` session writes custom-title, agent-name, queue-operation (enqueue, content = the
//     prompt), queue-operation (dequeue), then the user line whose cwd key FOLLOWS the message — so
//     the prompt is written twice before the first cwd (a 70 KiB prompt put it at ~144 KB);
//   - the first prompt of a NEW session (`--name`, or a fork) is judged before its transcript exists;
//   - `--fork-session` copies the conversation into a NEW transcript in the LAUNCH folder's project
//     directory, every cwd rewritten to the launch folder, the same title;
//   - resuming keeps hook cwd = CLAUDE_PROJECT_DIR = the launch folder and the original transcript;
//   - Claude Code resolves a junction in its cwd (its project directory is the target's).

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBindGuard } from '@claude-control/daemon';
import {
  aliasKey,
  canonicalizeFolder,
  projectDirStem,
  shellQuoteArg,
  type StoredGroup,
} from '@claude-control/switch-engine';
import { launchSessionContext, resolveLaunchBinding } from './bindCommands.js';

/** Session ids as Claude Code writes them; the last character varies per test. */
const SID = 'aaaaaaaa-0000-4000-8000-00000000000';

let root: string;
let claudeDir: string;
let profileA: string;
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

/** One alias-only group "A" holding (folder, alias): the vault's view and the guard's snapshot. */
function bindAlias(folder: string, alias: string): StoredGroup[] {
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      enforce: 'block',
      mainConfigDir: canon(claudeDir),
      groups: [
        {
          id: 'A',
          label: 'A',
          profileDir: profileA,
          folders: [],
          aliases: [{ folder, aliasKey: aliasKey(alias), alias }],
          members: ['alpha'],
        },
      ],
    }),
  );
  return [
    {
      id: 'A',
      label: 'A',
      members: [
        { id: 'alpha', label: 'alpha', quarantined: false, createdAtMs: 1, updatedAtMs: 1 },
      ],
      activeId: 'alpha',
      folders: [],
      aliases: [{ folder, alias }],
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ];
}

/** The transcript file of session `id` whose project directory is named after `dirOf`. */
const transcriptPath = (dirOf: string, id: string): string =>
  join(claudeDir, 'projects', projectDirStem(dirOf), `${id}.jsonl`);

/** Write a transcript shaped like Claude Code 2.1.283's for a named session recorded in `cwd`. */
function ccTranscript(
  cwd: string,
  id: string,
  opts: { title: string; prompt?: string; tail?: object[]; dirOf?: string; entrypoint?: string },
): string {
  const prompt = opts.prompt ?? 'hi';
  const file = transcriptPath(opts.dirOf ?? cwd, id);
  mkdirSync(join(file, '..'), { recursive: true });
  const lines: object[] = [
    { type: 'custom-title', customTitle: opts.title, sessionId: id },
    { type: 'agent-name', agentName: opts.title, sessionId: id },
    { type: 'queue-operation', operation: 'enqueue', sessionId: id, content: prompt },
    { type: 'queue-operation', operation: 'dequeue', sessionId: id },
    {
      type: 'user',
      message: { role: 'user', content: prompt },
      // `cli` for an interactive session, `sdk-cli` for one started by `-p` or the SDK.
      entrypoint: opts.entrypoint ?? 'cli',
      cwd,
      sessionId: id,
    },
    { type: 'assistant', message: { role: 'assistant', content: 'OK' }, cwd, sessionId: id },
    { type: 'custom-title', customTitle: opts.title, sessionId: id },
    ...(opts.tail ?? []),
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** Where `cctl claude <args>` run in `cwd` puts the session: 'A' (the alias group) or 'global'. */
async function launch(
  cwd: string,
  args: string[],
  groups: StoredGroup[],
  worktrees: string[] = [],
): Promise<'A' | 'global'> {
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
  return decision.binding?.groupId === 'A' ? 'A' : 'global';
}

/** Run the real guard for one prompt on `slot`, as Claude Code does. {} = allowed silently. */
function guard(opts: {
  slot: 'A' | 'global';
  projectDir: string;
  title?: string;
  transcript: string;
}): { decision?: string; reason?: string; systemMessage?: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CCTL_BIND_OVERRIDE', 'CCTL_LAUNCH_EXPLICIT'])
    delete env[k];
  // Claude Code sets CLAUDE_PROJECT_DIR with forward slashes on Windows (measured).
  env.CLAUDE_PROJECT_DIR = opts.projectDir.replace(/\\/g, '/');
  if (opts.slot === 'A') env.CLAUDE_CONFIG_DIR = profileA;
  const payload: Record<string, unknown> = {
    hook_event_name: 'UserPromptSubmit',
    // Claude Code names the transcript after the session id.
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

/** The argv of the resume command a block reason prints (PowerShell or POSIX single quotes). */
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
  root = mkdtempSync(join(tmpdir(), 'cctl-alias-route-'));
  claudeDir = join(root, 'claude');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  profileA = dir('profiles', 'A');
  guardScript = join(root, 'bind-guard.cjs');
  snapshotPath = join(root, 'folder-bindings.json');
  await writeBindGuard(guardScript, snapshotPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('a long first prompt pushes the recorded folder past a small read window', () => {
  // Measured: a 70 KiB first prompt put the first cwd-carrying line at byte 144369.
  it('cctl claude --resume <bound alias> lands on the bound account, and the guard allows it', async () => {
    const repo = dir('repo');
    const groups = bindAlias(repo, 'Big Alias');
    const file = ccTranscript(repo, `${SID}1`, {
      title: 'Big Alias',
      prompt: 'x'.repeat(70 * 1024),
    });

    const slot = await launch(repo, ['--resume', 'Big Alias'], groups);
    const verdict = guard({ slot, projectDir: repo, title: 'Big Alias', transcript: file });

    expect({ slot, verdict }).toEqual({ slot: 'A', verdict: {} });
  });

  it('cctl claude -c continues the long-prompt session Claude Code continues, not an older one', async () => {
    const repo = dir('repo');
    const groups = bindAlias(repo, 'Big Alias');
    const older = ccTranscript(repo, `${SID}2`, { title: 'Unbound Older' });
    const newest = ccTranscript(repo, `${SID}3`, {
      title: 'Big Alias',
      prompt: 'x'.repeat(70 * 1024),
    });
    utimesSync(older, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    utimesSync(newest, new Date(), new Date());

    const slot = await launch(repo, ['-c'], groups);
    const verdict = guard({ slot, projectDir: repo, title: 'Big Alias', transcript: newest });

    expect({ slot, verdict }).toEqual({ slot: 'A', verdict: {} });
  });

  it('a first cwd past even the 1 MiB window: both fall back to the folder the session runs in', async () => {
    const repo = dir('repo');
    const groups = bindAlias(repo, 'Huge');
    const file = ccTranscript(repo, `${SID}4`, { title: 'Huge', prompt: 'x'.repeat(1_200_000) });

    for (const args of [['--resume', 'Huge'], ['-c']]) {
      const slot = await launch(repo, args, groups);
      const verdict = guard({ slot, projectDir: repo, title: 'Huge', transcript: file });
      expect({ args, slot, verdict }).toEqual({ args, slot: 'A', verdict: {} });
    }
  });
});

describe('relocations: the launcher and the guard read the same last relocation', () => {
  it('a session relocated into a .claude worktree belongs there: routed and judged alike', async () => {
    const repo = dir('repo');
    const wt = dir('repo', '.claude', 'worktrees', 'feature');
    const groups = bindAlias(repo, 'X');
    const id = `${SID}5`;
    const file = ccTranscript(repo, id, {
      title: 'X',
      tail: [{ type: 'relocated', sessionId: id, relocatedCwd: wt }],
    });

    const slot = await launch(repo, ['--resume', 'X'], groups);
    const verdict = guard({ slot, projectDir: repo, title: 'X', transcript: file });

    // Its conversation moved out of repo, so (repo, X) no longer covers it — on either side.
    expect({ slot, verdict }).toEqual({ slot: 'global', verdict: {} });
  });

  it('a session recorded in a worktree and relocated back into the repository is routed and allowed', async () => {
    const repo = dir('repo');
    const wt = dir('repo', '.claude', 'worktrees', 'feature');
    const groups = bindAlias(repo, 'X');
    const id = `${SID}6`;
    // Claude Code never moves the transcript: it stays in the worktree's project directory, which
    // the repository's `<repo>--claude-worktrees-*` search scope reaches.
    const file = ccTranscript(wt, id, {
      title: 'X',
      tail: [{ type: 'relocated', sessionId: id, relocatedCwd: repo }],
    });

    const slot = await launch(repo, ['--resume', 'X'], groups);
    const verdict = guard({ slot, projectDir: repo, title: 'X', transcript: file });

    expect({ slot, verdict }).toEqual({ slot: 'A', verdict: {} });
  });

  it('a round trip (out to a worktree and back) is routed and allowed', async () => {
    const repo = dir('repo');
    const wt = dir('repo', '.claude', 'worktrees', 'feature');
    const groups = bindAlias(repo, 'X');
    const id = `${SID}7`;
    const file = ccTranscript(repo, id, {
      title: 'X',
      tail: [
        { type: 'relocated', sessionId: id, relocatedCwd: wt },
        { type: 'relocated', sessionId: id, relocatedCwd: repo },
      ],
    });
    const slot = await launch(repo, ['--resume', 'X'], groups);
    const verdict = guard({ slot, projectDir: repo, title: 'X', transcript: file });
    expect({ slot, verdict }).toEqual({ slot: 'A', verdict: {} });
  });
});

describe('cctl claude run from a link to a bound folder', () => {
  // Measured: launched in a junction to realdir, Claude Code resolves it — CLAUDE_PROJECT_DIR, the
  // hook cwd, the project directory and the recorded cwd are all realdir.
  it('cctl claude --resume <bound alias> from the link lands on the bound account', async () => {
    const real = dir('realdir');
    const link = join(root, 'linkdir');
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const groups = bindAlias(real, 'J Alias');
    const file = ccTranscript(real, `${SID}8`, { title: 'J Alias' });

    const slot = await launch(link, ['--resume', 'J Alias'], groups);
    const verdict = guard({ slot, projectDir: real, title: 'J Alias', transcript: file });

    expect({ slot, verdict }).toEqual({ slot: 'A', verdict: {} });
  });
});

describe('the block of a session picked from an ambiguous title resumes THAT session', () => {
  // (repo/sub, X) is bound; the prefix sibling repo-other also holds an unbound "X". From the repo
  // root (two worktrees) Claude Code's search reaches both, so `claude --resume X` opens its picker;
  // the launcher sees candidates that disagree and launches by the folder rule, leaving the pick to
  // the guard. The operator picks the bound conversation and is blocked: the printed command must
  // reach the bound account, not reopen the same picker.
  it('following the printed command lands the picked session on its bound account', async () => {
    const repo = dir('repo');
    const sub = dir('repo', 'sub');
    const other = dir('repo-other');
    const groups = bindAlias(sub, 'X');
    const picked = ccTranscript(sub, `${SID}a`, { title: 'X' });
    ccTranscript(other, `${SID}b`, { title: 'X' });
    const worktrees = [repo, join(root, 'repo-wt')];

    const slot = await launch(repo, ['--resume', 'X'], groups, worktrees);
    expect(slot).toBe('global');
    const blocked = guard({ slot, projectDir: repo, title: 'X', transcript: picked });
    expect(blocked.decision).toBe('block');
    const args = hintArgs(blocked.reason);
    expect(args).toEqual(['--resume', `${SID}a`]);

    const again = await launch(repo, args, groups, worktrees);
    expect({
      again,
      verdict: guard({ slot: again, projectDir: repo, title: 'X', transcript: picked }),
    }).toEqual({ again: 'A', verdict: {} });
  });
});

describe('a fork belongs to the folder it is launched in', () => {
  // Measured (two worktrees, so the root reaches the subfolder): from the repo root,
  // `claude --resume "Sub Alias" --fork-session` forked the session recorded in repo/sub into a NEW
  // transcript in the ROOT's project directory, every cwd rewritten to the root, the SAME title, and
  // the fork's first prompt was judged before that transcript existed.
  function setup() {
    const repo = dir('repo');
    const sub = dir('repo', 'sub');
    const groups = bindAlias(sub, 'Sub Alias');
    ccTranscript(sub, `${SID}c`, { title: 'Sub Alias' });
    return { repo, sub, groups, worktrees: [repo, join(root, 'repo-wt')] };
  }

  it('forked from the repository root: a new conversation of the root, routed and judged as one', async () => {
    const { repo, groups, worktrees } = setup();
    const slot = await launch(repo, ['--resume', 'Sub Alias', '--fork-session'], groups, worktrees);
    expect(slot).toBe('global');

    const fork = transcriptPath(repo, `${SID}d`);
    const first = guard({ slot, projectDir: repo, title: 'Sub Alias', transcript: fork });
    ccTranscript(repo, `${SID}d`, { title: 'Sub Alias' });
    const later = guard({ slot, projectDir: repo, title: 'Sub Alias', transcript: fork });

    expect({ first, later }).toEqual({ first: {}, later: {} });
  });

  it('...while the conversation it came from, resumed there, stays held to its binding', async () => {
    const { repo, sub, groups, worktrees } = setup();
    const original = transcriptPath(sub, `${SID}c`);
    expect(await launch(repo, ['--resume', 'Sub Alias'], groups, worktrees)).toBe('A');
    const onShared = guard({
      slot: 'global',
      projectDir: repo,
      title: 'Sub Alias',
      transcript: original,
    });
    expect(onShared.decision).toBe('block');
  });

  it('forked in its own folder: it stays bound, whether launched by --resume or -c', async () => {
    const { sub, groups } = setup();
    for (const args of [
      ['--resume', 'Sub Alias', '--fork-session'],
      ['-c', '--fork-session'],
    ]) {
      const slot = await launch(sub, args, groups);
      const fork = transcriptPath(sub, `${SID}e`);
      rmSync(fork, { force: true });
      const first = guard({ slot, projectDir: sub, title: 'Sub Alias', transcript: fork });
      ccTranscript(sub, `${SID}e`, { title: 'Sub Alias' });
      const later = guard({ slot, projectDir: sub, title: 'Sub Alias', transcript: fork });
      rmSync(fork, { force: true });
      expect({ args, slot, first, later }).toEqual({ args, slot: 'A', first: {}, later: {} });
    }
  });

  it('forked in its own folder on the shared account: blocked, and the printed command routes it', async () => {
    const { sub, groups } = setup();
    const fork = transcriptPath(sub, `${SID}f`);
    // Before its transcript exists there is nothing to resume by id: the alias is printed.
    const first = guard({ slot: 'global', projectDir: sub, title: 'Sub Alias', transcript: fork });
    expect(first.reason).toContain(
      `cctl claude --resume ${shellQuoteArg('Sub Alias', process.platform)}`,
    );
    expect(await launch(sub, hintArgs(first.reason), groups)).toBe('A');
    // Once it exists, THE session is printed, and resuming it by id routes it too.
    ccTranscript(sub, `${SID}f`, { title: 'Sub Alias' });
    const later = guard({ slot: 'global', projectDir: sub, title: 'Sub Alias', transcript: fork });
    expect(hintArgs(later.reason)).toEqual(['--resume', `${SID}f`]);
    expect(await launch(sub, hintArgs(later.reason), groups)).toBe('A');
  });
});

describe('a transcript whose head claims a folder its project directory does not encode', () => {
  it('is judged by the folder it runs in on both sides: never routed onto the binding', async () => {
    const bound = dir('bound');
    const elsewhere = dir('elsewhere');
    const groups = bindAlias(bound, 'X');
    // The conversation lives in elsewhere's project directory; only its head was edited.
    const file = ccTranscript(bound, `${SID}9`, { title: 'X', dirOf: elsewhere });

    const slot = await launch(elsewhere, ['--resume', 'X'], groups);
    expect({
      slot,
      verdict: guard({ slot, projectDir: elsewhere, title: 'X', transcript: file }),
    }).toEqual({ slot: 'global', verdict: {} });
    // ...and on the reserved account it is blocked, not silently allowed.
    const onA = guard({ slot: 'A', projectDir: elsewhere, title: 'X', transcript: file });
    expect(onA.decision).toBe('block');
  });
});

describe('a bound session started by -p or the SDK', () => {
  // Measured: interactive `claude --resume "<title>"` does not list a session whose transcript
  // records entrypoint "sdk-cli" (its picker reports no match); `claude -p --resume` resumes it.
  it('an interactive launch does not route by it; a -p launch does, and the guard agrees', async () => {
    const repo = dir('repo');
    const groups = bindAlias(repo, 'Batch');
    const file = ccTranscript(repo, `${SID}0`, { title: 'Batch', entrypoint: 'sdk-cli' });

    expect(await launch(repo, ['--resume', 'Batch'], groups)).toBe('global');
    const slot = await launch(repo, ['-p', 'go on', '--resume', 'Batch'], groups);
    expect({
      slot,
      verdict: guard({ slot, projectDir: repo, title: 'Batch', transcript: file }),
    }).toEqual({ slot: 'A', verdict: {} });
  });
});

describe('controls: the same shapes without the trigger', () => {
  it('a small first prompt: routed to the bound account, allowed there, blocked on the shared one', async () => {
    const repo = dir('repo');
    const groups = bindAlias(repo, 'Small');
    const file = ccTranscript(repo, `${SID}0`, { title: 'Small' });
    const slot = await launch(repo, ['--resume', 'Small'], groups);
    expect({
      slot,
      verdict: guard({ slot, projectDir: repo, title: 'Small', transcript: file }),
    }).toEqual({ slot: 'A', verdict: {} });
    expect(
      guard({ slot: 'global', projectDir: repo, title: 'Small', transcript: file }).decision,
    ).toBe('block');
  });

  it('a plain cross-folder resume from the repository root: routed to the sub binding and allowed', async () => {
    const repo = dir('repo');
    const sub = dir('repo', 'sub');
    const groups = bindAlias(sub, 'Sub Alias');
    const file = ccTranscript(sub, `${SID}0`, { title: 'Sub Alias' });
    const slot = await launch(repo, ['--resume', 'Sub Alias'], groups, [
      repo,
      join(root, 'repo-wt'),
    ]);
    expect({
      slot,
      verdict: guard({ slot, projectDir: repo, title: 'Sub Alias', transcript: file }),
    }).toEqual({ slot: 'A', verdict: {} });
  });
});
