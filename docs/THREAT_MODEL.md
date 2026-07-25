# Threat model

This document states what `claude-control` defends against, and — just as important — the
boundaries it does **not** defend across **by design**. The items in "Residual risks by design"
are not bugs; they are inherent consequences of the shape described in
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) (a local daemon that connects outbound to a hosted
relay which can send it commands). They are written down so an operator can make an informed
choice — most notably, whether to trust the shared relay or self-host their own
([`docs/SELF_HOST.md`](./SELF_HOST.md)).

## Assets, ranked

1. **OAuth access/refresh tokens** for the user's Claude accounts. Compromise = full account
   takeover. These live only in the per-machine encrypted vault and the live files the CLI reads;
   they never enter a protocol message, the relay, or Discord.
2. **The daemon's ability to run commands.** `session.spawn` starts Claude Code (and thus shell
   tools) on the user's machine. Anything that can command the daemon can run code as the user.
3. **Daemon tokens.** 256-bit secrets that authenticate a daemon to the relay. Stored only as
   scrypt hashes on the bot; the plaintext exists only on the owning machine.
4. **Session content in transit** — prompts, tool inputs/outputs, permission prompts. Sensitive
   but ephemeral; see "In-transit visibility" below.
5. **Discord ↔ daemon bindings.** Routing metadata on the bot. Not a credential, but integrity
   matters (a corrupted binding could misroute a command).

## Trust boundaries

| Actor                       | Trusted to                                                  | Explicitly NOT able to                                                                      |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Daemon** (user's machine) | Hold vault tokens, run sessions, decrypt credentials        | —                                                                                           |
| **Relay/bot** (shared host) | Route by Discord user id, store bindings + token **hashes** | Read any OAuth token; import credential code (structural — see `dependencyClosure.test.ts`) |
| **Discord**                 | Authenticate the human, deliver messages                    | Reach a daemon it isn't bound to                                                            |
| **Caddy** (edge)            | Terminate TLS for the relay hostname                        | See the Discord bot token (least-privilege env)                                             |

## What is defended (and how)

- **Cross-user daemon hijack** — the bot mints daemon ids server-side; a client cannot name
  another user's daemon. ACL is enforced at the bot (route by `interaction.user.id`) and
  re-validated at the daemon on ingress.
- **Daemon-token theft from the bot** — tokens are stored only as scrypt hashes (N=16384);
  verification is constant-time with a dummy-hash path so a missing daemon id and a wrong token
  are indistinguishable by timing.
- **Hook-secret timing oracle** — the loopback hook receiver compares its secret in constant time.
- **Pre-auth resource exhaustion** — a per-frame size cap (refuse oversized frames before parsing),
  a concurrent **unauthenticated-connection** cap (shed a handshake flood before allocating state),
  a first-frame handshake timeout, and a per-socket outbound backpressure cap (the relay keeps no
  message queue, so a stuck peer cannot make it buffer without bound). Container resource limits
  (`mem_limit`, `pids_limit`, `cpus`) turn a successful exhaustion attempt into a crash-and-restart
  of one container rather than host starvation.
- **Secret leakage into the image** — `.dockerignore` keeps `deploy/.env` (the bot token) out of
  the build context; the token reaches the container only at run time via compose.
- **Blast radius of the bot process** — it runs as an unprivileged user with an empty Linux
  capability set and `no-new-privileges`, so a hypothetical code-execution bug in frame handling
  starts from the weakest possible position inside an already-limited container.

## Residual risks by design

These are the boundaries a user is implicitly accepting. None is a defect; each is the direct cost
of a feature.

### 1. Whoever controls the bound Discord account controls the daemon

The bot authorizes actions by Discord user id. It cannot tell the real owner apart from someone who
has taken over that Discord account (stolen session, SIM-swap, shoulder-surf). Such an attacker can
send prompts, spawn sessions, and approve permission prompts — i.e. **run code on the user's
machine**. This is equivalent in power to compromising the machine itself.

_Mitigation:_ protect the Discord account as you would the machine — enable 2FA, don't leave
Discord logged in on untrusted devices. Phone control is additive; the daemon still runs locally
without it.

### 2. Relay domain / DNS / TLS takeover → remote code execution on daemons

Daemons trust the relay identified by DNS and the public web PKI (`wss://cctl.andrewtjin.com` by
default). An attacker who takes over the hostname's DNS, or who mis-issues/obtains a certificate
for it, can impersonate the relay. Because the daemon **executes commands the relay relays**
(`session.spawn`), a successful relay impersonation is a path to running code on every connected
daemon. This is inherent to "outbound connection to a hosted control plane that can issue commands."

_Mitigations / notes:_

- **Self-host** the relay and point the CLI at your own hostname (`docs/SELF_HOST.md`) to make the
  trust anchor one you control end-to-end.
- The relay still cannot read vault tokens even if impersonated — but it can _command_ the daemon,
  which is the more powerful lever here.
- The default relay is protected by ordinary web-PKI hygiene (CAA records, registrar/DNS account
  security). There is currently **no** certificate/key pinning beyond the public CA system; adding
  it is a candidate future hardening, not a shipped control.

### 3. Bot-host compromise

The bot holds no OAuth tokens and cannot decrypt them, so a compromised bot host **cannot** steal
account credentials. It can, however: (a) deliver forged commands to daemons (the same RCE lever as
risk 2 above), and (b) observe in-transit cleartext (below). Self-hosting moves this trust onto infrastructure
you own.

### 4. In-transit visibility

TLS protects the daemon↔relay link on the wire, but the **bot process itself terminates that link**
and therefore sees the cleartext it relays: commands, tool inputs/outputs, prompts, and the literal
contents of permission prompts (which include tool input, shell commands, file paths, and
Write/Edit bodies). The one thing structurally withheld from the bot is OAuth tokens — enforced by
the package dependency closure, not by policy. Do not treat the relay as zero-knowledge; treat it as
"holds no long-term credentials, but sees session traffic in flight." (This matches the disclosures
in `README.md` and `docs/ARCHITECTURE.md`.)

## Out of scope

- **Endpoint compromise of the user's machine.** If the machine is compromised, the vault's
  plaintext-at-rest protection (OS-level: DPAPI / owner-only key file) is the only line left, and it
  is not designed to stop an attacker already running as the user.
- **Malicious Claude account / upstream API.** Trust in Anthropic's API is assumed.
- **Denial of service against availability** beyond the resilience controls above. The goal is
  "an attacker cannot exhaust the host or bypass auth," not "the relay is always reachable."
