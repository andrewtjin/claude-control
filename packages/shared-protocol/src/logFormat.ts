// Pure log-line formatter: turns one pino-shaped log call (level, time, bindings/data object,
// message) into a single human-scannable text line. Zero pino dependency on purpose — this
// file only builds strings, so it can be unit-tested in isolation and reused by anything that
// wants pino's data shape without pino's default rendering (numeric level first, message last,
// pid/hostname repeated on every line, a full stack trace inline).
//
// Output shape: `HH:MM:SS LVL  message  key=val key=val`
//   - Local time, no date: the daemon runs continuously, so the date is noise on every line.
//   - The message sits right after the level — this is the entire point of the change from
//     pino's default order (level, time, pid, hostname, ...bindings, msg LAST).
//   - Headline keys (below) print first, in a fixed order, so the same kind of event always
//     lines up in the same column across log lines; everything else follows in its original
//     (insertion) order.
//   - `err` collapses to its message plus its scalar diagnostics (code/errno/syscall); the
//     stack is the single biggest length win, so it moves to an indented line below and only
//     when the caller asks for it (see `includeStack`).

/**
 * Keys worth aligning first because they carry the meaning of a line at a glance, in the order
 * an operator scans for them: which correlation id (sessionId/requestId), which subject
 * (accountId/daemonId/discordUserId), what triggered it (event), what was decided
 * (decision/outcome/state/rung), and the short scalars worth seeing without hunting
 * (reason/port/count). Everything else still prints, just after these, in whatever order the
 * call site built the object.
 */
const HEADLINE_KEYS = [
  'sessionId',
  'requestId',
  'accountId',
  'daemonId',
  'discordUserId',
  'event',
  'decision',
  'outcome',
  'state',
  'rung',
  'reason',
  'port',
  'count',
];

/** Scalar fields of a serialized error that are worth keeping on the summary line: they name
 *  the failure precisely (`ECONNREFUSED`, `EACCES`, `connect`) without costing the length a
 *  stack would. Everything else about the error lives in the stack or in the JSON output. */
const ERR_DETAIL_KEYS = ['code', 'errno', 'syscall'];

/** Values longer than this are truncated with a visible marker, never silently. Long enough to
 *  keep a URL or a short JSON blob intact, short enough that one bad field (a giant buffer, a
 *  huge array) cannot blow out an entire line. */
const MAX_VALUE_LENGTH = 200;

