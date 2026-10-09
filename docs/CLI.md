# CLI reference

`cctl` runs local, one-shot commands over the switch engine and the daemon's data, plus
the guided first-run wizard and the background daemon itself. Bare `cctl` (no
subcommand) prints `Not set up yet. Run: cctl setup` before setup, or a short status
summary afterward — it never dumps raw command-tree usage. `cctl --help` lists every
command; this page adds the detail and the unhappy paths.

## First run

```
cctl setup
```

The guided wizard: environment doctor → capture your current account → optional
add-more-accounts loop → usage hooks → prompts to idle sessions → relay → Discord
pairing → autostart + start the daemon → round-trip verify. See `docs/SETUP.md` for the
full step-by-step walkthrough, every prompt, and every unhappy path.

## Accounts

```
cctl accounts list                 # list stored accounts (active marked with *)
cctl accounts add <label>          # capture the currently logged-in account
cctl accounts add <label> --fresh  # log in as a NEW account in a throwaway window,
                                    # without touching the live login
cctl accounts relogin <id|label>   # re-login an existing account in a throwaway window,
                                    # keeping its id (and its usage history)
cctl accounts reauth <id|label>    # same in-place re-login, but via a login LINK you open
                                    # anywhere and a code you paste back — no browser needed
                                    # on this host (the phone's /reauth runs the same path)
cctl accounts exclude <id|label>   # stop auto-switch from ever hopping TO this account
                                    # (manual `cctl switch` and the phone's /switch still work)
cctl accounts include <id|label>   # let auto-switch consider this account again
cctl accounts remove <id|label>    # remove a stored account
cctl accounts rename <id|label> <new-label>
                                    # give an account a new label; its id and usage history stay
```

`relogin` and `reauth` differ only in how the login happens: `relogin` spawns a throwaway
`claude` window here, `reauth` prints a URL and reads back the `code#state` the approval page
shows. Both write into the EXISTING vault entry — same account id, usage attribution intact,
quarantine cleared — and both refuse if you log into a different account.
Two accounts can never answer to one name. `cctl accounts add` refuses a label another
account already has (in any case) and refuses a login that is already stored under another
row (`this login is account … ("jina25"), which is already stored; run cctl accounts relogin
jina25`). Rows created by an older build that broke this are resolved the next time
`cctl accounts list`, `cctl usage`, `cctl timeline` or the daemon runs: the same login stored
twice is merged onto one row (the active one, else the most recently captured), and two
logins under one label keep the earlier row's label while the later one becomes `jina25 (2)`.
Each repair is printed above the listing it precedes.

## Folder rules

By default every Claude Code session on the machine runs on one live account, the
_global_ account, drawn from the **shared pool** (every stored account), and a switch
moves all of them at once. A **folder rule** gives a folder (and everything under it) its
own say over that pool. The folder still **inherits the shared pool**; the rule adds two
things on top:

- **include**: accounts the folder uses **first**. An included account is **reserved**:
  it leaves the shared pool, so no other folder, and not the global slot, can use it.
  Including an account you excluded from auto-switch (`cctl accounts exclude`) makes it a
  normal target inside that folder.
- **exclude**: shared accounts the folder must not use. They stay usable everywhere else.

A ruled folder runs in its **own slot** (its own login, in a profile dir cctl prepares),
so its pool is: its included accounts first, then the rest of the shared pool minus what
it excludes. Global exclusions and quarantined logins are honored as everywhere else.
When every included account is out, the folder falls back to an inherited shared account,
and it returns to an included one as soon as that has usage again. One account is live in
one place at a time: a shared account live in another slot is skipped, and when two
places want the last free account, the global slot keeps it and the folder waits (the
phone gets an alert naming the folder). Memories, settings, skills, plugins, MCP servers
and history stay shared; only the login differs.

```
cctl folder include <folder> <account>[,<account>...]   # reserve accounts to a folder, used there first
cctl folder include <folder> <accounts> --label <name>  # ...naming the rule it creates (default: the folder)
cctl folder exclude <folder> <account>[,<account>...]   # keep a folder off some shared accounts
cctl folder exclude <folder> <accounts> --force         # ...even if that empties its slot while sessions run
cctl folder reset <folder> <account>[,<account>...]     # take accounts back out of a folder's rule
cctl folder reset <folder>                              # remove the folder's rule entirely
cctl folders                                            # every rule: includes, excludes, live account, pool
```

