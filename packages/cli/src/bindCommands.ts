// The folder-bound-account command surface: bind, unbind, bindings, where, shell-init, claude.
//
// Action bodies stay thin — the engine owns the state machine (bind/unbind/ensureGroupLive) and the
// pure helpers own resolution (launcher.ts), text (shellInit.ts) and rendering (render.ts). Here we
// only wire, resolve refs, and print. Every folder/label printed passes sanitizeForTerminal at the
// render layer (see render.ts) so operator- and filesystem-supplied text can never drive the terminal.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  SwitchEngineError,
  canonicalizeFolder,
  groupSlotId,
  profilesRoot,
  resolveAccountRef,
  resolveBinding,
  type AccountView,
  type StoredAccount,
  type StoredGroup,
} from '@claude-control/switch-engine';
import { defaultPaths } from '@claude-control/switch-engine';
import { buildEngine, fail } from './context.js';
import { detectPalette, sanitizeForTerminal } from './ansi.js';
import {
  renderBindingGroups,
  renderBindings,
  renderWhere,
  type BindingGroupView,
  type WhereView,
} from './render.js';
import type { Palette } from './ansi.js';
import {
  buildLaunchEnv,
  configDirPointsIntoProfiles,
  findClaudeOnPath,
  resolveLaunchTarget,
  spawnClaude,
  type LaunchSlot,
} from './launcher.js';
import {
  isSupportedShell,
  renderShellInit,
  resolveShellInitTarget,
  SUPPORTED_SHELLS,
} from './shellInit.js';

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

/** Build the display view of every group: members with the reconciled live one marked. */
async function buildGroupViews(engine: Engine): Promise<BindingGroupView[]> {
  const paths = defaultPaths();
  const [groups, live] = await Promise.all([engine.listGroups(), engine.liveSlots()]);
  return groups.map((g) => {
    const liveMemberId = live.get(groupSlotId(g.id)) ?? null;
    return {
      label: g.label,
      folders: g.folders,
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
        const boundFolder = sanitizeForTerminal(
          result.group.folders[result.group.folders.length - 1] ?? folder,
        );
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
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
    });

  // -------------------------------------------------------------------------
  // unbind
  // -------------------------------------------------------------------------
  program
    .command('unbind <folder>')
    .description('remove a folder binding; the last folder of a group dissolves it')
    .option('--force', 'dissolve even when sessions are observed running under the folder')
    .action(async (folder: string, opts: { force?: boolean }) => {
      const engine = buildEngine();
      try {
        const result = await engine.unbindFolder(folder, opts.force ? { force: true } : {});
        const folderText = sanitizeForTerminal(result.folder);
        if (!result.dissolved) {
          process.stdout.write(
            `Unbound ${folderText}. The group keeps its other folders and stays live.\n`,
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
      const [groups, snapshot, groupsGeneration] = await Promise.all([
        buildGroupViews(engine),
        engine.readSnapshot(),
        engine.getGroupsGeneration(),
      ]);
      process.stdout.write(
        renderBindings(
          {
            groups,
            footer: {
              snapshotGeneration: snapshot ? snapshot.generation : null,
              groupsGeneration,
              enforce: snapshot ? snapshot.enforce : 'block',
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
      const binding = resolveBinding(canonical, groups, process.platform);
      let view: WhereView;
      if (binding === null) {
        view = { folder: canonical, bound: null };
      } else {
        const group = groups.find((g) => g.id === binding.groupId) as StoredGroup;
        const liveId = live.get(groupSlotId(group.id)) ?? null;
        view = {
          folder: canonical,
          bound: {
            groupLabel: group.label,
            matchedFolder: binding.folder,
            members: group.members.map((m) => m.label),
            profileDir: groupProfilePath(defaultPaths().vaultDir, group.id),
            liveMemberLabel: liveId
              ? (group.members.find((m) => m.id === liveId)?.label ?? null)
              : null,
          },
        };
      }
      process.stdout.write(renderWhere(view, detectPalette()) + '\n');
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

  if (opts.account !== undefined) {
    explicit = true;
    const acct = await resolveAcrossAll(engine, opts.account);
    if (acct.groupId !== undefined) {
      // A reserved member: make it live in its group slot (a deliberate launch overrides cadence),
      // then run in that profile.
      const group = await engine.getGroup(acct.groupId);
      if (!group) fail(`account ${acct.label} is reserved to a group that no longer exists.`);
      try {
        await engine.activate(acct.id, { force: true, origin: 'manual' });
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      slot = {
        kind: 'group',
        profileDir: groupProfilePath(paths.vaultDir, group.id),
        label: acct.label,
        context: `explicit account, ${group.folders.join(', ')}`,
      };
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
    // No explicit account: the cwd's folder binding decides.
    const canonical = canonicalizeCliFolder(process.cwd());
    const groups = await engine.listGroups();
    const binding = resolveBinding(canonical, groups, platform);
    if (binding !== null) {
      const group = groups.find((g) => g.id === binding.groupId) as StoredGroup;
      let live;
      try {
        live = await engine.ensureGroupLive(group.id);
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      if (live.noWorkingAccount) {
        fail(
          `${binding.folder} is bound to ${group.members.map((m) => m.label).join(', ')}, but none ` +
            `of its accounts are usable (all quarantined). Re-login one: cctl accounts relogin <ref>.`,
        );
      }
      const liveLabel = group.members.find((m) => m.id === live.liveMember)?.label ?? group.label;
      slot = {
        kind: 'group',
        profileDir: groupProfilePath(paths.vaultDir, group.id),
        label: liveLabel,
        context: `${binding.folder} binding`,
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
  const env = buildLaunchEnv({
    baseEnv: process.env,
    slot,
    explicit,
    override: opts.override,
    dropInheritedConfigDir,
  });

  // One-line banner on stderr (stdout belongs to the child's TUI).
  process.stderr.write(
    `cctl: Claude Code on ${sanitizeForTerminal(slot.label)} (${sanitizeForTerminal(slot.context)})\n`,
  );

  try {
    const code = await spawnClaude({
      command: target.command,
      args: [...target.prefixArgs, ...opts.args],
      env,
    });
    process.exitCode = code;
  } catch (err) {
    fail(`failed to launch Claude Code: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Also used by `cctl switch`: describe the group a just-switched member belongs to (or null when it
 *  is a shared account). Kept here beside the other group helpers. */
export async function describeSwitchedGroup(
  engine: Engine,
  accountId: string,
): Promise<{ label: string; folders: string[] } | null> {
  const groups = await engine.listGroups();
  const group = groups.find((g) => g.members.some((m) => m.id === accountId));
  return group ? { label: group.label, folders: group.folders } : null;
}
