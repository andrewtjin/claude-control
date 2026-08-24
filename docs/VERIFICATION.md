# Verification

This project draws a hard line between what is **unit-proven** (green tests you can
trust) and what is a **wet gate** — behavior that only proves out against real
credentials, real Anthropic endpoints, a real Discord app, or real OS processes. Green
unit tests over a mock never close a wet gate. Do not mark a wet gate done from mocks.

## Unit-proven (headless, in CI)

- **shared-protocol** — envelope validation, codec round-trip, unknown-type and
  malformed-frame rejection, version negotiation.
- **switch-engine** — the full `activate`/`recover` state machine (happy path,
  near-expiry refresh with rotated-token persistence, dead-token quarantine,
  reconcile-by-reading adoption, all three crash-recovery branches), the OAuth refresh
  mapping (rotation, `invalid_grant` → quarantine, transient vs permanent), the file
  lock (contention + stale reclaim), the vault (encrypted round-trip, registry), the
  credential store (surgical key preservation in `~/.claude.json`), and the 529 retry
  loop (which statuses retry, both budgets, `Retry-After`, jitter bounds, the cached
  status probe). **DPAPI itself is proven for real** — a genuine PowerShell
  ProtectedData encrypt/decrypt round-trip runs in the suite on Windows. The **darwin**
  Keychain protector and live-credential channel are covered too, but only against a
  **fake `security(1)` runner** — that is unit-proof of our argument construction and
  payload handling, and is not evidence about a real Keychain (gate 13).
- **usage-advisor** — burn-before-reset selection, near-cap risk avoidance, switch-now,
  quarantine handling, binding-limit headroom, determinism.
- **control-plane-bot** — token mint/verify (constant-time), pairing (single-use,
  expiry, isolation), and WS relay routing/ACL over **real in-process sockets** (cross-
  user isolation, bad-token/old-version rejection, invalid-frame drop). Session-thread
  routing is proven as far as it can be headlessly: the four-tier precedence, the
  `/thread-here` decision tree and every reply string, the persisted pin store (concurrent
  writes, a genuinely failed write, restart survival), and the command → store → resolver
  path with no restart in between. Its three live Discord adapters are **not** — gate 14.
- **session-runtime** — the summarizer, session state machine, and manager persistence,
  against injected fakes.

## Wet gates (need on-machine confirmation)

Run these on the owner's machine with a spare/test account before trusting the feature.

> **2026-07-16 wet-test run (CLI 2.1.211):** gates 1–3 were exercised by the harness in
> `claude-control-orchestrator/wet-tests/` (raw evidence: `results.json`, verdicts:
> `RESULTS.md`). Per-gate status is stamped below. Bonus findings from the same run:
> `CLAUDE_CONFIG_DIR` relocates the **entire** config — `.claude.json` included — which is
> what makes `cctl accounts add --fresh` safe (WT-1); `--resume` works across accounts and
> transcripts are identity-free, so the attribution journal is load-bearing (WT-4); refresh
> tokens are single-use but a stale token does **not** revoke the grant family (WT-6), so
> adopting a newer vault token is always safe. The CLI's stale-token failure is exit 1 with
> `"Failed to authenticate: OAuth session expired and could not be refreshed"` — the string
> quarantine UX copy should key on.

### 1. Hot-swap of a live interactive session — the M0 question ✅ CLOSED 2026-07-16

**Claim to verify:** on Windows the CLI reads `.credentials.json` per request, so a
switch applies to a _running_ interactive session on its **next** message.
**Result (WT-3):** CONFIRMED — per-request reads; hot-swap applies to running sessions,
including an interactive TUI (human-confirmed). The daemon's `hot_applied` outcome is
accurate; the "staged for next launch" fallback UX is not needed on this CLI version.

### 2. OAuth refresh endpoint ✅ CLOSED 2026-07-16

