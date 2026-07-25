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
//   - `err` collapses to its message only; the stack (if any) prints on an indented line
//     below, and ONLY at debug level — the single biggest length win, and the direct answer to
//     "diagnostic info at the back, main message at the front".

/**
 * Keys worth aligning first because they carry the meaning of a line at a glance, ordered by
 * how often they are the thing an operator is scanning FOR. Chosen by grepping every
 * `logger.<level>(...)` call site across packages/daemon, packages/cli, packages/switch-engine,
 * and packages/control-plane-bot (not guessed):
 *   - sessionId, requestId  correlate almost every daemon/hook-receiver log line to the thing
 *     that triggered it; they are the two most common keys in the codebase by a wide margin.
 *   - accountId, daemonId, discordUserId  identify WHICH account/daemon/Discord user a line is
 *     about, the next most common "which one" axis after session/request.
 *   - event  the raw hook event name (hookReceiver.ts) driving a line.
 *   - decision, outcome, state, rung  the auto-switch and stop-escalation policy modules report
 *     their result under these names — the "what happened" half of a line, right after "which
 *     one" and "what triggered it".
 *   - reason  a short human explanation attached to a handful of warn/error lines.
 *   - port, count  small scalars worth seeing without hunting through the tail.
 * Everything else (err objects, route/op payloads, one-off fields) still prints, just after
 * these, in whatever order the call site built the object.
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

/** Values longer than this are truncated with a visible marker — never silently, per house
 *  rule. Long enough to keep a URL or a short JSON blob intact, short enough that one bad
 *  field (a giant buffer, a huge array) cannot blow out an entire line. */
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

/** Truncates a rendered value with a visible marker stating how much was cut — silent
 *  truncation is a house-rule violation, so the marker is not optional. */
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
    return quoteIfNeeded(truncate(json ?? String(value)));
  } catch {
    return `[unserializable ${Object.prototype.toString.call(value)}]`;
  }
}

/** Pulls the message and, at debug level only, the stack out of a pino-serialized `err`
 *  value. Accepts a real `Error`, pino's default serialized shape
 *  (`{type,message,stack,...}`), or anything else (rendered via String() so a malformed `err`
 *  never throws while we are trying to make a log line readable). */
function collapseErr(value: unknown): { message: string; stack: string | undefined } {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  if (value !== null && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const message = typeof v.message === 'string' ? v.message : JSON.stringify(value);
    const stack = typeof v.stack === 'string' ? v.stack : undefined;
    return { message, stack };
  }
  return { message: String(value), stack: undefined };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render one log call as a single (possibly two-line, see `err` below) text line.
 *
 * @param level  pino level name (e.g. 'info', 'warn') — case-insensitive, any string accepted.
 * @param timeMs epoch milliseconds.
 * @param obj    the bindings/data object passed to `logger.<level>(obj, msg)`; non-objects
 *               (null, an array, undefined) degrade to "no fields" rather than throwing.
 * @param msg    the message string; omitted messages simply produce no message segment.
 */
export function formatLogLine(level: string, timeMs: number, obj: unknown, msg?: string): string {
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
  let debugStack: string | undefined;
  for (const key of orderedKeys) {
    const value = safeObj[key];
    if (key === 'err') {
      const { message, stack } = collapseErr(value);
      parts.push(`err=${quoteIfNeeded(truncate(message))}`);
      if (level.toLowerCase() === 'debug' && stack) debugStack = stack;
      continue;
    }
    parts.push(`${key}=${renderValue(value)}`);
  }

  const segments = [`${formatTime(timeMs)} ${formatLevel(level)}`];
  if (msg) segments.push(msg);
  if (parts.length > 0) segments.push(parts.join(' '));
  let line = segments.join('  ');

  if (debugStack !== undefined) {
    // Indented continuation line(s) so the stack is visually subordinate to the summary line
    // above it, and still greppable as a block (every line shares the same 4-space prefix).
    line += `\n${debugStack
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`;
  }
  return line;
}
