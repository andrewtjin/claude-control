// Composition of the per-session channel server, shared by the standalone `cctl-channel`
// binary and by `cctl channel serve` (which is what the shipped plugin's .mcp.json invokes, so
// the channel travels with the CLI the operator already has rather than needing its own path).
//
// ORDER MATTERS HERE. The transport starts before anything else, so `initialize` is answered
// from an otherwise-idle process: identity resolution, the daemon's module graph, and the
// credential read that decrypts the hook secret all happen behind a handshake that has already
// completed. Nothing below `server.start()` may be moved in front of it — a measured ~7s of
// startup work in that window is enough to stall the MCP handshake.
//
// That is also why the imports below `./server.js` are DYNAMIC. Only `ChannelServer` is needed to
// answer `initialize`; the logger, identity resolution and the daemon link are all pulled in
// afterwards, so their module graphs land behind a handshake that has already been served.

import { ChannelServer } from './server.js';
import { noopLogger, type Logger } from './logger.js';
import type { DaemonLink, DeliverResult } from './daemonLink.js';

/** How long a detach may delay exit. Short: the daemon expires stale attachments anyway, so the
 *  worst case of skipping it is a brief window where a replacement server sees a 409. */
const DETACH_GRACE_MS = 2_000;

/** How long to wait for `notifications/initialized` before giving up on the handshake.
 *
 *  Generous — a real client answers in milliseconds. The bound exists because the alternative is
 *  an invisible park: without it, a client that never completes its handshake leaves this process
 *  waiting forever while showing a perfectly healthy MCP server, and the channel never attaches
 *  with nothing written anywhere to say so. */
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** Run the channel server to completion. Resolves with the process exit code. */
export async function runChannelServer(): Promise<number> {
  // The transport is built before the link and the real logger exist, so both live in one cell
  // that later stages fill in. `reply` reads the link from it and, while there isn't one, an
  // honest reason it cannot send — kept accurate as startup progresses rather than leaving the
  // model to guess why nothing happened.
  const channel: { link?: DaemonLink; logger: Logger; refusal: string } = {
    logger: noopLogger,
    refusal: 'the channel is still starting up',
  };
  // Forwards to whatever logger the cell currently holds, so the server can be constructed
  // before pino has been loaded without losing the lines it emits afterwards.
  const forwarding: Logger = {
    debug: (obj, msg) => channel.logger.debug(obj, msg),
    info: (obj, msg) => channel.logger.info(obj, msg),
    warn: (obj, msg) => channel.logger.warn(obj, msg),
    error: (obj, msg) => channel.logger.error(obj, msg),
  };

  let shutdown: (reason: string) => void = () => {};
  const server = new ChannelServer({
    input: process.stdin,
    output: process.stdout,
    logger: forwarding,
    onReply: (text): Promise<DeliverResult> =>
      channel.link?.reply(text) ?? Promise.resolve({ ok: false, error: channel.refusal }),
    // An EPIPE on stdio means Claude Code is gone. Without this the stream error would be an
    // uncaught exception that kills the process before it can detach, leaving the daemon holding
    // this session's attachment until its stale sweep.
    onTransportError: () => shutdown('transport-error'),
  });
  server.start();

  // stdout is the JSON-RPC wire; every log line goes to stderr, which Claude Code captures into
  // `~/.claude/debug/<session-id>.txt` — the only place an operator can see this process at all.
  const { createLogger } = await import('@claude-control/shared-protocol');
  const logger = createLogger({ defaultLevel: 'info', sink: process.stderr });
  channel.logger = logger;

  // Installed before the identity gate so even the degraded, never-attached server exits cleanly
  // on a signal instead of lingering until Claude Code kills the pipe.
  shutdown = installShutdown(() => {
    channel.link?.stop();
    return channel.link?.detach() ?? Promise.resolve();
  }, logger);

  const { resolveIdentity } = await import('./identity.js');
  const identity = await resolveIdentity();
  if (!identity.ok) {
    // Fail closed: with no verified session id there is no safe address to attach to, and
    // attaching to a guess would deliver one operator's message into another's terminal. The
    // server keeps serving the handshake — a crash here would only show up as a broken MCP
    // server with no explanation — but it accepts nothing and says why.
    channel.refusal = `this session could not be identified (${identity.reason}), so the cctl channel is not attached`;
    logger.error({ reason: identity.reason }, 'channel: refusing to attach, session unidentified');
    return 0;
  }
  // `sessionPid`, not `pid`: pino stamps its own `pid` (this process) on every line, and a
  // second key by that name emits a duplicate JSON key that every parser silently collapses.
  if (identity.ambiguous) {
    logger.warn(
      { sessionId: identity.sessionId, sessionPid: identity.pid },
      'channel: ancestry matched several live sessions; took the nearest',
    );
  }
  logger.info(
    { sessionId: identity.sessionId, sessionPid: identity.pid, identitySource: identity.source },
    'channel: session identified',
  );

  // Attaching before the client has finished its handshake would let the daemon hand us an item
  // the session cannot yet receive, and channel delivery has no way to discover that afterwards.
  if (!(await server.ready(HANDSHAKE_TIMEOUT_MS))) {
    // Not attaching is the safe answer: an attachment tells the daemon this session has a live
    // channel, which stops it using the turn-boundary fallback that would still have worked.
    channel.refusal =
      'the session never completed its MCP handshake, so the channel is not attached';
    logger.error(
      { timeoutMs: HANDSHAKE_TIMEOUT_MS },
      'channel: no notifications/initialized from the client; not attaching',
    );
    return 0;
  }

  const { DaemonLink } = await import('./daemonLink.js');
  const link = new DaemonLink({ identity, logger });
  channel.link = link;
  channel.refusal = 'the cctl daemon is not reachable';

  // `push` reports whether the frame reached the transport, and that result becomes the ack
  // verbatim. It must NOT be replaced with an unconditional success: the daemon drops an item
  // from its in-flight map on a `sent` ack, so a false success destroys the message outright.
  const outcome = await link.run((item) => server.push(item.text, item.meta));
  // A conflict is the operator's problem to fix (two servers, one session) and must not look
  // like a clean exit.
  return outcome.reason === 'conflict' ? 1 : 0;
}

/** Wire every way this process is asked to stop: stdin EOF (the normal one — Claude Code closes
 *  the pipe when the session ends), the termination signals, and a transport failure reported by
 *  the server. Returns the shutdown function so the caller can trigger it too. Detach is
 *  best-effort and hard-bounded, because an unreachable daemon must not turn shutdown into a
 *  hang. */
function installShutdown(
  stop: () => Promise<void>,
  logger: { info(obj: unknown, msg?: string): void },
): (reason: string) => void {
  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'channel: shutting down');
    const timer = setTimeout(() => process.exit(0), DETACH_GRACE_MS);
    timer.unref();
    void stop().finally(() => process.exit(0));
  };
  process.stdin.on('end', () => shutdown('stdin-eof'));
  process.stdin.on('close', () => shutdown('stdin-close'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}
