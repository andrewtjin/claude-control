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
// The canonicalizer is not re-implemented here. It is EMBEDDED verbatim from switch-engine's
// `embeddableFolderPathSource()` (canonicalizeFolder / folderKey / isWithin), whose colocated test
// proves the embedded copy still agrees with the live TS function across the whole case table.
// Only the small amount of glue below — reading the snapshot, resolving the binding, and shaping
// the decision per spec §9 — is written here, and it calls into that embedded trio.
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
  SNAPSHOT_IDENTITY_KEY_PREFIX,
} from '@claude-control/switch-engine';
import { bindTokensDir } from './bindToken.js';

/** Where the guard remembers the sessions it has already shown its one-time notice in: one empty
 *  file per session id, beside the snapshot (derived from the snapshot path alone, like the tokens
 *  dir, so the script needs nothing else baked in). */
export function guardNoticesDir(snapshotPath: string): string {
  return join(dirname(snapshotPath), 'bind-guard-notices');
}

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
 *   - session slot = the folder rule whose canonical profileDir equals the session's canonical
 *     CLAUDE_CONFIG_DIR; the global slot (outside every rule) when it is unset or names the
 *     snapshot's main config dir, keyed exactly like an unset one; otherwise an UNMANAGED config dir.
 *   - (A, unmanaged) the project dir has a folder rule and the session runs on an unmanaged config
 *     dir -> block, naming that dir. Its login is its own, so the global slot's identity cannot say
 *     which account it is. --override relaxes it the same way.
 *   - a project folder whose name has no canonical form (a control or bidi/format character) is
 *     judged by its nearest clean ancestor, which a binding covers exactly when it covers the folder.
 *   - (A, global) the project dir has a folder rule and the session runs on the GLOBAL slot. A ruled
 *     folder's pool inherits the shared pool, so the global slot's account is one the folder accepts
 *     — unless the rule excludes it, or it is reserved to other folders only. The account is told by
 *     the non-secret identity block (`oauthAccount`) in the main config's `.claude.json`, matched
 *     against the identities the snapshot carries; credentials are never read. So:
 *       - an account the folder does not take -> block, naming it;
 *       - an account it takes -> allow. When the rule includes accounts and the session is not on
 *         one, a notice says so ONCE per session (a marker file per hook session_id): an interactive
 *         session is told to relaunch through `cctl claude`, a background one that cctl moves it
 *         between turns;
 *       - which account it is cannot be told (no readable identity block, an excluded account with
 *         no recorded identity, or a snapshot that predates the excluded identities) -> block when
 *         the rule excludes anything (or might), allow when it excludes nothing. Allowing would let
 *         a folder run on an account its rule rules out, which is the one thing the rule exists to
 *         prevent; a rule with nothing to exclude has nothing to get wrong.
 *     A valid --override relaxation token (CCTL_BIND_OVERRIDE) turns a block into a visible
 *     systemMessage instead.
 *   - (A, another rule) the project dir has a folder rule and the session runs on ANOTHER rule's
 *     slot -> block, naming that slot. --override relaxes it the same way.
 *   - (B) the session runs on a rule's slot but the project dir is not within that rule's folders
 *     -> block. A valid --account relaxation token (CCTL_LAUNCH_EXPLICIT) allows it, with a visible
 *     systemMessage so the bypass is never silent.
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
const crypto = require('crypto');

${embeddableFolderPathSource()}

${embeddableSanitizeSource()}

// The non-secret folder-bindings snapshot, baked in at install time.
const SNAPSHOT_PATH = ${JSON.stringify(opts.snapshotPath)};

// Where the one-time notice per session is remembered: an empty file named by the hook payload's
// session_id. A marker older than a month is dropped when a new one is written, so the directory
// cannot grow without bound across months of sessions.
const NOTICES_DIR = ${JSON.stringify(guardNoticesDir(opts.snapshotPath))};
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NOTICE_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

// How a block message names a folder's rule. A rule that includes accounts names them (the accounts
// that folder uses first); a rule that only excludes accounts has none to name, so it is described
// as the folder having its own rules rather than as bound to an empty list.
function describeRule(g) {
  var members = Array.isArray(g.members) ? g.members.join(', ') : '';
  return members
    ? 'has its own cctl folder rules (it uses ' + members + ' first)'
    : 'has its own cctl folder rules';
}

