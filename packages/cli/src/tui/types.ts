// The full-screen view's contract: what it shows, what it can be asked to do, and the state its
// pure halves (input reducer, frame renderer) pass between them.
//
// Kept apart from every implementation so each half depends on these shapes only: the renderer
// never reads a vault, the reducer never touches a terminal, and the runtime that wires them to a
// real engine and a real TTY can be swapped for fakes in tests without either half noticing.

import type { AccountUsage } from '@claude-control/shared-protocol';
import type {
  ExhaustionEpisode,
  HeartbeatReading,
  UsageRepollResult,
} from '@claude-control/daemon';
import type { FoldersView } from '../folderRender.js';
import type { OutageStatus } from '../outagesView.js';
import type { SessionStatusHeader, SessionStatusRow } from '../sessionRender.js';

// ---------------------------------------------------------------------------
// What the view shows
// ---------------------------------------------------------------------------

/** How a tag reads: `info` is a fact (a folder), `dim` a deliberate setting (excluded), `error` a
 *  fault the person owes attention (quarantined, a failed poll). */
export type TuiTagTone = 'info' | 'dim' | 'error';

/** One short label at the end of an account row. */
export interface TuiTag {
  text: string;
  tone: TuiTagTone;
}

/** One account as the Accounts pane shows it. Everything here is read locally (the vault and the
 *  daemon's database); nothing is fetched from Anthropic for it. */
export interface TuiAccount {
  id: string;
  label: string;
  /** The plan cell, as `cctl accounts list` derives it. */
  plan: string;
  /** Live in the global slot (what a plain `claude` runs as). */
  active: boolean;
  quarantined: boolean;
  /** Barred from auto-switch hops (manual switches still work). */
  excluded: boolean;
  /** The daemon's latest snapshot, absent until it has polled this account. */
  usage?: AccountUsage;
  /** The history-derived next weekly reset, for an account whose endpoint stopped reporting one. */
  predictedResetAt?: number;
  /** Labels of the folder rules this account belongs to: included by the rule, or live in its
   *  slot. */
  folders: string[];
  /**
   * Tags other parts of cctl contribute to the row, shown after the built-in ones. This is the
   * hook for anything that holds an account outside the slots the view already knows about (a
   * terminal-scoped session slot would add its `session x2` here) without the renderer learning
   * what such a thing is.
   */
  extraTags: TuiTag[];
}

/** The daemon as the header shows it. */
export interface TuiDaemon {
  heartbeat: HeartbeatReading;
  /** Whether the running daemon reported auto-switch on; absent when no running daemon has said. */
  autoSwitch?: boolean;
}

/** What `cctl session status` shows. */
export interface TuiSessions {
  rows: SessionStatusRow[];
  header: SessionStatusHeader;
}

/** What `cctl outages` shows with no filter. */
export interface OutagesView {
  episodes: ExhaustionEpisode[];
  open: OutageStatus[];
  logPath: string;
}

/** One pane's data, or why it could not be read. Each pane degrades on its own: an unreadable
 *  exhaustion log must not blank the account list. */
export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

/** One full read of everything the view shows, taken at `readAtMs`. */
export interface TuiSnapshot {
  readAtMs: number;
  accounts: Section<TuiAccount[]>;
  daemon: TuiDaemon;
  sessions: Section<TuiSessions>;
  folders: Section<FoldersView>;
  outages: Section<OutagesView>;
}

// ---------------------------------------------------------------------------
// What the view can do
// ---------------------------------------------------------------------------

/** An action's result, in the words the matching command prints. */
export interface TuiActionResult {
  message: string;
}

/**
 * Where the view reads its data and sends its actions. Account actions take the account's id and
 * resolve it exactly as the commands do; an expected refusal is thrown as an AccountActionError
 * (the refresh: a SessionClientError) whose message is shown, and anything else is a fault that
 * ends the view.
 */
export interface TuiSources {
  load(nowMs: number): Promise<TuiSnapshot>;
  switchAccount(id: string): Promise<TuiActionResult>;
  setExcluded(id: string, excluded: boolean): Promise<TuiActionResult>;
  renameAccount(id: string, label: string): Promise<TuiActionResult>;
  removeAccount(id: string): Promise<TuiActionResult>;
  /** Log a NEW account in, in a window that owns the terminal while it runs: the caller must have
   *  stepped its own screen aside first. */
  addAccount(label: string): Promise<TuiActionResult>;
  /** Ask the running daemon to refresh every account's usage now. */
  repoll(): Promise<UsageRepollResult>;
}

// ---------------------------------------------------------------------------
// State, keys and effects
// ---------------------------------------------------------------------------

/** The panes, in the order Tab cycles them. */
export const PANES = ['accounts', 'sessions', 'folders', 'outages'] as const;
export type PaneId = (typeof PANES)[number];

/** The panes whose body is text that scrolls rather than a list that selects. */
export type TextPaneId = Exclude<PaneId, 'accounts'>;

/** What a prompt is asking for. */
export type PromptPurpose = 'rename' | 'add' | 'remove';

/** What the screen is doing: browsing a pane, or showing something over it. */
export type TuiMode =
  | { kind: 'browse' }
  | { kind: 'help' }
  | { kind: 'launch'; label: string }
  | {
      kind: 'prompt';
      purpose: PromptPurpose;
      /** The account the prompt is about (rename, remove); absent for an add. */
      account?: { id: string; label: string };
      input: string;
    };

/** How a status line reads. */
export type TuiTone = 'info' | 'ok' | 'warn' | 'error';

/** The one-line message under the body. */
export interface TuiStatus {
  text: string;
  tone: TuiTone;
}

/** Everything the screen is drawn from. Plain data, so the reducer and renderer stay pure. */
export interface TuiState {
  /** The clock every relative time on screen is measured from. */
  nowMs: number;
  /** Whose shell the launch line is quoted for. */
  platform: NodeJS.Platform;
  pane: PaneId;
  mode: TuiMode;
  /** The last successful read; absent until the first one lands. */
  snapshot?: TuiSnapshot;
  /** Why the last read failed, while it is still the latest word. */
  loadError?: string;
  /** The selected account, by id so a reorder or a removal elsewhere does not move it. */
  selectedId?: string;
  /** How far each text pane is scrolled. */
  scroll: Record<TextPaneId, number>;
  status?: TuiStatus;
  /** What is running now; while set, keys other than Ctrl-C wait. */
  busy?: string;
  /** Ctrl-C arrived while busy: quit as soon as the running action ends. */
  quitWhenIdle: boolean;
}

/** One key press, decoded from the raw input. */
export type Key =
  | {
      name:
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'pageup'
        | 'pagedown'
        | 'home'
        | 'end'
        | 'enter'
        | 'escape'
        | 'tab'
        | 'backtab'
        | 'backspace'
        | 'ctrl-c';
    }
  | { name: 'char'; char: string };

/** Something the reducer asks the runtime to do; the runtime reports back through the state. */
export type Effect =
  | { kind: 'quit' }
  | { kind: 'switch'; id: string; label: string }
  | { kind: 'exclude'; id: string; label: string; excluded: boolean }
  | { kind: 'rename'; id: string; from: string; to: string }
  | { kind: 'remove'; id: string; label: string }
  | { kind: 'add'; label: string }
  | { kind: 'refresh' };

/** What one key did: the next state, and at most one thing for the runtime to carry out. */
export interface Transition {
  state: TuiState;
  effect?: Effect;
}
