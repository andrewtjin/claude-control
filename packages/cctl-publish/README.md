# @andrewtjin/cctl

`cctl` — stop losing sessions to Claude Code usage limits. If you hold several
subscriptions, quota you don't spend before it resets is gone for good, and the account
you're sitting in is rarely the one about to expire. `cctl` spends the budget expiring
soonest, hops accounts before the active one hits its wall, and keeps your phone link
alive across the hop.

```bash
npm i -g @andrewtjin/cctl
cctl setup
```

`cctl setup` runs a guided first-run wizard: it checks your environment, captures your
current Claude login, installs the usage-tracking hooks, pairs this machine with the
shared Discord bot, and registers a logon task so the daemon starts automatically.
Before running it, [add the cctl bot to a Discord server you're in](https://discord.com/oauth2/authorize?client_id=1527387188772208790&permissions=395137108992&scope=bot+applications.commands) —
or, with no server at all, [add it to just your account](https://discord.com/oauth2/authorize?client_id=1527387188772208790&integration_type=1&scope=applications.commands)
and DM it — that's where `/pair` mints your pairing code and where notifications reach
you. Discord is optional: skip pairing in the wizard and everything works from the CLI
alone (usage, burn advice, manual and automatic switching); pair later with
`cctl setup --reconfigure`.

- **Burns the expiring budget first.** Weekly quota is the only scarcity that truly
  evaporates — a 5-hour window resets and hands the same capacity back. One line tells
  you which account to use now, and why.
- **Switches before the wall, not after.** When the active account runs low, the daemon
  moves to an account with real headroom on its own. Or switch from your phone.
- **Approve from anywhere.** Permission prompts and "done / waiting" notices reach
  Discord; approve or deny from there.
- **Answer Claude's questions from your phone.** When a session asks you to choose,
  the Discord card carries a select menu per question — multi-select and a free-text
  "Other…" included — and your answers land back in the running session.

Your credentials never leave your machine: the daemon holds them locally, and the shared
bot is a credential-free control plane that never sees session content.

**Windows and Linux (incl. WSL2) v0.2.2**; Mac support coming soon.

See the [project README](https://github.com/andrewtjin/claude-control#readme) for the
full command reference, the architecture, and the self-host path.

This package is a single-file bundle of the `cctl` CLI, built from the
[claude-control](https://github.com/andrewtjin/claude-control) monorepo
(`packages/cli`) — it has no source of its own.

Installing it also pulls in `@anthropic-ai/claude-agent-sdk` and, through it, the Claude
Code binary for your platform (~250MB) — that binary is what a remote session actually
runs. Installing with `--omit=optional` skips it, and `/run` will fail with "Native CLI
binary not found" while every other command still works; `cctl doctor` reports this as
the `session-runtime` check.

## License

MIT. See [LICENSE](./LICENSE).
