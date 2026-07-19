// Pure embed builders: cached protocol state -> discord.js EmbedBuilder.
//
// No network calls, no Interaction objects — every function here is a straight data
// transform, which is what makes it unit-testable via `.toJSON()` without a real bot.

import { EmbedBuilder, type APIEmbed } from 'discord.js';
import type {
  AccountUsage,
  PayloadOf,
  SettingsSnapshot,
  UsagePlan,
} from '@claude-control/shared-protocol';
// usage-advisor is a pure, credential-free library — importing it preserves the bot's
// zero-credential guarantee (which forbids switch-engine, not math).
import {
  computeOutlook,
  timelineInputFromWire,
  type ResetOutlook,
} from '@claude-control/usage-advisor';
import type { SessionStatus } from './stateCache.js';
import {
  accountMarker,
  discordRelative,
  EMBED_DESCRIPTION_LIMIT,
  EMBED_FIELD_VALUE_LIMIT,
  layeredBar,
  NOTIFICATION_COLOR,
  NOTIFICATION_ICON,
  SEVERITY_COLOR,
  truncateLabeled,
  UNICODE_TRACK_STYLE,
  worstSeverity,
  type TimelineTrackStyle,
  type TrackEvent,
} from './richFormat.js';
import type { BarRenderer } from './emojiBars.js';

const COLOR_OK = 0x2ecc71;
const COLOR_WARN = 0xf1c40f;
const COLOR_INFO = 0x3498db;
/** A dead card's accent: neither a warning (COLOR_WARN, still awaiting a tap) nor an error —
 *  just inert. Used only by `buildLapsedPermissionEmbed`, so a lapsed card reads as visibly
 *  different from a live one at a glance, before the reader even parses the new title. */
const COLOR_MUTED = 0x95a5a6;

// The default bar renderer is the credential-free unicode `layeredBar`. It is injected as an
// optional parameter (not hidden module state) so these builders stay PURE and every existing
// call site — and every test — keeps getting unicode bars untouched. The gateway swaps in the
// emoji renderer at runtime only after `ensureProgressEmojis` succeeds (see discordJsGateway).
// A parameter beats a module-level mutable/setter here because it keeps the "which bar?"
// decision explicit at the call site and leaves the functions trivially unit-testable.
export const DEFAULT_BAR_RENDERER: BarRenderer = layeredBar;

/** Render a field value with the preferred (possibly emoji) renderers, falling back to the
 *  unicode renderers when the result would cross Discord's per-field ceiling. A custom-emoji
 *  mention (`<:name:id>`) costs ~25 chars of that budget where a unicode cell costs 1, so an
 *  emoji bar-plus-track field can overflow where its unicode twin fits easily — and
 *  discord.js rejects the WHOLE message over one over-long field. Clamps as the last resort:
 *  a plainer bar beats a dead slash command. */
function fitFieldValue(render: (unicodeFallback: boolean) => string): string {
  const preferred = render(false);
  if (preferred.length <= EMBED_FIELD_VALUE_LIMIT) return preferred;
  return truncateLabeled(render(true), EMBED_FIELD_VALUE_LIMIT);
}

/** Embed accent color for a usage snapshot: the worst severity across every limit of
 *  every account, or neutral blue when no limit data exists yet. */
function usageColor(accounts: AccountUsage[]): number {
  const percents = accounts.flatMap((a) => a.limits.map((l) => l.percent));
  return percents.length === 0 ? COLOR_INFO : SEVERITY_COLOR[worstSeverity(percents)];
}

/** Render one account's limits as progress bars, one line per limit:
 *  "🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ session 42% · resets <t:...:R>". `bar` is the injected renderer
 *  (unicode by default, emoji at runtime). */
function formatLimits(account: AccountUsage, nowMs: number, bar: BarRenderer): string {
  if (account.limits.length === 0) return 'no limit data';
  return account.limits
    .map((l) => {
      const resetMs = l.resetsAt != null ? Date.parse(l.resetsAt) : NaN;
      const reset =
        Number.isFinite(resetMs) && resetMs > nowMs ? ` · resets ${discordRelative(resetMs)}` : '';
      return `${bar(l.percent)} ${l.kind.replace(/_/g, ' ')} ${Math.round(l.percent)}%${reset}`;
    })
    .join('\n');
}

/** `/usage` — the full table plus, when the daemon has computed one, the burn-down
 *  advisor's recommendation and any active advisories. */
