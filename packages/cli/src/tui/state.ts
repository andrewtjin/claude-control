// The full-screen view's state machine: what each key does, as a pure function.
//
// `reduce(state, key)` returns the next state and at most one effect (a switch, a rename, a
// refresh...) for the runtime to carry out. The runtime reports how the effect went back through
// `settleAction`, also pure. Keeping every decision here, away from the terminal and the engine,
// is what lets each key in each pane be tested as a table.

import type { UsageRepollResult } from '@claude-control/daemon';
import { humanizeDuration } from '@claude-control/usage-advisor';
import {
  PANES,
  type Effect,
  type Key,
  type PaneId,
  type TuiAccount,
  type TuiPrompt,
  type TuiSnapshot,
  type TuiState,
  type TuiStatus,
  type Transition,
} from './types.js';

/** Longest label a prompt accepts. Far past any label a person types; it only stops a paste from
 *  growing the input without bound. */
const MAX_INPUT = 200;

/** The state before the first read lands. */
export function initialState(nowMs: number, platform: NodeJS.Platform): TuiState {
  return {
    nowMs,
    platform,
    pane: 'accounts',
    mode: { kind: 'browse' },
    scroll: { sessions: 0, folders: 0, outages: 0 },
    quitWhenIdle: false,
  };
}

/** The accounts the last read found, or none when it could not read them. */
export function accountsOf(state: TuiState): TuiAccount[] {
  const section = state.snapshot?.accounts;
  return section?.ok === true ? section.value : [];
}

/** The selected account, or undefined when none is (before the first read, with no accounts, or
 *  once the selected one is gone). Never a stand-in: an account verb acts only on an account the
 *  person picked. */
export function selectedAccount(state: TuiState): TuiAccount | undefined {
  return accountsOf(state).find((a) => a.id === state.selectedId);
}

/**
 * Take a fresh read. The first read with accounts in it selects the first one. After that the
 * selection stays on its account while it exists, and when it is gone (removed here or elsewhere)
 * nothing is selected until the person moves: putting it on another row would quietly hand the
 * next Enter, or a key already on its way, an account nobody picked. A read whose accounts section
 * failed says nothing about which accounts exist, so it leaves the selection alone. An open
 * prompt follows its account the same way (see {@link followPrompt}).
 */
export function applySnapshot(state: TuiState, snapshot: TuiSnapshot): TuiState {
  let next: TuiState = { ...state, snapshot, nowMs: snapshot.readAtMs };
  delete next.loadError;
  if (next.status?.untilRead === true) delete next.status;
  if (!snapshot.accounts.ok) return next;
  const accounts = snapshot.accounts.value;
  if (state.selectedId === undefined) {
    if (accounts[0] !== undefined) next.selectedId = accounts[0].id;
  } else if (!accounts.some((a) => a.id === state.selectedId)) {
    next = saySelectionGone(next, state);
  }
  return followPrompt(next, accounts);
}

/** Say that the selected account is gone, once: on the read that first finds it missing after
 *  one that had it (or after one that could not tell). The id stays as the selection, matching
 *  nothing, so the next read does not pick a stand-in or say it again. */
function saySelectionGone(next: TuiState, before: TuiState): TuiState {
  const previous = before.snapshot?.accounts;
  const had = previous?.ok === true ? previous.value.find((a) => a.id === before.selectedId) : null;
  if (had === undefined) return next;
  const who = had === null ? 'The selected account' : had.label;
  return withStatus(
    next,
    `${who} is no longer stored, so no account is selected (j/k selects one).`,
    'info',
  );
}

/**
 * Keep an open rename or remove prompt about the account as it is now. The prompt names its
 * account by id, but the person reads (and, for a remove, types) its label: when another process
 * renames it, the prompt shows the new label, so the typed confirmation is checked against the
 * label the account has, not one it used to have (a note about the old label is dropped). When the
 * account is gone the prompt stays open, taking nothing and starting nothing, until Escape: keys
 * the person is still typing into it must not reach the account list.
 */
function followPrompt(state: TuiState, accounts: readonly TuiAccount[]): TuiState {
  const mode = state.mode;
  if (mode.kind !== 'prompt' || mode.account === undefined || mode.gone === true) return state;
  const target = mode.account;
  const now = accounts.find((a) => a.id === target.id);
  if (now === undefined) {
    return {
      ...state,
      mode: {
        ...mode,
        gone: true,
        note: `${target.label} is no longer stored. Esc closes this prompt.`,
      },
    };
  }
  if (now.label === target.label) return state;
  const followed: TuiPrompt = { ...mode, account: { id: now.id, label: now.label } };
  delete followed.note;
  return { ...state, mode: followed };
}

