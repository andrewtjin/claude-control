// The enforcement guard: a second UserPromptSubmit hook that keeps a folder-bound account from
// being used in the wrong place, and a folder-bound folder from being worked in on the wrong
// account. It runs BESIDE the relay forwarder (hook-forward.cjs) and, like it, is a
// dependency-free CommonJS script Claude Code spawns per event — so the whole implementation is
// generated as a source string and written to disk, never shipped as a bundled asset.
//
// Two things make the guard its own script rather than a branch inside the forwarder:
//   - the forwarder's contract is NEVER block / fail fast; the guard's whole job is to block, so
//     mixing them would put a blocking decision on the path that must never stall a tool call;
//   - the guard needs the folder canonicalizer, and the forwarder does not.
//
// The canonicalizer and the precedence rule are not re-implemented here. They are EMBEDDED verbatim
// from switch-engine's `embeddableFolderPathSource()` (canonicalizeFolder / folderKey / isWithin /
// aliasKey / resolveSessionBinding), whose colocated test proves the embedded copies still agree
// with the live TS functions across the case tables. Only the glue below — reading the snapshot and
// the session title, and shaping the decision per spec §9 — is written here.
//
// Fail-open by construction: any thrown error, a missing/unparseable snapshot, or an unrecognized
// schema exits 0 (never blocks) with a single stderr line. A guard that crashed closed would lock
// the operator out of every session, which is far worse than a binding that momentarily is not
// enforced.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  embeddableFolderPathSource,
  embeddableSanitizeSource,
} from '@claude-control/switch-engine';
import { bindTokensDir } from './bindToken.js';

/** Stable on-disk location of the guard script, beside `hook-forward.cjs` in the daemon data dir.
 *  Keeping the two colocated means one directory holds every generated hook script. */
export function bindGuardPath(dataDir: string): string {
  return join(dataDir, 'bind-guard.cjs');
}

/** A stable substring present in every guard command we install and in nobody else's — the script
 *  filename. Used to recognize (and prune stale generations of) our guard entry in settings.json,
 *  the way the forwarder's secret-header name fingerprints its own. Kept independent of the
 *  forwarder's ownership marker so installing one hook never evicts the other from the shared
 *  UserPromptSubmit group. */
export const BIND_GUARD_MARKER = 'bind-guard.cjs';

/**
 * The hook command Claude Code runs for the guard: node executing the guard script. Quoted exactly
 * like the forwarder command (each path in its own double quotes) so a space in either path is
 * safe. The snapshot path is baked INTO the script (see {@link generateBindGuardSource}), not
 * passed as an argument, so the command stays a bare `node <script>` and the script is fully
 * self-describing.
 */
export function buildBindGuardCommand(opts: { guardPath: string; nodePath?: string }): string {
  const nodePath = opts.nodePath ?? process.execPath;
  return `"${nodePath}" "${opts.guardPath}"`;
}