export function buildUsageEmbed(
  usage: {
    accounts: AccountUsage[];
    plan?: UsagePlan;
  },
  nowMs = Date.now(),
  barRenderer: BarRenderer = DEFAULT_BAR_RENDERER,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Usage').setColor(usageColor(usage.accounts));
  if (usage.accounts.length === 0) {
    embed.setDescription('No accounts reported yet.');
  }
  const outlook = computeOutlook(timelineInputFromWire(usage.accounts), nowMs);
  for (const account of usage.accounts) {
    // Signal differences at a glance: 🟢 active / ⚪ idle / ⚠️ erroring, plus a cached-data
    // marker so a stale tier-0 snapshot is never mistaken for a live read.
    const marker = `${accountMarker(account)} ${account.active ? 'active' : 'idle'}`;
    // Cached data carries its true fetch time — show it, so an hours-old number can never
    // masquerade as current (the timestamp renders as a live-updating "N minutes ago").
    const cached =
      account.source === 'cached' ? ` · cached ${discordRelative(account.fetchedAtMs)}` : '';
    const errorLine = account.error ? `\n⚠️ ${account.error}` : '';
    embed.addFields({
      name: `${account.label} — ${marker}${cached}`,
      value: fitFieldValue(
        (unicodeFallback) =>
          `${formatLimits(account, nowMs, unicodeFallback ? DEFAULT_BAR_RENDERER : barRenderer)}${windowsLine(outlook, account.accountId)}${errorLine}`,
      ),
    });
  }
  if (usage.plan) {
    // One compact field: the reason line already carries the whole burn order (see the
    // advisor), and advisories only exist for exceptional states — no separate headings.
    const lines = [usage.plan.reason, ...usage.plan.advisories.map((a) => `• ${a.message}`)];
    embed.addFields({
      name: 'Plan',
      value: truncateLabeled(lines.join('\n'), EMBED_FIELD_VALUE_LIMIT),
    });
  }
  return embed;
}

/** "12×5h windows left · weekly resets <t:...:R>" — the session budget line appended to
 *  an account's `/usage` field, or empty when no weekly reset time is known. Uses a native
 *  timestamp so the line stays truthful even in old messages in the chat scrollback. */
function windowsLine(outlook: ResetOutlook, accountId: string): string {
  const budget = outlook.accounts.find((a) => a.accountId === accountId)?.budget;
  if (!budget) return '';
  return (
    `\n${budget.fullWindows}×5h window${budget.fullWindows === 1 ? '' : 's'} left` +
    ` · weekly resets ${discordRelative(budget.weeklyResetAt)}`
  );
}

/** `/timeline` — the 5h-window budget and cross-account reset timeline, fully rendered
 *  as rich Discord markdown (no code block): layered emoji session bars, proportional
 *  emoji tracks that align because emoji are uniform-width, and native `<t:...:R>`
 *  timestamps that localize and live-update on the phone. The daemon-computed plan
 *  (quarantine-aware) rides along when the snapshot has one — the bot never recomputes
 *  advice from its own clock. */