/** Local HH:MM:SS — no date, see module comment. */
function formatTime(timeMs: number): string {
  const d = new Date(timeMs);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Uppercase, padded to a fixed 5-char column so every line's message starts in the same
 *  place regardless of level word length (INFO/WARN vs ERROR/DEBUG/TRACE/FATAL). An unknown
 *  level string still renders deterministically (padded or clipped to 5) rather than throwing
 *  or leaving misaligned columns. */
function formatLevel(level: string): string {
  const upper = level.toUpperCase();
  return upper.length >= 5 ? upper.slice(0, 5) : upper.padEnd(5);
}

/** Truncates a rendered value with a visible marker stating how much was cut, so a reader can
 *  always tell that something was dropped and how much. */
function truncate(s: string): string {
  if (s.length <= MAX_VALUE_LENGTH) return s;
  const cut = s.length - MAX_VALUE_LENGTH;
  return `${s.slice(0, MAX_VALUE_LENGTH)}…(+${cut} more chars)`;
}

/** Bare tokens read fine unquoted (`sessionId=abc123`); anything with whitespace, a quote, or
 *  the empty string needs quoting so the line stays unambiguous to read and to split on
 *  whitespace by a human or a quick `awk`. */
function quoteIfNeeded(s: string): string {
  if (s === '' || /[\s"]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Renders one value for the `key=value` tail. Objects/arrays go through JSON.stringify; a
 *  nested BigInt is swapped for its decimal string first (plain JSON.stringify throws on
 *  BigInt) via the replacer. Anything that still fails to serialize (circular references,
 *  etc.) renders as a visible marker rather than crashing the logger over a bad payload — the
 *  log line is diagnostic tooling, it must never be the thing that takes the process down. */
function renderValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteIfNeeded(truncate(value));
  // BigInt is handled as its own primitive (not routed through JSON.stringify) so it renders
  // bare (`big=10`) instead of as a quoted JSON string (`big="10"`).
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    // JSON.stringify returns undefined for values it has no representation for (functions,
    // symbols). Marking them beats stringifying them: `String(fn)` dumps the whole function
    // body into the middle of a log line.
    if (json === undefined) return `[unserializable ${Object.prototype.toString.call(value)}]`;
    return quoteIfNeeded(truncate(json));
  } catch {
    return `[unserializable ${Object.prototype.toString.call(value)}]`;
  }
}

/** Splits an `err` value into the three things a reader needs at different depths: the message
 *  (always on the summary line), the scalar detail fields (also on the summary line — cheap and
 *  often the whole diagnosis), and the stack (only when `includeStack` asks for it). Accepts a
 *  real `Error`, pino's default serialized shape (`{type,message,stack,...}`), or anything else
 *  — a malformed `err` must never throw while we are trying to make a log line readable. */
function collapseErr(value: unknown): {
  message: string;
  stack: string | undefined;
  details: string[];
} {
  if (value === null || typeof value !== 'object') {
    const message = typeof value === 'string' ? value : renderValue(value);
    return { message, stack: undefined, details: [] };
  }
  const record = value as Record<string, unknown>;
  const message =
    typeof record.message === 'string' ? record.message : (JSON.stringify(value) ?? '');
  const stack = typeof record.stack === 'string' ? record.stack : undefined;
  const details: string[] = [];
  for (const key of ERR_DETAIL_KEYS) {
    const detail = record[key];
    if (typeof detail === 'string' || typeof detail === 'number') {
      details.push(`${key}=${renderValue(detail)}`);
    }
  }
  return { message, stack, details };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FormatLogLineOptions {
  /** Print an `err`'s stack on indented continuation lines. Off by default: the stack is the
   *  bulk of what makes raw output unreadable, so it belongs behind the operator's own request
   *  for verbose output (the CONFIGURED logger level, not the level of this one line — every
   *  error in this codebase is logged at error/warn, so gating on the line's own level would
   *  make the stack unreachable). */
  includeStack?: boolean;
}

/**
 * Render one log call as a single (possibly multi-line, see `includeStack`) text line.
 *
 * @param level  pino level name (e.g. 'info', 'warn') — case-insensitive, any string accepted.
 * @param timeMs epoch milliseconds.
 * @param obj    the bindings/data object passed to `logger.<level>(obj, msg)`; non-objects
 *               (null, an array, undefined) degrade to "no fields" rather than throwing.
 * @param msg    the message string; omitted messages simply produce no message segment.
 */
export function formatLogLine(
  level: string,
  timeMs: number,
  obj: unknown,
  msg?: string,
  options: FormatLogLineOptions = {},
): string {
  const safeObj = isPlainRecord(obj) ? obj : {};
  const keys = Object.keys(safeObj);
  // Headline keys first (in HEADLINE_KEYS order, only the ones actually present), then
  // whatever else the call site included, in its original insertion order. `err` is not a
  // headline key — it gets special value-handling below, but its POSITION falls out of this
  // same ordering rule like any other field.
  const headline = HEADLINE_KEYS.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !HEADLINE_KEYS.includes(k));
  const orderedKeys = [...headline, ...rest];

  const parts: string[] = [];
  let errStack: string | undefined;
  for (const key of orderedKeys) {
    const value = safeObj[key];
    if (key === 'err') {
      const { message, stack, details } = collapseErr(value);
      parts.push(`err=${quoteIfNeeded(truncate(message))}`, ...details);
      if (options.includeStack === true && stack !== undefined) errStack = stack;
      continue;
    }
    parts.push(`${key}=${renderValue(value)}`);
  }

  const segments = [`${formatTime(timeMs)} ${formatLevel(level)}`];
  if (msg) segments.push(msg);
  if (parts.length > 0) segments.push(parts.join(' '));
  let line = segments.join('  ');

  if (errStack !== undefined) {
    // Indented continuation line(s) so the stack is visually subordinate to the summary line
    // above it, and still greppable as a block (every line shares the same 4-space prefix).
    line += `\n${errStack
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`;
  }
  return line;
}
