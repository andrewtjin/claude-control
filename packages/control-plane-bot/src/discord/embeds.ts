// Pure embed builders: cached protocol state -> discord.js EmbedBuilder.
//
// No network calls, no Interaction objects — every function here is a straight data
// transform, which is what makes it unit-testable via `.toJSON()` without a real bot.

import { EmbedBuilder } from 'discord.js';
import type { AccountUsage, SettingsSnapshot, UsagePlan } from '@claude-control/shared-protocol';
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
  layeredBar,
  SEVERITY_COLOR,
  UNICODE_TRACK_STYLE,
  worstSeverity,
  type TimelineTrackStyle,
  type TrackEvent,
} from './richFormat.js';
import type { BarRenderer } from './emojiBars.js';

const COLOR_OK = 0x2ecc71;
const COLOR_WARN = 0xf1c40f;
const COLOR_INFO = 0x3498db;

/** Discord's hard cap on an embed field's `value`. discord.js VALIDATES this at
 *  `addFields` time (shapeshift CombinedPropertyError), so an oversized value doesn't
 *  degrade — it makes the whole command throw. */
const FIELD_VALUE_MAX = 1024;

/**
 * Clamp a field value to Discord's 1024-char cap by dropping whole trailing LINES and
 * appending a "… +N more" marker, so the field degrades to "show the first lines" instead
 * of crashing the command. Lines are the unit because every multi-line field here is
 * sorted most-relevant-first (soonest resets, first accounts), and because emoji-sprite
 * tokens (`<:pb_mf_g:123…>`, ~28 raw chars each) make raw length ~10× the visible length —
 * cutting mid-line would leave a broken half-token on screen. A single line that alone
 * exceeds the cap (pathological) is hard-truncated with an ellipsis rather than thrown.
 */
export function clampFieldValue(value: string, max = FIELD_VALUE_MAX): string {
  if (value.length <= max) return value;
  const lines = value.split('\n');
  const kept = [...lines];
  while (kept.length > 1) {
    kept.pop();
    const candidate = `${kept.join('\n')}\n… +${lines.length - kept.length} more`;
    if (candidate.length <= max) return candidate;
  }
  return `${(kept[0] ?? '').slice(0, max - 1)}…`;
}

/** `addFields` with the value clamped — every data-driven field in this module goes
 *  through here so no snapshot shape (more accounts, more limits, longer labels) can
 *  ever make a command throw at the validation layer again. */
function addClampedField(embed: EmbedBuilder, name: string, value: string): void {
  embed.addFields({ name, value: clampFieldValue(value) });
}

// The default bar renderer is the credential-free unicode `layeredBar`. It is injected as an
// optional parameter (not hidden module state) so these builders stay PURE and every existing
// call site — and every test — keeps getting unicode bars untouched. The gateway swaps in the
// emoji renderer at runtime only after `ensureProgressEmojis` succeeds (see discordJsGateway).
// A parameter beats a module-level mutable/setter here because it keeps the "which bar?"
// decision explicit at the call site and leaves the functions trivially unit-testable.
export const DEFAULT_BAR_RENDERER: BarRenderer = layeredBar;

/** " · cached <t:...:R>" suffix for an account whose data is a stale fallback, or '' for a
 *  live read. Cached data carries its TRUE fetch time (the poller preserves the original
 *  stamp), and the native timestamp renders as a live-updating "N minutes ago" — so an
 *  hours-old number can never masquerade as current, on any surface that shows usage.
 *  (Live incident 2026-07-17: /timeline showed a stale wrong-account cache as if live.) */
function cachedSuffix(account: Pick<AccountUsage, 'source' | 'fetchedAtMs'> | undefined): string {
  return account?.source === 'cached' ? ` · cached ${discordRelative(account.fetchedAtMs)}` : '';
}

/** "\n⚠️ <reason>" suffix carrying the account's failure note (e.g. "usage endpoint
 *  rate-limited (429)"), or '' when the data arrived clean. */
