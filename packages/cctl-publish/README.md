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

- **Burns the expiring budget first.** Weekly quota is the only scarcity that truly
  evaporates — a 5-hour window resets and hands the same capacity back. One line tells
  you which account to use now, and why.
- **Switches before the wall, not after.** When the active account runs low, the daemon
  moves to an account with real headroom on its own. Or switch from your phone.
- **Approve from anywhere.** Permission prompts and "done / waiting" notices reach
  Discord; approve or deny from there.

Your credentials never leave your machine: the daemon holds them locally, and the shared
bot is a credential-free control plane that never sees session content.

**Windows-only v0.1.0**; Mac support coming soon.

See the [project README](https://github.com/andrewtjin/claude-control#readme) for the
full command reference, the architecture, and the self-host path.

This package is a single-file bundle of the `cctl` CLI, built from the
[claude-control](https://github.com/andrewtjin/claude-control) monorepo
(`packages/cli`) — it has no source of its own.

## License

MIT. See [LICENSE](./LICENSE).
