// The Daemon: composes every subsystem into the running per-user background process.
//
// This file is deliberately thin — the actual logic (parsing, polling/backoff, the security
// contract on permission resolution, outbox buffering, hook merging) lives in and is tested
// by each subsystem's own module. What's tested HERE is composition: on `start()`, recovery
// runs, the poller and hook receiver come up, the control-plane client connects, and inbound
// protocol messages are wired to the right collaborator. Every collaborator is accepted
// pre-built (dependency injection) so a lifecycle test can fake all of them.

import { randomUUID } from 'node:crypto';
import type { RecoverResult, ActivateResult, StoredAccount } from '@claude-control/switch-engine';
import { resolveAccountRef } from '@claude-control/switch-engine';
import type {
  SessionManager,
  SessionHandle,
  SessionRecord,
  PermissionRequest,
  QuestionRequest,
  QuestionAnswer,
} from '@claude-control/session-runtime';
import {
  createAgentSdkClient as defaultCreateAgentSdkClient,
  escalateStop,
} from '@claude-control/session-runtime';
import type { AgentSdkClient } from '@claude-control/session-runtime';
import type { SessionEvent } from '@claude-control/session-runtime';
import { type Logger, noopLogger } from '@claude-control/switch-engine';
import type { EnvelopeDraft, MessageOf, PayloadOf } from '@claude-control/shared-protocol';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import type { Store } from './store.js';
import { UsagePoller, type PollAccount } from './usagePoller.js';
import type { AttributionJournal } from './attributionJournal.js';
import type {
  HookReceiver,
  HookReceiverCliHandlers,
  SessionCommandBase,
  SessionCommandResult,
  SessionLabelInput,
  SessionRegisterInput,
  SessionWatchInput,
  TrackedSessionView,
} from './hookReceiver.js';
import { ControlPlaneClient } from './controlPlaneClient.js';
import { startLoopLagMonitor } from './loopLagMonitor.js';

/** The subset of `SwitchEngine`'s public surface the daemon depends on — narrower than the
 *  concrete class so tests can fake it without building a whole real engine. The real
 *  `SwitchEngine` satisfies this structurally; no adapter needed. */
export interface SwitchEngineLike {
  recover(): Promise<RecoverResult>;
  activate(id: string): Promise<ActivateResult>;
  listAccounts(): Promise<StoredAccount[]>;
  getActiveId(): Promise<string | null>;
}

/** The slice of `AutoSwitcher` the daemon calls each poll cycle — narrowed to an interface
 *  so lifecycle tests can fake it (mirroring `SwitchEngineLike`). */
export interface AutoSwitcherLike {
  evaluate(accounts: AccountUsageInput[]): Promise<void>;
}

