# CLI reference

`cctl` runs local, one-shot commands over the switch engine and the daemon's data, plus
the guided first-run wizard and the background daemon itself. Bare `cctl` (no
subcommand) prints `Not set up yet. Run: cctl setup` before setup. Afterward it opens the
full-screen view (see [Full-screen view](#full-screen-view)) when both its input and its
output are a terminal that can draw it, and prints a short status summary otherwise, so a
pipe, a script or `cctl > file` gets the same plain text it always did. A terminal that
cannot move the cursor (`TERM=dumb`, as in an Emacs shell buffer) or the legacy Windows
console gets the summary too. It never dumps raw command-tree usage.
`cctl --help` lists every command; this page adds the detail and the unhappy paths.

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

## Moving accounts to another machine

```
cctl export <file>                  # write every account, its folder and session rules, and
                                    # the persisted settings to a passphrase-sealed file
cctl export <file> --accounts work,home
                                    # only these accounts (labels, emails or ids)
cctl export <file> --no-tokens      # leave the logins out: each account is logged in
                                    # again on the other machine
cctl export <file> --move           # remove the exported accounts here once the file is
                                    # written and read back (asks first; --yes skips that)
cctl import <file>                  # add what the file holds to this machine
cctl import <file> --dry-run        # print what an import would do, and change nothing
cctl import <file> --replace        # also take the file's tokens for a stored account when
                                    # they are newer or the stored login is quarantined, and
                                    # the file's settings where this machine has others
```

The vault is sealed to the machine that wrote it (DPAPI on Windows, a local key file on
Linux), so a copy of the vault never opens anywhere else. `cctl export` reads each account's
credentials, seals them under a passphrase you choose (scrypt and AES-256-GCM), and writes one
file; `cctl import` opens it and stores the accounts in this machine's vault. There is no
plaintext mode. The passphrase comes from `--passphrase-file <file>` (its first line; a file
saved as UTF-16 or with a byte-order mark, as PowerShell writes one, reads the same), else
`CCTL_EXPORT_PASSPHRASE`, else a prompt (asked twice on export; at least 8 characters; it needs
a terminal with standard input free, so an import reading the file from standard input cannot
ask). From any
of them, a passphrase with a space at either end or a control or invisible character in it is
refused rather than trimmed: `echo secret > file` in cmd.exe writes `secret ` with the space,
and no one could type that again on the other machine. Use
`-` as the file to write to standard output or read from standard input; an import from
standard input needs the passphrase from a file or the env var. An export to `-` sends its
report to standard error, so standard output carries only the sealed file. An export never
overwrites an existing file, and the file it writes is readable by you alone (on Windows, on a
file system that keeps no per-user permissions, such as a FAT USB stick, the passphrase alone
protects it, and the export says so; other systems do not check). A file may be up to 16 MiB
and hold up to 512 accounts; a larger one is refused.

**A login works on one machine at a time.** Refresh tokens are single-use: once either machine
refreshes a login, the other machine's copy stops working. Keep each account on one machine,
either by exporting with `--move` or by removing it on the other side
(`cctl accounts remove <account>`). An export that carries tokens, and an import that stored
tokens, end with this reminder; `--dry-run` never prints it.

What travels: each account's id, label, login, email, organization, auto-switch exclusion and
(unless `--no-tokens`, in which case its plan instead, shown until it is logged in) its
credentials, freshest copy first (a rotation a running session made
is adopted before it is read); every rule a travelling account is a member of, whole, with all
of its members named by login (a member that stays behind is found by its login if the other
machine already has it, and left out otherwise); and the settings `cctl settings set`
persisted. What never travels: the relay (its URL and its pairing, which belong to this
machine), the hook secret, the vault key, switch recovery files, the guard snapshot, profiles,
the daemon's database (sessions, prompts, cards) and usage history. A setting that names a path
(`CCTL_LOG_FILE`) is left out, as is a quarantined account's stored login (the account travels
and waits for a login on the other side).

What an import does with each part, printed in full by `--dry-run` (the header, any notes and
this plan; a dry run always exits 0):

- **An account already stored here** (the same account, by the id it keeps when it is
  imported, or the same login) is left as it is. A label alone never makes two accounts the
  same. With `--replace` its tokens are replaced when the file's are newer (a later expiry) or
  the stored login is quarantined or none are stored for it (the import says "none were stored here"); the account keeps its id, its usage history and the identity
  stored for it. Only tokens whose own identity names the stored login can replace it, and a
  stored copy that cannot be read right now is not replaced either (the import says so; run it
  again).
- **A label already taken here by another login** gets a number, `work (2)`, the same way
  duplicate repair numbers labels.
- **An account without tokens** is stored waiting for a login (quarantined until then). The
  dry run says "waiting for a login" for each; the real run lists `cctl accounts relogin <label>`
  for each one that is still waiting, and that re-login must be the same account.
- **An account reserved to a rule that is not made here** (its folder is missing here, say, or
  the rule is refused while the import runs) is added but kept out of auto-switch, so a
  client's account does not end up spending its quota on other work; nor does the import move
  a slot onto it, or seat a rule it makes with it. `cctl accounts include <account>` hands it
  back to auto-switch.
- **Rules** land whole or not at all: a rule of the file is one slot, and splitting it would
  change which account its folders run on, so it is never made on part of its scopes. A rule
  keeps its identity across machines: a rule the import makes remembers which rule it is, and
  the export of a rule carries it. When the file was written on another platform and holds
  rules, the output opens with a note that folders of another platform are not looked up here,
  so rules on such folders are skipped (macOS creates no rules at all). Each rule of the file
  then ends one of four ways:
  - it **grows** the one rule here that carries its identity (an earlier import made it, say
    before one of its folders existed here; or the file came from this machine): the scopes
    and accounts it lacks are added, whatever changed on either machine since. An account the
    rule here holds the other way round (included where the file excludes it, or the reverse)
    is left as it is, and listed;
  - it is **created**, with every scope that can be used here, when no rule here holds any of
    them;
  - it is **skipped** when this machine already has the rule with these accounts, or when
    another rule here reserves every account it excludes, so it would change nothing;
  - otherwise it **fails**, counted as a failure (the import exits non-zero), naming the folder
    or session a rule of this machine holds and that rule. It also fails when this machine
    already has it split between several rules (remove all but one with `cctl folder reset`,
    then import again), or when the file holds the same rule twice (it is imported once). A
    rule here with another identity,
    or none (made here by hand), is never grown by an import, even on exactly the same
    scopes, whatever accounts it shares with the file's. To bring the two together, remove the
    rule here, every folder and session of it (`cctl folder reset <folder>`, `cctl session reset
<alias> --cwd <folder>`; resetting its last one removes the rule), and import again, which
    then makes the file's rule whole; the failure line names the commands. A folder of the file's
    rule that cannot be used here still counts: a rule here holding it fails the rule too, since
    making it on the rest would split it.

  A scope that cannot be used here is left out, and listed: its folder does not exist here, is
  a network folder (those are never looked up from a file), is a folder of another platform, or
  is one no rule may cover (a drive root, the home folder, cctl's own folders). Once it can be,
  the next import adds it to the rule the first one made (unless a rule of this machine holds
  it, see above). An exclusion of an account another
  rule here reserves is left out, and listed (only a shared account can be excluded). A rule is skipped, and listed, when
  none of its scopes is left, none of its accounts came along, none of the accounts it includes
  is in the file or here (with only its exclusions it would open its folders to every account),
  or it names one account both to include and to exclude. A rule fails, saying why, when it
  would pass the 64-rule limit or a limit on one rule (32 accounts included or excluded, 256
  folders, 256 session aliases), the 256 accounts reserved in all, or when reserving an account
  would leave this machine's main login, a folder slot that sessions run in, or the slot of a
  rule the file does not change, with no account to run on, or when an exclusion would leave a
  folder that sessions run in with no account, counting what the rest of the file reserves (the
  slot of a rule the file changes, with no sessions in it, is left empty instead, as an exclusion
  leaves it); within one file, the rule that fails is the first whose addition causes it. A rule that reserves the account live in a slot here moves that slot to another
  account (never onto one the file excludes from that slot's rule), and says so; the slots are
  chosen together, so one slot can take the account another leaves, and none takes the only
  account another could use while it has another to spare. Who is
  live in a slot is read from the slot itself, not from what cctl recorded
  for it, so a login made by hand inside a folder's profile counts, and so does this machine's
  main login when it runs an account of the file that cctl had not stored yet. Folder rules are
  not created on macOS, nor while a daemon older than this build runs (`cctl daemon restart`).

- **Settings** are checked the way `cctl settings set` checks them and saved the same way. A
  setting this machine already has with another value is kept unless `--replace`. A value that
  weakens a guard compared with the one saved in this machine's config (the default when none
  is saved), such as `bind-enforce` below `block`, `identity-check` off or `full-output` on, is
  never taken from a file, `--replace` or not; the output names the `cctl settings set` command
  to make it here. The comparison is with the saved value, not the one in force: a setting the
  daemon's environment also sets still wins over the saved one, and the output reports it as
  overridden. When a setting changed, the real run prints `cctl daemon restart` (a dry run
  does not).

What `--dry-run` prints for the rules is the decision the import itself makes, made by the same
code from the same reads, and the real run prints the same lines (in the past tense). Only what
changes on this machine between the two runs can make them differ: a session that starts or
stops in a folder a rule would leave with no account, a switch left unfinished in a slot (the
real run settles it first), an account a slot is to be moved onto that cannot go live then (its
login will not refresh: the real run checks every such account before it writes or moves
anything, and decides again without it, so the slot moves onto another account or the rule
fails, and no slot is ever moved for a rule that then fails), or an account, rule or login
changed in between. With `--replace`, a quarantined login the file brings tokens for counts as usable in the dry run too,
since the real run always takes them. Both runs also name every folder slot holding a login that
seating the rules puts on another account (an account the file newly includes there, one it no
longer excludes, the account another rule took, or a quarantined login replaced) or on none. A
slot that sessions run in is moved only as the run says, and never left with no account: a rule
that would leave it so fails.

A real run ends, in this order, with the `cctl daemon restart` line (when a setting changed),
the `cctl accounts relogin` list, a hint when nothing is live on this machine's main login
afterwards (`cctl switch <label>` for an account that can take it, else `cctl accounts add
<label>` when the accounts the import brought are all reserved or kept out of auto-switch), and
the one-machine reminder above. A dry run prints none of these.

An import is safe to run twice: everything already in place is reported as such and left
alone, and a run that stopped part-way (it still reports every rule it wrote and every slot it
moved) is completed by the next one, while the daemon settles any slot it did not get to. A rule the file carries without an identity (its registry rule had an id that is not a valid
one, as a hand-edited registry can) is given one from its folders and sessions, so the next import of the
same file finds the rule the first one made. A rule that failed because
a rule of this machine is in its way fails again until that rule is removed. A wrong passphrase, a file
changed after it was written, one cut short, or one whose rules hold more than 1024 folders and
session aliases in all is refused before anything is imported.
`--move` refuses before anything is written when an account is the live login of this machine's
main config (switch to another account first: `cctl switch <account>`), when a parallel session
runs on it (exit it first; checked as `cctl switch` checks it), when the export goes to
`-` (nothing to read back), and when there is no terminal to ask on and no `--yes`. It removes
nothing unless the written file is on the disk and reads back, opening with the same
passphrase. After that each account is checked on its own: one that is live in a folder's slot
while sessions run there, whose removal would dissolve a rule (one naming only that account)
whose folder's slot sessions are running on (exit them first), whose tokens changed since the
export, or that became the main login meanwhile is kept, reported as "Could not remove
<label>: ...", and makes the exit code 1. An account whose tokens did not travel (a
quarantined one) is kept and listed, without counting as a failure.

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
`cctl accounts list` shows the reserved accounts in their own table, each with its email, plan
and billing (as the shared table shows them) and the folders that include it.

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

### A rule for one named session

A rule can also apply to ONE session instead of a whole folder: its alias (the name you give
it with `/rename` or `claude --name`) in the folder it belongs to. It is a rule like a folder's
in every other way — it includes accounts (reserved, used first), excludes shared ones,
inherits the rest of the shared pool, and runs in its own slot — and it **outranks every folder
rule**, the one of its own folder included. It does not merge with that folder's rule: a
session alias's rule names its own includes and excludes.

```
cctl session include <alias> <account>[,<account>...]   # reserve accounts to that session, used first
cctl session include <alias> <accounts> --cwd <folder>  # an alias of another folder
cctl session include <alias> <accounts> --label <name>  # ...naming the rule it creates
cctl session exclude <alias> <account>[,<account>...]   # keep that session off some shared accounts
cctl session reset <alias> <account>[,<account>...]     # take accounts back out of its rule
cctl session reset <alias>                              # remove the session's rule entirely
```

As for folders, the alias and the accounts are always named — nothing is filled in for you.
The folder is `--cwd`, else, when you run the command inside the session the alias names (from
a Bash tool or a `!` command), the folder that session belongs to, else the current folder.
Only a name you set counts: a session with just a generated title is not covered (a generated
title changes under you), and aliases compare the way `claude --resume` compares them:
case-insensitive, ignoring surrounding spaces. An alias longer than 200 characters is refused:
Claude Code keeps only the first 200 characters of a session's name (an emoji counts as one),
so no session could ever carry it; so is one with control or bidirectional characters. A rule
for one session covers the conversations recorded in its exact folder, not in its subfolders,
so your home folder or a drive root may hold one. The reports are the folder verbs' own, about
the session ("Created a rule for session "auth work" in C:\repo: it uses research first, then
the shared pool."); when the command runs inside a session that is now on another slot than its
rule names, it says so, with the command that resumes it.

Session alias rules need **Claude Code 2.1.283 or newer**: the guard reads a session's name from
the `session_title` field Claude Code sends with each prompt, never from the transcript. An
older Claude Code does not send it, so every session looks unnamed and runs by its folder's rule.

Which rule a session runs under is decided by one rule, used by `cctl claude`, the guard, the
daemon's phone spawns and background moves, `cctl where` and `cctl session show` alike:

1. its alias has a rule for the folder the conversation was **recorded** in -> that rule;
2. else the longest ruled folder containing the folder it runs in -> that rule;
3. else the global slot.

The recorded folder is where the session was started (its transcript's first working
directory), or where it moved to since: entering or leaving a worktree (`EnterWorktree`,
`ExitWorktree`) moves a session, and Claude Code moves its transcript along. It matters because
`claude --resume <alias>` run in a git repo root can also resume a session recorded in one of
the repo's subfolders or worktrees (or in a sibling folder whose name starts with the root's):
the resumed conversation keeps belonging to its own folder, so it is routed and checked by that
folder's alias rule, and a same-titled conversation of another folder never runs on an alias
rule's reserved accounts.

**A fork belongs to the folder it is launched in.** `claude --resume <alias> --fork-session`
(or `--continue --fork-session`) copies the conversation into a NEW session of the folder you
run it in, under the same name. So a fork made in the alias's folder stays under its rule, and a
fork made from another folder is a conversation of that folder.

`cctl claude`, the guard, `cctl session show` and the running-session check all read a
transcript's recorded folder the same way:

- the first line with a working directory within the transcript's first 1 MiB (Claude Code
  writes a long first prompt twice before that line, so a smaller window would miss it);
