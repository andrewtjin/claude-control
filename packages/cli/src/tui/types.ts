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
  /** Why the usage numbers (the daemon's database) could not be read, when they could not. The
   *  accounts themselves come from the vault and are listed either way, without usage. */
  usageError?: string;
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
  /** Remove the account, refused when it no longer has `label`, the label the person typed to
   *  confirm the removal. */
  removeAccount(id: string, label: string): Promise<TuiActionResult>;
  /** Log a NEW account in, in a window that owns the terminal while it runs: the caller must have
   *  stepped its own screen aside first. `onStored` is told as soon as the account is stored,
   *  before the add's own cleanup (which can take seconds), so the caller can take the terminal
   *  back then rather than leave the person looking at a screen that seems hung. */
  addAccount(label: string, onStored?: (message: string) => void): Promise<TuiActionResult>;
  /** Ask the running daemon to refresh every account's usage now. */
  repoll(): Promise<UsageRepollResult>;
  /** Let go of anything held open between reads (the database connection). */
  close?(): void;
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
  /** `scroll`: how many lines of the key table are scrolled off the top, for a short terminal. */
  | { kind: 'help'; scroll: number }
  /** The last message in full, for one longer than the status line has room for; `scroll` as
   *  for help. */
  | { kind: 'message'; scroll: number }
  | { kind: 'launch'; label: string }
  | TuiPrompt;

/** A prompt taking text until Enter or Escape. */
export interface TuiPrompt {
  kind: 'prompt';
  purpose: PromptPurpose;
  /** The account the prompt is about (rename, remove); absent for an add. */
  account?: { id: string; label: string };
  input: string;
  /** Why the last Enter did not go through (an empty label, a mistyped confirmation, a refusal),
   *  shown with the prompt, which stays open so the input can be fixed. */
  note?: string;
  /** The account was removed while the prompt was open: it takes no input and starts nothing,
   *  and only Escape closes it. Closing it at once would hand the rest of what the person was
   *  typing, and the Enter meant for the prompt, to the account list. */
  gone?: true;
}

/** How a status line reads. */
export type TuiTone = 'info' | 'ok' | 'warn' | 'error';

/** The message under the body. */
export interface TuiStatus {
  text: string;
  tone: TuiTone;
  /** Only true until the next read lands (a message about the read itself), then dropped. */
  untilRead?: boolean;
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
  /** The prompt the running action was started from: opened again, with the refusal as its note,
   *  when the action is refused, so the Enter that follows a quick refusal goes to the prompt and
   *  not to the account list. */
  reopenOnRefusal?: TuiPrompt;
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
  | { name: 'char'; char: string }
  /** A block the terminal marked as pasted: text to type into a prompt, never key commands. */
  | { name: 'paste'; text: string };

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
