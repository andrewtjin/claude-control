// `cctl setup` — the guided first-run wizard.
//
// This file is the wizard's ORCHESTRATION: step order, the honest copy, idempotent re-entry
// driven by real on-disk state (never a progress file that can drift), the pause-not-exit
// behavior when no one is logged in, the input normalization for pairing codes, and the
// wizard-owned timeout around pairing (because `ControlPlaneClient.connect()` reconnects
// forever and never rejects on an unreachable relay). Every side-effecting subsystem is behind
// the injected `SetupDeps` interface, so this logic is unit-tested against fakes while the
// production assembly (real engine, real hooks, real Scheduled Task, real relay socket) lives
// in program.ts and is exercised on-machine — the same composition-root split daemonRun.ts uses.

import type { StoredAccount } from '@claude-control/switch-engine';
import { renderDoctor, summarize, type DoctorCheck, type RelayProbe } from './doctor.js';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

// ---------------------------------------------------------------------------
// The wizard's IO surface
// ---------------------------------------------------------------------------

/** Terminal IO the wizard talks through. `ask` prints its own prompt and resolves with the
 *  user's raw line (empty string on a bare Enter). Injected so tests drive the wizard with a
 *  scripted set of answers and capture everything it wrote. */
export interface WizardIo {
  write(text: string): void;
  ask(prompt: string): Promise<string>;
  /** True only for a real interactive terminal (both stdin and stdout are TTYs). */
  isInteractive: boolean;
  palette: Palette;
}

// ---------------------------------------------------------------------------
// Subsystem seam
// ---------------------------------------------------------------------------

/** Outcome of a single pairing attempt. `connect()` never rejects on an unreachable relay, so
 *  `'timeout'` is a first-class result here (the wizard's own deadline fired), distinct from
 *  `'rejected'` (the relay actively refused the code) and `'error'` (anything else). */
export type PairResult =
  { ok: true } | { ok: false; reason: 'timeout' | 'rejected' | 'error'; detail: string };

/** Result of registering + kicking the autostart task. `task` mirrors the Scheduled Task
 *  register outcome; `started` is best-effort (a failure to start now still leaves the task
 *  correctly registered for the next logon). */
export interface AutostartResult {
  task: 'created' | 'updated' | 'unchanged';
  started: boolean;
  detail?: string;
}

/**
 * Everything the wizard needs from the outside world. Each member is either a pure-ish reader
 * of real on-disk state (for idempotent re-entry) or an action; the wizard never touches the
 * filesystem, network, or child processes directly.
 */
export interface SetupDeps {
  io: WizardIo;

  /** The environment checks rendered in step 1. */
  runDoctor(): Promise<DoctorCheck[]>;

  /** Whether a live Claude login exists right now (drives the pause-and-retry in step 2). */
  isLoggedIn(): Promise<boolean>;

  /** Accounts already in the vault — the idempotency signal for capture. */
  listAccounts(): Promise<StoredAccount[]>;
  /** Capture the currently logged-in account under `label`. */
  captureCurrentLogin(label: string): Promise<StoredAccount>;
  /** The `--fresh` capture flow (throwaway login window) for additional accounts. */
  addFreshAccount(label: string): Promise<void>;

  /** Whether our managed hooks are already present in the profile's settings.json. */
  hooksInstalled(): Promise<boolean>;
  /** The settings.json the daemon installs hooks into — reported to the user. */
  hooksProfilePath: string;

  /** The relay URL in effect (default, env, or a value the caller resolved from a flag). */
  relayUrl: string;
  /** Probe the relay's health endpoint (step 5). */
  probeRelay(url: string): Promise<RelayProbe>;

  /** Whether a daemon identity is already persisted and decrypts (already paired). */
  isPaired(): Promise<boolean>;
  /** Attempt pairing with an already-normalized code. MUST resolve within its own timeout. */
  pair(code: string): Promise<PairResult>;

  /** Whether the logon Scheduled Task is registered. */
  taskRegistered(): Promise<boolean>;
  /** Register/update the logon task and start it now (best-effort). */
  installAutostart(): Promise<AutostartResult>;
  /** Whether the daemon is now actually up (heartbeat alive) — the round-trip check. */
  verifyDaemon(): Promise<boolean>;
}

export interface SetupOptions {
  /** Force the full walk even when everything is already set up. */
  reconfigure?: boolean;
}

/** What the wizard ended up doing — program.ts maps a non-success outcome to a non-zero exit. */
export type SetupOutcome = 'completed' | 'already-set-up' | 'not-interactive';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Normalize a pasted pairing code: drop surrounding/internal whitespace and dashes and
 *  lower-case it, so "AB-CD 12" and "abcd12" pair identically. Pure. */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toLowerCase();
}

