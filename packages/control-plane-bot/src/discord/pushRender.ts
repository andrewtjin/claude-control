// Pure "which daemon push is worth a DM, and how does it render" decision.
//
// This is the logic the live-boundary gateway used to hold inline. Pulling it here makes every
// routing decision — mode-aware permission cards, the done/waiting/quarantine lifecycle cards,
// which envelopes are cache-only — unit-testable off plain envelopes, leaving discordJsGateway
// as nothing but "call renderPush, turn the ButtonSpecs into components, send it".

import { isType, type Envelope, type PayloadOf } from '@claude-control/shared-protocol';
import type { EmbedBuilder } from 'discord.js';
import {
  buildDoneEmbed,
  buildPermissionRequestEmbed,
  buildQuarantineEmbed,
  buildSwitchResultEmbed,
  buildToolOutputEmbed,
  buildWaitingEmbed,
} from './embeds.js';
import { permissionButtons, type ButtonSpec } from './buttons.js';
import { MESSAGE_CONTENT_LIMIT, truncateLabeled } from './richFormat.js';

/** A text file to attach to the message — the same delivery session threads use for full
 *  stdout. Plain data (no discord.js types) so this module stays unit-testable; the gateway
 *  inflates it into an AttachmentBuilder. */
export interface PushFile {
  filename: string;
  text: string;
}

/** One rendered push. `undefined` from `renderPush` means cache-only: the envelope updated
 *  DaemonStateCache but is not worth interrupting the user's phone for (raw stdout, snapshots
 *  they can pull with `/usage`, socket control frames). `components` are plain ButtonSpecs the
 *  gateway inflates into discord.js rows. */
export interface RenderedPush {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ButtonSpec[][];
  files?: PushFile[];
}

/** The single source of truth for the host re-login command, shared by the quarantine card and
 *  `handleReauth` so the two can never print different instructions. `cctl accounts relogin`
 *  re-captures credentials into the EXISTING vault entry (same account id, quarantine cleared),
 *  so usage attribution survives — unlike `accounts add --fresh`, which mints a new id. */
export const RELOGIN_COMMAND = 'cctl accounts relogin <label>';

/** Map one daemon-originated envelope to what the bot should DM, or `undefined` for cache-only. */
export function renderPush(envelope: Envelope): RenderedPush | undefined {
  if (isType(envelope, 'permission.request')) {
    const p = envelope.payload;
    const detail = p.detail ?? undefined;
    const mode = p.permissionMode ?? undefined;
    const embed = buildPermissionRequestEmbed(p.summary, detail, mode);
    // Buttons ship in every permission mode: this envelope only exists while the daemon holds
    // the hook response open for a remote decision (see permissionButtons), so a tap always
    // takes effect honestly; the mode is context on the embed, not a gate.
    return { embeds: [embed], components: permissionButtons({ requestId: p.requestId }) };
  }
  if (isType(envelope, 'hook.notification')) {
    return renderNotification(envelope.payload);
  }
  if (isType(envelope, 'switch.result')) {
    return { embeds: [buildSwitchResultEmbed(envelope.payload.ok, envelope.payload.message)] };
  }
  if (isType(envelope, 'session.output')) {
    // Raw stdout is far too high-volume to DM; milestones/summaries/errors are worth it.
    if (envelope.payload.kind === 'stdout') return undefined;
    return { content: envelope.payload.text };
  }
  if (isType(envelope, 'error')) {
    // A protocol `error` envelope is the daemon telling the phone something explicitly failed
    // (e.g. a `/stop` for an unknown/not-yet-live session). Without a visible render it is dropped
    // (DaemonStateCache ignores it) and the Stop button keeps showing "Stop requested" forever.
    // Surface it as a DM, clamped to the content ceiling so a long message can't get the send
    // rejected (which would re-hide it).
    const { code, message } = envelope.payload;
    return {
      content: truncateLabeled(`⚠️ Daemon error (${code}): ${message}`, MESSAGE_CONTENT_LIMIT),
    };
  }
  return undefined; // usage.snapshot / settings.snapshot / session.status / pair.result / control frames: cache-only
}

