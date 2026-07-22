---
description: Name the current tracked session (shown in the phone session list).
argument-hint: '<name> [--session <id>]'
allowed-tools: Bash(cctl session label:*)
---

Give the current session a human label so it is easy to spot on the phone. The session must be
registered first (`/cctl:register`); if it isn't, the command says so. Pass `--session <id>` if
the session id can't be auto-detected.

!`cctl session label $ARGUMENTS`
