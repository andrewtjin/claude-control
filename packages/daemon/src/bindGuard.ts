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
// The canonicalizer, the precedence rule and the transcript's recorded folder are not re-implemented
// here. They are EMBEDDED verbatim from switch-engine's `embeddableFolderPathSource()`
// (canonicalizeFolder / folderKey / isWithin / aliasKey / resolveSessionBinding / the project-dir
// naming) and `embeddableRecordedFolderSource()` (readRecordedFolder / recordedFolderFor — the one
// reading the launcher, the session catalog and the running-session scan also use), whose colocated
// tests prove the embedded copies still agree with the live TS functions. Only the glue below —
// reading the snapshot and the session title, and shaping the decision per spec §9 — is written here.
//
// Fail-open by construction: any thrown error, a missing/unparseable snapshot, or an unrecognized
// schema exits 0 (never blocks) with a single stderr line. A guard that crashed closed would lock
// the operator out of every session, which is far worse than a binding that momentarily is not
// enforced.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  embeddableFolderPathSource,
  embeddableRecordedFolderSource,
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
 *     CLAUDE_CONFIG_DIR, else the global slot (outside every group). A CLAUDE_CONFIG_DIR naming the
 *     snapshot's main config dir IS the global slot, keyed exactly like an unset one.
 *   - a project folder whose name has no canonical form (a control or bidi/format character) is
 *     judged by its nearest clean ancestor, which a binding covers exactly when it covers the folder.
 *   - required slot = THE precedence rule (switch-engine's resolveSessionBinding, embedded): the
 *     session's RECORDED folder R and custom title X alias-bound as (R, X) -> that group; else the
 *     longest bound folder containing the project dir F -> that group; else the global slot. X is
 *     the payload's `session_title` (Claude Code's custom title; absent = unnamed — the transcript is
 *     never read for a title, so alias binding needs a Claude Code that sends it). R is the folder
 *     the conversation belongs to, read from the transcript at `transcript_path` by switch-engine's
 *     readRecordedFolder (embedded; only when X names some bound alias): its first cwd within a
 *     bounded head, moved by a relocation within a bounded tail, trusted only when consistent with
 *     the transcript's project-directory name; otherwise — no transcript yet, an unreadable one, or
 *     no trusted folder in it — F, when that name can stand for F, else no folder at all (so a
 *     lossy name never picks a bound folder the session does not run in). A read error is handled
 *     there, never by failing open.
 *   - (A) the rule names a group the session is NOT running on -> block. The block reason names the
 *     account the session is actually on (a different group, or the shared account); for an alias
 *     binding it names the alias and says to resume THE session: `cctl claude --resume <session id>`
 *     (the payload's session_id, a validated UUID) once its transcript exists — an id cannot be
 *     ambiguous the way a title several sessions share is — else `cctl claude --resume '<alias>'`,
 *     the whole alias as bound, quoted for the operator's shell (PowerShell on Windows, POSIX
 *     elsewhere). A valid --override relaxation token (CCTL_BIND_OVERRIDE) allows the session with a
 *     visible systemMessage instead.
 *   - (B) the session runs on a group's slot but the rule names no group here (a folder outside the
 *     group's folders, a session renamed away from the group's alias, or a same-titled conversation
 *     recorded in another folder) -> block. A valid --account relaxation token (CCTL_LAUNCH_EXPLICIT)
 *     allows it, with a visible systemMessage so the bypass is never silent.
 *   - every interpolated string (folders, labels, the untrusted session title) is sanitized at the
 *     output sinks; shown text is clipped and lists are shortened, so a decision stays small. A
 *     printed command is never clipped.
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

${embeddableRecordedFolderSource()}

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