/** Whether a prompt answer is an affirmative (default is always No, so only an explicit yes
 *  counts). Pure. */
export function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/** Whether the user asked to skip pairing. Recognized before code normalization so a lone
 *  `s`/`skip` is never mistaken for a (very short) code. Pure. */
export function isSkip(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 's' || a === 'skip';
}

// ---------------------------------------------------------------------------
// Wizard-owned pairing timeout
// ---------------------------------------------------------------------------

/** A cancelable timer, injected so the timeout is tested without real time passing. */
export interface WizardTimer {
  clear(): void;
}
export type SetWizardTimer = (fn: () => void, ms: number) => WizardTimer;

const realTimer: SetWizardTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return { clear: () => clearTimeout(handle) };
};

/** The connect surface the timeout wraps: `connect()` resolves once the connection is fully
 *  live (pairing adopted + hello ok) and rejects only on a terminal refusal; it may also never
 *  settle at all on an unreachable relay (it reconnects forever). `close()` stops it. */
export interface ConnectHandle {
  connect(): Promise<void>;
  close(): void;
}

/** How long the wizard waits for pairing before giving up on its own — `connect()` will not,
 *  so this deadline is the only thing that turns an unreachable relay into an actionable error
 *  instead of a silent hang. */
export const PAIRING_TIMEOUT_MS = 15_000;

/**
 * Race `handle.connect()` against a deadline. On success → `{ ok: true }`. On the deadline
 * firing first → `close()` the (still-reconnecting) handle and report `'timeout'`. On a
 * terminal rejection → `close()` and report `'rejected'`. Whichever happens first wins and the
 * loser is neutralized, so there is no dangling connection or late state change.
 */
