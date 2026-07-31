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

Optional: to get per-session **private threads** instead of DM delivery, set
`CCTL_SESSION_CHANNEL_ID` in `.env` to the id of a text channel the bot can see (right-click
the channel → Copy Channel ID, with Developer Mode on) and enable the **Message Content
intent** on your Discord application (Developer Portal → Bot → Message Content Intent) so
replies typed into a thread reach the session — typing into a finished session's thread
resumes it and keeps the conversation there. Left unset, everything arrives by DM.

`CCTL_SESSION_CHANNEL_ID` applies to **every** paired user, which is not always what you
want on a relay that other people pair against. `CCTL_SESSION_CHANNELS` overrides it per
user, as comma-separated `<discordUserId>:<channelId>` pairs:

```
CCTL_SESSION_CHANNELS=123456789012345678:987654321098765432
```

A user named there gets threads in their own channel; anyone else falls back to
`CCTL_SESSION_CHANNEL_ID`, or to DM when that is unset. So setting **only**
`CCTL_SESSION_CHANNELS` is the mixed deployment: threads for you, DMs for everyone else.
Copy your own user id the same way as a channel id (right-click yourself → Copy User ID).
A malformed pair fails startup with the offending entries listed — deliberately, because a
mistyped id would otherwise just never match and leave that user silently on DMs.

The Message Content intent requirement follows the routing, not one specific variable: the
bot requests the privileged intent whenever **either** variable configures session threads,
and requesting it without the portal toggle rejects the gateway login at startup. A pure-DM
deployment (neither set) requests no privileged intent and needs no portal change.

### `/thread-here` — users pick their own channel

Both env vars above are **defaults**. Any paired user can run `/thread-here` in a channel to
send their own future session threads there, and `/thread-here action:clear` from anywhere to
send them back to their DMs — no operator edit, no redeploy. `/thread-here action:show` reports
where their output goes right now, which authority decided that, and whether the bot can still
use the channel.

One caveat on a deployment that sets **neither** env var: a `/thread-here` pin still routes
output into threads, but those threads are one-way — reading replies needs the privileged
Message Content intent, and the bot only requests it at startup when the operator configured
session threads. A user's pin cannot make the next boot request it, because an unapproved
privileged intent rejects the login and takes the whole bot down for everyone. Set either
variable above (plus the portal toggle) and restart to make pinned threads two-way.

Full precedence, highest first:

1. that user's own `/thread-here` channel
2. that user's own `/thread-here action:clear` — **DMs, terminally**: a cleared user does not
   fall through to the channels below, or "back to my DMs" would be a lie on any deployment
   that sets `CCTL_SESSION_CHANNEL_ID`
3. the `CCTL_SESSION_CHANNELS` entry for that user
4. `CCTL_SESSION_CHANNEL_ID`
5. nothing configured → DMs

A user outranking the `CCTL_SESSION_CHANNELS` entry you wrote for them is deliberate: that map
is a convenience default, not an access control — it cannot stop someone reading their own
session output, so overriding it grants no capability they did not already have. If it won
instead, the feature would be useless for exactly the people you had already configured. Your
real control over where the bot may post is the channel's Discord permissions, and
`/thread-here` enforces them honestly — before pinning anything it checks the bot's permissions
(View Channel, Create Private Threads, Send Messages in Threads, Manage Threads) **and** really
creates, joins and deletes a throwaway private thread there. If either step fails it says what
is wrong and changes nothing, rather than pinning a channel that would silently revert to DMs
at delivery time hours later.

Pins live in `session-channel-pins.json` in the state dir, so they survive a restart. Sessions
already running keep the thread they started in; only new sessions follow a changed channel.

That throwaway thread is named **`cctl channel check`** and is deleted immediately. If you ever
find one lying around, the delete failed (a rate limit, or Manage Threads revoked between the
create and the delete) — it is empty and safe to remove, and the next `/thread-here` in that
channel reaps it rather than adding another. A pin is never auto-cleared when its channel breaks:
a transient outage must not silently discard a setting a user chose, so delivery falls back to
their DMs and `/thread-here action:show` names the problem — including the case where the _user_,
not the bot, has lost access to the channel, which is the likeliest reason output reverts to DMs
long after a pin.

Routing is per **user**, not per server: session output arrives from your daemon over the
relay socket and carries no guild, so the bot cannot infer "this belongs to server X". Adding
the bot to a second server changes nothing on its own; name the channel you want.

Point your own `cctl daemon run --relay wss://<RELAY_HOSTNAME>` at your hostname once
it's up. For a self-host you want to keep, prefer `relayUrl` in `config.json` beside
the vault — unlike a flag it survives autostart and reboots, and unlike a baked-in
default it needs no rebuild:

```json
{ "relayUrl": "wss://<RELAY_HOSTNAME>" }
```

See `docs/CLI.md`'s relay precedence for the full order.

## State and backup

The bot persists three small JSON files, none of which holds a credential: `bindings.json`
(which Discord user is bound to which daemon, plus a scrypt hash of each daemon's token),
`session-threads.json` (which thread each session's output goes to, so a restart does not
re-anchor a live session), and `session-channel-pins.json` (each user's own `/thread-here`
choice). They live on the named Docker volume `bot-state`, not in the image, so a redeploy or
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
