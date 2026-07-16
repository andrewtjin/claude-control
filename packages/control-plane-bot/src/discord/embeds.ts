// Pure embed builders: cached protocol state -> discord.js EmbedBuilder.
//
// No network calls, no Interaction objects — every function here is a straight data
// transform, which is what makes it unit-testable via `.toJSON()` without a real bot.

import { EmbedBuilder } from 'discord.js';
import type { AccountUsage, UsagePlan } from '@claude-control/shared-protocol';
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
  emojiTrack,
  layeredBar,
  SEVERITY_COLOR,
  TRACK,
  worstSeverity,
  type TrackEvent,
} from './richFormat.js';

const COLOR_OK = 0x2ecc71;
const COLOR_WARN = 0xf1c40f;
const COLOR_INFO = 0x3498db;

/** Embed accent color for a usage snapshot: the worst severity across every limit of
 *  every account, or neutral blue when no limit data exists yet. */
function usageColor(accounts: AccountUsage[]): number {
  const percents = accounts.flatMap((a) => a.limits.map((l) => l.percent));
  return percents.length === 0 ? COLOR_INFO : SEVERITY_COLOR[worstSeverity(percents)];
}

/** Render one account's limits as layered progress bars, one line per limit:
 *  "🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ session 42% · resets <t:...:R>". */
function formatLimits(account: AccountUsage, nowMs: number): string {
  if (account.limits.length === 0) return 'no limit data';
  return account.limits
    .map((l) => {
      const resetMs = l.resetsAt != null ? Date.parse(l.resetsAt) : NaN;
      const reset =
        Number.isFinite(resetMs) && resetMs > nowMs ? ` · resets ${discordRelative(resetMs)}` : '';
      return `${layeredBar(l.percent)} ${l.kind.replace(/_/g, ' ')} ${Math.round(l.percent)}%${reset}`;
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
    const cached = account.source === 'cached' ? ' · cached' : '';
    const errorLine = account.error ? `\n⚠️ ${account.error}` : '';
    embed.addFields({
      name: `${account.label} — ${marker}${cached}`,
      value: `${formatLimits(account, nowMs)}${windowsLine(outlook, account.accountId)}${errorLine}`,
    });
  }
  if (usage.plan) {
    const rec = usage.plan.recommendedAccountId
      ? `Use **${usage.plan.recommendedAccountId}** — ${usage.plan.reason}`
      : usage.plan.reason;
    embed.addFields({ name: 'Recommendation', value: rec });
    if (usage.plan.advisories.length > 0) {
      embed.addFields({
        name: 'Advisories',
        value: usage.plan.advisories.map((a) => `• ${a.message}`).join('\n'),
      });
    }
  }
  return embed;
}

/** "🪟 12×5h windows left · weekly resets <t:...:R>" — the session budget line appended to
 *  an account's `/usage` field, or empty when no weekly reset time is known. Uses a native
 *  timestamp so the line stays truthful even in old messages in the chat scrollback. */
function windowsLine(outlook: ResetOutlook, accountId: string): string {
  const budget = outlook.accounts.find((a) => a.accountId === accountId)?.budget;
  if (!budget) return '';
  return (
    `\n🪟 ${budget.fullWindows}×5h window${budget.fullWindows === 1 ? '' : 's'} left` +
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
      ? `Track spans now → ${discordRelative(lastEvent.atMs)} · ${TRACK.session} 5h window · ${TRACK.weekly} weekly · ${TRACK.both} both`
      : 'No reset times reported yet — wait for the next daemon poll.',
  );

  for (const a of outlook.accounts) {
    const lines: string[] = [];
    if (a.quarantined) {
      lines.push('🚫 quarantined — re-login required');
    } else if (a.openWindowEndsAt !== undefined) {
      lines.push(
        `${layeredBar(a.sessionPercent ?? 0)} window open · ${a.sessionPercent ?? 0}% used · resets ${discordRelative(a.openWindowEndsAt)}`,
      );
    } else {
      lines.push('💤 no open 5h window');
    }
    if (a.budget) {
      lines.push(
        `🪟 ${a.budget.fullWindows}×5h window${a.budget.fullWindows === 1 ? '' : 's'} left` +
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
      if (events.length > 0) lines.push(emojiTrack(events, nowMs, spanMs));
    }
    embed.addFields({
      name: `${accountMarker(a)} ${a.label}`,
      value: lines.join('\n'),
    });
  }

  if (outlook.events.length > 0) {
    embed.addFields({
      name: 'Upcoming resets',
      value: outlook.events
        .map((e) => {
          const mark = e.kind === 'session' ? TRACK.session : TRACK.weekly;
          return `${mark} ${discordRelative(e.atMs)} — **${e.label}** · ${describeEvent(e.kind, e.percentUsed)}`;
        })
        .join('\n'),
    });
  }

  if (usage.plan) {
    const planLines = [usage.plan.reason];
    for (const adv of usage.plan.advisories) planLines.push(`• ${adv.message}`);
    embed.addFields({ name: 'Plan', value: planLines.join('\n') });
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

/** Rendered for an incoming permission.request push (buttons are attached by the caller,
 *  which owns the requestId needed to build them). */
export function buildPermissionRequestEmbed(summary: string, detail?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Permission requested')
    .setColor(COLOR_WARN)
    .setDescription(summary);
  if (detail) embed.addFields({ name: 'Detail', value: detail });
  return embed;
}

/** Rendered for an incoming switch.result push. */
export function buildSwitchResultEmbed(ok: boolean, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(ok ? 'Switched' : 'Switch failed')
    .setColor(ok ? COLOR_OK : COLOR_WARN)
    .setDescription(message);
}