/** A read that failed: the last good picture stays, and the failure is said. */
export function applyLoadError(state: TuiState, message: string): TuiState {
  return { ...state, loadError: message };
}

/** Say something on the status line. */
export function withStatus(
  state: TuiState,
  text: string,
  tone: TuiStatus['tone'],
  untilRead = false,
): TuiState {
  return { ...state, status: untilRead ? { text, tone, untilRead } : { text, tone } };
}

/** How an action the runtime ran ended: its own words on success, the refusal's on a refusal.
 *  Clears `busy`. `notes` are the warnings logged while it ran: the status line showed the
 *  running action then, so they are said with the outcome rather than lost under it. A refused
 *  action started from a prompt opens that prompt again, saying why (see `reopenOnRefusal`). */
export function settleAction(
  state: TuiState,
  outcome: { ok: true; message: string } | { ok: false; message: string },
  notes: readonly string[] = [],
): TuiState {
  const tone = !outcome.ok ? 'error' : notes.length > 0 ? 'warn' : 'ok';
  const text = withNotes(outcome.message, notes);
  const next = withStatus(state, text, tone);
  delete next.busy;
  delete next.reopenOnRefusal;
  if (!outcome.ok && state.reopenOnRefusal !== undefined) {
    next.mode = { ...state.reopenOnRefusal, note: text };
  }
  return next;
}

/** An outcome line with every warning logged while it ran. A long one is cut on the status line
 *  but read whole in the message overlay (m) or, after quitting, on the normal screen. */
export function withNotes(message: string, notes: readonly string[]): string {
  if (notes.length === 0) return message;
  return notes.length === 1
    ? `${message} Warning: ${notes[0]!}`
    : `${message} ${notes.length} warnings: ${notes.join('; ')}`;
}

/** Why a refresh cannot be asked for right now, or undefined when it can. The daemon does the
 *  polling; with no running daemon there is nobody to ask. */
export function refreshBlocker(state: TuiState): string | undefined {
  const heartbeat = state.snapshot?.daemon.heartbeat;
  if (heartbeat === undefined) return 'Refresh is not available until the first read finishes.';
  if (heartbeat.state === 'alive') return undefined;
  const why =
    heartbeat.state === 'never'
      ? 'the daemon has never run on this machine'
      : heartbeat.state === 'stopped'
        ? 'the daemon is stopped'
        : 'the daemon is not answering (its heartbeat is stale)';
  return `Refresh needs the running daemon, and ${why} - start it with: cctl daemon start`;
}

/** The refresh's verdicts as one line: what was scheduled, and what is held and until when. */
export function describeRepoll(
  result: UsageRepollResult,
  labelOf: (id: string) => string,
  nowMs: number,
): string {
  const scheduled = result.results.filter((r) => r.outcome === 'scheduled');
  const parts: string[] = [];
  if (scheduled.length > 0) {
    parts.push(
      `Refreshing ${scheduled.map((r) => labelOf(r.id)).join(', ')}; new numbers show on the next read`,
    );
  }
  for (const r of result.results) {
    if (r.outcome !== 'skipped') continue;
    const who = labelOf(r.id);
    if (r.reason === 'floor') {
      parts.push(`${who} was polled recently (next in ${humanizeDuration(r.dueAtMs - nowMs)})`);
    } else if (r.reason === 'backoff') {
      parts.push(`${who} is rate limited (next in ${humanizeDuration(r.dueAtMs - nowMs)})`);
    } else if (r.reason === 'cycle_failed') {
      parts.push(`${who} not refreshed: the daemon's last poll cycle failed and it is retrying`);
    } else {
      parts.push(`${who} is no longer stored`);
    }
  }
  return parts.length > 0 ? `${parts.join('. ')}.` : 'There are no accounts to refresh.';
}

/** Where Tab (or Shift-Tab, `step` -1) goes from `pane`. */
function cyclePane(pane: PaneId, step: 1 | -1): PaneId {
  const i = PANES.indexOf(pane);
  return PANES[(i + step + PANES.length) % PANES.length]!;
}

/** Move the selection by `delta` rows, stopping at either end. With nothing selected, moving
 *  down picks the first row and moving up stays there too (End picks the last). */
function moveSelection(state: TuiState, delta: number): TuiState {
  const accounts = accountsOf(state);
  if (accounts.length === 0) return state;
  const current = accounts.findIndex((a) => a.id === state.selectedId);
  const next = Math.min(accounts.length - 1, Math.max(0, current + delta));
  return { ...state, selectedId: accounts[next]!.id };
}

