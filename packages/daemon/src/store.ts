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
// The one-way dependency is deliberate: `usageHistory` owns what a weekly reading MEANS (which
// limit kind counts, how its reset timestamp is read), and the store owns where it is kept. The
// reverse import does not exist — `usageHistory` reaches the store through a structural interface
// — so there is no cycle.
import { extractWeeklyReading } from './usageHistory.js';

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

/**
 * The weekly reading carried alongside a snapshot, denormalized OUT of {@link UsageSnapshotRow.json}
 * into real columns at insert time.
 *
 * WHY THIS EXISTS AT ALL. The burn/reset measurements re-read every snapshot in a ten-day window
 * on every sixty-second poll cycle, and all they ever want from a row is these two numbers. Left
 * inside the blob, getting them meant hauling ~6 MB of JSON off disk and parsing ~13k documents
 * per cycle — measured at 238-974ms of SYNCHRONOUS main-loop time on a real four-account machine,
 * which is precisely the stall every concurrent hook request was waiting out. As columns, the same
 * read is a covering-index scan: 15-32ms, no parse, and no per-cycle garbage.
 *
 * Both are nullable, and null is meaningful rather than missing: a snapshot whose payload carries
 * no `weekly_all` limit (a poll that degraded to an error record, a tier-0 cache entry without one)
 * genuinely has no weekly reading, and must be skipped by the measurement rather than read as zero.
 */
export interface WeeklyReading {
  /** Percent of the account's own weekly limit, from the payload's `weekly_all` limit. */
  weeklyPercent: number | null;
  /** Epoch ms of the reset the endpoint reported with that reading, when it reported one. */
  weeklyResetsAtMs: number | null;
}

/** One row of the history read: the three numbers the measurements need, and nothing else. */
export interface WeeklyObservationRow {
  fetchedAtMs: number;
  percent: number;
  /** Absent — not null — when that reading carried no reset, so the shape matches the pure
   *  `WeeklyObservation` the measurements consume without a second normalization step. */
  resetsAtMs?: number;
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

/**
 * One prompt queued for a session that could not take it yet, mirrored out of the daemon's
 * in-memory queues (see daemon.ts `queueSteering` / `queueManagedInject`).
 *
 * Unlike the sessions table above, this is NOT display-only: the phone was told each of these
 * texts was queued and would deliver at the session's next turn boundary, and an in-memory queue
 * met that promise with silence across a restart — the next boundary found nothing and nothing
 * ever said so. The rows are the durable half of that promise, so a restart can either put the
 * text back or account for it.
 */
export interface PendingSteeringRow {
  id: number;
  sessionId: string;
  /** Which queue the row belongs to — 'interactive' (a registered terminal session, answered at
   *  its next hook) or 'managed' (an SDK session, sent at its next idle turn). Recorded rather
   *  than inferred from the session id, because the two drain on different signals and a restart
   *  can only put ONE of them back: the terminal session is another process and outlives this
   *  daemon; the managed session's subprocess does not. */
  kind: string;
  text: string;
  queuedAtMs: number;
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
        json TEXT NOT NULL,
        weeklyPercent REAL,
        weeklyResetsAtMs INTEGER
      );
      -- Deliberately wider than its lookup key. The two trailing columns make this index COVER
      -- the history read (see listWeeklyObservationsSince), so that read never touches the table
      -- and never sees the json blob at all. The trim's covering scan for id is unaffected -- a
      -- wider index still carries the rowid -- and four inserts a minute make the extra write
      -- cost of two more indexed columns unmeasurable.
      CREATE INDEX IF NOT EXISTS idx_usage_snapshots_account
        ON usage_snapshots (accountId, fetchedAtMs, weeklyPercent, weeklyResetsAtMs);

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