Accounts are named by label, email or id, one or several separated by commas. **The
account is never filled in for you**: `cctl folder include C:\work` with no account is a
usage error. A default would silently reserve the account you are using right now, and
every other project on it would stop.

Every change says what it did:

- `include` names each account that left the shared pool, every slot that was moved off
  one of them (if the global slot was live on it, the global slot switches to the best
  remaining shared account first, and the include is refused, with nothing changed, when
  none is left), the account now live in the folder's slot, and any sessions already
  running under the folder, which keep their old account until relaunched.
- `exclude` says the accounts stay usable elsewhere, and, when an excluded account was live
  in the folder's slot, that the slot moved off it. With nothing else free the slot would be
  emptied; that is refused while sessions run under the folder unless you pass `--force`.
- `reset` with accounts removes each from what the folder includes or excludes; an account
  no folder includes any more returns to the shared pool. `reset` with no accounts removes
  the rule: its included accounts return to the shared pool (unless another folder also
  includes them), its profile's live login is cleared (the profile dir is kept for history),
  and the folder goes back to the global slot, or to a parent folder's rule.

Several folders may include the same account: they share it, and it is live in at most one
of them at a time. A folder that only excludes still gets its own slot, so it can avoid the
global live account when that is one it excludes.

`cctl folders` lists every rule: its folder(s), what it includes and excludes, the account
live in its slot (and whether that one is included or inherited), and the whole pool in
order, with what limits each account: live elsewhere, quarantined, or not an auto-switch
target. It ends with the global slot and the guard's state. `cctl usage` and `cctl timeline`
end with a short per-folder section (the live account and the pool on one line), and
`cctl accounts list` shows the reserved accounts in their own table, each with its email and
the folders that include it.

Nesting is allowed: a subfolder can have its own rule, and the **longest matching rule
wins**, with no merging: a nested rule does not add to its parent's, it replaces it there.
`cctl folder include|exclude` refuses a filesystem root, your home directory, and anything
inside cctl's own data directories.

**An older daemon must be restarted first.** A folder slot can hold a shared account, and
a daemon built before folder rules would treat that account as free for the global slot,
putting one login live in two places (the second copy logs itself out on the next refresh).
So while such a daemon is running, every command that could leave a shared account live in a
folder slot refuses and changes nothing: `cctl folder include` and `cctl folder exclude`,
`cctl folder reset <folder> <accounts>` (removing the whole rule with `cctl folder reset
<folder>` still works), `cctl switch` of a shared account into a folder's slot, and `cctl claude`
in a ruled folder unless its slot already holds one of the folder's own included accounts:

```
error: the running daemon (v0.5.2) predates folder rules: it could put an account live in a
folder and in the global slot at once. Restart it on this build first: cctl daemon restart.
Nothing was changed.
```

`cctl doctor` flags the same mismatch (`daemon-folder-rules`). The check is made when a command
runs: it cannot stop an older daemon started later (an older install's logon task, say). Before
going back to an older build, remove every folder rule with `cctl folder reset <folder>`.

### Switching a folder's slot by hand

```
cctl switch <account> --folder <folder>   # put the account in the slot that folder runs on
```

The folder's slot is the slot of the rule that applies there (or the global slot when none
does). The slot may take one of its included accounts, or a shared account the folder does
not exclude. The switch is refused, with nothing changed, when the folder's rule does not
allow the account, when the account is live in another slot, or (without `--folder`) when
several folders include the account and it is live in none of them: name the folder then.

### Running Claude Code in a ruled folder

A rule only takes effect for a session that launches on the folder's slot. That is what
`cctl claude` does:

```
cctl claude                        # launch Claude Code on the folder's slot (or the global
                                    # slot when no rule applies here)
cctl claude --account <id|label>   # launch on a specific account for this one session
cctl claude --override             # launch here on the global account, on purpose (see below)
cctl claude -- <claude args...>    # everything after -- is passed through to claude
```

