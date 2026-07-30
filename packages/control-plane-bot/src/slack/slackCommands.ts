// The Slack surface's one slash command: `/cctl <subcommand> [args…]`.
//
// This module owns ONLY the Slack-shaped glue — ack timing, parsing a freeform text string into
// the arguments each handler expects, rendering a `CommandResult` as Slack mrkdwn, and the
// deferred-reply dance `/cctl stats days:N` needs. Every command's actual MEANING (what `/run`
// does, what a switch/prune/approve does) lives in ../discord/commands.ts and is reused as-is —
// import-only, never copied — so a command means the same thing on both surfaces by construction.
// That reuse is also why this surface exposes a narrower set than Discord's: anything that leans on
// Discord-only affordances (buttons, threads, ephemeral component state — prune's confirm card,
// approve/deny, thread-here) has no Slack-native equivalent here yet and is left to Block Kit
// interactivity (a separate module) rather than faked as a slash command with no undo.

import { randomUUID } from 'node:crypto';
import type { App, RespondFn } from '@slack/bolt';
import { MAX_STATS_DAYS, MIN_STATS_DAYS } from '@claude-control/shared-protocol';
import type { SlackContext } from './context.js';
import { toMrkdwn, slackChunks, SLACK_LIMITS } from './slackFormat.js';
import * as commands from '../discord/commands.js';
import type { CommandDeps, CommandResult, RunOptions } from '../discord/commands.js';
import { buildStatsEmbed } from '../discord/embeds.js';

/** Every subcommand `/cctl` accepts. Kept as one list so the help text (unknown/empty subcommand)
 *  and the dispatch switch below can never silently drift apart — a subcommand added to one without
 *  the other is exactly the kind of mismatch this module exists to prevent. Exported so the
 *  pairing-primer drift test (slackCommands.test.ts) can hold primerMessage.ts's
 *  SLACK_PAIRING_PRIMER_MESSAGE to the SAME real dispatch set, the way discordJsGateway.ts's
 *  commandDefinitions() does for the Discord primer. */
export const SUBCOMMANDS = [
  'pair',
  'status',
  'usage',
  'accounts',
  'sessions',
  'run',
  'say',
  'stop',
  'stats',
] as const;

/** Subcommands deliberately left out of SLACK_PAIRING_PRIMER_MESSAGE, each for a reason that
 *  outlives the current subcommand list — mirrors discordJsGateway.ts's PRIMER_OMITTED_COMMANDS.
 *  `pair` is the subcommand the reader just finished using: the primer is sent right after a
 *  pairing code is claimed, so telling them how to pair again is not what a brand-new user needs
 *  first. Read by the drift test that keeps the primer and SUBCOMMANDS in step, so dropping a
 *  name from here is what makes that subcommand required in the primer text. */
export const SLACK_PRIMER_OMITTED_SUBCOMMANDS = new Set(['pair']);

/** How long a `/cctl stats days:N` reply waits for the host's scan before saying so. Mirrors the
 *  Discord surface's own bound (discordJsGateway.ts's `STATS_SCAN_TIMEOUT_MS`) — the daemon-side
 *  scan costs the same disk IO regardless of which surface asked for it. */
const STATS_SCAN_TIMEOUT_MS = 120_000;

/** How many of `slackChunks`' chunks a single `/cctl` reply may actually send. Slack allows only
 *  5 calls to a slash command's `response_url` within any 30-minute window; the stats slow path
 *  spends one of those on its own "Scanning…" placeholder before `respondResult` ever runs, so
 *  this leaves headroom rather than letting one huge reply claim (and quietly exceed) the whole
 *  budget — past which Slack does not deliver an error, it just stops delivering. */
const MAX_REPLY_CHUNKS = 4;

/** Register the `/cctl` command on `app`. Call once per process; Bolt errors on a duplicate
 *  registration of the same command name. */
export function registerSlackCommands(app: App, ctx: SlackContext): void {
  app.command('/cctl', async ({ command, ack, respond }) => {
    // MUST be the very first thing that happens. Slack voids the interaction ~3s after receipt,
    // and nothing below — cache reads, a relay send, let alone the stats slow path — is
    // guaranteed to clear that window, so no dependency call may run ahead of the ack.
    await ack();
    const principal = ctx.principalOf(command.user_id);
    const [subcommand, rest] = splitFirstWord(command.text);
    await dispatch(ctx, principal, subcommand.toLowerCase(), rest, respond);
  });
}

