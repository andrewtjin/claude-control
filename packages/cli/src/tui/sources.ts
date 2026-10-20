// The full-screen view's real data and actions, over one engine.
//
// Every read is local, from the same places the one-shot commands read: the vault (accounts,
// rules, live slots), the daemon's database (usage snapshots, sessions), its heartbeat and
// settings report, and the exhaustion log. Nothing here calls Anthropic. Actions are the account
// actions the commands run, against the same engine, so a refusal reads the same in both places.
//
// The engine is the caller's, built with a log sink that lands in the status line: a diagnostic
// written to stderr would scribble over the drawn screen.
//
// Each pane degrades on its own, by where its data lives: the account list comes from the vault
// and survives an unreadable daemon database (shown without usage), and the sessions come from the
// daemon database and survive an unreadable vault (shown without account labels). The database is
// held open for the view's lifetime (see UsageReader): it is read every couple of seconds.

import { readHeartbeat, type UsageRepollResult } from '@claude-control/daemon';
import { planLabel } from '@claude-control/usage-advisor';
import {
  addAccount,
  claudeLoginWindow,
  removeAccount,
  renameAccount,
  setExcluded,
  switchAccount,
  type LoginWindow,
} from '../accountActions.js';
import { buildEngine } from '../context.js';
import { readFoldersView } from '../folderCommands.js';
import { sessionRowFromStore, weeklyResetHeader } from '../sessionRender.js';
import { callDaemonUsageRepoll, type SessionClientDeps } from '../sessionClient.js';
import { daemonHeartbeatPath, daemonSettingsPath, readSettingsReport } from '../settings.js';
import { UsageReader, type UsageState } from '../usageState.js';
import type {
  OutagesView,
  Section,
  TuiAccount,
  TuiDaemon,
  TuiSessions,
  TuiSnapshot,
  TuiSources,
} from './types.js';

type Engine = ReturnType<typeof buildEngine>;

/** What {@link createTuiSources} is built from. */
export interface TuiSourceDeps {
  engine: Engine;
  /** The outage history `cctl outages` prints. Passed in because its reader lives with that
   *  command. `usage` is the whole fleet's usage when this read already has it, so the outage
   *  judgement need not read it again. */
  readOutages: (nowMs: number, usage?: UsageState) => Promise<OutagesView>;
  /** The window a fresh add logs in through; defaults to a real `claude`. */
  loginWindow?: LoginWindow;
  /** Where the daemon's loopback secret and endpoint are read from (tests point it at a temp
   *  dir); defaults to the real data dir. */
  daemonClient?: SessionClientDeps;
}

/** Run one pane's read, turning a failure into the words the pane shows instead. */
async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The registry and its usage, read once per load and shared by the panes that show them. The
 *  whole registry is read, reserved (folder-bound) accounts included, as `cctl accounts list`
 *  shows them. `usageError` says why the usage is empty when the daemon's database could not be
 *  read: the registry is still good without it. */
interface RegistryPicture {
  usage: UsageState;
  usageError?: string;
  rules: Awaited<ReturnType<Engine['listRules']>>;
  live: Awaited<ReturnType<Engine['liveSlots']>>;
  ruleIdsOf: Map<string, string[]>;
}

async function readRegistry(
  engine: Engine,
  reader: UsageReader,
  nowMs: number,
): Promise<RegistryPicture> {
  const [all, rules, live] = await Promise.all([
    engine.listAllAccounts(),
    engine.listRules(),
    engine.liveSlots(),
  ]);
  // The global slot's live account is already in hand; asking the engine again would re-read
  // the live login.
  const activeId = live.get('global') ?? null;
  const ruleIdsOf = new Map(all.map((a) => [a.id, a.ruleIds ?? []] as const));
  try {
    return { usage: await reader.read(nowMs, all, activeId), rules, live, ruleIdsOf };
  } catch (err) {
    return {
      usage: {
        accounts: all,
        activeId,
        usageFor: () => undefined,
        predictedResetFor: () => undefined,
        burnUnitsPerDay: undefined,
      },
      usageError: messageOf(err),
      rules,
      live,
      ruleIdsOf,
    };
  }
}

