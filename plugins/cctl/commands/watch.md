---
description: Stream this session to Discord (add --off to stop streaming it).
argument-hint: '[--off] [--session <id>]'
allowed-tools: Bash(cctl session watch:*)
---

Toggle per-session Discord streaming for the current session (on by default; `--off` stops it).
The session must be registered first (`/cctl:register`). Pass `--session <id>` if the session id
can't be auto-detected.

!`cctl session watch $ARGUMENTS`