/** Route one already-acked invocation. Takes the parsed subcommand/rest rather than the raw
 *  `SlashCommand` so the argument-parsing decisions below are exercised directly by tests without
 *  a fake Bolt payload for every case. */
async function dispatch(
  ctx: SlackContext,
  principal: string,
  subcommand: string,
  rest: string,
  respond: RespondFn,
): Promise<void> {
  const deps = commandDepsFrom(ctx);
  switch (subcommand) {
    case 'pair':
      await respondResult(ctx, respond, commands.handlePair(deps, principal));
      return;
    case 'status':
      await respondResult(ctx, respond, commands.handleStatus(deps, principal));
      return;
    case 'usage':
      await respondResult(ctx, respond, commands.handleUsage(deps, principal));
      return;
    case 'accounts':
      await respondResult(ctx, respond, commands.handleAccounts(deps, principal));
      return;
    case 'sessions':
      await respondResult(ctx, respond, commands.handleSessions(deps, principal));
      return;
    case 'run': {
      const { opts, prompt } = parseRunArgs(rest);
      if (prompt === '') {
        await respondResult(ctx, respond, {
          kind: 'error',
          message: 'Usage: `/cctl run [cwd:<path>] [resume:<sessionId>] <prompt>`.',
        });
        return;
      }
      await respondResult(
        ctx,
        respond,
        commands.handleRun(deps, principal, prompt, randomUUID(), randomUUID(), opts),
      );
      return;
    }
    case 'say': {
      const [sessionId, text] = splitFirstWord(rest);
      if (sessionId === '' || text === '') {
        await respondResult(ctx, respond, {
          kind: 'error',
          message: 'Usage: `/cctl say <sessionId> <text>`.',
        });
        return;
      }
      await respondResult(
        ctx,
        respond,
        commands.handleSay(deps, principal, sessionId, text, randomUUID()),
      );
      return;
    }
    case 'stop': {
      const [sessionId] = splitFirstWord(rest);
      if (sessionId === '') {
        await respondResult(ctx, respond, {
          kind: 'error',
          message: 'Usage: `/cctl stop <sessionId>`.',
        });
        return;
      }
      await respondResult(
        ctx,
        respond,
        commands.handleStop(deps, principal, sessionId, randomUUID()),
      );
      return;
    }
    case 'stats': {
      const arg = parseStatsArg(rest);
      if (arg.kind === 'invalid') {
        await respondResult(ctx, respond, {
          kind: 'error',
          message: `Usage: \`/cctl stats\` or \`/cctl stats days:N\` (${MIN_STATS_DAYS}-${MAX_STATS_DAYS}).`,
        });
        return;
      }
      if (arg.kind === 'none') {
        await respondResult(ctx, respond, commands.handleStats(deps, principal));
        return;
      }
      await runStatsScan(ctx, deps, principal, arg.value, respond);
      return;
    }
    default:
      await respondResult(ctx, respond, helpResult());
  }
}

/** `/cctl stats days:N` — the one subcommand that cannot answer from the cache. The number does
 *  not exist until the HOST re-reads its transcripts, well past Slack's ack window, so the
 *  interim "Scanning…" reply (from `handleStatsScan` itself) goes out first and the real answer
 *  replaces it later via `response_url` — Slack's analogue of Discord's defer-then-edit, since a
 *  slash command has no message to hold open across the wait. */
