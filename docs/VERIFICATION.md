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

### 1. Hot-swap of a live interactive session — the M0 question
**Claim to verify:** on Windows the CLI reads `.credentials.json` per request, so a
switch applies to a *running* interactive session on its **next** message.
**How:** start `claude` interactively under account A; from another shell run the switch
engine to activate B; send a new message in the running session.
**Pass:** the next message is served by B (check the usage endpoint / account identity).
**If it fails:** the fallback UX ("staged for next launch") is already designed —
`ActivateResult` reports only what was mechanically written, so the daemon's messaging
adapts to whichever answer this gate gives.

### 2. OAuth refresh endpoint
**Verify:** `switch-engine/src/oauth.ts` `DEFAULT_TOKEN_ENDPOINT`,
`CLAUDE_CODE_CLIENT_ID`, and the request/response shape are correct.
**How:** point the switch engine at a spare account whose access token is near expiry
and trigger `activate`; watch it refresh.
**Pass:** a new access + rotated refresh token are written to the vault and the account
keeps working. **Fail signal:** `invalid_grant` on a token you know is live → the
endpoint/shape is wrong, not the token.

### 3. Usage endpoint
**Verify:** `GET https://api.anthropic.com/api/oauth/usage` with the Bearer token,
`anthropic-beta: oauth-2025-04-20`, and a `User-Agent: claude-code/<ver>` returns the
expected `utilization.limits[]`.
**Pass:** live percentages for session + weekly limits. **Note:** omitting the
User-Agent gets throttled; the poller must fall back to tier-0 cached data on error.

### 4. Discord bot
**Verify:** the bot logs in (`DISCORD_BOT_TOKEN`), registers slash commands, creates a
per-user channel on `/pair`, and renders the usage + plan embed with a working switch
button.
**Pass:** end-to-end from a phone — `/pair` binds, `/usage` shows the table, the switch
button completes on the PC and edits the card.

### 5. Hook event names
**Verify:** the exact `PermissionRequest` / `Stop` / `Notification` hook event names and
payloads against the installed CLI version, and that merging our hooks into each
profile's `settings.json` is non-destructive.
**Pass:** a permission prompt in a session reaches the loopback hook receiver and
surfaces on the phone; approve/deny round-trips.

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
