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

## Folder-bound accounts

By default every Claude Code session on the machine runs on one live account — the
_global_ account — and a switch moves all of them at once. A **binding** carves out an
exception: a folder (and everything under it) is tied to one account, or a set of
accounts, and sessions started there run on that set. The bound accounts are held apart
from the global pool — auto-switch never hops to them, and a global switch never touches
them — so work in a bound folder cannot spend the account you keep for everything else,
and vice versa. Memories, settings, skills, plugins, MCP servers and history stay shared;
only the login differs.

```
cctl bind <folder> <account>[,<account>...]   # bind a folder to one account or a set
cctl unbind <folder>                          # remove a binding (dissolves the group on its last folder)
cctl unbind <folder> --force                  # dissolve even while a session runs in the profile
cctl unbind --group <id|label>                # dissolve a whole binding (all its folders and sessions)
cctl bindings                                 # list every binding, its accounts, and which is live
```

`cctl bind` reports what it changed: if a to-be-bound account was the global live account
it is moved out first (the global slot switches to the best remaining shared account, and
`bind` refuses if none is left), the account's isolated profile is prepared, and any
sessions already running under the folder are named — they stay on the slot they started on
until they are relaunched (a running session follows whatever login is live in its slot, and
picks up a switch there on its next request).

A **set** of accounts (`cctl bind C:\work alice,bob`) rotates internally: auto-switch and
the phone's `/switch` move only among the set's members, never out to a global account.
A single-account binding never hops; when its account is out of quota you are told, rather
than being moved onto an account the folder is not meant to use.

Nesting is allowed: a subfolder can be bound to a different account than its parent, and
the longest matching binding wins. `cctl bind` refuses a filesystem root, your home
directory, anything inside cctl's own data directories, and a folder already bound to a
_different_ set (unbind it first).

### Running Claude Code in a bound folder

A binding only takes effect for a session that launches with the folder's account. That is
what `cctl claude` does:

```
cctl claude                        # launch Claude Code on the folder's bound account (or the
                                    # global account when the folder is not bound)
cctl claude --account <id|label>   # launch on a specific account for this one session
cctl claude --override             # launch here on the global account, on purpose (see below)
cctl claude -- <claude args...>    # everything after -- is passed through to claude
```

`cctl claude` resolves which account to use — an explicit `--account`, else the folder's
binding, else global — prepares the profile, prints a one-line banner naming the account
and binding, and hands off to the real `claude` executable. Its exit code is yours;
Ctrl+C reaches Claude Code, not the wrapper.

To make an ordinary `claude` do this automatically, install the wrapper for your shell:

```
cctl shell-init powershell   # prints a `claude` function that calls `cctl claude`
cctl shell-init bash         # (also: zsh, fish)
```

For PowerShell, `cctl shell-init powershell` prints a function to add to your profile
(`$PROFILE`); afterwards typing `claude` in any bound folder starts on the right account,
and typing it anywhere else behaves exactly as before. The command prints where to put it.

One PowerShell caveat: the wrapper is a PowerShell _function_, and PowerShell binds a
function's arguments before it runs — a bare `--` is consumed, an unquoted comma splits one
argument into several, and `-name:value` splits at the colon. So through the wrapper
`claude -p -- --resume x` resumes the session `x`, where a direct `claude.exe` call sends the
prompt "--resume x", and `claude --resume=a,b` resumes "a". Quote such arguments (`'--'`,
`'--resume=a,b'`, `'-r:x'`) or call `claude.exe` directly. The generated wrapper says so too.

In **VS Code**, the Claude Code extension takes its environment from the
`claudeCode.environmentVariables` setting (a list of `{ "name", "value" }` pairs). That
setting is machine-scoped: VS Code reads it from **user** settings only and silently ignores
it in a folder's `.vscode/settings.json`. So give each binding its own VS Code profile, and
open the bound folder in it:

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
   other profile keep the shared account.

`cctl where` prints the exact command, quoted for your shell. A `claude` typed in VS Code's
integrated terminal is covered by the shell wrapper above.

Two VS Code specifics. The extension asks the model for a session title **in parallel with**
your first prompt, so a prompt the guard blocks in a wrongly configured window has already
sent its text, for that title, to the window's account; the guard cannot stop that request —
routing the window correctly does. And a multi-root workspace runs its session in the FIRST
folder; the other folders are added working directories that the guard does not judge, so
keep a bound folder in its own window.

```
cctl where              # explain how THIS folder resolves, with the env line and a
                        # ready-to-paste VS Code settings snippet
cctl where <folder>     # the same for another folder
```

