// Tests for the per-launch relaxation token store the guard verifies against. The end-to-end proof
// that a minted token actually relaxes the guard (and a bare "1" does not) lives in bindGuard.test.ts;
// here we pin the file contract in isolation: where records land, their shape, single-token removal,
// and age-based pruning of a crashed launcher's leftovers.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BIND_TOKEN_DIR_NAME,
  BIND_TOKEN_MAX_AGE_MS,
  BIND_TOKEN_PATTERN,
  bindTokensDir,
  cleanupBindTokens,
  mintBindToken,
  removeBindToken,
  type BindTokenRecord,
} from './bindToken.js';

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

  it('mints a hex token and writes a matching record', () => {
    const token = mintBindToken({ tokensDir, kind: 'override', profileKey: 'k1' });
    expect(BIND_TOKEN_PATTERN.test(token)).toBe(true);
    const record = JSON.parse(
      readFileSync(join(tokensDir, `${token}.json`), 'utf8'),
    ) as BindTokenRecord;
    expect(record.v).toBe(1);
    expect(record.kind).toBe('override');
    expect(record.profileKey).toBe('k1');
    expect(typeof record.createdAtMs).toBe('number');
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

  it('cleanup prunes records older than the max age but keeps fresh ones', () => {
    const now = 1_000_000_000_000;
    const fresh = mintBindToken({ tokensDir, kind: 'override', profileKey: '', now: () => now });
    // Hand-write a stale record (createdAtMs well past the age cap).
    const staleToken = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const stale: BindTokenRecord = {
      v: 1,
      kind: 'override',
      profileKey: '',
      createdAtMs: now - BIND_TOKEN_MAX_AGE_MS - 1,
    };
    writeFileSync(join(tokensDir, `${staleToken}.json`), JSON.stringify(stale), 'utf8');

    cleanupBindTokens({ tokensDir, now: () => now });

    expect(existsSync(join(tokensDir, `${fresh}.json`))).toBe(true);
    expect(existsSync(join(tokensDir, `${staleToken}.json`))).toBe(false);
  });

  it('mint prunes an unparseable leftover record', () => {
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, 'garbage.json'), '{ not json', 'utf8');
    mintBindToken({ tokensDir, kind: 'override', profileKey: '' });
    expect(existsSync(join(tokensDir, 'garbage.json'))).toBe(false);
  });

  it('cleanup on a missing dir is a silent no-op', () => {
    expect(() => cleanupBindTokens({ tokensDir: join(root, 'nope') })).not.toThrow();
  });
});