// A real folder whose name carries a control or bidi/format character has no canonical form, so no
// binding can name it or anything beneath it. It is still judged exactly: a bound folder contains it
// precisely when that folder contains its nearest clean ancestor (the path up to the separator before
// the offending character), since a binding can neither equal nor sit inside the offending segment.
// Returns that ancestor's canonical path, or null when there is none to fall back on (a rejection
// for any other reason, or no separator before the character).
function cleanAncestor(raw, failure, deps, platform) {
  if (typeof failure.unsafeCharIndex !== 'number') return null;
  var win = platform === 'win32';
  for (var q = failure.unsafeCharIndex - 1; q >= 0; q--) {
    var ch = raw[q];
    if (ch === '/' || (win && ch === '\\\\')) {
      // Keep the separator so a bare root ("C:/", "/") stays a root rather than a relative name.
      var anc = canonicalizeFolder(raw.slice(0, q + 1), deps);
      return anc.ok ? anc.path : null;
    }
  }
  return null;
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

  // The hook payload supplies the session's custom title (session_title), its transcript's path
  // (whose head records the folder the conversation belongs to) and the \`cwd\` fallback when
  // CLAUDE_PROJECT_DIR is unset.
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
  // projectDir is the canonical folder containment is judged on; projectShown is how the folder is
  // named in a message. They differ only for a folder with no canonical form (see cleanAncestor),
  // which is judged by its nearest clean ancestor and shown as spelled (sanitized at the sink).
  var projectDir;
  var projectShown;
  var projCanon = canonicalizeFolder(rawProject, deps);
  if (projCanon.ok) {
    projectDir = projCanon.path;
    projectShown = projCanon.path;
  } else {
    var ancestor = cleanAncestor(rawProject, projCanon, deps, platform);
    if (ancestor === null) return failOpen('project dir could not be canonicalized');
    projectDir = ancestor;
    projectShown = rawProject;
  }

  // The main config dir's key. A CLAUDE_CONFIG_DIR naming it is the global slot spelled out (a shell
  // that exports it), not a slot of its own.
  var mainConfigKey = null;
  if (typeof snapshot.mainConfigDir === 'string' && snapshot.mainConfigDir.length > 0) {
    var mc = canonicalizeFolder(snapshot.mainConfigDir, deps);
    mainConfigKey = folderKey(mc.ok ? mc.path : snapshot.mainConfigDir, platform);
  }

  // The session's slot: the group whose canonical profileDir equals the session's canonical
  // CLAUDE_CONFIG_DIR. No config dir, the main config dir, or no match means the global (shared)
  // slot. sessionConfigKey is the canonical folderKey of CLAUDE_CONFIG_DIR, and '' for the global
  // slot however it is spelled — the key the launcher mints a global-slot relaxation token for; a
  // token is honored only when it was minted for this same slot key.
  var sessionGroup = null;
  var sessionConfigKey = '';
  var rawConfig = process.env.CLAUDE_CONFIG_DIR;
  if (typeof rawConfig === 'string' && rawConfig.length > 0) {
    var cfgCanon = canonicalizeFolder(rawConfig, deps);
    var cfgKey = cfgCanon.ok ? folderKey(cfgCanon.path, platform) : null;
    if (cfgKey !== null && cfgKey !== mainConfigKey) {
      sessionConfigKey = cfgKey;
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
  // an unnamed session, never the generated title. Absent, or not a string, means "no custom title":
  // the guard never reads a title out of the transcript (a Claude Code that does not send
  // session_title cannot use alias bindings; see docs/CLI.md for the minimum version).
  var title = typeof payload.session_title === 'string' ? payload.session_title : null;

  // The folder the conversation BELONGS to — the alias rule's key. \`claude --resume <title>\` run in a
  // repo root also resumes sessions recorded in its subfolders and worktrees, and the resumed session
  // keeps its original folder, so an alias binding (F, X) means "the conversations titled X recorded
  // in F", wherever they run now. Only worked out when the title names some bound alias at all.
  var recorded = undefined;
  var transcriptExists = false;
  var key = title !== null ? aliasKey(title) : '';
  if (key !== '' && aliasBoundAnywhere(groups, key)) {
    var located = conversationFolder(payload.transcript_path, rawProject, projectDir, deps, platform);
    recorded = located.folder;
    transcriptExists = located.exists;
  }

  // THE precedence rule, embedded verbatim from switch-engine (the launcher, cctl where and cctl
  // session show run the same function): the alias bound for the session's recorded folder, else the
  // longest bound folder containing the folder it runs in (a nested binding overrides its ancestor;
  // the embedded isWithin keeps C:\\\\research from containing C:\\\\research2), else null = the
  // global slot.
  var required = resolveSessionBinding(projectDir, title, groups, platform, recorded);
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
      // The resume command carries the WHOLE alias as bound (printable by construction), quoted for
      // the operator's shell; only the display copy is shortened.
      var bound = boundAlias(requiredGroup, required.folder, required.aliasKey) || title.trim();
      var current = sessionGroup
        ? membersOf(sessionGroup) + ' (bound to ' + scopesOf(sessionGroup) + ')'
        : 'the shared account';
      reasonA =
        'cctl: session "' +
        clip(bound) +
        '" in ' +
        clip(required.folder) +
        ' is bound to ' +
        members +
        ', but this session runs on ' +
        current +
        '. Exit and resume it with: cctl claude --resume ' +
        resumeArgument(payload.session_id, transcriptExists, bound, platform);
    } else if (sessionGroup) {
      reasonA =
        'cctl: ' +
        clip(required.folder) +
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
        clip(required.folder) +
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
  // folder it is not bound to, or — for an alias scope — a session that is not (or no longer) that
  // alias's conversation.
  if (sessionGroup && !required) {
    var scopes = scopesOf(sessionGroup);
    var reservedTo = hasAliasScopes(sessionGroup) ? 'its bindings' : 'its folders';
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
          clip(projectShown) +
          ' — launched explicitly with --account. This account is reserved to ' +
          reservedTo +
          '.',
      );
    }
    var aliasHere = aliasScopeIn(sessionGroup, projectDir, platform);
    var reasonB;
    if (aliasHere !== null && key !== '' && aliasHere.aliasKey === key) {
      // Titled like this folder's bound alias, yet not in scope: the conversation was recorded in
      // another folder (Claude Code resumed a same-titled session from a subfolder, worktree or
      // prefix-sibling project), so it is not the bound one.
      reasonB =
        'cctl: this session runs on the account bound to session "' +
        clip(aliasHere.alias) +
        '" in ' +
        clip(projectShown) +
        ', but this session was recorded in ' +
        (typeof recorded === 'string' ? clip(recorded) : 'another folder') +
        ', so it is not that conversation. That account is reserved to its bindings. Exit and ' +
        'start it with: cctl claude';
    } else if (aliasHere !== null) {
      // In the folder of one of its group's alias scopes, but not (or no longer) carrying that
      // title. It may have been renamed away — or it may be another conversation altogether, so the
      // advice covers both.
      reasonB =
        'cctl: this session runs on the account bound to session "' +
        clip(aliasHere.alias) +
        '" in ' +
        clip(projectShown) +
        ', but it is ' +
        (key !== '' ? 'named "' + clip(title) + '"' : 'unnamed') +
        '. That account is reserved to its bindings. Exit and start it here with: cctl claude' +
        ' — or, if this is that session, rename it back: /rename ' +
        aliasHere.alias;
    } else if (hasAliasScopes(sessionGroup)) {
      reasonB =
        'cctl: this session runs on the account bound to ' +
        scopes +
        ', but this session in ' +
        clip(projectShown) +
        ' is not one of its bindings. That account is reserved to its bindings. Run Claude Code ' +
        'here normally, or launch it explicitly with: cctl claude --account <account>';
    } else {
      reasonB =
        'cctl: this session runs on the account bound to ' +
        scopes +
        ', but ' +
        clip(projectShown) +
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

// Bounds on what one decision may print. A group can hold 32 members and 512 scopes, a label or a
// folder can be long, and a decision is read by a terminal and the model on every blocked prompt:
// lists name their first few entries and count the rest, and each shown string is clipped. A resume
// command is never clipped (see case A).
var LIST_SHOWN_MAX = 3;
var TEXT_SHOWN_MAX = 160;

function clip(text) {
  var t = typeof text === 'string' ? text : '';
  return t.length > TEXT_SHOWN_MAX ? t.slice(0, TEXT_SHOWN_MAX) + '...' : t;
}

function shortList(items) {
  var shown = [];
  for (var i = 0; i < items.length && i < LIST_SHOWN_MAX; i++) shown.push(clip(items[i]));
  var rest = items.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ', and ' + rest + ' more' : '');
}

function membersOf(group) {
  if (!group || !Array.isArray(group.members)) return '';
  var labels = [];
  for (var i = 0; i < group.members.length; i++) {
    if (typeof group.members[i] === 'string') labels.push(group.members[i]);
  }
  return shortList(labels);
}

function aliasesOf(group) {
  return group && Array.isArray(group.aliases) ? group.aliases : [];
}

function hasAliasScopes(group) {
  return aliasesOf(group).length > 0;
}

// An alias row's display text: the alias as bound, or (a snapshot written before it was carried)
// its key.
function aliasShown(a) {
  return typeof a.alias === 'string' && a.alias !== '' ? a.alias : a.aliasKey;
}

// A group's scopes for a message: its folders, then each alias scope as session "<alias>" in
// <folder>, as a short list. For a group with no alias scope this is exactly its folder list.
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
      parts.push('session "' + clip(aliasShown(a)) + '" in ' + a.folder);
    }
  }
  return shortList(parts);
}

