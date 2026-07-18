# Self-hosting the control-plane bot

The shared bot is one deploy of the same thing you can run yourself: `docker compose
up` from `deploy/` is the whole story, on your own VPS with your own Discord app. The
bot is credential-free by construction (it can only import `shared-protocol` — see
`docs/ARCHITECTURE.md`), so self-hosting changes nothing about the trust model, only
who operates the box.

## What you need

- A VPS with a public IP and inbound 80/443 open (Hetzner/DigitalOcean/etc. — a
  cheap instance is enough; the bot does no heavy work).
- A hostname that already resolves to that IP. Caddy requests a Let's Encrypt
  certificate for it automatically — a bare IP cannot get one, so a real hostname is
  required, not optional.
- A Discord application + bot token (Discord Developer Portal → New Application →
  Bot → Reset Token).
- Docker + the Compose plugin on the VPS.

## Deploy

```bash
git clone <this repo> && cd claude-control/deploy
cp .env.example .env
# edit .env: DISCORD_BOT_TOKEN=..., RELAY_HOSTNAME=relay.yourdomain.example
docker compose up -d
```

Two services come up:

- **`bot`** — the Discord gateway + WebSocket relay daemons connect to. Not
  published directly; only reachable through `caddy`.
- **`caddy`** — reverse proxy on 80/443, terminating automatic TLS for
  `RELAY_HOSTNAME` and forwarding to `bot`.

Point your own `cctl daemon run --relay wss://<RELAY_HOSTNAME>` (or `CCTL_RELAY_URL`,
or your own build's baked-in default — see `docs/CLI.md`'s relay precedence) at your
hostname once it's up.

## State and backup

The bot's only persisted state is `bindings.json` (which Discord user is bound to
which daemon, plus a scrypt hash of each daemon's token — never a credential). It
lives on the named Docker volume `bot-state`, not in the image, so a redeploy or
`docker compose restart` never loses a pairing. Back it up by copying the volume; there
is no database migration story to worry about.

Caddy's own volumes (`caddy-data`, `caddy-config`) hold its ACME account and issued
certificates — losing them just costs a re-issue on next start, not an outage.

## Health check

The bot exposes an unauthenticated `GET /health` on its port (200 + minimal JSON),
proxied by Caddy at `https://<RELAY_HOSTNAME>/health`. `cctl setup` and `cctl doctor`
probe it to tell "the relay is down" apart from "your network is broken" — useful for
confirming your own deploy came up before pairing a first machine against it.

## Updating

```bash
git pull
docker compose build bot
docker compose up -d
```

`caddy` only needs a rebuild if `deploy/Caddyfile` changed.

## Zero-credential guarantee

`packages/control-plane-bot` may import only `@claude-control/shared-protocol` — a
structural rule, not a promise, enforced by a dependency-closure build guard that fails
if `@claude-control/switch-engine` (the package that touches vault/credential code)
ever ends up in the bot's dependency graph, self-hosted or shared alike.