export interface DaemonOptions {
  store: Store;
  switchEngine: SwitchEngineLike;
  sessionManager: SessionManager;
  poller: UsagePoller;
  attributionJournal: AttributionJournal;
  hookReceiver: HookReceiver;
  controlPlaneClient: ControlPlaneClient;
  /** Opt-in: evaluated after every poll cycle; absent = auto-switching disabled. */
  autoSwitcher?: AutoSwitcherLike;
  /** The effective-settings report resolved at startup (see cli/settings.ts). When present
   *  it is re-pushed with every poll cycle — settings never change mid-run, but the bot's
   *  cache is in-memory, so the repeat is what survives a bot restart. */
  settingsReport?: PayloadOf<'settings.snapshot'>;
  /** Real Agent SDK adapter (live boundary), overridable so tests never touch a real SDK. */
  createAgentSdkClient?: () => AgentSdkClient;
  /** Self-heal the CLI's hook config on startup. Called AFTER the hook receiver binds, with
   *  its actual loopback port, so it can (re)install the curl hooks that POST to that port.
   *  Injected — the composition root owns WHERE settings.json lives and which profile is
   *  targeted (see daemonRun.ts) — and optional so lifecycle tests and hook-less setups can
   *  omit it. Its rejection must NEVER crash startup: settings.json can be read-only or locked,
   *  and hooks are additive, not load-bearing for the daemon's own liveness. */
  installHooks?: (port: number) => Promise<void>;
  /** Publish the hook receiver's bound loopback port so a separate `cctl session` process can
   *  find this daemon (see hookEndpoint.ts). Called AFTER the receiver binds, with its actual
   *  port. Injected — the composition root owns WHERE the endpoint file lives — and optional so
   *  lifecycle tests can omit it. Failure is logged and swallowed: an unpublished endpoint means
   *  `cctl session register/label/watch` can't reach the daemon (they degrade to a clear "start
   *  the daemon" message), but nothing else the daemon does depends on it. */
  publishHookEndpoint?: (port: number) => Promise<void>;
  /** Cadence for RE-publishing the endpoint (default 60s). The file can be deleted out from
   *  under a running daemon — a stale-port forwarder's cleanup can race a restart — and a
   *  missing file makes every hook take the silent no-daemon fast path; the heartbeat bounds
   *  that outage to one interval. Injectable so tests can prove the re-publish quickly. */
  endpointRepublishMs?: number;
  /** Injectable clock (house convention: no fake timers). Only used for the quarantine-notice
   *  debounce; defaults to `Date.now`. */
  clock?: () => number;
  /** Minimum gap between repeat quarantine-notice pushes for the SAME account, so an account
   *  whose refresh flaps in and out of quarantine can't spam the phone. */
  quarantineNoticeDebounceMs?: number;
  /** Grace window for `session.stop` escalation (interrupt → THIS long → hard stop); defaults
   *  to escalateStop's own 5s. Injectable so tests can exercise the hard-stop rung with a
   *  short real-time window instead of fake timers (house convention). */
  stopGraceMs?: number;
  /** Bound on the live-session teardown inside {@link stop} (default 5s). Injectable so a
   *  test can prove a wedged handle cannot hang shutdown, without fake timers. */
  sessionStopOnShutdownMs?: number;
  /** How often to poll usage and re-sync attribution. */
  pollIntervalMs?: number;
  logger?: Logger;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** How long {@link Daemon.stop} waits for live session handles to tear down before closing
 *  the rest anyway. Generous for a normal `client.end()` (subprocess exit is fast), tight
 *  enough that one wedged transport cannot hold Ctrl+C hostage; a handle that misses the
 *  bound is exactly the crash shape the next start's recover() already reconciles. */
const DEFAULT_SESSION_STOP_ON_SHUTDOWN_MS = 5_000;
/** 30 minutes: re-login is a minutes-long human action on the PC, so nagging more often than
 *  ~twice an hour for the same still-broken account is pure noise. */
const DEFAULT_QUARANTINE_NOTICE_DEBOUNCE_MS = 30 * 60_000;

/**
 * DECISION — managed sessions always run in Claude Code's 'default' permission mode.
 * `session.spawn` carries no mode field (protocol v1), and 'default' is the only mode in
 * which the SDK parks tools on `canUseTool` — which IS the remote approve/deny loop (design:
 * approve/deny buttons only for 'default'-mode sessions; every other mode gets an
 * informational card). Any auto-approving mode (acceptEdits/bypassPermissions) would silently
 * remove the human from the loop on a phone-spawned session — the opposite of what remote
 * control exists for. If a future protocol rev adds a mode to session.spawn, the payload
 * should override this constant; until then the daemon owns the policy, not the phone.
 */
const MANAGED_SESSION_PERMISSION_MODE = 'default';

/** Bound on the session.stop and session.prune idempotency sets. These keys only need to
 *  survive the double/triple-tap window (seconds), so a few hundred remembered keys is
 *  generous while keeping each set trivially bounded across a long-lived daemon. */
const MAX_SEEN_STOP_KEYS = 256;

/** Remember an idempotency key with FIFO eviction past the bound — a JS Set iterates in
 *  insertion order, so the first value is always the oldest key. The one eviction mechanic
 *  behind every idempotency set the daemon keeps; the sets themselves stay separate because
 *  each names which commands share a dedupe namespace. */
function rememberBounded(keys: Set<string>, key: string, bound: number): void {
  keys.add(key);
  if (keys.size > bound) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
}

/** Bound on the `cctl session register|label|watch` idempotency set. Same FIFO discipline as
 *  the stop keys; a little larger because a busy user may register/label several sessions. The
 *  underlying operations are value-idempotent anyway (setting a label/watch flag to the same
 *  value twice is harmless) — the key set only exists to answer "already handled" for a genuine
 *  re-send without re-reading the switch engine for attribution. */
const MAX_SEEN_SESSION_CMD_KEYS = 512;

/** The Store `sessions.kind` value for a registered INTERACTIVE session — distinct from
 *  session-runtime's own 'managed'/'observed' kinds (the Store column is free-form text; see
 *  store.ts's decision note). These rows exist only for `cctl session status`. */
const INTERACTIVE_SESSION_KIND = 'interactive';

/** Endpoint re-publish heartbeat (see DaemonOptions.endpointRepublishMs): bounds how long a
 *  deleted endpoint file can hide a running daemon from its hooks. */
const DEFAULT_ENDPOINT_REPUBLISH_MS = 60_000;

/** A registered interactive session, as mirrored (display-only) into the Store `sessions`
 *  table's `json` column. Deliberately coarse: `state` is a single 'active' value — this commit
 *  does NOT thread live hook events into per-turn state for interactive sessions (that is the
 *  future SessionStart-auto-register work in the plan), and staleness is tolerated because the
 *  table is observability, never a recovery source (store.ts). */
interface TrackedInteractiveSession {
  id: string;
  kind: typeof INTERACTIVE_SESSION_KIND;
  state: 'active';
  /** Human label for the phone's session list. */
  label?: string;
  /** Per-session Discord-streaming opt-in. Recorded here as the control surface; enforcement
   *  (filtering the unconditional hook stream on this flag) is deliberately deferred so it
   *  cannot regress live hook cards — see the note in {@link Daemon.watchSession}. */
  watch: boolean;
  /** The account that was live when the session was registered — an attribution tag, matching
   *  the accountId semantics on managed sessions. */
  accountId?: string;
  registeredAtMs: number;
  updatedAtMs: number;
}

/** How long queued /say steering for an interactive session stays deliverable. Delivery only
 *  happens at a turn boundary (the session's next Stop hook), and a long turn can legitimately
 *  run tens of minutes — but guidance written for a context that is hours gone would arrive as
 *  a non sequitur, so entries past the TTL are dropped (with a card, never silently). */
const STEERING_TTL_MS = 30 * 60_000;
/** Upper bound on queued steer texts per session. Hitting it means nothing is delivering (an
 *  idle or closed window) — refusing the next /say with an honest error beats silently
 *  dropping the oldest, and it bounds what a dead session can accumulate in memory. */
const STEERING_QUEUE_CAP = 8;
/** One queued/delivered steering text, held in arrival order. */
interface QueuedSteering {
  text: string;
  queuedAtMs: number;
}

/** Outcome of resolving a label/watch/unregister ref (or a prompt.inject sessionId) against the
 *  interactive registry — see {@link Daemon.resolveInteractiveRef}. A distinct 'ambiguous'
 *  outcome (rather than just picking the first match) is the whole point: a label collision
 *  must never let the daemon guess which session the operator meant. */
type InteractiveRefResolution =
  | { outcome: 'resolved'; tracked: TrackedInteractiveSession }
  | { outcome: 'ambiguous'; matches: TrackedInteractiveSession[] }
  | { outcome: 'none' };

/** Pure view mapper: the compact shape echoed back to the CLI on a command. */
function interactiveView(t: TrackedInteractiveSession): TrackedSessionView {
  return {
    id: t.id,
    kind: t.kind,
    state: t.state,
    watch: t.watch,
    ...(t.label !== undefined ? { label: t.label } : {}),
    ...(t.accountId !== undefined ? { accountId: t.accountId } : {}),
  };
}

/** A view for the rare replay-with-vanished-row case (see registerSession): the row is gone but
 *  the idempotency key says we already applied, so we echo a minimal honest view. */
function minimalInteractiveView(sessionId: string): TrackedSessionView {
  return { id: sessionId, kind: INTERACTIVE_SESSION_KIND, state: 'active', watch: true };
}

/** Plain `Omit` over a discriminated union collapses `type`/`payload` into the union of ALL
 *  variants' values, losing the correlation between them — the same reason shared-protocol's
 *  own `EnvelopeDraft` is built with a distributive Omit rather than the built-in one. Reused
 *  here (rather than exported from shared-protocol) since only this file needs it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EnvelopeDraftSansDaemonId = DistributiveOmit<EnvelopeDraft, 'daemonId'>;

export class Daemon {
  private readonly store: Store;
  private readonly switchEngine: SwitchEngineLike;
  private readonly sessionManager: SessionManager;
  private readonly poller: UsagePoller;
  private readonly attributionJournal: AttributionJournal;
  private readonly hookReceiver: HookReceiver;
  private readonly controlPlaneClient: ControlPlaneClient;
  private readonly autoSwitcher: AutoSwitcherLike | undefined;
  private readonly settingsReport: PayloadOf<'settings.snapshot'> | undefined;
  private readonly createAgentSdkClient: () => AgentSdkClient;
  private readonly installHooks: ((port: number) => Promise<void>) | undefined;
  private readonly publishHookEndpoint: ((port: number) => Promise<void>) | undefined;
  private readonly endpointRepublishMs: number;
  private endpointRepublishTimer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: () => number;
  private readonly quarantineNoticeDebounceMs: number;
  private readonly stopGraceMs: number | undefined;
  private readonly sessionStopOnShutdownMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Tear-down for the event-loop lag watchdog started in {@link start}. */
  private stopLoopLagMonitor: (() => void) | undefined;
  /** Next `session.output.seq` to use per session — the protocol requires a monotonic
   *  per-session sequence so the phone can detect drops/reordering. */
  private readonly outputSeq = new Map<string, number>();
  /** One epoch token for THIS daemon run, stamped on every `session.output` envelope. Because
   *  {@link outputSeq} is in-memory it restarts at 0 on daemon restart; a crashed daemon never
   *  emitted a terminal `session.status`, so the bot still holds reassembly state (nextSeq past 0)
   *  for a session that a later operator prompt re-attaches under the SAME id (see
   *  {@link handlePromptInject}) and re-numbers from 0 — and would silently drop the resumed turn. A fresh epoch per run lets the bot detect the
   *  restart and reset its reassembly (with a visible marker). Stable within a run so the bot never
   *  resets spuriously mid-session. */
  private readonly outputEpoch = randomUUID();
  /** requestId → owning sessionId for permission requests that ORIGINATED from a managed
   *  session's SDK `canUseTool` (as opposed to CLI-hook-originated ones). Inbound
   *  `permission.response` routes on membership here — see {@link handlePermissionResponse}
   *  for why a registry (and not an id prefix) is the routing mechanism. Entries are swept
   *  when the owning session goes terminal (see {@link attachSessionPipes}), which bounds the
   *  map by the pending prompts of LIVE sessions. */
  private readonly managedPermissionRoutes = new Map<string, string>();
  /** requestId → owning sessionId for AskUserQuestion requests that ORIGINATED from a managed
   *  session's SDK `canUseTool` — the question analog of {@link managedPermissionRoutes}. Inbound
   *  `question.response` routes on membership here (managed leg → the session handle's gate;
   *  everything else → the held-hook receiver), for the same registry-not-id-prefix reason
   *  documented on {@link handleQuestionResponse}. Swept when the owning session goes terminal. */
  private readonly managedQuestionRoutes = new Map<string, string>();
  /** Recently seen `session.stop` idempotencyKeys, so a double-tapped/re-sent Stop never runs
   *  the escalation ladder twice. Bounded FIFO — see {@link rememberStopKey}. */
  private readonly seenStopKeys = new Set<string>();
  /** Recently seen `session.prune` idempotencyKeys, so a re-sent/replayed prune answers once
   *  instead of posting a second (empty) result. Bounded FIFO like the stop keys. */
  private readonly seenPruneKeys = new Set<string>();
  /** Recently seen `cctl session register|label|watch` idempotencyKeys, so a re-sent command
   *  answers "already handled" instead of re-applying. Bounded FIFO — see
   *  {@link rememberSessionCmdKey}. */
  private readonly seenSessionCmdKeys = new Set<string>();
  /** Operator /say texts queued per REGISTERED INTERACTIVE session, awaiting that session's
   *  next Stop hook (see {@link queueSteering}). In-memory only — a daemon restart drops the
   *  queue, which is tolerable because every queued text was confirmed to the phone as
   *  "queued", delivery is best-effort by design, and the TTL bounds staleness anyway. */
  private readonly pendingSteering = new Map<string, QueuedSteering[]>();
  /** Per-account quarantine bookkeeping for edge-detection + debounce; see
   *  {@link reconcileQuarantineNotices}. In-memory only, so it resets on restart — which is
   *  deliberate (an account already quarantined at startup is surfaced by the usage snapshot,
   *  not re-pushed on every restart). */
  private quarantineState = new Map<string, QuarantineNoticeState>();
  private started = false;

