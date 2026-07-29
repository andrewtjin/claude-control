// The pairing primer text, owned here rather than by either chat surface.
//
// WHY its own module: both surfaces send this same copy, and it must stay ONE copy — the moment
// each surface owns its wording, the two drift and a user who moves between them is told two
// different things about the same daemon. It sits outside discord/ and slack/ so that sharing it
// never makes one surface import the other, which would drag a whole client library into a process
// that may not use it. The command names are written the way Discord renders them; the Slack
// surface passes the text through its mrkdwn converter and sends it unchanged, so its
// `/cctl <subcommand>` grammar reads slightly differently there — an accepted cosmetic mismatch,
// and the reason this text carries no surface-specific formatting of its own.
//
// Sent once, right after a daemon successfully claims a pairing code. Lists every command that
// actually reaches the daemon, grouped so a brand-new user can find the one they want rather
// than reading a flat wall of sixteen. discord/discordJsGateway.ts's PRIMER_OMITTED_COMMANDS
// records the ones deliberately absent and why. A hand-written list beside a separately-declared
// command surface drifts the moment someone adds a command and forgets this file, so a unit test
// holds the two to each other rather than trusting the next author to remember.
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