      CREATE TABLE IF NOT EXISTS pending_steering (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        queuedAtMs INTEGER NOT NULL
      );
      -- The autoincrement id doubles as arrival order, which is the order queued text must be
      -- delivered in, so every read here is id-ordered and the index carries the id along.
      CREATE INDEX IF NOT EXISTS idx_pending_steering_session
        ON pending_steering (sessionId, kind, id);
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
    this.migrateWeeklyColumns();
  }

  /**
   * Bring a pre-denormalization database up to the {@link WeeklyReading} columns: add them, widen
   * the index to cover them, and fill them in for rows written before they existed.
   *
   * Split out of {@link migrate} because all three steps only ever matter to an EXISTING file — a
   * database created by the DDL above already has the columns, already has the wide index, and
   * has no rows to fill — and because the backfill is the one migration step here that is not
   * instantaneous.
   */
  private migrateWeeklyColumns(): void {
    const columns = this.db.prepare(`PRAGMA table_info(usage_snapshots)`).all();
    if (!columns.some((col) => col['name'] === 'weeklyPercent')) {
      this.db.exec(`ALTER TABLE usage_snapshots ADD COLUMN weeklyPercent REAL`);
      this.db.exec(`ALTER TABLE usage_snapshots ADD COLUMN weeklyResetsAtMs INTEGER`);
    }
    // `CREATE INDEX IF NOT EXISTS` above is a no-op against an index of the same name, so a
    // database carrying the old two-column index keeps it — and a two-column index does not
    // cover the history read, which would silently leave the whole stall in place on exactly
    // the machines that already have the data to be slow about. Detect by width and rebuild.
    const indexed = this.db.prepare(`PRAGMA index_info(idx_usage_snapshots_account)`).all();
    if (indexed.length > 0 && indexed.length < 4) {
      this.db.exec(`DROP INDEX idx_usage_snapshots_account`);
      this.db.exec(
        `CREATE INDEX idx_usage_snapshots_account
           ON usage_snapshots (accountId, fetchedAtMs, weeklyPercent, weeklyResetsAtMs)`,
      );
    }
    this.backfillWeeklyColumns();
  }

  /**
   * Populate {@link WeeklyReading} for rows that predate the columns.
   *
   * Deliberately NOT gated on a schema-version counter. The gate is the data itself — only rows
   * whose `weeklyPercent` is still null are read — which is self-limiting without any state to
   * keep in step: the first start after an upgrade parses the whole backlog once (~1s for 14k
   * rows), and every start after that re-reads only the handful of rows that legitimately carry
   * no weekly reading and never will (measured: ~1.2% of a real corpus). A version counter would
   * buy back that remainder in exchange for a number that can disagree with the schema it claims
   * to describe — the wrong trade for a cost this small.
   *
   * One transaction, so an interrupted start leaves the columns either wholly filled or wholly
   * unfilled, and the next start simply redoes it.
   */
  private backfillWeeklyColumns(): void {
    const rows = this.db
      .prepare(`SELECT id, json FROM usage_snapshots WHERE weeklyPercent IS NULL`)
      .all();
    if (rows.length === 0) return;
    const update = this.db.prepare(
      `UPDATE usage_snapshots SET weeklyPercent = ?, weeklyResetsAtMs = ? WHERE id = ?`,
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const reading = extractWeeklyReading(requireString(row, 'json'));
        if (reading.weeklyPercent === null) continue; // no weekly reading to record
        update.run(reading.weeklyPercent, reading.weeklyResetsAtMs, requireNumber(row, 'id'));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
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

  /**
   * Append one snapshot, denormalizing its weekly reading into columns as it goes.
   *
   * The reading is derived HERE rather than being asked of the caller. Every caller already hands
   * over the serialized payload, so deriving it from that one source is what makes the columns
   * incapable of disagreeing with the blob they summarize — a caller-supplied pair could drift
   * from the JSON beside it and the measurements would report the drift as real usage.
   */
  insertUsageSnapshot(row: Omit<UsageSnapshotRow, 'id'>): number {
    const reading = extractWeeklyReading(row.json);
    const result = this.db
      .prepare(
        `INSERT INTO usage_snapshots (accountId, fetchedAtMs, source, json, weeklyPercent, weeklyResetsAtMs)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.accountId,
        row.fetchedAtMs,
        row.source,
        row.json,
        reading.weeklyPercent,
        reading.weeklyResetsAtMs,
      );
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

  /**
   * One account's weekly readings from `sinceMs` onward, OLDEST first — the order a time series
   * is differenced in. Bounded by the caller's window rather than a row count, so a burn
   * measurement covers the span it claims to instead of however many rows happened to fit.
   *
   * This is the daemon's hottest read: it runs for every account on every poll cycle, on the main
   * loop, in front of every concurrent hook request. Three facts keep it cheap, and all three are
   * load-bearing:
   *   - it names its three columns instead of `SELECT *`, so the `json` blob is never fetched;
   *   - those columns are all in `idx_usage_snapshots_account`, so the query plan is
   *     `SEARCH ... USING COVERING INDEX` and the table is never touched;
   *   - `weeklyPercent IS NOT NULL` drops the unreadable rows in SQLite rather than in JS.
   * The predecessor read the whole row and JSON-parsed every blob: 238-974ms per cycle on a real
   * four-account machine, against 15-32ms here. Anything that reintroduces the blob to this path
   * reintroduces the stall.
   */
  listWeeklyObservationsSince(accountId: string, sinceMs: number): WeeklyObservationRow[] {
    const rows = this.db
      .prepare(
        `SELECT fetchedAtMs, weeklyPercent, weeklyResetsAtMs FROM usage_snapshots
         WHERE accountId = ? AND fetchedAtMs >= ? AND weeklyPercent IS NOT NULL
         ORDER BY fetchedAtMs ASC`,
      )
      .all(accountId, sinceMs);
    return rows.map((r) => {
      const resetsAtMs = r['weeklyResetsAtMs'];
      return {
        fetchedAtMs: requireNumber(r, 'fetchedAtMs'),
        percent: requireNumber(r, 'weeklyPercent'),
        // Absent rather than null, matching the pure measurement's optional field.
        ...(typeof resetsAtMs === 'number' ? { resetsAtMs } : {}),
      };
    });
  }

  latestUsageSnapshot(accountId: string): UsageSnapshotRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM usage_snapshots WHERE accountId = ? ORDER BY fetchedAtMs DESC LIMIT 1`,
      )
      .get(accountId);
    return row ? this.toUsageSnapshotRow(row) : undefined;
  }

  /**
   * Drop usage snapshots older than `cutoffMs`, returning how many rows went. The poller appends
   * one row per account per cycle forever, so without this the table is the only unbounded thing
   * the daemon writes; nothing reads a snapshot older than the current view.
   *
   * The `id IN (SELECT ...)` shape is not decoration. A bare `DELETE ... WHERE fetchedAtMs < ?`
   * plans as a full table SCAN on a database that has never been ANALYZEd (the normal state of a
   * daemon db), because `fetchedAtMs` is the SECOND column of the only index. Selecting the ids
   * first plans as `SCAN ... USING COVERING INDEX idx_usage_snapshots_account` — the candidate
   * rows are found in the index alone, and only the rows actually being deleted are touched.
   * Same reason and same shape as {@link trimOutboxOldest}.
   */
  trimUsageSnapshots(cutoffMs: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM usage_snapshots WHERE id IN (
           SELECT id FROM usage_snapshots WHERE fetchedAtMs < ?
         )`,
      )
      .run(cutoffMs);
    return Number(result.changes);
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

  // ---- pending steering ----
  //
  // Write-through mirror of the daemon's queues, not a second source of truth: the maps stay
  // authoritative while the process lives, and these rows exist only so the NEXT process can
  // rebuild them. Every enqueue inserts, every delivery or drop deletes, so a row outliving its
  // queue entry would mean a restart re-delivers text that already landed.

  private toPendingSteeringRow(row: Record<string, unknown>): PendingSteeringRow {
    return {
      id: requireNumber(row, 'id'),
      sessionId: requireString(row, 'sessionId'),
      kind: requireString(row, 'kind'),
      text: requireString(row, 'text'),
      queuedAtMs: requireNumber(row, 'queuedAtMs'),
    };
  }

  /** Returns the new row's id, which the caller keeps on its in-memory queue entry so the
   *  matching delete can name exactly the one that delivered. */
  insertPendingSteering(row: Omit<PendingSteeringRow, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO pending_steering (sessionId, kind, text, queuedAtMs) VALUES (?, ?, ?, ?)`,
      )
      .run(row.sessionId, row.kind, row.text, row.queuedAtMs);
    return Number(result.lastInsertRowid);
  }

  /** Oldest-first across every session — arrival order is the order queued text delivers in,
   *  and a reload has to rebuild each session's queue in exactly that order. */
  listPendingSteering(): PendingSteeringRow[] {
    return this.db
      .prepare(`SELECT * FROM pending_steering ORDER BY id ASC`)
      .all()
      .map((r) => this.toPendingSteeringRow(r));
  }

  /** Retire one row — the delivered-a-single-message case (a managed session takes one text per
   *  turn boundary), where the rest of the queue must stay. */
  deletePendingSteering(id: number): void {
    this.db.prepare(`DELETE FROM pending_steering WHERE id = ?`).run(id);
  }

  /** Retire a whole queue at once: everything consumed in one hook answer, or discarded because
   *  the session was unregistered or ended. Returns the number of rows removed so a caller can
   *  report a count honestly rather than guess one. */
  deletePendingSteeringForSession(sessionId: string, kind: string): number {
    const result = this.db
      .prepare(`DELETE FROM pending_steering WHERE sessionId = ? AND kind = ?`)
      .run(sessionId, kind);
    return Number(result.changes);
  }
}
