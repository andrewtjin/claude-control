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

/** The selected account: the one with `selectedId`, else the first. */
export function selectedAccount(state: TuiState): TuiAccount | undefined {
  const accounts = accountsOf(state);
  return accounts.find((a) => a.id === state.selectedId) ?? accounts[0];
}

/** Take a fresh read. The selection stays on its account while that account exists; when it is
 *  gone (removed here or elsewhere) it moves to the first. */
export function applySnapshot(state: TuiState, snapshot: TuiSnapshot): TuiState {
  const accounts = snapshot.accounts.ok ? snapshot.accounts.value : [];
  const kept = accounts.some((a) => a.id === state.selectedId) ? state.selectedId : accounts[0]?.id;
  const next: TuiState = { ...state, snapshot, nowMs: snapshot.readAtMs };
  delete next.loadError;
  if (kept === undefined) delete next.selectedId;
  else next.selectedId = kept;
  return next;
}

/** A read that failed: the last good picture stays, and the failure is said. */
export function applyLoadError(state: TuiState, message: string): TuiState {
  return { ...state, loadError: message };
}

/** Say something on the status line. */
export function withStatus(state: TuiState, text: string, tone: TuiStatus['tone']): TuiState {
  return { ...state, status: { text, tone } };
}

/** How an action the runtime ran ended: its own words on success, the refusal's on a refusal.
 *  Clears `busy`. */
export function settleAction(
  state: TuiState,
  outcome: { ok: true; message: string } | { ok: false; message: string },
): TuiState {
  const next = withStatus(state, outcome.message, outcome.ok ? 'ok' : 'error');
  delete next.busy;
  return next;
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

/** Move the selection by `delta` rows, stopping at either end. */
function moveSelection(state: TuiState, delta: number): TuiState {
  const accounts = accountsOf(state);
  if (accounts.length === 0) return state;
  const current = Math.max(
    0,
    accounts.findIndex((a) => a.id === selectedAccount(state)?.id),
  );
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

/** Mark `state` busy with `what` and hand `effect` to the runtime. */
function start(state: TuiState, what: string, effect: Effect): Transition {
  return { state: { ...state, busy: what }, effect };
}

/**
 * What one key does.
 *
 * Ctrl-C quits from anywhere; while an action runs it quits once the action ends (a switch cut off
 * half way would leave its recovery to the next command), and a second Ctrl-C quits at once.
 * Overlays (help, the launch line) close on any key. A prompt takes text until Enter or Escape.
 * Otherwise the key map applies, with the account verbs answering only in the Accounts pane.
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
  if (mode.kind === 'help' || mode.kind === 'launch') {
    return { state: { ...state, mode: { kind: 'browse' } } };
  }
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
      return { state: { ...state, mode: { kind: 'help' } } };
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
  if (account === undefined) {
    return { state: withStatus(state, `There is no account to ${what}.`, 'info') };
  }
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

/** A key while a prompt is open. */
function reducePrompt(
  state: TuiState,
  mode: Extract<TuiState['mode'], { kind: 'prompt' }>,
  key: Key,
): Transition {
  const browse: TuiState = { ...state, mode: { kind: 'browse' } };
  switch (key.name) {
    case 'escape':
      return { state: withStatus(browse, 'Cancelled.', 'info') };
    case 'backspace': {
      const chars = [...mode.input];
      chars.pop();
      return { state: { ...state, mode: { ...mode, input: chars.join('') } } };
    }
    case 'char': {
      if ([...mode.input].length >= MAX_INPUT) return { state };
      return { state: { ...state, mode: { ...mode, input: mode.input + key.char } } };
    }
    case 'enter':
      return submitPrompt(browse, mode);
    default:
      return { state };
  }
}

/** Enter in a prompt: the action it was asking for, or why not. */
function submitPrompt(
  state: TuiState,
  mode: Extract<TuiState['mode'], { kind: 'prompt' }>,
): Transition {
  const input = mode.input;
  switch (mode.purpose) {
    case 'add':
      if (input.trim() === '')
        return { state: withStatus(state, 'Cancelled: no label given.', 'info') };
      return start(state, `Adding ${input.trim()}...`, { kind: 'add', label: input });
    case 'rename': {
      const account = mode.account!;
      if (input.trim() === '')
        return { state: withStatus(state, 'Cancelled: no label given.', 'info') };
      return start(state, `Renaming ${account.label}...`, {
        kind: 'rename',
        id: account.id,
        from: account.label,
        to: input,
      });
    }
    case 'remove': {
      const account = mode.account!;
      // The label typed in full, exactly: a removal deletes the stored login, so it is never one
      // stray key away.
      if (input !== account.label) {
        return {
          state: withStatus(
            state,
            `Not removed: the label typed was not ${account.label}.`,
            'warn',
          ),
        };
      }
      return start(state, `Removing ${account.label}...`, {
        kind: 'remove',
        id: account.id,
        label: account.label,
      });
    }
  }
}
