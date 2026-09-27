// The folder-bound-account command surface: bind, unbind, bindings, where, shell-init, claude.
//
// Action bodies stay thin — the engine owns the state machine (bind/unbind/ensureGroupLive) and the
// pure helpers own resolution (launcher.ts), text (shellInit.ts) and rendering (render.ts). Here we
// only wire, resolve refs, and print. Every folder/label printed passes sanitizeForTerminal at the
// render layer (see render.ts) so operator- and filesystem-supplied text can never drive the terminal.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import {
  SwitchEngineError,
  canonicalizeFolder,
  describeGroupScopes,
  folderBindingsPath,
  folderKey,
  folderUniquenessKey,
  groupSlotId,
  profilesRoot,
  recordedFolderFor,
  resolveAccountRef,
  resolveBinding,
  resolveSessionBinding,
  canonicalStoredFolder,
  scopedGroupOf,
  type AccountView,
  type Paths,
  type SessionBinding,
  type SlotId,
  type StoredAccount,
  type StoredGroup,
} from '@claude-control/switch-engine';
import { defaultPaths } from '@claude-control/switch-engine';
import {
  bindGuardPath,
  ensureBindGuard,
  bindTokensDir,
  mintBindToken,
  removeBindToken,
} from '@claude-control/daemon';
import { buildEngine, fail } from './context.js';
import { detectPalette, sanitizeForTerminal } from './ansi.js';
import {
  renderBindingGroups,
  renderBindings,
  renderWhere,
  type BindingGroupView,
  type WhereAliasView,
  type WhereView,
} from './render.js';
import type { Palette } from './ansi.js';
import {
  bannerContextForLaunch,
  buildLaunchEnv,
  configDirPointsIntoProfiles,
  findClaudeOnPath,
  parseClaudeSessionArgs,
  resolveLaunchSessions,
  resolveLaunchTarget,
  spawnClaude,
  type LaunchCandidate,
  type LaunchSessionDeps,
  type LaunchSlot,
} from './launcher.js';
import { claudeCodeCwd, launchSessionStore } from './launchSessionStore.js';
import { canonicalOrRaw } from './sessionAliases.js';
import {
  isSupportedShell,
  renderShellInit,
  resolveShellInitTarget,
  SUPPORTED_SHELLS,
} from './shellInit.js';
import { resolveGuardProfileSettingsPaths } from './guardProfiles.js';

type Engine = ReturnType<typeof buildEngine>;

/** Canonicalize a CLI folder argument (default: cwd) with the same rules the engine uses, failing
 *  the command with the reason on a bad path. */
function canonicalizeCliFolder(input: string): string {
  const r = canonicalizeFolder(input, {
    platform: process.platform,
    cwd: process.cwd(),
    realpath: (p) => realpathSync.native(p),
  });
  if (!r.ok) fail(`cannot use folder "${input}": ${r.reason}`);
  return r.path;
}

/** The profile config dir for a group — the same location the engine materializes
 *  (`<profilesRoot>/<groupId>`). Computed here rather than read from the (possibly stale) snapshot. */
function groupProfilePath(vaultDir: string, groupId: string): string {
  return join(profilesRoot(vaultDir), groupId);
}

/** Install (or, after the last unbind, remove) the enforcement guard hook so a binding change takes
 *  effect immediately — without waiting for a daemon restart. Best-effort: an unwritable settings.json
 *  is reported as a warning, never a command failure, because the daemon also reconciles the guard on
 *  its next start. Keeps the bind/unbind actions from each re-deriving the same paths. */
