// Non-destructively wires our three hooks into a Claude Code profile's `settings.json`.
//
// `settings.json` is the CLI's own config file — it can carry hooks other tools installed,
// plus unrelated keys (theme, permissions, etc.) that this module has no business touching.
// The merge is therefore read-modify-write and additive only: every unrecognized key, and
// every hook entry that isn't recognizably ours, is round-tripped byte-for-byte-equivalent
// (same JSON values; `JSON.parse`+`JSON.stringify` does not guarantee identical key ORDER,
// which is why this is "preserve values", not "preserve the file verbatim").
//
// Idempotent + self-healing: running `installHooks` again never duplicates an entry, and if
// our own hook state was left malformed by e.g. a manual edit or a partial write, the next
// call coalesces it back to canonical form rather than erroring or piling on a duplicate.
//
// WET-GATED: the exact `settings.json` hooks schema (event names, matcher semantics, the
// installed CLI version's exact expectations) is reverse-engineered — see docs/VERIFICATION.md.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_HOOK_EVENT_NAMES } from './hookReceiver.js';

/** Write via temp-then-rename in the same directory so a crash mid-write can never leave
 *  `settings.json` half-written — a reader sees either the whole old file or the whole new
 *  one. switch-engine has the same helper, but it's package-internal (not part of its public
 *  surface); duplicating six lines here is cheaper than depending on another package's
 *  private module. */
async function atomicWriteFile(target: string, data: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One hook we want installed: which event fires it, an optional tool matcher, and the
 *  shell command Claude Code should run. */
export interface HookCommandSpec {
  event: string;
  matcher?: string;
  command: string;
}

interface HookEntry {
  type: 'command';
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

/** A record with arbitrary extra keys we must preserve when rewriting. */
type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookEntry(value: unknown): value is HookEntry {
  return isRecord(value) && value.type === 'command' && typeof value.command === 'string';
}

function isHookGroup(value: unknown): value is HookGroup {
  return (
    isRecord(value) &&
    Array.isArray(value.hooks) &&
    (value.matcher === undefined || typeof value.matcher === 'string')
  );
}

// ---------------------------------------------------------------------------
// installHooks
// ---------------------------------------------------------------------------

export interface InstallHooksOptions {
  settingsPath: string;
  hooks: HookCommandSpec[];
}

export async function installHooks(options: InstallHooksOptions): Promise<void> {
  const settings = await readSettings(options.settingsPath);

  // Self-healing: an unrecognizable `hooks` value (missing, null, a string, ...) is replaced
  // with a fresh object rather than erroring — the rest of the file is untouched either way.
  const hooksSection: JsonObject = isRecord(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooksSection;

  for (const spec of options.hooks) {
    mergeOneHook(hooksSection, spec);
  }

  await atomicWriteFile(options.settingsPath, JSON.stringify(settings, null, 2));
}

/** Merge one hook spec into `hooksSection[event]`, preserving every well-formed group/entry
 *  already there and adding ours only if an equivalent one isn't already present. */
function mergeOneHook(hooksSection: JsonObject, spec: HookCommandSpec): void {
  const existingForEvent = hooksSection[spec.event];
  // Self-healing: a malformed (non-array) value for this event is replaced, not preserved —
  // there is nothing safe to keep from it.
  const groups: unknown[] = Array.isArray(existingForEvent) ? existingForEvent : [];

  let targetGroup = groups.find(
    (g): g is HookGroup => isHookGroup(g) && g.matcher === spec.matcher,
  );
  if (!targetGroup) {
    targetGroup = { hooks: [], ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}) };
    groups.push(targetGroup);
  }

  // Only well-formed entries are checked for a duplicate — a malformed one can't be trusted
  // to mean "already installed", so we'd rather add ours than silently skip it.
  const alreadyPresent = targetGroup.hooks.some(
    (h) => isHookEntry(h) && h.command === spec.command,
  );
  if (!alreadyPresent) {
    targetGroup.hooks.push({ type: 'command', command: spec.command });
  }

  hooksSection[spec.event] = groups;
}

async function readSettings(path: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt settings.json is not ours to repair wholesale — refuse rather than silently
    // discard whatever the user had. installHooks is meant to be additive, never destructive.
    throw new Error(`settings.json at "${path}" is not valid JSON; refusing to overwrite it`);
  }
  return isRecord(parsed) ? parsed : {};
}

// ---------------------------------------------------------------------------
// Building the daemon's own three hook specs
// ---------------------------------------------------------------------------

export interface BuildDaemonHookSpecsOptions {
  /** Loopback port `hookReceiver` is listening on. */
  port: number;
  /** Shared secret `hookReceiver` requires (see hookReceiver.ts `secretHeader`). */
  secret: string;
  eventNames?: typeof DEFAULT_HOOK_EVENT_NAMES;
  /** Header name the receiver expects the secret on; must match `HookReceiverOptions.secretHeader`. */
  secretHeader?: string;
}

/**
 * The three hook specs the daemon needs on every profile it manages: forward the CLI's hook
 * JSON (fed on stdin, per Claude Code's hook contract) as an HTTP POST to the loopback
 * receiver. Kept as a small, readable curl one-liner so a user inspecting settings.json can
 * see exactly what runs.
 */
export function buildDaemonHookSpecs(options: BuildDaemonHookSpecsOptions): HookCommandSpec[] {
  const eventNames = options.eventNames ?? DEFAULT_HOOK_EVENT_NAMES;
  const secretHeader = options.secretHeader ?? 'x-claude-control-secret';
  const url = `http://127.0.0.1:${options.port}/`;
  const command = `curl -s -X POST -H "content-type: application/json" -H "${secretHeader}: ${options.secret}" --data-binary @- ${url}`;
  return [
    { event: eventNames.permissionRequest, command },
    { event: eventNames.stop, command },
    { event: eventNames.notification, command },
  ];
}
