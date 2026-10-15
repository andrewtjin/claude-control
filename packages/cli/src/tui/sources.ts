// The full-screen view's real data and actions, over one engine.
//
// Every read is local, from the same places the one-shot commands read: the vault (accounts,
// rules, live slots), the daemon's database (usage snapshots, sessions), its heartbeat and
// settings report, and the exhaustion log. Nothing here calls Anthropic. Actions are the account
// actions the commands run, against the same engine, so a refusal reads the same in both places.
//
// The engine is the caller's, built with a log sink that lands in the status line: a diagnostic
// written to stderr would scribble over the drawn screen.

import { Store, readHeartbeat, type UsageRepollResult } from '@claude-control/daemon';
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
import { buildEngine, daemonDbPath } from '../context.js';
import { readFoldersView } from '../folderCommands.js';
import { sessionRowFromStore, weeklyResetHeader } from '../sessionRender.js';
import { callDaemonUsageRepoll, type SessionClientDeps } from '../sessionClient.js';
import { daemonHeartbeatPath, daemonSettingsPath, readSettingsReport } from '../settings.js';
import { readUsageState, type UsageState } from '../usageState.js';
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
   *  command. */
  readOutages: (nowMs: number) => Promise<OutagesView>;
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The registry and its usage, read once per load and shared by the panes that show them. The
 *  whole registry is read, reserved (folder-bound) accounts included, as `cctl accounts list`
 *  shows them. */
interface RegistryPicture {
  usage: UsageState;
  rules: Awaited<ReturnType<Engine['listRules']>>;
  live: Awaited<ReturnType<Engine['liveSlots']>>;
  ruleIdsOf: Map<string, string[]>;
}

async function readRegistry(engine: Engine, nowMs: number): Promise<RegistryPicture> {
  const [all, rules, live] = await Promise.all([
    engine.listAllAccounts(),
    engine.listRules(),
    engine.liveSlots(),
  ]);
  return {
    usage: await readUsageState(nowMs, all, engine),
    rules,
    live,
    ruleIdsOf: new Map(all.map((a) => [a.id, a.ruleIds ?? []] as const)),
  };
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
 *  its label too. */
function readSessions(usage: UsageState, nowMs: number): TuiSessions {
  const { accounts, activeId, usageFor, predictedResetFor } = usage;
  const labelById = new Map(accounts.map((a) => [a.id, a.label] as const));
  const store = new Store(daemonDbPath());
  let rows;
  try {
    rows = store.listSessions().map((s) => sessionRowFromStore(s, labelById));
  } finally {
    store.close();
  }
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
  return {
    async load(nowMs): Promise<TuiSnapshot> {
      const registry = await section(() => readRegistry(engine, nowMs));
      const [daemon, sessions, folders, outages] = await Promise.all([
        readDaemon(nowMs),
        registry.ok
          ? section(() => Promise.resolve(readSessions(registry.value.usage, nowMs)))
          : Promise.resolve(registry),
        section(() => readFoldersView(engine)),
        section(() => deps.readOutages(nowMs)),
      ]);
      const accounts: Section<TuiAccount[]> = registry.ok
        ? { ok: true, value: accountsOf(registry.value) }
        : registry;
      return { readAtMs: nowMs, accounts, daemon, sessions, folders, outages };
    },
    switchAccount: (id) => switchAccount(id, {}, ctx),
    setExcluded: (id, excluded) => setExcluded(id, excluded, ctx),
    renameAccount: (id, label) => renameAccount(id, label, ctx),
    removeAccount: (id) => removeAccount(id, ctx),
    addAccount: (label) =>
      addAccount(label, { fresh: true, loginWindow: deps.loginWindow ?? claudeLoginWindow }, ctx),
    repoll: (): Promise<UsageRepollResult> => callDaemonUsageRepoll(undefined, deps.daemonClient),
  };
}