/** Scroll the current text pane by `delta` lines; never above the top. The bottom is clamped when
 *  the frame is drawn, the only place the pane's line count is known. */
function scrollPane(state: TuiState, delta: number): TuiState {
  if (state.pane === 'accounts') return state;
  const pane = state.pane;
  return { ...state, scroll: { ...state.scroll, [pane]: Math.max(0, state.scroll[pane] + delta) } };
}

/** The verbs that act on the selected account, for the line said when there is none. */
const ACCOUNT_VERBS: Readonly<Record<string, string>> = {
  enter: 'switch to',
  e: 'exclude or include',
  r: 'rename',
  d: 'remove',
  l: 'launch',
};

/** One page of rows for PageUp/PageDown. The renderer knows the real height; a fixed page keeps
 *  the reducer free of the terminal's size. */
const PAGE = 10;

/** How far a movement key scrolls a scrollable overlay or pane, or undefined for a key that is
 *  not a movement key. */
function scrollStep(key: Key): number | undefined {
  switch (key.name) {
    case 'up':
      return -1;
    case 'down':
      return 1;
    case 'pageup':
      return -PAGE;
    case 'pagedown':
      return PAGE;
    case 'home':
      return -Number.MAX_SAFE_INTEGER;
    case 'end':
      return Number.MAX_SAFE_INTEGER;
    case 'char':
      return key.char === 'k' ? -1 : key.char === 'j' ? 1 : undefined;
    default:
      return undefined;
  }
}

/** Mark `state` busy with `what` and hand `effect` to the runtime. `from` is the prompt the
 *  action was asked for in, opened again if the action is refused. */
function start(state: TuiState, what: string, effect: Effect, from?: TuiPrompt): Transition {
  const next: TuiState = { ...state, busy: what };
  if (from !== undefined) {
    const reopen: TuiPrompt = { ...from };
    delete reopen.note;
    next.reopenOnRefusal = reopen;
  }
  return { state: next, effect };
}

/** Scroll an overlay that scrolls (help, the message) by `step`, never above the top; the
 *  bottom is clamped where the overlay's height is known. */
function scrollOverlay(
  state: TuiState,
  mode: Extract<TuiState['mode'], { kind: 'help' | 'message' }>,
  step: number,
): TuiState {
  const scroll = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, mode.scroll + step));
  return { ...state, mode: { kind: mode.kind, scroll } };
}

/**
 * What one key does.
 *
 * Ctrl-C quits from anywhere; while an action runs it quits once the action ends (a switch cut off
 * half way would leave its recovery to the next command), and a second Ctrl-C quits at once.
 * The help and message overlays scroll with the movement keys and close on any other; the launch
 * line closes on any key. A prompt takes text until Enter or Escape. Otherwise the key map
 * applies, with the account verbs answering only in the Accounts pane. Pasted text is only ever
 * prompt input.
 */
export function reduce(state: TuiState, key: Key): Transition {
  if (key.name === 'ctrl-c') {
    if (state.busy !== undefined && !state.quitWhenIdle) {
      return {
        state: {
          ...withStatus(
            state,
            'Quitting when this finishes (press Ctrl-C again to quit now).',
            'warn',
          ),
          quitWhenIdle: true,
        },
      };
    }
    return { state, effect: { kind: 'quit' } };
  }
  // An action is running: nothing else may start or change the screen under it.
  if (state.busy !== undefined) return { state };

  const mode = state.mode;
  if (mode.kind === 'help' || mode.kind === 'message') {
    const step = scrollStep(key);
    if (step === undefined) return { state: { ...state, mode: { kind: 'browse' } } };
    return { state: scrollOverlay(state, mode, step) };
  }
  if (mode.kind === 'launch') return { state: { ...state, mode: { kind: 'browse' } } };
  if (mode.kind === 'prompt') return reducePrompt(state, mode, key);

  switch (key.name) {
    case 'tab':
      return { state: { ...state, pane: cyclePane(state.pane, 1) } };
    case 'backtab':
      return { state: { ...state, pane: cyclePane(state.pane, -1) } };
    case 'escape':
      return { state, effect: { kind: 'quit' } };
    case 'up':
      return {
        state: state.pane === 'accounts' ? moveSelection(state, -1) : scrollPane(state, -1),
      };
    case 'down':
      return { state: state.pane === 'accounts' ? moveSelection(state, 1) : scrollPane(state, 1) };
    case 'pageup':
      return {
        state: state.pane === 'accounts' ? moveSelection(state, -PAGE) : scrollPane(state, -PAGE),
      };
    case 'pagedown':
      return {
        state: state.pane === 'accounts' ? moveSelection(state, PAGE) : scrollPane(state, PAGE),
      };
    case 'home':
      return {
        state:
          state.pane === 'accounts'
            ? moveSelection(state, -Number.MAX_SAFE_INTEGER)
            : { ...state, scroll: { ...state.scroll, [state.pane]: 0 } },
      };
    case 'end':
      return {
        state:
          state.pane === 'accounts'
            ? moveSelection(state, Number.MAX_SAFE_INTEGER)
            : scrollPane(state, Number.MAX_SAFE_INTEGER),
      };
    case 'enter':
      return accountVerb(state, 'enter');
    case 'char':
      return reduceChar(state, key.char);
    case 'paste':
      // A paste is text, and outside a prompt there is nothing to type it into: run as keys, a
      // clipboard holding "rachel" would rename, exclude and switch.
      return {
        state: withStatus(state, 'Pasted text only goes into a prompt (r rename, a add).', 'info'),
      };
    default:
      return { state };
  }
}

