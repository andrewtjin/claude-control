# claude-control

Switch between multiple Claude Code subscription accounts, see usage across all of
them at once, and drive your sessions from your phone — with the remote link
surviving account switches.

Each person runs a **local daemon** on their own machine that manages 3–5 of their
own accounts. A single **shared Discord bot** acts as a credential-free control
plane: it holds no tokens and never sees session content, routing every interaction
strictly by Discord user. Your credentials never leave your machine.

## What it does

- **Cross-account usage** — one view of every account's 5-hour, weekly, and per-model
  limits, without switching to poll them.
- **One-tap switch** — get a near-cap alert on your phone, switch accounts with a
  tap; in-flight work resumes under the new account.
- **Approve from anywhere** — permission prompts and "done / waiting" notices reach
  your phone; approve or deny from Discord.
- **Remote sessions** — send a prompt into a live session, or start a new one, and
  watch milestones stream back.

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

## Status

Pre-release. Core contracts, the switch engine, usage/attribution, pairing, and the
control-plane relay are implemented and unit-tested. Live integration surfaces
(real account switching, the Anthropic usage endpoint, Discord connectivity, and
ConPTY-observed sessions) are gated behind on-machine verification — see
`docs/VERIFICATION.md`.

## Platform

Windows-first (DPAPI credential vault, ConPTY sessions). macOS/Linux support is a
later milestone.

## License

MIT — see [LICENSE](./LICENSE).
