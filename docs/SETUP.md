# `cctl setup` walkthrough

`cctl setup` is the guided first-run wizard: one command from a fresh install to a
paired, autostarting daemon. This page walks every step as it actually runs, including
every unhappy path.

## Before you start

`cctl setup` refuses to run outside a real interactive terminal (both stdin and stdout
must be TTYs) — a piped, redirected, or CI invocation prints one line and exits rather
than hanging on input that can never come:

```
error: cctl setup is interactive and needs a terminal. Run it directly in a console
(not through a pipe, redirect, or CI).
```

## Flags

```
cctl setup                  # run the wizard (skips already-complete steps)
cctl setup --reconfigure    # force the full walk even when already set up
cctl setup --relay <url>    # pair against a specific relay instead of the default
```

## Re-entry is free

Every step reads **real on-disk state** — not a progress file that could drift — so
`cctl setup` is safe to interrupt (Ctrl+C) and re-run at any time. If accounts exist,
hooks are installed, and the logon task is registered, a bare re-run prints a one-line
summary and stops instead of repeating work:

```
Already set up. 2 account(s), hooks in C:\Users\you\.claude\settings.json,
autostart on, paired.
Details: cctl status   ·   reconfigure: cctl setup --reconfigure
```

Pairing is intentionally excluded from "already set up" — skipping Discord pairing is
a valid, complete local-only setup, and `--reconfigure` is how you go back and pair
later without re-answering everything else.

## The eight steps

### [1/8] Checking your environment

Runs `cctl doctor`'s checks inline (Node version floor, vault crypto round-trip, vault
directory, live login, `~/.claude.json`) and prints them. A failed check does not stop
setup — it's a warning to revisit if a later step fails, since most checks (e.g. "not
logged in yet") are expected to still be red this early.

### [2/8] Your current Claude account

If accounts are already captured, this step is a no-op ("Leaving them as-is").
Otherwise:

- **Not logged in is a pause, not an exit.** The account IS the point of this step, so
  the wizard loops rather than bailing:

  ```
  No Claude login found. In another window run `claude` and `/login`, then come back.
  Press Enter to re-check (Ctrl+C to stop):
  ```

- Once a login is detected, you're asked for a label (`Label for this account
[default]:` — bare Enter uses `default`), and the currently logged-in account is
  captured into the vault. Your live login is never touched by this step.

### [3/8] Add more accounts (optional)

A `[y/N]` loop (default No on bare Enter): each `y` prompts for a label and runs the
`--fresh` capture flow — a throwaway `claude` window where you log into the _new_
account without touching your existing live login. An empty label skips that one
iteration rather than failing the whole step.

### [4/8] Usage hooks

If hooks are already present in your profile's `settings.json`, this is a no-op.
Otherwise the wizard explains (and does not itself write anything yet):

```
Hooks will be installed into <settings.json path> when the daemon starts (step 8).
```

This is deliberate, not a bug: the hook command line carries the daemon's loopback
port, which is only known once the daemon actually binds it. Writing a
soon-to-be-stale entry here would just create work for step 8 to redo.

### [5/8] Prompts to idle sessions

The one step that asks for administrator rights, and the only one whose absence is
otherwise invisible. Without it, a prompt you send from Discord to an interactive
session waits until that session finishes a turn or you type in it — which never
happens while you are away, the case phone control exists for.

If it is already enabled the wizard says so and moves on. Otherwise it explains what
the file does, names the exact path, and asks:

```
Enable prompts to idle sessions? [y/N]:
```

Answering yes writes one file into Claude Code's managed-settings drop-in directory and
raises a single Windows consent prompt. There is no prompt on any later session. The
default is No, and nothing is written without an explicit yes.

Three outcomes, all reported plainly:

- **Accepted** — the path it wrote, plus a reminder that only sessions started from now
  on can receive prompts while idle. A channel is attached at launch, so a session
  already running cannot be upgraded.
- **Consent declined** — nothing was written, and setup continues. `cctl channel enable`
  turns it on whenever you want.
- **macOS/Linux** — cctl does not escalate privileges for you. It prints the `sudo`
  command to run and the JSON to place.

Skipping is free: everything else works, and a prompt from Discord still delivers at the
next turn boundary. `cctl channel status` and `cctl doctor` both report the current state.

### [6/8] Relay

Prints the effective relay URL (flag → `CCTL_RELAY_URL` env → `relayUrl` in
`config.json` → built-in default) and
probes its `/health` endpoint. An unreachable relay does not stop setup — it's a
warning that pairing below may fail, with the same actionable detail `cctl doctor`
would show.

### [7/8] Pair with Discord

If already paired: informational only, with the re-pair command for later.

Otherwise, the invite/instructions come **before** the code prompt:

```
In your Discord server (or a DM with the bot), run `/pair` to get a one-time code.
No server with the bot yet? Add it first: <bot invite URL>
Or add it to just your account (no server needed) and DM it: <user-install URL>
Enter it below, or type s to skip and set up local-only.
Pairing code (or `s` to skip):
```

- Codes are normalized before use: whitespace and dashes stripped, lower-cased — `AB-CD
12` and `abcd12` pair identically.
- `s` / `skip` (case-insensitive) at any point exits the loop with a valid **local-only**
  setup; pair anytime later with `cctl setup --reconfigure`.
- An empty (non-skip) answer re-prompts without attempting to pair.
- On failure, the message is reason-specific and the loop lets you retry or skip:
  - **`timeout`** — the wizard's own ~15s deadline fired (pairing's `connect()` never
    rejects on an unreachable relay by itself, so the wizard imposes this timeout):
    "Couldn't reach the relay (...). Check a firewall/proxy, or override with `--relay
<url>`."
  - **`rejected`** — the relay actively refused the code: "The relay refused that code
    (...). Codes are one-time and expire — run `/pair` again for a fresh one."
  - **`error`** — anything else, printed as-is: "Pairing failed (...)."

### [8/8] Autostart and start the daemon

Registers (or updates, or confirms unchanged) the logon Scheduled Task, then tries to
start the daemon immediately rather than making you wait for the next logon — a
failure to start now is reported but does not undo the registration:

```
Registered the logon task so the daemon starts automatically.
Could not start it right now (<detail>); it will start at your next logon.
```

Finally the wizard polls the daemon heartbeat for up to 10 seconds for the round-trip
check:

```
Daemon is up.
```

or, if it hasn't reported in yet:

```
Daemon has not reported in yet — give it a moment, then run `cctl status`.
```

## Success summary

The wizard ends with the same summary `cctl status` and bare `cctl` render: which
accounts are captured, whether hooks are installed (and where), the relay URL, whether
the daemon/autostart is up, and pairing state. If pairing succeeded, one more line is
appended:

```
Your usage numbers reach your phone within ~1 minute (the daemon polls once a minute).
```

followed by next-step hints: `cctl status` · `cctl usage` · `cctl timeline` · `cctl
accounts list`.

## See also

- `docs/CLI.md` — every command, including the daemon and pairing commands `cctl
setup` wraps.
- `docs/PLATFORM.md` — which platforms are supported (Windows and Linux/WSL2 today)
  and what `cctl doctor` checks.
- `docs/VERIFICATION.md` — the fresh-machine wet gate this wizard exists to pass.