export function buildTimelineEmbed(
  usage: {
    accounts: AccountUsage[];
    plan?: UsagePlan;
  },
  nowMs = Date.now(),
  barRenderer: BarRenderer = DEFAULT_BAR_RENDERER,
  trackStyle: TimelineTrackStyle = UNICODE_TRACK_STYLE,
): EmbedBuilder {
  const outlook = computeOutlook(timelineInputFromWire(usage.accounts), nowMs);
  const embed = new EmbedBuilder().setTitle('Reset timeline').setColor(usageColor(usage.accounts));
  if (outlook.accounts.length === 0) {
    return embed.setDescription('No accounts reported yet.');
  }

  // One shared span (now → last known reset) so every account's track uses the same
  // time scale and dots align vertically across fields.
  const lastEvent = outlook.events[outlook.events.length - 1];
  const spanMs = lastEvent ? Math.max(lastEvent.atMs - nowMs, 1) : 0;
  embed.setDescription(
    lastEvent
      ? `Track spans now → ${discordRelative(lastEvent.atMs)} · ${trackStyle.session} 5h window · ${trackStyle.weekly} weekly · ${trackStyle.both} both`
      : 'No reset times reported yet — wait for the next daemon poll.',
  );

  for (const a of outlook.accounts) {
    const accountLines = (bar: BarRenderer, style: TimelineTrackStyle): string => {
      const lines: string[] = [];
      if (a.quarantined) {
        lines.push('🚫 quarantined — re-login required');
      } else if (a.openWindowEndsAt !== undefined) {
        lines.push(
          `${bar(a.sessionPercent ?? 0)} window open · ${a.sessionPercent ?? 0}% used · resets ${discordRelative(a.openWindowEndsAt)}`,
        );
      } else {
        lines.push('no open 5h window');
      }
      if (a.budget) {
        lines.push(
          `${a.budget.fullWindows}×5h window${a.budget.fullWindows === 1 ? '' : 's'} left` +
            `${a.budget.hasPartialWindow ? ' +1 partial' : ''}` +
            ` · weekly resets ${discordRelative(a.budget.weeklyResetAt)}`,
        );
      } else if (!a.quarantined) {
        lines.push('weekly reset time unknown');
      }
      if (spanMs > 0) {
        const events: TrackEvent[] = outlook.events
          .filter((e) => e.accountId === a.accountId)
          .map((e) => ({ atMs: e.atMs, kind: e.kind === 'session' ? 'session' : 'weekly' }));
        if (events.length > 0) lines.push(style.track(events, nowMs, spanMs));
      }
      return lines.join('\n');
    };
    embed.addFields({
      name: `${accountMarker(a)} ${a.label}`,
      value: fitFieldValue((unicodeFallback) =>
        unicodeFallback
          ? accountLines(DEFAULT_BAR_RENDERER, UNICODE_TRACK_STYLE)
          : accountLines(barRenderer, trackStyle),
      ),
    });
  }

  if (outlook.events.length > 0) {
    const upcoming = (style: TimelineTrackStyle): string =>
      outlook.events
        .map((e) => {
          const mark = e.kind === 'session' ? style.session : style.weekly;
          return `${mark} ${discordRelative(e.atMs)} — **${e.label}** · ${describeEvent(e.kind, e.percentUsed)}`;
        })
        .join('\n');
    embed.addFields({
      name: 'Upcoming resets',
      value: fitFieldValue((unicodeFallback) =>
        upcoming(unicodeFallback ? UNICODE_TRACK_STYLE : trackStyle),
      ),
    });
  }

  if (usage.plan) {
    const planLines = [usage.plan.reason];
    for (const adv of usage.plan.advisories) planLines.push(`• ${adv.message}`);
    embed.addFields({
      name: 'Plan',
      value: truncateLabeled(planLines.join('\n'), EMBED_FIELD_VALUE_LIMIT),
    });
  }
  return embed;
}

/** What a reset means for planning: a session reset frees the window; a weekly reset
 *  wastes whatever headroom went unburned — that asymmetry is the "use them efficiently"
 *  signal (same semantics as the CLI's text renderer). */
function describeEvent(kind: string, percentUsed: number): string {
  if (kind === 'session') return `5h window resets (${percentUsed}% used clears)`;
  const scoped = kind === 'weekly_scoped' ? 'weekly (scoped)' : 'weekly';
  const unused = 100 - percentUsed;
  return unused > 0
    ? `${scoped} quota resets — ${unused}% unused expires`
    : `${scoped} quota resets`;
}

/** `/accounts` — a lighter listing than `/usage`: which accounts exist and whether each is
 *  live or cached, without the full limit table. */
export function buildAccountsEmbed(accounts: AccountUsage[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Accounts').setColor(COLOR_INFO);
  if (accounts.length === 0) {
    embed.setDescription('No accounts reported yet.');
    return embed;
  }
  for (const account of accounts) {
    embed.addFields({
      name: `${accountMarker(account)} ${account.label}`,
      value: `${account.active ? 'active' : 'idle'} · source: ${account.source}`,
    });
  }
  return embed;
}

/** `/sessions` — every session the daemon has reported a status for, most-recent value per
 *  session id (the cache overwrites, never appends). */
/** `/settings` — the daemon's effective configuration. One line per knob; the source is
 *  only called out when it is an explicit override (env/flag), so silent defaults read as
 *  quiet and deliberate choices pop. */
export function buildSettingsEmbed(snapshot: SettingsSnapshot): EmbedBuilder {
  const lines = snapshot.settings.map((s) => {
    const source = s.source === 'default' ? '' : ` _(via ${s.source})_`;
    return `**${s.name}** — ${s.value}${source}`;
  });
  return new EmbedBuilder()
    .setTitle('Daemon settings')
    .setColor(COLOR_INFO)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'as of daemon start' })
    .setTimestamp(snapshot.startedAtMs);
}

