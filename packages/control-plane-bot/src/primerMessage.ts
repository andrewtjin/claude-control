// The pairing primer text for both chat surfaces, owned here rather than by either one.
//
// WHY its own module: sharing this location (not discord/ or slack/) means neither surface has to
// import the other's client library just to reuse copy, and it keeps the two primers sitting side
// by side where a reader immediately sees that one changed without the other.
//
// The two exports below are NOT the same string. Discord exposes each command as its own bare
// slash command (`/usage`, `/run`, …); Slack funnels everything through one `/cctl <subcommand>`
// dispatcher whose v1 set (see slack/slackCommands.ts's SUBCOMMANDS) is materially smaller —
// there is no Slack `/timeline`, `/prune`, `/thread-here`, `/settings`, or `/approve`/`/deny` yet.
// Printing Discord's command names on Slack would tell a new Slack user to run things that do not
// exist there, which is worse than the two primers simply reading differently. Each is instead
// hand-written for its own surface and pinned to ITS OWN real command list by a colocated drift
// test — discordJsGateway.test.ts against commandDefinitions()/PRIMER_OMITTED_COMMANDS,
// slackCommands.test.ts against SUBCOMMANDS/SLACK_PRIMER_OMITTED_SUBCOMMANDS — so neither can go
// stale even though the two are no longer required to agree with each other.
//
// Sent once, right after a daemon successfully claims a pairing code. Each lists every command
// that actually reaches the daemon on that surface, grouped so a brand-new user can find the one
// they want rather than reading a flat wall of text.
export const PAIRING_PRIMER_MESSAGE = [
  "Paired. Here's what works right now:",
  '',
  '**Usage**',
  '`/usage` — usage across accounts',
  '`/timeline` — 5h-session budget and reset timeline',
  '`/stats` — token counts per account, model and day (add `days:30` for a longer window)',
  '`/accounts` — the accounts this daemon can switch between',
  '',
  '**Sessions**',
  '`/run <prompt>` — start a Claude Code session',
  '`/say <session> <text>` — send a message into a running session',
  '`/stop <session>` — stop a running session',
  '`/sessions` — every session this daemon has reported',
  '`/prune` — clear out dormant session records (asks first)',
  '`/thread-here` — send your session threads to this channel, or back to your DMs',
  '',
  '**Daemon**',
  '`/switch <account>` — switch the active account',
  '`/status` — daemon connection status',
  '`/settings` — effective settings and where each came from',
  '`/approve <request>` · `/deny <request>` — answer a pending permission request',
  '',
  'Permission prompts and questions arrive here as cards — tap the buttons, no command needed.',
].join('\n');

/** The Slack v1 primer. Every line names a real `/cctl <subcommand>` (see slack/slackCommands.ts's
 *  SUBCOMMANDS) — no bare `/name` commands exist on this surface, so unlike the Discord primer
 *  above every command reference here carries the `/cctl ` prefix. `pair` is omitted for the same
 *  reason Discord omits it (see SLACK_PRIMER_OMITTED_SUBCOMMANDS); `run`'s optional `cwd:`/`resume:`
 *  tokens are called out inline because Slack has no structured slash-command options to surface
 *  them the way Discord's `/run` fields do. */
export const SLACK_PAIRING_PRIMER_MESSAGE = [
  "Paired. Here's what works right now:",
  '',
  '**Usage**',
  '`/cctl usage` — usage across accounts',
  '`/cctl stats` — token counts per account, model and day (add `days:30` for a longer window)',
  '`/cctl accounts` — the accounts this daemon can switch between',
  '',
  '**Sessions**',
  '`/cctl run <prompt>` — start a Claude Code session (`cwd:<path>` and `resume:<sessionId>` are optional, before the prompt)',
  '`/cctl say <session> <text>` — send a message into a running session',
  '`/cctl stop <session>` — stop a running session',
  '`/cctl sessions` — every session this daemon has reported',
  '',
  '**Daemon**',
  '`/cctl status` — daemon connection status',
  '',
  'Permission prompts and questions arrive here as cards — tap the buttons, no command needed.',
].join('\n');