// The group's alias scope in exactly this folder, as { alias, aliasKey }, or null.
function aliasScopeIn(group, folder, platform) {
  var here = folderKey(folder, platform);
  var aliases = aliasesOf(group);
  for (var i = 0; i < aliases.length; i++) {
    var a = aliases[i];
    if (
      a &&
      typeof a.folder === 'string' &&
      typeof a.aliasKey === 'string' &&
      folderKey(a.folder, platform) === here
    ) {
      return { alias: aliasShown(a), aliasKey: a.aliasKey };
    }
  }
  return null;
}

// The alias as bound for the scope (folder, key) of this group, or null (an older snapshot).
function boundAlias(group, folder, key) {
  var aliases = aliasesOf(group);
  for (var i = 0; i < aliases.length; i++) {
    var a = aliases[i];
    if (a && a.aliasKey === key && a.folder === folder && typeof a.alias === 'string' && a.alias) {
      return a.alias;
    }
  }
  return null;
}

// Whether any group holds an alias scope with this key — the only case the transcript is read.
function aliasBoundAnywhere(groups, key) {
  for (var i = 0; i < groups.length; i++) {
    var aliases = aliasesOf(groups[i]);
    for (var j = 0; j < aliases.length; j++) {
      var a = aliases[j];
      if (a && a.aliasKey === key && typeof a.folder === 'string') return true;
    }
  }
  return false;
}

// The folder a session's conversation belongs to for the alias rule, and whether its transcript
// exists. No transcript path in the payload: the folder it runs in. Otherwise the embedded
// readRecordedFolder / recordedFolderFor decide (see the policy in the script header); neither ever
// throws, so an unreadable transcript never fails the whole guard open.
function conversationFolder(transcriptPath, rawProject, projectDir, deps, platform) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') {
    return { folder: projectDir, exists: false };
  }
  var read = readRecordedFolder(transcriptPath, fs, platform);
  var folder = recordedFolderFor(
    read,
    { spelled: rawProject, canonical: projectDir },
    function (f) {
      var c = canonicalizeFolder(f, deps);
      return c.ok ? c.path : f;
    },
  );
  return { folder: folder, exists: read.status !== 'missing' };
}

// The argument of the resume command an alias block prints: THE session's id once its transcript
// exists (a UUID needs no quoting, and unlike a title it names exactly one conversation), else the
// whole alias as bound, quoted for the operator's shell.
var SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resumeArgument(sessionId, transcriptExists, alias, platform) {
  if (transcriptExists && typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)) {
    return sessionId;
  }
  return shellQuoteArg(alias, platform);
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
