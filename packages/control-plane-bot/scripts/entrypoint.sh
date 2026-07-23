#!/bin/sh
# Self-healing privilege drop for the control-plane bot container.
#
# The image starts as root ONLY long enough to fix up ownership of the persisted state directory,
# then drops to the unprivileged `node` user (uid 1000) and exec's the real process. This matters
# because on an existing deploy the bot-state volume was created root-owned by earlier images that
# ran the bot as root; a plain `USER node` image could no longer write its bindings/token-hashes
# there. Chowning it here means the switch to non-root needs no manual migration and never breaks a
# running deploy.
#
# After the exec, the internet-facing bot — the only thing that ever parses untrusted WebSocket
# frames — runs as uid 1000 with an EMPTY Linux capability set: su-exec's setuid() clears the
# capability sets on the uid transition, and compose's `no-new-privileges` blocks reacquiring them.
# The three capabilities this bootstrap needs (CHOWN, SETUID, SETGID) are added back in
# deploy/docker-compose.yml and nothing more; they are live only for this short root phase, which
# reads no untrusted input.
set -e

STATE_DIR="${CCTL_BOT_STATE_DIR:-/data/bot-state}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STATE_DIR"
  # -R: earlier root-run deploys may already have written bindings.json / session-threads.json
  # into this directory owned by root. `set -e` above means a failed chown aborts startup (fails
  # closed) rather than silently continuing to run the bot as root.
  chown -R node:node "$STATE_DIR"
  exec su-exec node:node "$@"
fi

# Already unprivileged (e.g. an operator ran the image with `--user`): nothing to fix, just run.
exec "$@"
