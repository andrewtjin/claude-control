// Eager activation probe: spend ONE cheap headless turn on a vaulted account so Anthropic
// starts publishing its usage windows.
//
// THE GAP. Auto-switch can only choose a target whose weekly clock it can resolve
// (`decideAutoSwitch` drops any account whose weekly reset is unknown — an unknown clock is not
// a lesser candidate, it is not a candidate at all). The endpoint publishes a weekly reset only
// for accounts that have been USED: a freshly vaulted account that has never run a turn reports
// no weekly limit and no reset, and history-based prediction cannot rescue it either — there is
// no history to advance. So the accounts holding a full untouched allowance are precisely the
// ones the fleet can never reach, and nothing but real usage closes that loop.
//
// WHAT IT DOES. For one such account: refresh its token IN THE VAULT (never activating it),
// seed a throwaway `CLAUDE_CONFIG_DIR` with those credentials, run a single trivial turn bound
// to that dir, harvest whatever the CLI rotated back into the vault, and delete the dir. The
// live login is never touched — this is the whole reason the turn runs in its own config dir
// rather than through `activate()`.
//
// THE NON-NEGOTIABLE INVARIANT is the harvest. Refresh tokens are single-use: if the CLI
// rotates the seeded token inside the throwaway dir and we delete the dir without reading it
// back, the vault is left holding a spent token and the account is dead until a manual
// re-login. The harvest therefore runs in a `finally`, on EVERY path — success, SDK failure,
// timeout — and its own failure is what decides the probe failed, whatever the turn did.
//
// SAFETY RAILS. One probe in flight at a time; a per-account floor with failure backoff so a
// broken account cannot be re-probed in a loop; and two rails enforced by the engine call this
// module already makes rather than by a duplicated copy of the caller's filter — `refreshToken`
// reports `active_account` for the live account (whose single-use token is shared with the
// running CLI, so spending it here would strand the live session) and throws for a quarantined
// one. Auto-switch EXCLUSION is a policy fact the engine cannot see; the caller filters it,
// because an excluded account is one nothing should spend quota on.

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CredentialStore,
  isOverloadCode,
  LockTimeoutError,
  noopLogger,
  RefreshError,
  type ClaudeOauth,
  type CredentialBundle,
  type Logger,
  type RefreshTokenResult,
  type ReloginResult,
} from '@claude-control/switch-engine';
import type { AgentSdkClient } from '@claude-control/session-runtime';

/** The turn's whole content. It exists to be BILLED, not read — the shortest prompt that still
 *  provokes a real model call is the cheapest way to open a usage window. */
export const PROBE_PROMPT = 'Reply with exactly: OK';

/** The smallest model there is. The probe needs a turn to have HAPPENED; the answer is
 *  discarded, so paying Opus rates for it would be pure waste. Pinned rather than left to the
 *  CLI default because the default tracks whatever the operator codes with, which is the
 *  expensive end. A model an account's plan refuses fails the probe loudly (backoff + a warn
 *  line) instead of silently — the alternative, sending no model at all, would hide it. */
export const PROBE_MODEL = 'claude-haiku-4-5';

/** Hard ceiling on one probe turn. The SDK spawns a CLI subprocess that can hang on a stalled
 *  socket; the poll cycle this runs under must not. Generous enough for a cold subprocess
 *  start on a loaded machine. */
export const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

/** Floor between probe attempts for ONE account. Matches the poller's refresh floor: both
 *  govern how often background machinery may spend a single-use token on one account. */
export const PROBE_COOLDOWN_MS = 60 * 60_000;

/** Cap on the failure backoff (1h, 2h, 4h … capped at a day). A day is the right ceiling: an
 *  account this keeps failing on needs a human, and re-asking more often than daily buys
 *  nothing. */
export const PROBE_BACKOFF_CAP_MS = 24 * 60 * 60_000;

/** How long to keep re-attempting the throwaway dir's delete. Windows refuses to unlink a file
 *  a just-exited `claude` (or a grandchild) still holds open, and the dir holds real
 *  credentials — so the delete retries against a wall clock rather than giving up on the first
 *  EPERM. Same race, and same budget, the CLI's capture dirs contend with. */
const DELETE_BUDGET_MS = 8_000;
const DELETE_RETRY_STEP_MS = 250;
const DELETE_RETRY_CAP_MS = 1_000;

/** An account the caller believes has no resolvable weekly clock. Identity only — every fact
 *  the probe REFUSES on is read from the engine, not taken on trust from here. */
export interface ProbeCandidate {
  accountId: string;
  label: string;
}

/** The engine capabilities a probe needs. `SwitchEngine` satisfies this structurally, so the
 *  daemon wires the real one straight through and tests inject a fake. */