function errorSuffix(account: Pick<AccountUsage, 'error'> | undefined): string {
  return account?.error ? `\n⚠️ ${account.error}` : '';
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
    addClampedField(
      embed,
      `${account.label} — ${marker}${cachedSuffix(account)}`,
      `${formatLimits(account, nowMs, barRenderer)}${windowsLine(outlook, account.accountId)}${errorSuffix(account)}`,
    );
  }
  if (usage.plan) {
    // One compact field: the reason line already carries the whole burn order (see the
    // advisor), and advisories only exist for exceptional states — no separate headings.
    const lines = [usage.plan.reason, ...usage.plan.advisories.map((a) => `• ${a.message}`)];
    addClampedField(embed, 'Plan', lines.join('\n'));
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
    // The outlook account is derived math; staleness/error live on the WIRE account. Look it
    // up so /timeline flags stale data the same way /usage does — this was the surface the
    // 2026-07-17 incident actually played out on (stale bars rendered indistinguishably live).
    const wire = usage.accounts.find((acc) => acc.accountId === a.accountId);
    const lines: string[] = [];
    if (a.quarantined) {
      lines.push('🚫 quarantined — re-login required');
    } else if (a.openWindowEndsAt !== undefined) {
      lines.push(
        `${barRenderer(a.sessionPercent ?? 0)} window open · ${a.sessionPercent ?? 0}% used · resets ${discordRelative(a.openWindowEndsAt)}`,
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
      if (events.length > 0) lines.push(trackStyle.track(events, nowMs, spanMs));
    }
    addClampedField(
      embed,
      `${accountMarker(a)} ${a.label}${cachedSuffix(wire)}`,
      `${lines.join('\n')}${errorSuffix(wire)}`,
    );
  }

  if (outlook.events.length > 0) {
    // This is the field that grows FASTEST with fleet size: one line per (account × limit)
    // reset, each line ~105 raw chars with emoji-sprite marks — four 3-limit accounts
    // already exceed the cap, so the clamp is what keeps `/timeline` alive as accounts
    // are added (soonest resets survive; the far tail is what gets dropped).
    addClampedField(
      embed,
      'Upcoming resets',
      outlook.events
        .map((e) => {
          const mark = e.kind === 'session' ? trackStyle.session : trackStyle.weekly;
          return `${mark} ${discordRelative(e.atMs)} — **${e.label}** · ${describeEvent(e.kind, e.percentUsed)}`;
        })
        .join('\n'),
    );
  }

  if (usage.plan) {
    const planLines = [usage.plan.reason];
    for (const adv of usage.plan.advisories) planLines.push(`• ${adv.message}`);
    addClampedField(embed, 'Plan', planLines.join('\n'));
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
    // "source: cached" alone hides HOW stale — show the true fetch age and any failure
    // reason, same as /usage and /timeline, so no surface renders old data as current.
    const age = account.source === 'cached' ? ` (${discordRelative(account.fetchedAtMs)})` : '';
    addClampedField(
      embed,
      `${accountMarker(account)} ${account.label}`,
      `${account.active ? 'active' : 'idle'} · source: ${account.source}${age}${errorSuffix(account)}`,
    );
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
    // Summaries are daemon-relayed model text — unbounded, so clamp like everything else.
    const summaryLine = session.summary ? ` — ${session.summary}` : '';
    addClampedField(embed, session.sessionId, `${session.state}${summaryLine}`);
  }
  return embed;
}

/** Rendered for an incoming permission.request push (buttons are attached by the caller,
 *  which owns the requestId needed to build them). */
export function buildPermissionRequestEmbed(summary: string, detail?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Permission requested')
    .setColor(COLOR_WARN)
    .setDescription(summary);
  // Detail is hook-supplied tool input — unbounded (a long Bash command, a big diff).
  if (detail) addClampedField(embed, 'Detail', detail);
  return embed;
}

/** Rendered for an incoming switch.result push. */
export function buildSwitchResultEmbed(ok: boolean, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(ok ? 'Switched' : 'Switch failed')
    .setColor(ok ? COLOR_OK : COLOR_WARN)
    .setDescription(message);
}
