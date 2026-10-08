// Tests for the per-launch relaxation token store the guard verifies against. The end-to-end proof
// that a minted token actually relaxes the guard (and a bare "1" does not) lives in bindGuard.test.ts;
// here we pin the file contract in isolation: where records land, their shape, single-token removal,
// and age-based pruning of a crashed launcher's leftovers.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BIND_TOKEN_DIR_NAME,
  BIND_TOKEN_MAX_AGE_MS,
  BIND_TOKEN_PATTERN,
  BIND_TOKEN_UNPARSEABLE_GRACE_MS,
  bindTokensDir,
  cleanupBindTokens,
  isLauncherAlive,
  mintBindToken,
  removeBindToken,
  type BindTokenRecord,
} from './bindToken.js';

/** A pid that is (almost) certainly not a live process, for exercising the liveness prune/honor. */
const DEAD_PID = 2_000_000_000;

describe('bindTokensDir', () => {
  it('sits beside the snapshot file', () => {
    const dir = bindTokensDir(join('C:', 'data', 'claude-control', 'folder-bindings.json'));
    expect(dir).toBe(join('C:', 'data', 'claude-control', BIND_TOKEN_DIR_NAME));
  });
});

describe('mint / remove / cleanup', () => {
  let root: string;
  let tokensDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-token-'));
    tokensDir = join(root, BIND_TOKEN_DIR_NAME);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('mints a hex token and writes a matching record (with the launcher pid)', () => {
    const token = mintBindToken({
      tokensDir,
      kind: 'override',
      profileKey: 'k1',
      launcherPid: 4321,
    });
    expect(BIND_TOKEN_PATTERN.test(token)).toBe(true);
    const record = JSON.parse(
      readFileSync(join(tokensDir, `${token}.json`), 'utf8'),
    ) as BindTokenRecord;
    expect(record.v).toBe(1);
    expect(record.kind).toBe('override');
    expect(record.profileKey).toBe('k1');
    expect(record.launcherPid).toBe(4321);
    expect(typeof record.createdAtMs).toBe('number');
  });

  it('defaults the launcher pid to this process', () => {
    const token = mintBindToken({ tokensDir, kind: 'override', profileKey: '' });
    const record = JSON.parse(
      readFileSync(join(tokensDir, `${token}.json`), 'utf8'),
    ) as BindTokenRecord;
    expect(record.launcherPid).toBe(process.pid);
  });

  it('mint leaves no .tmp file behind (writes atomically)', () => {
    mintBindToken({ tokensDir, kind: 'override', profileKey: '' });
    const leftovers = readdirSync(tokensDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('removeBindToken deletes exactly that token', () => {
    const a = mintBindToken({ tokensDir, kind: 'explicit', profileKey: '' });
    const b = mintBindToken({ tokensDir, kind: 'explicit', profileKey: '' });
    removeBindToken(tokensDir, a);
    expect(existsSync(join(tokensDir, `${a}.json`))).toBe(false);
    expect(existsSync(join(tokensDir, `${b}.json`))).toBe(true);
  });

  it('removeBindToken ignores a non-token value (never touches unrelated files)', () => {
    const b = mintBindToken({ tokensDir, kind: 'explicit', profileKey: '' });
    // A path-traversal-shaped value must be rejected by the pattern, not acted on.
    removeBindToken(tokensDir, '../../evil');
    expect(existsSync(join(tokensDir, `${b}.json`))).toBe(true);
  });

  it('cleanup reaps a record whose launcher is dead, but keeps one whose launcher is alive', () => {
    // A live-launcher token (this process) and a dead-launcher token.
    const live = mintBindToken({
      tokensDir,
      kind: 'override',
      profileKey: '',
      launcherPid: process.pid,
    });
    const dead = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const deadRecord: BindTokenRecord = {
      v: 1,
      kind: 'override',
      profileKey: '',
      launcherPid: DEAD_PID,
      createdAtMs: Date.now(),
    };
    writeFileSync(join(tokensDir, `${dead}.json`), JSON.stringify(deadRecord), 'utf8');

    cleanupBindTokens({ tokensDir });

    expect(existsSync(join(tokensDir, `${live}.json`))).toBe(true);
    expect(existsSync(join(tokensDir, `${dead}.json`))).toBe(false);
  });

  it('cleanup keeps a live-launcher token no matter how old it is', () => {
    const now = 1_000_000_000_000;
    const token = mintBindToken({
      tokensDir,
      kind: 'override',
      profileKey: '',
      launcherPid: process.pid,
      now: () => now,
    });
    // Far past the legacy age backstop: a live launcher must still keep its relaxation (a long
    // interactive session), so the age cap never applies to a token with a live pid.
    cleanupBindTokens({ tokensDir, now: () => now + BIND_TOKEN_MAX_AGE_MS * 100 });
    expect(existsSync(join(tokensDir, `${token}.json`))).toBe(true);
  });

  it('cleanup reaps a pid-less legacy record only past the age backstop', () => {
    const now = 1_000_000_000_000;
    const legacyToken = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    // A legacy record with no launcherPid.
    const legacy = { v: 1, kind: 'override', profileKey: '', createdAtMs: now };
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, `${legacyToken}.json`), JSON.stringify(legacy), 'utf8');

    cleanupBindTokens({ tokensDir, now: () => now + 1 }); // fresh: kept
    expect(existsSync(join(tokensDir, `${legacyToken}.json`))).toBe(true);

    cleanupBindTokens({ tokensDir, now: () => now + BIND_TOKEN_MAX_AGE_MS + 1 }); // aged out
    expect(existsSync(join(tokensDir, `${legacyToken}.json`))).toBe(false);
  });

  it('cleanup does NOT delete a fresh unparseable file (a peer mint in flight)', () => {
    mkdirSync(tokensDir, { recursive: true });
    const partial = join(tokensDir, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json');
    writeFileSync(partial, '{"v":1,"kind":"over', 'utf8'); // a truncated mid-write file
    // A concurrent mint's cleanup must not destroy it purely because it will not parse.
    mintBindToken({ tokensDir, kind: 'explicit', profileKey: '' });
    expect(existsSync(partial)).toBe(true);
  });

  it('cleanup reaps an unparseable file only once it is older than the grace window', () => {
    mkdirSync(tokensDir, { recursive: true });
    const garbage = join(tokensDir, 'cccccccccccccccccccccccccccccccc.json');
    writeFileSync(garbage, '{ not json', 'utf8');
    // Backdate its mtime past the grace window so cleanup treats it as a genuine dead leftover.
    const old = Date.now() / 1000 - (BIND_TOKEN_UNPARSEABLE_GRACE_MS / 1000 + 5);
    utimesSync(garbage, old, old);
    cleanupBindTokens({ tokensDir });
    expect(existsSync(garbage)).toBe(false);
  });

  it('cleanup on a missing dir is a silent no-op', () => {
    expect(() => cleanupBindTokens({ tokensDir: join(root, 'nope') })).not.toThrow();
  });
});

describe('isLauncherAlive', () => {
  it('is true for this process and false for a plainly dead pid / bad input', () => {
    expect(isLauncherAlive(process.pid)).toBe(true);
    expect(isLauncherAlive(DEAD_PID)).toBe(false);
    expect(isLauncherAlive(0)).toBe(false);
    expect(isLauncherAlive(-1)).toBe(false);
    expect(isLauncherAlive(Number.NaN)).toBe(false);
  });
});