/**
 * Generate the guard script source. `snapshotPath` is the absolute path of the non-secret
 * folder-bindings snapshot (`folderBindingsPath(vaultDir)`); it is baked in as a string literal so
 * the script needs no arguments and no knowledge of the vault layout.
 *
 * The script implements the enforcement rules:
 *   - session slot = the group whose canonical profileDir equals the session's canonical
 *     CLAUDE_CONFIG_DIR, else the global slot (outside every group).
 *   - required slot = THE precedence rule (switch-engine's resolveSessionBinding, embedded): the
 *     session's folder F and custom title X alias-bound as (F, X) -> that group; else the longest
 *     bound folder containing F -> that group; else the global slot. X is the payload's
 *     `session_title` (Claude Code's custom title, absent for an unnamed session); only when that key
 *     is absent and an alias rule could matter is the transcript's last custom-title read (bounded).
 *   - (A) the rule names a group the session is NOT running on -> block. The block reason names the
 *     account the session is actually on (a different group, or the shared account); for an alias
 *     binding it says to resume the session with `cctl claude --resume "<title>"`. A valid --override
 *     relaxation token (CCTL_BIND_OVERRIDE) allows the session with a visible systemMessage instead.
 *   - (B) the session runs on a group's slot but the rule names no group here (a folder outside the
 *     group's folders, or a session renamed away from the group's alias) -> block. A valid --account
 *     relaxation token (CCTL_LAUNCH_EXPLICIT) allows it, with a visible systemMessage so the bypass
 *     is never silent.
 *   - every interpolated string (folders, labels, the untrusted session title) is sanitized at the
 *     output sinks, and a title is truncated for display.
 *   - The relaxation env vars are NOT plain switches: each must name a token file the launcher minted
 *     for THIS launch's slot (see bindToken.ts) whose launching process is still alive. An inherited
 *     or persisted value (e.g. a stray "1"), or a token left behind by a dead launch, has no honored
 *     backing record, so a folder binding cannot be defeated by ambient env. A honored relaxation
 *     emits a systemMessage, which Claude Code surfaces in an INTERACTIVE session; a non-interactive
 *     (-p / SDK) run drops UserPromptSubmit systemMessages, so there the launcher's own stderr banner
 *     (see launcher.ts / bindCommands.ts) is the visible signal that a relaxation is in effect.
 *   - enforce = snapshot.enforce (block|warn|off) ?? 'block' — read ONLY from the snapshot, which the
 *     daemon/CLI resolve from CCTL_BIND_ENFORCE (env > config > default) and write. The guard does
 *     not re-read the env var: doing so let any session's ambient environment silently turn
 *     enforcement off. warn never blocks and emits the same text as a systemMessage; off exits 0
 *     silently (an operator-configured mode, not an ambient one).
 *   - any error / missing / unparseable / unknown-schema snapshot -> exit 0 with one stderr line.
 */