- the last `relocated` line within its last 64 KiB — Claude Code records one whenever a session
  changes folder (a `.claude/worktrees/<name>` checkout, or `/cd`) and moves the transcript into
  that folder's project directory;
- the relocation counts when the project directory the transcript lives in is named after it and
  it leads to where the session started or above it, counting a `.claude/worktrees/<name>`
  checkout as its repository. Otherwise the first working directory counts, when the project
  directory is named after it;
- otherwise — no working directory within the window, one that disagrees, a transcript that does
  not exist yet or cannot be read — the session counts for the folder it runs in when the project
  directory's name can stand for that folder, and for no alias rule otherwise. The name is lossy
  (`C:\a_b` and `C:\a-b` share one), so it never picks a ruled folder the session does not run in.

`cctl claude` reads Claude Code's own arguments to see which session it opens — `--resume
<alias>`, `--resume <session id>`, `--resume <path to a .jsonl transcript>`, `--continue` (it
wins when given together with `--resume`, as in Claude Code), `--name <alias>`, `--session-id`,
with or without `--fork-session` — then finds that session the way Claude Code will (the
folder's sessions, plus the repo's subfolders and worktrees when Claude Code would search them)
and launches it on the rule of the session's own name and recorded folder:

```
cctl claude --resume 'auth work'    # resumes the session on its rule's slot
```

A resume by text that matches only a generated title is an unnamed session (the folder rule
applies). An interactive `claude --resume <text>` does not find sessions started with `-p` or the
SDK, so an interactive launch does not route by them; a `-p` launch does. When the text matches
several sessions under different rules, Claude Code decides which one opens (its picker), so the
launch uses the folder rule and the guard judges the pick. `cctl claude` carries Claude Code's
own option table; when your arguments hold an option it does not know before the session flags,
it cannot tell which session opens, so it launches by the folder rule and says so in one line:

```
cctl: could not tell which session these arguments open (unrecognized option "--x"); launching
by the folder rule — the enforcement guard checks the session Claude Code opens
```

It reads nothing at all when no rule holds a session alias, or no title the launch can end up
with has one. A session resumed from your phone follows the same rule, and so does a background
session the daemon moves: it goes to the slot of its alias's rule when it has one, whatever its
folder runs under.

The guard checks each prompt with the same rule, and treats a session alias's rule exactly as a
folder's: a session on the global slot is accepted unless the rule excludes that account (or it
is reserved to other rules), with the one-time notice when the rule includes accounts it is not
on. Its refusals and notices name the session and resume THAT session by its id — a name several
sessions share would reopen Claude Code's picker:

```
cctl: session "auth work" in C:\repo has its own cctl rule (it uses research first) and
excludes personal, the account this session runs on. Exit and resume it with: cctl claude
--resume 0b1c2d3e-4f50-4617-8899-aabbccddeeff
```

A session on a session alias's slot that carries another name (renamed away, or another
conversation altogether) is refused too — start it again with `cctl claude`, or, if it is that
session, rename it back — and so is a same-titled session recorded in another folder.

`cctl folders` lists a session's rule with a `session:` line in place of its folder,
`cctl where` names the sessions with a rule of their own in a folder (they outrank the folder's
rule), and `cctl session show` adds `Rule` and `Slot` lines (`--json`: a `binding` field). A
running session counts for an alias when its transcript names it; when a live session's name
cannot be learned at all (its transcript cannot be read, or it has none yet: a fork or a new
session before its first prompt) and it runs in the alias's folder, it may be that conversation,
so emptying the rule's slot refuses without `--force`, and says how many could not be
identified. A rule whose folder was moved and replaced by a link (a junction or symlink) to its
new home can still be removed by its old path: `cctl session reset <alias> --cwd <old path>`
(and `cctl folder reset <old path>`) look the rule up by the folder as spelled when the resolved
path has none.

**Mixing cctl versions.** While any session alias rule exists, `groups.json` is written as
schema 3, which a cctl without them refuses to read (every command fails there, naming the
schema) instead of quietly routing named sessions by their folder alone. So `cctl session
include` and `exclude` (and `reset` with accounts) refuse while a running daemon predates them
— restart it on this build first (`cctl daemon restart`); `cctl doctor` flags the same
mismatch (`daemon-alias-rules`). Once the last session rule is gone the file goes back to
schema 2. Before going back to an older build, remove every session rule with
`cctl session reset <alias>`.

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
cctl claude --account <id|label>   # run on that account in this terminal only: on the slot where it is
                                    # live, following that slot's switches (global, this launch's rule,
                                    # a named session's), else in a slot of its own (see "Parallel sessions")
cctl claude --override             # launch here on the global account, on purpose (see below)
cctl claude -- <claude args...>    # everything after -- is passed through to claude
cctl claude attach <id|name>       # open a background session on its folder's account (see
cctl claude --resume <id|title>    # "Opening a background session" below)
```

