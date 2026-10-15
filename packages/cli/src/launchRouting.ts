// Which rule a `cctl claude` launch runs under: THE precedence rule applied to the session Claude
// Code's own arguments open (launcher.ts resolveLaunchSessions over Claude Code's session store, see
// launchSessionStore.ts) — the alias rule of that session's title in the folder its conversation is
// recorded in, else the folder rule of the launch folder, else the global slot. The one wiring
// `cctl claude` uses; its tests drive it over a sandbox config dir.
//
// The recorded folder is decided exactly as the enforcement guard decides it (switch-engine
// recordedFolderFor over readRecordedFolder), so the two can never disagree about a session.

import {
  canonicalStoredFolder,
  recordedFolderFor,
  resolveSessionRule,
  scopedRuleOf,
  type FolderRule,
  type SessionRuleMatch,
} from '@claude-control/switch-engine';
import { sanitizeForTerminal } from './ansi.js';
import {
  parseClaudeSessionArgs,
  resolveLaunchSessions,
  type LaunchCandidate,
  type LaunchSessionDeps,
} from './launcher.js';
import { claudeCodeCwd, launchSessionStore } from './launchSessionStore.js';
import { canonicalOrRaw } from './sessionAliases.js';

/** Which rule a `cctl claude` launch runs under, and the note (if any) to print about it. */
export interface LaunchRuleDecision {
  /** The rule, or null for the global slot. */
  match: SessionRuleMatch | null;
  /** The title a launch routed by an alias rule opens under, for the banner; null otherwise. */
  alias: string | null;
  /** One stderr line when the launcher could not tell which session opens, else null. */
  note: string | null;
}

/** The stderr note for a launch whose arguments do not say which session opens. The reason quotes
 *  operator text, so it passes sanitizeForTerminal at this sink. */
export function uncertainLaunchNote(reason: string): string {
  return (
    `cctl: could not tell which session these arguments open (${sanitizeForTerminal(reason)}); ` +
    `launching by the folder rule — the enforcement guard checks the session Claude Code opens\n`
  );
}

/**
 * Which rule a `cctl claude` launch runs under, by THE precedence rule applied to the session Claude
 * Code's own arguments open (launcher.ts resolveLaunchSessions): its title, and the folder its
 * conversation is RECORDED in — `claude --resume X` in a repository can reach sessions recorded in
 * subfolders and worktrees, and a resumed session keeps its original folder, so that recorded folder
 * is the one an alias rule is matched against (a fork is a new conversation of the launch folder);
 * the folder rule always uses the launch folder. When the arguments allow several sessions (a title
 * several sessions share, a newest transcript from another folder), the launch follows an alias rule
 * only if EVERY candidate maps to the same rule; otherwise, and whenever the arguments are
 * uncertain, it launches by the folder rule and leaves the pick to the enforcement guard.
 *
 * Nothing is parsed or read when no rule has an alias scope — no title could change the answer.
 */