/** hook.notification → the right lifecycle card. Stop always wins (it carries the final message);
 *  otherwise the tolerant `notificationType` string selects tool-output/waiting/quarantine, and
 *  anything unknown falls back to the generic title/body content an N-1 bot would also show. */
function renderNotification(p: PayloadOf<'hook.notification'>): RenderedPush {
  if (p.event === 'stop') {
    return {
      embeds: [
        buildDoneEmbed({
          ...(p.sessionId != null ? { sessionId: p.sessionId } : {}),
          ...(p.lastAssistantMessage != null
            ? { lastAssistantMessage: p.lastAssistantMessage }
            : {}),
          body: p.body,
          title: p.title,
        }),
      ],
    };
  }
  switch (p.notificationType) {
    case 'tool_output': {
      // Compact by design: full-length fenced messages were flooding the DM, so the card is
      // a fixed-height embed — a glanceable preview behind a fence, the origin tag in the
      // footer, and the COMPLETE raw text as a .txt attachment the reader taps to expand
      // (a real file needs no fence defusing). Embedded ``` sequences in the preview are
      // defused with a zero-width space so output text cannot terminate its own fence.
      const zeroWidthSpace = String.fromCharCode(0x200b);
      const safeBody = p.body.replaceAll('```', '`' + zeroWidthSpace + '``');
      const { text: preview, clipped } = previewOf(safeBody);
      const tag = sessionTag(p);
      const embed = buildToolOutputEmbed({
        title: p.title,
        preview,
        attached: clipped,
        totalChars: p.body.length,
        ...(tag !== '' ? { footer: tag } : {}),
      });
      return clipped
        ? { embeds: [embed], files: [{ filename: 'output.txt', text: p.body }] }
        : { embeds: [embed] };
    }
    case 'idle_prompt':
      return {
        embeds: [
          buildWaitingEmbed({
            ...(p.sessionId != null ? { sessionId: p.sessionId } : {}),
            title: p.title,
            body: p.body,
          }),
        ],
      };
    case 'quarantine':
      return {
        embeds: [
          buildQuarantineEmbed({ title: p.title, body: p.body, reloginCommand: RELOGIN_COMMAND }),
        ],
      };
    default:
      return { content: `**${p.title}**\n${p.body}` };
  }
}

/** How much output the card shows inline: enough lines to glance at, never enough to flood
 *  a DM. Anything past this rides in the tap-to-expand attachment. */
const PREVIEW_MAX_LINES = 6;
const PREVIEW_MAX_CHARS = 300;

/** Clamp output to the card's glanceable preview: the first lines up to both caps, with a
 *  visible continuation mark when anything was cut (`clipped` tells the caller to attach the
 *  full text). */
function previewOf(text: string): { text: string; clipped: boolean } {
  let head = text.split('\n').slice(0, PREVIEW_MAX_LINES).join('\n');
  if (head.length > PREVIEW_MAX_CHARS) head = head.slice(0, PREVIEW_MAX_CHARS);
  if (head === text) return { text, clipped: false };
  return { text: `${head.trimEnd()}\n…`, clipped: true };
}

/** "<folder> · <session prefix>" — the output card's footer, tying the card to the window
 *  that produced it. Several CLI windows can stream shell output at once, and untagged cards
 *  are indistinguishable on a phone: the working directory's basename is the human-meaningful
 *  origin, and the session-id prefix splits two windows running in the same directory. Either
 *  part may be absent (older daemon, internal sender) — the tag shrinks instead of guessing,
 *  down to the empty string (no footer). */
function sessionTag(p: PayloadOf<'hook.notification'>): string {
  // Hooks report native paths — split on both separators so Windows and POSIX paths both
  // yield a basename, and drop empty segments so a trailing separator can't blank the folder.
  const folder = p.cwd
    ?.split(/[\\/]/)
    .filter((segment) => segment !== '')
    .pop();
  const parts = [folder, p.sessionId?.slice(0, 8)].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.join(' · ');
}