export function buildSessionListEmbed(sessions: SessionStatus[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Sessions').setColor(COLOR_INFO);
  if (sessions.length === 0) {
    embed.setDescription('No sessions reported yet.');
    return embed;
  }
  for (const session of sessions) {
    const summaryLine = session.summary ? ` — ${session.summary}` : '';
    embed.addFields({ name: session.sessionId, value: `${session.state}${summaryLine}` });
  }
  return embed;
}

/** Rendered for an incoming permission.request push — actionable in EVERY permission mode.
 *  This card only exists while the daemon is holding the hook's HTTP response open for a
 *  remote decision, and the CLI only fires that hook when it is actually blocking on a prompt
 *  (accept-edits auto-approves file edits but still prompts for shell commands), so
 *  Approve/Deny always take effect honestly. A non-default mode is shown in the footer as
 *  context, never as a reason to withhold the controls. The buttons themselves are attached by
 *  the caller (pushRender), which owns the requestId; this function only sets the copy so the
 *  card and its buttons agree. `summary` is the description so the reader always sees WHAT was
 *  requested. */
export function buildPermissionRequestEmbed(
  summary: string,
  detail?: string,
  permissionMode?: string,
): EmbedBuilder {
  const modeNote =
    permissionMode !== undefined && permissionMode !== 'default' ? ` · ${permissionMode} mode` : '';
  const embed = new EmbedBuilder()
    .setTitle('Permission requested')
    .setColor(COLOR_WARN)
    .setDescription(summary)
    .setFooter({ text: `Approve or Deny below · or /approve /deny${modeNote}` });
  if (detail)
    embed.addFields({ name: 'Detail', value: truncateLabeled(detail, EMBED_FIELD_VALUE_LIMIT) });
  return embed;
}

/** Human title per lapse reason — the phone reader's only cue for WHY the buttons died, since
 *  the daemon-side wire reason string is never shown verbatim. */
const LAPSE_TITLE: Record<PayloadOf<'permission.lapsed'>['reason'], string> = {
  local: 'Handled at the terminal',
  expired: 'Expired — answer at the terminal',
  shutdown: 'Daemon stopped',
};

/** Rendered for a permission.lapsed push: the hold ended without a phone decision, so the card
 *  must stop claiming its Approve/Deny buttons still work. Keeps whatever the ORIGINAL card
 *  said (summary, detail, footer) — the reader should still be able to see WHAT was asked —
 *  and only swaps the title and accent color; the caller strips the button components
 *  separately (`components: []` on the edit), since that lives in the message payload, not the
 *  embed. `original` is the live card's embed data as read back from Discord (this side never
 *  stores a copy of the request text, only the message reference) — `undefined` when the
 *  message somehow had no embed, which still produces a valid, if bare, card. */
export function buildLapsedPermissionEmbed(
  reason: PayloadOf<'permission.lapsed'>['reason'],
  original?: APIEmbed,
): EmbedBuilder {
  const embed = original ? EmbedBuilder.from(original) : new EmbedBuilder();
  return embed.setTitle(LAPSE_TITLE[reason]).setColor(COLOR_MUTED);
}

/** A completed tool run's output as a COMPACT card: a glanceable few-line preview fenced in
 *  the description, the origin tag (folder · session) as the footer, and — when the preview
 *  was clipped — a note pointing at the .txt attachment the reader taps to expand (the caller
 *  ships the file). Replaces a full-length fenced message: busy sessions were flooding the
 *  DM, so the card keeps a stable, small height and the detail lives one tap away. */
export function buildToolOutputEmbed(p: {
  title: string;
  preview: string;
  attached: boolean;
  totalChars: number;
  footer?: string;
}): EmbedBuilder {
  const attachedNote = p.attached
    ? `\n📎 full output attached (${p.totalChars} chars) — tap to expand`
    : '';
  const embed = new EmbedBuilder()
    .setTitle(truncateLabeled(p.title, 256))
    .setColor(COLOR_INFO)
    .setDescription(`\`\`\`\n${p.preview}\n\`\`\`${attachedNote}`);
  if (p.footer !== undefined && p.footer !== '') embed.setFooter({ text: p.footer });
  return embed;
}

/** `hook.notification` Stop event → the "done" card: WHAT Claude finished saying, not a bare
 *  "session ended". `lastAssistantMessage` can be long, so it is truncated with a visible marker
 *  (no silent cut). Falls back to the daemon-supplied body when no final message was captured. */
export function buildDoneEmbed(p: {
  sessionId?: string;
  lastAssistantMessage?: string;
  body?: string;
  title?: string;
}): EmbedBuilder {
  const message = p.lastAssistantMessage ?? p.body ?? 'Session finished.';
  const embed = new EmbedBuilder()
    .setTitle(`${NOTIFICATION_ICON.done} ${p.title ?? 'Done'}`)
    .setColor(NOTIFICATION_COLOR.done)
    .setDescription(truncateLabeled(message, EMBED_DESCRIPTION_LIMIT));
  if (p.sessionId) embed.addFields({ name: 'Session', value: p.sessionId });
  return embed;
}

/** `hook.notification` with `notification_type: 'idle_prompt'` → the "waiting on you" card: the
 *  session is blocked awaiting the user's next input. Distinct blue/🔔 language so it reads as
 *  "your turn", never as an error or a completion. */
export function buildWaitingEmbed(p: {
  sessionId?: string;
  title?: string;
  body?: string;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${NOTIFICATION_ICON.waiting} ${p.title ?? 'Waiting on you'}`)
    .setColor(NOTIFICATION_COLOR.waiting)
    .setDescription(
      truncateLabeled(
        p.body && p.body.length > 0 ? p.body : 'A session is waiting for your reply.',
        EMBED_DESCRIPTION_LIMIT,
      ),
    );
  if (p.sessionId) embed.addFields({ name: 'Session', value: p.sessionId });
  return embed;
}

/** A quarantine notice → the "account down" card. Re-authentication is an interactive OAuth flow
 *  that can only complete on the host (the bot holds zero credentials by design), so the card's
 *  whole job is to name the account and print the EXACT host command to run. `reloginCommand` is
 *  injected (from pushRender's single source of truth) so the card, `handleReauth`, and the real
 *  CLI verb can never drift apart. */
export function buildQuarantineEmbed(p: {
  title?: string;
  body?: string;
  reloginCommand: string;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${NOTIFICATION_ICON.quarantine} ${p.title ?? 'Account needs re-login'}`)
    .setColor(NOTIFICATION_COLOR.quarantine)
    .setDescription(
      truncateLabeled(
        p.body && p.body.length > 0
          ? p.body
          : 'An account can no longer refresh its token and was quarantined.',
        EMBED_DESCRIPTION_LIMIT,
      ),
    )
    .addFields({
      name: 'Fix it on the host',
      value: `Run \`${p.reloginCommand}\` to restore the account, then \`cctl switch <label>\`.`,
    });
  return embed;
}

/** Rendered for an incoming switch.result push. */
export function buildSwitchResultEmbed(ok: boolean, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(ok ? 'Switched' : 'Switch failed')
    .setColor(ok ? COLOR_OK : COLOR_WARN)
    .setDescription(message);
}

// ---------------------------------------------------------------------------
// Managed-session live card + final summary (thread-per-session UX)
// ---------------------------------------------------------------------------

/** The session lifecycle states, as the wire reports them (see `session.status`). */
type SessionState = PayloadOf<'session.status'>['state'];

/** Per-state icon + accent so the live card reads at a phone-glance which stage the session is in.
 *  Deliberately distinct from the usage `SEVERITY_COLOR` gradient — a session card is an *event
 *  surface*, not a *measurement*, so it must never be mistaken for a usage band. */
const SESSION_STATE_ICON: Record<SessionState, string> = {
  starting: '⏳',
  running: '🔄',
  waiting_input: '🔔',
  waiting_permission: '🔐',
  done: '✅',
  failed: '❌',
  orphaned: '🧟',
};
const SESSION_STATE_COLOR: Record<SessionState, number> = {
  starting: COLOR_INFO,
  running: COLOR_INFO,
  waiting_input: COLOR_INFO,
  waiting_permission: COLOR_WARN,
  done: COLOR_OK,
  failed: SEVERITY_COLOR.critical,
  orphaned: SEVERITY_COLOR.critical,
};

/** The pure, discord.js-free shape a session card renders from. Assembled by the SessionPlanner
 *  from its accumulated per-session state; kept here (not in the planner) so embeds.ts stays the
 *  single home for embed layout and the planner needs no discord.js beyond the returned builder. */
export interface SessionCardModel {
  sessionId: string;
  state: SessionState;
  /** Optimistic bot-side flag: the user asked to stop and no terminal status has landed yet.
   *  Overrides the state icon/label with a "stopping…" affordance so the card never looks idle
   *  while a stop is in flight. */
  stopping: boolean;
  summary?: string;
  accountId?: string;
  /** The tail of accumulated stdout, already sliced by the planner to a phone-friendly length. */
  outputTail?: string;
  totalOutputChars: number;
  /** The full output has been (or is being) delivered as a file attachment. */
  attached: boolean;
  /** At least one seq gap was declared — the transcript has a labeled hole, shown honestly. */
  hasGap: boolean;
  /** A source truncated its own output somewhere in the stream. */
  sourceTruncated: boolean;
  /** At least one `error`-kind chunk was streamed. */
  hadError: boolean;
}

/** Compose the "notes" line shown on both the live card and the summary — the honesty markers the
 *  plan requires (attachment present, gap declared, source truncation) never rendered silently. */
function sessionNotes(model: SessionCardModel): string | undefined {
  const notes: string[] = [];
  if (model.attached) notes.push('📎 full output attached');
  if (model.hasGap) notes.push('⚠️ output has a gap (some chunks were lost)');
  if (model.sourceTruncated) notes.push('⚠️ a source truncated its own output');
  if (model.hadError) notes.push('❗ errors were emitted');
  return notes.length > 0 ? notes.join('\n') : undefined;
}

/** The live, edited-in-place card for one managed session. One of these per session is created on
 *  the first status/output and re-rendered (via an edit) as the session progresses. The stdout
 *  tail is fenced as a code block for monospaced readability; it is bounded by the caller and
 *  additionally clamped here so an over-long tail can never make discord.js reject the edit. */
export function buildSessionCardEmbed(model: SessionCardModel): EmbedBuilder {
  const icon = model.stopping ? '🛑' : SESSION_STATE_ICON[model.state];
  const label = model.stopping ? 'stopping…' : model.state.replace(/_/g, ' ');
  const embed = new EmbedBuilder()
    .setTitle(`${icon} Session ${label}`)
    .setColor(model.stopping ? COLOR_WARN : SESSION_STATE_COLOR[model.state]);

  const rawBody =
    model.summary ??
    (model.stopping ? 'Stop requested — waiting for the session to end.' : undefined);
  // Hard-cap the body (a session summary is short; the cap defends the card against a runaway one)
  // then reserve its length so the fenced tail below can never push the description over the limit.
  const prefix = rawBody ? `${truncateLabeled(rawBody, 512)}\n` : '';
  const tail = model.outputTail;
  if (tail && tail.length > 0) {
    const fenceOverhead = '```\n'.length + '\n```'.length; // fence wrapping the inner text
    const inner = truncateLabeled(
      tail,
      Math.max(16, EMBED_DESCRIPTION_LIMIT - prefix.length - fenceOverhead),
    );
    embed.setDescription(`${prefix}\`\`\`\n${inner}\n\`\`\``);
  } else {
    embed.setDescription(prefix.length > 0 ? prefix.trimEnd() : 'No output yet.');
  }

  embed.addFields({ name: 'Session', value: model.sessionId });
  if (model.accountId) embed.addFields({ name: 'Account', value: model.accountId });
  const notes = sessionNotes(model);
  if (notes) embed.addFields({ name: 'Notes', value: notes });
  return embed;
}

/** The final summary card, posted as its OWN message when a session reaches a terminal state — a
 *  standalone record of the outcome that survives above the live card's last edit. `done` reads as
 *  completion; `failed`/`orphaned` read as an error. */
export function buildSessionSummaryEmbed(model: SessionCardModel): EmbedBuilder {
  const icon = SESSION_STATE_ICON[model.state];
  const embed = new EmbedBuilder()
    .setTitle(`${icon} Session ${model.state === 'done' ? 'complete' : model.state}`)
    .setColor(SESSION_STATE_COLOR[model.state])
    .setDescription(truncateLabeled(model.summary ?? 'Session ended.', EMBED_DESCRIPTION_LIMIT));
  embed.addFields({ name: 'Session', value: model.sessionId });
  if (model.accountId) embed.addFields({ name: 'Account', value: model.accountId });
  embed.addFields({ name: 'Output', value: `${model.totalOutputChars} chars streamed` });
  const notes = sessionNotes(model);
  if (notes) embed.addFields({ name: 'Notes', value: notes });
  return embed;
}
