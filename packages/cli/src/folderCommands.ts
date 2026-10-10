// The folder-rule command surface: `folder include|exclude|reset`, `folders`, `where`, `shell-init`
// and `claude`, plus the folder sections other commands print (`usage`, `timeline`, `accounts list`)
// and the slot choice behind `switch --folder`.
//
// A folder rule applies to its folder and everything under it (the longest matching rule wins, with
// no merging). It includes accounts — reserved to the folders that include them, and used there
// first — and excludes shared accounts the folder must not use; everything else is inherited from the
// shared pool. Action bodies stay thin: the engine owns the state machine (include / exclude / reset
// / ensure-live), the pure helpers own resolution (launcher.ts), text (shellInit.ts) and rendering
// (folderRender.ts). Here we only wire, resolve refs, and print what changed.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import {
  SlotError,
  SwitchEngineError,
  canonicalizeFolder,
  exactFolderRule,
  folderBindingsPath,
  folderKey,
  profilesRoot,
  resolveAccountRef,
  resolveFolderRule,
  ruleIdOfSlot,
  ruleSlotId,
  rulesIncluding,
  type AccountView,
  type ExcludeResult,
  type FolderRule,
  type IncludeResult,
  type Paths,
  type PoolEntry,
  type ResetResult,
  type ResolveResult,
  type RuleLiveResult,
  type SlotId,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { defaultPaths } from '@claude-control/switch-engine';
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  Store,
  bindGuardPath,
  ensureBindGuard,
  bindTokensDir,
  isMoveTarget,
  mintBindToken,
  readHeartbeat,
  removeBindToken,
} from '@claude-control/daemon';
import { timelineInputFromWire, type AccountUsageInput } from '@claude-control/usage-advisor';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { buildEngine, daemonDbPath, fail } from './context.js';
import {
  backgroundHostOptions,
  createClaudeBackgroundHost,
  type ClaudeBackgroundHost,
} from './backgroundHost.js';
import {
  parseBackgroundRequest,
  routeBackgroundLaunch,
  runHolding,
  type ConfigView,
  type RouteContext,
  type RouteDecision,
  type RouteMode,
} from './backgroundAttach.js';
import { detectPalette, sanitizeForTerminal } from './ansi.js';
import type { Palette } from './ansi.js';
import {
  renderFolderRulesSection,
  renderFolders,
  renderReservedAccounts,
  renderWhere,
  nothingUsableReason,
  vscodeProfileNames,
  type FolderRuleView,
  type GlobalSlotView,
  type PoolEntryView,
  type ReservedAccountView,
  type SlotLiveView,
} from './folderRender.js';
import { olderDaemonReason } from './folderRulesSupport.js';
import { daemonHeartbeatPath, daemonSettingsPath, readSettingsReport } from './settings.js';
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

/** Canonicalize a CLI folder argument with the same rules the engine uses, failing the command with
 *  the reason on a bad path. */
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
function ruleProfilePath(vaultDir: string, ruleId: string): string {
  return join(profilesRoot(vaultDir), ruleId);
}

/** The label of an account id among `accounts`, falling back to the id itself. */
function labelOf(accounts: readonly StoredAccount[], id: string): string {
  return accounts.find((a) => a.id === id)?.label ?? id;
}

/** Several ids as one comma-separated list of labels. */
function labelsOf(accounts: readonly StoredAccount[], ids: readonly string[]): string {
  return ids.map((id) => labelOf(accounts, id)).join(', ');
}

/** A slot in words: "the global slot", or the folder slot named by its rule's folders. */
export function slotName(slot: SlotId, rules: readonly FolderRule[]): string {
  const ruleId = ruleIdOfSlot(slot);
  if (ruleId === undefined) return 'the global slot';
  const rule = rules.find((r) => r.id === ruleId);
  return rule === undefined
    ? 'a folder slot whose rule no longer exists'
    : `the folder slot of ${rule.folders.join(', ')}`;
}

/** Install (or, once the last rule is gone, remove) the enforcement guard hook so a rule change takes
 *  effect immediately — without waiting for a daemon restart. Best-effort: an unwritable
 *  settings.json is reported as a warning, never a command failure, because the daemon also
 *  reconciles the guard on its next start. */
