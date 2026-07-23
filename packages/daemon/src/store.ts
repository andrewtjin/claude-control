// Thin, typed wrapper over the daemon's local sqlite state.
//
// Every other daemon subsystem (poller, attribution journal, hook receiver, control-plane
// client) reads/writes through this one class rather than touching `node:sqlite` directly —
// that keeps the SQL and the "what shape is a row" narrowing in one place, and lets every
// other module's tests run against a real `:memory:` database instead of a fake.
//
// `node:sqlite` is synchronous end-to-end, so every method here is synchronous too; nothing
// in this file does IO that needs awaiting.

import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface UsageSnapshotRow {
  id: number;
  accountId: string;
  fetchedAtMs: number;
  source: string;
  /** Serialized `AccountUsage` (or the raw poll error context) — the store never parses it. */
  json: string;
}

export interface ActivationIntervalRow {
  id: number;
  accountId: string;
  startedAtMs: number;
  /** `null` while the interval is still open (this account is the currently-active one). */
  endedAtMs: number | null;
}

export interface PendingPermissionRow {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  createdAtMs: number;
  /** Which leg surfaced the request: 'hook' (a CLI hook's held HTTP response — the hook
   *  receiver's resolve path answers it) or 'managed' (an SDK-parked `canUseTool` — ONLY the
   *  daemon process holding the in-memory gate can apply a decision, so the hook receiver
   *  must refuse to resolve these rows; see hookReceiver.resolvePermission). */
  origin: string;
  /** `null` until `resolvePendingPermissionDecision` records an answer. */
  resolvedDecision: string | null;
}

/** A held AskUserQuestion awaiting the phone's answers — the question analog of
 *  {@link PendingPermissionRow}. Deliberately a parallel table rather than a `kind` column on
 *  pending_permissions: a question carries no tool/summary/allow-deny decision, and its
 *  single-resolve guard is a resolved-timestamp rather than a decision string, so folding the
 *  two shapes into one table would mean nullable columns that only ever apply to one kind. The
 *  structured questions + answers themselves never touch the DB — they live on the held HTTP
 *  response (hook leg) or the in-process gate (managed leg); this row is purely the WHERE-guarded
 *  single-resolve + origin bookkeeping. */
export interface PendingQuestionRow {
  requestId: string;
  sessionId: string;
  createdAtMs: number;
  /** Which leg surfaced it: 'hook' (a CLI hook's held HTTP response) or 'managed' (an
   *  SDK-parked question — only the daemon process holding its gate can answer it; the hook
   *  receiver's resolve path refuses these, mirroring pending_permissions). */
  origin: string;
  /** `null` until answered; the epoch-ms of the answer otherwise. The single-resolve guard is a
   *  WHERE `resolvedAtMs IS NULL` on the UPDATE — a question has no allow/deny to record, so a
   *  timestamp both marks it resolved and dates the answer for the audit trail. */
  resolvedAtMs: number | null;
}

export interface SessionRow {
  id: string;
  kind: string;
  state: string;
  accountId: string | null;
  /** Serialized `SessionRecord` — the store never parses it, callers own that shape. */
  json: string;
  updatedAtMs: number;
}

export interface OutboxRow {
  id: number;
  /** Serialized `Envelope` awaiting delivery to the control plane. */
  envelopeJson: string;
  createdAtMs: number;
}

// ---------------------------------------------------------------------------
// Row narrowing
// ---------------------------------------------------------------------------
//
// `node:sqlite` types a row's columns as `SQLOutputValue` (`null | number | bigint | string |
// Uint8Array`). We fully control the schema below, so a column ever showing up as the wrong
// JS type would mean the schema and this file disagreed with each other — a programming
// error, not a runtime condition to swallow. These helpers turn that mismatch into a loud,
// specific throw instead of a silent `as` cast papering over it.

function requireString(row: Record<string, unknown>, col: string): string {
  const value = row[col];
  if (typeof value !== 'string') throw new TypeError(`column "${col}" was not a string`);
  return value;
}

