---
description: Opt this Claude Code session into claude-control tracking + phone (Discord) streaming.
argument-hint: '[--label <name>] [--session <id>]'
allowed-tools: Bash(cctl session register:*)
---

Register the current Claude Code session with the local claude-control daemon, so it shows up in
the phone's session list and (with watch on) streams to Discord.

Notes:

- The daemon must be running (`cctl daemon run`). If it isn't, the command says so.
- `cctl` tries to auto-detect the current session id from the environment, but Claude Code does
  not reliably expose it to slash commands — if it can't, pass `--session <id>` explicitly.

!`cctl session register $ARGUMENTS`