export async function reconcileFolderGuard(engine: Engine, paths: Paths): Promise<void> {
  const rules = await engine.listRules();
  const hasRules = rules.length > 0;
  try {
    await ensureBindGuard({
      settingsPath: join(paths.claudeDir, 'settings.json'),
      guardPath: bindGuardPath(dirname(paths.vaultDir)),
      snapshotPath: folderBindingsPath(paths.vaultDir),
      hasBindings: hasRules,
      // Propagate the guard into (or clean it out of) every rule profile's settings.json — a
      // rule-slot session reads its profile copy, which a temp+rename write to main un-shares.
      profileSettingsPaths: resolveGuardProfileSettingsPaths(paths.vaultDir, rules, hasRules),
    });
  } catch (err) {
    process.stderr.write(
      `warning: could not update the enforcement guard hook ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `restart the daemon to enforce folder rules: cctl daemon restart\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Account references
// ---------------------------------------------------------------------------

/** Split a comma-separated account argument into its refs. Never defaults: an empty list is the
 *  caller's usage error, because a default would silently reserve the account in use and halt every
 *  other folder using it. */
export function parseAccountList(arg: string): string[] {
  return arg
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** Resolve one ref the way every account command does (id, then label), and failing that by email
 *  (case-insensitive): a folder command is often typed from the address an account is known by. */
export function resolveAccountRefOrEmail(accounts: StoredAccount[], ref: string): ResolveResult {
  const byRef = resolveAccountRef(accounts, ref);
  if (byRef.ok || byRef.reason === 'ambiguous') return byRef;
  const lower = ref.toLowerCase();
  const byEmail = accounts.filter((a) => a.emailAddress?.toLowerCase() === lower);
  if (byEmail.length === 1) return { ok: true, account: byEmail[0]! };
  if (byEmail.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `"${ref}" is the email of ${byEmail.length} accounts; use the label or the id.`,
    };
  }
  return byRef;
}

/** Resolve a comma-separated account argument across the WHOLE registry (shared and reserved rows)
 *  to distinct ids in the order given, failing on the first ref that does not resolve. */
async function resolveAccountArg(engine: Engine, verb: string, arg: string): Promise<string[]> {
  const refs = parseAccountList(arg);
  if (refs.length === 0) {
    fail(`folder ${verb} needs at least one account, e.g. cctl folder ${verb} . work@example.com`);
  }
  const all = await engine.listAllAccounts();
  const ids: string[] = [];
  for (const ref of refs) {
    const resolved = resolveAccountRefOrEmail(all, ref);
    if (!resolved.ok) fail(resolved.message);
    if (!ids.includes(resolved.account.id)) ids.push(resolved.account.id);
  }
  return ids;
}

/** Resolve one account ref across the whole registry (shared pool + reserved accounts). */
async function resolveAcrossAll(engine: Engine, ref: string): Promise<AccountView> {
  const all = await engine.listAllAccounts();
  const resolved = resolveAccountRef(all, ref);
  if (!resolved.ok) fail(resolved.message);
  return resolved.account;
}

/** Why the running daemon cannot be trusted with a shared account live in a folder slot, or
 *  undefined when it can (see folderRulesSupport.ts). */
async function olderDaemonRunning(): Promise<string | undefined> {
  const [report, heartbeat] = await Promise.all([
    readSettingsReport(daemonSettingsPath()),
    readHeartbeat(daemonHeartbeatPath()),
  ]);
  return olderDaemonReason(report, heartbeat);
}

/** Refuse a command while a daemon that predates folder rules runs, when the command could leave a
 *  SHARED account live in a folder slot (see folderRulesSupport.ts): that daemon could put the same
 *  account live in the global slot too. Every such command calls this — a rule edit, a reset that
 *  can release a live account, a switch of a shared account into a folder slot, a launch that may
 *  seat one — before anything is resolved or written, so a refusal changes nothing. */
export async function refuseOnOlderDaemon(): Promise<void> {
  const reason = await olderDaemonRunning();
  if (reason !== undefined) fail(`${reason}. Nothing was changed.`);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** How the account live in a slot relates to that slot: one of the rule's includes, a shared account
 *  the slot inherits, or a login its pool does not hold. Judged by membership, not by the pool list,
 *  which leaves quarantined accounts out. */
function liveSource(
  accountId: string,
  rule: FolderRule | undefined,
  accounts: readonly AccountView[],
): SlotLiveView['source'] {
  const account = accounts.find((a) => a.id === accountId);
  const shared = account !== undefined && (account.ruleIds ?? []).length === 0;
  if (rule === undefined) return shared ? 'inherited' : 'outside';
  if (rule.include.includes(accountId)) return 'include';
  return shared && !rule.exclude.includes(accountId) ? 'inherited' : 'outside';
}

/** The live view of a slot from its reconciled live account id. */
export function buildLiveView(
  liveId: string | null,
  rule: FolderRule | undefined,
  accounts: readonly AccountView[],
): SlotLiveView | null {
  if (liveId === null) return null;
  return {
    label: labelOf(accounts, liveId),
    source: liveSource(liveId, rule, accounts),
    quarantined: accounts.find((a) => a.id === liveId)?.quarantined === true,
  };
}

/**
 * The pool of a slot as the folder views show it, in pool order. The engine's pool leaves quarantined
 * accounts out (they can never be taken); the views put them back where they would sit — an included
 * one at its include position, a shared one after the usable inherited accounts — so a dead login is
 * visible where the operator expects it rather than silently missing.
 */
export function buildPoolView(
  rule: FolderRule | undefined,
  pool: readonly PoolEntry[],
  liveId: string | null,
  accounts: readonly AccountView[],
  rules: readonly FolderRule[],
): PoolEntryView[] {
  const fromEntry = (e: PoolEntry): PoolEntryView => ({
    label: e.account.label,
    source: e.source,
    live: e.account.id === liveId,
    liveElsewhere: e.liveElsewhere === null ? null : slotName(e.liveElsewhere, rules),
    quarantined: false,
    autoTarget: e.autoTarget,
  });
  const dead = (a: StoredAccount, source: PoolEntryView['source']): PoolEntryView => ({
    label: a.label,
    source,
    live: a.id === liveId,
    liveElsewhere: null,
    quarantined: true,
    autoTarget: false,
  });
  const included: PoolEntryView[] = [];
  for (const id of rule?.include ?? []) {
    const entry = pool.find((e) => e.source === 'include' && e.account.id === id);
    const account = accounts.find((a) => a.id === id);
    if (entry !== undefined) included.push(fromEntry(entry));
    else if (account?.quarantined === true) included.push(dead(account, 'include'));
  }
  const inherited = pool.filter((e) => e.source === 'inherited').map(fromEntry);
  const deadShared = accounts
    .filter(
      (a) =>
        a.quarantined && (a.ruleIds ?? []).length === 0 && !(rule?.exclude ?? []).includes(a.id),
    )
    .map((a) => dead(a, 'inherited'));
  return [...included, ...inherited, ...deadShared];
}

/** Everything the folder views read, in one pass: the rules, who is live in each slot, every account
 *  (shared and reserved), and each slot's pool. */
async function readFolderPicture(engine: Engine): Promise<{
  rules: FolderRule[];
  live: Map<SlotId, string | null>;
  accounts: AccountView[];
}> {
  const [rules, live, accounts] = await Promise.all([
    engine.listRules(),
    engine.liveSlots(),
    engine.listAllAccounts(),
  ]);
  return { rules, live, accounts };
}

/** One rule's pool as the views show it (see {@link buildPoolView}). */
async function rulePoolView(
  engine: Engine,
  rule: FolderRule,
  picture: Awaited<ReturnType<typeof readFolderPicture>>,
): Promise<PoolEntryView[]> {
  const slot = ruleSlotId(rule.id);
  const liveId = picture.live.get(slot) ?? null;
  return buildPoolView(rule, await engine.slotPool(slot), liveId, picture.accounts, picture.rules);
}

/** The full view of one rule. */
async function buildRuleView(
  engine: Engine,
  rule: FolderRule,
  picture: Awaited<ReturnType<typeof readFolderPicture>>,
): Promise<FolderRuleView> {
  const slot = ruleSlotId(rule.id);
  const liveId = picture.live.get(slot) ?? null;
  return {
    label: rule.label,
    folders: rule.folders,
    include: rule.include.map((id) => labelOf(picture.accounts, id)),
    exclude: rule.exclude.map((id) => labelOf(picture.accounts, id)),
    live: buildLiveView(liveId, rule, picture.accounts),
    pool: await rulePoolView(engine, rule, picture),
    profileDir: ruleProfilePath(defaultPaths().vaultDir, rule.id),
  };
}

/** The global slot's view: its live account and the shared pool. */
async function buildGlobalView(
  engine: Engine,
  picture: Awaited<ReturnType<typeof readFolderPicture>>,
): Promise<GlobalSlotView> {
  const liveId = picture.live.get('global') ?? null;
  const pool = await engine.slotPool('global');
  return {
    live: buildLiveView(liveId, undefined, picture.accounts),
    pool: buildPoolView(undefined, pool, liveId, picture.accounts, picture.rules),
  };
}

/** The per-folder section `cctl usage` and `cctl timeline` end on, or '' when no folder has a rule —
 *  so the shared-pool views those commands print are joined by what each folder runs on. */
export async function renderFolderRulesAppendix(engine: Engine, palette: Palette): Promise<string> {
  const rules = await engine.listRules();
  // Nothing more to read with no rules: every `usage` and `timeline` call reaches this.
  if (rules.length === 0) return '';
  const picture = await readFolderPicture(engine);
  const views = await Promise.all(picture.rules.map((r) => buildRuleView(engine, r, picture)));
  return '\n\n' + renderFolderRulesSection(views, palette);
}

/** The reserved accounts, as `cctl accounts list` shows them below the shared table: each WITH its
 *  email, and the folders of every rule that includes it. Pure over its inputs. */
export function buildReservedViews(
  accounts: readonly AccountView[],
  rules: readonly FolderRule[],
  live: ReadonlyMap<SlotId, string | null>,
): ReservedAccountView[] {
  return accounts
    .filter((a) => (a.ruleIds ?? []).length > 0)
    .map((a) => {
      const including = rulesIncluding(a.id, rules);
      return {
        id: a.id,
        label: a.label,
        email: a.emailAddress,
        quarantined: a.quarantined,
        live: including.some((r) => live.get(ruleSlotId(r.id)) === a.id),
        includedBy: including.map((r) => r.folders.join(', ')),
      };
    });
}

/** The reserved-accounts section appended to `cctl accounts list`, or '' when none is reserved. */
export async function renderReservedAppendix(engine: Engine, palette: Palette): Promise<string> {
  const rules = await engine.listRules();
  if (rules.length === 0) return '';
  const picture = await readFolderPicture(engine);
  const text = renderReservedAccounts(
    buildReservedViews(picture.accounts, picture.rules, picture.live),
    palette,
  );
  return text === '' ? '' : '\n\n' + text;
}

// ---------------------------------------------------------------------------
// What a rule change did, in words
// ---------------------------------------------------------------------------

/** What the describe* helpers need besides the result: the registry as it stands AFTER the change. */
export interface ChangeContext {
  accounts: readonly AccountView[];
  rules: readonly FolderRule[];
  vaultDir: string;
  palette: Palette;
  /** Each rule's pool as the views show it, by rule id: what says why a slot has nothing usable.
   *  Absent, that reason is given in general terms. */
  pools?: ReadonlyMap<string, PoolEntryView[]>;
}

/** The lines every rule change ends on: who is live in the folder's slot now, and the running
 *  sessions that keep their old account until relaunched. */
function liveAndSessionLines(
  rule: FolderRule,
  live: Pick<RuleLiveResult, 'liveAccount' | 'noWorkingAccount'>,
  runningSessions: number,
  ctx: ChangeContext,
): string[] {
  const lines: string[] = [];
  if (live.liveAccount === null) {
    const pool = ctx.pools?.get(rule.id);
    const why =
      pool !== undefined
        ? nothingUsableReason(pool)
        : 'every account it may use is quarantined, live in another slot or excluded ' +
          '(cctl folders shows which)';
    lines.push(ctx.palette.red(`  the folder's slot has no working account: ${why}`));
  } else {
    const label = sanitizeForTerminal(labelOf(ctx.accounts, live.liveAccount));
    const source = liveSource(live.liveAccount, rule, ctx.accounts);
    const why =
      source === 'include'
        ? 'included'
        : source === 'inherited'
          ? 'inherited from the shared pool'
          : 'outside its pool';
    lines.push(
      live.noWorkingAccount
        ? ctx.palette.red(
            `  live in the folder's slot: ${label}, which is quarantined; re-login it: ` +
              `cctl accounts relogin ${label}`,
          )
        : `  live in the folder's slot: ${label} (${why})`,
    );
  }
  if (runningSessions > 0) {
    lines.push(
      ctx.palette.yellow(
        `  ${runningSessions} running session(s) under this folder keep their current account ` +
          'until relaunched with: cctl claude',
      ),
    );
  }
  return lines;
}

/** The line saying a `--label` was not applied: it names a rule only when the command creates one,
 *  so an existing rule keeps its label. Nothing when no label was given or it matches. */
function labelNotApplied(
  result: { created: boolean; rule: FolderRule },
  label: string | undefined,
): string[] {
  if (label === undefined || result.created || label === result.rule.label) return [];
  return [
    `  --label was not applied: the rule already exists and keeps its label ` +
      `${sanitizeForTerminal(result.rule.label)} (--label names a rule only when it creates it).`,
  ];
}

/** A VS Code profile name as an optional field: present only when there is one. */
function profileOf(name: string | undefined): { vscodeProfile?: string } {
  return name === undefined ? {} : { vscodeProfile: name };
}

/** The rule's folders as one phrase. */
function foldersOf(rule: FolderRule): string {
  return sanitizeForTerminal(rule.folders.join(', '));
}

/** `cctl folder include`'s report: the rule, every account that left the shared pool, every slot
 *  moved off one of them (an include can change which account ANOTHER place runs on), the slot's
 *  live account, and the sessions that keep their old one. */
export function describeInclude(
  result: IncludeResult,
  requested: readonly string[],
  ctx: ChangeContext,
  label?: string,
): string {
  const { rule } = result;
  const names = sanitizeForTerminal(labelsOf(ctx.accounts, requested));
  const lines = [
    result.created
      ? `Created a folder rule on ${foldersOf(rule)}: it uses ${names} first, then the shared pool.`
      : `Included ${names} in the folder rule on ${foldersOf(rule)}.`,
    ...labelNotApplied(result, label),
  ];
  if (result.reserved.length > 0) {
    lines.push(
      `  reserved: ${sanitizeForTerminal(labelsOf(ctx.accounts, result.reserved))} left the ` +
        'shared pool; only folders that include an account may use it now.',
    );
  }
  // An account another rule already reserved is shared between the folders that include it.
  for (const id of requested) {
    if (result.reserved.includes(id)) continue;
    const others = rulesIncluding(id, ctx.rules).filter((r) => r.id !== rule.id);
    if (others.length === 0) continue;
    lines.push(
      `  ${sanitizeForTerminal(labelOf(ctx.accounts, id))} is also included by ` +
        `${sanitizeForTerminal(others.map((r) => r.folders.join(', ')).join('; '))}; ` +
        'those folders share it, live in one of them at a time.',
    );
  }
  if (result.unexcluded.length > 0) {
    lines.push(
      `  no longer excluded here: ${sanitizeForTerminal(labelsOf(ctx.accounts, result.unexcluded))}.`,
    );
  }
  for (const h of result.handedOff) {
    lines.push(
      `  ${sanitizeForTerminal(slotName(h.slot, ctx.rules))} switched off ` +
        `${sanitizeForTerminal(labelOf(ctx.accounts, h.from))} (now reserved) and is on ` +
        `${sanitizeForTerminal(labelOf(ctx.accounts, h.to))}.`,
    );
  }
  lines.push(...liveAndSessionLines(rule, result.live, result.runningSessions.length, ctx));
  lines.push(`  profile: ${sanitizeForTerminal(ruleProfilePath(ctx.vaultDir, rule.id))}`);
  return lines.join('\n');
}

/** `cctl folder exclude`'s report: the rule, that the accounts stay usable elsewhere, the slot moved
 *  off an excluded account, the live account, and the sessions that keep their old one. */
export function describeExclude(
  result: ExcludeResult,
  requested: readonly string[],
  ctx: ChangeContext,
  label?: string,
): string {
  const { rule } = result;
  const names = sanitizeForTerminal(labelsOf(ctx.accounts, requested));
  const lines = [
    result.created
      ? `Created a folder rule on ${foldersOf(rule)} that excludes ${names}; it uses the rest of ` +
        'the shared pool, in its own slot.'
      : `Excluded ${names} from the folder rule on ${foldersOf(rule)}.`,
    ...labelNotApplied(result, label),
    `  ${names} ${requested.length === 1 ? 'stays' : 'stay'} usable everywhere else.`,
  ];
  if (result.movedOff !== null) {
    const from = sanitizeForTerminal(labelOf(ctx.accounts, result.movedOff));
    lines.push(
      result.live.liveAccount === null
        ? ctx.palette.yellow(
            `  the folder's slot was cleared off ${from}: nothing else in its pool is available.`,
          )
        : `  the folder's slot switched off ${from}.`,
    );
  }
  lines.push(...liveAndSessionLines(rule, result.live, result.runningSessions.length, ctx));
  return lines.join('\n');
}

/** `cctl folder reset`'s report. `before` is the folder's rule as it was, so the report can say
 *  which named accounts were included and which excluded; `liveAfter` is the slot's live account
 *  now (a surviving rule only). */
export function describeReset(
  result: ResetResult,
  before: FolderRule | undefined,
  liveAfter: string | null,
  ctx: ChangeContext,
  requested: readonly string[] | undefined,
): string {
  const folder = sanitizeForTerminal(result.folder);
  const released =
    result.released.length > 0
      ? [
          `  returned to the shared pool: ${sanitizeForTerminal(labelsOf(ctx.accounts, result.released))}` +
            (result.adoptedRotation ? ' (the slot’s latest login was saved first)' : '') +
            '.',
        ]
      : [];
  // What the folder runs on now that its own rule is gone or shrunk: a parent's rule, or the global
  // slot (the longest match wins, so removing a nested rule exposes its parent's).
  const nowRunsOn = (): string => {
    const match = resolveFolderRule(result.folder, ctx.rules, process.platform);
    return match === null
      ? 'the global slot and the shared pool'
      : `the folder rule on ${sanitizeForTerminal(match.folder)}`;
  };

  if (result.dissolved) {
    const lines = [
      `Removed the folder rule on ${before ? foldersOf(before) : folder}. ${folder} now uses ${nowRunsOn()}.`,
      ...released,
    ];
    const stillReserved = (before?.include ?? []).filter((id) => !result.released.includes(id));
    if (stillReserved.length > 0) {
      lines.push(
        `  still reserved to other folders: ${sanitizeForTerminal(labelsOf(ctx.accounts, stillReserved))}.`,
      );
    }
    lines.push('  the profile dir is kept for history; its live login was cleared.');
    if (result.runningSessions.length > 0) {
      lines.push(
        ctx.palette.yellow(
          `  ${result.runningSessions.length} running session(s) under it lost the folder's ` +
            'login; relaunch them with: cctl claude',
        ),
      );
    }
    return lines.join('\n');
  }

  const rule = result.rule;
  if (requested === undefined || rule === undefined) {
    // One of several folders left a rule that keeps the others.
    return [
      `${folder} left its folder rule, which stays on ${rule ? foldersOf(rule) : 'its other folders'}.`,
      `  ${folder} now uses ${nowRunsOn()}.`,
    ].join('\n');
  }

  const wasIncluded = requested.filter((id) => before?.include.includes(id) === true);
  const wasExcluded = requested.filter((id) => before?.exclude.includes(id) === true);
  const lines: string[] = [];
  if (wasIncluded.length > 0) {
    lines.push(
      `Removed ${sanitizeForTerminal(labelsOf(ctx.accounts, wasIncluded))} from what ` +
        `${foldersOf(rule)} includes.`,
    );
  }
  if (wasExcluded.length > 0) {
    lines.push(
      `Removed ${sanitizeForTerminal(labelsOf(ctx.accounts, wasExcluded))} from what ` +
        `${foldersOf(rule)} excludes: the folder may use ${wasExcluded.length === 1 ? 'it' : 'them'} again.`,
    );
  }
  lines.push(...released);
  const stillReserved = wasIncluded.filter((id) => !result.released.includes(id));
  if (stillReserved.length > 0) {
    lines.push(
      `  still reserved to other folders: ${sanitizeForTerminal(labelsOf(ctx.accounts, stillReserved))}.`,
    );
  }
  lines.push(
    ...liveAndSessionLines(
      rule,
      { liveAccount: liveAfter, noWorkingAccount: liveAfter === null },
      result.runningSessions.length,
      ctx,
    ),
  );
  return lines.join('\n');
}

/** Read the registry after a change, for the describe* helpers. */
async function changeContext(engine: Engine): Promise<ChangeContext> {
  const picture = await readFolderPicture(engine);
  const pools = new Map<string, PoolEntryView[]>();
  for (const rule of picture.rules) pools.set(rule.id, await rulePoolView(engine, rule, picture));
  return {
    accounts: picture.accounts,
    rules: picture.rules,
    vaultDir: defaultPaths().vaultDir,
    palette: detectPalette(),
    pools,
  };
}

/** Run a rule change: an engine refusal is the whole error line (it already says what is wrong and
 *  that nothing moved); anything else escapes as a real failure. */
async function engineCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof SwitchEngineError) fail(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `cctl switch --folder`
// ---------------------------------------------------------------------------

/** The slot `cctl switch <account> --folder <folder>` targets: the slot of the rule the folder runs
 *  under (the longest match), or the global slot when no rule applies there — `ruleFolders` names
 *  which, for the report. */
export async function switchSlotForFolder(
  engine: Engine,
  folder: string,
): Promise<{ slot: SlotId; ruleFolders: string[] | null }> {
  const canonical = canonicalizeCliFolder(folder);
  const match = resolveFolderRule(canonical, await engine.listRules(), process.platform);
  return match === null
    ? { slot: 'global', ruleFolders: null }
    : { slot: ruleSlotId(match.rule.id), ruleFolders: match.rule.folders };
}

/** A refused switch in plain words: the engine's reason, that nothing changed, and what to do. */
export function describeSlotRefusal(err: SlotError, accountLabel: string): string {
  const label = sanitizeForTerminal(accountLabel);
  switch (err.code) {
    case 'slot_ambiguous':
      return `${err.message}. Nothing was changed - name the folder: cctl switch ${label} --folder <folder>.`;
    case 'live_elsewhere':
      return (
        `${err.message}. Nothing was changed - switch that slot to another account first, or ` +
        'pick an account that is free (cctl folders shows who is live where).'
      );
    case 'slot_mismatch':
      return (
        `${err.message}. Nothing was changed - pick an account that folder may use, or change its ` +
        'rule (cctl folder include / cctl folder reset).'
      );
    default:
      return `${err.message}. Nothing was changed - check cctl folders.`;
  }
}

/** Also used by `cctl switch`: the folder rule whose slot a just-switched account is now live in, or
 *  null when it went to the global slot. */
export async function describeSwitchedGroup(
  engine: Engine,
  accountId: string,
): Promise<{ label: string; folders: string[] } | null> {
  const [rules, live] = await Promise.all([engine.listRules(), engine.liveSlots()]);
  const rule = rules.find((r) => live.get(ruleSlotId(r.id)) === accountId);
  return rule ? { label: rule.label, folders: rule.folders } : null;
}

/** The slot `cctl switch` asserts for an account named without `--folder`: the global slot for a
 *  shared one, the rule's slot for an account one rule includes, and none for an account several
 *  rules include — the engine then takes the slot it is live in, or refuses and says to name the
 *  folder, rather than this command picking one. */
export function switchSlotOf(account: AccountView | undefined): SlotId | undefined {
  const ruleIds = account?.ruleIds ?? [];
  if (ruleIds.length === 0) return 'global';
  return ruleIds.length === 1 ? ruleSlotId(ruleIds[0]!) : undefined;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function buildFolderCommands(program: Command): void {
  const folder = program
    .command('folder')
    .description(
      'give a folder (and everything under it) its own rule over the shared pool: include, exclude, reset',
    );

  // -------------------------------------------------------------------------
  // folder include
  // -------------------------------------------------------------------------
  folder
    .command('include <folder> <accounts>')
    .description(
      'reserve accounts to a folder and use them there first (comma-separated labels, emails or ids; ' +
        'always named, never the account in use)',
    )
    .option(
      '--label <label>',
      "a display name for the folder's rule, if this creates it (default: the folder)",
    )
    .action(async (folderArg: string, accountsArg: string, opts: { label?: string }) => {
      await refuseOnOlderDaemon();
      const engine = buildEngine();
      const ids = await resolveAccountArg(engine, 'include', accountsArg);
      const result = await engineCall(() =>
        engine.includeInFolder(folderArg, ids, opts.label ? { label: opts.label } : {}),
      );
      process.stdout.write(
        describeInclude(result, ids, await changeContext(engine), opts.label) + '\n',
      );
      // Wire the guard now so the rule is enforced without waiting for a daemon restart.
      await reconcileFolderGuard(engine, defaultPaths());
    });

  // -------------------------------------------------------------------------
  // folder exclude
  // -------------------------------------------------------------------------
  folder
    .command('exclude <folder> <accounts>')
    .description(
      'keep a folder off shared accounts (comma-separated); they stay usable everywhere else',
    )
    .option('--label <label>', "a display name for the folder's rule, if this creates it")
    .option(
      '--force',
      'clear the slot even while sessions run there, when an excluded account is live and nothing else is free',
    )
    .action(
      async (folderArg: string, accountsArg: string, opts: { label?: string; force?: boolean }) => {
        await refuseOnOlderDaemon();
        const engine = buildEngine();
        const ids = await resolveAccountArg(engine, 'exclude', accountsArg);
        const result = await engineCall(() =>
          engine.excludeInFolder(folderArg, ids, {
            ...(opts.label ? { label: opts.label } : {}),
            ...(opts.force ? { force: true } : {}),
          }),
        );
        process.stdout.write(
          describeExclude(result, ids, await changeContext(engine), opts.label) + '\n',
        );
        await reconcileFolderGuard(engine, defaultPaths());
      },
    );

  // -------------------------------------------------------------------------
  // folder reset
  // -------------------------------------------------------------------------
  folder
    .command('reset <folder> [accounts]')
    .description(
      "drop named accounts from a folder's rule; with none named, remove the rule entirely (its " +
        'included accounts return to the shared pool unless another folder includes them, and the ' +
        'folder goes back to the global slot)',
    )
    .option('--force', 'go ahead even when sessions are running under the folder')
    .action(
      async (folderArg: string, accountsArg: string | undefined, opts: { force?: boolean }) => {
        // Removing named accounts can return one live in the folder's slot to the shared pool while
        // it stays live there. Removing the whole rule clears the slot and seats nothing, so it is
        // left open: it is also how an operator backs out of rules an older daemon cannot honor.
        if (accountsArg !== undefined) await refuseOnOlderDaemon();
        const engine = buildEngine();
        // An empty account list is a usage error, never "the whole rule": removing the rule must be
        // asked for by leaving the argument out.
        const ids =
          accountsArg === undefined
            ? undefined
            : await resolveAccountArg(engine, 'reset', accountsArg);
        const rulesBefore = await engine.listRules();
        const result = await engineCall(() =>
          engine.resetFolder(folderArg, ids, opts.force ? { force: true } : {}),
        );
        const before = exactFolderRule(result.folder, rulesBefore, process.platform);
        const liveAfter =
          result.rule === undefined
            ? null
            : ((await engine.liveSlots()).get(ruleSlotId(result.rule.id)) ?? null);
        process.stdout.write(
          describeReset(result, before, liveAfter, await changeContext(engine), ids) + '\n',
        );
        // Remove the guard when the last rule is gone; keep it otherwise.
        await reconcileFolderGuard(engine, defaultPaths());
      },
    );

  // -------------------------------------------------------------------------
  // folders
  // -------------------------------------------------------------------------
  program
    .command('folders')
    .description(
      'list every folder rule: its folders, includes, excludes, live account and pool in order',
    )
    .action(async () => {
      const engine = buildEngine();
      const [picture, freshness] = await Promise.all([
        readFolderPicture(engine),
        engine.getGuardSnapshotFreshness(),
      ]);
      const [rules, global] = await Promise.all([
        Promise.all(picture.rules.map((r) => buildRuleView(engine, r, picture))),
        picture.rules.length > 0 ? buildGlobalView(engine, picture) : { live: null, pool: [] },
      ]);
      process.stdout.write(
        renderFolders(
          {
            rules,
            global,
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
    .description(
      'explain which rule, account and pool a folder runs on, with the env line and a VS Code snippet',
    )
    .action(async (folderArg: string | undefined) => {
      const engine = buildEngine();
      const canonical = canonicalizeCliFolder(folderArg ?? process.cwd());
      const picture = await readFolderPicture(engine);
      const match = resolveFolderRule(canonical, picture.rules, process.platform);
      const global = await buildGlobalView(engine, picture);
      const rule =
        match === null
          ? null
          : {
              ...(await buildRuleView(engine, match.rule, picture)),
              matchedFolder: match.folder,
              ...profileOf(vscodeProfileNames(picture.rules).get(match.rule.id)),
            };
      process.stdout.write(
        renderWhere({ folder: canonical, rule, global }, detectPalette()) + '\n',
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
    .option(
      '--account <ref>',
      "launch a specific account (its folder's profile, or the global slot)",
    )
    .option('--override', 'allow this session in a folder whose rule runs on a DIFFERENT slot')
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
 * relaxation applies, rather than the account's own folder. Both inputs pass sanitizeForTerminal
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
    ? `cctl: --override in effect: allowing ${safeLabel} in ${safeCwd}, whose folder rule runs ` +
        `on a different slot.\n`
    : `cctl: --account in effect: ${safeLabel} is reserved to its folders; running it in ` +
        `${safeCwd} on purpose.\n`;
}

/**
 * Refuse a launch into a rule's slot while a daemon that predates folder rules runs, unless the slot
 * already holds one of the rule's own included accounts with a working login: making the slot live
 * would otherwise seat (or keep) a SHARED account there, which that daemon could put live in the
 * global slot as well. An included account kept where it is seats nothing new.
 */
async function refuseSeatingUnderOlderDaemon(engine: Engine, rule: FolderRule): Promise<void> {
  const reason = await olderDaemonRunning();
  if (reason === undefined) return;
  const [live, accounts] = await Promise.all([engine.liveSlots(), engine.listAllAccounts()]);
  const liveId = live.get(ruleSlotId(rule.id)) ?? null;
  const working = accounts.find((a) => a.id === liveId)?.quarantined === false;
  if (liveId !== null && rule.include.includes(liveId) && working) return;
  fail(`${reason}. Nothing was changed.`);
}

/** How long `cctl claude` waits for another cctl process (the daemon) that is moving the session it
 *  was asked to open: a move is a stop, a resume and a confirm, seconds each. */
const BACKGROUND_LOCK_WAIT_MS = 90_000;

/** The background-service host `cctl claude` reads and drives: built as the daemon builds its own
 *  (see backgroundHostOptions), so it reads the main config dir cctl resolved and runs every command
 *  against that same dir's service, and takes the locks the daemon takes. */
function launcherBackgroundHost(paths: Paths): ClaudeBackgroundHost {
  return createClaudeBackgroundHost(backgroundHostOptions(paths));
}

/** A folder's canonical key, leniently: a path with no canonical form is keyed as spelled. */
function folderKeyOf(folder: string, platform: NodeJS.Platform): string {
  return folderKey(canonicalOrSpelled(folder, platform), platform);
}

/** The usage the daemon last recorded for an account, as the move judgment reads it: no store yet,
 *  or no snapshot in it, is an account never polled (no limits, so able); a store that cannot be
 *  read says nothing (`undefined`: not known to be able). */
export function lastUsageOf(
  account: AccountView,
  dbPath: string = daemonDbPath(),
): AccountUsageInput | undefined {
  let limits: AccountUsage['limits'] = [];
  if (existsSync(dbPath)) {
    let store: Store | undefined;
    try {
      store = new Store(dbPath);
      const row = store.latestUsageSnapshot(account.id);
      if (row !== undefined) limits = (JSON.parse(row.json) as AccountUsage).limits ?? [];
    } catch {
      return undefined;
    } finally {
      store?.close();
    }
  }
  return timelineInputFromWire([
    {
      accountId: account.id,
      label: account.label,
      active: true,
      quarantined: account.quarantined,
      limits,
    },
  ])[0]!;
}

/** The folders `claude --resume <title>` searches from a folder, as Claude Code searches them: the
 *  folder, every worktree of its git repository (`git worktree list`), and the worktrees Claude
 *  Code makes under it (`.claude/worktrees/*`). A folder outside any repository is searched alone. */
async function titleFolders(cwd: string): Promise<string[]> {
  const listed = await new Promise<string>((resolve) =>
    execFile(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: 5_000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : stdout),
    ),
  );
  const worktrees = listed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
  let own: string[] = [];
  try {
    own = readdirSync(join(cwd, '.claude', 'worktrees')).map((n) =>
      join(cwd, '.claude', 'worktrees', n),
    );
  } catch {
    // No worktrees of Claude Code's here.
  }
  return [cwd, ...worktrees, ...own];
}

/** Ctrl-C held off around a move: between the stop and the resume the session runs nowhere, so a
 *  move interrupted there would leave it stopped. The signals that would end cctl (Ctrl-C, Ctrl-Break,
 *  a closing terminal) are taken while the move runs and said once; the move then finishes or puts
 *  the session back, and `interrupted` tells the launch to open nothing after it. */
function moveShield(say: (line: string) => void): {
  shield: RouteContext['shield'];
  interrupted: () => boolean;
} {
  let interrupted = false;
  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGHUP'];
  let recovery: (() => string | undefined) | undefined;
  const onSignal = (): void => {
    if (!interrupted) {
      // Said once, with the way back in case the window closes before the move ends.
      const hint = recovery?.();
      say(
        'cctl: finishing the move first; stopping now would leave the session stopped.' +
          (hint !== undefined
            ? ` If this window closes before it finishes, resume it with: ${hint}`
            : ''),
      );
    }
    interrupted = true;
  };
  return {
    async shield(fn, note) {
      recovery = note;
      for (const sig of signals) process.on(sig, onSignal);
      try {
        return await fn();
      } finally {
        for (const sig of signals) process.off(sig, onSignal);
      }
    },
    interrupted: () => interrupted,
  };
}

/**
 * What the background-session routing needs from the engine (see backgroundAttach.ts): where a
 * session in a folder belongs — the slot `cctl claude` would launch in there, made live as a launch
 * there makes it, behind the same older-daemon fence — and any config dir in words.
 */
function routeContext(
  engine: Engine,
  paths: Paths,
  host: ClaudeBackgroundHost,
  daemonRunning: boolean,
  shield: RouteContext['shield'],
): RouteContext {
  const platform = process.platform;
  const profileOf = (ruleId: string): string => ruleProfilePath(paths.vaultDir, ruleId);
  return {
    host,
    cwd: process.cwd(),
    platform,
    sameFolder: (a, b) => folderKeyOf(a, platform) === folderKeyOf(b, platform),
    titleFolders,
    async launchConfigDir() {
      const match = resolveFolderRule(
        canonicalizeCliFolder(process.cwd()),
        await engine.listRules(),
        platform,
      );
      return match === null ? null : profileOf(match.rule.id);
    },
    shield,
    async homeOf(cwd) {
      const match = resolveFolderRule(
        canonicalOrSpelled(cwd, platform),
        await engine.listRules(),
        platform,
      );
      if (match === null) return { configDir: null, movable: false };
      const rule = match.rule;
      const configDir = profileOf(rule.id);
      await refuseSeatingUnderOlderDaemon(engine, rule);
      let live: RuleLiveResult;
      try {
        live = await engine.ensureRuleLive(rule.id);
      } catch (err) {
        if (err instanceof SwitchEngineError) {
          return { configDir, movable: false, unusable: err.message };
        }
        throw err;
      }
      if (live.noWorkingAccount || live.liveAccount === null) {
        const picture = await readFolderPicture(engine);
        const why = nothingUsableReason(await rulePoolView(engine, rule, picture));
        return {
          configDir,
          movable: false,
          unusable: `${match.folder} has a folder rule, but no account it may use is usable: ${why}`,
        };
      }
      const account = (await engine.listAllAccounts()).find((a) => a.id === live.liveAccount);
      const usage = account !== undefined ? lastUsageOf(account) : undefined;
      return {
        configDir,
        movable: isMoveTarget(rule.include, live.liveAccount, usage, Date.now()),
      };
    },
    async view(configDir) {
      const [rules, live, accounts] = await Promise.all([
        engine.listRules(),
        engine.liveSlots(),
        engine.listAllAccounts(),
      ]);
      const labelIn = (slot: SlotId): string | undefined => {
        const id = live.get(slot) ?? null;
        return id === null ? undefined : labelOf(accounts, id);
      };
      const named = (account: string | undefined, slot: string): ConfigView =>
        account !== undefined ? { account: sanitizeForTerminal(account), slot } : { slot };
      if (configDir === null) return named(labelIn('global'), 'the global slot');
      const key = folderKeyOf(configDir, platform);
      const rule = rules.find((r) => folderKeyOf(profileOf(r.id), platform) === key);
      return rule === undefined
        ? { slot: 'the profile of a folder rule since removed', removed: true }
        : named(labelIn(ruleSlotId(rule.id)), `the folder slot of ${foldersOf(rule)}`);
    },
    daemonRunning,
    say: (line) => process.stderr.write(`${sanitizeForTerminal(line)}\n`),
    lockWaitMs: BACKGROUND_LOCK_WAIT_MS,
    timing: {
      clock: () => performance.now(),
      confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      // Only a way back that failed is logged by a move; it reaches the operator as one line.
      logger: {
        debug: () => {},
        info: () => {},
        warn: (_obj, msg) => process.stderr.write(`cctl: ${String(msg)}\n`),
        error: (_obj, msg) => process.stderr.write(`cctl: ${String(msg)}\n`),
      },
    },
  };
}

/** A folder's canonical path, or the path as spelled when it has none. */
function canonicalOrSpelled(folder: string, platform: NodeJS.Platform): string {
  const r = canonicalizeFolder(folder, {
    platform,
    cwd: process.cwd(),
    realpath: (p) => realpathSync.native(p),
  });
  return r.ok ? r.path : folder;
}

/** The launch slot for a config dir the routing chose: its account and slot for the banner, and the
 *  profile it runs in. */
async function slotOfConfig(ctx: RouteContext, configDir: string | null): Promise<LaunchSlot> {
  const view = await ctx.view(configDir);
  const label = view.account ?? 'no account';
  return configDir === null
    ? { kind: 'global', label, context: view.slot }
    : { kind: 'group', profileDir: configDir, label, context: view.slot };
}

/** Whether cctl's daemon is running (its heartbeat is fresh). */
async function daemonIsRunning(): Promise<boolean> {
  try {
    return (await readHeartbeat(daemonHeartbeatPath())).state === 'alive';
  } catch {
    return false;
  }
}

/** Orchestrate `cctl claude`: resolve the slot (explicit account > folder rule > global), make it
 *  live, print the one-line banner, and spawn the real executable. Arguments that reach a background
 *  session (`attach <session>`, `--resume <session>`, `stop|rm <session>`, the picker, the agents
 *  view) are first routed to where that session runs or belongs, or checked against the slot's
 *  rows (see backgroundAttach.ts). */
async function runClaude(opts: {
  account?: string;
  override: boolean;
  args: string[];
}): Promise<void> {
  const engine = buildEngine();
  const paths = defaultPaths();
  const platform = process.platform;
  const profRoot = profilesRoot(paths.vaultDir);

  // Folder profiles never exist on macOS (folder rules are refused there), so nothing is routed.
  const request = platform === 'darwin' ? undefined : parseBackgroundRequest(opts.args);
  let routing: { ctx: RouteContext; decision: RouteDecision } | undefined;
  const route = async (mode: RouteMode): Promise<RouteDecision> => {
    const say = (line: string): void => void process.stderr.write(`${sanitizeForTerminal(line)}\n`);
    const guard = moveShield(say);
    const ctx = routeContext(
      engine,
      paths,
      launcherBackgroundHost(paths),
      await daemonIsRunning(),
      guard.shield,
    );
    const decision = await routeBackgroundLaunch(request!, ctx, mode);
    if (guard.interrupted()) {
      // Asked to stop while a move ran: the move finished (or put the session back), and nothing is
      // opened after it.
      if ('hold' in decision) decision.hold?.lock.release();
      say('cctl: interrupted; not opening the session.');
      process.exitCode = 130;
      return { kind: 'refuse', message: '' };
    }
    if (decision.kind === 'refuse') fail(decision.message);
    routing = { ctx, decision };
    return decision;
  };
  // Without --account or --override the launch follows the session: it opens where the session
  // belongs, or where it runs while it cannot move there.
  if (request !== undefined && opts.account === undefined && !opts.override) {
    const decision = await route({ kind: 'follow' });
    // Interrupted while a move ran (any other refusal has ended the command already).
    if (decision.kind === 'refuse') return;
    if (decision.kind === 'open') {
      await launchRouted(routing!.ctx, decision);
      return;
    }
  }

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
        profileDir: ruleProfilePath(paths.vaultDir, rule.id),
        label: acct.label,
        context: `explicit account, ${rule.folders.join(', ')}`,
      };
    } else {
      // A shared account runs where it is already live: the global slot, or the slot of this
      // folder's rule when it is live there (the folder's fallback, or a folder that excludes the
      // global account). A launch never switches a slot out from under the sessions on it, so
      // anywhere else --account of a shared account is refused.
      const globalLive = await engine.getActiveId('global');
      const match = resolveFolderRule(
        canonicalizeCliFolder(process.cwd()),
        await engine.listRules(),
        platform,
      );
      const liveHere =
        match !== null && (await engine.liveSlots()).get(ruleSlotId(match.rule.id)) === acct.id;
      if (acct.id === globalLive) {
        slot = { kind: 'global', label: acct.label, context: 'global (shared account)' };
      } else if (match !== null && liveHere) {
        // The folder's own slot on the account it holds: no relaxation is involved.
        explicit = false;
        slot = {
          kind: 'group',
          profileDir: ruleProfilePath(paths.vaultDir, match.rule.id),
          label: acct.label,
          context: `${match.folder} folder rule`,
        };
      } else {
        fail(
          `${acct.label} is a shared account live neither in the global slot nor in this folder's ` +
            `slot. Switch to it first (cctl switch ${acct.label}, with --folder <folder> for a ` +
            `folder's slot), then run cctl claude, or omit --account.`,
        );
      }
    }
  } else {
    // No explicit account: the cwd's folder rule decides, unless --override asks for the global
    // account here on purpose (the guard honors that launch's token for this session).
    const canonical = canonicalizeCliFolder(process.cwd());
    const rules = await engine.listRules();
    const match = opts.override ? null : resolveFolderRule(canonical, rules, platform);
    if (match !== null) {
      const rule = match.rule;
      await refuseSeatingUnderOlderDaemon(engine, rule);
      let live;
      try {
        live = await engine.ensureRuleLive(rule.id);
      } catch (err) {
        if (err instanceof SwitchEngineError) fail(err.message);
        throw err;
      }
      if (live.noWorkingAccount || live.liveAccount === null) {
        const picture = await readFolderPicture(engine);
        const why = nothingUsableReason(await rulePoolView(engine, rule, picture));
        fail(`${match.folder} has a folder rule, but no account it may use is usable: ${why}.`);
      }
      const liveLabel = labelOf(await engine.listAllAccounts(), live.liveAccount);
      slot = {
        kind: 'group',
        profileDir: ruleProfilePath(paths.vaultDir, rule.id),
        label: liveLabel,
        context: `${match.folder} folder rule`,
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

  // With the slot chosen by --account or --override, the session is not moved, but it is still never
  // taken from the service that runs it: an open there would kill it where it runs.
  if (request !== undefined && routing === undefined) {
    const decision = await route({
      kind: 'fixed',
      configDir: slot.kind === 'group' ? (slot.profileDir ?? null) : null,
    });
    if (decision.kind === 'refuse') return;
    if (decision.kind === 'open') {
      await launchRouted(routing!.ctx, decision);
      return;
    }
  }
  const hold = routing?.decision.kind === 'pass' ? routing.decision.hold : undefined;
  const holdHost = routing?.ctx.host;
  await runHolding(holdHost ?? NO_JOURNAL, hold, (spawned) =>
    launchOnSlot({
      slot,
      explicit,
      override: opts.override,
      args: opts.args,
      paths,
      profRoot,
      onSpawn: spawned,
    }),
  );
}

/** A host for {@link runHolding} when nothing is held. */
const NO_JOURNAL = { attachedBy: () => Promise.resolve(false) };

/** The real executable, located and classified, or the command fails saying why. */
function claudeLaunchTarget(platform: NodeJS.Platform): { command: string; prefixArgs: string[] } {
  const candidate = findClaudeOnPath({ platform });
  if (candidate === undefined) {
    fail('could not find `claude` on PATH. Install Claude Code, or add its directory to PATH.');
  }
  const target = resolveLaunchTarget(candidate, { platform, readFileSync });
  if (target.kind === 'refused') fail(target.reason);
  return target;
}

/** Whether a global launch drops an inherited CLAUDE_CONFIG_DIR: only one naming a folder profile
 *  (see configDirPointsIntoProfiles), so a session started from inside one lands on the main dir. */
function dropsInheritedConfigDir(slot: LaunchSlot, profRoot: string): boolean {
  return (
    slot.kind === 'global' &&
    configDirPointsIntoProfiles(process.env.CLAUDE_CONFIG_DIR, profRoot, {
      platform: process.platform,
      cwd: process.cwd(),
      realpath: (p) => realpathSync.native(p),
    })
  );
}

/**
 * Run what the background-session routing chose: Claude Code under that config dir, with the
 * routing's arguments, behind the same banner as any launch. The config dir is named exactly as the
 * routing's own commands named it (see ClaudeBackgroundHost.configEnv), whatever CLAUDE_CONFIG_DIR
 * this shell inherited, so the terminal opens the service the session was found in. No relaxation
 * token is minted: opening a running background session starts no session of its own, and the
 * session keeps the environment it was started with.
 */
async function launchRouted(
  ctx: RouteContext,
  decision: Extract<RouteDecision, { kind: 'open' }>,
): Promise<void> {
  await runHolding(ctx.host, decision.hold, async (spawned) => {
    const target = claudeLaunchTarget(process.platform);
    const slot = await slotOfConfig(ctx, decision.configDir);
    const env = buildLaunchEnv({ baseEnv: process.env, slot, dropInheritedConfigDir: true });
    const named = ctx.host.configEnv(decision.configDir);
    if (named !== undefined) env.CLAUDE_CONFIG_DIR = named;
    process.stderr.write(
      `cctl: Claude Code on ${sanitizeForTerminal(slot.label)} (${sanitizeForTerminal(slot.context)})\n`,
    );
    try {
      process.exitCode = await spawnClaude({
        command: target.command,
        args: [...target.prefixArgs, ...decision.args],
        env,
        onSpawn: spawned,
      });
    } catch (err) {
      fail(`failed to launch Claude Code: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** The launch itself, on the slot `cctl claude` resolved: the banner, the relaxation tokens, and the
 *  real executable with the operator's arguments. */
async function launchOnSlot(input: {
  slot: LaunchSlot;
  explicit: boolean;
  override: boolean;
  args: string[];
  paths: Paths;
  profRoot: string;
  /** Told the pid of the Claude Code it starts (see runHolding). */
  onSpawn?: (pid: number) => void;
}): Promise<void> {
  const { explicit, paths, profRoot } = input;
  let slot = input.slot;
  const platform = process.platform;
  const target = claudeLaunchTarget(platform);

  // Build the child env.
  const dropInheritedConfigDir = dropsInheritedConfigDir(slot, profRoot);

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
  if (input.override) {
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
  // It names the actual session cwd (where the relaxation applies), not the account's own folder.
  if (overrideToken !== undefined) {
    process.stderr.write(relaxationBannerLine('override', slot.label, process.cwd()));
  }
  if (explicitToken !== undefined) {
    process.stderr.write(relaxationBannerLine('explicit', slot.label, process.cwd()));
  }

  try {
    const code = await spawnClaude({
      command: target.command,
      args: [...target.prefixArgs, ...input.args],
      env,
      ...(input.onSpawn !== undefined ? { onSpawn: input.onSpawn } : {}),
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