`cctl claude` resolves which slot to use (an explicit `--account`, else the folder's
rule, else global), makes sure an account is live there, prints a one-line banner naming
the account and the rule, and hands off to the real `claude` executable. Its exit code is
yours; Ctrl+C reaches Claude Code, not the wrapper.

To make an ordinary `claude` do this automatically, install the wrapper for your shell:

```
cctl shell-init powershell   # prints a `claude` function that calls `cctl claude`
cctl shell-init bash         # (also: zsh, fish)
```

For PowerShell, `cctl shell-init powershell` prints a function to add to your profile
(`$PROFILE`); afterwards typing `claude` in any ruled folder starts on the right slot,
and typing it anywhere else behaves exactly as before. The command prints where to put it.

In **VS Code**, the Claude Code extension takes its environment from the
`claudeCode.environmentVariables` setting (a list of `{ "name", "value" }` pairs). That
setting is machine-scoped: VS Code reads it from **user** settings only and silently ignores
it in a folder's `.vscode/settings.json`. So give each folder rule its own VS Code profile,
and open the folder in it:

1. `code --profile cctl-<label> <folder>` — creates the profile the first time; install or
   enable the Claude Code extension in it.
2. In that window, run **Preferences: Open User Settings (JSON)** and add the snippet
   `cctl where` prints:

   ```json
   {
     "claudeCode.environmentVariables": [
       { "name": "CLAUDE_CONFIG_DIR", "value": "<the profile dir cctl where prints>" }
     ]
   }
   ```

3. Open the folder with the same `code --profile ...` command from then on. Windows in any
   other profile keep the global slot.

`cctl where` prints the exact command, quoted for your shell. A `claude` typed in VS Code's
integrated terminal is covered by the shell wrapper above.

Two VS Code specifics. The extension asks the model for a session title **in parallel with**
your first prompt, so a prompt the guard blocks in a wrongly configured window has already
sent its text, for that title, to the window's account; the guard cannot stop that request —
routing the window correctly does. And a multi-root workspace runs its session in the FIRST
folder; the other folders are added working directories that the guard does not judge, so
keep a ruled folder in its own window.

```
cctl where              # explain how THIS folder resolves: the rule that matched, what it
                        # includes and excludes, the live account, the pool in order, the env
                        # line and a ready-to-paste VS Code settings snippet
cctl where <folder>     # the same for another folder
```

### Enforcement: what a session on the wrong slot sees

So a session does not silently run on the wrong account, cctl installs a guard that checks
each prompt against the folder's rule. When a folder has a rule but the session runs on the
shared account, the guard blocks the prompt with:

```
cctl: C:\work has its own cctl folder rules (it uses A, B first), but this session runs on
the shared account. Exit and start it with: cctl claude   (or set up the claude wrapper:
cctl shell-init powershell)
```

There are three enforcement modes, set with `cctl settings set bind-enforce <mode>`:

- **block** (default) — a mismatched prompt is refused with the message above.
- **warn** — the same message is shown, but the prompt proceeds.
- **off** — no check.

To run in a ruled folder on the global account _on purpose_ for one session, launch it
with `cctl claude --override`; to run a reserved account in a folder that does not include
it, launch with `cctl claude --account <that account>`. Both are honored by the guard for
that session only.

### macOS

Folder rules are **not supported on macOS yet** — `cctl folder include|exclude` refuse
there. The isolation relies on a per-slot credential store, and on macOS each store would
prompt the Keychain. See `docs/PLATFORM.md`.

## Switching and recovery

```
cctl switch <id|label>       # activate an account (a reserved account switches its folder's slot)
cctl switch <id|label> --force   # bypass the switch-cadence guard
cctl recover                 # recover from an interrupted switch (safe to run anytime);
                             # exits 1 with the reason when it cannot be settled yet
```

## Usage and timeline

```
cctl usage      # cross-account usage from the daemon's latest poll
cctl timeline   # 5h-session budget per account + when every limit resets, with a
                # burn-down plan
```

Both read the daemon's last-persisted snapshot, so they work whether or not the daemon
is currently running. While no account can take work, both lead with a line saying so, with
since when once the daemon has recorded it and which account is expected back first when a
reset time is known: one line for the global pool, and one for each folder rule whose pool is
out (see below).