**Verify:** `switch-engine/src/oauth.ts` `DEFAULT_TOKEN_ENDPOINT`,
`CLAUDE_CODE_CLIENT_ID`, and the request/response shape are correct.
**Result (WT-6):** rotation SEMANTICS confirmed — single-use refresh tokens, rotation on
CLI use, stale copy fails with the auth error above, and reuse does NOT revoke the newer
token.
**Result (live probe, owner-run per `claude-control-orchestrator/tasks/m0-wet-gate-runbook.md`):**
CONFIRMED — with `CCTL_REFRESH_SKEW_MS` forcing the refresh path, `cctl switch spare`
printed `Activated spare (credentials written, token refreshed).` — i.e. this module's own
request to `DEFAULT_TOKEN_ENDPOINT` with `CLAUDE_CODE_CLIENT_ID` succeeded and the rotated
token was persisted; a follow-up `claude -p` authenticated on the refreshed token. Same
run also live-validated two M0 alignment features: `accounts add --fresh` captured the
spare without touching the live login, and the cadence guard refused an immediate
switch-back ("next switch allowed in Ns") until `--force`.

### 3. Usage endpoint ✅ CLOSED 2026-07-16

**Verify:** `GET https://api.anthropic.com/api/oauth/usage` with the Bearer token and
`anthropic-beta: oauth-2025-04-20` returns the expected `utilization.limits[]`.
**Result (WT-2):** CONFIRMED — 3 limits (session, weekly_all, weekly_scoped) with
kind/group/percent/severity/resets_at(nullable)/scope(nullable)/is_active; the parser
handles the verbatim payload (see `usageParse.test.ts`). **Correction:** omitting the
User-Agent did NOT get throttled (200 OK) — the header is sent anyway but is not
load-bearing. Tier-0 cache was observed ~58 min stale, so staleness labels on cached
data are mandatory, and the poller's tier-0 fallback stands.
**Shape correction (2026-07-16, authenticated probe during the M2 gate):** the live
response carries `limits[]` at the TOP level of the body — the `utilization.limits[]`
nesting WT-2 recorded is how the CLI persists the same payload in `.claude.json`
(`cachedUsageUtilization.utilization.limits`), not the wire shape. The parser accepts
both containers (fix @ 013f053; the verbatim live body is a test fixture).

### 4. Discord bot ✅ CLOSED 2026-07-16

