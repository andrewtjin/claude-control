// Claude Code "managed settings" — the administrator-scoped configuration that admits cctl's
// plugin as a channel.
//
// Channels are how a message from the phone reaches a session that is sitting idle at its
// prompt; nothing else can do that. Claude Code only loads a channel whose plugin is on an
// approved list, and that list is an administrator setting a user cannot override. So enabling
// cctl's channel means writing one administrator-scoped file, which needs elevation once.
//
// We write into the `managed-settings.d/` DROP-IN DIRECTORY, never into `managed-settings.json`.
// Claude Code reads the base file first, then every non-dotted `*.json` in the drop-in directory
// in sorted filename order, merging each over the last. Owning a separate file means cctl can
// install, diff, and uninstall its own policy without ever parsing or rewriting a file some
// other administrator owns.
//
// Everything here takes its target directory and its command runner as parameters so the whole
// module unit-tests against a temp directory with no elevation and no real system path.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { decodePowerShellStderr, type PowerShellRunner } from './daemonInstall.js';

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/**
 * The directory Claude Code reads administrator-scoped settings from. These three constants are
 * the CLI's own, read out of the shipped binary rather than guessed — an earlier attempt at this
 * used `C:\ProgramData\ClaudeCode`, which the CLI never reads, and the resulting "managed
 * settings don't work" conclusion was wrong for a whole planning cycle.
 */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    default:
      return '/etc/claude-code';
  }
}

/** The drop-in directory. Claude Code merges every non-dotted `*.json` here, sorted by name. */
export function managedDropInDir(platform: NodeJS.Platform = process.platform): string {
  return join(managedSettingsDir(platform), 'managed-settings.d');
}

/** cctl's own drop-in file. The name is stable and obviously ours: an administrator reading the
 *  directory should be able to tell at a glance who put it there and what to delete to undo it. */
export const CCTL_DROP_IN_FILENAME = 'claude-control-channels.json';

export function cctlDropInPath(platform: NodeJS.Platform = process.platform): string {
  return join(managedDropInDir(platform), CCTL_DROP_IN_FILENAME);
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface ChannelPluginRef {
  marketplace: string;
  plugin: string;
}

export interface CctlManagedSettings {
  channelsEnabled: boolean;
  allowedChannelPlugins: ChannelPluginRef[];
}

/** cctl's plugin, as Claude Code addresses it: `plugin:<plugin>@<marketplace>`. */
export const CCTL_CHANNEL_PLUGIN: ChannelPluginRef = {
  marketplace: 'claude-control',
  plugin: 'cctl',
};

/**
 * Anthropic's own channel plugins.
 *
 * These are restated deliberately and MUST NOT be "cleaned up" as redundant. `allowedChannelPlugins`
 * REPLACES the CLI's built-in list rather than extending it, so a file naming only cctl would
 * disable discord/telegram/fakechat/imessage for every session on the machine — a side effect the
 * operator never asked for and would have no obvious way to diagnose.
 */
export const OFFICIAL_CHANNEL_PLUGINS: readonly ChannelPluginRef[] = [
  { marketplace: 'claude-plugins-official', plugin: 'discord' },
  { marketplace: 'claude-plugins-official', plugin: 'telegram' },
  { marketplace: 'claude-plugins-official', plugin: 'fakechat' },
  { marketplace: 'claude-plugins-official', plugin: 'imessage' },
];

/** The exact content cctl writes. Pure, so the diff shown to the operator and the bytes written
 *  can never drift apart. */
export function buildCctlManagedSettings(): CctlManagedSettings {
  return {
    channelsEnabled: true,
    allowedChannelPlugins: [...OFFICIAL_CHANNEL_PLUGINS, CCTL_CHANNEL_PLUGIN],
  };
}

/** One canonical serialization, so "identical content" is a byte comparison rather than a deep
 *  equality guess, and so an unchanged re-run is provably a no-op. */
export function serializeCctlManagedSettings(settings: CctlManagedSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Read + diff
// ---------------------------------------------------------------------------

/** Current on-disk content of cctl's drop-in, or `undefined` when absent. A malformed file is
 *  reported as present-but-unparseable rather than treated as absent: overwriting something we
 *  could not read is exactly the case that deserves an explicit operator decision. */
export async function readCctlDropIn(
  path: string,
): Promise<{ present: boolean; text?: string; parsed?: unknown; parseError?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
    throw err;
  }
  try {
    return { present: true, text, parsed: JSON.parse(text) };
  } catch (err) {
    return { present: true, text, parseError: err instanceof Error ? err.message : String(err) };
  }
}

export interface DropInDiff {
  /** False when the file already says exactly what we want — the caller writes nothing. */
  changed: boolean;
  action: 'create' | 'update' | 'none';
  currentText?: string;
  desiredText: string;
  /** Plugins our write would add relative to what is on disk, for a readable summary. */
  addedPlugins: ChannelPluginRef[];
  /** Plugins on disk that our write would drop. Non-empty means we are about to remove someone
   *  else's entry, which the operator must see before consenting. */
  removedPlugins: ChannelPluginRef[];
  /** Set when the existing file could not be parsed; the caller should surface it loudly. */
  parseError?: string;
}

/**
 * The exact text an operator must see before consenting to this file: where it goes, the whole
 * JSON verbatim, and every warning about what the write would take away.
 *
 * One renderer, shared by every caller that asks for the write — `cctl channel enable` and the
 * setup wizard's channel step. Two renderings would eventually disagree about what "showing the
 * file" means, and the one that showed less would be the one asking for administrator rights.
 */
export function renderCctlDropInPlan(path: string, diff: DropInDiff): string {
  let out =
    `${diff.action === 'create' ? 'Create' : 'Update'}: ${path}\n\n` + `${diff.desiredText}\n`;
  if (diff.parseError !== undefined) {
    out += `warning: the existing file is not valid JSON (${diff.parseError}); it will be replaced.\n`;
  }
  if (diff.removedPlugins.length > 0) {
    out += `warning: this removes ${diff.removedPlugins
      .map((r) => `${r.plugin}@${r.marketplace}`)
      .join(', ')} from the approved list.\n`;
  }
  return out;
}

const pluginKey = (p: ChannelPluginRef): string => `${p.marketplace}/${p.plugin}`;

function pluginsOf(parsed: unknown): ChannelPluginRef[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const raw = (parsed as { allowedChannelPlugins?: unknown }).allowedChannelPlugins;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { marketplace, plugin } = entry as Record<string, unknown>;
    if (typeof marketplace !== 'string' || typeof plugin !== 'string') return [];
    return [{ marketplace, plugin }];
  });
}