export interface ProbeEngine {
  /** Refresh the account's token in the VAULT without activating it. */
  refreshToken(accountId: string): Promise<RefreshTokenResult>;
  /** Fold credentials found in a config dir back into the account's vault bundle, under the
   *  credential lock. This is the harvest: the same locked, identity-guarded, in-place write
   *  a host re-login performs, which is exactly what a rotated token needs.
   *  `expectedRefreshToken` is the token the probe saw in the vault before it started the turn —
   *  passed through so the engine can refuse to overwrite a bundle someone else has since
   *  updated, rather than clobbering it with this probe's now-stale capture. */
  reloginFromConfigDir(
    accountId: string,
    configDir: string,
    expectedRefreshToken?: string,
  ): Promise<ReloginResult>;
}

/** The vault read that seeds the throwaway dir. Narrow on purpose — a probe must never be able
 *  to WRITE the vault except through the engine's locked path above. */
export interface ProbeVault {
  readBundle(accountId: string): Promise<CredentialBundle>;
}

export interface AccountProbeOptions {
  vault: ProbeVault;
  engine: ProbeEngine;
  /** Parent directory the throwaway config dirs are created under (created on demand). */
  configDirRoot: string;
  /** Build a ONE-SHOT SDK client bound to `configDir` — production passes
   *  `createAgentSdkClient({ configDirForAccount: () => configDir })`. Injected so this module
   *  never imports the live SDK boundary, and so tests never spawn a Claude Code subprocess. */
  createClient: (configDir: string) => AgentSdkClient;
  /** Working directory for the turn. Defaults to the throwaway dir itself, which keeps a
   *  probe from reading whatever repository the daemon happens to have been started in. */
  cwd?: string;
  timeoutMs?: number;
  cooldownMs?: number;
  backoffCapMs?: number;
  clock?: () => number;
  logger?: Logger;
}

/** Per-account attempt bookkeeping, in memory (a daemon restart resets it — worst case one
 *  extra probe per account, still bounded by the floor). Mirrors the poll token getter's
 *  state: same floor-plus-doubling shape, same blameless exemptions. */
interface ProbeAttemptState {
  nextAttemptAtMs: number;
  consecutiveFailures: number;
}

export class AccountProbe {
  private readonly vault: ProbeVault;
  private readonly engine: ProbeEngine;
  private readonly configDirRoot: string;
  private readonly createClient: (configDir: string) => AgentSdkClient;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly backoffCapMs: number;
  private readonly clock: () => number;
  private readonly logger: Logger;

  private readonly state = new Map<string, ProbeAttemptState>();
  /** One probe in flight at a time, fleet-wide: each one spends a real turn and holds the
   *  credential lock twice, and nothing is gained by racing two. */
  private inFlight = false;