export function generateBindGuardSource(opts: { snapshotPath: string }): string {
  // The directory holding per-launch relaxation tokens, baked in beside the snapshot path so the
  // guard and the launcher agree on it from the snapshot path alone.
  const tokensDir = bindTokensDir(opts.snapshotPath);
  return `'use strict';
// claude-control bind guard (written by cctl; safe to delete — it is re-created on the next
// bind / daemon start). A second UserPromptSubmit hook that enforces folder-account bindings.
// Dependency-free CommonJS. Fails OPEN (exit 0) on any error so it can never lock a session out.
const fs = require('fs');
const path = require('path');

${embeddableFolderPathSource()}

${embeddableSanitizeSource()}

// The non-secret folder-bindings snapshot, baked in at install time.
const SNAPSHOT_PATH = ${JSON.stringify(opts.snapshotPath)};

// Where the launcher writes a per-launch relaxation token (see bindToken.ts). A token is honored
// only when the env var names a file here whose recorded slot matches this session's slot; a plain
// inherited value has no such file and is ignored, so a binding cannot be bypassed by ambient env.
const TOKENS_DIR = ${JSON.stringify(tokensDir)};
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// True when the launching process that minted a token is still running. A relaxation lasts only for
// the lifetime of the launch that requested it: a session that merely inherited the env value after
// that launch died (a hard kill, an orphaned child) is not relaxed. kill(pid, 0) sends no signal — it
// throws ESRCH when the process is gone and EPERM when it exists but is not signalable (still alive).
function launcherAlive(pid) {
  if (typeof pid !== 'number' || !isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// True when \`envValue\` names a valid relaxation token of the expected kind, minted for the slot this
// session runs on (sessionConfigKey: the folderKey of CLAUDE_CONFIG_DIR, '' for the global slot), AND
// the launch that minted it is still alive. Binding the honor to the launcher pid means a token that
// outlives its launch — a file left behind by a hard kill, or a value inherited by an unrelated
// same-slot session — cannot relax a binding: the mismatch is caught here, not left to file cleanup.
function honorRelaxation(envValue, expectedKind, sessionConfigKey) {
  if (typeof envValue !== 'string' || !TOKEN_PATTERN.test(envValue)) return false;
  var record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, envValue + '.json'), 'utf8'));
  } catch (e) {
    return false;
  }
  if (!record || record.v !== 1 || record.kind !== expectedKind) return false;
  var recordKey = typeof record.profileKey === 'string' ? record.profileKey : '';
  if (recordKey !== sessionConfigKey) return false;
  return launcherAlive(record.launcherPid);
}

// Exit 0 (never block) and leave a single diagnostic line — the fail-open path for every internal
// fault and every unusable snapshot.
function failOpen(reason) {
  try {
    process.stderr.write('cctl bind-guard: ' + reason + ' (allowing prompt)\\n');
  } catch (e) {}
  process.exit(0);
}

// Block the prompt with the given reason — unless warn mode, where the same text rides a
// systemMessage and the prompt proceeds. The reason interpolates a folder path and account
// labels, both operator/filesystem-controlled; it is sanitized here (the single output sink) so a
// control char, ANSI escape, newline, or bidi/format control in either can never reach the
// terminal or the model. JSON.stringify only escapes the wire JSON, not the string Claude Code
// decodes and prints.
function emitBlock(reason, enforce) {
  if (enforce === 'warn') return emitSystemMessage(reason);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: sanitizeTerminalText(reason) }));
  process.exit(0);
}

// Show a non-blocking message to the operator (warn mode, and the --override notice). Sanitized at
// this sink for the same reason as emitBlock.
function emitSystemMessage(message) {
  process.stdout.write(JSON.stringify({ systemMessage: sanitizeTerminalText(message) }));
  process.exit(0);
}

function readValidEnforce(value) {
  return value === 'block' || value === 'warn' || value === 'off' ? value : undefined;
}

function run(input) {
  const platform = process.platform;
  const deps = {
    platform: platform,
    cwd: process.cwd(),
    realpath: function (p) {
      return fs.realpathSync.native(p);
    },
  };

  // The hook payload supplies the session's custom title (session_title, or the transcript_path
  // fallback) and the \`cwd\` fallback when CLAUDE_PROJECT_DIR is unset.
  var payload = {};
  try {
    var parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') payload = parsed;
  } catch (e) {}

  // Load + validate the snapshot. Anything wrong with it fails open.
  var snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (e) {
    return failOpen('snapshot missing or unreadable');
  }
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    snapshot.schemaVersion !== 1 ||
    !Array.isArray(snapshot.groups)
  ) {
    return failOpen('snapshot schema not recognized');
  }

  // enforce: read ONLY from the snapshot (the daemon/CLI resolve CCTL_BIND_ENFORCE env > config >
  // default into it). The guard must not re-read the env var, or any session's ambient environment
  // could silently turn enforcement off. off is silent: it is an operator-configured mode.
  var enforce = readValidEnforce(snapshot.enforce) || 'block';
  if (enforce === 'off') process.exit(0);

  // The project dir under evaluation: CLAUDE_PROJECT_DIR (set on every hook spawn), else the
  // payload cwd. Nothing to check without one.
  var rawProject =
    typeof process.env.CLAUDE_PROJECT_DIR === 'string' && process.env.CLAUDE_PROJECT_DIR.length > 0
      ? process.env.CLAUDE_PROJECT_DIR
      : typeof payload.cwd === 'string'
        ? payload.cwd
        : '';
  if (!rawProject) process.exit(0);
  var projCanon = canonicalizeFolder(rawProject, deps);
  if (!projCanon.ok) return failOpen('project dir could not be canonicalized');
  var projectDir = projCanon.path;

  // The session's slot: the group whose canonical profileDir equals the session's canonical
  // CLAUDE_CONFIG_DIR. No config dir, or no match, means the global (shared) slot. sessionConfigKey
  // is the canonical folderKey of CLAUDE_CONFIG_DIR ('' for the global slot); a relaxation token is
  // honored only when it was minted for this same slot key.
  var sessionGroup = null;
  var sessionConfigKey = '';
  var rawConfig = process.env.CLAUDE_CONFIG_DIR;
  if (typeof rawConfig === 'string' && rawConfig.length > 0) {
    var cfgCanon = canonicalizeFolder(rawConfig, deps);
    if (cfgCanon.ok) {
      sessionConfigKey = folderKey(cfgCanon.path, platform);
      for (var i = 0; i < snapshot.groups.length; i++) {
        var g = snapshot.groups[i];
        if (g && typeof g.profileDir === 'string') {
          var pc = canonicalizeFolder(g.profileDir, deps);
          var pk = pc.ok ? folderKey(pc.path, platform) : folderKey(g.profileDir, platform);
          if (pk === sessionConfigKey) {
            sessionGroup = g;
            break;
          }
        }
      }
    }
  }

  var groups = snapshot.groups;

  // The session's alias: the prompt payload's session_title, which Claude Code sets to the session's
  // CUSTOM title (/rename, --name) — present from the very first prompt of a named launch, absent for
  // an unnamed session, never the generated title. Any non-string value means "no custom title".
  // Only when the key is ABSENT (an older Claude Code that does not send it) AND an alias rule could
  // change the answer here is the transcript read for its last custom-title line; the scan is bounded.
  var title = typeof payload.session_title === 'string' ? payload.session_title : null;
  if (
    !Object.prototype.hasOwnProperty.call(payload, 'session_title') &&
    aliasRuleRelevant(projectDir, sessionGroup, groups, platform)
  ) {
    title = lastCustomTitle(payload.transcript_path);
  }

  // THE precedence rule, embedded verbatim from switch-engine (the launcher, cctl where and cctl
  // session show run the same function): an alias scope in exactly this folder, else the longest
  // bound folder containing it (a nested binding overrides its ancestor; the embedded isWithin keeps
  // C:\\research from containing C:\\research2), else null = the global slot.
  var required = resolveSessionBinding(projectDir, title, groups, platform);
  var requiredGroup = required ? findGroup(groups, required.groupId) : null;
  if (required && !requiredGroup) required = null;

  var sessionGroupId = sessionGroup ? sessionGroup.id : null;

  // Case A: the rule names a group, and the session is not on that group's slot.
  if (required && required.groupId !== sessionGroupId) {
    var members = membersOf(requiredGroup);
    // The reason must name the account this session is ACTUALLY on. A session on the global slot runs
    // on the shared account; a session on another group's slot runs on that group's reserved account,
    // so telling it to "cctl claude" (which would put it on the bound account) is right, but "runs on
    // the shared account" would be false. Branch on sessionGroup accordingly.
    var reasonA;
    if (required.via === 'alias') {
      var shown = displayTitle(title);
      var current = sessionGroup
        ? membersOf(sessionGroup) + ' (bound to ' + scopesOf(sessionGroup) + ')'
        : 'the shared account';
      reasonA =
        'cctl: session "' +
        shown +
        '" in ' +
        projectDir +
        ' is bound to ' +
        members +
        ', but this session runs on ' +
        current +
        '. Exit and resume it with: cctl claude --resume "' +
        shown +
        '"';
    } else if (sessionGroup) {
      reasonA =
        'cctl: ' +
        required.folder +
        ' is bound to ' +
        members +
        ', but this session runs on ' +
        membersOf(sessionGroup) +
        ' (bound to ' +
        scopesOf(sessionGroup) +
        '). Exit and start it here with: cctl claude' +
        '   (or add --override to use this account here anyway)';
    } else {
      reasonA =
        'cctl: ' +
        required.folder +
        ' is bound to ' +
        members +
        ', but this session runs on the shared account. Exit and start it with: cctl claude' +
        '   (or set up the claude wrapper: cctl shell-init powershell)';
    }
    // --override relaxes case A, but only via a token the launcher minted for this launch's slot; an
    // inherited env value is not honored, so the binding still applies. A honored override is visible.
    if (honorRelaxation(process.env.CCTL_BIND_OVERRIDE, 'override', sessionConfigKey)) {
      return emitSystemMessage(reasonA);
    }
    return emitBlock(reasonA, enforce);
  }

  // Case B: the session runs on a group's slot, but the rule names no group here (a group-named
  // required slot that differs was case A above). The reserved account is outside its scopes: a
  // folder it is not bound to, or — for an alias scope — a session renamed away from its alias.
  if (sessionGroup && !required) {
    var scopes = scopesOf(sessionGroup);
    // --account relaxes case B, but only via a token minted for this session's slot whose launch is
    // still alive; an inherited env value is not honored. A honored relaxation emits a systemMessage
    // (surfaced in interactive sessions; the launcher banner is the headless signal) so it is clear
    // the reserved account is being used outside its scopes on purpose.
    if (honorRelaxation(process.env.CCTL_LAUNCH_EXPLICIT, 'explicit', sessionConfigKey)) {
      return emitSystemMessage(
        'cctl: running ' +
          membersOf(sessionGroup) +
          ' (bound to ' +
          scopes +
          ') in ' +
          projectDir +
          ' — launched explicitly with --account. This account is reserved to its folders.',
      );
    }
    var aliasHere = aliasScopeIn(sessionGroup, projectDir, platform);
    var reasonB;
    if (aliasHere !== null) {
      // The session is in the folder of one of its group's alias scopes but no longer carries that
      // title: it was renamed away (or never had it). Say so, and how to put it back.
      reasonB =
        'cctl: this session runs on the account bound to session "' +
        aliasHere +
        '" in ' +
        projectDir +
        ', but it is ' +
        (title !== null && aliasKey(title) !== '' ? 'named "' + displayTitle(title) + '"' : 'unnamed') +
        '. That account is reserved to its bindings. Rename it back with /rename ' +
        aliasHere +
        ', or exit and run Claude Code here normally: cctl claude';
    } else if (hasAliasScopes(sessionGroup)) {
      reasonB =
        'cctl: this session runs on the account bound to ' +
        scopes +
        ', but this session in ' +
        projectDir +
        ' is not one of its bindings. That account is reserved to its bindings. Run Claude Code ' +
        'here normally, or launch it explicitly with: cctl claude --account <account>';
    } else {
      reasonB =
        'cctl: this session runs on the account bound to ' +
        scopes +
        ', but ' +
        projectDir +
        ' is not one of its folders. That account is reserved to its folders. Run Claude Code ' +
        'here normally, or launch it explicitly with: cctl claude --account <account>';
    }
    return emitBlock(reasonB, enforce);
  }

  // No conflict.
  process.exit(0);
}

// ---- snapshot row helpers (every field is read defensively: the snapshot is operator-editable) ----

function findGroup(groups, id) {
  for (var i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].id === id) return groups[i];
  }
  return null;
}

function membersOf(group) {
  return group && Array.isArray(group.members) ? group.members.join(', ') : '';
}

function aliasesOf(group) {
  return group && Array.isArray(group.aliases) ? group.aliases : [];
}

function hasAliasScopes(group) {
  return aliasesOf(group).length > 0;
}

// A group's scopes for a message: its folders, then each alias scope as session "<key>" in <folder>
// (only the key is in the snapshot). For a group with no alias scope this is exactly the folder list.
function scopesOf(group) {
  var parts = [];
  if (group && Array.isArray(group.folders)) {
    for (var i = 0; i < group.folders.length; i++) {
      if (typeof group.folders[i] === 'string') parts.push(group.folders[i]);
    }
  }
  var aliases = aliasesOf(group);
  for (var j = 0; j < aliases.length; j++) {
    var a = aliases[j];
    if (a && typeof a.folder === 'string' && typeof a.aliasKey === 'string') {
      parts.push('session "' + a.aliasKey + '" in ' + a.folder);
    }
  }
  return parts.join(', ');
}

// The key of the group's alias scope in exactly this folder, or null.
function aliasScopeIn(group, projectDir, platform) {
  var here = folderKey(projectDir, platform);
  var aliases = aliasesOf(group);
  for (var i = 0; i < aliases.length; i++) {
    var a = aliases[i];
    if (
      a &&
      typeof a.folder === 'string' &&
      typeof a.aliasKey === 'string' &&
      folderKey(a.folder, platform) === here
    ) {
      return a.aliasKey;
    }
  }
  return null;
}

// Whether the session's title could change the decision here: some group binds an alias in exactly
// this folder, or the session runs on a slot that has alias scopes (then whether it still carries the
// alias decides case B). Otherwise the rule is folder-only and no title is needed.
function aliasRuleRelevant(projectDir, sessionGroup, groups, platform) {
  if (hasAliasScopes(sessionGroup)) return true;
  for (var i = 0; i < groups.length; i++) {
    if (aliasScopeIn(groups[i], projectDir, platform) !== null) return true;
  }
  return false;
}

// A title for display in a decision: long enough to recognize, never a megabyte of hook output.
// Control characters are stripped at the output sinks (emitBlock / emitSystemMessage).
var TITLE_DISPLAY_MAX = 120;
function displayTitle(title) {
  var t = typeof title === 'string' ? title : '';
  return t.length > TITLE_DISPLAY_MAX ? t.slice(0, TITLE_DISPLAY_MAX) + '...' : t;
}

// The fallback title read, for a Claude Code that does not put session_title in the payload: the
// LAST {"type":"custom-title"} line of the transcript (titles are last-wins). Read BACKWARDS in chunks
// so the common case (a title near the end) costs one chunk, and bounded so a multi-gigabyte
// transcript can never stall a prompt: past TITLE_SCAN_MAX_BYTES the session is treated as unnamed.
// A torn (half-written) line simply fails to parse and the scan moves on to the previous one. Only a
// regular file is opened (a FIFO would block the open).
var TITLE_SCAN_MAX_BYTES = 8 * 1024 * 1024;
var TITLE_SCAN_CHUNK = 256 * 1024;
var CUSTOM_TITLE_NEEDLE = Buffer.from('"type":"custom-title"');

function lastCustomTitle(file) {
  if (typeof file !== 'string' || file.length === 0) return null;
  var st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null;
  }
  if (!st.isFile()) return null;
  var fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return null;
  }
  try {
    var pos = st.size;
    var scanned = 0;
    var carry = Buffer.alloc(0);
    while (pos > 0 && scanned < TITLE_SCAN_MAX_BYTES) {
      var len = Math.min(TITLE_SCAN_CHUNK, pos, TITLE_SCAN_MAX_BYTES - scanned);
      pos -= len;
      scanned += len;
      var chunk = Buffer.alloc(len);
      var got = fs.readSync(fd, chunk, 0, len, pos);
      var data = Buffer.concat([chunk.subarray(0, got), carry]);
      // Every segment after a newline is a complete line; the head before the first newline may
      // continue in the previous chunk, so it is carried to the next (earlier) read.
      var end = data.length;
      while (end > 0) {
        var nl = data.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break;
        var found = customTitleOfLine(data.subarray(nl + 1, end));
        if (found !== null) return found;
        end = nl;
      }
      carry = data.subarray(0, end);
    }
    // Reached the start of the file: the carried head is the (complete) first line.
    if (pos === 0 && carry.length > 0) return customTitleOfLine(carry);
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {}
  }
}

function customTitleOfLine(line) {
  if (line.length === 0 || line.indexOf(CUSTOM_TITLE_NEEDLE) === -1) return null;
  var obj;
  try {
    obj = JSON.parse(line.toString('utf8'));
  } catch (e) {
    return null;
  }
  if (obj && obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
    return obj.customTitle;
  }
  return null;
}

var input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', function () {
  failOpen('stdin error');
});
process.stdin.on('data', function (chunk) {
  input += chunk;
});
process.stdin.on('end', function () {
  try {
    run(input);
  } catch (e) {
    failOpen('internal error: ' + (e && e.message ? e.message : String(e)));
  }
});
`;
}

/** Write (or refresh) the guard script with the snapshot path baked in. Called wherever a binding
 *  is created and on daemon start, so a deleted or stale copy heals itself the way the forwarder's
 *  does. */
export async function writeBindGuard(filePath: string, snapshotPath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, generateBindGuardSource({ snapshotPath }), 'utf8');
}
