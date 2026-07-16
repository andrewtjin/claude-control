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

### 4. Discord bot

**Verify:** the bot logs in (`DISCORD_BOT_TOKEN`), registers slash commands, creates a
per-user channel on `/pair`, and renders the usage + plan embed with a working switch
button.
**Pass:** end-to-end from a phone — `/pair` binds, `/usage` shows the table, the switch
button completes on the PC and edits the card.

### 5. Hook event names ⚠ PARTIALLY CLOSED 2026-07-16

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
**Pass (remaining):** a permission prompt in a `default`-mode session reaches the loopback
hook receiver and surfaces on the phone; approve/deny round-trips.

### 6. Managed sessions (Agent SDK)

**Verify:** `session-runtime/src/managedSession.ts`'s adapter matches the real
`@anthropic-ai/claude-agent-sdk` streaming API (message shapes, `interrupt`, input).
**Pass:** `/run` starts a session that streams summarized milestones to a Discord
thread; `/say` injects a prompt.

### 7. Observed sessions (ConPTY)

**Verify:** `node-pty` (an optional dep, not installed by default) drives a real
Windows terminal.
**Setup:** `pnpm add -w node-pty` (needs MSVC build tools) or a prebuilt binary.
**Pass:** `cctl run` wraps a terminal; output is observed and a prompt can be injected;
absence of `node-pty` degrades gracefully with a clear message.

### 8. `~/.claude.json` round-trip

**Verify:** switching rewrites only the `oauthAccount` block and preserves every other
key (projects, history, settings), including the duplicate-key quirk seen on real
files.
**Pass:** diff `~/.claude.json` before/after a switch — only `oauthAccount` changed.

## Reminder

The undocumented endpoints (2, 3) and hook names (5) can change without notice. Parsing
is deliberately tolerant so a schema drift degrades gracefully instead of crashing the
poller — but a change still needs re-confirmation here.