  constructor(options: AccountProbeOptions) {
    this.vault = options.vault;
    this.engine = options.engine;
    this.configDirRoot = options.configDirRoot;
    this.createClient = options.createClient;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.cooldownMs = options.cooldownMs ?? PROBE_COOLDOWN_MS;
    this.backoffCapMs = options.backoffCapMs ?? PROBE_BACKOFF_CAP_MS;
    this.clock = options.clock ?? Date.now;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Probe at most ONE of `candidates` — the first that is past its cooldown — and resolve with
   * the ids whose probe succeeded (empty when nothing was eligible or the attempt failed).
   *
   * NEVER THROWS: this runs inside the poll cycle, and an account that cannot be activated is
   * a fact about that account, not a reason to take down polling for the whole fleet. The
   * caller acts on the returned ids (re-polling them immediately, so the window this just
   * opened is visible before the next floor elapses) and needs nothing else from us.
   */
  async probeUnknown(candidates: ProbeCandidate[]): Promise<string[]> {
    if (this.inFlight) return [];
    const now = this.clock();
    const candidate = candidates.find((c) => this.isDue(c.accountId, now));
    if (candidate === undefined) return [];

    this.inFlight = true;
    // Stamped BEFORE the attempt, so a probe that throws its way out still spends its slot.
    this.state.set(candidate.accountId, {
      nextAttemptAtMs: now + this.cooldownMs,
      consecutiveFailures: this.state.get(candidate.accountId)?.consecutiveFailures ?? 0,
    });
    try {
      await this.probeOne(candidate);
      // A success that does not actually open the window is self-limiting rather than
      // self-correcting: the account stays a candidate and is re-probed no sooner than the
      // floor. The normal case removes it from the candidate set entirely on the next poll.
      this.state.set(candidate.accountId, {
        nextAttemptAtMs: this.clock() + this.cooldownMs,
        consecutiveFailures: 0,
      });
      this.logger.info(
        { accountId: candidate.accountId, label: candidate.label },
        'activation probe opened an unknown account usage window',
      );
      return [candidate.accountId];
    } catch (err) {
      this.recordFailure(candidate, err);
      return [];
    } finally {
      this.inFlight = false;
    }
  }

  /** Whether an account may be probed now. An account never probed has no state and is due. */
  private isDue(accountId: string, now: number): boolean {
    const prior = this.state.get(accountId);
    return prior === undefined || now >= prior.nextAttemptAtMs;
  }

  /**
   * Grow the backoff for a failed attempt, with the same blameless exemption the poll token
   * getter applies: an OVERLOADED endpoint and a LOCK TIMEOUT are both non-evidence about THIS
   * account (the second is usually caused by our own concurrent refresh winning the lock), so
   * neither may push an account toward the day-long ceiling. The counter is then left exactly
   * where it was and the next attempt lands on the plain floor.
   */
  private recordFailure(candidate: ProbeCandidate, err: unknown): void {
    const blameless =
      (err instanceof RefreshError && isOverloadCode(err.code)) || err instanceof LockTimeoutError;
    const priorFailures = this.state.get(candidate.accountId)?.consecutiveFailures ?? 0;
    const consecutiveFailures = blameless ? priorFailures : priorFailures + 1;
    const backoffMs = blameless
      ? this.cooldownMs
      : Math.min(this.cooldownMs * 2 ** (consecutiveFailures - 1), this.backoffCapMs);
    this.state.set(candidate.accountId, {
      nextAttemptAtMs: this.clock() + backoffMs,
      consecutiveFailures,
    });
    this.logger.warn(
      { accountId: candidate.accountId, label: candidate.label, err, consecutiveFailures },
      'activation probe failed',
    );
  }

  /** The probe proper. Throws on any failure; the caller turns that into backoff. */
  private async probeOne(candidate: ProbeCandidate): Promise<void> {
    const { accountId } = candidate;
    // Refresh FIRST, and read the bundle after: a probe that seeds an already-expired access
    // token spends a subprocess start to be told it is unauthenticated. `refreshToken` skips
    // the network entirely when the token is still fresh, so the common case costs one lock.
    const refresh = await this.engine.refreshToken(accountId);
    if (refresh.skippedReason === 'active_account') {
      // The live account's refresh token is the same single-use token the running CLI holds.
      // Copying it into a throwaway dir and letting a second CLI rotate it there is exactly
      // how a live session gets stranded — refuse rather than trust the caller's filter.
      throw new Error('refusing to probe the account that is currently live');
    }

    const bundle = await this.vault.readBundle(accountId);
    const dir = join(this.configDirRoot, `probe-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try {
      await this.seed(dir, bundle);
      await this.runTurn(dir, accountId);
    } finally {
      // Both of these run however the turn ended, and in this order: the harvest reads the dir
      // the discard is about to delete. `harvest` owns its own failure reporting and rethrows,
      // which is what makes a lost rotation fail the probe even after a clean turn.
      try {
        await this.harvest(dir, accountId, bundle.claudeAiOauth);
      } finally {
        await this.discard(dir);
      }
    }
  }

  /** Write the account's credentials into the throwaway dir — the SAME surgical writer
   *  `activate()` uses for the live files, pointed at this dir instead. */
  private async seed(dir: string, bundle: CredentialBundle): Promise<void> {
    const store = this.transientStore(dir);
    await store.writeLiveCredentials(bundle.claudeAiOauth);
    // Identity too, when the account has one: `reloginFromConfigDir` reads it back to prove the
    // dir still describes THIS account before it overwrites the vault bundle, and a dir with no
    // identity block leaves that guard structurally unable to run.
    if (bundle.oauthAccount) await store.writeOauthAccount(bundle.oauthAccount);
  }

  /**
   * Read the throwaway dir back and, if the CLI rotated the token in there, fold it into the
   * vault through the engine's locked in-place path. A dir whose token is unchanged needs no
   * write at all — the vault already holds exactly what is on disk.
   *
   * Every failure here rethrows. A rotation we saw but could not persist means the vault's copy
   * is spent, so the probe is a failure no matter how the turn went, and the account must back
   * off rather than be handed to auto-switch as freshly usable.
   */
  private async harvest(dir: string, accountId: string, seeded: ClaudeOauth): Promise<void> {
    let after: ClaudeOauth | undefined;
    try {
      after = await this.transientStore(dir).readLiveCredentials();
    } catch (err) {
      throw new Error(
        `could not read back the probe credentials (a rotated token may be lost): ${reason(err)}`,
        { cause: err },
      );
    }
    // `undefined` here is not "nothing changed" — it means the dir has no usable credentials at
    // all (ENOENT, or a structurally-invalid claudeAiOauth block; readLiveCredentials returns
    // undefined for both without throwing). The seeded token is single-use, so if the CLI
    // consumed it and then failed to leave a readable replacement, the vault's copy is already
    // spent even though nothing here threw. Treat that the same as a rotation we could not
    // persist, not as a clean no-op.
    if (after === undefined) {
      throw new Error(
        'probe turn left no readable credentials in the throwaway dir; the seeded token may be spent',
      );
    }
    if (after.refreshToken === seeded.refreshToken) return;
    try {
      // Pass the seeded (pre-turn) token so the engine can detect a vault bundle that moved on
      // while this turn was running and refuse to clobber it — see reloginFromConfigDir's doc.
      await this.engine.reloginFromConfigDir(accountId, dir, seeded.refreshToken);
      this.logger.info({ accountId }, 'activation probe rotated the token; vault updated');
    } catch (err) {
      this.logger.error(
        { accountId, err },
        'activation probe could not persist a rotated token; the vault copy is now spent - ' +
          'this account needs a re-login',
      );
      throw err;
    }
  }

  /** Run the one turn, bound to `dir`, under a hard deadline. */
  private async runTurn(dir: string, accountId: string): Promise<void> {
    const client = this.createClient(dir);
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe turn exceeded ${this.timeoutMs}ms`)),
          this.timeoutMs,
        );
      });
      const turn = this.drainTurn(client, dir, accountId);
      // The loser of the race stays pending. A turn that fails on its own AFTER the deadline
      // already decided the outcome would otherwise surface as an unhandled rejection, so its
      // (by then irrelevant) failure is absorbed here rather than left dangling.
      turn.catch(() => {});
      await Promise.race([turn, deadline]);
    } finally {
      clearTimeout(timer);
      // Tear the subprocess down on every path, including the timeout — an abandoned CLI would
      // both keep spending and keep a handle inside the dir the discard is about to delete.
      // Best-effort: a client that is already finished has nothing to interrupt.
      await client.interrupt().catch(() => {});
      await client.end().catch(() => {});
    }
  }

  /** Consume the turn's events, translating a failed turn into a thrown error. */
  private async drainTurn(client: AgentSdkClient, dir: string, accountId: string): Promise<void> {
    let failure: string | undefined;
    let sawResult = false;
    for await (const event of client.query(PROBE_PROMPT, {
      accountId,
      cwd: this.cwd ?? dir,
      model: PROBE_MODEL,
      maxTurns: 1,
      // No tools, and a mode that DENIES rather than prompts. A prompting mode would park the
      // first tool call on `canUseTool` with nobody to answer it, turning a two-second probe
      // into a full timeout.
      allowedTools: [],
      permissionMode: 'dontAsk',
    })) {
      if (event.type === 'error') failure ??= event.message;
      else if (event.type === 'turn_result') {
        sawResult = true;
        if (!event.ok) failure ??= event.summary;
      }
    }
    if (failure !== undefined) throw new Error(`probe turn failed: ${failure}`);
    // A stream that ends without a result never reached the API, so nothing opened a window.
    if (!sawResult) throw new Error('probe turn ended without a result');
  }

  /**
   * Delete the throwaway dir. Never throws: by the time this runs the probe has already
   * succeeded or failed on its own terms, and a directory that lost a handle race must not
   * rewrite that verdict. It IS security-relevant though — the dir holds a real
   * `.credentials.json` — so a loss is logged at warn rather than swallowed, and the retry runs
   * against a wall clock (Node's own `maxRetries` retries per tree level, so its total wait
   * compounds with depth and cannot be bounded from here).
   */
  private async discard(dir: string): Promise<void> {
    const deadline = this.clock() + DELETE_BUDGET_MS;
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        lastError = err;
        if (this.clock() >= deadline) break;
        await sleep(Math.min(DELETE_RETRY_STEP_MS * 2 ** attempt, DELETE_RETRY_CAP_MS));
      }
    }
    this.logger.warn(
      { dir, err: lastError },
      'could not delete the probe config dir; it still holds credentials',
    );
  }

  /** A `CredentialStore` whose live files ARE the throwaway dir's. `vaultDir` is part of the
   *  `Paths` shape but never read by this store (it only touches the two paths above), so the
   *  dir itself stands in rather than dragging the real vault path through this module. */
  private transientStore(dir: string): CredentialStore {
    return new CredentialStore({
      claudeDir: dir,
      credentialsPath: join(dir, '.credentials.json'),
      claudeJsonPath: join(dir, '.claude.json'),
      vaultDir: dir,
    });
  }
}

/** A thrown value reduced to one loggable line. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