export async function resolveLaunchRule(input: {
  /** The canonical launch folder. */
  folder: string;
  /** The launch folder as Claude Code spells it (see launchSessionStore's claudeCodeCwd): what a
   *  transcript's project-directory name is matched against when it records no folder of its own.
   *  Default: {@link folder}. */
  launchSpelling?: string;
  /** Claude Code's argv, read and never modified. */
  args: readonly string[];
  rules: readonly FolderRule[];
  platform: NodeJS.Platform;
  /** Claude Code's session store, searched from the launch folder. */
  sessions: LaunchSessionDeps;
  /** A recorded session folder in the form rules store folders (default: string-only
   *  canonicalization; the launcher passes the realpath-resolving one). */
  canonicalFolder?: (folder: string) => string;
}): Promise<LaunchRuleDecision> {
  const folderRule: LaunchRuleDecision = {
    match: resolveSessionRule(input.folder, null, input.rules, input.platform),
    alias: null,
    note: null,
  };
  const boundAliasKeys = new Set(
    input.rules.flatMap((r) =>
      (scopedRuleOf(r, input.platform).aliases ?? []).map((a) => a.aliasKey),
    ),
  );
  if (boundAliasKeys.size === 0) return folderRule;

  const opened = await resolveLaunchSessions(parseClaudeSessionArgs(input.args), input.sessions, {
    launchFolder: input.folder,
    boundAliasKeys,
    platform: input.platform,
  });
  if (opened.kind === 'uncertain') {
    return { ...folderRule, note: uncertainLaunchNote(opened.reason) };
  }

  const canonical =
    input.canonicalFolder ?? ((f: string) => canonicalStoredFolder(f, input.platform));
  const running = { spelled: input.launchSpelling ?? input.folder, canonical: input.folder };
  /** The folder the candidate's conversation belongs to, as the guard will judge it: the guard knows
   *  the folder a session runs in by CLAUDE_PROJECT_DIR (the launch folder) and by the hook payload's
   *  cwd, which for a resumed relocated session is its relocated folder — so both are offered here,
   *  in the guard's order. */
  const recordedFolder = (c: LaunchCandidate): string | null => {
    if (c.dirName === undefined) return c.folder === null ? null : canonical(c.folder);
    const read = { folder: c.folder, dirName: c.dirName };
    const here = recordedFolderFor(read, running, canonical);
    if (here !== null || c.relocatedCwd === undefined) return here;
    return recordedFolderFor(
      read,
      { spelled: c.relocatedCwd, canonical: canonical(c.relocatedCwd) },
      canonical,
    );
  };
  const targets = opened.candidates.map((c) => ({
    title: c.title,
    match: resolveSessionRule(
      input.folder,
      c.title,
      input.rules,
      input.platform,
      recordedFolder(c),
    ),
  }));
  const first = targets[0];
  if (first === undefined) return folderRule;
  const ruleOf = (m: SessionRuleMatch | null): string | null => m?.rule.id ?? null;
  if (!targets.every((t) => ruleOf(t.match) === ruleOf(first.match))) return folderRule;
  return {
    match: first.match,
    alias: first.match?.via === 'alias' ? first.title : null,
    note: null,
  };
}

/**
 * Where `cctl claude` run in `cwd` searches for the session it opens, and how it spells and
 * canonicalizes folders: the launch folder (canonical, the folder rule's key; `canonicalLaunch`
 * decides it, refusing a folder with no canonical form), the launch folder as Claude Code spells it
 * (it resolves a junction or symlink in its cwd before naming its project directory, so its session
 * search runs from that spelling, not the one the shell reports), Claude Code's session store
 * searched from there, and the canonicalizer for a recorded folder.
 */
export function launchSessionContext(opts: {
  cwd: string;
  claudeDir: string;
  platform: NodeJS.Platform;
  /** The canonical launch folder (default: {@link canonicalOrRaw} of `cwd`). */
  canonicalLaunch?: (cwd: string) => string;
  /** The git worktree list (default: `git worktree list`); injected by tests. */
  gitWorktrees?: (cwd: string) => Promise<string[]>;
}): {
  folder: string;
  launchSpelling: string;
  sessions: LaunchSessionDeps;
  canonicalFolder: (folder: string) => string;
} {
  const ccCwd = claudeCodeCwd(opts.cwd);
  const canonicalFolder = (folder: string): string =>
    canonicalOrRaw(folder, { platform: opts.platform, cwd: opts.cwd });
  return {
    folder: (opts.canonicalLaunch ?? canonicalFolder)(opts.cwd),
    launchSpelling: ccCwd,
    sessions: launchSessionStore({
      claudeDir: opts.claudeDir,
      cwd: ccCwd,
      platform: opts.platform,
      ...(opts.gitWorktrees !== undefined ? { gitWorktrees: opts.gitWorktrees } : {}),
    }),
    canonicalFolder,
  };
}
