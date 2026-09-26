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
} from '@claude-control/switch-engine';

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
 * The script implements spec §9 exactly:
 *   - session slot = the group whose canonical profileDir equals the session's canonical
 *     CLAUDE_CONFIG_DIR, else the global slot (outside every group).
 *   - (A) the project dir is bound to a group the session is NOT running on -> block with the exact
 *     reason text, unless CCTL_BIND_OVERRIDE=1 (the launcher's --override), which allows with a
 *     systemMessage warning instead.
 *   - (B) the session runs on a group's slot but the project dir is not within that group's folders
 *     -> block, unless CCTL_LAUNCH_EXPLICIT=1 (the launcher's --account), which allows silently.
 *   - enforce = env CCTL_BIND_ENFORCE (block|warn|off) ?? snapshot.enforce ?? 'block'. warn never
 *     blocks and emits the same text as a systemMessage; off exits 0 silently.
 *   - any error / missing / unparseable / unknown-schema snapshot -> exit 0 with one stderr line.
 */
export function generateBindGuardSource(opts: { snapshotPath: string }): string {
  // The exact block reason for case A (spec §9). Kept as a single source-of-truth constant on the
  // TS side too so the test can assert the generated script reproduces it byte-for-byte.
  return `'use strict';
// claude-control bind guard (written by cctl; safe to delete — it is re-created on the next
// bind / daemon start). A second UserPromptSubmit hook that enforces folder-account bindings.
// Dependency-free CommonJS. Fails OPEN (exit 0) on any error so it can never lock a session out.
const fs = require('fs');

${embeddableFolderPathSource()}

${embeddableSanitizeSource()}

// The non-secret folder-bindings snapshot, baked in at install time.
const SNAPSHOT_PATH = ${JSON.stringify(opts.snapshotPath)};

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

  // The hook payload is only needed for its \`cwd\` fallback when CLAUDE_PROJECT_DIR is unset.
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

  // enforce: env overrides the snapshot's mode; default block. off is silent.
  var enforce =
    readValidEnforce(process.env.CCTL_BIND_ENFORCE) || readValidEnforce(snapshot.enforce) || 'block';
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
  // CLAUDE_CONFIG_DIR. No config dir, or no match, means the global (shared) slot.
  var sessionGroup = null;
  var rawConfig = process.env.CLAUDE_CONFIG_DIR;
  if (typeof rawConfig === 'string' && rawConfig.length > 0) {
    var cfgCanon = canonicalizeFolder(rawConfig, deps);
    if (cfgCanon.ok) {
      var cfgKey = folderKey(cfgCanon.path, platform);
      for (var i = 0; i < snapshot.groups.length; i++) {
        var g = snapshot.groups[i];
        if (g && typeof g.profileDir === 'string') {
          var pc = canonicalizeFolder(g.profileDir, deps);
          var pk = pc.ok ? folderKey(pc.path, platform) : folderKey(g.profileDir, platform);
          if (pk === cfgKey) {
            sessionGroup = g;
            break;
          }
        }
      }
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

  // Case A: the project dir is bound to a group, and the session is not on that group's slot.
  if (projectBinding && projectBinding.group.id !== sessionGroupId) {
    var members = Array.isArray(projectBinding.group.members)
      ? projectBinding.group.members.join(', ')
      : '';
    var reasonA =
      'cctl: ' +
      projectBinding.folder +
      ' is bound to ' +
      members +
      ', but this session runs on the shared account. Exit and start it with: cctl claude' +
      '   (or set up the claude wrapper: cctl shell-init powershell)';
    // --override (CCTL_BIND_OVERRIDE=1) allows the session but warns, in every enforce mode.
    if (process.env.CCTL_BIND_OVERRIDE === '1') return emitSystemMessage(reasonA);
    return emitBlock(reasonA, enforce);
  }

  // Case B: the session runs on a group's slot, but the project dir is outside that group's folders.
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
      // --account (CCTL_LAUNCH_EXPLICIT=1) is a deliberate launch of this account here: allowed.
      if (process.env.CCTL_LAUNCH_EXPLICIT === '1') process.exit(0);
      var folders = Array.isArray(sessionGroup.folders) ? sessionGroup.folders.join(', ') : '';
      var reasonB =
        'cctl: this session runs on the account bound to ' +
        folders +
        ', but ' +
        projectDir +
        ' is not one of its folders. That account is reserved to its folders. Run Claude Code ' +
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
