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

/** One rendered push. `undefined` from `renderPush` means cache-only: the envelope updated
 *  DaemonStateCache but is not worth interrupting the user's phone for (raw stdout, snapshots
 *  they can pull with `/usage`, socket control frames). `components` are plain ButtonSpecs the
 *  gateway inflates into discord.js rows. */
export interface RenderedPush {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ButtonSpec[][];
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
    const components = permissionButtons({
      requestId: p.requestId,
      permissionMode: p.permissionMode,
    });
    // Only attach a components array when there ARE buttons — an empty row array would render as
    // a stray empty action bar.
    return components.length > 0 ? { embeds: [embed], components } : { embeds: [embed] };
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
 *  otherwise the tolerant `notificationType` string selects waiting/quarantine, and anything
 *  unknown falls back to the generic title/body content an N-1 bot would also show. */
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