// The snapshot names accounts by one-way keys of their identity (see the engine's
// snapshotIdentityKey); the live identity is keyed the same way to compare.
const IDENTITY_KEY_PREFIX = ${JSON.stringify(SNAPSHOT_IDENTITY_KEY_PREFIX)};
function identityKey(value) {
  return crypto.createHash('sha256').update(IDENTITY_KEY_PREFIX + value, 'utf8').digest('hex');
}

// Which account the global slot holds, by the identity block Claude Code keeps for its login in the
// main config's .claude.json (oauthAccount), as identity keys. Never the credentials. null when it
// cannot be read: no file, unparseable, or no account id in it.
function readGlobalIdentity(snapshot) {
  var file = snapshot.mainIdentityFile;
  if (typeof file !== 'string' || file.length === 0) return null;
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  var oa = parsed && typeof parsed === 'object' ? parsed.oauthAccount : null;
  if (!oa || typeof oa !== 'object' || typeof oa.accountUuid !== 'string' || !oa.accountUuid) {
    return null;
  }
  return {
    accountKey: identityKey(oa.accountUuid),
    organizationKey:
      typeof oa.organizationUuid === 'string' && oa.organizationUuid
        ? identityKey(oa.organizationUuid)
        : undefined,
  };
}

// Whether a snapshot identity names the live login: the same account, and the same organization
// when both sides record one (one person can hold logins in several organizations).
function sameIdentity(entry, live) {
  if (!entry || typeof entry.accountKey !== 'string' || entry.accountKey !== live.accountKey) {
    return false;
  }
  return (
    typeof entry.organizationKey !== 'string' ||
    live.organizationKey === undefined ||
    entry.organizationKey === live.organizationKey
  );
}

// Judge a session on the GLOBAL slot in a folder with a rule. Returns one of:
//   { verdict: 'refuse', label, why }  the global slot holds an account this folder does not take
//                                      (why: 'excluded' or 'reserved');
//   { verdict: 'unknown' }             which account it holds cannot be told, and it might matter;
//   { verdict: 'accept', label, own }  the folder takes it; own = it is one of the rule's own
//                                      included accounts (nothing to tell the operator).
// label is the account's stored label, or null for a login cctl does not store.
function judgeGlobal(snapshot, rule) {
  // A snapshot from a build that predates the excluded identities cannot say what the rule rules out.
  if (!Array.isArray(rule.excluded)) return { verdict: 'unknown' };
  var live = readGlobalIdentity(snapshot);
  var accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  var matches = [];
  if (live !== null) {
    for (var i = 0; i < accounts.length; i++) {
      if (sameIdentity(accounts[i], live)) matches.push(accounts[i]);
    }
  }
  var label = matches.length > 0 && typeof matches[0].label === 'string' ? matches[0].label : null;
  if (live !== null) {
    for (var e = 0; e < rule.excluded.length; e++) {
      var ex = rule.excluded[e];
      if (sameIdentity(ex, live)) {
        return { verdict: 'refuse', label: typeof ex.label === 'string' ? ex.label : label, why: 'excluded' };
      }
    }
    // Reserved to other folders and not to this one: outside this folder's pool. (The global slot
    // holding a reserved account at all is a breach the daemon repairs; it is still refused here.)
    var reservedElsewhere =
      matches.length > 0 &&
      matches.every(function (a) {
        return Array.isArray(a.ruleIds) && a.ruleIds.length > 0 && a.ruleIds.indexOf(rule.id) < 0;
      });
    if (reservedElsewhere) return { verdict: 'refuse', label: label, why: 'reserved' };
  }
  var excludedUnmatchable = rule.excluded.some(function (x) {
    return !x || typeof x.accountKey !== 'string';
  });
  if (rule.excluded.length > 0 && (live === null || excludedUnmatchable)) {
    return { verdict: 'unknown' };
  }
  var own = matches.some(function (a) {
    return Array.isArray(a.ruleIds) && a.ruleIds.indexOf(rule.id) >= 0;
  });
  return { verdict: 'accept', label: label, own: own };
}

// Claim the one-time notice for a session: true when it has not been shown in this session yet (and
// is now recorded as shown), false when it has. A session id that cannot name a file, or a marker
// that cannot be written, shows the notice rather than lose it.
function claimNotice(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return true;
  var file = path.join(NOTICES_DIR, sessionId);
  try {
    fs.mkdirSync(NOTICES_DIR, { recursive: true });
  } catch (e) {
    return true;
  }
  try {
    fs.writeFileSync(file, '', { flag: 'wx' });
  } catch (e) {
    // Only an existing marker means "already shown"; any other failure shows it.
    return !(e && e.code === 'EEXIST');
  }
  pruneNotices(file);
  return true;
}