async function runStatsScan(
  ctx: SlackContext,
  deps: CommandDeps,
  principal: string,
  days: number,
  respond: RespondFn,
): Promise<void> {
  const requestId = randomUUID();
  // MUST be registered before handleStatsScan can put the frame on the wire: a `stats.result`
  // that lands with nobody waiting is dropped by design (see PendingStatsScans) — this ordering
  // is the entire correctness of the slow path, not a nicety.
  const waiting = ctx.statsScans.awaitResult(requestId, STATS_SCAN_TIMEOUT_MS);
  const sent = commands.handleStatsScan(deps, principal, days, requestId);
  await respondResult(ctx, respond, sent);
  if (sent.kind === 'error') {
    // The request never left the bot (offline daemon, no binding) — nothing will ever answer it,
    // so holding the waiter open would just burn the full timeout telling the user nothing new.
    ctx.statsScans.abandon(requestId);
    return;
  }

  const outcome = await waiting;
  if (outcome.kind === 'busy') {
    await respondResult(
      ctx,
      respond,
      {
        kind: 'error',
        message: 'Too many stats scans are already running — try again in a moment.',
      },
      true,
    );
    return;
  }
  if (outcome.kind === 'timeout') {
    await respondResult(
      ctx,
      respond,
      {
        kind: 'error',
        message:
          `The host did not finish scanning within ${Math.round(STATS_SCAN_TIMEOUT_MS / 1000)}s. ` +
          'It may still be working — try a smaller `days` value, or `/cctl stats` for the last ' +
          'pushed snapshot.',
      },
      true,
    );
    return;
  }
  const { ok, snapshot, error } = outcome.payload;
  if (!ok || snapshot === undefined || snapshot === null) {
    await respondResult(
      ctx,
      respond,
      { kind: 'error', message: error ?? 'the host could not scan' },
      true,
    );
    return;
  }
  await respondResult(ctx, respond, { kind: 'embed', embed: buildStatsEmbed(snapshot) }, true);
}

/** Append a visible cut marker to a reply's final sendable chunk when {@link MAX_REPLY_CHUNKS}
 *  bites, trimming to make room for it rather than letting the addition push the chunk back over
 *  its own budget — the same reserve-then-cut care `discord/messageChunks.ts`'s own truncation
 *  marker takes for the analogous per-message cap. */
function withOmittedMarker(chunk: string, omittedChunks: number): string {
  const marker = `\n… output truncated — ${omittedChunks} more chunk${omittedChunks === 1 ? '' : 's'}`;
  const budget = SLACK_LIMITS.SECTION_TEXT_MAX;
  if (chunk.length + marker.length <= budget) return `${chunk}${marker}`;
  return `${chunk.slice(0, Math.max(0, budget - marker.length))}${marker}`;
}

/** Send one `CommandResult` through the sanitize-then-chunk pipeline. `toMrkdwn` (slackFormat.ts)
 *  is the ONLY sanitization boundary daemon-sourced text crosses before reaching the Slack API —
 *  nothing here may hand `respond()` a raw handler string. `replaceOriginal` swaps in the FIRST
 *  chunk over whatever this `response_url` last posted (Slack's edit), used only by the stats
 *  slow path's final answer overwriting its own "Scanning…" placeholder; every other caller posts
 *  fresh messages.
 *
 *  Capped at {@link MAX_REPLY_CHUNKS} with a visible marker on the last chunk sent, rather than
 *  looping over every chunk `slackChunks` produced — a slash command's `response_url` silently
 *  stops delivering once Slack's own 5-call budget is spent, so a longer reply must never reach
 *  chunk 6 pretending anything past it will arrive. Each send is guarded: the budget can already
 *  be exhausted by the time a LATER chunk in this loop goes out (an earlier caller may have spent
 *  some of it already — the stats slow path's "Scanning…" placeholder is exactly that), and that
 *  rejection must not escape this command's listener. */
async function respondResult(
  ctx: SlackContext,
  respond: RespondFn,
  result: CommandResult,
  replaceOriginal = false,
): Promise<void> {
  const chunks = slackChunks(toMrkdwn(resultToMarkdown(result)));
  const omitted = chunks.length - MAX_REPLY_CHUNKS;
  const sendable = omitted > 0 ? chunks.slice(0, MAX_REPLY_CHUNKS) : chunks;
  for (const [index, chunk] of sendable.entries()) {
    const isLast = index === sendable.length - 1;
    try {
      await respond({
        text: isLast && omitted > 0 ? withOmittedMarker(chunk, omitted) : chunk,
        // These can carry account labels and real token figures — never in_channel, the same
        // reasoning every Discord reply here is ephemeral for.
        response_type: 'ephemeral',
        ...(index === 0 && replaceOriginal ? { replace_original: true } : {}),
      });
    } catch (err) {
      // A later chunk's response_url call can fail on its own (Slack's per-command budget
      // exhausted, or the token simply expired) independently of whether earlier chunks landed —
      // log and stop rather than let it escape this listener or keep retrying a dead endpoint.
      ctx.logger.warn({ err, index }, 'slack: failed to send a command-reply chunk');
      return;
    }
  }
}

