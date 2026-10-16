// The view's real sources over a temp vault and daemon database: each pane must degrade on its own,
// so one unreadable file never blanks a pane whose data lives somewhere else.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  InsecurePassthroughProtector,
  SwitchEngine,
  defaultPaths,
  noopLogger,
  type CredentialBundle,
} from '@claude-control/switch-engine';
import { Store } from '@claude-control/daemon';
import { createTuiSources } from './sources.js';

// The data dir (vault, daemon.db) is moved into a temp root for every test.
const pathsIo = vi.hoisted(() => ({ dataRoot: '' }));
vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@claude-control/switch-engine')>();
  return {
    ...real,
    defaultPaths: (...args: Parameters<typeof real.defaultPaths>) => ({
      ...real.defaultPaths(...args),
      vaultDir: join(pathsIo.dataRoot, 'claude-control', 'vault'),
    }),
  };
});

/** A login far from expiry. */
function login(name: string): CredentialBundle {
  return {
    claudeAiOauth: {
      accessToken: `at-${name}`,
      refreshToken: `rt-${name}`,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    },
    oauthAccount: { accountUuid: `uuid-${name}`, emailAddress: `${name}@example.com` },
  };
}

describe('createTuiSources: each pane degrades on its own', () => {
  let root: string;
  let dataDir: string;
  let engine: SwitchEngine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-tui-sources-'));
    pathsIo.dataRoot = root;
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
    await mkdir(join(root, 'claude'), { recursive: true });
    const paths = defaultPaths();
    dataDir = dirname(paths.vaultDir);
    engine = new SwitchEngine({
      paths,
      protector: new InsecurePassthroughProtector(),
      logger: noopLogger,
    });
    await engine.addAccount('work', login('work'));
    await engine.addAccount('home', login('home'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    pathsIo.dataRoot = '';
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const sourcesOver = () =>
    createTuiSources({
      engine,
      readOutages: () =>
        Promise.resolve({ episodes: [], open: [], logPath: join(dataDir, 'exhaustion.jsonl') }),
    });

  it('lists the accounts from the vault when the usage database cannot be read', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'daemon.db'), Buffer.alloc(8192, 0x5a));
    const sources = sourcesOver();
    try {
      const snapshot = await sources.load(Date.now());
      expect(snapshot.accounts.ok).toBe(true);
      if (snapshot.accounts.ok) {
        expect(snapshot.accounts.value.map((a) => a.label).sort()).toEqual(['home', 'work']);
      }
      expect(snapshot.usageError).toMatch(/not a database/);
    } finally {
      sources.close?.();
    }
  });

  it('lists the sessions from the daemon database when the vault cannot be read', async () => {
    const store = new Store(join(dataDir, 'daemon.db'));
    store.upsertSession({
      id: 'sess-1',
      kind: 'interactive',
      state: 'active',
      accountId: null,
      json: JSON.stringify({ label: 'planning' }),
      updatedAtMs: Date.now(),
    });
    store.close();
    await writeFile(join(dataDir, 'vault', 'accounts.json'), '{"accounts": [');
    const sources = sourcesOver();
    try {
      const snapshot = await sources.load(Date.now());
      expect(snapshot.accounts.ok).toBe(false);
      expect(snapshot.sessions.ok).toBe(true);
      if (snapshot.sessions.ok) expect(snapshot.sessions.value.rows[0]?.label).toBe('planning');
    } finally {
      sources.close?.();
    }
  });

  it('reads through one open database for as long as the view runs', async () => {
    // A poll that carried no weekly reading (a 429, say): its row keeps a null weekly column for
    // good, which is what used to make every open take the write lock.
    const seed = new Store(join(dataDir, 'daemon.db'));
    const [work] = await engine.listAccounts();
    seed.insertUsageSnapshot({
      accountId: work!.id,
      fetchedAtMs: Date.now() - 60_000,
      source: 'live',
      json: JSON.stringify({
        accountId: work!.id,
        label: 'work',
        active: false,
        source: 'live',
        fetchedAtMs: Date.now() - 60_000,
        limits: [],
        error: 'http_429',
      }),
    });
    seed.close();
    const sources = sourcesOver();
    try {
      await sources.load(Date.now());
      // Another connection holds the write lock: a reader that reopened (and migrated) the
      // database on every read would wait on it; one that stays open does not.
      const holder = new Store(join(dataDir, 'daemon.db'));
      const raw = (holder as unknown as { db: { exec(sql: string): void } }).db;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const started = Date.now();
        const snapshot = await sources.load(Date.now());
        expect(snapshot.accounts.ok).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        raw.exec('ROLLBACK');
        holder.close();
      }
    } finally {
      sources.close?.();
    }
  });
});