  constructor(options: DaemonOptions) {
    this.store = options.store;
    this.switchEngine = options.switchEngine;
    this.sessionManager = options.sessionManager;
    this.poller = options.poller;
    this.attributionJournal = options.attributionJournal;
    this.hookReceiver = options.hookReceiver;
    this.controlPlaneClient = options.controlPlaneClient;
    this.autoSwitcher = options.autoSwitcher;
    this.settingsReport = options.settingsReport;
    this.createAgentSdkClient = options.createAgentSdkClient ?? defaultCreateAgentSdkClient;
    this.installHooks = options.installHooks;
    this.publishHookEndpoint = options.publishHookEndpoint;
    this.endpointRepublishMs = options.endpointRepublishMs ?? DEFAULT_ENDPOINT_REPUBLISH_MS;
    this.clock = options.clock ?? Date.now;
    this.quarantineNoticeDebounceMs =
      options.quarantineNoticeDebounceMs ?? DEFAULT_QUARANTINE_NOTICE_DEBOUNCE_MS;
    this.stopGraceMs = options.stopGraceMs;
    this.sessionStopOnShutdownMs =
      options.sessionStopOnShutdownMs ?? DEFAULT_SESSION_STOP_ON_SHUTDOWN_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Bring the daemon up: recover any interrupted switch, start the hook receiver, wire
   * inbound-message handlers, connect to the control plane, and kick off periodic polling.
   * Order matters only where a real dependency exists (recover before anything else touches
   * credentials; handlers wired before connect so no early inbound message can be dropped).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Loop-lag watchdog: any synchronous work anywhere in this process re-couples hook
    // latency (paid per tool call by every session on the machine) to that work. The warning
    // names the stall so the regression class that motivated it (sync child-process waits on
    // the poll path) can never again hide behind "hooks feel slow".
    this.stopLoopLagMonitor = startLoopLagMonitor({
      onStall: (lagMs) =>
        this.logger.warn(
          { lagMs },
          'event loop stalled - every concurrent hook request waited this long; find and async the blocking work',
        ),
    });

    const recovery = await this.switchEngine.recover();
    if (recovery.recovered) {
      this.logger.info({ recovery }, 'switch engine recovery ran on daemon startup');
    }

    // Install the CLI session-command logic BEFORE binding, so a `cctl session` request that
    // arrives the instant the port opens is served rather than 503'd. Pure delegation — the
    // registry logic lives in this class's methods; the receiver owns transport + auth.
    this.hookReceiver.setCliHandlers(this.cliHandlers());
    // Same late-binding seam for steering: the receiver answers Stop hooks, this class owns
    // WHAT is queued for them (the /say → queue → turn-boundary delivery path).
    this.hookReceiver.setSteeringSource((sessionId) => this.takePendingSteering(sessionId));

    const hookPort = await this.hookReceiver.listen(0);

    // Publish the bound loopback port so `cctl session register|label|watch` can find us. Like
    // hook self-heal below, this is additive and fail-open: a publish failure only degrades the
    // CLI-command surface, never the daemon's own liveness. Re-published on a heartbeat: the
    // file is this daemon's ONLY discoverability, and it can be deleted while we run (a
    // stale-port forwarder's cleanup racing a restart, an operator mistake) — without the
    // heartbeat that leaves a healthy, listening daemon no hook can find until the next start.
    if (this.publishHookEndpoint) {
      const republish = this.publishHookEndpoint;
      this.endpointRepublishTimer = setInterval(() => {
        republish(hookPort).catch((err: unknown) => {
          this.logger.warn({ err }, 'hook endpoint re-publish failed; retrying next heartbeat');
        });
      }, this.endpointRepublishMs);
      this.endpointRepublishTimer.unref();
      try {
        await this.publishHookEndpoint(hookPort);
      } catch (err) {
        this.logger.error(
          { err },
          'failed to publish hook endpoint; cctl session commands cannot reach this daemon',
        );
      }
    }

    // Self-heal the CLI's hook config so permission/stop/notification events actually reach the
    // receiver we just bound. A failure here (settings.json unwritable/locked, or invalid JSON
    // the installer refuses to clobber) is logged and swallowed: remote hooks degrade to "not
    // installed", but local Claude use and every other daemon subsystem keep working. See the
    // `installHooks` option doc for why this is fail-open.
    if (this.installHooks) {
      try {
        await this.installHooks(hookPort);
      } catch (err) {
        this.logger.error(
          { err },
          'hook self-heal failed; continuing without installed hooks (remote approve/deny degraded)',
        );
      }
    }

    this.controlPlaneClient.setHandlers({
      onSwitchCommand: (msg) => {
        this.handleSwitchCommand(msg).catch((err: unknown) => {
          this.logger.error({ err }, 'error handling switch.command');
        });
      },
      onPermissionResponse: (msg) => {
        this.handlePermissionResponse(msg);
      },
      onQuestionResponse: (msg) => {
        this.handleQuestionResponse(msg);
      },
      onPromptInject: (msg) => {
        this.handlePromptInject(msg).catch((err: unknown) => {
          this.logger.error({ err }, 'error handling prompt.inject');
        });
      },
      onSessionSpawn: (msg) => {
        this.handleSessionSpawn(msg).catch((err: unknown) => {
          this.logger.error({ err }, 'error handling session.spawn');
        });
      },
      onSessionStop: (msg) => {
        this.handleSessionStop(msg).catch((err: unknown) => {
          this.logger.error({ err }, 'error handling session.stop');
        });
      },
      onSessionPrune: (msg) => {
        this.handleSessionPrune(msg).catch((err: unknown) => {
          this.logger.error({ err }, 'error handling session.prune');
        });
      },
    });

    await this.controlPlaneClient.connect();

    // Reconcile session records a previous daemon run left behind: stamp them 'orphaned' so
    // their persisted state is honest. Deliberately NO re-attach here — resuming a session
    // always runs a real turn (the SDK has no attach-without-prompting), so an eager pass
    // would re-run work nobody asked for on every single restart, once per idle session.
    // Orphans stay dormant until the operator actually addresses one, at which point THEIR
    // text is the resumed turn (see handlePromptInject). A failure here must NEVER kill
    // startup: an un-reconcilable registry is a degraded feature, not a dead daemon.
    try {
      await this.reconcileOrphanedSessions();
    } catch (err) {
      this.logger.error({ err }, 'session reconciliation failed; continuing startup without it');
    }

    // Run one poll cycle immediately so the phone has fresh data as soon as the daemon comes
    // up, rather than waiting a full interval; failures here must not crash startup — the
    // interval loop below will simply try again.
    this.runPollCycle().catch((err: unknown) => {
      this.logger.error({ err }, 'initial poll cycle failed');
    });
    this.pollTimer = setInterval(() => {
      this.runPollCycle().catch((err: unknown) => {
        this.logger.error({ err }, 'poll cycle failed');
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.stopLoopLagMonitor?.();
    this.stopLoopLagMonitor = undefined;
    if (this.endpointRepublishTimer) clearInterval(this.endpointRepublishTimer);
    this.endpointRepublishTimer = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    // Live sessions FIRST, while the store/receiver they report through still work: each
    // handle.stop() ends the spawned SDK subprocess and fail-closes any parked permission
    // prompt through the runtime's own turn teardown. Without this, shutdown leaks the
    // `claude` child processes — still running under the last-activated account, invisible
    // to the next daemon run (whose recover() only stamps the registry rows 'orphaned').
    await this.stopLiveSessions();
    this.controlPlaneClient.close();
    await this.hookReceiver.close();
    this.store.close();
  }

  /** Stop every live session handle, bounded by {@link sessionStopOnShutdownMs}. Plain
   *  `handle.stop()`, deliberately NOT the interrupt-then-grace escalation ladder: shutdown
   *  is not a request to finish the turn gracefully, and a per-session grace window would
   *  hold process exit hostage. Failures are settled, never thrown — a handle whose
   *  transport is already dead is no less stopped for it — and a handle that outlives the
   *  bound is left to next start's recover(), the same as any crash. */
  private async stopLiveSessions(): Promise<void> {
    const handles = this.sessionManager
      .list()
      .map((record) => this.sessionManager.get(record.id))
      .filter((handle): handle is SessionHandle => handle !== undefined);
    if (handles.length === 0) return;
    this.logger.info({ count: handles.length }, 'stopping live sessions before shutdown');
    const bound = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.sessionStopOnShutdownMs);
      timer.unref();
    });
    await Promise.race([
      Promise.allSettled(handles.map((handle) => handle.stop())).then(() => undefined),
      bound,
    ]);
  }

  // ---- poll cycle ----

  private async runPollCycle(): Promise<void> {
    await this.attributionJournal.sync();

    const [accounts, activeId] = await Promise.all([
      this.switchEngine.listAccounts(),
      this.switchEngine.getActiveId(),
    ]);
    const pollAccounts: PollAccount[] = accounts.map((a) => ({
      accountId: a.id,
      label: a.label,
      active: a.id === activeId,
      quarantined: a.quarantined,
    }));

    // Push a guided-re-login card the moment an account newly enters quarantine. Done off the
    // authoritative registry flag (not the poll result) so it fires even if the usage poll for
    // that account degrades. Ordered before pollAll so a poll failure can't skip the alert.
    this.emitQuarantineNotices(pollAccounts);

    const snapshot = await this.poller.pollAll(pollAccounts);
    for (const result of snapshot.results) {
      if (result.outcome === 'skipped') continue; // nothing new to persist
      this.store.insertUsageSnapshot({
        accountId: result.accountId,
        fetchedAtMs: result.usage.accountUsage.fetchedAtMs,
        source: result.usage.accountUsage.source,
        json: JSON.stringify(result.usage.accountUsage),
      });
    }

    this.sendEnvelope({
      type: 'usage.snapshot',
      payload: { accounts: snapshot.accounts, plan: snapshot.plan },
    });

    // Piggyback the (static) effective-settings report on the usage cadence: a tiny frame,
    // and re-sending keeps `/settings` answerable even after the bot restarts and loses its
    // in-memory cache.
    if (this.settingsReport) {
      this.sendEnvelope({ type: 'settings.snapshot', payload: this.settingsReport });
    }

    // Auto-switch runs AFTER the snapshot ships, so the phone always sees the usage state
    // that triggered a hop before the hop's own switch.result arrives. AutoSwitcher absorbs
    // engine failures itself; this catch only guards against bugs in the evaluator so a
    // broken policy can never take down the poll loop.
    if (this.autoSwitcher) {
      const inputs = snapshot.results.map((r) => r.usage.advisorInput);
      await this.autoSwitcher.evaluate(inputs).catch((err: unknown) => {
        this.logger.error({ err }, 'auto-switch evaluation failed');
      });
    }
  }

  /** Emit a `hook.notification` (level 'warn') for each account that just entered quarantine,
   *  then carry the updated debounce state forward. Delegates the edge-detection + debounce to
   *  the pure {@link reconcileQuarantineNotices} so that logic is unit-testable without driving
   *  whole poll cycles. */
  private emitQuarantineNotices(accounts: PollAccount[]): void {
    const { notices, nextState } = reconcileQuarantineNotices(
      accounts.map((a) => ({ accountId: a.accountId, label: a.label, quarantined: a.quarantined })),
      this.quarantineState,
      this.clock(),
      this.quarantineNoticeDebounceMs,
    );
    this.quarantineState = nextState;
    for (const notice of notices) {
      this.sendEnvelope({
        type: 'hook.notification',
        payload: {
          // Account-level, so there is no sessionId. `notificationType: 'quarantine'` is the
          // exact discriminator the (already-committed) bot keys the quarantine card off. The
          // payload has no accountId field, so the account reference (label + id) goes in the
          // title/body as human-readable text. We deliberately DO NOT emit any guided-re-login
          // command here: the bot owns the card copy (its re-login verb is a bot-side constant),
          // so competing copy from the daemon would only risk drift.
          event: 'notification',
          title: `Account quarantined: ${notice.label}`,
          body:
            `Account "${notice.label}" (${notice.accountId}) can no longer refresh its login ` +
            `(its refresh token is dead) and needs re-authentication on this PC before it can be ` +
            `used again.`,
          level: 'warn',
          notificationType: 'quarantine',
        },
      });
    }
  }

  // ---- inbound handlers ----

  private async handleSwitchCommand(msg: MessageOf<'switch.command'>): Promise<void> {
    const { requestId, targetAccountId } = msg.payload;
    try {
      // Phone-side commands carry whatever the user typed — an id or a label. Resolve it the
      // same way `cctl switch` does, or `/switch account:spare` fails while the identical
      // ref works locally. Unknown/ambiguous refs are refused with the resolver's message.
      const resolved = resolveAccountRef(await this.switchEngine.listAccounts(), targetAccountId);
      if (!resolved.ok) throw new Error(resolved.message);
      const result = await this.switchEngine.activate(resolved.account.id);
      // The engine reports only what it mechanically did (see switch-engine's own docs):
      // whether a running interactive session picks up rewritten live credentials is a
      // separate, per-platform empirical fact this daemon does not currently verify — so a
      // successful write is reported as the file-level hot-apply it actually performed.
      this.sendEnvelope({
        type: 'switch.result',
        payload: {
          requestId,
          ok: result.ok,
          outcome: 'hot_applied',
          activeAccountId: result.activeAccountId,
          message: `switched to ${result.activeAccountId}`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const activeAccountId =
        (await this.switchEngine.getActiveId().catch(() => null)) ?? targetAccountId;
      this.sendEnvelope({
        type: 'switch.result',
        payload: {
          requestId,
          ok: false,
          outcome: 'failed',
          activeAccountId,
          message: `switch to ${targetAccountId} failed`,
          error: message,
        },
      });
    }
  }

  /**
   * One inbound pipeline, two request origins:
   *  - CLI-hook-originated requests (an interactive `claude` run on the PC) resolve through
   *    `hookReceiver.resolvePermission` — the DB WHERE-guarded single-resolve path.
   *  - SDK-originated requests (a managed session's parked `canUseTool`) resolve through the
   *    owning `SessionHandle.resolvePermission` — the in-process permission gate that actually
   *    unblocks the tool.
   *
   * WHY a requestId REGISTRY (managedPermissionRoutes) and not an id prefix: requestIds are
   * minted by third parties (the SDK's control-request ids; the hook payload's own ids), so
   * the daemon cannot impose a namespace without REWRITING the id — and a rewritten id would
   * no longer match what the runtime/DB knows, forcing an unmangling step on every resolve and
   * re-opening exactly the forged/stale-id ambiguity the security contract exists to close.
   * The registry needs no such rewriting: membership is recorded at the only place an SDK
   * request can enter ({@link handleManagedPermissionRequest}), so an id NOT in it is by
   * construction not a managed request. Unknown ids resolve NOTHING on either leg — the
   * managed leg returns 'unknown' from the gate, the hook leg rejects on its DB guard.
   *
   * `scope` is accepted on the wire but v1 applies every decision once-only (session-scoped
   * allows are not implemented in the runtime) — the same posture the hook path has always had.
   */
  private handlePermissionResponse(msg: MessageOf<'permission.response'>): void {
    const { requestId, decision } = msg.payload;

    const owningSessionId = this.managedPermissionRoutes.get(requestId);
    if (owningSessionId !== undefined) {
      const handle = this.sessionManager.get(owningSessionId);
      if (!handle?.resolvePermission) {
        // The session died between request and response — the runtime already denied the
        // request fail-closed when its turn ended. Drop; never fall through to the hook path,
        // where "resolving" the row would record a decision nothing ever applied.
        this.logger.warn(
          { requestId, sessionId: owningSessionId },
          'permission.response for a managed request whose session is gone; dropped',
        );
        return;
      }
      const outcome = handle.resolvePermission(requestId, {
        behavior: decision,
        // The SDK requires a reason on a deny; the adapter would default one, but naming the
        // actual origin (a human on the phone) is more useful to the model than a generic.
        ...(decision === 'deny' ? { message: 'denied by remote operator' } : {}),
      });
      if (outcome === 'resolved') {
        // Mirror the applied decision onto the pending_permissions row so the audit trail
        // matches what happened. The row is bookkeeping on this leg, not the guard (the
        // runtime's gate is), so a 0-change result would only mean the row went missing.
        this.store.resolvePendingPermission(requestId, decision);
      } else {
        // 'already_handled' (double-tap) or 'unknown' (request ended with its turn): the
        // idempotency/fail-closed guard working, not a daemon error.
        this.logger.warn({ requestId, outcome }, 'managed permission.response not applied');
      }
      return;
    }

    // Hook-originated (or entirely unknown) — the pre-existing path, unchanged.
    const result = this.hookReceiver.resolvePermission(requestId, decision);
    if (!result.ok) {
      // Exactly the security contract's job: a stale/forged/duplicate response is logged and
      // dropped, never applied. This is not an error in the daemon — it's the guard working.
      this.logger.warn({ requestId, error: result.error }, 'rejected permission.response');
    }
  }

  /**
   * The question analog of {@link handlePermissionResponse}, with the same two-origin routing and
   * the same registry-not-id-prefix rationale (see that method): a `question.response` whose
   * requestId is in {@link managedQuestionRoutes} came from a managed session's SDK gate and must
   * be answered by the owning `SessionHandle.resolveQuestion` (the only place the parked tool's
   * blocking promise lives); anything else is a held-hook question resolved through
   * `hookReceiver.resolveQuestion` (the DB WHERE-guarded single-resolve path). Unknown ids answer
   * NOTHING on either leg.
   */
  private handleQuestionResponse(msg: MessageOf<'question.response'>): void {
    const { requestId, answers } = msg.payload;
    // Normalize the wire answers into the runtime's domain shape once (nullish otherText → omit),
    // used only on the managed leg; the hook leg consumes the wire shape directly.
    const domainAnswers: QuestionAnswer[] = answers.map((a) => ({
      question: a.question,
      selected: a.selected,
      ...(a.otherText != null ? { otherText: a.otherText } : {}),
    }));

    const owningSessionId = this.managedQuestionRoutes.get(requestId);
    if (owningSessionId !== undefined) {
      const handle = this.sessionManager.get(owningSessionId);
      if (!handle?.resolveQuestion) {
        // The session died between request and response — the runtime already denied the parked
        // question fail-closed when its turn ended. Drop; never fall through to the hook path,
        // where "resolving" the row would record an answer nothing ever applied.
        this.logger.warn(
          { requestId, sessionId: owningSessionId },
          'question.response for a managed request whose session is gone; dropped',
        );
        return;
      }
      const outcome = handle.resolveQuestion(requestId, domainAnswers);
      if (outcome === 'resolved') {
        // Mark the audit row answered so it matches what the gate applied. The row is bookkeeping
        // on this leg, not the guard (the runtime's gate is), so a 0-change result would only
        // mean the row went missing.
        this.store.resolvePendingQuestion(requestId, this.clock());
      } else {
        // 'already_handled' (double-tap) or 'unknown' (question ended with its turn): the
        // idempotency/fail-closed guard working, not a daemon error.
        this.logger.warn({ requestId, outcome }, 'managed question.response not applied');
      }
      return;
    }

    // Hook-originated (or entirely unknown) — the held-hook resolve, whose own contract rejects a
    // stale/duplicate/expired/unanswered response and injects the answers as updatedInput.
    const result = this.hookReceiver.resolveQuestion(requestId, answers);
    if (!result.ok) {
      this.logger.warn({ requestId, error: result.error }, 'rejected question.response');
    }
  }

  private async handlePromptInject(msg: MessageOf<'prompt.inject'>): Promise<void> {
    const { sessionId, text } = msg.payload;
    const handle = this.sessionManager.get(sessionId);
    if (handle) {
      await handle.send(text);
      return;
    }

    // A REGISTERED terminal session has no direct input channel (the daemon cannot type into
    // another process's terminal), but it does have a turn boundary: queue the text and
    // deliver it as the session's next Stop-hook answer. See queueSteering. The ref may be the
    // real id or a registered label — resolveInteractiveRef covers both, same as label/watch/
    // unregister.
    const resolution = this.resolveInteractiveRef(sessionId);
    if (resolution.outcome === 'resolved') {
      this.queueSteering(msg, resolution.tracked);
      return;
    }
    if (resolution.outcome === 'ambiguous') {
      // Mirrors answerPromptInjectRefusal's shape: every refusal ANSWERS the phone, since the
      // bot already acked the /say optimistically when the relay accepted the frame.
      this.sendEnvelope({
        type: 'error',
        payload: {
          code: 'ambiguous_label',
          message: this.ambiguousLabelMessage(sessionId, resolution.matches),
          relatesTo: msg.id,
        },
      });
      return;
    }

    // No live handle — the session may be an orphan from a previous daemon run. Re-attach it
    // NOW, with the operator's text as the resumed turn's prompt: resuming always runs a real
    // turn (the SDK has no attach-without-prompting), so re-attach happens only at the moment
    // the operator actually addresses the session, never as a startup side effect. Gated to
    // 'orphaned' managed records. Every refusal ANSWERS the phone (an error envelope, same as
    // stop's unknown-session path): the bot acks a /say as soon as the relay accepts the
    // frame, so a silent drop here would leave the operator believing text reached a session
    // that never heard it.
    const record = this.sessionManager.list().find((r) => r.id === sessionId);
    if (
      record === undefined ||
      record.kind !== 'managed' ||
      record.state !== 'orphaned' ||
      this.sessionManager.resumeOrphan === undefined
    ) {
      this.logger.warn({ sessionId }, 'prompt.inject for unknown/inactive session');
      this.answerPromptInjectRefusal(msg, record);
      return;
    }
    try {
      const resumed = await this.sessionManager.resumeOrphan(sessionId, {
        client: this.createAgentSdkClient(),
        prompt: text,
        permissionMode: MANAGED_SESSION_PERMISSION_MODE,
      });
      this.attachSessionPipes(resumed, record.accountId);
      this.logger.info({ sessionId }, 'orphaned session re-attached for an operator prompt');
    } catch (err) {
      // Un-resumable (e.g. no persisted resumeId): logged, the record stays 'orphaned' on
      // disk, and the phone is told — degraded but honest, never a crashed dispatch loop.
      this.logger.warn({ sessionId, err }, 'orphaned session could not be re-attached');
      this.sendEnvelope({
        type: 'error',
        payload: {
          code: 'resume_failed',
          message:
            `prompt.inject: session '${sessionId}' could not be re-attached ` +
            `(${err instanceof Error ? err.message : String(err)})`,
          relatesTo: msg.id,
        },
      });
    }
  }

  /**
   * Tell the phone WHY its /say went nowhere. The message is cause-specific because the
   * generic "unknown session" reads as a typo when the id is plainly visible in the phone's
   * own session list. (A registered terminal session never lands here — its /say queues for
   * turn-boundary delivery instead; see {@link queueSteering}.)
   */
  private answerPromptInjectRefusal(
    msg: MessageOf<'prompt.inject'>,
    record: SessionRecord | undefined,
  ): void {
    const { sessionId } = msg.payload;
    const detail =
      record !== undefined && (record.state === 'done' || record.state === 'failed')
        ? `session '${sessionId}' already ended`
        : `no live session '${sessionId}' in this daemon`;
    this.sendEnvelope({
      type: 'error',
      payload: { code: 'unknown_session', message: `prompt.inject: ${detail}`, relatesTo: msg.id },
    });
  }

  /**
   * Queue a /say for a REGISTERED INTERACTIVE session and confirm the queueing to the phone.
   * The daemon only hears from a terminal session through its hooks (a one-way stream), so
   * delivery rides one of two supported reverse channels, whichever the session hits first:
   * its next Stop hook, answered with the CLI's documented `{"decision": "block", "reason": …}`
   * (continues the turn with the text as guidance), or its next UserPromptSubmit hook —
   * fired the moment the user types locally, which can happen while the session is otherwise
   * idle — answered with `hookSpecificOutput.additionalContext` ({@link takePendingSteering}
   * is the delivery side for both). A bounded queue + TTL still keep a closed window (one that
   * hits NEITHER channel) from accumulating stale guidance forever.
   *
   * Keyed on `tracked.id`, NEVER on `msg.payload.sessionId`: the caller may have addressed this
   * session by its registered label, but the hook that eventually asks for the queue
   * (takePendingSteering) always carries the session's real id — queuing under the label would
   * make delivery unreachable.
   */
  private queueSteering(msg: MessageOf<'prompt.inject'>, tracked: TrackedInteractiveSession): void {
    const { text } = msg.payload;
    const sessionId = tracked.id;
    const queue = this.pendingSteering.get(sessionId) ?? [];
    if (queue.length >= STEERING_QUEUE_CAP) {
      this.sendEnvelope({
        type: 'error',
        payload: {
          code: 'steer_queue_full',
          message:
            `prompt.inject: ${queue.length} messages are already queued for '${sessionId}' and ` +
            `none have delivered — the session looks idle or closed. Queued text delivers when ` +
            `it next finishes a turn; \`cctl session unregister\` discards the queue.`,
          relatesTo: msg.id,
        },
      });
      return;
    }
    queue.push({ text, queuedAtMs: this.clock() });
    this.pendingSteering.set(sessionId, queue);
    const excerpt = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    this.sendEnvelope({
      type: 'hook.notification',
      payload: {
        event: 'notification',
        sessionId,
        title: `Queued for ${tracked.label ?? 'terminal session'}`,
        body:
          `"${excerpt}" — delivers when the session finishes its current turn or you next type in it` +
          `${queue.length > 1 ? ` (${queue.length} queued)` : ''}.`,
        level: 'info',
        notificationType: 'steering_queued',
      },
    });
    this.logger.info({ sessionId, queued: queue.length }, 'steering queued for terminal session');
  }

  /**
   * The delivery side of {@link queueSteering}, installed into the hook receiver as its
   * steering source: consume everything queued for `sessionId`, expire what aged past the
   * TTL (with a card — the operator was told it was queued, so it must not vanish silently),
   * and hand back the surviving texts joined in arrival order for the answer to WHICHEVER hook
   * asked first (Stop or UserPromptSubmit — the receiver routes both here). The `Map.delete`
   * below is what makes consumption exactly-once: the second hook to fire for a session finds
   * nothing queued, never a repeat delivery.
   */
  private takePendingSteering(sessionId: string): string | undefined {
    const queue = this.pendingSteering.get(sessionId);
    if (queue === undefined) return undefined;
    this.pendingSteering.delete(sessionId);
    const now = this.clock();
    const fresh = queue.filter((q) => now - q.queuedAtMs <= STEERING_TTL_MS);
    const expired = queue.length - fresh.length;
    if (expired > 0) {
      this.sendEnvelope({
        type: 'hook.notification',
        payload: {
          event: 'notification',
          sessionId,
          title: 'Steering expired',
          body:
            `${expired} queued message${expired === 1 ? '' : 's'} aged past ` +
            `${STEERING_TTL_MS / 60_000} minutes before the session finished a turn or the ` +
            `user typed again — dropped, not delivered.`,
          level: 'warn',
          notificationType: 'steering_expired',
        },
      });
    }
    if (fresh.length === 0) return undefined;
    this.sendEnvelope({
      type: 'hook.notification',
      payload: {
        event: 'notification',
        sessionId,
        title: 'Steering delivered',
        body:
          `${fresh.length === 1 ? 'Your message was' : `${fresh.length} messages were`} ` +
          `handed to the session at its turn boundary — it is continuing with your guidance.`,
        level: 'success',
        notificationType: 'steering_delivered',
      },
    });
    this.logger.info({ sessionId, delivered: fresh.length, expired }, 'steering delivered');
    return fresh.map((q) => q.text).join('\n\n');
  }

  private async handleSessionSpawn(msg: MessageOf<'session.spawn'>): Promise<void> {
    const { prompt, resumeSessionId, cwd, accountId } = msg.payload;
    const client = this.createAgentSdkClient();
    const handle = await this.sessionManager.spawnManaged({
      client,
      prompt,
      // Always 'default' so remote approve/deny actually works — see the constant's decision
      // comment for why the daemon (not the spawn payload) owns this policy in protocol v1.
      permissionMode: MANAGED_SESSION_PERMISSION_MODE,
      ...(resumeSessionId !== undefined && resumeSessionId !== null ? { resumeSessionId } : {}),
      ...(cwd !== undefined && cwd !== null ? { cwd } : {}),
      ...(accountId !== undefined && accountId !== null ? { accountId } : {}),
    });

    this.attachSessionPipes(handle, accountId ?? undefined);
  }

  /**
   * Phone-initiated stop: interrupt → grace window → hard stop. `escalateStop` owns the
   * ladder (tested in session-runtime); this handler owns idempotency and routing. There is
   * deliberately NO stop.result envelope — the acknowledgment rides on the `session.status`
   * transitions the stopped handle's own event stream already forwards (running →
   * done/failed), so the phone's source of truth for "it stopped" is the same as for every
   * other state change.
   */
  private async handleSessionStop(msg: MessageOf<'session.stop'>): Promise<void> {
    const { sessionId, idempotencyKey } = msg.payload;

    // Duplicate-CHECK first, before any await: a double-tapped Stop (same key, re-sent or replayed)
    // must not run the ladder twice — a second interrupt() landing inside the first stop's grace
    // window would turn a graceful wind-down into a harder stop than asked for.
    if (this.seenStopKeys.has(idempotencyKey)) {
      this.logger.info({ sessionId, idempotencyKey }, 'duplicate session.stop ignored');
      return;
    }

    const handle = this.sessionManager.get(sessionId);
    if (!handle) {
      // Unknown/inactive session: tell the phone explicitly (`relatesTo` = the stop frame's
      // own envelope id, the protocol's correlation anchor) rather than leaving the Stop
      // button waiting on a session.status ack that will never come — and never crash.
      // Deliberately do NOT rememberStopKey here: burning the key on a stop that merely RACED a
      // not-yet-live session (e.g. during the startup resume window) would make the card's stable
      // per-(user,action,session) key un-stoppable forever once the session comes live. Sibling CLI
      // handlers likewise only remember keys on success.
      this.logger.warn({ sessionId }, 'session.stop for unknown/inactive session');
      this.sendEnvelope({
        type: 'error',
        payload: {
          code: 'unknown_session',
          message: `session.stop: no live session '${sessionId}' in this daemon`,
          relatesTo: msg.id,
        },
      });
      return;
    }

    // Remember the key now that a live handle exists — still BEFORE the first await. `get()` is
    // synchronous, so nothing has yielded since the duplicate-CHECK above; the "suppress before the
    // first await" invariant that protects the grace window from a double-tap is preserved.
    this.rememberStopKey(idempotencyKey);

    const result = await escalateStop(handle, {
      ...(this.stopGraceMs !== undefined ? { graceMs: this.stopGraceMs } : {}),
    });
    // The rung is the honest answer to "did it die cleanly?" — logged for the record; the
    // phone reads the outcome off the forwarded session.status transition.
    this.logger.info(
      { sessionId, rung: result.rung, state: result.state },
      'session.stop escalation finished',
    );
  }

  /** Remember a session.stop idempotencyKey. Kept as a named method (not an inline
   *  {@link rememberBounded} call) because handleSessionStop's key-burning rules reference it. */
  private rememberStopKey(key: string): void {
    rememberBounded(this.seenStopKeys, key, MAX_SEEN_STOP_KEYS);
  }

  /**
   * Phone-initiated prune of dormant session records. The registry primitive
   * (`sessionManager.prune`) owns what "dormant" means — terminal records, plus non-terminal
   * leftovers with no live handle in this process (their owner is gone) — so a session with
   * live work is structurally untouchable; this handler owns idempotency and the result
   * reply. Unlike stop there IS a dedicated result envelope: pruned records disappear rather
   * than transition, so no session.status ack ever comes, and the phone needs the exact
   * pruned ids to clear its own cached session list — plus the registry's remaining ids, so
   * it can also drop cached ghosts this daemon holds no record of at all.
   */
  private async handleSessionPrune(msg: MessageOf<'session.prune'>): Promise<void> {
    const { requestId, idempotencyKey } = msg.payload;
    if (this.seenPruneKeys.has(idempotencyKey)) {
      this.logger.info({ requestId, idempotencyKey }, 'duplicate session.prune ignored');
      return;
    }
    // Burn the key before the first await. Unlike stop there is no not-yet-live race to
    // protect the key from: a prune always applies to whatever is dormant right now, and a
    // failed prune should NOT be silently retried by a replayed frame — the phone got an
    // explicit ok:false result to act on.
    rememberBounded(this.seenPruneKeys, idempotencyKey, MAX_SEEN_STOP_KEYS);

    if (this.sessionManager.prune === undefined) {
      this.sendEnvelope({
        type: 'session.prune.result',
        payload: {
          requestId,
          ok: false,
          prunedSessionIds: [],
          error: 'this daemon cannot prune session records',
        },
      });
      return;
    }
    try {
      const pruned = await this.sessionManager.prune();
      // Drop the display-only Store mirror rows too: the registry record is gone, so a
      // leftover mirror row would show the pruned session in `cctl session status` forever.
      // Best-effort per row — the mirror is observability, never authoritative.
      for (const record of pruned) {
        try {
          this.store.deleteSession(record.id);
        } catch (err) {
          this.logger.warn(
            { err, sessionId: record.id },
            'failed to drop a pruned session from the display mirror',
          );
        }
      }
      this.logger.info({ sessionIds: pruned.map((r) => r.id) }, 'pruned dormant session records');
      this.sendEnvelope({
        type: 'session.prune.result',
        payload: {
          requestId,
          ok: true,
          prunedSessionIds: pruned.map((r) => r.id),
          // The full post-prune registry view, so the bot can also clear cached rows for
          // sessions this daemon holds NO record of (lost rather than pruned) — without it
          // those ghosts would outlive every prune. Computed after the prune, so it can
          // only over-include (a session spawned mid-prune), never name a pruned id.
          remainingSessionIds: this.sessionManager.list().map((r) => r.id),
        },
      });
    } catch (err) {
      this.logger.error({ err }, 'session prune failed');
      this.sendEnvelope({
        type: 'session.prune.result',
        payload: {
          requestId,
          ok: false,
          prunedSessionIds: [],
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // ---- managed-session plumbing (spawn + resume share all of it) ----

  /**
   * Stamp session records a previous daemon run left behind as 'orphaned' — bookkeeping
   * only, no re-attach. Resuming an SDK session always starts a real turn, so re-attach is
   * strictly on demand: the operator's next prompt.inject to an orphan resumes it with that
   * text as the turn (see {@link handlePromptInject}). Orphans stay visible in `list()`,
   * never silently dropped.
   *
   * PERSISTENCE DECISION: session records live in session-runtime's `sessions.json` (atomic
   * temp+rename with a serialized write queue) and ONLY there — the Store's `sessions` table
   * stays deliberately unwired. Mirroring every state change into sqlite would create a
   * second source of truth that recover()/resumeOrphan never read, and a crash between the
   * two writes guarantees eventual divergence; nothing reads the table today. If the planned
   * `cctl session status` wants sqlite access, the mirror must land in the same commit as its
   * reader (see the matching note in store.ts).
   */
  private async reconcileOrphanedSessions(): Promise<void> {
    const orphaned = await this.sessionManager.recover();
    if (orphaned.length > 0) {
      this.logger.info(
        { sessionIds: orphaned.map((r) => r.id) },
        'found orphaned sessions from a previous run; each re-attaches on its next operator prompt',
      );
    }
  }

  /**
   * Subscribe the two channels every managed session must forward, identically for fresh
   * spawns and crash-resumed sessions: display events → session.status/session.output
   * envelopes, and STRUCTURED permission requests → the pending-permission pipeline. Also
   * sweeps the session's permission routes on terminal status — which is what keeps
   * `managedPermissionRoutes` bounded (a session's requests never outlive the session).
   */
  private attachSessionPipes(handle: SessionHandle, accountId: string | undefined): void {
    handle.onEvent((event) => {
      if (event.kind === 'status' && (event.state === 'done' || event.state === 'failed')) {
        this.sweepManagedPermissionRoutes(handle.id);
        this.sweepManagedQuestionRoutes(handle.id);
      }
      this.forwardSessionEvent(handle.id, accountId, event);
    });
    // Optional on SessionHandle (observed terminals have no structured permission seam);
    // managed handles always implement it.
    handle.onPermissionRequest?.((req) => {
      this.handleManagedPermissionRequest(handle.id, req);
    });
    // The question seam, symmetric with the permission one — structured AskUserQuestion requests
    // from a managed session's SDK gate.
    handle.onQuestionRequest?.((req) => {
      this.handleManagedQuestionRequest(handle.id, req);
    });
  }

  /**
   * An SDK-originated permission request: the managed session's `canUseTool` has PARKED a
   * tool awaiting a human decision. Bookkeeping mirrors the hook-originated path (a
   * `pending_permissions` row + a `permission.request` envelope) so the phone sees ONE kind of
   * permission card regardless of origin — but the request is ALSO registered in
   * `managedPermissionRoutes`, because resolution travels a different leg: back into the
   * in-process SessionHandle that owns the blocked promise, not the hook receiver's
   * DB-guarded resolve.
   *
   * No `expiresAt` on the envelope: unlike hook prompts (15-min TTL), an SDK-parked prompt
   * deliberately has NO deadline (never auto-allow/deny on timeout) — it
   * stays pending until a human answers or the turn/session ends, at which point the runtime
   * denies it fail-closed.
   */
  private handleManagedPermissionRequest(sessionId: string, req: PermissionRequest): void {
    // The SDK can re-deliver a control_request for a still-pending id (see the runtime's
    // permissionGate.register) — a repeat must not re-insert the row or push a second card.
    if (this.managedPermissionRoutes.has(req.requestId)) return;
    this.managedPermissionRoutes.set(req.requestId, sessionId);
    // Same duplicate-guard against the DB: protects the PRIMARY KEY insert from an id that
    // (however improbably) collides with a hook-originated row.
    if (this.store.getPendingPermission(req.requestId) === undefined) {
      this.store.insertPendingPermission({
        requestId: req.requestId,
        sessionId,
        tool: req.tool,
        summary: req.summary,
        createdAtMs: this.clock(),
        // Marks the row as SDK-owned so the hook receiver's resolve path refuses it: only
        // THIS process's in-memory gate can actually apply a decision to a parked tool, and
        // a resolver in any other process flipping the shared row would record an allow/deny
        // nothing ever applied.
        origin: 'managed',
      });
    }
    this.sendEnvelope({
      type: 'permission.request',
      payload: {
        requestId: req.requestId,
        sessionId,
        tool: req.tool,
        summary: req.summary,
        ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
      },
    });
    // Deliberately NO companion hook.notification (the hook path sends one): a managed
    // session's own event stream already surfaces the "Permission required: …" milestone as
    // session.output, so a notification here would be a duplicate card on the phone.
  }

  /** Drop every permission route owned by `sessionId` once it ends, mirroring the runtime's
   *  fail-closed teardown onto the audit rows: the session's gate has already DENIED any
   *  still-pending request when it went terminal, so the row must not linger 'pending'. That
   *  also makes a LATE phone response harmless — with the route gone it falls through to the
   *  hook receiver's resolve, whose already-resolved DB guard rejects it instead of recording
   *  a decision nothing ever applied. (The WHERE-guarded update leaves rows a human actually
   *  answered untouched.) */
  private sweepManagedPermissionRoutes(sessionId: string): void {
    for (const [requestId, owner] of this.managedPermissionRoutes) {
      if (owner !== sessionId) continue;
      this.managedPermissionRoutes.delete(requestId);
      this.store.resolvePendingPermission(requestId, 'deny');
    }
  }

  /**
   * An SDK-originated AskUserQuestion request: the managed session's `canUseTool` has PARKED the
   * tool awaiting the human's answers. The exact mirror of {@link handleManagedPermissionRequest}
   * — a `pending_questions` row + a `question.request` envelope so the phone sees one kind of
   * question card regardless of origin — but registered in {@link managedQuestionRoutes} because
   * resolution travels back into the in-process SessionHandle, not the hook receiver's DB resolve.
   *
   * No `expiresAt`: an SDK-parked question deliberately has NO deadline (never auto-answer on
   * timeout); it stays pending until a human answers or the turn/session ends, at which point the
   * runtime denies it fail-closed. No companion `hook.notification` either: the managed session's
   * own event stream already surfaces the "Question: …" milestone.
   */
  private handleManagedQuestionRequest(sessionId: string, req: QuestionRequest): void {
    // The SDK can re-deliver a control_request for a still-pending id — a repeat must not
    // re-insert the row or push a second card.
    if (this.managedQuestionRoutes.has(req.requestId)) return;
    this.managedQuestionRoutes.set(req.requestId, sessionId);
    if (this.store.getPendingQuestion(req.requestId) === undefined) {
      this.store.insertPendingQuestion({
        requestId: req.requestId,
        sessionId,
        createdAtMs: this.clock(),
        // SDK-owned so the hook receiver's resolve path refuses it — only THIS process's gate can
        // answer a parked question.
        origin: 'managed',
      });
    }
    this.sendEnvelope({
      type: 'question.request',
      payload: {
        requestId: req.requestId,
        sessionId,
        questions: req.questions,
        ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
      },
    });
  }

  /** Drop every question route owned by `sessionId` once it ends — the mirror of
   *  {@link sweepManagedPermissionRoutes}. The session's gate has already denied any still-pending
   *  question when it went terminal, so the row must not linger unresolved, and a LATE phone
   *  answer becomes harmless: with the route gone it falls through to the hook receiver's resolve,
   *  whose already-resolved DB guard rejects it. */
  private sweepManagedQuestionRoutes(sessionId: string): void {
    for (const [requestId, owner] of this.managedQuestionRoutes) {
      if (owner !== sessionId) continue;
      this.managedQuestionRoutes.delete(requestId);
      this.store.resolvePendingQuestion(requestId, this.clock());
    }
  }

  /** Translate a session backend's own event vocabulary into wire envelopes for the phone. */
  private forwardSessionEvent(
    sessionId: string,
    accountId: string | undefined,
    event: SessionEvent,
  ): void {
    if (event.kind === 'status') {
      // Mirror the transition into the display-only Store table BEFORE shipping the envelope,
      // so `cctl session status` reflects the same state the phone just saw. Failure to mirror
      // must never block the live envelope — see mirrorManagedSession.
      this.mirrorManagedSession(sessionId, accountId, event.state);
      this.sendEnvelope({
        type: 'session.status',
        payload: {
          sessionId,
          state: event.state,
          ...(accountId !== undefined ? { accountId } : {}),
        },
      });
      return;
    }

    const kind = event.kind === 'output' ? 'stdout' : event.kind;
    const seq = this.outputSeq.get(sessionId) ?? 0;
    this.outputSeq.set(sessionId, seq + 1);
    this.sendEnvelope({
      type: 'session.output',
      // `epoch` is this run's token so the bot can tell a restart-induced seq reset (which
      // re-numbers from 0) apart from real output loss — see {@link outputEpoch}.
      payload: {
        sessionId,
        seq,
        kind,
        text: event.text,
        truncated: false,
        epoch: this.outputEpoch,
      },
    });
  }

  // ---- cctl session CLI commands (interactive-session registry) ----
  //
  // These back the `cctl session register|label|watch` loopback endpoints (hookReceiver). They
  // manage a DISPLAY-ONLY registry of interactive Claude Code sessions the user opted into
  // tracking, mirrored into the Store `sessions` table (kind='interactive') so `cctl session
  // status` reads them offline. This is purely additive observability: it never touches the
  // hook stream, the managed-session pipeline, or recovery (store.ts). SEMANTICS:
  //   - register:   opt a session into tracking; default `watch: true` (registering implies you
  //     want it on the phone). Idempotent; a no-change re-register answers 'already_registered'
  //     and keeps any prior label/watch choice.
  //   - label:      name a REGISTERED session (404 if not registered — register is the gateway).
  //   - watch:      set the per-session streaming opt-in on a REGISTERED session (404 otherwise).
  //   - unregister: drop a REGISTERED session from tracking (404 otherwise) — the undo for
  //     register, including registrations made with a mistyped id.
  // label/watch/unregister (and prompt.inject) accept EITHER the real session id or a registered
  // label as their ref — see resolveInteractiveRef. A label matching more than one session is
  // 409 'ambiguous_label', never a guess. register never resolves labels: its sessionId is what
  // CREATES the row, so it must be the real Claude session id.
  // The watch flag is RECORDED as the control surface; enforcing it (filtering the unconditional
  // hook stream) is deferred so it cannot regress live cards — see watchSession.

  /** Bind this daemon's registry methods as the receiver's CLI handlers. `register` is async
   *  (it reads the switch engine for attribution); `label`/`watch` are synchronous and wrapped
   *  in a resolved promise to satisfy the uniformly-async handler contract. */
  private cliHandlers(): HookReceiverCliHandlers {
    return {
      registerSession: (input) => this.registerSession(input),
      labelSession: (input) => Promise.resolve(this.labelSession(input)),
      watchSession: (input) => Promise.resolve(this.watchSession(input)),
      unregisterSession: (input) => Promise.resolve(this.unregisterSession(input)),
    };
  }

  /** Opt an interactive session into daemon tracking. Async because it reads the switch engine
   *  for the attribution tag. Idempotent on `idempotencyKey` AND value-idempotent (a re-register
   *  preserves the prior label/watch). */
  private async registerSession(input: SessionRegisterInput): Promise<SessionCommandResult> {
    if (this.seenSessionCmdKeys.has(input.idempotencyKey)) {
      const current = this.readInteractiveSession(input.sessionId);
      return {
        ok: true,
        status: 'already_handled',
        session: current ? interactiveView(current) : minimalInteractiveView(input.sessionId),
      };
    }
    const existing = this.readInteractiveSession(input.sessionId);
    // A repeated register that would change nothing gets its own status (not a fresh
    // "Registered" that reads as if something happened): the keys differ across deliberate
    // invocations, so key-idempotency can't catch this — it is VALUE-level feedback. No
    // write either, so updatedAtMs honestly reflects the last real change. A re-register
    // that supplies a NEW label falls through: that is a genuine update.
    if (existing !== undefined && (input.label === undefined || input.label === existing.label)) {
      return { ok: true, status: 'already_registered', session: interactiveView(existing) };
    }
    const now = this.clock();
    // Best-effort attribution: tag with the live account, but never let a switch-engine read
    // failure block registration (observability plumbing must not depend on the vault).
    const activeId =
      existing?.accountId ?? (await this.switchEngine.getActiveId().catch(() => null)) ?? undefined;
    const label = input.label ?? existing?.label;
    const tracked: TrackedInteractiveSession = {
      id: input.sessionId,
      kind: INTERACTIVE_SESSION_KIND,
      state: 'active',
      // Registering implies streaming; but never downgrade a prior explicit `watch: false`.
      watch: existing?.watch ?? true,
      registeredAtMs: existing?.registeredAtMs ?? now,
      updatedAtMs: now,
      ...(label !== undefined ? { label } : {}),
      ...(activeId !== undefined ? { accountId: activeId } : {}),
    };
    this.writeInteractiveSession(tracked);
    this.rememberSessionCmdKey(input.idempotencyKey);
    return { ok: true, status: 'applied', session: interactiveView(tracked) };
  }

  /**
   * Resolve a label/watch/unregister ref (also used for prompt.inject's sessionId) against the
   * interactive registry. An exact id match wins outright — a label can never shadow a real id,
   * so this checks {@link readInteractiveSession} FIRST and only falls back to a label scan when
   * that misses. The scan is case-sensitive exact match against every interactive row (corrupt
   * rows are skipped, never fatal — same tolerance as readInteractiveSession). Zero label
   * matches is 'none' (the caller's existing not-registered path); more than one is 'ambiguous'
   * (never guess which session the operator meant); exactly one is 'resolved'. Register is
   * deliberately NOT a caller of this — its sessionId creates the row and must be the real id.
   */
  private resolveInteractiveRef(ref: string): InteractiveRefResolution {
    const byId = this.readInteractiveSession(ref);
    if (byId !== undefined) return { outcome: 'resolved', tracked: byId };

    const matches: TrackedInteractiveSession[] = [];
    for (const row of this.store.listSessions()) {
      if (row.kind !== INTERACTIVE_SESSION_KIND) continue;
      let parsed: TrackedInteractiveSession;
      try {
        parsed = JSON.parse(row.json) as TrackedInteractiveSession;
      } catch {
        continue;
      }
      if (parsed.label === ref) matches.push(parsed);
    }
    // Destructuring (rather than indexing matches[0]) keeps this correct under
    // noUncheckedIndexedAccess without an unreachable branch.
    const [tracked, ...rest] = matches;
    if (tracked === undefined) return { outcome: 'none' };
    if (rest.length > 0) return { outcome: 'ambiguous', matches };
    return { outcome: 'resolved', tracked };
  }

  /** The shared "which sessions did that label match" wording for {@link resolveInteractiveRef}'s
   *  ambiguous outcome — used identically by the CLI-command failure result and the
   *  prompt.inject error envelope, so an operator sees the same explanation either way. */
  private ambiguousLabelMessage(ref: string, matches: TrackedInteractiveSession[]): string {
    const ids = matches.map((m) => m.id).join(', ');
    return `label '${ref}' matches ${matches.length} sessions: ${ids} — use the session id`;
  }

  /** The `ambiguous_label` failure shape for label/watch/unregister. */
  private ambiguousLabelResult(
    ref: string,
    matches: TrackedInteractiveSession[],
  ): SessionCommandResult {
    return {
      ok: false,
      code: 'ambiguous_label',
      message: this.ambiguousLabelMessage(ref, matches),
    };
  }

  /** Name a registered interactive session. 404 (`unknown_session`) if it was never registered
   *  — register is the deliberate gateway, which also gives the CLI a clean, testable failure.
   *  `input.sessionId` may be the real id or a registered label — see resolveInteractiveRef. */
  private labelSession(input: SessionLabelInput): SessionCommandResult {
    if (this.seenSessionCmdKeys.has(input.idempotencyKey)) {
      const current = this.readInteractiveSession(input.sessionId);
      return {
        ok: true,
        status: 'already_handled',
        session: current ? interactiveView(current) : minimalInteractiveView(input.sessionId),
      };
    }
    const resolution = this.resolveInteractiveRef(input.sessionId);
    if (resolution.outcome === 'ambiguous') {
      return this.ambiguousLabelResult(input.sessionId, resolution.matches);
    }
    if (resolution.outcome === 'none') return this.notRegistered(input.sessionId);
    const tracked: TrackedInteractiveSession = {
      ...resolution.tracked,
      label: input.label,
      updatedAtMs: this.clock(),
    };
    this.writeInteractiveSession(tracked);
    this.rememberSessionCmdKey(input.idempotencyKey);
    return { ok: true, status: 'applied', session: interactiveView(tracked) };
  }

  /** Set the per-session Discord-streaming opt-in on a registered interactive session.
   *
   * DELIBERATELY records-only: it does NOT gate the daemon's hook stream on this flag. The daemon
   * streams every session's hook notifications unconditionally; auto-filtering (a SessionStart
   * hook auto-registering sessions, then streaming only watched ones) comes later.
   * Gating here now would silence cards for every not-yet-registered session — a regression.
   * So this ships the control surface (persisted + shown in `cctl session status`) that
   * the future filter will consult, without changing what streams today. 404 if not registered.
   * `input.sessionId` may be the real id or a registered label — see resolveInteractiveRef. */
  private watchSession(input: SessionWatchInput): SessionCommandResult {
    if (this.seenSessionCmdKeys.has(input.idempotencyKey)) {
      const current = this.readInteractiveSession(input.sessionId);
      return {
        ok: true,
        status: 'already_handled',
        session: current ? interactiveView(current) : minimalInteractiveView(input.sessionId),
      };
    }
    const resolution = this.resolveInteractiveRef(input.sessionId);
    if (resolution.outcome === 'ambiguous') {
      return this.ambiguousLabelResult(input.sessionId, resolution.matches);
    }
    if (resolution.outcome === 'none') return this.notRegistered(input.sessionId);
    const tracked: TrackedInteractiveSession = {
      ...resolution.tracked,
      watch: input.watch,
      updatedAtMs: this.clock(),
    };
    this.writeInteractiveSession(tracked);
    this.rememberSessionCmdKey(input.idempotencyKey);
    return { ok: true, status: 'applied', session: interactiveView(tracked) };
  }

  /** Drop a registered interactive session from tracking — the undo for `register`, and the
   *  cleanup path for a registration made with a garbage id (register accepts any string, so
   *  a typo like "67" becomes a row only THIS can remove). 404 (`unknown_session`) if it was
   *  never registered, mirroring label/watch; managed rows are untouchable here (the kind
   *  check in readInteractiveSession keeps them apart). `input.sessionId` may be the real id or
   *  a registered label — see resolveInteractiveRef. */
  private unregisterSession(input: SessionCommandBase): SessionCommandResult {
    if (this.seenSessionCmdKeys.has(input.idempotencyKey)) {
      // Replay of an unregister that already applied: the row is gone, so echo the minimal
      // honest view rather than a 404 that would read as "it never existed".
      return {
        ok: true,
        status: 'already_handled',
        session: minimalInteractiveView(input.sessionId),
      };
    }
    const resolution = this.resolveInteractiveRef(input.sessionId);
    if (resolution.outcome === 'ambiguous') {
      return this.ambiguousLabelResult(input.sessionId, resolution.matches);
    }
    if (resolution.outcome === 'none') return this.notRegistered(input.sessionId);
    const existing = resolution.tracked;
    this.store.deleteSession(existing.id);
    // Queued steering dies with the registration: nothing would ever deliver it (delivery is
    // gated on the registry), and a later re-register must not inherit stale guidance.
    this.pendingSteering.delete(existing.id);
    this.rememberSessionCmdKey(input.idempotencyKey);
    // Echo the view of what was removed so the CLI can confirm WHICH session it just forgot.
    return { ok: true, status: 'applied', session: interactiveView(existing) };
  }

  /** The one 404 body for label/watch/unregister against a session that was never registered. */
  private notRegistered(sessionId: string): SessionCommandResult {
    return {
      ok: false,
      code: 'unknown_session',
      message:
        `session '${sessionId}' is not registered - run \`cctl session register\` ` +
        `(or /cctl:register) in that session first`,
    };
  }

  /** Read a registered interactive session from the Store mirror, or `undefined` if the id is
   *  not an interactive row (or is a corrupt/foreign row — treated as not registered so a
   *  re-register heals it). Never a managed row: managed and interactive share the table but
   *  the kind column keeps them apart. */
  private readInteractiveSession(sessionId: string): TrackedInteractiveSession | undefined {
    const row = this.store.getSession(sessionId);
    if (!row || row.kind !== INTERACTIVE_SESSION_KIND) return undefined;
    try {
      return JSON.parse(row.json) as TrackedInteractiveSession;
    } catch {
      return undefined;
    }
  }

  /** Upsert an interactive session into the display-only Store table. */
  private writeInteractiveSession(tracked: TrackedInteractiveSession): void {
    this.store.upsertSession({
      id: tracked.id,
      kind: tracked.kind,
      state: tracked.state,
      accountId: tracked.accountId ?? null,
      json: JSON.stringify(tracked),
      updatedAtMs: tracked.updatedAtMs,
    });
  }

  /** Remember a `cctl session register|label|watch` idempotencyKey. */
  private rememberSessionCmdKey(key: string): void {
    rememberBounded(this.seenSessionCmdKeys, key, MAX_SEEN_SESSION_CMD_KEYS);
  }

  /** Mirror a managed session's state transition into the display-only Store table (kind
   *  'managed'), so `cctl session status` shows phone-spawned sessions alongside interactive
   *  ones. Pulls the richer SessionRecord from the manager when available (resumeId/cwd/summary),
   *  else writes a minimal snapshot from what the event carried. Best-effort: a serialize/write
   *  failure here must not break live envelope forwarding, so it is swallowed (the next
   *  transition rewrites the row; the table is observability, never authoritative — store.ts). */
  private mirrorManagedSession(
    sessionId: string,
    accountId: string | undefined,
    state: string,
  ): void {
    try {
      const record = this.sessionManager.list().find((r) => r.id === sessionId);
      const json = record ?? {
        id: sessionId,
        kind: 'managed',
        state,
        ...(accountId !== undefined ? { accountId } : {}),
      };
      this.store.upsertSession({
        id: sessionId,
        kind: 'managed',
        state,
        accountId: accountId ?? record?.accountId ?? null,
        json: JSON.stringify(json),
        updatedAtMs: this.clock(),
      });
    } catch (err) {
      this.logger.warn(
        { err, sessionId },
        'failed to mirror managed session to store (display only)',
      );
    }
  }

  // ---- outbound ----

  private sendEnvelope(draft: EnvelopeDraftSansDaemonId): void {
    const daemonId = this.controlPlaneClient.getIdentity()?.daemonId ?? 'unknown';
    this.controlPlaneClient.send({ ...draft, daemonId });
  }
}

// ---------------------------------------------------------------------------
// Quarantine-notice edge detection (pure, so it is testable without poll cycles)
// ---------------------------------------------------------------------------

/** Per-account bookkeeping carried between poll cycles to detect quarantine transitions and
 *  debounce repeat pushes. */
export interface QuarantineNoticeState {
  quarantined: boolean;
  /** Epoch ms of the last notice pushed for this account; 0 = none yet. */
  lastNoticeAtMs: number;
}

/** One quarantine-notice to push. */
export interface QuarantineNotice {
  accountId: string;
  label: string;
}

/**
 * Decide which accounts should get a quarantine push this cycle and compute the state to carry
 * forward. Pure (no IO, no clock read) so the tricky edge + debounce logic can be unit-tested
 * directly instead of by orchestrating multiple live poll cycles.
 *
 * Rules (quarantine + guided re-login, plus a restart-storm guard):
 *   - Fire ONLY on a false→true transition THIS process observed. An account already
 *     quarantined at first sight (no prior state) is recorded SILENTLY — its standing state is
 *     already carried on every usage snapshot's advisory, and re-alerting on every daemon
 *     restart (the state resets in-memory) would storm the phone.
 *   - Suppress a repeat push within `debounceMs` of the last one for that account, so a refresh
 *     that flaps in and out of quarantine can't spam.
 */
export function reconcileQuarantineNotices(
  accounts: { accountId: string; label: string; quarantined: boolean }[],
  prevState: Map<string, QuarantineNoticeState>,
  nowMs: number,
  debounceMs: number,
): { notices: QuarantineNotice[]; nextState: Map<string, QuarantineNoticeState> } {
  const notices: QuarantineNotice[] = [];
  const nextState = new Map<string, QuarantineNoticeState>(prevState);

  for (const account of accounts) {
    const prev = prevState.get(account.accountId);

    // First observation this run: record silently (see restart-storm rule above).
    if (prev === undefined) {
      nextState.set(account.accountId, {
        quarantined: account.quarantined,
        lastNoticeAtMs: 0,
      });
      continue;
    }

    const enteringQuarantine = account.quarantined && !prev.quarantined;
    // `lastNoticeAtMs === 0` means "never pushed a notice for this account" — that must NEVER
    // be debounced (otherwise the first transition is silently swallowed whenever the clock is
    // still below the debounce window). Only a REAL prior notice starts the debounce timer.
    const outsideDebounce = prev.lastNoticeAtMs === 0 || nowMs - prev.lastNoticeAtMs >= debounceMs;
    if (enteringQuarantine && outsideDebounce) {
      notices.push({ accountId: account.accountId, label: account.label });
      nextState.set(account.accountId, { quarantined: true, lastNoticeAtMs: nowMs });
    } else {
      // Track the current flag but PRESERVE lastNoticeAtMs, so the debounce window spans a flap
      // that clears and re-triggers quickly.
      nextState.set(account.accountId, {
        quarantined: account.quarantined,
        lastNoticeAtMs: prev.lastNoticeAtMs,
      });
    }
  }

  return { notices, nextState };
}