/** The accounts, with usage, plan, folder memberships and live markers. */
function accountsOf(picture: RegistryPicture): TuiAccount[] {
  const { usage, rules, live } = picture;
  const ruleLabel = new Map(rules.map((r) => [r.id, r.label] as const));
  return usage.accounts.map((a): TuiAccount => {
    // A rule names the account by inclusion, or holds it live in its slot (an inherited shared
    // account): either way the account answers to that folder now.
    const folders = new Set<string>();
    for (const id of picture.ruleIdsOf.get(a.id) ?? []) folders.add(ruleLabel.get(id) ?? id);
    for (const [slot, liveId] of live) {
      if (slot !== 'global' && liveId === a.id) folders.add(ruleLabel.get(slot) ?? slot);
    }
    const snapshot = usage.usageFor(a.id);
    const predicted = usage.predictedResetFor(a.id);
    return {
      id: a.id,
      label: a.label,
      plan: planLabel(a),
      active: usage.activeId === a.id,
      quarantined: a.quarantined,
      excluded: a.autoSwitchExcluded === true,
      ...(snapshot !== undefined ? { usage: snapshot } : {}),
      ...(predicted !== undefined ? { predictedResetAt: predicted } : {}),
      folders: [...folders],
      extraTags: [],
    };
  });
}

/** The daemon's heartbeat, and auto-switch as the running daemon reported it. */
async function readDaemon(nowMs: number): Promise<TuiDaemon> {
  const heartbeat = await readHeartbeat(daemonHeartbeatPath(), nowMs);
  if (heartbeat.state !== 'alive') return { heartbeat };
  const report = await readSettingsReport(daemonSettingsPath());
  const value = report?.settings.find((r) => r.name === 'auto-switch')?.value;
  return value === 'on' || value === 'off'
    ? { heartbeat, autoSwitch: value === 'on' }
    : { heartbeat };
}

/** What `cctl session status` shows: the tracked sessions and the live account's weekly runway.
 *  Account ids resolve against the whole registry, so a session on a folder-bound account shows
 *  its label too. Without a registry (the vault unreadable) the sessions are still listed, by
 *  their account ids and with no runway header. */
function readSessions(
  reader: UsageReader,
  usage: UsageState | undefined,
  nowMs: number,
): TuiSessions {
  const labelById = new Map((usage?.accounts ?? []).map((a) => [a.id, a.label] as const));
  const rows = reader.listSessions().map((s) => sessionRowFromStore(s, labelById));
  if (usage === undefined) return { rows, header: {} };
  const { accounts, activeId, usageFor, predictedResetFor } = usage;
  const active = accounts.find((a) => a.id === activeId);
  return {
    rows,
    header: {
      ...(active ? { activeLabel: active.label } : {}),
      ...(activeId
        ? weeklyResetHeader(usageFor(activeId), predictedResetFor(activeId), nowMs)
        : {}),
    },
  };
}

/** The view's sources over `deps.engine`. */
export function createTuiSources(deps: TuiSourceDeps): TuiSources {
  const { engine } = deps;
  const ctx = { engine };
  // No burn rate: the view never shows one, and measuring it is the costly part of a read.
  const reader = new UsageReader(engine, { burn: false });
  return {
    async load(nowMs): Promise<TuiSnapshot> {
      const registry = await section(() => readRegistry(engine, reader, nowMs));
      const picture = registry.ok ? registry.value : undefined;
      const usage = picture?.usageError === undefined ? picture?.usage : undefined;
      const [daemon, sessions, folders, outages] = await Promise.all([
        readDaemon(nowMs),
        section(() => Promise.resolve(readSessions(reader, picture?.usage, nowMs))),
        section(() => readFoldersView(engine)),
        section(() => deps.readOutages(nowMs, usage)),
      ]);
      const accounts: Section<TuiAccount[]> = registry.ok
        ? { ok: true, value: accountsOf(registry.value) }
        : registry;
      return {
        readAtMs: nowMs,
        accounts,
        daemon,
        sessions,
        folders,
        outages,
        ...(picture?.usageError !== undefined ? { usageError: picture.usageError } : {}),
      };
    },
    switchAccount: (id) => switchAccount(id, {}, ctx),
    setExcluded: (id, excluded) => setExcluded(id, excluded, ctx),
    renameAccount: (id, label) => renameAccount(id, label, ctx),
    removeAccount: (id, label) => removeAccount(id, ctx, { label }),
    addAccount: (label, onStored) =>
      addAccount(
        label,
        {
          fresh: true,
          loginWindow: deps.loginWindow ?? claudeLoginWindow,
          ...(onStored !== undefined ? { onAdded: (added) => onStored(added.message) } : {}),
        },
        ctx,
      ),
    repoll: (): Promise<UsageRepollResult> => callDaemonUsageRepoll(undefined, deps.daemonClient),
    close: () => reader.close(),
  };
}