Where folder rules exist, both end with a section per rule: its folders, the account live in its
slot, and its pool in order (`cctl folders` has the full picture).

## When every account is out of usage

```
cctl outages                   # every time no account could take work, newest first
cctl outages --days 30         # only the times that started in the last 30 days (plus any still on)
cctl outages --folder <folder> # only the times the pool <folder> runs under ran out
cctl outages --json            # the same, as JSON (each episode carries its scope)
```

When auto-switch has walked every account and all of them are spent, the daemon records it.
An account counts as out when one of its limits is more than 98% used (the endpoint reports
whole percents, so in practice 99% or more): its 5-hour window, its weekly budget, or the
Fable weekly cap unless `CCTL_AUTOSWITCH_ON_FABLE_CAP` is off. An account whose login has
expired counts as out too. An account you excluded from auto-switch still counts as available
while it has quota, and so does an account cctl has no numbers for yet. This bar is stricter
than auto-switch's own: auto-switch stops hopping to an account at its 94% trigger, so it can
run out of places to go a little before every account counts as out.

Each time is one entry with when it started, why each account was out (every limit holding
it out) and when each was due back, and the switches of the five hours before it (who made
each and why). When an account comes back, the entry is closed with how long nothing could
run and how it ended (a limit reset, a login restored, a new account, or numbers showing
usage left again). The outage is measured to the reset that ended it, so a daemon that was
stopped through the reset still records the right length; a reset the usage endpoint moves
later while the outage is on moves the end with it.

An account only counts as back on evidence: numbers showing it has usage left, or the
resets of every limit it was last seen out on having passed. A usage poll that fails or
comes back empty during an outage is not evidence, and neither is a login added mid-outage
before its first successful poll, so neither ends it (or starts a second one).

While an outage is open the daemon also adds a short `walls` line whenever what keeps an
account out changes (it hits another limit, its login expires, a reset moves by more than five
minutes, or an account joins), so a daemon restarted mid-outage judges every account by what was
last seen, not only by what was true at the start.

The phone gets a card when it starts and when it ends. The log is
`exhaustion-log.jsonl` in the daemon's data folder (beside `daemon.db`), one JSON line per
start, per end and per `walls` change, starts and ends each with a plain-English `summary`;
`cctl outages` prints its path. A
write that fails (the file held open by a scanner, a full disk) is retried every cycle and on
shutdown, and the entry is in `daemon.log` either way.

`cctl outages` marks the outage still open as `ongoing`, with the account expected back first
by what was last seen. If the latest numbers already show
an account back but no running daemon has recorded the end, it says so (`over by the latest
numbers`) instead. A start whose end was never written is shown as `end not recorded`.

### Per pool: the global pool and each folder rule

Outages are kept per **scope**: the global pool (the shared accounts the global slot draws from)
and each folder rule's pool (its included accounts plus the shared accounts it keeps). Each scope
has its own episodes, cards and `walls` lines, side by side in the one log, so a folder can be
out while the rest of the machine works, and the other way round.

A scope is out when nothing in its pool can take work, where an account **live in another slot**
does not count as available: one login is never live in two places, so that slot cannot have it.
This holds for the global pool too: a shared account a folder is running on (its fallback while
its own accounts are out) is not counted as the global pool's while the folder holds it. Such an
account is listed as `live in <the slot>`, and when the other slot lets it go and its numbers
show usage left, the outage ends as `another slot let it go`. Accounts reserved to a folder are
never part of the global pool. A pool with nothing in it at all (a folder that excludes every
shared account, or whose last one another folder reserved) is out too, and says its pool is
empty; it ends once an account that can work joins it.

The phone card names the folder (`<folder>: every account in its pool is out`, then `Usage is
back in <folder>`), and the `usage` / `timeline` banner adds one line per folder that is out.
While folder rules exist the global pool is not every account, so its card, log lines and banner
name it too (`Every account in the global pool is out`, `No account in the global pool can take
work`); with none they read as before. `cctl outages` labels each entry `[global]` or
`[<folder>]` once any folder has an entry or a global one was recorded beside folder rules (a log
with neither reads as before); `--folder` resolves a folder the way a session does, against the
rules in force (the longest rule folder containing it), so a subfolder finds its rule's history,
a rule made anew on the same folder shows only its own, and a folder no rule applies to shows
the global pool's (with that of any removed rule that covered it), and
`--json` gives every episode a `scope` (`{ "kind": "global" }` or `{ "kind": "folder",
"ruleId", "folders", "label" }`) and lists each scope's open outage under `open`.

