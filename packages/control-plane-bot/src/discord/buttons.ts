// Button customId grammar + the two-tap confirm state machine for destructive actions.
//
// discord.js buttons carry no server state between taps — the ONLY thing that survives a tap is
// the button's `customId` string. So the entire two-tap confirm flow is encoded there: a
// destructive button ships ARMED, its first tap swaps the row for a Confirm/Cancel pair whose
// customIds carry the arm timestamp, and only the second (Confirm) tap executes. This keeps every
// bit of the decision PURE and unit-testable off `resolveTap(customId, now)` with no discord.js
// and no fake timers — the gateway does nothing but translate the returned ButtonSpecs into
// real components and route an `execute` to the matching command handler.

/** The things a button can ultimately do. Each maps 1:1 to a command handler. */
export type ButtonAction = 'approve' | 'deny' | 'switch' | 'stop' | 'prune';

/** Where a button sits in the two-tap lifecycle. `go` = single-tap, execute immediately (safe
 *  actions). `arm` = the resting state of a destructive button. `confirm`/`cancel` = the pair a
 *  first tap swaps in. */
export type ButtonPhase = 'go' | 'arm' | 'confirm' | 'cancel';

/** Permission scope carried through to `permission.response`; `na` for actions that have none. */
export type ButtonScope = 'once' | 'session' | 'na';

/** discord.js button styles, as plain strings so this module stays discord.js-free (the gateway
 *  maps these to `ButtonStyle.*`). */
export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

/** A button as plain data — the render struct the gateway turns into a ButtonBuilder. */
export interface ButtonSpec {
  customId: string;
  label: string;
  style: ButtonStyle;
}

/** A decoded customId. `ts` is the arm timestamp stamped into a Confirm button (0 otherwise);
 *  `id` is the free-form requestId / accountId / sessionId and may itself contain the delimiter. */
export interface ParsedButton {
  action: ButtonAction;
  phase: ButtonPhase;
  scope: ButtonScope;
  ts: number;
  id: string;
}

const PREFIX = 'cc';
const SEP = ':';

/** How long a Confirm button stays valid after its row is armed. Past this, a Confirm tap is
 *  treated as stale (re-arm instead of firing) so a day-old card can't execute a destructive
 *  action on an idle tap. */
export const CONFIRM_TTL_MS = 30_000;

/** discord.js hard cap on a customId. Our ids are server-minted UUIDs, so the encoded string is
 *  ~60 chars — comfortably under this — but the constant documents the ceiling for reviewers. */
export const CUSTOM_ID_MAX = 100;

const ACTIONS = new Set<ButtonAction>(['approve', 'deny', 'switch', 'stop', 'prune']);
const PHASES = new Set<ButtonPhase>(['go', 'arm', 'confirm', 'cancel']);
const SCOPES = new Set<ButtonScope>(['once', 'session', 'na']);

/** Encode a customId. Field order is fixed and the free-form `id` goes LAST, so an id that
 *  itself contains `:` round-trips through `decodeButton` intact. */
export function encodeButton(p: ParsedButton): string {
  return [PREFIX, p.action, p.phase, p.scope, Math.floor(p.ts), p.id].join(SEP);
}

/** Decode a customId, or `null` for anything that isn't one of ours (foreign/legacy buttons) or
 *  is malformed. Rebuilds the trailing `id` by rejoining, so `:` inside an id survives. */
export function decodeButton(customId: string): ParsedButton | null {
  const parts = customId.split(SEP);
  if (parts.length < 6 || parts[0] !== PREFIX) return null;
  const [, action, phase, scope, tsRaw] = parts;
  if (
    action === undefined ||
    phase === undefined ||
    scope === undefined ||
    tsRaw === undefined ||
    !ACTIONS.has(action as ButtonAction) ||
    !PHASES.has(phase as ButtonPhase) ||
    !SCOPES.has(scope as ButtonScope)
  ) {
    return null;
  }
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return null;
  const id = parts.slice(5).join(SEP);
  if (id.length === 0) return null;
  return {
    action: action as ButtonAction,
    phase: phase as ButtonPhase,
    scope: scope as ButtonScope,
    ts,
    id,
  };
}