/** A printable key outside a prompt. */
function reduceChar(state: TuiState, char: string): Transition {
  switch (char) {
    case 'q':
      return { state, effect: { kind: 'quit' } };
    case 'k':
      return reduce(state, { name: 'up' });
    case 'j':
      return reduce(state, { name: 'down' });
    case '?':
      return { state: { ...state, mode: { kind: 'help', scroll: 0 } } };
    case 'm':
      return lastMessage(state) === undefined
        ? { state: withStatus(state, 'There is no message to show.', 'info') }
        : { state: { ...state, mode: { kind: 'message', scroll: 0 } } };
    case 'a':
      return { state: { ...state, mode: { kind: 'prompt', purpose: 'add', input: '' } } };
    case 'u': {
      const blocked = refreshBlocker(state);
      if (blocked !== undefined) return { state: withStatus(state, blocked, 'warn') };
      return start(state, 'Asking the daemon to refresh usage...', { kind: 'refresh' });
    }
    case 'e':
    case 'r':
    case 'd':
    case 'l':
      return accountVerb(state, char);
    default:
      return { state };
  }
}

/** The message the status line says when nothing is running, in full: the last word, else a read
 *  that failed. Undefined when there is none. */
export function lastMessage(state: TuiState): string | undefined {
  if (state.status !== undefined) return state.status.text;
  return state.loadError !== undefined ? `Could not read: ${state.loadError}` : undefined;
}

/** Why there is no selected account to act on: not read yet, unreadable, none stored, or none
 *  selected (the selected one is gone). Only the third is "there is no account"; saying so
 *  before the read lands would be false. */
function noAccountStatus(state: TuiState, what: string): TuiState {
  const section = state.snapshot?.accounts;
  if (section === undefined) {
    return withStatus(state, 'The accounts are still being read.', 'info', true);
  }
  if (!section.ok) {
    return withStatus(
      state,
      `The accounts could not be read, so there is nothing to ${what}.`,
      'warn',
    );
  }
  if (section.value.length > 0) {
    return withStatus(state, `No account is selected; pick one with j/k to ${what}.`, 'info');
  }
  return withStatus(state, `There is no account to ${what}.`, 'info');
}

/** A key that acts on the selected account: only in the Accounts pane, and only with an account
 *  to act on. */
function accountVerb(state: TuiState, verb: 'enter' | 'e' | 'r' | 'd' | 'l'): Transition {
  const what = ACCOUNT_VERBS[verb]!;
  if (state.pane !== 'accounts') {
    return {
      state: withStatus(state, `Go to the Accounts pane (Tab) to ${what} an account.`, 'info'),
    };
  }
  const account = selectedAccount(state);
  if (account === undefined) return { state: noAccountStatus(state, what) };
  const target = { id: account.id, label: account.label };
  switch (verb) {
    case 'enter':
      return start(state, `Switching to ${account.label}...`, {
        kind: 'switch',
        id: account.id,
        label: account.label,
      });
    case 'e': {
      const excluded = !account.excluded;
      return start(state, `${excluded ? 'Excluding' : 'Including'} ${account.label}...`, {
        kind: 'exclude',
        id: account.id,
        label: account.label,
        excluded,
      });
    }
    case 'r':
      return {
        state: {
          ...state,
          mode: { kind: 'prompt', purpose: 'rename', account: target, input: '' },
        },
      };
    case 'd':
      return {
        state: {
          ...state,
          mode: { kind: 'prompt', purpose: 'remove', account: target, input: '' },
        },
      };
    case 'l':
      return { state: { ...state, mode: { kind: 'launch', label: account.label } } };
  }
}

