---
description: Show tracked claude-control sessions and the active account (reads the daemon db, works offline).
allowed-tools: Bash(cctl session status:*)
---

Show the active account (with 5h-window budget) and every tracked session — interactive ones you
registered plus phone-spawned managed ones. Reads the daemon's local database, so it works even
when the daemon is not currently running.

!`cctl session status`