/** Which actions warrant a confirm step: switching accounts, stopping a session, and pruning
 *  session records are always destructive (a prune irrevocably forgets every dormant session's
 *  resume anchor); denying is only destructive at `session` scope (a one-off deny is cheap and
 *  re-requestable, a session deny blanks the tool for the whole run). */
export function isDestructive(action: ButtonAction, scope: ButtonScope): boolean {
  if (action === 'switch' || action === 'stop' || action === 'prune') return true;
  return action === 'deny' && scope === 'session';
}

/** The result of a button tap, as plain data the gateway acts on:
 *   - `execute`   → run the mapped command handler (and dedupe on its idempotency key first).
 *   - `confirm`   → swap the message's row to the returned Confirm/Cancel buttons.
 *   - `restore`   → put the armed button back (a Cancel tap, or a stale Confirm).
 *   - `ignore`    → not our button, or malformed; do nothing but tell the user. */
export type TapOutcome =
  | { kind: 'ignore'; reason: string }
  | { kind: 'execute'; action: ButtonAction; scope: ButtonScope; id: string }
  | { kind: 'confirm'; rows: ButtonSpec[][]; note: string }
  | { kind: 'restore'; rows: ButtonSpec[][]; note: string };

/** Human label for a destructive button in its armed/confirm-target state. */
function destructiveLabel(action: ButtonAction, scope: ButtonScope): string {
  if (action === 'switch') return 'Switch account';
  if (action === 'stop') return 'Stop session';
  if (action === 'prune') return 'Prune sessions';
  return scope === 'session' ? 'Deny (session)' : 'Deny';
}

/** Rebuild the armed button (the resting state a Cancel/timeout returns the row to). */
function armedButton(p: ParsedButton): ButtonSpec {
  return {
    customId: encodeButton({ action: p.action, phase: 'arm', scope: p.scope, ts: 0, id: p.id }),
    label: destructiveLabel(p.action, p.scope),
    style: 'danger',
  };
}

/** The FULL row a restore (Cancel / stale Confirm) returns the message to. The customId is the
 *  only state that survives a tap, but it proves what the card originally rendered: permission
 *  buttons ship on EVERY permission card, and a Stop button ships only on a stoppable session
 *  — so the whole original row is reconstructible. Restoring just the armed button would
 *  permanently lose the sibling Approve/Deny buttons on a permission card. */
function restoredRows(p: ParsedButton): ButtonSpec[][] {
  if (p.action === 'approve' || p.action === 'deny') {
    return permissionButtons({ requestId: p.id });
  }
  if (p.action === 'stop') {
    return sessionCardButtons({ sessionId: p.id, stoppable: true });
  }
  // 'switch' and 'prune' have no multi-button card — the armed button IS the whole row.
  return [[armedButton(p)]];
}

/** The Confirm/Cancel pair a first tap swaps in. Confirm carries `nowMs` so a later tap can be
 *  aged out against CONFIRM_TTL_MS. */
function confirmCancelRow(p: ParsedButton, nowMs: number): ButtonSpec[] {
  return [
    {
      customId: encodeButton({
        action: p.action,
        phase: 'confirm',
        scope: p.scope,
        ts: nowMs,
        id: p.id,
      }),
      label: 'Confirm',
      style: 'danger',
    },
    {
      customId: encodeButton({
        action: p.action,
        phase: 'cancel',
        scope: p.scope,
        ts: 0,
        id: p.id,
      }),
      label: 'Cancel',
      style: 'secondary',
    },
  ];
}

/**
 * The whole two-tap decision, pure. Given the tapped customId and the current time, say what the
 * gateway should do. `go` fires immediately; `arm` asks for confirmation; `confirm` fires only
 * within the TTL, else re-arms; `cancel` re-arms. Unknown ids are ignored, never guessed at.
 */
