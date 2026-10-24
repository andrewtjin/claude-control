// The enforcement guard and parallel sessions (`cctl claude --account`): a session whose config dir
// is a parallel-session profile runs wherever it was started — in a folder ruled by another rule, as
// a session an alias rule names, in a folder no rule covers — with no token and nothing printed. A
// guard built before parallel sessions sees the same group without its kind; it then blocks unless
// the launcher's tokens are honored, which is why the launcher still mints them.
//
// Spawned the way Claude Code runs it: the generated script under the real node binary, a payload on
// stdin, a real snapshot on disk.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeFolder, folderKey, snapshotIdentityKey } from '@claude-control/switch-engine';
import { bindGuardPath, writeBindGuard } from './bindGuard.js';
import { bindTokensDir, mintBindToken } from './bindToken.js';

interface GuardResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the guard with a payload on stdin and the given env. */
function runGuard(
  scriptPath: string,
  payload: string,
  env: NodeJS.ProcessEnv,
): Promise<GuardResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** Canonicalize a real path as the engine and the guard do. */
function canon(p: string): string {
  const r = canonicalizeFolder(p, {
    platform: process.platform,
    cwd: process.cwd(),
    realpath: (x) => realpathSync.native(x),
  });
  if (!r.ok) throw new Error(`could not canonicalize ${p}: ${r.reason}`);
  return r.path;
}

describe('the guard and a parallel session', () => {
  let root: string;
  let scriptPath: string;
  let snapshotPath: string;
  let ruled: string;
  let aliasFolder: string;
  let unruled: string;
  let folderProfile: string;
  let leaseProfile: string;

  /** A snapshot with a folder rule on `ruled`, an alias rule "x" in `aliasFolder`, and the parallel
   *  session of W; `kind` false writes the session's group as a guard older than parallel sessions
   *  reads it (no kind). */
  async function writeSnapshot(kind = true): Promise<void> {
    const snapshot = {
      schemaVersion: 1,
      generation: 1,
      enforce: 'block',
      mainConfigDir: canon(root),
      mainIdentityFile: join(root, '.claude.json'),
      accounts: [
        { label: 'A', accountKey: snapshotIdentityKey('uuid-a'), ruleIds: ['r1'] },
        { label: 'W', accountKey: snapshotIdentityKey('uuid-w'), ruleIds: ['session-w'] },
      ],
      groups: [
        {
          id: 'r1',
          label: 'repo',
          profileDir: folderProfile,
          folders: [ruled],
          members: ['A'],
          excluded: [],
        },
        {
          id: 'r2',
          label: 'x',
          profileDir: join(root, 'profiles', 'r2'),
          folders: [],
          members: ['A'],
          excluded: [],
          aliases: [{ folder: aliasFolder, aliasKey: 'x', alias: 'x' }],
        },
        {
          id: 'session-w',
          label: 'W',
          profileDir: leaseProfile,
          folders: [],
          members: ['W'],
          excluded: [],
          ...(kind ? { kind: 'lease' } : {}),
        },
      ],
    };
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
  }

  /** The env of a session on the parallel-session profile, in `project`. */
  function leaseEnv(project: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const e = { ...process.env };
    delete e.CCTL_BIND_OVERRIDE;
    delete e.CCTL_LAUNCH_EXPLICIT;
    delete e.CCTL_BIND_ENFORCE;
    return { ...e, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: leaseProfile, ...extra };
  }

  const payload = (title?: string): string =>
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's-1',
      ...(title !== undefined ? { session_title: title } : {}),
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-guard-lease-'));
    scriptPath = bindGuardPath(root);
    snapshotPath = join(root, 'folder-bindings.json');
    for (const d of [
      'repo',
      'aliased',
      'free',
      join('profiles', 'r1'),
      join('profiles', 'r2'),
      join('profiles', 'session-w'),
    ]) {
      await mkdir(join(root, d), { recursive: true });
    }
    ruled = canon(join(root, 'repo'));
    aliasFolder = canon(join(root, 'aliased'));
    unruled = canon(join(root, 'free'));
    folderProfile = canon(join(root, 'profiles', 'r1'));
    leaseProfile = canon(join(root, 'profiles', 'session-w'));
    await writeBindGuard(scriptPath, snapshotPath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('runs in a folder another rule covers, with no token, silently', async () => {
    await writeSnapshot();
    const r = await runGuard(scriptPath, payload(), leaseEnv(ruled));
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('runs as a session an alias rule names, silently', async () => {
    await writeSnapshot();
    const r = await runGuard(scriptPath, payload('x'), leaseEnv(aliasFolder));
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('runs in a folder no rule covers, silently', async () => {
    await writeSnapshot();
    const r = await runGuard(scriptPath, payload(), leaseEnv(unruled));
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it("an older guard's view (no kind) blocks without tokens and lets the launcher's tokens through", async () => {
    await writeSnapshot(false);
    const blocked = await runGuard(scriptPath, payload(), leaseEnv(ruled));
    expect(blocked.stdout).toContain('"decision":"block"');
    const key = folderKey(leaseProfile, process.platform);
    const tokensDir = bindTokensDir(snapshotPath);
    const override = mintBindToken({ tokensDir, kind: 'override', profileKey: key });
    const explicit = mintBindToken({ tokensDir, kind: 'explicit', profileKey: key });
    const inRuled = await runGuard(
      scriptPath,
      payload(),
      leaseEnv(ruled, { CCTL_BIND_OVERRIDE: override, CCTL_LAUNCH_EXPLICIT: explicit }),
    );
    expect(inRuled.stdout).not.toContain('"decision":"block"');
    const inUnruled = await runGuard(
      scriptPath,
      payload(),
      leaseEnv(unruled, { CCTL_BIND_OVERRIDE: override, CCTL_LAUNCH_EXPLICIT: explicit }),
    );
    expect(inUnruled.stdout).not.toContain('"decision":"block"');
  });
});