/** `CommandResult` → the SAME markdown vocabulary embeds.ts already writes into descriptions and
 *  field values (`**bold**`, `_italic_`, fenced code) — `toMrkdwn` is what turns that into real
 *  Slack mrkdwn. Slack has no embed concept, so the `embed` branch is the necessary "what would
 *  this look like as text" step every read subcommand (`usage`, `accounts`, `sessions`, `stats`,
 *  …) needs, since all of them answer with an `EmbedBuilder` today. `components` (Discord button
 *  specs, e.g. prune's confirm control) map to no subcommand here and are silently dropped — a
 *  Slack-native equivalent is Block Kit interactivity's job, not this text path's. */
function resultToMarkdown(result: CommandResult): string {
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'error':
      return `Error: ${result.message}`;
    case 'embed': {
      const { title, description, fields, footer } = result.embed.data;
      const parts: string[] = [];
      if (title) parts.push(`**${title}**`);
      if (description) parts.push(description);
      for (const field of fields ?? []) parts.push(`**${field.name}**\n${field.value}`);
      if (footer?.text) parts.push(`_${footer.text}_`);
      return parts.length > 0 ? parts.join('\n\n') : '(empty)';
    }
  }
}

function helpResult(): CommandResult {
  return {
    kind: 'text',
    text: `Unknown command. Available: ${SUBCOMMANDS.map((c) => `\`${c}\``).join(', ')}.`,
  };
}

function commandDepsFrom(ctx: SlackContext): CommandDeps {
  return { relay: ctx.relay, pairing: ctx.pairing, cache: ctx.cache };
}

/** First whitespace-delimited token and the untouched remainder. What every argument string is
 *  parsed from: the subcommand off the top-level command text, `<sessionId>` off `say`'s and
 *  `stop`'s argument string. Internal whitespace in the remainder survives verbatim — `say`'s
 *  text argument may be meaningfully formatted. */
function splitFirstWord(text: string): [string, string] {
  const trimmed = text.trim();
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return [trimmed, ''];
  return [trimmed.slice(0, idx), trimmed.slice(idx + 1).trimStart()];
}

/** `/cctl run [cwd:<path>] [resume:<sessionId>] <prompt>` — Slack has no structured slash-command
 *  options (unlike Discord's `/run prompt: cwd: resume:` fields), so the same two optional knobs
 *  are read off leading `key:value` tokens ahead of the prompt, in either order. Everything from
 *  the first token that isn't one of those onward is the prompt — so a prompt that itself starts
 *  with literal `cwd:` or `resume:` cannot be expressed this way, the one tradeoff this scheme
 *  makes for staying option-free. */
function parseRunArgs(rest: string): { opts: RunOptions; prompt: string } {
  const tokens = rest.length === 0 ? [] : rest.split(' ');
  let cwd: string | undefined;
  let resumeSessionId: string | undefined;
  let i = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const cwdMatch = /^cwd:(.+)$/.exec(token);
    if (cwdMatch !== null) {
      cwd = cwdMatch[1];
      continue;
    }
    const resumeMatch = /^resume:(.+)$/.exec(token);
    if (resumeMatch !== null) {
      resumeSessionId = resumeMatch[1];
      continue;
    }
    break;
  }
  return {
    prompt: tokens.slice(i).join(' ').trim(),
    opts: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    },
  };
}

/** What `/cctl stats [days:N]` asked for. `invalid` covers both a malformed token (anything other
 *  than exactly `days:<digits>`) and an in-range-checked-out-of-range value — Discord's slash
 *  command declares `days` with `setMinValue`/`setMaxValue` so the client rejects those before
 *  they reach a handler; Slack's freeform text has no such client-side gate, so this is the only
 *  place that bound is enforced on this surface. */
type StatsArg = { kind: 'none' } | { kind: 'days'; value: number } | { kind: 'invalid' };

function parseStatsArg(rest: string): StatsArg {
  const trimmed = rest.trim();
  if (trimmed === '') return { kind: 'none' };
  const match = /^days:(\d+)$/.exec(trimmed);
  if (match === null) return { kind: 'invalid' };
  const raw = match[1];
  if (raw === undefined) return { kind: 'invalid' };
  const value = Number(raw);
  if (value < MIN_STATS_DAYS || value > MAX_STATS_DAYS) return { kind: 'invalid' };
  return { kind: 'days', value };
}