/** Describe what a write would change, structurally. The caller renders it; a policy file the
 *  user cannot override must never be written without showing exactly what it does. */
export function diffCctlDropIn(
  current: { present: boolean; text?: string; parsed?: unknown; parseError?: string },
  desired: CctlManagedSettings = buildCctlManagedSettings(),
): DropInDiff {
  const desiredText = serializeCctlManagedSettings(desired);
  const desiredPlugins = desired.allowedChannelPlugins;
  const currentPlugins = pluginsOf(current.parsed);
  const desiredKeys = new Set(desiredPlugins.map(pluginKey));
  const currentKeys = new Set(currentPlugins.map(pluginKey));

  if (!current.present) {
    return {
      changed: true,
      action: 'create',
      desiredText,
      addedPlugins: desiredPlugins,
      removedPlugins: [],
    };
  }
  const identical = current.parseError === undefined && current.text === desiredText;
  return {
    changed: !identical,
    action: identical ? 'none' : 'update',
    ...(current.text !== undefined ? { currentText: current.text } : {}),
    desiredText,
    addedPlugins: desiredPlugins.filter((p) => !currentKeys.has(pluginKey(p))),
    removedPlugins: currentPlugins.filter((p) => !desiredKeys.has(pluginKey(p))),
    ...(current.parseError !== undefined ? { parseError: current.parseError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Write (unprivileged path)
// ---------------------------------------------------------------------------

export type WriteOutcome = 'written' | 'unchanged';

/** Temp-then-rename within the target directory, so a crash mid-write can never leave a policy
 *  file half-parsed. Same reasoning as hookInstaller's writer. */
async function atomicWriteFile(target: string, data: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, data, 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Write cctl's drop-in directly. Only succeeds where the process already has rights to the
 * managed directory (a developer running elevated, or a non-Windows box where the operator ran
 * cctl under sudo). Idempotent: identical content is reported, not rewritten.
 */
export async function writeCctlDropIn(options: {
  path?: string;
  platform?: NodeJS.Platform;
  settings?: CctlManagedSettings;
}): Promise<{ outcome: WriteOutcome; path: string; diff: DropInDiff }> {
  const path = options.path ?? cctlDropInPath(options.platform);
  const settings = options.settings ?? buildCctlManagedSettings();
  const current = await readCctlDropIn(path);
  const diff = diffCctlDropIn(current, settings);
  if (!diff.changed) return { outcome: 'unchanged', path, diff };
  await atomicWriteFile(path, diff.desiredText);
  return { outcome: 'written', path, diff };
}

/** Symmetric uninstall. Reports `'none'` when our file was never there — never claims a removal
 *  that did not happen, and never touches the base `managed-settings.json`. */
export async function removeCctlDropIn(options: {
  path?: string;
  platform?: NodeJS.Platform;
}): Promise<{ outcome: 'removed' | 'none'; path: string }> {
  const path = options.path ?? cctlDropInPath(options.platform);
  try {
    await unlink(path);
    return { outcome: 'removed', path };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'none', path };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Can we write without elevation?
// ---------------------------------------------------------------------------

/**
 * Probe by actually trying to write, then cleaning up.
 *
 * Deliberately empirical: a group-membership check answers "is this user an administrator",
 * which is a different question from "can this process write here right now" — UAC filtering
 * means an administrator's normal shell holds a restricted token and cannot. Asking the
 * filesystem is the only answer that is true for the process that will do the writing.
 */
export async function canWriteManagedDir(dir: string): Promise<boolean> {
  const probe = join(dir, `.cctl-write-probe-${process.pid}-${Date.now()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '', 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Write (elevated path)
// ---------------------------------------------------------------------------

export type ElevatedOutcome = 'written' | 'unchanged' | 'declined' | 'unsupported';

export interface ElevatedWriteResult {
  outcome: ElevatedOutcome;
  path: string;
  diff: DropInDiff;
  /** For platforms we do not elevate on, the command the operator should run themselves. */
  manualCommand?: string;
  error?: string;
}

/** Escape a value for a PowerShell single-quoted literal. */
function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The script the ELEVATED process runs. It copies an already-staged file into place; the settings
 * content itself never appears on a command line, where quoting could corrupt it and where it
 * would be visible to anything enumerating processes.
 */
export function elevatedCopyScript(stagedPath: string, targetPath: string): string {
  const dir = dirname(targetPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = '${psSingleQuote(dir)}'`,
    `$target = '${psSingleQuote(targetPath)}'`,
    `$staged = '${psSingleQuote(stagedPath)}'`,
    'if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }',
    "$tmp = Join-Path $dir ('.tmp-cctl-' + [guid]::NewGuid().ToString('N'))",
    'Copy-Item -LiteralPath $staged -Destination $tmp -Force',
    'Move-Item -LiteralPath $tmp -Destination $target -Force',
  ].join('\n');
}

/**
 * The script the UNPRIVILEGED process runs: it asks Windows to re-launch PowerShell elevated,
 * which is what raises the consent dialog. `-Wait -PassThru` lets us distinguish three outcomes
 * the operator experiences very differently — it worked, the elevated write itself failed, or
 * the operator dismissed the prompt.
 */
export function elevatedLaunchScript(innerScript: string): string {
  const encoded = encodeCommand(innerScript);
  return [
    'try {',
    "  $p = Start-Process -FilePath 'powershell.exe' " +
      `-ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') ` +
      '-Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop',
    '  if ($p.ExitCode -ne 0) { Write-Error "cctl-elevated-write-failed exit=$($p.ExitCode)"; exit 1 }',
    "  Write-Output 'cctl-elevated-ok'",
    '} catch {',
    '  Write-Error "cctl-elevation-declined $($_.Exception.Message)"',
    '  exit 2',
    '}',
  ].join('\n');
}

/** Recognizes the operator dismissing the consent dialog, which Windows surfaces as a cancelled
 *  operation rather than an access error. Declining is a choice, not a fault, and the caller
 *  renders it differently. */
function looksDeclined(message: string): boolean {
  return (
    /cctl-elevation-declined/i.test(message) ||
    /operation was canceled by the user/i.test(message) ||
    /The operation was cancell?ed/i.test(message)
  );
}

/**
 * Write cctl's drop-in with elevation.
 *
 * Windows raises one consent dialog and, if accepted, the file is in place for good — no dialog
 * on any later session. On macOS and Linux we deliberately do not try to escalate: a CLI that
 * silently invokes `sudo` is worse behaved than one that hands the operator the exact command.
 */
export async function writeCctlDropInElevated(options: {
  path?: string;
  platform?: NodeJS.Platform;
  settings?: CctlManagedSettings;
  runPowerShell?: PowerShellRunner;
  /** Directory for the staged copy. Injected by tests; production uses the OS temp dir. */
  stageDir?: string;
}): Promise<ElevatedWriteResult> {
  const platform = options.platform ?? process.platform;
  const path = options.path ?? cctlDropInPath(platform);
  const settings = options.settings ?? buildCctlManagedSettings();
  const current = await readCctlDropIn(path).catch(() => ({ present: false }) as const);
  const diff = diffCctlDropIn(current, settings);
  if (!diff.changed) return { outcome: 'unchanged', path, diff };

  if (platform !== 'win32') {
    // `tee` reads the content on stdin, so the operator can paste one line without the JSON
    // having to survive shell quoting.
    const manualCommand = `sudo mkdir -p '${dirname(path)}' && sudo tee '${path}' > /dev/null`;
    return { outcome: 'unsupported', path, diff, manualCommand };
  }

  const runner = options.runPowerShell ?? defaultElevationRunner;
  const stageRoot = options.stageDir ?? (await mkdtemp(join(tmpdir(), 'cctl-managed-')));
  const staged = join(stageRoot, CCTL_DROP_IN_FILENAME);
  try {
    await mkdir(stageRoot, { recursive: true });
    await writeFile(staged, diff.desiredText, 'utf8');
    runner(elevatedLaunchScript(elevatedCopyScript(staged, path)));
    return { outcome: 'written', path, diff };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: looksDeclined(message) ? 'declined' : 'unchanged',
      path,
      diff,
      error: message,
    };
  } finally {
    if (options.stageDir === undefined) await rm(stageRoot, { recursive: true, force: true });
  }
}

/**
 * Production runner for the elevation launcher.
 *
 * Distinct from daemonInstall's runner in one way that matters: `-NonInteractive` is NOT passed
 * to the outer shell, because the consent dialog is precisely the interaction we are asking for.
 */
const defaultElevationRunner: PowerShellRunner = (script) => {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-EncodedCommand', encodeCommand(script)],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const raw =
      typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
    const decoded = decodePowerShellStderr(raw);
    throw new Error(decoded.length > 0 ? decoded : String((err as Error).message), { cause: err });
  }
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ManagedSettingsStatus {
  /** Our drop-in exists and names cctl's plugin. */
  effective: boolean;
  path: string;
  /** True when the file is there but no longer lists cctl — e.g. hand-edited. */
  presentButStale: boolean;
  detail: string;
}

/**
 * Read back what is actually on disk and report whether cctl's channel is admitted.
 *
 * Reads the file rather than inspecting Claude Code's startup banner on purpose: the banner is
 * rendered before MCP servers connect and has been observed reporting a channel as unconfigured
 * in a session where that same channel then delivered perfectly. It is unreliable in both
 * directions and must never be used as evidence.
 */
export async function verifyManagedSettingsEffective(options: {
  path?: string;
  platform?: NodeJS.Platform;
}): Promise<ManagedSettingsStatus> {
  const path = options.path ?? cctlDropInPath(options.platform);
  const current = await readCctlDropIn(path);
  if (!current.present) {
    return { effective: false, path, presentButStale: false, detail: `${path} not present` };
  }
  if (current.parseError !== undefined) {
    return {
      effective: false,
      path,
      presentButStale: true,
      detail: `${path} is not valid JSON (${current.parseError})`,
    };
  }
  const listed = pluginsOf(current.parsed).some(
    (p) => pluginKey(p) === pluginKey(CCTL_CHANNEL_PLUGIN),
  );
  return {
    effective: listed,
    path,
    presentButStale: !listed,
    detail: listed
      ? `${CCTL_CHANNEL_PLUGIN.plugin}@${CCTL_CHANNEL_PLUGIN.marketplace} is allowed`
      : `${path} exists but does not list ${CCTL_CHANNEL_PLUGIN.plugin}@${CCTL_CHANNEL_PLUGIN.marketplace}`,
  };
}
