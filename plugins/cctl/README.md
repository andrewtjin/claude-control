# cctl — in-session Claude Code plugin

Adds `/cctl:*` slash commands that wrap the local `cctl` CLI, so you can control claude-control
from inside a Claude Code session:

| Command                                            | What it does                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `/cctl:register [--label <name>] [--session <id>]` | Opt this session into daemon tracking + phone streaming                  |
| `/cctl:label <name> [--session <id>]`              | Name the current tracked session for the phone list                      |
| `/cctl:watch [--off] [--session <id>]`             | Turn per-session Discord streaming on (default) or off                   |
| `/cctl:status`                                     | Show tracked sessions + the active account (reads the daemon db offline) |

## Requirements

- The `cctl` binary must be on your `PATH` (`pnpm --filter @claude-control/cli build`, then link it).
- For `register` / `label` / `watch`, the daemon must be running (`cctl daemon run`). Those commands
  talk to the daemon's loopback endpoint, authenticated with the daemon-minted hook secret (read
  via DPAPI). `status` reads the daemon database directly and works even when the daemon is down.

**This plugin holds no secrets and no absolute paths.** The secret lives only in the daemon's
DPAPI-encrypted `hook-secret.enc`; the CLI reads it at call time. The plugin only ships command
text that invokes `cctl`.

## Session id

Claude Code does not reliably expose the current session id to slash-command subprocesses (as of
2.1.x there is no documented, stable `CLAUDE_SESSION_ID`; `CLAUDE_CODE_BRIDGE_SESSION_ID` appears
only when Remote Control is connected). `cctl` tries those env vars best-effort; when neither is
present, pass `--session <id>` explicitly — the command will tell you if it couldn't determine it.

## Enabling it

This directory is a self-contained Claude Code plugin (`.claude-plugin/plugin.json` + `commands/`).
Install/enable it the way you install any local plugin (e.g. add this repo as a plugin source, or
copy `plugins/cctl` into your Claude Code plugins directory), then the `/cctl:*` commands appear.