// Drop notice markers older than a month (their sessions are long gone). Best effort: a marker that
// cannot be read or removed is simply left.
function pruneNotices(keep) {
  try {
    var now = Date.now();
    var names = fs.readdirSync(NOTICES_DIR);
    for (var i = 0; i < names.length; i++) {
      var p = path.join(NOTICES_DIR, names[i]);
      if (p === keep) continue;
      try {
        if (now - fs.statSync(p).mtimeMs > NOTICE_MARKER_MAX_AGE_MS) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
}

// A background session (claude --bg) runs under Claude Code's own background service, which marks
// its workers' environment; an interactive session carries neither mark.
function isBackgroundSession() {
  return (
    process.env.CLAUDE_CODE_SESSION_KIND === 'bg' ||
    (typeof process.env.CLAUDE_JOB_DIR === 'string' && process.env.CLAUDE_JOB_DIR.length > 0)
  );
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

  // The hook payload: its \`cwd\` is the fallback when CLAUDE_PROJECT_DIR is unset, and its
  // \`session_id\` keys the one-time notice.
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
  // CLAUDE_CONFIG_DIR. No config dir, or the main config dir, means the global (shared) slot. Any
  // OTHER config dir is unmanaged: a second Claude Code config a shell or editor exports, or the
  // profile of a rule since removed. Its login is its own, so the global slot's identity says nothing
  // about it, and it is never folded into the global slot. A config dir with no canonical form is
  // keyed as spelled, the way a profile dir with none is, so it can still match one exactly.
  // sessionConfigKey is the folderKey of CLAUDE_CONFIG_DIR, and '' for the global slot however it is
  // spelled — the key the launcher mints a global-slot relaxation token for; a token is honored only
  // when it was minted for this same slot key.
  var sessionGroup = null;
  var sessionConfigKey = '';
  var unmanagedConfig = null;
  var rawConfig = process.env.CLAUDE_CONFIG_DIR;
  if (typeof rawConfig === 'string' && rawConfig.length > 0) {
    var cfgCanon = canonicalizeFolder(rawConfig, deps);
    var cfgKey = folderKey(cfgCanon.ok ? cfgCanon.path : rawConfig, platform);
    if (cfgKey !== mainConfigKey) {
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
      if (sessionGroup === null) unmanagedConfig = cfgCanon.ok ? cfgCanon.path : rawConfig;
    }
  }

  // Resolve the project dir's binding: the longest bound folder that contains it wins (a nested
  // binding overrides its ancestor). Uses the embedded isWithin, so the boundary + case rules match
  // the TS canonicalizer exactly (C:\\research never contains C:\\research2).
  var projectBinding = null;
  for (var j = 0; j < snapshot.groups.length; j++) {
    var grp = snapshot.groups[j];
    if (!grp || !Array.isArray(grp.folders)) continue;
    for (var k = 0; k < grp.folders.length; k++) {
      var f = grp.folders[k];
      if (typeof f === 'string' && isWithin(projectDir, f, platform)) {
        if (projectBinding === null || f.length > projectBinding.folder.length) {
          projectBinding = { group: grp, folder: f };
        }
      }
    }
  }

  var sessionGroupId = sessionGroup ? sessionGroup.id : null;
  // How a refusal tells the operator to get onto the folder's own slot.
  var relaunch =
    'Exit and start it with: cctl claude' +
    '   (or set up the claude wrapper: cctl shell-init powershell)';

  // Case A on an unmanaged config dir: it is not this folder's slot, and which account it runs on is
  // not something the global slot's identity can tell, so it is refused whatever account it holds.
  // Letting it through would let a folder run on an account its rule excludes.
  if (projectBinding && unmanagedConfig !== null) {
    var reasonU =
      'cctl: ' +
      projectBinding.folder +
      ' ' +
      describeRule(projectBinding.group) +
      ', but this session runs on ' +
      unmanagedConfig +
      ', a Claude Code config dir cctl does not manage. ' +
      relaunch;
    if (honorRelaxation(process.env.CCTL_BIND_OVERRIDE, 'override', sessionConfigKey)) {
      return emitSystemMessage(reasonU);
    }
    return emitBlock(reasonU, enforce);
  }

  // Case A on the global slot: the folder accepts the global slot's account unless its rule rules it
  // out (see judgeGlobal).
  if (projectBinding && sessionGroup === null) {
    var rule = projectBinding.group;
    var judged = judgeGlobal(snapshot, rule);
    if (judged.verdict === 'accept') {
      var members = Array.isArray(rule.members) ? rule.members.join(', ') : '';
      // Nothing to tell when the rule prefers no account (it only excludes) or the global slot
      // already holds one of its own; otherwise tell it once per session.
      if (!members || judged.own || !claimNotice(payload.session_id)) process.exit(0);
      var onAccount = judged.label ? judged.label + ' from the shared pool' : 'the shared account';
      var notice =
        'cctl: ' +
        projectBinding.folder +
        ' ' +
        describeRule(rule) +
        '. This session runs on ' +
        onAccount +
        ', which this folder also accepts. ' +
        (isBackgroundSession()
          ? 'cctl moves this background session onto ' +
            members +
            ' between turns once one of them can take work.'
          : 'To use ' + members + ' here, ' + relaunch.charAt(0).toLowerCase() + relaunch.slice(1));
      return emitSystemMessage(notice);
    }
    var reasonG;
    if (judged.verdict === 'refuse') {
      var who = judged.label ? judged.label : 'an account';
      reasonG =
        'cctl: ' +
        projectBinding.folder +
        ' ' +
        describeRule(rule) +
        (judged.why === 'excluded'
          ? ' and excludes ' + who + ', the account this session runs on. '
          : ', but this session runs on ' + who + ', which is reserved to other folders. ') +
        relaunch;
    } else {
      reasonG =
        'cctl: ' +
        projectBinding.folder +
        ' ' +
        describeRule(rule) +
        ', and cctl cannot tell whether the account this session runs on is one it allows. ' +
        relaunch;
    }
    // --override relaxes it, but only via a token the launcher minted for this launch's slot; an
    // inherited env value is not honored, so the rule still applies. A honored override is visible.
    if (honorRelaxation(process.env.CCTL_BIND_OVERRIDE, 'override', sessionConfigKey)) {
      return emitSystemMessage(reasonG);
    }
    return emitBlock(reasonG, enforce);
  }

  // Case A on another rule's slot: the project dir has a folder rule, and the session runs on the
  // slot of a different rule. The reason names the slot the session is ACTUALLY on, and points at
  // cctl claude (which puts it on this folder's slot) or --override.
  if (projectBinding && projectBinding.group.id !== sessionGroupId) {
    var sFolders = Array.isArray(sessionGroup.folders) ? sessionGroup.folders.join(', ') : '';
    var reasonA =
      'cctl: ' +
      projectBinding.folder +
      ' ' +
      describeRule(projectBinding.group) +
      ', but this session runs on the folder slot of ' +
      sFolders +
      '. Exit and start it here with: cctl claude' +
      '   (or add --override to use this account here anyway)';
    if (honorRelaxation(process.env.CCTL_BIND_OVERRIDE, 'override', sessionConfigKey)) {
      return emitSystemMessage(reasonA);
    }
    return emitBlock(reasonA, enforce);
  }

  // Case B: the session runs on a rule's slot, but the project dir is outside that rule's folders.
  if (sessionGroup) {
    var within = false;
    if (Array.isArray(sessionGroup.folders)) {
      for (var m = 0; m < sessionGroup.folders.length; m++) {
        var sf = sessionGroup.folders[m];
        if (typeof sf === 'string' && isWithin(projectDir, sf, platform)) {
          within = true;
          break;
        }
      }
    }
    if (!within) {
      var folders = Array.isArray(sessionGroup.folders) ? sessionGroup.folders.join(', ') : '';
      // --account relaxes case B, but only via a token minted for this session's slot whose launch is
      // still alive; an inherited env value is not honored. A honored relaxation emits a systemMessage
      // (surfaced in interactive sessions; the launcher banner is the headless signal) so it is clear
      // the reserved account is being used outside its folders on purpose.
      if (honorRelaxation(process.env.CCTL_LAUNCH_EXPLICIT, 'explicit', sessionConfigKey)) {
        return emitSystemMessage(
          'cctl: running the folder slot of ' +
            folders +
            ' in ' +
            projectShown +
            ' — launched explicitly with --account. That slot belongs to its folders.',
        );
      }
      var reasonB =
        'cctl: this session runs on the folder slot of ' +
        folders +
        ', but ' +
        projectShown +
        ' is not one of its folders. That slot belongs to its folders. Run Claude Code ' +
        'here normally, or launch it explicitly with: cctl claude --account <account>';
      return emitBlock(reasonB, enforce);
    }
  }

  // No conflict.
  process.exit(0);
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
