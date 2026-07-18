# claudecontrol

`cctl` — switch between multiple Claude Code accounts, see usage across all of them at
once, and drive your sessions from your phone.

```bash
npm i -g claudecontrol
cctl setup
```

`cctl setup` runs a guided first-run wizard: it checks your environment, captures your
current Claude login, installs the usage-tracking hooks, pairs this machine with the
shared Discord bot, and registers a logon task so the daemon starts automatically.

See the [project README](https://github.com/andrewtjin/claude-control#readme) for what
`cctl` does, the full command reference, and the self-host path.

This package is a single-file bundle of the `cctl` CLI, built from the
[claude-control](https://github.com/andrewtjin/claude-control) monorepo
(`packages/cli`) — it has no source of its own.

## License

MIT — see [LICENSE](./LICENSE).
