// Non-destructively wires our hooks into a Claude Code profile's `settings.json`.
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
// Exact-command dedup alone is NOT enough for that: our command has changed shape across
// releases (an earlier generation was a curl one-liner embedding an OS-assigned per-run
// port, minting a never-seen command every restart), and it still varies with the node and
// script paths — a stale generation would accumulate forever. `ownedCommandMarker` closes
// that hole — entries carrying the marker are recognizably OURS regardless of which
// generation they came from, and any that don't match a current spec are pruned before the
// merge.
//
// The exact `settings.json` hooks schema (event names, matcher semantics, the
// installed CLI version's exact expectations) is reverse-engineered — see docs/VERIFICATION.md.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_HOOK_EVENT_NAMES, DEFAULT_SECRET_HEADER } from './hookReceiver.js';

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
  /** Ownership fingerprint: a substring that appears in every command WE ever installed and
   *  in nobody else's (the daemon passes its secret-header name). When set, entries carrying
   *  it that don't exactly match a current spec are treated as stale generations of ours —
   *  same hook, dead port from a previous run — and removed before the merge. Without it,
   *  exact-command dedup can only recognize the CURRENT command, so every port rotation
   *  would append a fresh entry and leave the old one behind. Optional because the marker is
   *  meaningless for callers whose commands are stable across runs. */
  ownedCommandMarker?: string;
}

export async function installHooks(options: InstallHooksOptions): Promise<void> {
  const settings = await readSettings(options.settingsPath);

  // Self-healing: an unrecognizable `hooks` value (missing, null, a string, ...) is replaced
  // with a fresh object rather than erroring — the rest of the file is untouched either way.
  const hooksSection: JsonObject = isRecord(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooksSection;

  // Prune BEFORE merging so a stale generation of our own command (old port) is replaced,
  // not joined, by the current one. Only events we're installing into are touched.
  if (options.ownedCommandMarker !== undefined) {
    pruneStaleOwnedEntries(hooksSection, options.hooks, options.ownedCommandMarker);
  }

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

/** Remove stale generations of OUR OWN entries (marker present, command not current) from the
 *  events we're about to install into. Foreign entries — no marker — are never touched, and
 *  neither are events outside `specs`. A group this pruning empties is dropped (it existed
 *  only to hold our stale entry); a group that was ALREADY empty is someone else's state and
 *  is preserved as-is. */
function pruneStaleOwnedEntries(
  hooksSection: JsonObject,
  specs: HookCommandSpec[],
  marker: string,
): void {
  // The same event can appear in several specs, so staleness is judged against the full set
  // of current commands for that event, not just one spec's.
  const currentByEvent = new Map<string, Set<string>>();
  for (const spec of specs) {
    const set = currentByEvent.get(spec.event) ?? new Set<string>();
    set.add(spec.command);
    currentByEvent.set(spec.event, set);
  }

  for (const [event, currentCommands] of currentByEvent) {
    const groups = hooksSection[event];
    if (!Array.isArray(groups)) continue; // malformed per-event value; mergeOneHook self-heals it
    hooksSection[event] = groups.filter((group) => {
      if (!isHookGroup(group)) return true; // not recognizably a group — not ours to judge
      const countBefore = group.hooks.length;
      group.hooks = group.hooks.filter(
        (entry) => !isStaleOwnedEntry(entry, marker, currentCommands),
      );
      return group.hooks.length > 0 || group.hooks.length === countBefore;
    });
  }
}

/** An entry is a stale generation of ours when its command carries the ownership marker but
 *  isn't one of the commands being installed right now. Deliberately does NOT require
 *  `type: 'command'`: a half-written entry whose command is recognizably ours is still ours
 *  to heal away. */
function isStaleOwnedEntry(entry: unknown, marker: string, currentCommands: Set<string>): boolean {
  if (!isRecord(entry) || typeof entry.command !== 'string') return false;
  return entry.command.includes(marker) && !currentCommands.has(entry.command);
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
// Building the daemon's own hook specs
// ---------------------------------------------------------------------------

export interface BuildDaemonHookSpecsOptions {
  /** Shared secret `hookReceiver` requires (see hookReceiver.ts `secretHeader`). */
  secret: string;
  /** Absolute path of the forwarder script (see hookForwarder.ts) the command runs. */
  forwarderPath: string;
  /** Node executable to run the forwarder with. Defaults to the running process's own
   *  binary — the daemon IS Node, so its binary is known-good and needs no PATH lookup. */
  nodePath?: string;
  eventNames?: typeof DEFAULT_HOOK_EVENT_NAMES;
  /** Header name the receiver expects the secret on; must match `HookReceiverOptions.secretHeader`. */
  secretHeader?: string;
}

/**
 * The hook specs the daemon needs on every profile it manages: forward the CLI's hook
 * JSON (fed on stdin, per Claude Code's hook contract) as an HTTP POST to the loopback
 * receiver, via the forwarder script (hookForwarder.ts) so the daemon-down fast path and
 * the connect-timeout policy live in ONE place instead of five duplicated one-liners.
 * The command deliberately carries no port — the forwarder discovers the current one from
 * the endpoint file at fire time, so the installed entries (and every running session's
 * startup snapshot of them) stay valid across daemon restarts. The secret header stays on
 * the command line both as the receiver's auth and as the ownership marker `installHooks`
 * prunes stale generations by — including previous-shape curl entries, which carried the
 * same header name. PostToolUse carries no matcher on purpose: it must observe every tool
 * (the receiver decides which runs are worth forwarding, not the hook filter).
 */
export function buildDaemonHookSpecs(options: BuildDaemonHookSpecsOptions): HookCommandSpec[] {
  const eventNames = options.eventNames ?? DEFAULT_HOOK_EVENT_NAMES;
  const secretHeader = options.secretHeader ?? DEFAULT_SECRET_HEADER;
  const nodePath = options.nodePath ?? process.execPath;
  const command = `"${nodePath}" "${options.forwarderPath}" --secret-header "${secretHeader}: ${options.secret}"`;
  return [
    { event: eventNames.permissionRequest, command },
    { event: eventNames.stop, command },
    { event: eventNames.notification, command },
    { event: eventNames.postToolUse, command },
    { event: eventNames.userPromptSubmit, command },
  ];
}
