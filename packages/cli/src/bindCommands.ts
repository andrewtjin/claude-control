// The folder-account command surface: bind, unbind, bindings, where, shell-init, claude. `bind` adds
// accounts to a folder's rule (include) and `unbind` removes the folder's rule (reset).
//
// Action bodies stay thin — the engine owns the state machine (include/reset/ensureRuleLive) and the
// pure helpers own resolution (launcher.ts), text (shellInit.ts) and rendering (render.ts). Here we
// only wire, resolve refs, and print. Every folder/label printed passes sanitizeForTerminal at the
// render layer (see render.ts) so operator- and filesystem-supplied text can never drive the terminal.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import {
  SwitchEngineError,
  canonicalizeFolder,
  folderBindingsPath,
  folderKey,
  profilesRoot,
  resolveAccountRef,
  resolveFolderRule,
  ruleIdOfSlot,
  ruleSlotId,
  type AccountView,
  type Paths,
  type SlotId,
  type StoredAccount,
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
  type WhereView,
} from './render.js';
import type { Palette } from './ansi.js';
import {
  bannerContextForLaunch,
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

/** The profile config dir for a folder rule — the same location the engine materializes
 *  (`<profilesRoot>/<ruleId>`). Computed here rather than read from the (possibly stale) snapshot. */
function groupProfilePath(vaultDir: string, ruleId: string): string {
  return join(profilesRoot(vaultDir), ruleId);
}

/** The label of an account id among `accounts`, falling back to the id itself. */
function labelOf(accounts: readonly StoredAccount[], id: string): string {
  return accounts.find((a) => a.id === id)?.label ?? id;
}

/** Install (or, after the last unbind, remove) the enforcement guard hook so a binding change takes
 *  effect immediately — without waiting for a daemon restart. Best-effort: an unwritable settings.json
 *  is reported as a warning, never a command failure, because the daemon also reconciles the guard on
 *  its next start. Keeps the bind/unbind actions from each re-deriving the same paths. */
export async function reconcileBindGuard(engine: Engine, paths: Paths): Promise<void> {
  const rules = await engine.listRules();
  const hasBindings = rules.length > 0;
  try {
    await ensureBindGuard({
      settingsPath: join(paths.claudeDir, 'settings.json'),
      guardPath: bindGuardPath(dirname(paths.vaultDir)),
      snapshotPath: folderBindingsPath(paths.vaultDir),
      hasBindings,
      // Propagate the guard into (or clean it out of) every rule profile's settings.json — a
      // rule-slot session reads its profile copy, which a temp+rename write to main un-shares.
      profileSettingsPaths: resolveGuardProfileSettingsPaths(paths.vaultDir, rules, hasBindings),
    });
  } catch (err) {
    process.stderr.write(
      `warning: could not update the enforcement guard hook ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `restart the daemon to enforce bindings: cctl daemon restart\n`,
    );
  }
}

/** Build the display view of every folder rule: its included accounts with the reconciled live one
 *  marked. (An inherited shared account live in the slot is not one of them, so none is marked.) */
async function buildGroupViews(engine: Engine): Promise<BindingGroupView[]> {
  const paths = defaultPaths();
  const rules = await engine.listRules();
  // Nothing more to read with no rules: `accounts list` / `usage` append this to every listing.
  if (rules.length === 0) return [];
  const [live, accounts] = await Promise.all([engine.liveSlots(), engine.listAllAccounts()]);
  return rules.map((r) => {
    const liveId = live.get(ruleSlotId(r.id)) ?? null;
    return {
      label: r.label,
      folders: r.folders,
      members: r.include
        .map((id) => accounts.find((a) => a.id === id))
        .filter((a): a is AccountView => a !== undefined)
        .map((m) => ({
          label: m.label,
          live: m.id === liveId,
          quarantined: m.quarantined,
          excluded: m.autoSwitchExcluded ?? false,
        })),
      profileDir: groupProfilePath(paths.vaultDir, r.id),
      noWorkingAccount: liveId === null,
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

/** Resolve one account ref against the full registry (shared pool + reserved accounts). */
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
    .description(
      'have a folder (and its subfolders) use one account or a comma-separated set first',
    )
    .option('--label <label>', "a display name for the folder's rule (default: the folder)")
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
        const result = await engine.includeInFolder(
          folder,
          ids,
          opts.label ? { label: opts.label } : {},
        );
        const palette = detectPalette();
        const accounts = await engine.listAllAccounts();
        const lines: string[] = [];
        const ruleLabel = sanitizeForTerminal(result.rule.label);
        const boundFolder = sanitizeForTerminal(
          result.rule.folders[result.rule.folders.length - 1] ?? folder,
        );
        const included = sanitizeForTerminal(ids.map((id) => labelOf(accounts, id)).join(', '));
        lines.push(
          result.created
            ? `Bound ${boundFolder} to a new folder rule (${ruleLabel}) using ${included} first.`
            : `Added ${included} to the folder rule of ${boundFolder} (${ruleLabel}).`,
        );
        // Every slot moved off a newly reserved account, said out loud: an include can change which
        // account another place runs on.
        for (const h of result.handedOff) {
          const from = sanitizeForTerminal(labelOf(accounts, h.from));
          const to = sanitizeForTerminal(labelOf(accounts, h.to));
          const ruleId = ruleIdOfSlot(h.slot);
          const slotName =
            ruleId === undefined
              ? 'global slot'
              : `folder slot of ${sanitizeForTerminal(
                  (await engine.getRule(ruleId))?.folders.join(', ') ?? h.slot,
                )}`;
          lines.push(
            `  ${slotName} switched off ${from} (it is now reserved to this folder); it is now on ${to}.`,
          );
        }
        const profileDir = sanitizeForTerminal(
          groupProfilePath(defaultPaths().vaultDir, result.rule.id),
        );
        if (result.live.noWorkingAccount || result.live.liveAccount === null) {
          lines.push(
            palette.red(
              `  the folder has no working account (every account it may use is quarantined or ` +
                `live elsewhere); re-login one: cctl accounts relogin <ref>`,
            ),
          );
        } else {
          const liveLabel = labelOf(accounts, result.live.liveAccount);
          lines.push(`  profile ready on ${sanitizeForTerminal(liveLabel)}: ${profileDir}`);
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
    .command('unbind <folder>')
    .description("remove a folder's rule; a rule's last folder dissolves it")
    .option('--force', 'dissolve even when sessions are observed running under the folder')
    .action(async (folder: string, opts: { force?: boolean }) => {
      const engine = buildEngine();
      try {
        const result = await engine.resetFolder(
          folder,
          undefined,
          opts.force ? { force: true } : {},
        );
        const folderText = sanitizeForTerminal(result.folder);
        if (!result.dissolved) {
          process.stdout.write(
            `Unbound ${folderText}. Its rule keeps its other folders and stays live.\n`,
          );
          return;
        }
        const lines = [`Unbound ${folderText} and removed its folder rule.`];
        if (result.released.length > 0) {
          lines.push(
            `  ${result.released.length} account(s) returned to the shared pool` +
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
      const [rules, live, accounts] = await Promise.all([
        engine.listRules(),
        engine.liveSlots(),
        engine.listAllAccounts(),
      ]);
      const match = resolveFolderRule(canonical, rules, process.platform);
      let view: WhereView;
      if (match === null) {
        view = { folder: canonical, bound: null };
      } else {
        const rule = match.rule;
        const liveId = live.get(ruleSlotId(rule.id)) ?? null;
        view = {
          folder: canonical,
          bound: {
            groupLabel: rule.label,
            matchedFolder: match.folder,
            members: rule.include.map((id) => labelOf(accounts, id)),
            profileDir: groupProfilePath(defaultPaths().vaultDir, rule.id),
            // Any account live in the slot — an inherited one too, while the included ones are out.
            liveMemberLabel: liveId !== null ? labelOf(accounts, liveId) : null,
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
    .option(
      '--account <ref>',
      "launch a specific account (its folder's profile, or the global slot)",
    )
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
): string {
  const safeLabel = sanitizeForTerminal(label);
  const safeCwd = sanitizeForTerminal(cwd);
  return kind === 'override'
    ? `cctl: --override in effect: allowing ${safeLabel} in ${safeCwd}, which is bound to a ` +
        `different account.\n`
    : `cctl: --account in effect: ${safeLabel} is reserved to its folders; running it in ` +
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

  if (opts.account !== undefined) {
    explicit = true;
    const acct = await resolveAcrossAll(engine, opts.account);
    if (acct.ruleIds !== undefined && acct.ruleIds.length > 0) {
      // A reserved account: make it live in its rule's slot (a deliberate launch overrides cadence),
      // then run in that profile. One several rules include goes to the slot it is live in.
      const live = await engine.liveSlots();
      const ruleId =
        acct.ruleIds.length === 1
          ? acct.ruleIds[0]
          : acct.ruleIds.find((id) => live.get(ruleSlotId(id)) === acct.id);
      if (ruleId === undefined) {
        fail(
          `${acct.label} is included by several folders and live in none of them; ` +
            'run cctl claude from one of its folders instead.',
        );
      }
      const rule = await engine.getRule(ruleId);
      if (!rule) fail(`account ${acct.label} is reserved to a folder rule that no longer exists.`);
      try {
        // Asserting the rule slot: if the account was released between the lookup above and this
        // switch, it must fail here rather than switch the GLOBAL slot and then launch into a profile.
        await engine.activate(acct.id, {
          force: true,
          origin: 'manual',
          slot: ruleSlotId(rule.id),
        });
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      slot = {
        kind: 'group',
        profileDir: groupProfilePath(paths.vaultDir, rule.id),
        label: acct.label,
        context: `explicit account, ${rule.folders.join(', ')}`,
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
    // No explicit account: the cwd's folder rule decides.
    const canonical = canonicalizeCliFolder(process.cwd());
    const rules = await engine.listRules();
    const match = resolveFolderRule(canonical, rules, platform);
    if (match !== null) {
      const rule = match.rule;
      let live;
      try {
        live = await engine.ensureRuleLive(rule.id);
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      if (live.noWorkingAccount || live.liveAccount === null) {
        fail(
          `${match.folder} has a folder rule, but no account it may use is usable right now ` +
            `(quarantined, or live in another slot). Re-login one: cctl accounts relogin <ref>.`,
        );
      }
      const liveLabel = labelOf(await engine.listAllAccounts(), live.liveAccount);
      slot = {
        kind: 'group',
        profileDir: groupProfilePath(paths.vaultDir, rule.id),
        label: liveLabel,
        context: `${match.folder} binding`,
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
    process.stderr.write(relaxationBannerLine('explicit', slot.label, process.cwd()));
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

/** Also used by `cctl switch`: the folder rule whose slot a just-switched account is now live in, or
 *  null when it went to the global slot. Kept here beside the other folder helpers. */
export async function describeSwitchedGroup(
  engine: Engine,
  accountId: string,
): Promise<{ label: string; folders: string[] } | null> {
  const [rules, live] = await Promise.all([engine.listRules(), engine.liveSlots()]);
  const rule = rules.find((r) => live.get(ruleSlotId(r.id)) === accountId);
  return rule ? { label: rule.label, folders: rule.folders } : null;
}

/** The slot `cctl switch` asserts for an account: the global slot for a shared one, the rule's slot
 *  for an account one rule includes, and none for an account several rules include — the engine then
 *  takes the slot it is live in, or refuses and says to name the folder, rather than this command
 *  picking one. */
export function switchSlotOf(account: AccountView | undefined): SlotId | undefined {
  const ruleIds = account?.ruleIds ?? [];
  if (ruleIds.length === 0) return 'global';
  return ruleIds.length === 1 ? ruleSlotId(ruleIds[0]!) : undefined;
}