type PromptMode = TuiPrompt;

/** `text` added to a prompt's input: printable characters only (a pasted line break is not an
 *  Enter), up to the input cap. Clears the note, which was about the input as it was. */
function typed(state: TuiState, mode: PromptMode, text: string): Transition {
  let input = [...mode.input];
  for (const ch of text) {
    if (input.length >= MAX_INPUT) break;
    if ((ch.codePointAt(0) ?? 0) < 0x20) continue;
    input = [...input, ch];
  }
  const next: PromptMode = { ...mode, input: input.join('') };
  delete next.note;
  return { state: { ...state, mode: next } };
}

/** A key while a prompt is open. A prompt whose account is gone answers Escape only. */
function reducePrompt(state: TuiState, mode: PromptMode, key: Key): Transition {
  if (key.name === 'escape') {
    return { state: withStatus({ ...state, mode: { kind: 'browse' } }, 'Cancelled.', 'info') };
  }
  if (mode.gone === true) return { state };
  switch (key.name) {
    case 'backspace': {
      const chars = [...mode.input];
      chars.pop();
      const next: PromptMode = { ...mode, input: chars.join('') };
      delete next.note;
      return { state: { ...state, mode: next } };
    }
    case 'char':
      return typed(state, mode, key.char);
    case 'paste':
      return typed(state, mode, key.text);
    case 'enter':
      return submitPrompt(state, mode);
    default:
      return { state };
  }
}

/** Keep the prompt open, saying why its Enter did not go through. Closing it instead would hand a
 *  second Enter in the same burst (a double press, a bounce, a paste ending in two line breaks)
 *  to the browse keys, where Enter switches the live login to the selected account. */
function stayOpen(state: TuiState, mode: PromptMode, note: string): Transition {
  return { state: { ...state, mode: { ...mode, note } } };
}

/** Why `label` cannot be given to an account (`exceptId`: the account being renamed, whose own
 *  label it may keep): another account already answers to it, by id or by label in any case, as
 *  the vault refuses it. Undefined when it is free. */
function labelTaken(state: TuiState, label: string, exceptId?: string): string | undefined {
  const lower = label.toLowerCase();
  const holder = accountsOf(state).find(
    (a) => a.id === label || (a.id !== exceptId && a.label.toLowerCase() === lower),
  );
  if (holder === undefined) return undefined;
  return holder.id === label
    ? `"${label}" is an account id. Pick another label, or Esc to cancel.`
    : `"${label}" is already the label of ${holder.label}. Pick another, or Esc to cancel.`;
}

/** Enter in a prompt: the action it was asking for, or why not, with the prompt still open. */
function submitPrompt(state: TuiState, mode: PromptMode): Transition {
  const browse: TuiState = { ...state, mode: { kind: 'browse' } };
  const input = mode.input;
  switch (mode.purpose) {
    case 'add': {
      const label = input.trim();
      if (label === '') return stayOpen(state, mode, 'Type a label first, or Esc to cancel.');
      // Refused here, before the login window: the vault would refuse it only after the person
      // had completed a whole browser login.
      const taken = labelTaken(state, label);
      if (taken !== undefined) return stayOpen(state, mode, taken);
      return start(browse, `Adding ${label}...`, { kind: 'add', label: input });
    }
    case 'rename': {
      const account = mode.account!;
      const label = input.trim();
      if (label === '') return stayOpen(state, mode, 'Type a label first, or Esc to cancel.');
      // Refused here rather than by the vault a moment later: the prompt stays open, so a second
      // Enter cannot reach the account list.
      const taken = labelTaken(state, label, account.id);
      if (taken !== undefined) return stayOpen(state, mode, taken);
      return start(
        browse,
        `Renaming ${account.label}...`,
        { kind: 'rename', id: account.id, from: account.label, to: input },
        mode,
      );
    }
    case 'remove': {
      const account = mode.account!;
      // The label typed in full, exactly: a removal deletes the stored login, so it is never one
      // stray key away. The label is the account's current one (see followPrompt).
      if (input !== account.label) {
        return stayOpen(
          state,
          mode,
          `Not removed: the label typed was not ${account.label}. Fix it, or Esc to cancel.`,
        );
      }
      return start(
        browse,
        `Removing ${account.label}...`,
        { kind: 'remove', id: account.id, label: account.label },
        mode,
      );
    }
  }
}