export function resolveTap(
  customId: string,
  nowMs: number,
  ttlMs: number = CONFIRM_TTL_MS,
): TapOutcome {
  const p = decodeButton(customId);
  if (!p) return { kind: 'ignore', reason: `unrecognized button: ${customId}` };
  switch (p.phase) {
    case 'go':
      return { kind: 'execute', action: p.action, scope: p.scope, id: p.id };
    case 'arm':
      return {
        kind: 'confirm',
        rows: [confirmCancelRow(p, nowMs)],
        note: `Confirm ${destructiveLabel(p.action, p.scope).toLowerCase()}?`,
      };
    case 'confirm':
      if (nowMs - p.ts > ttlMs) {
        // Name the window so the reset teaches the mechanic — a silent revert to the
        // original buttons reads as a failure, not a timeout.
        return {
          kind: 'restore',
          rows: restoredRows(p),
          note: `Expired; confirm within ${Math.round(ttlMs / 1000)}s. Tap again to retry.`,
        };
      }
      return { kind: 'execute', action: p.action, scope: p.scope, id: p.id };
    case 'cancel':
      return { kind: 'restore', rows: restoredRows(p), note: 'Cancelled.' };
  }
}

/**
 * The button row for a permission.request card — attached in EVERY permission mode. The daemon
 * only emits permission.request while it is holding the hook's HTTP response open for a remote
 * decision, and the CLI only fires that hook when it is actually blocking on a prompt (accept-
 * edits auto-approves file edits but still prompts for shell commands), so a card can only
 * exist while a tap would truthfully take effect; a lapsed hold already gets its own honest
 * refusal on tap. Approve/Deny are safe single-tap; a session-scope Deny is destructive, so it
 * ships armed and goes through confirm.
 */
export function permissionButtons(payload: { requestId: string }): ButtonSpec[][] {
  const id = payload.requestId;
  return [
    [
      {
        customId: encodeButton({ action: 'approve', phase: 'go', scope: 'once', ts: 0, id }),
        label: 'Approve',
        style: 'success',
      },
      {
        customId: encodeButton({ action: 'deny', phase: 'go', scope: 'once', ts: 0, id }),
        label: 'Deny',
        style: 'secondary',
      },
      {
        customId: encodeButton({ action: 'deny', phase: 'arm', scope: 'session', ts: 0, id }),
        label: 'Deny (session)',
        style: 'danger',
      },
    ],
  ];
}

/**
 * The button row for a live managed-session card: a single Stop control. Stop is destructive, so it
 * ships ARMED (`phase:'arm'`) and goes through the same two-tap confirm as every other destructive
 * button — a stray tap on a session card can never kill a running session outright. `id` is the
 * sessionId, so an `execute` outcome maps straight to `handleStop` for that session. Returns `[]`
 * for a session that is stopping or already terminal (nothing left to stop), so the card's row is
 * simply cleared on its final edit.
 */
export function sessionCardButtons(payload: {
  sessionId: string;
  stoppable: boolean;
}): ButtonSpec[][] {
  if (!payload.stoppable) return [];
  return [
    [
      {
        customId: encodeButton({
          action: 'stop',
          phase: 'arm',
          scope: 'na',
          ts: 0,
          id: payload.sessionId,
        }),
        label: 'Stop session',
        style: 'danger',
      },
    ],
  ];
}

/**
 * The button row for the `/prune` confirmation card: a single armed Prune control, the same
 * two-tap confirm every destructive button gets. `id` is the requestId minted for THIS `/prune`
 * invocation — deliberately NOT a constant: the executed-button dedupe keys off (user, action,
 * id), and a fixed id would swallow a legitimate second prune issued within the dedupe window.
 */
export function pruneButtons(payload: { requestId: string }): ButtonSpec[][] {
  return [
    [
      {
        customId: encodeButton({
          action: 'prune',
          phase: 'arm',
          scope: 'na',
          ts: 0,
          id: payload.requestId,
        }),
        label: 'Prune sessions',
        style: 'danger',
      },
    ],
  ];
}

/**
 * The idempotency key for an executed button tap. Derived from the LOGICAL action (who + what +
 * which target), NOT from the interaction id — that is exactly what lets a double-tap from two
 * phones collapse to the same key so the second resolves to "already handled" instead of sending
 * a second command frame. Slash commands keep fresh random keys (each invocation is intentional);
 * only buttons dedupe.
 */
export function buttonIdempotencyKey(
  userId: string,
  o: { action: ButtonAction; scope: ButtonScope; id: string },
): string {
  return `btn:${userId}:${o.action}:${o.scope}:${o.id}`;
}
