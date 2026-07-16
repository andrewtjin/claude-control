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
  humanizeDuration,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
  type ResetOutlook,
} from '@claude-control/usage-advisor';
import type { SessionStatus } from './stateCache.js';

const COLOR_OK = 0x2ecc71;
const COLOR_WARN = 0xf1c40f;
const COLOR_INFO = 0x3498db;

/** Render one account's limits as a compact line, e.g. "session 42% · weekly all 81%". */
function formatLimits(account: AccountUsage): string {
  if (account.limits.length === 0) return 'no limit data';
  return account.limits
    .map((l) => `${l.kind.replace(/_/g, ' ')} ${Math.round(l.percent)}%`)
    .join(' · ');
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
  const embed = new EmbedBuilder().setTitle('Usage').setColor(COLOR_INFO);
  if (usage.accounts.length === 0) {
    embed.setDescription('No accounts reported yet.');
  }
  const outlook = computeOutlook(timelineInputFromWire(usage.accounts), nowMs);
  for (const account of usage.accounts) {
    const marker = account.active ? '● active' : 'idle';
    const errorLine = account.error ? `\n:warning: ${account.error}` : '';
    embed.addFields({
      name: `${account.label} — ${marker}`,
      value: `${formatLimits(account)}${windowsLine(outlook, account.accountId, nowMs)}${errorLine}`,
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

/** "12×5h windows left · weekly resets in 3d 4h" — the session budget line appended to an
 *  account's `/usage` field, or empty when no weekly reset time is known. */
function windowsLine(outlook: ResetOutlook, accountId: string, nowMs: number): string {
  const budget = outlook.accounts.find((a) => a.accountId === accountId)?.budget;
  if (!budget) return '';
  return (
    `\n${budget.fullWindows}×5h window${budget.fullWindows === 1 ? '' : 's'} left` +
    ` · weekly resets in ${humanizeDuration(budget.weeklyResetAt - nowMs)}`
  );
}

/** `/timeline` — the 5h-window budget and cross-account reset timeline, rendered by the
 *  same pure text renderer the CLI uses and wrapped in a code block so the ASCII tracks
 *  align. The daemon-computed plan (quarantine-aware) rides along when the snapshot has
 *  one — the bot never recomputes advice from its own clock. */
export function buildTimelineEmbed(
  usage: {
    accounts: AccountUsage[];
    plan?: UsagePlan;
  },
  nowMs = Date.now(),
): EmbedBuilder {
  const outlook = computeOutlook(timelineInputFromWire(usage.accounts), nowMs);
  // 28 columns keeps the track inside a phone-width Discord code block.
  let text = renderOutlook(outlook, { trackWidth: 28 });
  if (usage.plan) text += '\n\n' + renderPlanSummary(usage.plan);
  return new EmbedBuilder()
    .setTitle('Reset timeline')
    .setColor(COLOR_INFO)
    .setDescription('```\n' + text + '\n```');
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
      name: account.label,
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
