// The Daemon: composes every subsystem into the running per-user background process.
//
// This file is deliberately thin — the actual logic (parsing, polling/backoff, the security
// contract on permission resolution, outbox buffering, hook merging) lives in and is tested
// by each subsystem's own module. What's tested HERE is composition: on `start()`, recovery
// runs, the poller and hook receiver come up, the control-plane client connects, and inbound
// protocol messages are wired to the right collaborator. Every collaborator is accepted
// pre-built (dependency injection) so a lifecycle test can fake all of them.

import type { RecoverResult, ActivateResult, StoredAccount } from '@claude-control/switch-engine';
import { resolveAccountRef } from '@claude-control/switch-engine';
import type { SessionManager } from '@claude-control/session-runtime';
import { createAgentSdkClient as defaultCreateAgentSdkClient } from '@claude-control/session-runtime';
import type { AgentSdkClient } from '@claude-control/session-runtime';
import type { SessionEvent } from '@claude-control/session-runtime';
import { type Logger, noopLogger } from '@claude-control/switch-engine';
import type { EnvelopeDraft, MessageOf } from '@claude-control/shared-protocol';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import type { Store } from './store.js';
import { UsagePoller, type PollAccount } from './usagePoller.js';
import type { AttributionJournal } from './attributionJournal.js';
import type { HookReceiver } from './hookReceiver.js';
import { ControlPlaneClient } from './controlPlaneClient.js';

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
  /** WET-GATED real Agent SDK adapter, overridable so tests never touch a real SDK. */
  createAgentSdkClient?: () => AgentSdkClient;
  /** Self-heal the CLI's hook config on startup. Called AFTER the hook receiver binds, with
   *  its actual loopback port, so it can (re)install the curl hooks that POST to that port.
   *  Injected — the composition root owns WHERE settings.json lives and which profile is
   *  targeted (see daemonRun.ts) — and optional so lifecycle tests and the pre-M3 path can
   *  omit it. Its rejection must NEVER crash startup: settings.json can be read-only or locked,
   *  and hooks are additive, not load-bearing for the daemon's own liveness. */
  installHooks?: (port: number) => Promise<void>;
  /** Injectable clock (house convention: no fake timers). Only used for the quarantine-notice
   *  debounce; defaults to `Date.now`. */
  clock?: () => number;
  /** Minimum gap between repeat quarantine-notice pushes for the SAME account, so an account
   *  whose refresh flaps in and out of quarantine can't spam the phone. */
  quarantineNoticeDebounceMs?: number;
  /** How often to poll usage and re-sync attribution. */
  pollIntervalMs?: number;
  logger?: Logger;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** 30 minutes: re-login is a minutes-long human action on the PC, so nagging more often than
 *  ~twice an hour for the same still-broken account is pure noise. */
const DEFAULT_QUARANTINE_NOTICE_DEBOUNCE_MS = 30 * 60_000;

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
  private readonly createAgentSdkClient: () => AgentSdkClient;
  private readonly installHooks: ((port: number) => Promise<void>) | undefined;
  private readonly clock: () => number;
  private readonly quarantineNoticeDebounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Next `session.output.seq` to use per session — the protocol requires a monotonic
   *  per-session sequence so the phone can detect drops/reordering. */
  private readonly outputSeq = new Map<string, number>();
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
    this.createAgentSdkClient = options.createAgentSdkClient ?? defaultCreateAgentSdkClient;
    this.installHooks = options.installHooks;
    this.clock = options.clock ?? Date.now;
    this.quarantineNoticeDebounceMs =
      options.quarantineNoticeDebounceMs ?? DEFAULT_QUARANTINE_NOTICE_DEBOUNCE_MS;
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

    const recovery = await this.switchEngine.recover();
    if (recovery.recovered) {
      this.logger.info({ recovery }, 'switch engine recovery ran on daemon startup');
    }

    const hookPort = await this.hookReceiver.listen(0);

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
    });

    await this.controlPlaneClient.connect();

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
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.controlPlaneClient.close();
    await this.hookReceiver.close();
    this.store.close();
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

  private handlePermissionResponse(msg: MessageOf<'permission.response'>): void {
    const { requestId, decision } = msg.payload;
    const result = this.hookReceiver.resolvePermission(requestId, decision);
    if (!result.ok) {
      // Exactly the security contract's job: a stale/forged/duplicate response is logged and
      // dropped, never applied. This is not an error in the daemon — it's the guard working.
      this.logger.warn({ requestId, error: result.error }, 'rejected permission.response');
    }
  }

  private async handlePromptInject(msg: MessageOf<'prompt.inject'>): Promise<void> {
    const { sessionId, text } = msg.payload;
    const handle = this.sessionManager.get(sessionId);
    if (!handle) {
      this.logger.warn({ sessionId }, 'prompt.inject for unknown/inactive session');
      return;
    }
    await handle.send(text);
  }

  private async handleSessionSpawn(msg: MessageOf<'session.spawn'>): Promise<void> {
    const { prompt, resumeSessionId, cwd, accountId } = msg.payload;
    const client = this.createAgentSdkClient();
    const handle = await this.sessionManager.spawnManaged({
      client,
      prompt,
      ...(resumeSessionId !== undefined && resumeSessionId !== null ? { resumeSessionId } : {}),
      ...(cwd !== undefined && cwd !== null ? { cwd } : {}),
      ...(accountId !== undefined && accountId !== null ? { accountId } : {}),
    });

    handle.onEvent((event) => {
      this.forwardSessionEvent(handle.id, accountId ?? undefined, event);
    });
  }

  /** Translate a session backend's own event vocabulary into wire envelopes for the phone. */
  private forwardSessionEvent(
    sessionId: string,
    accountId: string | undefined,
    event: SessionEvent,
  ): void {
    if (event.kind === 'status') {
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
      payload: { sessionId, seq, kind, text: event.text, truncated: false },
    });
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
 * Rules (plan §4 "quarantine + guided re-login", plus a restart-storm guard):
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