export async function connectWithTimeout(
  handle: ConnectHandle,
  timeoutMs: number = PAIRING_TIMEOUT_MS,
  setTimer: SetWizardTimer = realTimer,
): Promise<PairResult> {
  return new Promise<PairResult>((resolve) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve({
        ok: false,
        reason: 'timeout',
        detail: `no response within ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    // Both outcomes are handled here, so this never surfaces as an unhandled rejection; `void`
    // marks it as deliberately not awaited (the surrounding Promise is what the caller awaits).
    void handle.connect().then(
      () => {
        if (settled) return;
        settled = true;
        timer.clear();
        resolve({ ok: true });
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        timer.clear();
        handle.close();
        resolve({ ok: false, reason: 'rejected', detail: (err as Error).message });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Status summary (shared by the wizard's success screen, `cctl status`, bare `cctl`)
// ---------------------------------------------------------------------------

export interface SetupSummary {
  accounts: { label: string; active: boolean }[];
  hooksInstalled: boolean;
  hooksProfilePath: string;
  relayUrl: string;
  taskRegistered: boolean;
  daemonAlive: boolean;
  paired: boolean;
}

/** Render the at-a-glance summary. `firstPollNote` adds the "numbers reach your phone within
 *  ~1 minute" line the success screen ends on. Pure — every value is gathered by the caller. */
export function renderSetupSummary(
  s: SetupSummary,
  palette: Palette = PLAIN_PALETTE,
  opts: { firstPollNote?: boolean } = {},
): string {
  const ok = (t: string) => `${palette.green('[ok]')} ${t}`;
  const warn = (t: string) => `${palette.yellow('[--]')} ${t}`;

  const accountsLine =
    s.accounts.length === 0
      ? warn('accounts: none captured yet')
      : ok(
          `accounts: ${s.accounts
            .map((a) => (a.active ? `${palette.bold(a.label)} (active)` : a.label))
            .join(', ')}`,
        );

  const hooksLine = s.hooksInstalled
    ? ok(`hooks: installed in ${s.hooksProfilePath}`)
    : warn(`hooks: not yet in ${s.hooksProfilePath} (installed when the daemon starts)`);

  const daemonLine = s.daemonAlive
    ? ok('daemon: running')
    : s.taskRegistered
      ? warn('daemon: not running yet — starts at logon (or: cctl daemon install)')
      : warn('daemon: no autostart registered — run: cctl daemon install');

  const pairingLine = s.paired
    ? ok('discord: paired')
    : warn('discord: local-only (not paired) — pair later: cctl setup --reconfigure');

  const lines = [
    accountsLine,
    hooksLine,
    `${palette.dim('relay:')} ${s.relayUrl}`,
    daemonLine,
    pairingLine,
  ];
  if (opts.firstPollNote && s.paired) {
    lines.push('');
    lines.push(
      palette.dim(
        'Your usage numbers reach your phone within ~1 minute (the daemon polls once a minute).',
      ),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 7;

/** Run the guided setup. Returns an outcome; all user-facing text goes through `deps.io`. */
export async function runSetup(deps: SetupDeps, options: SetupOptions = {}): Promise<SetupOutcome> {
  const { io } = deps;
  const p = io.palette;

  // TTY refusal up front: the wizard asks questions, so a pipe/CI/redirected run can only hang
  // or answer nothing. Refuse with one honest line rather than half-run.
  if (!io.isInteractive) {
    io.write(
      'error: cctl setup is interactive and needs a terminal. ' +
        'Run it directly in a console (not through a pipe, redirect, or CI).\n',
    );
    return 'not-interactive';
  }

  const step = (n: number, title: string): void =>
    io.write(`\n${p.bold(`[${n}/${TOTAL_STEPS}]`)} ${title}\n`);

  // Idempotent re-entry: read the REAL on-disk state and, if setup is already complete, print a
  // one-line summary and stop — unless --reconfigure forces the full walk. "Complete" is
  // accounts + hooks + autostart; pairing is optional (skip = a valid local-only setup), so it
  // never blocks this gate.
  const [initialAccounts, initialHooks, initialTask] = await Promise.all([
    deps.listAccounts(),
    deps.hooksInstalled(),
    deps.taskRegistered(),
  ]);
  const alreadyComplete = initialAccounts.length > 0 && initialHooks && initialTask;
  if (alreadyComplete && !options.reconfigure) {
    const paired = await deps.isPaired();
    io.write(
      `${p.green('Already set up.')} ${initialAccounts.length} account(s), hooks in ` +
        `${deps.hooksProfilePath}, autostart on, ${paired ? 'paired' : 'local-only'}.\n`,
    );
    io.write(
      `Details: ${p.bold('cctl status')}   ·   reconfigure: ${p.bold('cctl setup --reconfigure')}\n`,
    );
    return 'already-set-up';
  }

  io.write(`${p.bold('cctl setup')} — one-time setup for control from Discord.\n`);
  io.write('Every step is safe to re-run; you can stop with Ctrl+C and resume later.\n');

  // ---- [1/7] environment ----
  step(1, 'Checking your environment');
  const checks = await deps.runDoctor();
  io.write(renderDoctor(checks, p) + '\n');
  const { failed } = summarize(checks);
  if (failed > 0) {
    io.write(
      p.yellow(
        `${failed} check(s) need attention above — setup will continue, but fix them if a later step fails.\n`,
      ),
    );
  }

  // ---- [2/7] capture the current account ----
  step(2, 'Your current Claude account');
  let accounts = initialAccounts;
  if (accounts.length > 0) {
    io.write(
      `Already have ${accounts.length} account(s): ${accounts.map((a) => a.label).join(', ')}. Leaving them as-is.\n`,
    );
  } else {
    // Not logged in is a PAUSE, not an exit: the account IS the point of this step, so loop
    // until a login appears rather than bailing.
    while (!(await deps.isLoggedIn())) {
      io.write(
        'No Claude login found. In another window run `claude` and `/login`, then come back.\n',
      );
      await io.ask('Press Enter to re-check (Ctrl+C to stop): ');
    }
    const label = (await io.ask('Label for this account [default]: ')).trim() || 'default';
    const account = await deps.captureCurrentLogin(label);
    io.write(`${p.green('Captured')} ${account.label}. Your live login was not changed.\n`);
    accounts = await deps.listAccounts();
  }

  // ---- [3/7] optional additional accounts ----
  step(3, 'Add more accounts (optional)');
  io.write(
    'Add another account by logging into it in a throwaway window (your live login is untouched).\n',
  );
  for (;;) {
    const answer = await io.ask('Add another account now? [y/N]: ');
    if (!isYes(answer)) break;
    const label = (await io.ask('Label for the new account: ')).trim();
    if (!label) {
      io.write('A label is required — skipping this one.\n');
      continue;
    }
    await deps.addFreshAccount(label);
    accounts = await deps.listAccounts();
  }

  // ---- [4/7] hooks ----
  step(4, 'Usage hooks');
  if (await deps.hooksInstalled()) {
    io.write(`${p.green('Already installed')} in ${deps.hooksProfilePath}.\n`);
  } else {
    // The hook command carries the daemon's loopback port, which is only known once the daemon
    // binds it — so the daemon installs (and self-heals) hooks on every start rather than the
    // wizard writing a soon-stale entry here. Step 7 brings the daemon up; the summary confirms.
    io.write(
      `Hooks will be installed into ${deps.hooksProfilePath} when the daemon starts (step 7).\n`,
    );
  }

  // ---- [5/7] relay ----
  step(5, 'Relay');
  io.write(`Relay URL: ${p.bold(deps.relayUrl)}\n`);
  io.write(p.dim('Override with `cctl daemon run --relay <url>` or the CCTL_RELAY_URL env var.\n'));
  const probe = await deps.probeRelay(deps.relayUrl);
  io.write(
    (probe.reachable ? `${p.green('[ok]')} ` : `${p.yellow('[--]')} `) +
      probe.detail +
      (probe.reachable ? '' : ' — setup can still finish; pairing below may fail.') +
      '\n',
  );

  // ---- [6/7] pairing ----
  step(6, 'Pair with Discord');
  let paired = await deps.isPaired();
  if (paired) {
    io.write(
      `${p.green('Already paired.')} Re-pair later with \`cctl daemon run --pair <code>\`.\n`,
    );
  } else {
    io.write('In your Discord server, run `/pair` to get a one-time code.\n');
    io.write(`Enter it below, or type ${p.bold('s')} to skip and set up local-only.\n`);
    for (;;) {
      const raw = await io.ask('Pairing code (or `s` to skip): ');
      if (isSkip(raw)) {
        io.write(
          p.dim('Skipped — local-only setup. Pair anytime later: `cctl setup --reconfigure`.\n'),
        );
        break;
      }
      const code = normalizePairingCode(raw);
      if (!code) {
        io.write('That looked empty. Enter the code from `/pair`, or `s` to skip.\n');
        continue;
      }
      const result = await deps.pair(code);
      if (result.ok) {
        io.write(`${p.green('Paired.')} This machine is now bound to the bot.\n`);
        paired = true;
        break;
      }
      // Actionable, reason-specific guidance; the loop lets the user retry or skip.
      if (result.reason === 'timeout') {
        io.write(
          p.yellow(
            `Couldn't reach the relay (${result.detail}). Check a firewall/proxy, or override ` +
              'with `--relay <url>`. Try again, or `s` to skip.\n',
          ),
        );
      } else if (result.reason === 'rejected') {
        io.write(
          p.yellow(
            `The relay refused that code (${result.detail}). Codes are one-time and expire — ` +
              'run `/pair` again for a fresh one. Try again, or `s` to skip.\n',
          ),
        );
      } else {
        io.write(p.yellow(`Pairing failed (${result.detail}). Try again, or \`s\` to skip.\n`));
      }
    }
  }

  // ---- [7/7] autostart + daemon, then round-trip verify ----
  step(7, 'Autostart and start the daemon');
  // A failed registration must not kill the wizard at its final step — everything before it
  // (accounts, hooks, pairing) is already done, and the daemon runs fine without autostart.
  // Degrade to a warning with the retry path; the summary below reports the task honestly.
  let autostart: AutostartResult | undefined;
  try {
    autostart = await deps.installAutostart();
  } catch (err) {
    io.write(
      p.yellow(
        `Could not register the logon task: ${(err as Error).message}\n` +
          'The daemon still runs manually (`cctl daemon run` or `cctl daemon supervise`); ' +
          'retry autostart later with `cctl daemon install`.\n',
      ),
    );
  }
  if (autostart) {
    const taskVerb = {
      created: 'Registered',
      updated: 'Updated',
      unchanged: 'Already registered',
    }[autostart.task];
    io.write(`${taskVerb} the logon task so the daemon starts automatically.\n`);
    if (!autostart.started) {
      io.write(
        p.yellow(
          `Could not start it right now${autostart.detail ? ` (${autostart.detail})` : ''}; ` +
            'it will start at your next logon.\n',
        ),
      );
    }
  }
  const daemonAlive = await deps.verifyDaemon();
  io.write(
    daemonAlive
      ? `${p.green('Daemon is up.')}\n`
      : p.yellow('Daemon has not reported in yet — give it a moment, then run `cctl status`.\n'),
  );

  // ---- success summary ----
  const finalHooks = await deps.hooksInstalled();
  const finalTask = await deps.taskRegistered();
  io.write('\n' + p.bold('Setup complete.') + '\n');
  io.write(
    renderSetupSummary(
      {
        accounts: accounts.map((a) => ({ label: a.label, active: false })),
        hooksInstalled: finalHooks,
        hooksProfilePath: deps.hooksProfilePath,
        relayUrl: deps.relayUrl,
        taskRegistered: finalTask,
        daemonAlive,
        paired,
      },
      p,
      { firstPollNote: true },
    ) + '\n',
  );
  io.write(
    `\nNext: ${p.bold('cctl status')} · ${p.bold('cctl usage')} · ${p.bold('cctl timeline')} · ${p.bold('cctl accounts list')}\n`,
  );
  return 'completed';
}
