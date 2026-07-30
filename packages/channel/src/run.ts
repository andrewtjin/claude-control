// Composition of the per-session channel server, shared by the standalone `cctl-channel`
// binary and by `cctl channel serve` (which is what the shipped plugin's .mcp.json invokes, so
// the channel travels with the CLI the operator already has rather than needing its own path).
//
// ORDER MATTERS HERE. The transport starts before anything else, so `initialize` is answered
// from an otherwise-idle process: identity resolution, the daemon's module graph, and the
// credential read that decrypts the hook secret all happen behind a handshake that has already
// completed. Nothing below `server.start()` may be moved in front of it — a measured ~7s of
// startup work in that window is enough to stall the MCP handshake.

import { createLogger } from '@claude-control/shared-protocol';

import { DaemonLink, type DeliverResult } from './daemonLink.js';
import { resolveIdentity } from './identity.js';
import { ChannelServer } from './server.js';

/** How long a detach may delay exit. Short: the daemon expires stale attachments anyway, so the
 *  worst case of skipping it is a brief window where a replacement server sees a 409. */
const DETACH_GRACE_MS = 2_000;

/** Run the channel server to completion. Resolves with the process exit code. */
export async function runChannelServer(): Promise<number> {
  // stdout is the JSON-RPC wire; every log line goes to stderr, which Claude Code captures into
  // `~/.claude/debug/<session-id>.txt` — the only place an operator can see this process at all.
  const logger = createLogger({ defaultLevel: 'info', sink: process.stderr });

  // The transport is built before the link exists, so `reply` needs somewhere to look up both
  // the link and — while there isn't one — an honest reason it cannot send. One cell keeps the
  // two in step, and keeps the refusal accurate as startup progresses instead of leaving the
  // model to guess why nothing happened.
  const channel: { link?: DaemonLink; refusal: string } = {
    refusal: 'the channel is still starting up',
  };

  const server = new ChannelServer({
    input: process.stdin,
    output: process.stdout,
    logger,
    onReply: (text): Promise<DeliverResult> =>
      channel.link?.reply(text) ?? Promise.resolve({ ok: false, error: channel.refusal }),
  });
  server.start();

  // Installed before the identity gate so even the degraded, never-attached server exits cleanly
  // on a signal instead of lingering until Claude Code kills the pipe.
  installShutdown(() => {
    channel.link?.stop();
    return channel.link?.detach() ?? Promise.resolve();
  }, logger);

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

  const link = new DaemonLink({ identity, logger });
  channel.link = link;
  channel.refusal = 'the cctl daemon is not reachable';

  // Attaching before the client has finished its handshake would let the daemon hand us an item
  // the session cannot yet receive, and channel delivery has no way to discover that afterwards.
  await server.ready();
  const outcome = await link.run(async (item) => {
    await server.push(item.text, item.meta);
    return { ok: true };
  });
  // A conflict is the operator's problem to fix (two servers, one session) and must not look
  // like a clean exit.
  return outcome.reason === 'conflict' ? 1 : 0;
}

/** Wire the three ways this process is asked to stop. stdin EOF is the normal one: Claude Code
 *  closes the pipe when the session ends. Detach is best-effort and hard-bounded, because an
 *  unreachable daemon must not turn shutdown into a hang. */
function installShutdown(
  stop: () => Promise<void>,
  logger: { info(obj: unknown, msg?: string): void },
): void {
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'channel: shutting down');
    const timer = setTimeout(() => process.exit(0), DETACH_GRACE_MS);
    timer.unref();
    void stop().finally(() => process.exit(0));
  };
  process.stdin.on('end', () => shutdown('stdin-eof'));
  process.stdin.on('close', () => shutdown('stdin-close'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