export async function reconcileBindGuard(engine: Engine, paths: Paths): Promise<void> {
  const groups = await engine.listGroups();
  const hasBindings = groups.length > 0;
  try {
    await ensureBindGuard({
      settingsPath: join(paths.claudeDir, 'settings.json'),
      guardPath: bindGuardPath(dirname(paths.vaultDir)),
      snapshotPath: folderBindingsPath(paths.vaultDir),
      hasBindings,
      // Propagate the guard into (or clean it out of) every group profile's settings.json — a
      // group-slot session reads its profile copy, which a temp+rename write to main un-shares.
      profileSettingsPaths: resolveGuardProfileSettingsPaths(paths.vaultDir, groups, hasBindings),
    });
  } catch (err) {
    process.stderr.write(
      `warning: could not update the enforcement guard hook ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `restart the daemon to enforce bindings: cctl daemon restart\n`,
    );
  }
}

/** Build the display view of every group: members with the reconciled live one marked. */
async function buildGroupViews(engine: Engine): Promise<BindingGroupView[]> {
  const paths = defaultPaths();
  const [groups, live] = await Promise.all([engine.listGroups(), engine.liveSlots()]);
  return groups.map((g) => {
    const liveMemberId = live.get(groupSlotId(g.id)) ?? null;
    return {
      id: g.id,
      label: g.label,
      folders: g.folders,
      aliases: g.aliases ?? [],
      members: g.members.map((m) => ({
        label: m.label,
        live: m.id === liveMemberId,
        quarantined: m.quarantined,
        excluded: m.autoSwitchExcluded ?? false,
      })),
      profileDir: groupProfilePath(paths.vaultDir, g.id),
      noWorkingAccount: liveMemberId === null,
    };
  });
}

/** The folder-bindings section appended to `accounts list` / `usage`, or '' when nothing is bound —
 *  so the shared-pool table those commands already print is joined by the reserved accounts under
 *  their folders (spec §10: "accounts list / usage show the binding"). */
export async function renderBindingsAppendix(engine: Engine, palette: Palette): Promise<string> {
  const groups = await buildGroupViews(engine);
  if (groups.length === 0) return '';
  return '\n\nFolder-bound accounts:\n' + renderBindingGroups(groups, palette);
}

/**
 * The `cctl where` view of a folder: the binding an UNNAMED session there resolves to (the folder
 * rule), plus every named session alias-bound in exactly this folder — those outrank the folder rule,
 * so the operator has to see them to know where a resumed session will run. Pure over its inputs.
 */
export function buildWhereView(
  folder: string,
  groups: readonly StoredGroup[],
  live: ReadonlyMap<SlotId, string | null>,
  platform: NodeJS.Platform,
  vaultDir: string = defaultPaths().vaultDir,
): WhereView {
  const liveLabel = (g: StoredGroup): string | null => {
    const liveId = live.get(groupSlotId(g.id)) ?? null;
    return liveId ? (g.members.find((m) => m.id === liveId)?.label ?? null) : null;
  };
  const binding = resolveBinding(folder, groups, platform);
  const group =
    binding === null ? undefined : (groups.find((g) => g.id === binding.groupId) ?? undefined);
  const here = folderUniquenessKey(folder, platform);
  const aliases: WhereAliasView[] = [];
  for (const g of groups) {
    for (const a of g.aliases ?? []) {
      if (folderUniquenessKey(a.folder, platform) !== here) continue;
      aliases.push({
        alias: a.alias,
        groupLabel: g.label,
        members: g.members.map((m) => m.label),
        liveMemberLabel: liveLabel(g),
      });
    }
  }
  return {
    folder,
    bound:
      binding === null || group === undefined
        ? null
        : {
            groupLabel: group.label,
            matchedFolder: binding.folder,
            members: group.members.map((m) => m.label),
            profileDir: groupProfilePath(vaultDir, group.id),
            liveMemberLabel: liveLabel(group),
          },
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

/** Which binding a `cctl claude` launch belongs to, and the note (if any) to print about it. */
export interface LaunchBindingDecision {
  binding: SessionBinding | null;
  /** The title a launch routed by alias opens under, for the banner; null otherwise. */
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
 * Which binding a `cctl claude` launch belongs to, by THE precedence rule applied to the session
 * Claude Code's own arguments open (launcher.ts resolveLaunchSessions): its title, and the folder
 * its conversation is RECORDED in — `claude --resume X` in a repository can reach sessions recorded
 * in subfolders and worktrees, and a resumed session keeps its original folder, so that recorded
 * folder is the one an alias scope is matched against (a fork is a new conversation of the launch
 * folder); the folder rule always uses the launch folder. The recorded folder is decided exactly as
 * the enforcement guard decides it (switch-engine recordedFolderFor over readRecordedFolder), so
 * the two can never disagree about a session. When the arguments allow several sessions (a title
 * several sessions share, a newest transcript from another folder), the launch routes to a binding
 * only if EVERY candidate maps to the same one; otherwise, and whenever the arguments are uncertain,
 * it launches by the folder rule and leaves the pick to the enforcement guard.
 *
 * Nothing is parsed or read when no binding has an alias scope — no title could change the answer.
 */
export async function resolveLaunchBinding(input: {
  /** The canonical launch folder. */
  folder: string;
  /** The launch folder as Claude Code spells it (see launchSessionStore's claudeCodeCwd): what a
   *  transcript's project-directory name is matched against when it records no folder of its own.
   *  Default: {@link folder}. */
  launchSpelling?: string;
  /** Claude Code's argv, read and never modified. */
  args: readonly string[];
  groups: readonly StoredGroup[];
  platform: NodeJS.Platform;
  /** Claude Code's session store, searched from the launch folder. */
  sessions: LaunchSessionDeps;
  /** A recorded session folder in the form bindings store folders (default: string-only
   *  canonicalization; the launcher passes the realpath-resolving one). */
  canonicalFolder?: (folder: string) => string;
}): Promise<LaunchBindingDecision> {
  const scoped = input.groups.map((g) => scopedGroupOf(g, input.platform));
  const folderRule: LaunchBindingDecision = {
    binding: resolveSessionBinding(input.folder, null, scoped, input.platform),
    alias: null,
    note: null,
  };
  const boundAliasKeys = new Set(scoped.flatMap((g) => (g.aliases ?? []).map((a) => a.aliasKey)));
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
  /** The folder the candidate's conversation belongs to, as the guard will judge it. */
  const recordedFolder = (c: LaunchCandidate): string | null =>
    c.dirName === undefined
      ? c.folder === null
        ? null
        : canonical(c.folder)
      : recordedFolderFor({ folder: c.folder, dirName: c.dirName }, running, canonical);
  const targets = opened.candidates.map((c) => ({
    title: c.title,
    binding: resolveSessionBinding(
      input.folder,
      c.title,
      scoped,
      input.platform,
      recordedFolder(c),
    ),
  }));
  const first = targets[0];
  if (first === undefined) return folderRule;
  const groupOf = (b: SessionBinding | null): string | null => b?.groupId ?? null;
  if (!targets.every((t) => groupOf(t.binding) === groupOf(first.binding))) return folderRule;
  return {
    binding: first.binding,
    alias: first.binding?.via === 'alias' ? first.title : null,
    note: null,
  };
}

/**
 * Where `cctl claude` run in `cwd` searches for the session it opens, and how it spells and
 * canonicalizes folders: the launch folder (canonical, the folder rule's key), the launch folder as
 * Claude Code spells it (it resolves a junction or symlink in its cwd before naming its project
 * directory, so its session search runs from that spelling, not the one the shell reports), Claude
 * Code's session store searched from there, and the canonicalizer for a recorded folder. The one
 * wiring the launcher uses; its tests drive it with a sandbox config dir.
 */
export function launchSessionContext(opts: {
  cwd: string;
  claudeDir: string;
  platform: NodeJS.Platform;
  /** The git worktree list (default: `git worktree list`); injected by tests. */
  gitWorktrees?: (cwd: string) => Promise<string[]>;
}): {
  folder: string;
  launchSpelling: string;
  sessions: LaunchSessionDeps;
  canonicalFolder: (folder: string) => string;
} {
  const ccCwd = claudeCodeCwd(opts.cwd);
  return {
    folder: canonicalizeCliFolder(opts.cwd),
    launchSpelling: ccCwd,
    sessions: launchSessionStore({
      claudeDir: opts.claudeDir,
      cwd: ccCwd,
      platform: opts.platform,
      ...(opts.gitWorktrees !== undefined ? { gitWorktrees: opts.gitWorktrees } : {}),
    }),
    canonicalFolder: (folder) => canonicalOrRaw(folder, { platform: opts.platform, cwd: opts.cwd }),
  };
}

/**
 * `cctl unbind --group <id|label>`: dissolve a whole binding — every account back to the shared pool,
 * V1 unbind semantics (refused while sessions run in its scopes, unless `force`). The way out for a
 * binding left with no scope at all (which no folder or alias can name), and a shortcut for one with
 * many. The ref is the group id (as `cctl bindings` / `cctl doctor` print it) or its exact label.
 */
async function unbindGroup(engine: Engine, ref: string, force: boolean): Promise<void> {
  const groups = await engine.listGroups();
  const byId = groups.find((g) => g.id === ref.trim());
  const byLabel = groups.filter((g) => g.label === ref);
  if (byId === undefined && byLabel.length > 1) {
    fail(
      `${byLabel.length} bindings are labelled "${ref}"; pass the id (cctl bindings lists them)`,
    );
  }
  const group = byId ?? byLabel[0];
  if (group === undefined) fail(`no binding with id or label "${ref}" (cctl bindings lists them)`);
  try {
    const res = await engine.removeGroupMembers(
      group.id,
      group.members.map((m) => m.id),
      force ? { force: true } : {},
    );
    process.stdout.write(
      `Dissolved the binding ${sanitizeForTerminal(group.label)}: ${res.removed.length} account(s) ` +
        'returned to the shared pool' +
        (res.adoptedRotation ? ' (adopted the profile’s latest token first)' : '') +
        '.\n  the profile dir is kept for history; its live credentials were cleared.\n',
    );
    await reconcileBindGuard(engine, defaultPaths());
  } catch (err) {
    if (err instanceof SwitchEngineError) fail(err.message);
    throw err;
  }
}

/** Resolve one account ref against the full registry (shared pool + reserved members). */
async function resolveAcrossAll(engine: Engine, ref: string): Promise<AccountView> {
  const all = (await engine.listAllAccounts()) as StoredAccount[];
  const resolved = resolveAccountRef(all, ref);
  if (!resolved.ok) fail(resolved.message);
  return resolved.account;
}

export function buildBindCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // bind
  // -------------------------------------------------------------------------
  program
    .command('bind <folder> <accounts>')
    .description('bind a folder (and its subfolders) to one account or a comma-separated set')
    .option('--label <label>', 'a display name for the group (default: joined member labels)')
    .action(async (folder: string, accounts: string, opts: { label?: string }) => {
      const engine = buildEngine();
      const refs = accounts
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      if (refs.length === 0) fail('bind needs at least one account, e.g. cctl bind . work@me.com');
      const ids: string[] = [];
      for (const ref of refs) {
        const acct = await resolveAcrossAll(engine, ref);
        if (!ids.includes(acct.id)) ids.push(acct.id);
      }
      try {
        const result = await engine.bindFolder(
          folder,
          ids,
          opts.label ? { label: opts.label } : {},
        );
        const palette = detectPalette();
        const lines: string[] = [];
        const groupLabel = sanitizeForTerminal(result.group.label);
        const boundFolder = sanitizeForTerminal(result.folder);
        lines.push(
          result.created
            ? `Bound ${boundFolder} to a new folder account: ${groupLabel}.`
            : `Bound ${boundFolder} to the existing folder account: ${groupLabel}.`,
        );
        if (result.movedOffGlobal !== null) {
          const movedLabel = result.group.members.find(
            (m) => m.id === result.movedOffGlobal,
          )?.label;
          const toLabel = result.globalSwitchedTo
            ? sanitizeForTerminal(
                (await engine.listAccounts()).find((a) => a.id === result.globalSwitchedTo)
                  ?.label ?? result.globalSwitchedTo,
              )
            : 'none';
          lines.push(
            `  global slot switched off ${sanitizeForTerminal(movedLabel ?? result.movedOffGlobal)} ` +
              `(it is now reserved to this folder); global is now on ${toLabel}.`,
          );
        }
        const profileDir = sanitizeForTerminal(
          groupProfilePath(defaultPaths().vaultDir, result.group.id),
        );
        if (result.live.noWorkingAccount) {
          lines.push(
            palette.red(
              `  the folder has no working account (all members quarantined); re-login one: ` +
                `cctl accounts relogin <ref>`,
            ),
          );
        } else {
          const liveLabel = result.group.members.find(
            (m) => m.id === result.live.liveMember,
          )?.label;
          lines.push(
            `  profile ready on ${sanitizeForTerminal(liveLabel ?? 'a member')}: ${profileDir}`,
          );
        }
        if (result.runningSessions.length > 0) {
          lines.push(
            palette.yellow(
              `  ${result.runningSessions.length} running session(s) under this folder will keep ` +
                `their current account until relaunched with: cctl claude`,
            ),
          );
        }
        process.stdout.write(lines.join('\n') + '\n');
        // Wire the guard now so this binding is enforced without waiting for a daemon restart.
        await reconcileBindGuard(engine, defaultPaths());
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
    });

  // -------------------------------------------------------------------------
  // unbind
  // -------------------------------------------------------------------------
  program
    .command('unbind [folder]')
    .description(
      'remove a folder binding; the last folder of a group dissolves it (--group <id|label>: ' +
        'dissolve a whole binding, e.g. one left with no folder or session)',
    )
    .option('--force', 'dissolve even when sessions are observed running under the folder')
    .option('--group <ref>', 'dissolve the binding with this id or label, whatever its scopes')
    .action(async (folder: string | undefined, opts: { force?: boolean; group?: string }) => {
      const engine = buildEngine();
      if (opts.group !== undefined) {
        if (folder !== undefined) fail('pass a folder or --group, not both');
        await unbindGroup(engine, opts.group, opts.force === true);
        return;
      }
      if (folder === undefined) fail('pass the folder to unbind (or --group <id|label>)');
      try {
        const result = await engine.unbindFolder(folder, opts.force ? { force: true } : {});
        const folderText = sanitizeForTerminal(result.folder);
        if (!result.dissolved) {
          process.stdout.write(
            `Unbound ${folderText}. The group keeps its other bindings and stays live.\n`,
          );
          return;
        }
        const lines = [`Unbound ${folderText} and dissolved its folder account.`];
        if (result.releasedMembers.length > 0) {
          lines.push(
            `  ${result.releasedMembers.length} account(s) returned to the shared pool` +
              (result.adoptedRotation ? ' (adopted the profile’s latest token first)' : '') +
              '.',
          );
        }
        lines.push('  the profile dir is kept for history; its live credentials were cleared.');
        process.stdout.write(lines.join('\n') + '\n');
        // Remove the guard when the last folder is now unbound; keep it otherwise.
        await reconcileBindGuard(engine, defaultPaths());
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
    });

  // -------------------------------------------------------------------------
  // bindings
  // -------------------------------------------------------------------------
  program
    .command('bindings')
    .description(
      'show folder bindings: folders, accounts, live member, profile dir, snapshot freshness',
    )
    .action(async () => {
      const engine = buildEngine();
      const [groups, freshness] = await Promise.all([
        buildGroupViews(engine),
        engine.getGuardSnapshotFreshness(),
      ]);
      process.stdout.write(
        renderBindings(
          {
            groups,
            footer: {
              present: freshness.present,
              fresh: freshness.fresh,
              enforce: freshness.enforce,
            },
          },
          detectPalette(),
        ) + '\n',
      );
    });

  // -------------------------------------------------------------------------
  // where
  // -------------------------------------------------------------------------
  program
    .command('where [folder]')
    .description('explain which account a folder runs on, with the env line and a VS Code snippet')
    .action(async (folderArg: string | undefined) => {
      const engine = buildEngine();
      const canonical = canonicalizeCliFolder(folderArg ?? process.cwd());
      const [groups, live] = await Promise.all([engine.listGroups(), engine.liveSlots()]);
      process.stdout.write(
        renderWhere(buildWhereView(canonical, groups, live, process.platform), detectPalette()) +
          '\n',
      );
    });

  // -------------------------------------------------------------------------
  // shell-init
  // -------------------------------------------------------------------------
  program
    .command('shell-init <shell>')
    .description(`print a claude wrapper for your shell (${SUPPORTED_SHELLS.join(' | ')})`)
    .action((shell: string) => {
      if (!isSupportedShell(shell)) {
        fail(`unsupported shell "${shell}". Supported: ${SUPPORTED_SHELLS.join(', ')}.`);
      }
      // Resolve the running node + cctl entry so the PowerShell wrapper can bypass the npm .cmd shim
      // (see shellInit.ts): otherwise cmd.exe would re-expand `%*` and corrupt session arguments.
      const target = resolveShellInitTarget({ execPath: process.execPath, argv: process.argv });
      process.stdout.write(renderShellInit(shell, target));
    });

  // -------------------------------------------------------------------------
  // claude (launcher)
  // -------------------------------------------------------------------------
  // passThroughOptions (with enablePositionalOptions on the program) makes our --account/--override
  // parse only until the first operand or unknown flag, after which EVERYTHING passes through to
  // Claude Code verbatim — so `cctl claude --account x -- --model opus foo` and `cctl claude --model
  // opus` both do the right thing.
  program
    .command('claude [args...]')
    .description('launch Claude Code on the account for the current folder (or --account)')
    .option('--account <ref>', 'launch a specific account (its group profile, or the global slot)')
    .option('--override', 'allow this session in a folder bound to a DIFFERENT account')
    .helpOption(false)
    .allowUnknownOption(true)
    .passThroughOptions()
    .action(async (args: string[], opts: { account?: string; override?: boolean }) => {
      await runClaude({
        ...(opts.account !== undefined ? { account: opts.account } : {}),
        override: Boolean(opts.override),
        args,
      });
    });
}

/**
 * The stderr banner line shown when a per-launch relaxation is in effect. Emitted by the launcher
 * itself — not only via the guard's UserPromptSubmit systemMessage — because Claude Code drops that
 * systemMessage in a headless (`-p` / SDK) run, where the guard warning would otherwise be invisible;
 * this line is the reliable signal in every mode. It names the actual session cwd, where the
 * relaxation applies, rather than the account's own bound folder. Both inputs pass sanitizeForTerminal
 * at this sink so a crafted label/path cannot inject terminal control sequences.
 */
export function relaxationBannerLine(
  kind: 'override' | 'explicit',
  label: string,
  cwd: string,
  reservedTo: 'folders' | 'bindings' = 'folders',
): string {
  const safeLabel = sanitizeForTerminal(label);
  const safeCwd = sanitizeForTerminal(cwd);
  // An account whose binding holds a session alias is reserved to its bindings, one bound only to
  // folders to its folders — the guard's own --account notice words it the same way.
  return kind === 'override'
    ? `cctl: --override in effect: allowing ${safeLabel} in ${safeCwd}, which is bound to a ` +
        `different account.\n`
    : `cctl: --account in effect: ${safeLabel} is reserved to its ${reservedTo}; running it in ` +
        `${safeCwd} on purpose.\n`;
}

/** Orchestrate `cctl claude`: resolve the slot (explicit account > folder binding > global), make it
 *  live, print the one-line banner, and spawn the real executable. */
async function runClaude(opts: {
  account?: string;
  override: boolean;
  args: string[];
}): Promise<void> {
  const engine = buildEngine();
  const paths = defaultPaths();
  const platform = process.platform;
  const profRoot = profilesRoot(paths.vaultDir);

  let slot: LaunchSlot;
  let explicit = false;
  /** What an explicitly launched reserved account is reserved to, for its notice. */
  let reservedTo: 'folders' | 'bindings' = 'folders';

  if (opts.account !== undefined) {
    explicit = true;
    const acct = await resolveAcrossAll(engine, opts.account);
    if (acct.groupId !== undefined) {
      // A reserved member: make it live in its group slot (a deliberate launch overrides cadence),
      // then run in that profile.
      const group = await engine.getGroup(acct.groupId);
      if (!group) fail(`account ${acct.label} is reserved to a group that no longer exists.`);
      try {
        // Asserting the group slot: if the account was released between the lookup above and this
        // switch, it must fail here rather than switch the GLOBAL slot and then launch into a profile.
        await engine.activate(acct.id, {
          force: true,
          origin: 'manual',
          slot: groupSlotId(group.id),
        });
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      slot = {
        kind: 'group',
        profileDir: groupProfilePath(paths.vaultDir, group.id),
        label: acct.label,
        context: `explicit account, ${describeGroupScopes(group)}`,
      };
      if ((group.aliases ?? []).length > 0) reservedTo = 'bindings';
    } else {
      // A shared account can only be live in the global slot, and only one at a time — so --account
      // of a shared account is honored ONLY when it is already the global live account.
      const globalLive = await engine.getActiveId('global');
      if (acct.id !== globalLive) {
        fail(
          `${acct.label} is a shared account and is not the one currently live in the global slot. ` +
            `A shared account can only run in the global slot, one at a time. Switch to it first ` +
            `(cctl switch ${acct.label}), then run cctl claude, or omit --account.`,
        );
      }
      slot = { kind: 'global', label: acct.label, context: 'global (shared account)' };
    }
  } else {
    // No explicit account: THE precedence rule decides — the alias binding of the session Claude
    // Code's own arguments open (matched in the folder that session is recorded in), else the cwd's
    // folder binding, else global. The argv is only read here; it is passed to the child untouched
    // below.
    const groups = await engine.listGroups();
    const { binding, alias, note } = await resolveLaunchBinding({
      ...launchSessionContext({ cwd: process.cwd(), claudeDir: paths.claudeDir, platform }),
      args: opts.args,
      groups,
      platform,
    });
    if (note !== null) process.stderr.write(note);
    if (binding !== null) {
      const group = groups.find((g) => g.id === binding.groupId) as StoredGroup;
      const scope =
        binding.via === 'alias'
          ? `session "${alias ?? binding.aliasKey}" in ${binding.folder}`
          : binding.folder;
      let live;
      try {
        live = await engine.ensureGroupLive(group.id);
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      if (live.noWorkingAccount) {
        fail(
          `${sanitizeForTerminal(scope)} is bound to ` +
            `${sanitizeForTerminal(group.members.map((m) => m.label).join(', '))}, but none of its ` +
            `accounts are usable (all quarantined). Re-login one: cctl accounts relogin <ref>.`,
        );
      }
      const liveLabel = group.members.find((m) => m.id === live.liveMember)?.label ?? group.label;
      slot = {
        kind: 'group',
        profileDir: groupProfilePath(paths.vaultDir, group.id),
        label: liveLabel,
        context: `${scope} binding`,
      };
    } else {
      const globalLive = await engine.getActiveId('global');
      const label =
        (globalLive
          ? (await engine.listAccounts()).find((a) => a.id === globalLive)?.label
          : null) ?? 'the shared account';
      slot = { kind: 'global', label, context: 'global' };
    }
  }

  // Locate + classify the real executable.
  const candidate = findClaudeOnPath({ platform });
  if (candidate === undefined) {
    fail('could not find `claude` on PATH. Install Claude Code, or add its directory to PATH.');
  }
  const target = resolveLaunchTarget(candidate, { platform, readFileSync });
  if (target.kind === 'refused') fail(target.reason);

  // Build the child env.
  const dropInheritedConfigDir =
    slot.kind === 'global' &&
    configDirPointsIntoProfiles(process.env.CLAUDE_CONFIG_DIR, profRoot, {
      platform,
      cwd: process.cwd(),
      realpath: (p) => realpathSync.native(p),
    });

  // Banner honesty on a global launch: an inherited CLAUDE_CONFIG_DIR that does NOT point into the
  // profiles root is left untouched (only a profile-root dir is dropped), so the child actually runs
  // on THAT config store — a different account than the global slot the banner would otherwise name.
  // bannerContextForLaunch names the inherited dir rather than silently claiming the global slot.
  slot = {
    ...slot,
    context: bannerContextForLaunch(slot, process.env.CLAUDE_CONFIG_DIR, dropInheritedConfigDir),
  };
  // Mint per-launch relaxation tokens for the guard so the knobs cannot be forged by ambient env: a
  // token is a random value the guard verifies against a record on disk keyed to THIS launch's slot,
  // and it is removed the instant the session exits. CCTL_LAUNCH_EXPLICIT is only meaningful for a
  // group slot (the guard's case B is a group-slot rule), so an explicit shared-account launch mints
  // none.
  const tokensDir = bindTokensDir(folderBindingsPath(paths.vaultDir));
  const slotKey = slotProfileKey(slot, platform);
  let explicitToken: string | undefined;
  let overrideToken: string | undefined;
  if (explicit && slot.kind === 'group') {
    explicitToken = mintBindToken({ tokensDir, kind: 'explicit', profileKey: slotKey });
  }
  if (opts.override) {
    overrideToken = mintBindToken({ tokensDir, kind: 'override', profileKey: slotKey });
  }

  const env = buildLaunchEnv({
    baseEnv: process.env,
    slot,
    ...(explicitToken !== undefined ? { explicitToken } : {}),
    ...(overrideToken !== undefined ? { overrideToken } : {}),
    dropInheritedConfigDir,
  });

  // One-line banner on stderr (stdout belongs to the child's TUI).
  process.stderr.write(
    `cctl: Claude Code on ${sanitizeForTerminal(slot.label)} (${sanitizeForTerminal(slot.context)})\n`,
  );
  // When a relaxation is in effect, say so on the launcher's OWN stderr — not only via the guard's
  // systemMessage. Claude Code drops UserPromptSubmit systemMessages in a headless (-p / SDK) run, so
  // the guard warning would be invisible there; this banner line is the reliable signal in every mode.
  // It names the actual session cwd (where the relaxation applies), not the account's bound folder.
  if (overrideToken !== undefined) {
    process.stderr.write(relaxationBannerLine('override', slot.label, process.cwd()));
  }
  if (explicitToken !== undefined) {
    process.stderr.write(relaxationBannerLine('explicit', slot.label, process.cwd(), reservedTo));
  }

  try {
    const code = await spawnClaude({
      command: target.command,
      args: [...target.prefixArgs, ...opts.args],
      env,
    });
    process.exitCode = code;
  } catch (err) {
    fail(`failed to launch Claude Code: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // The token is valid only while its launch is alive: drop it as soon as the child exits (or the
    // launch fails). A leftover from a hard kill is pruned by age on the next mint.
    if (explicitToken !== undefined) removeBindToken(tokensDir, explicitToken);
    if (overrideToken !== undefined) removeBindToken(tokensDir, overrideToken);
  }
}

/** The folderKey of a launch slot's config dir — '' for the global slot, the canonical key of the
 *  group's profile dir otherwise. The guard binds a relaxation token to this key so a token minted
 *  for one slot cannot relax a session running on another. */
function slotProfileKey(slot: LaunchSlot, platform: NodeJS.Platform): string {
  if (slot.kind !== 'group' || slot.profileDir === undefined) return '';
  const r = canonicalizeFolder(slot.profileDir, {
    platform,
    cwd: process.cwd(),
    realpath: (p) => realpathSync.native(p),
  });
  return r.ok ? folderKey(r.path, platform) : folderKey(slot.profileDir, platform);
}

/** Also used by `cctl switch`: describe the group a just-switched member belongs to (or null when it
 *  is a shared account). `where` is the phrase naming it: "the <folders> folder group" for a group
 *  bound only by folders, else "the binding of <scopes>" so an alias-only group is still named.
 *  Kept here beside the other group helpers. */
export async function describeSwitchedGroup(
  engine: Engine,
  accountId: string,
): Promise<{ label: string; folders: string[]; where: string } | null> {
  const groups = await engine.listGroups();
  const group = groups.find((g) => g.members.some((m) => m.id === accountId));
  if (!group) return null;
  const where =
    (group.aliases ?? []).length === 0 && group.folders.length > 0
      ? `the ${group.folders.join(', ')} folder group`
      : `the binding of ${describeGroupScopes(group)}`;
  return { label: group.label, folders: group.folders, where };
}