Removing a folder rule while its pool is out ends that outage, recorded as `its folder rule was
removed` (with an informational card), since there is no pool left to be out. Lines written
before scopes existed carry no scope and read as the global pool's. A folder's lines are written
as version 2, so an older cctl that knows only the global pool skips them rather than reading a
folder's outage as the whole machine's.

Separately from the log, the daemon alerts once (per episode, not per hour) when a folder's slot
cannot move: its live account is out of usage and nothing else in its pool is free to take over,
or its slot has no working account at all. A folder whose outage card has already gone out is not
alerted on twice.

## Token stats

```
cctl stats             # absolute token counts per account, model and day (last 7 days)
cctl stats --days 30   # a longer window
```

`usage` and `timeline` answer "how much of my limit is gone" — a percentage from
Anthropic's usage endpoint. `stats` answers the different question, "how many tokens did I
actually spend, and on which account". It reads the per-turn records Claude Code writes
under your Claude config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`) and joins each turn's
timestamp against the daemon's switch journal to decide which account was live at the
time. Input, output, cache-write and cache-read tokens are reported separately — cache
reads usually dominate, so one combined number would hide everything interesting.

No network call is made and no daemon needs to be running. The same numbers reach the
phone as `/stats`, pushed by the daemon every 15 minutes.

On the phone, `/stats` with no options renders that pushed snapshot — instant, and up to
15 minutes old. `/stats days:30` (1–90) asks for a different window instead, which makes
the daemon re-read the host's transcripts then and there: the reply is deferred while the
scan runs, and only one scan happens at a time, so a request arriving while another is in
flight is told to try again rather than queued behind it.

**What these numbers are not.** They are the turns Claude Code recorded _on this machine_:

- Work done from the web app, the mobile app, or another computer is not counted at all.
- Turns from before cctl recorded its first account switch cannot be attributed to an
  account. They appear in an `unattributed` row rather than being dropped.
- They are local records, not an authoritative billing figure from Anthropic.

The command prints these caveats under every table, and reports how many transcript files
it read, skipped, or could not read — a total over part of the corpus is a different claim
from a total over all of it.

## Status and settings

```
cctl status     # at-a-glance: accounts, hooks, relay, daemon, pairing
cctl settings   # every configurable setting: effective value and where it came from
                # (flag / env / config / default), for both this shell and the
                # running daemon; a saved value the daemon is not yet running with
                # shows beside the live one as `on (off after cctl daemon restart)`
cctl settings set <name> <value>    # persist a daemon setting by alias or env var name,
                                    # e.g. `cctl settings set fable-cap off`,
                                    # `cctl settings set trigger 90` (applies when the
                                    # daemon next starts: `cctl daemon restart`;
                                    # aliases listed below)
cctl settings unset <name>          # remove a persisted daemon setting
cctl doctor     # environment checks: Node version, vault crypto round-trip, vault dir,
                # live login, ~/.claude.json, and whether the daemon has autostart
```

## The daemon

The daemon is the one long-running local process: usage poller, hook receiver,
attribution journal, and the control-plane connection to the bot.

```
cctl daemon run                        # run in the foreground (Ctrl+C to stop)
cctl daemon run --pair <code>          # adopt a new identity from a Discord /pair code
cctl daemon run --relay <url>          # override the control-plane WebSocket url
cctl daemon run --no-greedy            # hop only when the active account runs low
                                        # (by default the daemon ALSO hops toward whichever
                                        # account's weekly quota expires soonest)
cctl daemon run --no-auto-switch       # never hop accounts automatically; for an installed
                                        # daemon: `cctl settings set autoswitch off`
                                        # (likewise `greedy off`). A full Fable weekly
                                        # cap counts as "out of quota" by default; to keep a
                                        # Fable-capped account and hop only on the shared weekly
                                        # budget or the 5h window:
                                        # `cctl settings set fable-cap off`

