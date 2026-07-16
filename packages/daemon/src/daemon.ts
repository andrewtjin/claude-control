// The Daemon: composes every subsystem into the running per-user background process.
//
// This file is deliberately thin — the actual logic (parsing, polling/backoff, the security
// contract on permission resolution, outbox buffering, hook merging) lives in and is tested
// by each subsystem's own module. What's tested HERE is composition: on `start()`, recovery
// runs, the poller and hook receiver come up, the control-plane client connects, and inbound
// protocol messages are wired to the right collaborator. Every collaborator is accepted
// pre-built (dependency injection) so a lifecycle test can fake all of them.

import type { RecoverResult, ActivateResult, StoredAccount } from '@claude-control/switch-engine';
import type { SessionManager } from '@claude-control/session-runtime';
import { createAgentSdkClient as defaultCreateAgentSdkClient } from '@claude-control/session-runtime';
import type { AgentSdkClient } from '@claude-control/session-runtime';
import type { SessionEvent } from '@claude-control/session-runtime';
import { type Logger, noopLogger } from '@claude-control/switch-engine';
import type { EnvelopeDraft, MessageOf } from '@claude-control/shared-protocol';
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

export interface DaemonOptions {
  store: Store;
  switchEngine: SwitchEngineLike;
  sessionManager: SessionManager;
  poller: UsagePoller;
  attributionJournal: AttributionJournal;
  hookReceiver: HookReceiver;
  controlPlaneClient: ControlPlaneClient;
  /** WET-GATED real Agent SDK adapter, overridable so tests never touch a real SDK. */
  createAgentSdkClient?: () => AgentSdkClient;
  /** How often to poll usage and re-sync attribution. */
  pollIntervalMs?: number;
  logger?: Logger;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

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
  private readonly createAgentSdkClient: () => AgentSdkClient;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Next `session.output.seq` to use per session — the protocol requires a monotonic
   *  per-session sequence so the phone can detect drops/reordering. */
  private readonly outputSeq = new Map<string, number>();
  private started = false;

  constructor(options: DaemonOptions) {
    this.store = options.store;
    this.switchEngine = options.switchEngine;
    this.sessionManager = options.sessionManager;
    this.poller = options.poller;
    this.attributionJournal = options.attributionJournal;
    this.hookReceiver = options.hookReceiver;
    this.controlPlaneClient = options.controlPlaneClient;
    this.createAgentSdkClient = options.createAgentSdkClient ?? defaultCreateAgentSdkClient;
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

    await this.hookReceiver.listen(0);

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
  }

  // ---- inbound handlers ----

  private async handleSwitchCommand(msg: MessageOf<'switch.command'>): Promise<void> {
    const { requestId, targetAccountId } = msg.payload;
    try {
      const result = await this.switchEngine.activate(targetAccountId);
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