### Enforcement: what a session in the wrong account sees

So a session does not silently run on the wrong account, cctl installs a guard that checks
each prompt against the folder's binding. When a folder is bound but the session is on the
shared account, the guard blocks the prompt with:

```
cctl: C:\work is bound to alice, but this session runs on the shared account.
Exit and start it with: cctl claude   (or set up the claude wrapper: cctl shell-init powershell)
```

There are three enforcement modes, set with `cctl settings set bind-enforce <mode>`:

- **block** (default) — a mismatched prompt is refused with the message above.
- **warn** — the same message is shown, but the prompt proceeds.
- **off** — no check.

To run in a bound folder on the global account _on purpose_ for one session, launch it
with `cctl claude --override`; to run a bound account against a folder it is not bound to,
launch with `cctl claude --account <that account>`. Both are honored by the guard for that
session only.

### Binding a named session

A binding can also name ONE session instead of a whole folder: its alias (the title you give
it with `/rename` or `claude --name`) in the folder it belongs to. That conversation runs on
the bound accounts whenever it is resumed, while the rest of the folder keeps its own binding
(or the global account).

Alias binding needs **Claude Code 2.1.283 or newer**: the guard reads a session's name from
the `session_title` field Claude Code sends with each prompt (measured on 2.1.283), and never
from the transcript. An older Claude Code does not send it, so every session looks unnamed:
alias bindings do not apply, and a session started on an alias's accounts is stopped as
unnamed.

```
cctl session bind                         # this session's alias, on the account it runs on now
cctl session bind <alias> <account>[,<account>...]   # an alias in this folder, on those accounts
cctl session bind <alias> <accounts> --cwd <folder>  # an alias in another folder
cctl session unbind [alias]               # drop the binding (dissolves it when it was the last)
cctl session unbind [alias] --accounts <refs>        # remove accounts from the binding instead
```

Run inside a Claude Code session (from a Bash tool or a `!` command), both commands default to
that session: the alias is its own name and the folder is its own folder. Only a name you set
counts — a session with just a generated title is refused with `name it first: /rename <alias>`,
because a generated title changes under you. An alias longer than 200 characters is refused too:
Claude Code keeps only the first 200 characters of a session's name (an emoji counts as one), so
no session could ever carry it. (A longer alias bound by an older cctl still loads; `cctl bindings` marks it as never
matching and `cctl doctor` prints the command that unbinds it.) The accounts default to the one the session runs
on right now; when the session runs on a config dir cctl does not manage (a `CLAUDE_CONFIG_DIR`
that is neither the main config dir nor a live binding's profile), that account is unknown, so
`bind` refuses and asks you to name the accounts, and `session show` reports its slot as
unknown. Run from inside a session on a binding's profile, the commands still act on the main
config dir.

Binding an alias that is already bound **adds** the accounts to it ("add this session's account
to the ones that alias uses"), so running `cctl session bind` from sessions on different
accounts builds up the alias's list. If the binding also covers other folders or aliases (it was
created for the same set of accounts), growing it would grow those too, so `bind` refuses and
asks you to unbind the alias and bind it to the full list — and it re-checks that under the
credential lock, so a `cctl bind` elsewhere that joins the same accounts in the meantime is
never grown along with it. `--accounts` on `unbind` shrinks the same way; removing a live
account first moves the slot to another of the alias's accounts, and when none of them can
take it over (none left, or each fails to refresh right now) while a session runs on the
binding, it refuses unless you pass `--force`.

A running session counts for an alias when its transcript names it. When a live session's name
cannot be learned at all — its transcript cannot be read (a sync client or a scanner holding it),
or it has none yet (a fork, or a new session, before its first prompt) — and it runs in the
alias's folder, it may be that conversation: dissolving or shrinking the binding is refused
without `--force`, and the refusal says how many sessions could not be identified.

A folder that was moved and replaced by a link (a junction or symlink) to its new home can still
be unbound by its old path: `cctl session unbind --cwd <old path>` and `cctl unbind <old path>`
look the binding up by the folder as spelled when the resolved path is not bound.
`cctl unbind --group` dissolves the binding as it stands when it takes the credential lock —
accounts another command added in the meantime are released with the rest — and prints what it
released.

Which account a session belongs on is decided by one rule, used by `cctl claude`, the guard,
the daemon's phone spawns, `cctl where` and `cctl session show` alike:

1. its alias is bound for the folder the conversation was **recorded** in -> that binding;
2. else the longest bound folder containing the folder it runs in -> that binding;
3. else the global account.

The recorded folder is where the session was started (its transcript's first working
directory). It matters because `claude --resume <alias>` run in a git repo root can also resume
a session recorded in one of the repo's subfolders or worktrees (or in a sibling folder whose
name starts with the root's): the resumed conversation keeps belonging to its own folder, so it
is routed and checked by that folder's alias binding, and a same-titled conversation of another
folder never runs on an alias's reserved accounts. An alias binding covers the conversations of
its exact folder, not of its subfolders, and aliases compare the way `claude --resume` compares
them: case-insensitive, ignoring surrounding spaces.

**A fork belongs to the folder it is launched in.** `claude --resume <alias> --fork-session`
(or `--continue --fork-session`) copies the conversation into a NEW session of the folder you
run it in — Claude Code writes the fork's transcript to that folder's project directory with
every working directory rewritten to it, under the same name. So a fork made in the bound
folder stays on the alias's accounts, and a fork made from another folder (say the repo root, of
a conversation recorded in a subfolder) is a conversation of that folder: it runs by that
folder's own bindings, and the subfolder's alias binding no longer applies to it.

