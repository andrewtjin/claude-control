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
      // A tool run's output. Rendered as a fenced code block so multi-line command output
      // stays readable on a phone; the body is clamped BEFORE assembly so truncation can
      // never eat the closing fence and leave the block unterminated. Embedded ``` sequences
      // are defused with a zero-width space — output text must not be able to terminate its
      // own fence.
      const header = `**${p.title}**${sessionTag(p)}\n`;
      const fenceOverhead = '```\n\n```'.length;
      const zeroWidthSpace = String.fromCharCode(0x200b);
      const safeBody = p.body.replaceAll('```', '`' + zeroWidthSpace + '``');
      const maxBody = Math.max(0, MESSAGE_CONTENT_LIMIT - header.length - fenceOverhead);
      if (safeBody.length > maxBody) {
        // Too big for one message (the daemon ships more than this only when full output is
        // enabled): the COMPLETE raw text rides as a .txt attachment under a clamped inline
        // preview, so nothing is lost to Discord's content ceiling. The file gets the raw
        // body — a real file needs no fence defusing.
        return {
          content: `${header}\`\`\`\n${truncateLabeled(safeBody, maxBody)}\n\`\`\``,
          files: [{ filename: 'output.txt', text: p.body }],
        };
      }
      return { content: `${header}\`\`\`\n${safeBody}\n\`\`\`` };
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

/** " · <folder> · <session prefix>" appended to an output card's header. Several CLI windows
 *  can stream shell output at once, and untagged cards are indistinguishable on a phone: the
 *  working directory's basename is the human-meaningful origin, and the session-id prefix
 *  splits two windows running in the same directory. Either part may be absent (older daemon,
 *  internal sender) — the tag shrinks instead of guessing, down to nothing. */
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
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
}