function requireNumber(row: Record<string, unknown>, col: string): number {
  const value = row[col];
  if (typeof value !== 'number') throw new TypeError(`column "${col}" was not a number`);
  return value;
}

function optionalString(row: Record<string, unknown>, col: string): string | null {
  const value = row[col];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`column "${col}" was not a string`);
  return value;
}

function optionalNumber(row: Record<string, unknown>, col: string): number | null {
  const value = row[col];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new TypeError(`column "${col}" was not a number`);
  return value;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  private readonly db: DatabaseSync;

  /** `path` is injectable so tests use `:memory:`; production passes a real file path. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    // WAL keeps commits cheap (no per-commit journal-file create/delete + fsync — the daemon
    // writes on every envelope via the outbox and on every hook event) and lets the CLI's
    // offline readers (`cctl session status`, `usage`) read while the daemon writes. Applied
    // before the DDL so even the first-ever migration commits in WAL. On `:memory:` databases
    // (tests) the pragma is a no-op. synchronous=NORMAL is the documented safe pairing for
    // WAL — a power loss can lose the last commit, never corrupt, and every table here is a
    // cache/mirror/outbox that tolerates exactly that.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
    // Idempotent: every deploy of the daemon calls this on startup against a possibly
    // already-migrated file, so every statement is `IF NOT EXISTS`.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        accountId TEXT NOT NULL,
        fetchedAtMs INTEGER NOT NULL,
        source TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_snapshots_account
        ON usage_snapshots (accountId, fetchedAtMs);

      CREATE TABLE IF NOT EXISTS activation_intervals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        accountId TEXT NOT NULL,
        startedAtMs INTEGER NOT NULL,
        endedAtMs INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_activation_intervals_account
        ON activation_intervals (accountId, startedAtMs);

      CREATE TABLE IF NOT EXISTS pending_permissions (
        requestId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        tool TEXT NOT NULL,
        summary TEXT NOT NULL,
        createdAtMs INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'hook',
        resolvedDecision TEXT
      );

      CREATE TABLE IF NOT EXISTS pending_questions (
        requestId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        createdAtMs INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'hook',
        resolvedAtMs INTEGER
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        accountId TEXT,
        json TEXT NOT NULL,
        updatedAtMs INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        envelopeJson TEXT NOT NULL,
        createdAtMs INTEGER NOT NULL
      );
    `);
    // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a database created
    // before the `origin` column existed must be upgraded here. Legacy rows default to
    // 'hook': the resolve path has always treated every row as hook-originated, so the
    // default preserves exactly the behavior those rows already had — a legacy managed row
    // loses only the new refuse-from-the-wrong-process protection, never its resolvability.
    const pendingPermissionColumns = this.db
      .prepare(`PRAGMA table_info(pending_permissions)`)
      .all();
    if (!pendingPermissionColumns.some((col) => col['name'] === 'origin')) {
      this.db.exec(
        `ALTER TABLE pending_permissions ADD COLUMN origin TEXT NOT NULL DEFAULT 'hook'`,
      );
    }
  }

  // ---- usage_snapshots ----

  private toUsageSnapshotRow(row: Record<string, unknown>): UsageSnapshotRow {
    return {
      id: requireNumber(row, 'id'),
      accountId: requireString(row, 'accountId'),
      fetchedAtMs: requireNumber(row, 'fetchedAtMs'),
      source: requireString(row, 'source'),
      json: requireString(row, 'json'),
    };
  }

  insertUsageSnapshot(row: Omit<UsageSnapshotRow, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO usage_snapshots (accountId, fetchedAtMs, source, json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(row.accountId, row.fetchedAtMs, row.source, row.json);
    return Number(result.lastInsertRowid);
  }

  /** Snapshots for one account (or all, when `accountId` is omitted), newest first. */
  listUsageSnapshots(accountId?: string, limit = 100): UsageSnapshotRow[] {
    const rows =
      accountId === undefined
        ? this.db
            .prepare(`SELECT * FROM usage_snapshots ORDER BY fetchedAtMs DESC LIMIT ?`)
            .all(limit)
        : this.db
            .prepare(
              `SELECT * FROM usage_snapshots WHERE accountId = ? ORDER BY fetchedAtMs DESC LIMIT ?`,
            )
            .all(accountId, limit);
    return rows.map((r) => this.toUsageSnapshotRow(r));
  }

  latestUsageSnapshot(accountId: string): UsageSnapshotRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM usage_snapshots WHERE accountId = ? ORDER BY fetchedAtMs DESC LIMIT 1`,
      )
      .get(accountId);
    return row ? this.toUsageSnapshotRow(row) : undefined;
  }

  // ---- activation_intervals ----

  private toActivationIntervalRow(row: Record<string, unknown>): ActivationIntervalRow {
    return {
      id: requireNumber(row, 'id'),
      accountId: requireString(row, 'accountId'),
      startedAtMs: requireNumber(row, 'startedAtMs'),
      endedAtMs: optionalNumber(row, 'endedAtMs'),
    };
  }

  openActivationInterval(accountId: string, startedAtMs: number): number {
    const result = this.db
      .prepare(
        `INSERT INTO activation_intervals (accountId, startedAtMs, endedAtMs) VALUES (?, ?, NULL)`,
      )
      .run(accountId, startedAtMs);
    return Number(result.lastInsertRowid);
  }

  closeActivationInterval(id: number, endedAtMs: number): void {
    this.db
      .prepare(`UPDATE activation_intervals SET endedAtMs = ? WHERE id = ?`)
      .run(endedAtMs, id);
  }

  /** Close every still-open interval (defensive cleanup — normally there is at most one). */
  closeOpenActivationIntervals(endedAtMs: number): void {
    this.db
      .prepare(`UPDATE activation_intervals SET endedAtMs = ? WHERE endedAtMs IS NULL`)
      .run(endedAtMs);
  }

  /** Replace the ENTIRE activation-interval set with `intervals` (start-ascending). The
   *  attribution journal re-derives all intervals from the whole audit log each sync — an
   *  out-of-order audit timestamp can change earlier intervals, so a tail-append cursor would
   *  corrupt them — and hands the full corrected set here. `node:sqlite` is synchronous and
   *  the daemon is single-threaded, so delete-then-insert with no `await` between is atomic
   *  with respect to any concurrent point-in-time lookup. */
  replaceActivationIntervals(
    intervals: { accountId: string; startedAtMs: number; endedAtMs: number | null }[],
  ): void {
    this.db.exec(`DELETE FROM activation_intervals`);
    const insert = this.db.prepare(
      `INSERT INTO activation_intervals (accountId, startedAtMs, endedAtMs) VALUES (?, ?, ?)`,
    );
    for (const interval of intervals) {
      insert.run(interval.accountId, interval.startedAtMs, interval.endedAtMs);
    }
  }

  getOpenActivationInterval(): ActivationIntervalRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM activation_intervals WHERE endedAtMs IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get();
    return row ? this.toActivationIntervalRow(row) : undefined;
  }

  listActivationIntervals(accountId?: string): ActivationIntervalRow[] {
    const rows =
      accountId === undefined
        ? this.db.prepare(`SELECT * FROM activation_intervals ORDER BY startedAtMs ASC`).all()
        : this.db
            .prepare(
              `SELECT * FROM activation_intervals WHERE accountId = ? ORDER BY startedAtMs ASC`,
            )
            .all(accountId);
    return rows.map((r) => this.toActivationIntervalRow(r));
  }

  /** The interval covering `tsMs`, if any — an open interval (`endedAtMs IS NULL`) covers
   *  every timestamp from its start onward. */
  findActivationIntervalAt(tsMs: number): ActivationIntervalRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM activation_intervals
         WHERE startedAtMs <= ? AND (endedAtMs IS NULL OR endedAtMs > ?)
         ORDER BY startedAtMs DESC LIMIT 1`,
      )
      .get(tsMs, tsMs);
    return row ? this.toActivationIntervalRow(row) : undefined;
  }

  // ---- pending_permissions ----

  private toPendingPermissionRow(row: Record<string, unknown>): PendingPermissionRow {
    return {
      requestId: requireString(row, 'requestId'),
      sessionId: requireString(row, 'sessionId'),
      tool: requireString(row, 'tool'),
      summary: requireString(row, 'summary'),
      createdAtMs: requireNumber(row, 'createdAtMs'),
      origin: requireString(row, 'origin'),
      resolvedDecision: optionalString(row, 'resolvedDecision'),
    };
  }

  insertPendingPermission(row: Omit<PendingPermissionRow, 'resolvedDecision'>): void {
    this.db
      .prepare(
        `INSERT INTO pending_permissions (requestId, sessionId, tool, summary, createdAtMs, origin, resolvedDecision)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(row.requestId, row.sessionId, row.tool, row.summary, row.createdAtMs, row.origin);
  }

  getPendingPermission(requestId: string): PendingPermissionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_permissions WHERE requestId = ?`)
      .get(requestId);
    return row ? this.toPendingPermissionRow(row) : undefined;
  }

  /**
   * Record a decision, but ONLY for a request that is still pending (`resolvedDecision IS
   * NULL`) — the WHERE clause is what makes this atomically reject a double-resolve. Returns
   * the number of rows changed: 1 on success, 0 if the id doesn't exist or was already
   * resolved. Callers (hookReceiver) use that to implement the "unknown/expired id" contract
   * without a separate read-then-write race.
   */
  resolvePendingPermission(requestId: string, decision: string): number {
    const result = this.db
      .prepare(
        `UPDATE pending_permissions SET resolvedDecision = ?
         WHERE requestId = ? AND resolvedDecision IS NULL`,
      )
      .run(decision, requestId);
    return Number(result.changes);
  }

  listPendingPermissions(): PendingPermissionRow[] {
    return this.db
      .prepare(`SELECT * FROM pending_permissions ORDER BY createdAtMs ASC`)
      .all()
      .map((r) => this.toPendingPermissionRow(r));
  }

  // ---- pending_questions ----
  //
  // Mirrors the pending_permissions surface exactly (insert / get / WHERE-guarded resolve /
  // list), so the hook receiver's held-question path and the daemon's managed-question routing
  // share the same single-resolve contract the permission machinery already relies on.

  private toPendingQuestionRow(row: Record<string, unknown>): PendingQuestionRow {
    return {
      requestId: requireString(row, 'requestId'),
      sessionId: requireString(row, 'sessionId'),
      createdAtMs: requireNumber(row, 'createdAtMs'),
      origin: requireString(row, 'origin'),
      resolvedAtMs: optionalNumber(row, 'resolvedAtMs'),
    };
  }

  insertPendingQuestion(row: Omit<PendingQuestionRow, 'resolvedAtMs'>): void {
    this.db
      .prepare(
        `INSERT INTO pending_questions (requestId, sessionId, createdAtMs, origin, resolvedAtMs)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(row.requestId, row.sessionId, row.createdAtMs, row.origin);
  }

  getPendingQuestion(requestId: string): PendingQuestionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_questions WHERE requestId = ?`)
      .get(requestId);
    return row ? this.toPendingQuestionRow(row) : undefined;
  }

  /**
   * Record that a question was answered, but ONLY while still pending (`resolvedAtMs IS NULL`) —
   * the WHERE clause is what makes this atomically reject a double-resolve. Returns the number of
   * rows changed: 1 on success, 0 if the id doesn't exist or was already answered. The mirror of
   * {@link resolvePendingPermission}, differing only in that a question records a timestamp (it
   * has no allow/deny to store).
   */
  resolvePendingQuestion(requestId: string, resolvedAtMs: number): number {
    const result = this.db
      .prepare(
        `UPDATE pending_questions SET resolvedAtMs = ?
         WHERE requestId = ? AND resolvedAtMs IS NULL`,
      )
      .run(resolvedAtMs, requestId);
    return Number(result.changes);
  }

  listPendingQuestions(): PendingQuestionRow[] {
    return this.db
      .prepare(`SELECT * FROM pending_questions ORDER BY createdAtMs ASC`)
      .all()
      .map((r) => this.toPendingQuestionRow(r));
  }

  // ---- sessions ----
  //
  // DECISION: this table is a DISPLAY-ONLY MIRROR for `cctl session status`, NOT a
  // source of truth. Recovery NEVER reads it: session-runtime's `sessions.json` (atomic
  // temp+rename) remains the single source of truth that recover()/resumeOrphan read, precisely
  // because a mirror can diverge from it across a crash window. Wiring a writer was deferred
  // until its reader existed ("a second source of truth with no reader is pure
  // divergence risk"); both land together — the daemon mirrors managed-session state
  // transitions here (see daemon.ts `mirrorManagedSession`) and registers interactive sessions
  // here (see daemon.ts `registerSession`), and `cctl session status` reads it offline. Because
  // it is observability-only, STALENESS AFTER A CRASH IS TOLERATED: a row left 'running' by a
  // dead daemon is a cosmetic lie in `session status`, never a recovery hazard (recovery reads
  // sessions.json, which is authoritative). Do not make anything on the recovery path read here.

  private toSessionRow(row: Record<string, unknown>): SessionRow {
    return {
      id: requireString(row, 'id'),
      kind: requireString(row, 'kind'),
      state: requireString(row, 'state'),
      accountId: optionalString(row, 'accountId'),
      json: requireString(row, 'json'),
      updatedAtMs: requireNumber(row, 'updatedAtMs'),
    };
  }

  /** Insert-or-replace by id (latest write wins). Written by the daemon's display mirror only
   *  (managed-session transitions + interactive-session registration) — see the section note
   *  above: this is observability, never a recovery source. */
  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, kind, state, accountId, json, updatedAtMs)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           state = excluded.state,
           accountId = excluded.accountId,
           json = excluded.json,
           updatedAtMs = excluded.updatedAtMs`,
      )
      .run(row.id, row.kind, row.state, row.accountId, row.json, row.updatedAtMs);
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    return row ? this.toSessionRow(row) : undefined;
  }

  /** Remove one row from the display mirror (the `cctl session unregister` path). Returns
   *  whether a row was actually deleted, so the caller can answer "was never registered"
   *  honestly instead of pretending an unregister of nothing succeeded. */
  deleteSession(id: string): boolean {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY updatedAtMs ASC`)
      .all()
      .map((r) => this.toSessionRow(r));
  }

  // ---- outbox ----

  private toOutboxRow(row: Record<string, unknown>): OutboxRow {
    return {
      id: requireNumber(row, 'id'),
      envelopeJson: requireString(row, 'envelopeJson'),
      createdAtMs: requireNumber(row, 'createdAtMs'),
    };
  }

  enqueueOutbox(envelopeJson: string, createdAtMs: number): number {
    const result = this.db
      .prepare(`INSERT INTO outbox (envelopeJson, createdAtMs) VALUES (?, ?)`)
      .run(envelopeJson, createdAtMs);
    return Number(result.lastInsertRowid);
  }

  /** Oldest-first — the order outbound envelopes should be replayed in on reconnect. */
  listOutbox(limit = 1000): OutboxRow[] {
    return this.db
      .prepare(`SELECT * FROM outbox ORDER BY id ASC LIMIT ?`)
      .all(limit)
      .map((r) => this.toOutboxRow(r));
  }

  deleteOutbox(id: number): void {
    this.db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
  }

  countOutbox(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get();
    return row ? requireNumber(row, 'n') : 0;
  }

  /** Enforce a bounded outbox by dropping the OLDEST rows first — a disconnected daemon
   *  should keep its most recent state, not the state from before a long outage. */
  trimOutboxOldest(maxRows: number): void {
    this.db
      .prepare(
        `DELETE FROM outbox WHERE id IN (
           SELECT id FROM outbox ORDER BY id ASC LIMIT MAX(0, (SELECT COUNT(*) FROM outbox) - ?)
         )`,
      )
      .run(maxRows);
  }
}