cctl daemon supervise                  # run + auto-restart on crash or hang (same flags
                                        # as `daemon run`; a clean exit you asked for ends
                                        # supervision)

cctl daemon start       # start the daemon in the background: through the logon task /
                        # LaunchAgent / systemd unit when one is registered, else as a
                        # detached `daemon run`
cctl daemon stop        # ask the running daemon to stop; ends the process only if it cannot
                        # be asked (an older build, or one that stopped answering)
cctl daemon restart     # stop + start: applies persisted settings and an updated build, then
                        # prints the build and the settings that came from config.json

cctl daemon install     # register autostart and start the daemon now: a Windows logon
                        # Scheduled Task (from inside WSL too), a macOS LaunchAgent, or a
                        # Linux systemd user unit — see docs/PLATFORM.md
cctl daemon uninstall   # remove the logon task + the daemon's hook entries in settings.json
cctl daemon status      # logon task, heartbeat, pairing, relay — at a glance
```

`cctl daemon install`/`uninstall` are idempotent: install checks the current
registration first and only re-registers (`Register-ScheduledTask`, a rewritten plist
or unit) when the resolved action actually differs, so re-running it (e.g. re-entering
`cctl setup`) is a fast no-op. A
second daemon instance is refused up front with an actionable message naming the
running daemon's pid, not a raw exception.

`cctl daemon uninstall` also prunes the daemon's own hook entries from
`~/.claude/settings.json` — only entries it installed; other tools' hooks and the rest
of the file are untouched. Hook removal is best-effort: if settings.json can't be
touched (e.g. it isn't valid JSON), the command prints a warning but the task removal
still counts as a success. Neither step stops an already-running daemon, and a running
daemon reinstalls its hooks on its next start — `cctl daemon stop` first for the removal
to stick.

`cctl daemon supervise` respawns the daemon a couple of seconds after a crash (with a
cooldown if it crash-loops), probes its local health endpoint, and kills + respawns a
daemon that is alive but unresponsive: SIGTERM first, SIGKILL if it is still running 10
seconds later. A daemon it killed this way is always respawned, even when it shut down
cleanly; only a stop you asked for (`cctl daemon stop`, Ctrl+C) ends supervision. Crashes
and health kills leave a line in `daemon-crash.log` beside the vault.

While the daemon is down, its hooks do nothing, and auto-switch is off with them. So that
an outage is never silent, a prompt you send while it is down shows a one-line notice naming
`cctl daemon start` (and `cctl daemon uninstall`, to remove the hooks instead). The notice
appears at most once every 15 minutes across all sessions, and again right away for a new
outage after the daemon has run in between. `cctl status` and
`cctl doctor` also flag a daemon with no autostart registered, since one started by hand
stays down after a reboot or a stopped supervisor.

A running daemon writes a heartbeat roughly every 30 seconds; `cctl daemon status` and
`cctl status` read it to tell "connected 12s ago" from "dead since 3h" apart from
whether the logon task is registered at all. A stale heartbeat with a registered task
reads as "will restart at next logon", not just a bare timestamp.

## Session tracking

```
cctl session register       # opt the current session into daemon tracking + phone streaming
cctl session label <name>   # name the current tracked session (shown in the phone list)
cctl session watch [--off]  # stream the current session to Discord (--off to stop)
cctl session unregister     # stop tracking (by the current session, --session <id>, or --label <name>)
cctl session status         # show tracked sessions + active account (reads the daemon db offline)
```

`register`/`label`/`watch`/`unregister` talk to the running daemon over its loopback
receiver; `status` reads the local database and works offline. The group is also
exposed in-session as the `/cctl:*` slash commands shipped in `plugins/cctl/` — a
self-contained Claude Code plugin that holds no secrets and only wraps the CLI.

## Prompts to idle sessions

```
cctl channel status              # is idle-session delivery enabled on this machine?
cctl channel enable              # approve cctl as a channel (one administrator consent prompt)
cctl channel enable --print      # show exactly what would be written, and where; write nothing
cctl channel enable --no-elevate # don't ask for rights; print the file to place by hand
cctl channel disable             # withdraw the approval
```

Without this, a prompt sent from Discord to an interactive session waits for that session's next
turn boundary — it lands when the session finishes what it is doing, or when you next type in it.
That never happens while you are away, which is the case phone control exists for. Enabling it lets
the prompt land immediately on a session sitting idle.

The mechanism is a Claude Code **channel**: a small MCP server that Claude Code starts alongside
each session. Claude Code only loads a channel whose plugin an administrator has approved, so
`enable` writes one file — `managed-settings.d/claude-control-channels.json` inside Claude Code's
managed-settings directory. cctl writes its own drop-in there and never edits
`managed-settings.json`, so a file another administrator owns is left alone. The written content
restates Anthropic's four official channel plugins alongside cctl's, because that list _replaces_
the built-in one rather than extending it.

Two things worth knowing:

- **A session cannot be upgraded after it starts.** A channel is attached at launch. Sessions
  already running keep turn-boundary delivery; `cctl session status` distinguishes them.
- **"Sent" is not "delivered."** Channel notifications are fire-and-forget: if a session never
  loaded the channel, the event is dropped with no error returned. cctl reports `sent` and stops
  there — nothing on this side can observe whether the session displayed the message or acted on
  it, and cctl does not claim otherwise. What it _does_ track is whether its own channel server
  took the message: anything still undelivered when that server goes away falls back to the
  turn-boundary queue, with a card saying so, and if a channel attaches for that session again,
  whatever is still queued goes back onto it. Queued prompts also survive a daemon restart.

`cctl doctor` reports the current state, and `cctl setup` offers to turn it on (you can decline; it
stays available afterwards).

## Pairing

```
cctl pair              # prompts for the code interactively
cctl pair <code>       # bind this machine to the Discord bot using a one-time /pair code
cctl pair <code> --relay <url>
```

Pairing codes are case-insensitive and tolerate stray whitespace/dashes (`AB-CD 12` and
`abcd12` pair identically). `cctl pair` only adopts and persists the daemon identity —
start (or restart) the daemon afterward to actually connect (`cctl daemon install` or
`cctl setup`).

Failure is reason-specific, never a raw error:

- **Relay unreachable** (the wizard/pair's own ~15s timeout fired, since
  `ControlPlaneClient.connect()` reconnects forever and never rejects on its own) →
  checks a firewall/proxy hint and the `--relay <url>` override.
- **Relay refused the code** → codes are one-time and expire; run `/pair` again for a
  fresh one.

## Remote control

```
cctl run   # (needs the running daemon + hosted bot) start a remote session
```

Until the daemon is connected to the bot, `cctl run` fails with a pointer to
`docs/VERIFICATION.md` rather than doing nothing silently.

## Persisted settings and override precedence

Every daemon knob resolves the same way, highest precedence first: a `cctl daemon run`
flag → the env var → `config.json` → the built-in default. `cctl settings` shows the
effective value and which layer produced it. The relay is the same chain:
`--relay <url>` flag → `CCTL_RELAY_URL` env var → `relayUrl` in `config.json` → the
built-in default.

`config.json` lives beside the vault (the same directory as `daemon.db`; run
`cctl settings` to see the resolved path) and is the option that survives a reboot
without a wrapper script or a machine-wide env var. `cctl settings set` writes it for
you, keyed by the env var name the daemon already reads, and refuses a value the daemon
would silently ignore (`CCTL_AUTOSWITCH maybe`, a negative percent, an unknown log
level):

```json
{
  "relayUrl": "wss://relay.example.com",
  "env": {
    "CCTL_AUTOSWITCH_ON_FABLE_CAP": "off",
    "CCTL_AUTOSWITCH_TRIGGER_PCT": "90"
  }
}
```

The daemon reads the file at start-up, so a change applies when it next starts —
`cctl daemon restart` does that now, and until then `cctl settings` shows the saved
value beside the running one (`on (off after cctl daemon restart)`) with the restart command in the
section title, and says whether the report belongs to a daemon that is still running. A file
setting the running build has no row for — a build from before that knob — stays visible as
`off (not read by build v0.4.2)`, and the title says which install to update; `cctl daemon start`
and `restart` print the same warning when the daemon they brought up is not this CLI's build
or took nothing from the file. A value set in the real environment always wins over the file, even a misspelled one
(which then falls to the default, exactly as it does without a file). Only the names
`cctl settings` lists for the daemon are read from `env`; the CLI's own shell knobs
(`CCTL_SWITCH_MIN_INTERVAL_MS`, `CCTL_REFRESH_SKEW_MS`) stay environment-only.

Every setting has a short alias for the command line (case and `-`/`_` do not matter;
`cctl settings set x` prints this list):

| alias               | env var                                  | value                 |
| ------------------- | ---------------------------------------- | --------------------- |
| `autoswitch`        | `CCTL_AUTOSWITCH`                        | on / off              |
| `greedy`            | `CCTL_AUTOSWITCH_GREEDY`                 | on / off              |
| `fable-cap`         | `CCTL_AUTOSWITCH_ON_FABLE_CAP`           | on / off              |
| `trigger`           | `CCTL_AUTOSWITCH_TRIGGER_PCT`            | percent used          |
| `stale-trigger`     | `CCTL_AUTOSWITCH_STALE_TRIGGER_PCT`      | percent used          |
| `stale-after`       | `CCTL_AUTOSWITCH_STALE_AFTER_MS`         | milliseconds          |
| `min-session-left`  | `CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT`   | percent left          |
| `greedy-margin`     | `CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS` | milliseconds          |
| `cooldown`          | `CCTL_AUTOSWITCH_COOLDOWN_MS`            | milliseconds          |
| `waiting-cards`     | `CCTL_WAITING_CARDS`                     | on / off              |
| `permission-hold`   | `CCTL_PERMISSION_HOLD_MS`                | milliseconds          |
| `question-hold`     | `CCTL_QUESTION_HOLD_MS`                  | milliseconds          |
| `command-output`    | `CCTL_COMMAND_OUTPUT`                    | on / off              |
| `identity-check`    | `CCTL_IDENTITY_CHECK`                    | on / off              |
| `full-output`       | `CCTL_TOOL_OUTPUT_FULL`                  | on / off              |
| `relay`             | `CCTL_RELAY_URL`                         | ws:// or wss:// url   |
| `log-level`         | `CCTL_LOG_LEVEL`                         | trace … silent (pino) |
| `log-format`        | `CCTL_LOG_FORMAT`                        | json / pretty         |
| `log-file`          | `CCTL_LOG_FILE`                          | file path             |
| `probe-unknown`     | `CCTL_PROBE_UNKNOWN`                     | on / off              |
| `probe-timeout`     | `CCTL_PROBE_TIMEOUT_MS`                  | milliseconds          |
| `auto-continue`     | `CCTL_AUTO_CONTINUE`                     | on / off              |
| `auto-continue-max` | `CCTL_AUTO_CONTINUE_MAX`                 | count                 |
| `bind-enforce`      | `CCTL_BIND_ENFORCE`                      | block / warn / off    |

A missing, corrupt, or wrong-shaped file is ignored rather than being a startup
error, so a typo costs you the override, never the daemon (`cctl settings set` will
refuse to overwrite a corrupt file rather than destroy it). Do not confuse it with
`daemon-settings.json` in the same directory: that one is written _by_ the daemon to
report what it resolved, and editing it changes nothing.

## Building from source

```bash
pnpm install
pnpm run build
pnpm run test
```

`cctl` is then available unbundled at `packages/cli/dist/bin.js`
(`pnpm --filter @claude-control/cli build`, then `node packages/cli/dist/bin.js --help`).
The published `@andrewtjin/cctl` package (`packages/cctl-publish`) is a separate
single-file esbuild bundle of the same CLI + daemon — see that package for the
prepublish smoke test that guards it.

One dependency is deliberately NOT bundled: `@anthropic-ai/claude-agent-sdk`, which
spawns the Claude Code binary that backs every remote session. The SDK finds that binary
by resolving a per-platform package from its own module location, so inlining it produces
a bundle that builds and boots but cannot start a session. It stays external and declared,
and the smoke test re-runs that lookup against a staged install so the gap cannot ship.
