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
  credential store (surgical key preservation in `~/.claude.json`). **DPAPI itself is
  proven for real** — a genuine PowerShell ProtectedData encrypt/decrypt round-trip
  runs in the suite on Windows.
- **usage-advisor** — burn-before-reset selection, near-cap risk avoidance, switch-now,
  quarantine handling, binding-limit headroom, determinism.
- **control-plane-bot** — token mint/verify (constant-time), pairing (single-use,
  expiry, isolation), and WS relay routing/ACL over **real in-process sockets** (cross-
  user isolation, bad-token/old-version rejection, invalid-frame drop).
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
present, `npm i -g claudecontrol` followed by `cctl setup` reaches a paired,
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

## Reminder

The undocumented endpoints (2, 3) and hook names (5) can change without notice. Parsing
is deliberately tolerant so a schema drift degrades gracefully instead of crashing the
poller — but a change still needs re-confirmation here.