**Verify:** the bot logs in (`DISCORD_BOT_TOKEN`), registers slash commands, creates a
per-user channel on `/pair`, and renders the usage + plan embed with a working switch
button.
**Result (owner-run per `claude-control-orchestrator/tasks/m2-wet-gate-runbook.md`):**
CONFIRMED end-to-end from a phone — `/pair` minted a code and `cctl daemon run --pair`
bound the PC, adopting a DPAPI-persisted daemon identity; `/status`/`/usage`/`/accounts`
answered from delivered `usage.snapshot`s; `/switch` completed on the PC (audit
`activated` entry + live `oauthAccount` flip, both verified on disk) with the result card
back on the phone; an immediate second switch was REFUSED by the cadence guard and the
refusal surfaced on the phone. Two live-found defects were fixed mid-gate @ 013f053:
`/switch` now resolves labels the same way `cctl switch` does, and the usage parser
matches the real wire shape (see gate 3's shape correction). Notes: switching shipped as
a `/switch` slash command (interactive buttons are M3 UX); there is no phone-side
`--force`/cadence-retry yet — local `cctl switch <ref> --force` is the override (backlog).

### 5. Hook event names ✅ CLOSED 2026-07-19

**Verify:** the exact `PermissionRequest` / `Stop` / `Notification` hook event names and
payloads against the installed CLI version, and that merging our hooks into each
profile's `settings.json` is non-destructive.
**Result (WT-5):** 8 events confirmed with payloads on 2.1.211 — SessionStart, SessionEnd
(+reason), UserPromptSubmit, PreToolUse (+tool_use_id/permission_mode/effort), PostToolUse
(+tool_response/duration_ms), Notification (+notification_type; `idle_prompt` = the
"waiting" card), Stop (+last_assistant_message = the "done" card), SubagentStop.
**Still open:** the permission-time event itself — unobservable on the owner's machine
(global `permissions.defaultMode: "auto"` means no prompt ever fires). Confirm at M3 in
`default` mode; the phone card set must be mode-aware (`PreToolUse.permission_mode` is on
every payload).
**M3 landed on `feat/remote-control`** (daemon `hookInstaller`/`hookReceiver`/`hookSecret`,
mode-aware cards, two-tap, quarantine debounce) and is unit-proven.
**Result (owner-run 2026-07-17, `feat/remote-control` through `ba37019`):** the
permission-time event is **`PermissionRequest`**, and it fires only while the CLI is
actually blocking on a prompt. The daemon holds the hook's HTTP response open for the
remote decision; the terminal prompt and the phone card race concurrently, first answer
wins, and a late tap gets an honest refusal. Confirmed live: (1) non-destructive hook
install with a stable secret across restarts; (2) a permission prompt surfaced a phone
card; (3) Approve/Deny round-tripped, with the two-tap guard and the expired-confirm
restore; (4) **correction to the original criterion** — non-`default` modes do NOT get
button-less info cards: accept-edits still prompts for shell commands, so permission cards
keep Approve/Deny in EVERY mode and show the mode as footer context (shipped @ `33e1baa`
after the button-less design proved wrong live). Bonus, same run: every completed shell
command delivers an output card in every permission mode (truncated by default;
`CCTL_TOOL_OUTPUT_FULL` ships the rest as a file attachment).
**Result (owner sign-off 2026-07-19):** the remaining item — done / waiting / quarantine
notices, including the quarantine debounce and the `cctl accounts relogin <label>` guided
copy — ran clean in the owner's live sessions (the quarantine path was exercised for real
during a live vault repair). Gate closed on that confirmation, with no regressions
outstanding at the merged tip.

### 6. Managed sessions (Agent SDK) — the M4 question ✅ CLOSED 2026-07-19

**Verify:** the daemon-wired managed-session path matches the real
`@anthropic-ai/claude-agent-sdk` streaming API — message shapes, `canUseTool` permission
parking, `interrupt`, and input injection — end to end through the Discord live card.
**M4 landed on `feat/remote-control`** (session-runtime permission gate + ordered output,
daemon permission routing / stop / orphan resume, bot thread-per-session live card +
attachments, C6 `cctl session` commands + `cctl accounts relogin`) and is unit-proven.
**Progress (owner-run 2026-07-17, in flight):** item (1) confirmed live — `/run` streams a
live card that edits in place, milestone lines post as their own messages, and `/say`
injects a follow-up into the running session. Two live defects were found and fixed on the
branch: a managed session's own Stop hook duplicated every turn's summary as a
"Session stopped" card (the receiver now suppresses hook-driven cards for sessions the
daemon manages — permission requests and armed output watches still forward), and a
multi-line turn summary kept only its first line (structured SDK events now emit their
display event directly instead of being re-classified line by line).
**Result (owner sign-off 2026-07-19):** the pass criteria below were exercised across the
owner's live runs — permission round-trips (exactly-once across a double-tap), Stop
escalation, orphan resume, output attachments, the `cctl session` command set, and
`accounts relogin` — and the owner confirmed the gate clean with no regressions
outstanding at the merged tip. Kept for the record:
**Pass — run `claude-control-orchestrator/tasks/m4-wet-gate-runbook.md`:** (1) `/run`
starts a managed session that streams a live card to the phone (DM today — channel-per-user
is not built) with real tool names and milestone lines; `/say` injects a follow-up prompt;
(2) the managed permission gate blocks the tool with **no timer**, round-trips Approve/Deny,
resolves exactly once across a two-device double-tap, and is **never** auto-resolved by any
timeout; (3) the Stop button (two-tap) escalates interrupt → grace → hard and fail-closes a
pending permission; a repeat `/stop` is ignored (seen-set); (4) killing the daemon
mid-session and restarting resumes the orphan under the **same** session id; (5) a lost
output `seq` surfaces a visible gap marker, and long output attaches as `session-<id>.log`;
(6) `cctl session register|label|watch|status` behave online/offline as specified
(`status` reads the db with the daemon down; `register` fails loudly when it is down;
re-register is idempotent); (7) `cctl accounts relogin <ref>` rewrites the same id and its
identity guard refuses a login as a different account.
**Known non-defects the runbook flags** (do not read as failures): session cards always
land in DM; `watch --off` is recorded but does not yet gate the stream; there is no
verbosity control (no protocol field); `session-threads.json` defaults under `%TEMP%`
because the bot's `bin.ts` does not set the gateway `stateDir`.