`cctl claude`, the guard, `cctl session show` and the running-session check all read a
transcript's recorded folder the same way:

- the first line with a working directory within the transcript's first 1 MiB (Claude Code
  writes a long first prompt twice before that line, so a smaller window would miss it);
- moved by the last `relocated` line within its last 64 KiB — Claude Code records one when a
  session enters or leaves a `.claude/worktrees/<name>` checkout, and re-appends it with the
  session's title;
- each trusted only when it agrees with the project directory the transcript lives in (Claude
  Code names that directory after the folder the session started in); a relocation must stay
  within the same repository's `.claude/worktrees`;
- otherwise — no working directory within the window, one that disagrees, a transcript that does
  not exist yet or cannot be read — the session counts for the folder it runs in when the project
  directory's name can stand for that folder, and for no alias binding otherwise. The name is
  lossy (`C:\a_b` and `C:\a-b` share one), so it never picks a bound folder the session does not
  run in.

`cctl claude` reads Claude Code's own arguments to see which session it opens — `--resume
<alias>`, `--resume <session id>`, `--resume <path to a .jsonl transcript>`, `--continue` (the
folder's most recent session; it wins when given together with `--resume`, as in Claude Code),
`--name <alias>` (an empty name names nothing), `--session-id`, with or without `--fork-session`
(a fork keeps its title and belongs to the launch folder) — then finds that session the way
Claude Code will (the folder's sessions, plus the repo's subfolders and worktrees when Claude
Code would search them, searched from the folder as Claude Code sees it: a junction or symlink
in the working directory resolved) and launches it on the binding of the session's own name and
recorded folder:

```
cctl claude --resume 'auth work'    # resumes the session on the accounts bound to "auth work"
```

A resume by text that matches only a generated title is an unnamed session (the folder rule
applies). An interactive `claude --resume <text>` does not find sessions started with `-p` or
the SDK (their picker reports no match), so an interactive launch does not route by them; a
`-p` launch does. Subcommands (`claude mcp ...`, `claude doctor`) and Claude Code's other entry
points (`claude rc`, `claude logs`, ...) open no session, so they run by the folder rule too. When the text matches several sessions that belong to different bindings, Claude Code
decides which one opens (its picker), so the launch uses the folder rule and the guard judges
the pick. `cctl claude` carries Claude Code 2.1.283's own option table; when your arguments hold
an option it does not know before the session flags (or `--bg`), it cannot tell which session
opens, so it launches by the folder rule and says so in one line:

```
cctl: could not tell which session these arguments open (unrecognized option "--x"); launching
by the folder rule — the enforcement guard checks the session Claude Code opens
```

`cctl claude` reads a transcript's first and last 64 KiB for its name, as Claude Code's own
search does, reads the recorded folder (above) only for the sessions the launch may open, and
reads nothing at all when no binding has a session alias or no title the launch can end up with
is bound.

A session resumed from your phone follows the same rule: the daemon looks up the resumed
session's name and recorded folder and starts it on that binding.

The guard checks each prompt with the same rule. A named session that is running on the wrong
account is stopped with how to fix it: the command resumes THAT session by its id — a name
several sessions share would reopen Claude Code's picker, and the launcher could route the pick
only by the folder rule:

```
cctl: session "auth work" in C:\repo is bound to research, but this session runs on the shared
account. Exit and resume it with: cctl claude --resume 0b1c2d3e-4f50-4617-8899-aabbccddeeff
```

The same holds on a session's very first prompt (`claude --name 'auth work'`, or a fork): Claude
Code keeps the stopped session's transcript, so its id resumes it, while its name would now match
both it and the conversation already bound (`--resume "auth work" matches 2 sessions`). The alias
in the message is only there to say which binding applies. `cctl session show` and the note
`cctl session bind` prints about the session it runs in resume a session by its id the same way.

A session on an alias's accounts that carries another name (renamed away, or another
conversation altogether) is stopped too — start it again normally with `cctl claude`, or, if it
is the bound session, rename it back — and so is a same-titled session recorded in another
folder. `cctl bindings` lists alias bindings beside folder ones, `cctl where` names the aliases
bound in a folder, and `cctl session show` adds a `Bound to` line and whether the session is in
scope (`--json`: a `binding` field). If `session bind` is run from a session that the change
leaves outside its binding, it says so: that session stays on the slot it started on until it
exits (following whatever account is live there — a running session picks up its slot's
current login on its next request), and its next prompt is flagged.

**Mixing cctl versions.** While any alias binding exists, `groups.json` is written as schema 2,
which a cctl without session aliases refuses to read (every command fails there, naming the
schema) instead of silently dropping the aliases it does not know. Update every cctl on the
machine — the daemon's included — before binding a session; once the last alias binding is
gone the file goes back to schema 1. A binding left with no folder and no session (what an
older cctl leaves when it rewrote such a file) still loads: it routes nothing, its accounts stay
reserved, and `cctl bindings` / `cctl doctor` flag it. Bind a session or folder to the same
accounts again to reuse it, or release it:

```
cctl unbind --group <id|label>     # dissolve a whole binding, whatever its folders and sessions
```

### macOS

Folder-bound accounts are **not supported on macOS yet** — `cctl bind` refuses there. The
isolation relies on a per-account credential store, and on macOS each store would prompt
the Keychain. See `docs/PLATFORM.md`.

## Switching and recovery

```
cctl switch <id|label>       # activate an account (a bound account switches ITS group's slot)
cctl switch <id|label> --force   # bypass the switch-cadence guard
cctl recover                 # recover from an interrupted switch (safe to run anytime)
```

## Usage and timeline

```
cctl usage      # cross-account usage from the daemon's latest poll
cctl timeline   # 5h-session budget per account + when every limit resets, with a
                # burn-down plan
