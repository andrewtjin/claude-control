# claude-control

Switch between multiple Claude Code subscription accounts, see usage across all of
them at once, and drive your sessions from your phone — with the remote link
surviving account switches.

Each person runs a **local daemon** on their own machine that manages 3–5 of their
own accounts. A single **shared Discord bot** acts as a credential-free control
plane: it holds no tokens and never sees session content, routing every interaction
strictly by Discord user. Your credentials never leave your machine.

## What it does

- **Auto-switch.** At low remaining 5h usage, you'll switch sessions to maximize uptime. Or, switch on phone with one tap.
- **Remote sessions.** Send live prompts or start a new session, and
  watch milestones stream back.
- **Cross-account usage optimization.** One view of every account's 5-hour, weekly, and per-model
  limits, with optimal use calculations.
- **Approve from anywhere.** permission prompts and "done / waiting" notices reach
  your phone; approve or deny from Discord.

## Packages

| Package                             | Role                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `@claude-control/shared-protocol`   | Wire contract (zod-validated envelope + message types). The only package the bot may import. |
| `@claude-control/switch-engine`     | Account vault, OAuth refresh, atomic activation, crash recovery.                             |
| `@claude-control/session-runtime`   | Managed (Agent SDK) and observed (ConPTY) sessions.                                          |
| `@claude-control/daemon`            | Usage poller, attribution journal, session manager, hook receiver, control-plane client.     |
| `@claude-control/control-plane-bot` | Discord bot + WebSocket relay; holds zero credentials.                                       |
| `@claude-control/cli`               | `cctl` — the local command-line interface.                                                   |

## Quick start

```bash
pnpm install
pnpm run build
pnpm run test
```

The CLI is available as `cctl` once built (`pnpm --filter @claude-control/cli build`,
then `node packages/cli/dist/bin.js --help`).

## CLI

`cctl` runs local, one-shot commands over the switch engine and the daemon's data:

```
cctl accounts add <label>   # capture the currently logged-in account
cctl accounts list          # list stored accounts (active marked with *)
cctl accounts relogin <ref> # re-login an existing (quarantined) account in place, keeping its id
cctl switch <id|label>      # activate an account
cctl usage                  # cross-account usage from the daemon's latest poll
cctl recover                # recover from an interrupted switch
cctl doctor                 # check the local environment (DPAPI, vault, login)

cctl session register       # opt the current session into daemon tracking + phone streaming
cctl session label <name>   # name the current tracked session (shown in the phone list)
cctl session watch [--off]  # stream the current session to Discord (--off to stop)
cctl session status         # show tracked sessions + active account (reads the daemon db offline)
```

`accounts relogin` reuses an existing account's id and usage history (unlike
`accounts add --fresh`, which mints a new one) and refuses if you log into a different
account. The `cctl session` group is also exposed in-session as the `/cctl:*` slash
commands shipped in `plugins/cctl/` — a self-contained Claude Code plugin that holds no
secrets and only wraps the CLI.

Remote control (`pair`, `run`, and the background `daemon`) needs the running daemon
connected to the hosted bot — an on-machine step described in `docs/VERIFICATION.md`.
The `cctl session register` / `label` / `watch` commands likewise need the running
daemon; `status` reads the local database and works offline.

## Status

Pre-release. All seven packages are implemented and unit-tested (600+ tests), and the
whole workspace builds, lints, and passes clean. An adversarial security pass on the
control plane and daemon has been run and its findings fixed.

Switching, cross-account usage, Discord pairing, and the `.claude.json` round-trip are
wet-verified and closed (`docs/VERIFICATION.md` gates 1–4, 8). The remote-control
milestones — **M3** (the loopback hook loop: mode-aware permission cards, done / waiting
/ quarantine notices, guided re-login) and **M4** (phone-driven **managed** sessions over
the Agent SDK: a live Discord card, streamed milestones, remote approve/deny, Stop
escalation, and crash-resume) — are implemented on this branch and unit-proven, but their
live surfaces are gated behind on-machine (wet) verification: the permission hook loop in
`default` mode (gate 5), end-to-end managed sessions (gate 6), and ConPTY-observed
sessions (gate 7). Each is enumerated with exact steps in `docs/VERIFICATION.md` and its
linked runbook.

## Platform

**Windows-only today.** The implementation is platform-dependent in two load-bearing
places:

- **Credential vault encryption** uses Windows DPAPI (via PowerShell
  `ProtectedData`, CurrentUser scope) — there is no macOS/Linux equivalent wired in
  yet, so the vault cannot protect tokens off Windows.
- **Observed sessions** (a later milestone) target ConPTY, the Windows
  pseudo-console.

Everything else (daemon, bot, CLI, usage polling) is portable Node ≥ 22.5.
macOS support (Keychain-backed vault) is the next planned milestone; Linux
(libsecret) after that. On an unsupported platform, `cctl doctor` reports the gap
instead of failing silently.

## License

MIT — see [LICENSE](./LICENSE).