`cctl claude` resolves which slot to use (an explicit `--account`, which outranks a rule that
would otherwise decide, within the limits under Parallel sessions; else the folder's rule; else global), makes sure an account is live there, prints a one-line banner naming
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

One PowerShell caveat: the wrapper is a PowerShell _function_, and PowerShell binds a
function's arguments before it runs — a bare `--` is consumed, an unquoted comma splits one
argument into several, and `-name:value` splits at the colon. So through the wrapper
`claude -p -- --resume x` resumes the session `x`, where a direct `claude.exe` call sends the
prompt "--resume x", and `claude --resume=a,b` resumes "a". Quote such arguments (`'--'`,
`'--resume=a,b'`, `'-r:x'`) or call `claude.exe` directly. The generated wrapper says so too.

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

So a session does not silently run on an account its folder must not use, cctl installs a
guard that checks each prompt against the folder's rule.

**A plain `claude` in a ruled folder** (no wrapper) runs on the global slot. A ruled folder's
pool inherits the shared pool, so the global slot's account is one the folder accepts, and
the prompt goes through. When the rule includes accounts, the session is told once (on its
first prompt, not on every one) that it is not on them:

```
cctl: C:\work has its own cctl folder rules (it uses A, B first). This session runs on C
from the shared pool, which this folder also accepts. To use A, B here, exit and start it
with: cctl claude   (or set up the claude wrapper: cctl shell-init powershell)
```

A background session (`claude --bg`) is told instead that cctl moves it: once one of the
folder's included accounts is live in its slot and can take work, the daemon stops the
session between turns and resumes it under the folder's slot, with the same session id and
the same conversation (see below).

**The global slot on an account the folder must not use** is refused: one the rule
excludes, or one reserved to other folders.

```
cctl: C:\work has its own cctl folder rules (it uses A, B first) and excludes D, the
account this session runs on. Exit and start it with: cctl claude   (or set up the claude
wrapper: cctl shell-init powershell)
```

The guard tells which account the global slot holds from the identity Claude Code records
for its login (`oauthAccount` in the main config's `.claude.json`), never from credentials.
When it cannot tell (that file is missing or unreadable, or an excluded account has no
recorded identity), a folder whose rule excludes accounts refuses the prompt — allowing it
could run the folder on the very account it excludes — and a folder that excludes nothing
lets it through with the notice.

**A session on another folder's slot** is refused in a ruled folder, and a session on a
folder's slot is refused outside that folder's folders, exactly as before. So is **a session
on a config dir cctl does not manage** (a `CLAUDE_CONFIG_DIR` that is neither the main config
dir nor a folder's profile, such as a second Claude Code config a shell exports, or the
profile of a rule since removed): its login is its own, so the global slot's identity says
nothing about which account it runs on. `--override` does not relax this one: it launches on
the global slot, and such a session is not on it. Unset `CLAUDE_CONFIG_DIR`, or start the
session with `cctl claude`, which puts it on the folder's slot.

There are three enforcement modes, set with `cctl settings set bind-enforce <mode>`:

- **block** (default) — refuses only the sessions above: an account the folder's rule rules
  out, or a slot that is not the folder's. Every other account is allowed, with the
  one-time notice.
- **warn** — the same sessions are flagged on every prompt, but nothing is refused.
- **off** — no check.

### Background sessions move onto the folder's slot

A running Claude Code session cannot change account: its account is the config dir it
started with, and the global slot is shared by every plain session in every folder, so it
cannot be switched for one folder. Background sessions are the exception. Claude Code hosts
them in a background service of its own, one per config dir, and keeps their conversations
in `projects/`, which every folder profile shares with the main config dir. So in each poll
cycle, for every rule whose slot holds one of its included accounts with usage left, the
daemon moves each background session the global slot's service hosts in that folder:

1. it checks that the session is idle between turns (`claude agents` reports it idle) — a
   session in a turn, or waiting on a permission prompt, is left for a later cycle — that it
   holds no work between turns (a scheduled wakeup, a background task: Claude Code reports
   such a session idle, but a stop would drop the work), and that no terminal has a
   background session of that service open (`claude attach`, or the agent view). Claude Code
   does not say which session a terminal has open, so while one is open, nothing moves;
2. it stops the session (`claude stop`), and while the session runs nowhere it removes every
   job row Claude Code keeps for it, in every config dir (`claude rm`, which deletes the row
   and keeps the conversation);
3. it resumes the session's current conversation by its full session id under the folder's
   profile (`claude --bg --resume <id>`, with no prompt, so no turn is spent), from the
   session's working directory, with every option the session was started with and Claude
   Code saved (its model, permission mode, added directories, tool restrictions, settings,
   budgets and the rest);
4. it confirms the folder's service now hosts it, logs the move in the daemon log and sends
   one phone notice.

Why every row goes: each config dir keeps a job row for a session it ran, and Claude Code
acts on a row under its own config dir whatever runs elsewhere. A row left under the global
slot for a session that now runs on the folder's slot is a trap: a `claude attach`, an
interactive `claude --resume` (by id, by title, or chosen in its picker), a `claude stop`,
`claude rm` or `claude respawn`, or Enter or Ctrl+X in `claude agents`, run under that config
dir, reaches the session where it runs and kills it there, in the middle of a turn too. So a
background session keeps a job row only in the config dir where it runs or last ran.

After `/clear` inside a background session, its job runs a new conversation; the move
resumes that one (the job then shows up under the new conversation's short id). A row another
config dir keeps of the job's earlier conversation, or of that conversation resumed as a job of
its own, is not this session's and is left alone: it reaches only the old job id, which the moved
session no longer runs under. When the session would keep its job id (no `/clear` since it
started) and another config dir runs a different conversation under that id, nothing tells the
two apart, so the session is not moved (one notice).

Claude Code's `claude stop` returns a moment before the session has exited, so the move waits
until the session is gone from Claude Code's session registry and from the service before it
removes its rows and resumes it elsewhere (a resume while it still runs would start a copy).
The daemon and `cctl claude` (below) never move one session at once: each takes the
session's move lock, under cctl's data folder, on every id the session is known by (the id its
job started with and, after `/clear`, the conversation it runs now, so the two always meet on
one), and the daemon leaves a session alone while `cctl claude` holds it.

A session moves at most once an hour, so one woken back onto the global slot by hand is not
bounced every cycle. If a move fails, the session is resumed back on the global slot with its
saved options (tried a few times, since Claude Code can count a session it just stopped as
still open), the daemon logs it and sends one phone notice, and it does not try that session
again until it restarts. When even that fails, the notice gives the command that brings it
back as it was: `cctl claude --resume <id>`, in any shell, from any folder. A move saves how
to bring the session back (where it ran, its folder and its saved options) before it touches
anything; that command runs the move's own way back from it, then opens the session as below.
The move drops what it saved once the session runs again, moved or put back; `cctl claude`
drops it whenever it finds the session running, or finds the job row the way back would wake
woken since by other means, and it is kept a week at most. One that names no config dir of
cctl's, or options other than a move saves, is never used.

A session that cannot move without changing is left where it is, with one notice: one
started with an option this cctl does not know, or one that would act again at startup
(`--file`, `--rewind-files`, `--session-id`, `--reply-on-resume`); one holding permission
rules granted while it ran (they are kept in its job row, and no option carries them over);
and one working in a git worktree Claude Code made for it (`claude --bg -w`): `claude rm`
deletes such a worktree along with the row, so that session is never moved, and stays where
it runs.

Sessions in folders without a rule are never moved, and an exclude-only rule
prefers no account, so its sessions stay where they are. The moves use the `claude` on the
daemon's PATH (the one that started the background service). Not on macOS, where folder
rules are not supported.

An interactive session cannot be moved this way; it gets the relaunch notice above.

### Opening a background session

Claude Code runs one background service per config dir, so a background session runs either
in the main config dir's service (the global slot) or in a folder profile's. A plain
`claude attach` or `claude --resume` in a ruled folder runs on the folder's profile, and when
the session runs in another service, a job row the profile still holds for it is the trap
described above.

`cctl claude attach <session>` and `cctl claude --resume <session>` (also after `--`, with
other options around them, and in every spelling Claude Code reads as a resume: `-r <id>`,
`-r<id>`, `-pr <id>`, `--resume=<id>`) find the session first:

- by any full session id it has had (the id it started with, and the conversation it runs
  after `/clear`);
- for `attach`, by its short id or any shorter start of it (Claude Code reads one to eight
  hex digits as the start of a job id, never as a name), else by its name, whole or in part;
- for `--resume`, by its conversation title, among the sessions of this folder and of the
  folder's git worktrees (Claude Code's own `.claude/worktrees` among them), as Claude Code
  searches. A title more than one conversation there has is passed to Claude Code, whose
  picker then opens, unless a job row on this slot could be chosen in it into the trap above:
  then it is refused with their ids.

A name that matches more than one session is refused with their ids. A session that is not a
background session (no job row anywhere, no background service running it) is passed to
Claude Code as typed. The session belongs to the slot of the folder it works in (an attach by
id from another folder follows the session, not the folder you are in). Then:

- **it runs where it belongs**: it is opened there;
- **it runs on another account, idle between turns, holding no work, with no terminal on
  that service**: cctl says it is moving it, moves it where it belongs by the same move the
  daemon makes and on the same terms (the folder's slot holds one of its included accounts
  with usage left, its saved options carry over, no git worktree), and then opens it there.
  Ctrl-C from the moment it says it is moving does not cut the move off: the move finishes,
  or puts the session back, and then nothing is opened (before that line, nothing has been
  touched, and Ctrl-C ends `cctl claude` as usual). Closing the window is not waited on for
  long: Windows ends a program a few seconds after its console closes. Should that, or
  anything else, end `cctl claude` in the middle of a move, `cctl claude --resume <id>` (said
  when you press Ctrl-C) brings the session back where it was. One line says it was moved,
  and onto which account;
- **it runs on another account and is in a turn, waiting on a prompt, holding work between
  turns, watched from another terminal, in a git worktree, or cannot move** (or the move
  failed and it was put back): it is opened where it runs, with one line saying it stays on
  that account for now and why, and, when cctl's daemon is running and will do it, that the
  daemon moves it between turns. A session left on the profile of a rule since removed has
  no login there (every prompt fails with "Not logged in"), so it is moved onto its folder's
  slot whenever it is idle, and otherwise opened there with that said plainly;
- **it is open in a terminal** (an interactive session): nothing is touched, and cctl says
  which process has it open;
- **it runs nowhere**: `attach` opens it where it belongs, removing its rows elsewhere first,
  restarting a failed row there, or, when the profile holds no row for it, starting it there
  with the options its latest row saved (when those cannot carry over, or its row records a
  git worktree, it is opened where that row is). `--resume` runs it in the foreground as
  Claude Code does. When its rows record different conversations under one job id (its
  conversation before `/clear` among them), `attach` cannot tell which is meant: it is refused
  with each conversation's id and where its row is, to resume one by its id.

A prompt given after the session (`cctl claude --resume <id> "<prompt>"`) is passed on as
`claude --resume <id> "<prompt>"` under the config dir that runs it, where Claude Code sends it
to the session and opens it.

`cctl claude stop|kill|rm|respawn <session>` is run under the config dir whose service runs
the session, by its job id there. Anything else `cctl claude` passes to Claude Code that can
reach a job row — the `--resume` picker, `--continue`, the `agents` view (`agents --json`
too), `logs`, a `respawn` of every session, an id or a title cctl does not find — is checked
first against the job rows of the slot it runs on: one held there for a session running in
another service refuses the command, naming the session, where it runs, and
`cctl claude attach <short id>` to open it. So is anything cctl cannot tell is a plain new
session: a short option cluster with `r` or `c` in it that is no plain resume (`-cr <id>`,
which Claude Code runs as `--continue` whatever the id, or `-dr`), or `--from-pr`. Only
arguments that are plainly a new session (a prompt and options, none of the above), a new
background start (`--bg`) and a copy (`--fork-session`) are passed on without that check.
So nothing `cctl claude` runs opens, stops or removes a session through a row under one
config dir while it runs in another's service. `cctl claude` holds the session's move lock
while it decides, and until the terminal it started shows up in the service's attach journal,
so the daemon cannot move the session in between. With `--account` or `--override` the
session is never moved, but it is still opened where it runs rather than taken from there.

To run in a ruled folder on the global account _on purpose_ for one session, launch it
with `cctl claude --override`; `--account` runs the account you name here instead of the
rule's (refused in some cases: see Parallel sessions). Both are honored by the guard for that session only.
`--override` relaxes a session on the global slot only: from a shell whose
`CLAUDE_CONFIG_DIR` names a config dir cctl does not manage, the session runs there and is
refused as above.

### Parallel sessions (one account per terminal)

`claude --account work` (through the shell wrapper; `cctl claude --account work` without it)
runs Claude Code on `work` in this terminal only. Other terminals and folders keep their
accounts.

Where it runs:

- on the global slot when `work` is live there. That session then follows global switches,
  from any terminal or the phone;
- in the slot of the rule this launch runs under when `work` is live there: this folder's
  rule, or the rule of the named session its arguments open (`--resume <title>`). It then
  follows that rule's switches;
- in the slot of a folder or named session `work` is reserved to (a rule that includes it),
  when it is live there, from any folder. The session then follows that rule's switches,
  which can move it off `work`;
- otherwise, when `work` is live in no folder's or named session's slot, in a
  parallel-session slot of its own.

Live in the slot of any other rule, `work` is refused: a shared account serving another
folder's or named session's slot, or a reserved account live in a rule that does not include
it. It is also refused when it is live in two slots, when it is quarantined (fix:
`cctl accounts relogin work`; joining a parallel session already running on it is allowed), and
when the rules registry is full (64 rules, parallel sessions included). That covers this folder's own slot too when the launch opens a named session whose rule has
a slot of its own. Run claude where that slot applies, or switch that slot to another account
first (for a named session's slot, keep `work` out of it with `cctl session exclude`).

While a parallel session runs:

- `work` leaves every pool. No switch or auto-switch picks it, `cctl switch work` refuses and
  says so, and the phone cannot start or resume a session on it.
- The slot never auto-switches. At a usage limit the session stops, as at any limit.
- Two terminals on `work` share one slot.

Do not run `/login` inside a parallel session: it would put another account in that slot. The
daemon notices that on a later check (nothing happens without it): the other account's refreshed
login is saved with that account, and the copy in the slot is cleared only when that account
could be live in another slot too; otherwise it stays, since no other slot can take it meanwhile.
The session's own account is not changed.

When the last terminal on `work` exits, its refreshed login returns to cctl and `work` rejoins
the pool. A closed window or a killed process is cleaned up by the daemon at its next check
(a busy Windows machine can take longer; a check that cannot decide is retried), or, with no
daemon, by the next `cctl switch`, `accounts remove`, `folder exclude`, `session exclude` or
`cctl claude --account`, which first end every session whose processes are gone.

A Claude Code the session started that outlives it on its profile (a backgrounded `claude -p`)
keeps `work` reserved until it exits: it may still use the login. The terminal names its pid
when it exits, and `cctl doctor` names it too. Anything else the session started (a dev server,
an editor) does not hold `work`: it never reads the login.

On Windows the last terminal out may pause while the process list is read (up to 60 s). From
the claim until the release, Ctrl-C, Ctrl-Break and closing the console are ignored in the
wrapper, so a stray one cannot cut the release short; a terminal that is not the last reads
nothing on the way out. A session holds at most 32 processes.

When the release cannot finish, the terminal says so: `could not return <label> to the pool yet
(<reason>)` (a roster, process list or slot that could not be read or settled; the daemon or the
next command above retries), or `<label> stays reserved ...` (a Claude Code process or a
background-service session started from it still runs on its profile; it rejoins when that
exits). For an unsaved login the fix is `cctl accounts relogin <label>`. The session shows in
`cctl status`, `accounts list`, `usage`, `timeline` and `folder list` as in use. `cctl folder
include` of an account a session holds waits until it ends, and `cctl accounts remove` is
refused. `--override` with a parallel session relaxes nothing.

History is shared, as in folder profiles: `--resume` and `--continue` see every conversation.

Not available with it (for now): `--bg`, `attach`/`stop`/`rm`/`kill`/`respawn`, and Claude
Code subcommands. For a named session that should keep an account, use
`cctl session include <alias> <account>`.

It needs a build that reads parallel sessions (1.1.0 or later) everywhere it can run. A running
daemon on an older build is refused (fix: `cctl daemon restart`), and so is an older `cctl` on
PATH, in the PowerShell `claude` wrapper or in the autostart registration (fix: update that
install). An older cctl cannot read the rules file while a parallel session exists.

macOS: not available yet, except for an account that is already live in the global slot.

### macOS

Folder rules are **not supported on macOS yet** — `cctl folder include|exclude` refuse
there. The isolation relies on a per-slot credential store, and on macOS each store would
prompt the Keychain. See `docs/PLATFORM.md`. Parallel sessions likewise.

## Full-screen view

```
cctl            # on a terminal, once set up
cctl tui        # the same view, by name; works before setup too
```

One screen with four panes, refreshed every 2 seconds (a timed refresh is skipped while an action runs or a read is still in
flight, and a read follows the action) and after every action: **Accounts**
(each account's plan, its 5-hour and weekly usage with reset times, any per-model weekly
windows, its folder rules, whether it is excluded or quarantined, and how old the reading is),
**Sessions** (what `cctl session status` shows), **Folders** (`cctl folders`) and **Outages**
(`cctl outages`). The header says whether the daemon is running, whether auto-switch is on, and
when it last polled (the newest usage reading of any account, or "no poll yet"). The auto-switch
part only shows while the daemon is running. Colour is used when the output is a terminal and
`NO_COLOR` is unset. Everything is read locally from the vault and the daemon's database, the
same places the commands read; nothing in the view calls Anthropic. A reset marked `~` is
predicted from history rather than reported.

| Key                 | What it does                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| up/down or k/j      | move the selection (Accounts) or scroll (other panes)                                                                                                                                                                                 |
| PgUp/PgDn, Home/End | move or scroll further                                                                                                                                                                                                                |
| Tab / Shift-Tab     | next / previous pane                                                                                                                                                                                                                  |
| Enter               | switch to the selected account (same as `cctl switch`)                                                                                                                                                                                |
| e                   | exclude the selected account from auto-switch, or include it again                                                                                                                                                                    |
| r                   | rename the selected account                                                                                                                                                                                                           |
| a                   | add an account: the screen steps aside for a Claude login window (as `cctl accounts add --fresh`), then comes back                                                                                                                    |
| d                   | remove the selected account; you type its label to confirm                                                                                                                                                                            |
| u                   | ask the running daemon to refresh usage now; it still honors each account's poll floor and any rate-limit backoff, and says which accounts it held back and until when. Unavailable, with the reason, while the daemon is not running |
| l                   | show the command that runs Claude as the selected account, to paste in another terminal                                                                                                                                               |
| m                   | show the last message in full (a long one is cut on the status line)                                                                                                                                                                  |
| ?                   | the key list                                                                                                                                                                                                                          |
| q or Esc            | quit                                                                                                                                                                                                                                  |

Enter, e, r, d and l act on the selected account, so they work only in the Accounts pane;
elsewhere the status line tells you to Tab to it. a, u, ?, m and q work in every pane.

q and Esc quit from the list. In a prompt, Esc cancels it and q is just typed; in the help,
message and launch overlays, q and Esc close the overlay. While an action is running q and Esc
do nothing; Ctrl-C always works. It quits the view as soon as the action finishes; a second
Ctrl-C gives the screen back at once, and cctl exits when the action has finished (it is never
cut off part way). Either way, how the action ended is printed on the normal screen, and a
refused action makes the exit code non-zero. A signal exits with 128 plus its number (SIGHUP 129,
SIGINT 130, SIGTERM 143); one that arrives during an action waits for it and prints "Still
finishing the running action...". While a login window is up, Ctrl-C and Ctrl+Break belong to
that window and the view ignores them.

The help and message overlays scroll with the movement keys, including Home/End and
PgUp/PgDn, in a short terminal. They and the
launch line close on Esc or any other key except Enter, so a doubled Enter never reaches the
account list. A prompt takes Backspace, filters out control characters and caps its input at 200
characters. A rename, add or remove prompt whose Enter does not go through (an empty label, a
label another account already has, a mistyped confirmation) stays open and says why, and a rename
or remove the vault refuses opens its prompt again with the reason; Esc then leaves the reason on
the status line, where m shows all of it. A removal is checked against the label you typed once
more when it runs, so an account renamed elsewhere in the meantime is not removed. A prompt whose
account is removed elsewhere while it is open takes nothing more and closes on Esc. When the
selected account is removed, here or elsewhere, no account is selected until j/k picks one, so no
key lands on an account you did not pick. Pasted text only ever goes into a prompt; in the list it does nothing. Keys typed while the
screen is stepped aside for a login window are dropped when it comes back, for as long as they
keep arriving.

As the terminal narrows, columns give way in a fixed order: per-model windows first, then reset
times, then the plan; after that the label column narrows and the tags are cut, and the key-hint line
drops its least important hints first. Below 40 columns (or 6 rows) the view shows a notice instead, and only q,
Esc and Ctrl-C do anything until it is larger. A long message wraps onto up to three status
rows, never taking the selected account's row; one longer than that keeps its start and its end,
and m shows all of it. cctl's own messages are drawn with plain ASCII punctuation, so they are as
wide on a terminal set up for CJK text as anywhere else. Diagnostics that
would normally go to stderr appear on the status line, so they never draw over the screen; every
one logged while an action ran is shown with that action's result (and printed after an error
ends the view). Quitting, a signal, a closed terminal and an error all give the terminal back as
it was. `cctl tui` refuses to start when its input or output is redirected, or on a terminal that
cannot draw it (`TERM=dumb`, or a Windows console that does not answer a cursor-position query,
as the legacy console does not), and points at `cctl usage` for plain output; bare `cctl` prints
the summary there instead. The legacy console setting only applies to windows opened after it is
changed.

## Switching and recovery

```
cctl switch <id|label>       # activate an account (a reserved account switches its folder's slot;
                             # refused while the account runs a parallel session; a session
                             # whose processes are gone is ended first, as `accounts remove`,
                             # `folder exclude` and `session exclude` also do)
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
                # live login, ~/.claude.json, and whether the daemon has autostart;
                # with folder rules or parallel sessions also slots, rule-scopes,
                # guard-snapshot, guard-hook, parallel-sessions, daemon-folder-rules,
                # daemon-alias-rules and daemon-parallel-sessions
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
was live in the session's slot at that moment (the global slot, or its folder rule's slot),
so a session that ran on several accounts over its life lists them all, in the order it first
used them, with turns, tokens and dates. `--json` prints the same data for scripts. Like
`stats`, it reads local files only and needs no running daemon; a session's slot is known
from the hooks the daemon receives, so turns from before the daemon saw the session are
billed against the global slot.

`cctl session show` also says which rule the session runs under (see
[A rule for one named session](#a-rule-for-one-named-session)) and whether it runs on that
rule's slot: for the session you run it from, by the config dir that session is on now; for any
other, by the slot the daemon last recorded for it. A session on the global slot under a rule is
told the rule accepts it unless it excludes that account, and how to move onto the rule's own
accounts.

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