```

Both read the daemon's last-persisted snapshot, so they work whether or not the daemon
is currently running.

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

No network call is made, and no daemon needs to be running to read them — but which account
was live when comes from the daemon's switch journal, so a turn is attributed only once the
daemon has run and synced that journal at least once; before that (measured), every turn reads
as `unattributed`. The same numbers reach the phone as `/stats`, pushed by the daemon every 15
minutes.

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
                # live login, ~/.claude.json
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
                                        # as `daemon run`; a clean exit ends supervision)

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
daemon that is alive but unresponsive. Crashes leave a line in `daemon-crash.log`
beside the vault.

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

## Session aliases

```
cctl session show                # this session: its alias, folder, and every account it ran on
cctl session show <id|alias>     # any session, by id or by alias
cctl session show <alias> --cwd <folder>   # look the alias up in another folder
cctl session aliases             # the named sessions in this folder and their accounts
cctl session aliases --all       # every folder (--auto adds sessions with only a generated title)
```

A session's alias is its title: the name you give it with `/rename` (or `claude --name`),
else the title Claude Code generates. It is exactly what `claude --resume <alias>` matches —
case-insensitive, per folder — so two folders can each have a session called `pptx`. An
alias is looked up in the current folder first; when only one other folder uses it, that
session is shown with a note, and when several do, they are listed and `--cwd` picks one.
An id always wins over an alias.

The account list is billed the same way as `cctl stats`: each turn goes to the account that
was live in the session's slot at that moment (the global slot, or its folder-bound group),
so a session that ran on several accounts over its life lists them all, in the order it first
used them, with turns, tokens and dates. `--json` prints the same data for scripts. Like
`stats`, it reads local files only and needs no running daemon — once the daemon has synced its
switch journal at least once; until then every turn reads as `unattributed`. A session's slot is
known from the hooks the daemon receives, so turns from before the daemon saw the session are
billed against the global slot.

`cctl session show` also says which account the session is bound to (see
[Binding a named session](#binding-a-named-session)) and whether it runs there: for the session
you run it from, by the account that session is on now; for any other, by the slot the daemon
last recorded for it.

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