### 7. Observed sessions (ConPTY)

**Verify:** `node-pty` (an optional dep, not installed by default) drives a real
Windows terminal.
**Setup:** `pnpm add -w node-pty` (needs MSVC build tools) or a prebuilt binary.
**Pass:** `cctl run` wraps a terminal; output is observed and a prompt can be injected;
absence of `node-pty` degrades gracefully with a clear message.

### 8. `~/.claude.json` round-trip ✅ CLOSED 2026-07-16

**Verify:** switching rewrites only the `oauthAccount` block and preserves every other
key (projects, history, settings), including the duplicate-key quirk seen on real
files.
**Result (owner-run, same M2 gate):** CONFIRMED semantically — before/after comparison of
the real file (81 top-level keys, 50 `projects` entries): zero keys added or removed,
`projects` deep-equal, and the only switch-caused change was `oauthAccount`
(`promptQueueUseCount` also moved, mutated by the running CLI itself, not the engine).
Cosmetic caveat: the engine re-serializes the file minified onto one line, so a TEXT diff
shows a full-file rewrite even though content is preserved — pretty-print-preserving
writes are a polish backlog item.

### 9. Fresh-machine install ⏳ PENDING

**Claim to verify:** on a fresh Windows profile (or fresh VM) with only Node ≥ 22.13
present, `npm i -g @andrewtjin/cctl` followed by `cctl setup` reaches a paired,
autostarted daemon with a working phone `/usage` in **≤ 10 minutes**, without opening
any doc (README's quick start is the whole prompt).
**Verify:** time the run start-to-finish; confirm every wizard step in
`docs/SETUP.md` matches what actually prints; confirm no step required reading a doc
to get unstuck.
**Result:** not yet run.

### 10. Reboot / autostart survival ⏳ PENDING

**Claim to verify:** after `cctl daemon install` (directly or via `cctl setup`), the
daemon is up and reconnected to the relay **after a full reboot, without any user
action** — no login shell, no manual `cctl daemon run`.
**Verify:** reboot the machine that ran gate 9, wait past logon, then confirm
`cctl daemon status` reports the heartbeat alive and the Scheduled Task's last run
succeeded; confirm `/usage` on the phone reflects a fresh poll.
**Result:** not yet run.

### 11. VPS compose + wss end-to-end ⏳ PENDING

**Claim to verify:** `docker compose up` from `deploy/` (per `docs/SELF_HOST.md`) on a
real VPS with a real hostname brings up a working bot behind Caddy's automatic TLS,
and a daemon pointed at `wss://<hostname>` pairs and round-trips exactly like the
shared bot.
**Verify:** deploy per `docs/SELF_HOST.md`; confirm `GET https://<hostname>/health`
returns 200; run `cctl setup --relay wss://<hostname>` (or `cctl pair --relay
wss://<hostname>`) end-to-end from a separate machine; confirm `/usage` and `/switch`
work over the VPS relay the same as gate 4 did over the shared one.
**Result:** not yet run.

### 12. Linux file-key vault ✅ CLOSED 2026-07-22

**Claim to verify:** on real Linux (WSL2 counts — it is the primary target), the
published bundle's `cctl doctor` passes `vault-crypto` via the file-key protector, the
key file is created `0600` inside a `0700` dir at
`~/.local/share/claude-control/vault.key`, and the key is stable across runs.
**Result (WSL2 Ubuntu, Node v22.23.1, standalone `dist/bin.js`):** CONFIRMED —
`[ok] vault-crypto: file-key (linux) protect/unprotect round-trip works`; `stat`
reports `600` on `vault.key` and `700` on `~/.local/share/claude-control`; the file
holds a single 64-hex line and is byte-identical across repeated doctor runs. The full
`packages/switch-engine` suite also passes on the same Linux install (123 passed — the
POSIX permission tests run for real there, not skipped as on Windows). Remaining open
slice: a keyring-less **desktop** distro is expected to behave identically (same code
path, no D-Bus involved), but has not been separately exercised.

### 13. macOS support (Keychain vault + live-credential channel) ⏳ OPEN

**State of the code:** the Keychain-backed vault protector and the `security(1)`
live-credential channel are **implemented and shipping** (`packages/switch-engine/src/keychain.ts`,
dispatched on `darwin` by `protector.ts`), and unit-tested — but every one of those tests
drives a **fake `ExecRunner`**, never the real binary. Nothing below has run on Mac hardware,
so macOS is **not a supported platform** no matter how green the suite is. Record the verdict
as **arch-scoped** (arm64 ≠ Intel — do not generalize one to the other).

**Run `claude-control-orchestrator/tasks/mac-wet-gate-runbook.md`** — the runbook holds the
exact commands and per-step pass/fail criteria; results are stamped back **here**, the same
cross-repo split gates 2, 4 and 6 use.

**Verify (assumptions A1–A4, defined in `claude-control-orchestrator/tasks/mac-compatibility-plan.md`):**

- **A1 — item name/account.** The CLI's live credentials are assumed to live in Keychain
  service `Claude Code-credentials` under the login user; confirm the exact account name via an
  **attribute-only** dump. Never `-w`/`-g` on the live item — those print the OAuth token, and
  this file is public. A miss here is a config fix (`CLAUDE_CLI_KEYCHAIN_SERVICE` /
  `CLAUDE_CLI_KEYCHAIN_ACCOUNT`), not a code change.
- **A2 — payload shape.** The item decodes to the same `{claudeAiOauth:{…}}` shape as
  `.credentials.json`, confirmed **keys-only**, never by echoing values.
- **A3 — `CLAUDE_CONFIG_DIR` + `--fresh`.** A fresh login with `CLAUDE_CONFIG_DIR` set writes a
  `.credentials.json` **into that dir** (the CLI respects it, as on Windows per WT-1) → `--fresh`
  capture is safe. If instead the login mutates the global Keychain item (clobbering the live
  account), `--fresh` needs a mac-specific path — stop and report, do not improvise one.
- **A4 — recurring Keychain GUI prompt.** Reading the CLI's **cross-app** item via
  `/usr/bin/security` may raise a GUI prompt, and the daemon reads it headlessly in steady
  state. Probe with the three-observation differential (our own `vault-key` item stays silent /
  the CLI item prompts / a post-token-refresh re-read isolates ACL-wipe-on-recreate). **A red
  here has no `security(1)`-path code fix.** It routes to a documented terminal-fail caveat
  ("the daemon needs an interactive login-session Always-Allow; fully headless operation is
  unsupported on macOS"), never an ACL workaround.

**Pass (each stamped with evidence):**

- `cctl doctor` reports `vault-crypto` and `login` green on darwin.
- Switch round-trip: `accounts add` → `switch spare` → `claude -p` runs under the spare →
  `switch` back, with sibling Keychain keys preserved.
- Daemon steady-state: usage polls **both** accounts with **no** Keychain GUI prompt and no
  loopback-firewall dialog.
- **Negative invariant:** the vault directory copied to a second user / temp-keychain context
  **fails** to decrypt — a stolen vault dir is useless without the owner's login keychain.
- **Relay-from-darwin:** the daemon's outbound WebSocket client connects from macOS.

**Result:** not yet run — no Mac available. Nothing on this gate may be marked closed from
the fake-runner unit tests or from the `macos-latest` CI leg (that leg exercises only our own
`vault-key` item, which is the half that was never in doubt).

### 14. `/thread-here` — the live Discord half ⏳ OPEN

**State of the code:** the command, its precedence, its persistence and its whole decision tree
are unit-proven. Its three live adapters are not: `gatherThreadHereFacts`, `probeThreadHere` and
`inspectChannelHealth` are replaced by stand-ins in every test, so the guarantee that a channel
the bot cannot use is refused at command time rests entirely on assumptions about Discord that
no headless test can check.

**Verify (each is an assumption the preflight is built on):**

- **`interaction.appPermissions` reflects channel OVERWRITES**, not just the bot's guild-wide
  role permissions. If it reports the role baseline, a channel that denies the bot by overwrite
  passes stage one — the probe still catches it, but the reply names no permission and is
  therefore unactionable.
- **`interaction.guild === null` with a non-null `guildId` really is "the bot is not in this
  server"** (user-installed app in a foreign guild). If it can also be null for a bot that IS a
  member, that rejection tells a fixable case it cannot be fixed.
- **The four required bits are exactly right.** Create a channel granting only View Channel,
  Create Private Threads, Send Messages in Threads and Manage Threads — nothing else — and
  confirm `/thread-here` pins and a real session thread is then created AND the user admitted.
  Then revoke **Manage Threads alone** and confirm the pin is refused, which is the non-obvious
  bit the whole preflight exists for (`invitable: false` + admitting a non-member).
- **The probe cleans up.** After a successful pin, no `cctl channel check` thread remains. Then
  force a cleanup failure and confirm a second `/thread-here` in the same channel reaps the
  leftover rather than adding another.
- **`action:show` names a user-side loss.** With the bot's permissions untouched, remove the
  user's access to the pinned channel (leave the server, or deny View Channel for them) and
  confirm `show` reports that they cannot see it — not `ok` — and that a new session lands in
  their DMs.
- **The three-second window.** A `pin` in a busy guild answers with a real reply, never "The
  application did not respond". The path defers first, so this is a check that the deferral is
  actually reached and edited, not that it is fast.

**Pass:** every bullet above observed on a real Discord app, with a spare account.

**Result:** not yet run.

### 15. Authorization-code re-login (`/reauth`, `cctl accounts reauth`) ⏳ OPEN

**State of the code:** the PKCE mint, the authorize-URL shape, the paste parser, the code exchange,
the identity guard, the in-place vault write and the whole daemon-side pending-flow state machine
are unit-proven against injected fakes. What no headless test can check is whether the
reverse-engineered endpoints and formats in `switch-engine/src/oauth.ts` are what the real service
actually does — the same posture as gate 2, whose module this shares.

**Verify (run the CLI verb first — same engine call as the phone, minus the daemon):**

- **The authorize URL is accepted as built.** `DEFAULT_AUTHORIZE_ENDPOINT` plus the exact parameter
  set (`code=true`, `client_id`, `response_type=code`, `redirect_uri` = `DEFAULT_REDIRECT_URI`,
  `scope` = `OAUTH_AUTHORIZE_SCOPES`, `code_challenge`, `code_challenge_method=S256`, `state`)
  reaches a real login page and, after approval, a code display — not an error page.
- **The displayed code really is `<code>#<state>`**, with a single separator and no surrounding
  markup or entity-encoding that `parsePastedCode` would mis-split. The parser splits on the LAST
  `#`; confirm no real code makes that the wrong choice.
- **The exchange request/response shape is right.** A JSON `authorization_code` body at
  `DEFAULT_TOKEN_ENDPOINT` returns `access_token` + `refresh_token` (+ `expires_in`), and whatever
  `account`/`organization` fields `mapExchangeResponse` reads are named as assumed — those field
  names are guesses today, so log the token-redacted body once and correct the mapping if it
  differs. If no identity block arrives at all, confirm the output says the match is unverified.
- **A WRONG `code_verifier` is rejected by the real endpoint** (right code, tampered verifier).
  This is the one live check that proves the whole "the verifier never transits, so relaying the
  code is safe" posture (`THREAT_MODEL.md` asset 1a) enforces something server-side, rather than
  PKCE being silently optional.
- **The account is really usable afterwards.** `cctl accounts list` shows the SAME id with
  quarantine cleared, then `cctl switch <label>` + a `claude -p "hi"` authenticates on the
  re-authenticated login.
- **A failed paste changes nothing.** Paste garbage, and a code with a doctored state segment;
  confirm each prints one actionable line and leaves the account's bundle and quarantine flag
  exactly as they were (in particular: a healthy account is never newly quarantined).
- **Then the phone loop**, against a local bot + local daemon (never the shared relay): `/reauth
<label>` → link card → log in on the phone → **Paste code** → success card. Confirm the daemon's
  log records the account and expiry but **never** the URL, the pasted code, the verifier, or a
  token. Re-submit the same modal and confirm the second attempt answers "no re-auth in progress"
  rather than exchanging twice.
- **The live heal.** Re-authenticate the account that is currently live and confirm the live files
  end up holding the NEW token (result outcome `reauthenticated_and_healed`, and the CLI saying the
  fresh login is already in place), that a running `claude` authenticates again without a switch,
  and that the account is **not** quarantined moments later by the next refresh — the failure mode
  `adoptRotationIfNeeded`'s direction guard exists to prevent.

**Pass:** every bullet above observed against a real Claude account.

**Result:** not yet run.

### 16. status.claude.com probe ⏳ OPEN

**Endpoint claim:** `GET https://status.claude.com/api/v2/status.json` (Atlassian Statuspage v2)
answers `{"page": {...}, "status": {"indicator": "none"|"minor"|"major"|"critical",
"description": "All Systems Operational"}}`, and `switch-engine/src/overload.ts` treats any
`indicator` other than exactly `none` as an incident.

**Live-confirmed:** the URL and that body shape, read from the real page in the all-clear state
(`indicator: "none"`, `description: "All Systems Operational"`). The field path
`status.indicator` is what the probe reads; nothing else in the body is used.

**What no headless test can close:**

- **The indicator during a REAL incident.** `minor`/`major`/`critical` are the documented
  Statuspage vocabulary, not values observed here. If the page ever reports something outside
  that set, the probe must still buy the patient budget — an unrecognized indicator is
  deliberately treated as an incident, and that branch wants confirming against a live one.
- **That a real 529 coincides with a reported incident at all.** The whole premise is that a
  fleet-wide overload shows up on the status page. It may lag, or may never be posted for a
  short spike, in which case the short budget is what a genuine 529 gets — acceptable by
  design (the caller retries next cycle), but worth knowing rather than assuming.
- **The probe under a real outage's network conditions.** A status page that is slow rather
  than down must hit the 5s bound and degrade to `unreachable` (→ patient), not stall the
  refresh inside the credential lock.

**Verify:** during (or by simulating against a recorded body) a reported incident, confirm the
refresh failure message reads `token endpoint overloaded (529) after 6 attempts;
status.claude.com: <indicator>` and that the usage snapshot carries the matching
`usage endpoint overloaded (529); status.claude.com: <indicator>`. Then block
`status.claude.com` at the firewall and confirm the same paths say `unreachable` and still
retry the patient number of times.

**Pass:** an all-clear 529 retried the short budget, an incident (or an unreachable page) the
patient one, and no path ever stopped retrying because the status page could not be read.

**Result:** the endpoint and its all-clear body are confirmed; incident behavior is not yet run.

## Reminder

The undocumented endpoints (2, 3, 15) and hook names (5) can change without notice. Parsing
is deliberately tolerant so a schema drift degrades gracefully instead of crashing the
poller — but a change still needs re-confirmation here.
