// The view's real sources over a temp vault and daemon database: each pane must degrade on its own,
// so one unreadable file never blanks a pane whose data lives somewhere else.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  InsecurePassthroughProtector,
  SwitchEngine,
  Vault,
  defaultPaths,
  leaseRuleId,
  noopLogger,
  ruleSlotId,
  type CredentialBundle,
  type LeaseHolder,
} from '@claude-control/switch-engine';
import { Store } from '@claude-control/daemon';
import { AccountActionError } from '../accountActions.js';
import { createTuiSources } from './sources.js';
import type { TuiAccount } from './types.js';

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

// Whether a parallel session's processes still run is a process query, which these tests do not
// make: the check an action runs before a session can refuse it is recorded instead.
const leaseIo = vi.hoisted(() => ({ swept: [] as string[] }));
vi.mock('../leaseCli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../leaseCli.js')>()),
  sweepBeforeLeaseRefusal: (_engine: unknown, _paths: unknown, accountId: string) => {
    leaseIo.swept.push(accountId);
    return Promise.resolve();
  },
}));

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

describe('createTuiSources: an account a parallel session holds', () => {
  let root: string;
  let paths: ReturnType<typeof defaultPaths>;
  let engine: SwitchEngine;
  let work: { id: string };
  let sources: ReturnType<typeof createTuiSources>;

  /** Two terminals on a parallel session, as `cctl claude --account` records them. */
  const launcher = (pid: number): LeaseHolder => ({
    pid,
    start: 0,
    host: 'box',
    platform: 'win32',
    role: 'launcher',
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-tui-lease-'));
    pathsIo.dataRoot = root;
    leaseIo.swept = [];
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
    await mkdir(join(root, 'claude'), { recursive: true });
    paths = defaultPaths();
    const protector = new InsecurePassthroughProtector();
    engine = new SwitchEngine({ paths, protector, logger: noopLogger });
    work = await engine.addAccount('work', login('work'));
    const home = await engine.addAccount('home', login('home'));
    const spare = await engine.addAccount('spare', login('spare'));
    await engine.addAccount('extra', login('extra'));
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await engine.includeInFolder(repo, [home.id], { label: 'Client' });
    // work's parallel session, its slot seated as the claim seats it.
    await new Vault(paths.vaultDir, protector).createRule({
      folders: [],
      include: [work.id],
      lease: { holders: [launcher(4101), launcher(4102)], startedAtMs: Date.now() },
    });
    await engine.activate(work.id, { slot: ruleSlotId(leaseRuleId(work.id)), lease: true });
    // A folder that only excludes spare: its slot inherits the one shared account free for it.
    const other = join(root, 'other');
    await mkdir(other, { recursive: true });
    await engine.excludeInFolder(other, [spare.id], { label: 'Other' });
    const dataDir = dirname(paths.vaultDir);
    sources = createTuiSources({
      engine,
      readOutages: () =>
        Promise.resolve({ episodes: [], open: [], logPath: join(dataDir, 'exhaustion.jsonl') }),
    });
  });
  afterEach(async () => {
    sources.close?.();
    vi.unstubAllEnvs();
    pathsIo.dataRoot = '';
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** The account rows of a fresh read, by label. */
  async function rows(): Promise<Map<string, TuiAccount>> {
    const snapshot = await sources.load(Date.now());
    expect(snapshot.accounts.ok).toBe(true);
    return new Map((snapshot.accounts.ok ? snapshot.accounts.value : []).map((a) => [a.label, a]));
  }

  /** work's parallel session is as it was started: both holders, its slot on work, and the rules
   *  file at the schema a parallel session needs. */
  async function sessionIntact(): Promise<void> {
    const rule = (await engine.listRules()).find((r) => r.id === leaseRuleId(work.id));
    expect(rule?.lease?.holders).toEqual([launcher(4101), launcher(4102)]);
    expect(await engine.getActiveId(ruleSlotId(leaseRuleId(work.id)))).toBe(work.id);
    const file = JSON.parse(await readFile(join(paths.vaultDir, 'groups.json'), 'utf8')) as {
      schemaVersion: number;
    };
    expect(file.schemaVersion).toBe(4);
  }

  it('is tagged as a parallel session, never as a folder, beside a folder rule named by its label', async () => {
    const byLabel = await rows();
    expect(byLabel.get('work')).toMatchObject({
      folders: [],
      extraTags: [{ text: 'parallel session x2', tone: 'info' }],
    });
    expect(byLabel.get('home')).toMatchObject({ folders: ['Client'], extraTags: [] });
    // A shared account live in a folder's slot is named by that rule's label, not its slot id.
    expect(byLabel.get('extra')).toMatchObject({ folders: ['Other'], extraTags: [] });
    // The folders pane lists the operator's rules only.
    const snapshot = await sources.load(Date.now());
    expect(snapshot.folders.ok && snapshot.folders.value.rules.map((r) => r.label)).toEqual([
      'Client',
      'Other',
    ]);
  });

  it("refuses a switch to it and its removal in the engine's words, and changes nothing", async () => {
    const global = await engine.getActiveId('global');
    const switched = await sources.switchAccount(work.id).catch((err: unknown) => err);
    expect(switched).toBeInstanceOf(AccountActionError);
    expect((switched as AccountActionError).code).toBe('slot_refused');
    expect((switched as AccountActionError).message).toMatch(
      /^account "work" is in use by a parallel session on 2 terminals .*; it rejoins the pool when the last of them exits$/,
    );
    const removed = await sources.removeAccount(work.id, 'work').catch((err: unknown) => err);
    expect(removed).toBeInstanceOf(AccountActionError);
    expect((removed as AccountActionError).code).toBe('leased');
    expect((removed as AccountActionError).message).toMatch(
      /^account "work" is in use by a parallel session .*; exit them first$/,
    );
    // Each first checked whether the session's processes still run.
    expect(leaseIo.swept).toEqual([work.id, work.id]);
    expect(await engine.getActiveId('global')).toBe(global);
    expect((await engine.listAllAccounts()).map((a) => a.label).sort()).toEqual([
      'extra',
      'home',
      'spare',
      'work',
    ]);
    await sessionIntact();
  });

  it('renames it and bars it from auto-switch with the session left whole', async () => {
    expect((await sources.renameAccount(work.id, 'job')).message).toContain('Renamed work to job');
    expect((await sources.setExcluded(work.id, true)).message).toBe(
      'Excluded job from auto-switch (manual switches still work).',
    );
    await sessionIntact();
    expect((await rows()).get('job')).toMatchObject({
      excluded: true,
      folders: [],
      extraTags: [{ text: 'parallel session x2', tone: 'info' }],
    });
  });
});
