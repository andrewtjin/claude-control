// The engine side of moving accounts between machines: reading the freshest credentials of an
// account (exportBundle), storing an account that comes without credentials (addPendingAccount),
// and writing brought credentials over a stored account only when they are the better copy
// (importBundle).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { RefreshError, UnknownAccountError, VaultError } from './errors.js';
import type {
  ClaudeOauth,
  CredentialBundle,
  ImportRuleSpec,
  ImportRuleVerdict,
  OauthAccount,
  RuleScopeRef,
} from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  live: CredentialStore;
}

/** A sandboxed engine over a fresh vault, with a refresh that would show up in any token it
 *  touched (none of these verbs may refresh over the network). */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-transfer-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const clock = (): number => NOW;
  const engine = new SwitchEngine({
    paths,
    protector,
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) =>
      Promise.resolve({ ...cur, accessToken: 'NETWORK-' + cur.accessToken, expiresAt: NOW + HOUR }),
    clock,
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
  });
  return {
    paths,
    engine,
    vault: new Vault(paths.vaultDir, protector, clock),
    live: new CredentialStore(paths),
  };
}

function bundle(
  access: string,
  uuid: string,
  expiresAt: number,
  refresh = 'r-' + access,
): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt },
    oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.com` },
  };
}

/** Plant a later rotation of `uuid`'s login in the global live files, as a running session
 *  refreshing it would. */
async function rotateLive(
  h: Harness,
  access: string,
  uuid: string,
  expiresAt: number,
): Promise<void> {
  await h.live.writeLiveCredentials({
    accessToken: access,
    refreshToken: 'r-' + access,
    expiresAt,
  });
  await h.live.writeOauthAccount({ accountUuid: uuid, emailAddress: `${uuid}@x.com` });
}

describe('exportBundle', () => {
  it('returns the stored credentials of an account that is not live', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    const out = await h.engine.exportBundle(a.id);
    expect(out.claudeAiOauth.accessToken).toBe('A1');
    expect(out.oauthAccount?.accountUuid).toBe('u-work');
  });

  it('adopts a live rotation first, so the copy does not carry a spent refresh token', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    await rotateLive(h, 'A2', 'u-work', NOW + 5 * HOUR);

    const out = await h.engine.exportBundle(a.id);
    expect(out.claudeAiOauth.accessToken).toBe('A2');
    expect(out.claudeAiOauth.refreshToken).toBe('r-A2');
    // Adopted into the vault too, not just handed out.
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A2');
  });

  it('never refreshes over the network, even an expired token', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('OLD', 'u-work', NOW - HOUR));
    const out = await h.engine.exportBundle(a.id);
    expect(out.claudeAiOauth.accessToken).toBe('OLD');
  });

  it('refuses an unknown account', async () => {
    const h = await harness();
    await expect(h.engine.exportBundle('nope')).rejects.toBeInstanceOf(UnknownAccountError);
  });
});

describe('addPendingAccount', () => {
  it('stores a quarantined row with its identity and no bundle', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('home', {
      accountUuid: 'u-home',
      emailAddress: 'home@x.com',
    });
    expect(row).toMatchObject({
      label: 'home',
      accountUuid: 'u-home',
      emailAddress: 'home@x.com',
      quarantined: true,
    });
    expect(row.quarantineReason).toContain('cctl accounts relogin');
    expect(existsSync(join(h.paths.vaultDir, row.id, 'cred.enc'))).toBe(false);
    await expect(h.vault.readBundle(row.id)).rejects.toBeInstanceOf(VaultError);
    // Never a switch target while it has no login.
    await expect(h.engine.activate(row.id)).rejects.toThrow(/quarantined/);
  });

  it('refuses a label or a login already stored', async () => {
    const h = await harness();
    await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await expect(h.engine.addPendingAccount('WORK', { accountUuid: 'u-other' })).rejects.toThrow(
      /already refers to/,
    );
    await expect(h.engine.addPendingAccount('other', { accountUuid: 'u-work' })).rejects.toThrow(
      /already stored/,
    );
  });

  it('is filled by a re-login of the same account, and refuses a different one', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('home', { accountUuid: 'u-home' });
    const capture = join(h.paths.claudeDir, '..', 'capture');
    await mkdir(capture, { recursive: true });
    const store = new CredentialStore({
      claudeDir: capture,
      credentialsPath: join(capture, '.credentials.json'),
      claudeJsonPath: join(capture, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials(bundle('X', 'u-intruder', NOW + HOUR).claudeAiOauth);
    await store.writeOauthAccount({ accountUuid: 'u-intruder' });
    await expect(h.engine.reloginFromConfigDir(row.id, capture)).rejects.toBeInstanceOf(
      RefreshError,
    );

    await store.writeLiveCredentials(bundle('H1', 'u-home', NOW + HOUR).claudeAiOauth);
    await store.writeOauthAccount({ accountUuid: 'u-home', emailAddress: 'home@x.com' });
    const { account } = await h.engine.reloginFromConfigDir(row.id, capture);
    expect(account.id).toBe(row.id);
    expect(account.quarantined).toBe(false);
    expect((await h.vault.readBundle(row.id)).claudeAiOauth.accessToken).toBe('H1');
  });
});

describe('importBundle', () => {
  it('replaces the stored credentials with newer ones, keeping the id', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + 3 * HOUR));
    expect(res).toEqual({ replaced: true, reason: 'newer', healedLiveLogin: false });
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('B1');
    expect((await h.engine.listAllAccounts()).map((x) => x.id)).toEqual([a.id]);
  });

  it('keeps stored credentials that are as new or newer, writing nothing', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + 3 * HOUR));
    for (const expiresAt of [NOW + HOUR, NOW + 3 * HOUR]) {
      const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', expiresAt));
      expect(res).toEqual({ replaced: false, reason: 'stored_newer', healedLiveLogin: false });
    }
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A1');
  });

  it('replaces the credentials of a quarantined account even when they are older, and lifts the quarantine', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + 3 * HOUR));
    await h.vault.quarantine(a.id, 'refresh token died');
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + HOUR));
    expect(res.replaced).toBe(true);
    expect(res.reason).toBe('quarantined');
    expect((await h.vault.getAccount(a.id))?.quarantined).toBe(false);
  });

  it('fills an account that waits for a login', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('home', { accountUuid: 'u-home' });
    const res = await h.engine.importBundle(row.id, bundle('H1', 'u-home', NOW + HOUR));
    expect(res.reason).toBe('quarantined');
    expect((await h.vault.readBundle(row.id)).claudeAiOauth.accessToken).toBe('H1');
  });

  it('compares against a live rotation, not the older vault copy', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    await rotateLive(h, 'A2', 'u-work', NOW + 6 * HOUR);
    // Newer than the vault's copy, older than the live one: the live one wins.
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + 3 * HOUR));
    expect(res.replaced).toBe(false);
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A2');
  });

  it('writes newer credentials live too when the account is in use here', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + 3 * HOUR));
    expect(res).toEqual({ replaced: true, reason: 'newer', healedLiveLogin: true });
    expect((await h.live.readLiveCredentials())?.accessToken).toBe('B1');
  });

  it('refuses credentials of another login, writing nothing', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await expect(
      h.engine.importBundle(a.id, bundle('EVIL', 'u-other', NOW + 9 * HOUR)),
    ).rejects.toThrow("the tokens were not replaced: the file's tokens belong to another login");
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A1');
  });
});

/** The engine's own vault, for a test that has to make one read of it fail. */
function vaultOf(engine: SwitchEngine): Vault {
  return (engine as unknown as { vault: Vault }).vault;
}

/** A real folder beside the sandbox's vault, for a rule. */
async function ruleFolder(h: Harness, name: string): Promise<string> {
  const dir = join(h.paths.claudeDir, '..', name);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('importBundle and what the stored copy says', () => {
  it('refuses, writing nothing, when the stored copy cannot be read for a passing reason', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A2', 'u-work', NOW + 5 * HOUR));
    const vault = vaultOf(h.engine);
    const read = vault.readBundle.bind(vault);
    let failNext = true;
    vault.readBundle = (id: string) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(Object.assign(new Error('resource busy'), { code: 'EBUSY' }));
      }
      return read(id);
    };
    await expect(
      h.engine.importBundle(a.id, bundle('A1', 'u-work', NOW + HOUR)),
    ).rejects.toBeInstanceOf(VaultError);
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A2');
  });

  it('rewrites the guard snapshot when the brought login fills in what the row lacked', async () => {
    const h = await harness();
    const work = await h.engine.addAccount('work', bundle('W1', 'u-work', NOW + HOUR));
    await h.engine.includeInFolder(await ruleFolder(h, 'proj'), [work.id]);
    const row = await h.engine.addPendingAccount('home', { accountUuid: 'u-home' });
    const brought = bundle('H1', 'u-home', NOW + HOUR);
    brought.oauthAccount!.organizationUuid = 'org-home';
    await h.engine.importBundle(row.id, brought);
    expect((await h.engine.getGuardSnapshotFreshness()).fresh).toBe(true);
  });
});

describe('the verbs a move uses', () => {
  it('stores the auto-switch exclusion and a stated identity in the same write as the account', async () => {
    const h = await harness();
    const bare: CredentialBundle = {
      claudeAiOauth: { accessToken: 'N1', refreshToken: 'r-N1', expiresAt: NOW + HOUR },
    };
    const row = await h.engine.addAccount('nb', bare, {
      autoSwitchExcluded: true,
      identity: { accountUuid: 'u-nb', emailAddress: 'nb@x.com' },
    });
    expect(row).toMatchObject({
      accountUuid: 'u-nb',
      emailAddress: 'nb@x.com',
      autoSwitchExcluded: true,
    });
    await expect(
      h.engine.addAccount('again', bare, { identity: { accountUuid: 'u-nb' } }),
    ).rejects.toThrow(/already stored/);
    const pending = await h.engine.addPendingAccount(
      'p',
      { accountUuid: 'u-p' },
      { autoSwitchExcluded: true },
    );
    expect(pending.autoSwitchExcluded).toBe(true);
  });

  it('removes an account only while it still holds the refresh token that was handed over', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.vault.writeBundle(a.id, bundle('A2', 'u-work', NOW + 2 * HOUR));
    await expect(h.engine.removeAccount(a.id, { expectRefreshToken: 'r-A1' })).rejects.toThrow(
      /tokens changed/,
    );
    expect(await h.vault.getAccount(a.id)).toBeDefined();
    await h.engine.removeAccount(a.id, { expectRefreshToken: 'r-A2' });
    expect(await h.vault.getAccount(a.id)).toBeUndefined();
  });

  it("refuses to remove the account live on the machine's main login when asked to", async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    await expect(h.engine.removeAccount(a.id, { refuseIfGloballyLive: true })).rejects.toThrow(
      /live account of this machine's main login/,
    );
    expect(await h.vault.getAccount(a.id)).toBeDefined();
  });
});

describe('importRules', () => {
  it('creates one rule with every scope, exclusions before inclusions, and seats it once', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
    await h.engine.addAccount('z', bundle('Z1', 'u-z', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const p3 = await ruleFolder(h, 'p3');
    const res = await h.engine.importRules([
      {
        scopes: [
          { kind: 'folder', folder: p1 },
          { kind: 'folder', folder: p2 },
          { kind: 'alias', folder: p1, alias: 'Job' },
        ],
        include: [x.id],
        exclude: [],
        label: 'Client',
      },
      // Excludes y, which the next rule reserves: kept on record, as the source keeps it.
      { scopes: [{ kind: 'folder', folder: p3 }], include: [], exclude: [y.id] },
      { scopes: [{ kind: 'alias', folder: p3, alias: 'Other' }], include: [y.id], exclude: [] },
    ]);
    expect(res.outcomes.map((o) => o?.ok)).toEqual([true, true, true]);
    const rules = await h.engine.listRules();
    expect(rules).toHaveLength(3);
    const client = rules.find((r) => r.label === 'Client')!;
    expect(client.folders).toHaveLength(2);
    expect(client.aliases).toHaveLength(1);
    expect(client.activeId).toBe(x.id);
    expect(rules.find((r) => r.folders[0] === p3)!.exclude).toEqual([y.id]);
  });

  it('refuses only the rule whose reservation would leave the main login with nothing', async () => {
    const h = await harness();
    const only = await h.engine.addAccount('only', bundle('O1', 'u-o', NOW + HOUR));
    await h.engine.activate(only.id);
    const res = await h.engine.importRules([
      {
        scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'p1') }],
        include: [only.id],
        exclude: [],
      },
    ]);
    expect(res.plan.rules[0]).toMatchObject({ kind: 'refused' });
    expect(res.outcomes).toEqual([undefined]);
    expect(await h.engine.listRules()).toEqual([]);
    expect(await h.engine.getActiveId('global')).toBe(only.id);
  });
});

describe('importRules: accounts kept out of every slot but their own rule', () => {
  it('never moves a slot onto one, refusing the rule when nothing else is left', async () => {
    const h = await harness();
    const only = await h.engine.addAccount('only', bundle('O1', 'u-o', NOW + HOUR));
    const client = await h.engine.addAccount('client', bundle('C1', 'u-c', NOW + HOUR));
    await h.engine.activate(only.id);
    const spec = {
      scopes: [{ kind: 'folder' as const, folder: await ruleFolder(h, 'p1') }],
      include: [only.id],
      exclude: [],
    };
    const res = await h.engine.importRules([spec], { keepOut: [client.id] });
    expect(res.plan.rules[0]).toMatchObject({ kind: 'refused' });
    expect(res.handedOff).toEqual([]);
    expect(await h.engine.listRules()).toEqual([]);
    expect(await h.engine.getActiveId('global')).toBe(only.id);
  });

  it('picks the assignment that leaves them out when one exists', async () => {
    // The main login and an exclude-only rule's slot both move; taking the first free account for
    // each in turn would give the rule slot the kept-out one.
    const h = await harness();
    const z = await h.engine.addAccount('z', bundle('Z1', 'u-z', NOW + HOUR));
    const w = await h.engine.addAccount('w', bundle('W1', 'u-w', NOW + HOUR));
    const s1 = await h.engine.addAccount('s1', bundle('S1', 'u-s1', NOW + HOUR));
    const s2 = await h.engine.addAccount('s2', bundle('S2', 'u-s2', NOW + HOUR));
    const client = await h.engine.addAccount('client', bundle('C1', 'u-c', NOW + HOUR), {
      autoSwitchExcluded: true,
    });
    await h.engine.activate(z.id);
    await h.engine.excludeInFolder(await ruleFolder(h, 'q'), [s2.id]);
    const res = await h.engine.importRules(
      [
        {
          scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'p') }],
          include: [z.id, w.id],
          exclude: [],
        },
      ],
      { keepOut: [client.id] },
    );
    expect(res.outcomes[0]).toMatchObject({ ok: true });
    expect(res.handedOff.map((x) => x.to).sort()).toEqual([s1.id, s2.id].sort());
    expect(res.plan.handOffs).toEqual(res.handedOff);
    expect([...(await h.engine.liveSlots()).values()]).not.toContain(client.id);
  });

  it('never seats a rule it makes with one', async () => {
    const h = await harness();
    const live = await h.engine.addAccount('live', bundle('L1', 'u-l', NOW + HOUR));
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    const client = await h.engine.addAccount('client', bundle('C1', 'u-c', NOW + HOUR));
    await h.engine.activate(live.id);
    const res = await h.engine.importRules(
      [
        {
          scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'p') }],
          include: [],
          exclude: [x.id],
        },
      ],
      { keepOut: [client.id] },
    );
    expect(res.outcomes[0]).toMatchObject({ ok: true });
    expect((await h.engine.listRules())[0]!.activeId).toBeNull();
  });
});

describe('importBundle: the file has to prove the login', () => {
  /** A stored account with a full identity, live on the main login. */
  async function stored(h: Harness): Promise<string> {
    const full: CredentialBundle = {
      claudeAiOauth: { accessToken: 'X1', refreshToken: 'r-X1', expiresAt: NOW + HOUR },
      oauthAccount: {
        accountUuid: 'u-x',
        emailAddress: 'u-x@x.com',
        organizationUuid: 'org-x',
        displayName: 'X person',
      },
    };
    const x = await h.engine.addAccount('x', full);
    await h.engine.activate(x.id);
    return x.id;
  }

  it('refuses tokens whose block is missing, empty, or names no login as text, writing nothing', async () => {
    const h = await harness();
    const id = await stored(h);
    for (const block of [
      undefined,
      {},
      { accountUuid: 42 },
      { emailAddress: 'u-x@x.com' },
      { displayName: 'Y person' },
    ]) {
      const brought: CredentialBundle = {
        claudeAiOauth: { accessToken: 'Y1', refreshToken: 'r-Y1', expiresAt: NOW + 9 * HOUR },
        ...(block !== undefined ? { oauthAccount: block as OauthAccount } : {}),
      };
      await expect(h.engine.importBundle(id, brought)).rejects.toThrow(
        /the tokens were not replaced: the file's tokens do not (say|name)/,
      );
      const kept = await h.vault.readBundle(id);
      expect(kept.claudeAiOauth.accessToken).toBe('X1');
      expect(kept.oauthAccount).toMatchObject({ accountUuid: 'u-x', organizationUuid: 'org-x' });
      expect((await h.live.readLiveCredentials())?.accessToken).toBe('X1');
      expect((await h.live.readOauthAccount())?.accountUuid).toBe('u-x');
    }
  });

  it('never shrinks the identity: a block naming only the login keeps what was stored', async () => {
    const h = await harness();
    const id = await stored(h);
    const res = await h.engine.importBundle(id, {
      claudeAiOauth: { accessToken: 'X2', refreshToken: 'r-X2', expiresAt: NOW + 9 * HOUR },
      oauthAccount: { accountUuid: 'u-x', billingType: 'stripe_subscription' },
    });
    expect(res).toMatchObject({ replaced: true, healedLiveLogin: true });
    expect((await h.vault.readBundle(id)).oauthAccount).toEqual({
      accountUuid: 'u-x',
      emailAddress: 'u-x@x.com',
      organizationUuid: 'org-x',
      displayName: 'X person',
      billingType: 'stripe_subscription',
    });
    expect(await h.live.readOauthAccount()).toMatchObject({
      accountUuid: 'u-x',
      emailAddress: 'u-x@x.com',
      organizationUuid: 'org-x',
    });
    expect(await h.vault.getAccount(id)).toMatchObject({
      accountUuid: 'u-x',
      emailAddress: 'u-x@x.com',
      organizationUuid: 'org-x',
    });
  });

  it('never lets a block naming the login erase or rewrite the other anchors stored here', async () => {
    // The guard checks the login; the email and organization next to it are only the file's word,
    // whatever form it takes: not text at all, or other text.
    const blocks: Record<string, unknown>[] = [
      { emailAddress: null, organizationUuid: null },
      { emailAddress: false, organizationUuid: 0 },
      { emailAddress: 42, organizationUuid: { id: 'org-y' } },
      { emailAddress: 'y@evil.example', organizationUuid: 'org-y' },
    ];
    for (const [i, extra] of blocks.entries()) {
      const h = await harness();
      const id = await stored(h);
      const access = `X${i + 2}`;
      const res = await h.engine.importBundle(id, {
        claudeAiOauth: {
          accessToken: access,
          refreshToken: 'r-' + access,
          expiresAt: NOW + 9 * HOUR,
        },
        oauthAccount: { accountUuid: 'u-x', displayName: 'X renamed', ...extra },
      });
      expect(res).toMatchObject({ replaced: true, healedLiveLogin: true });
      const anchors = {
        accountUuid: 'u-x',
        emailAddress: 'u-x@x.com',
        organizationUuid: 'org-x',
      };
      // Fields that are not anchors still arrive with the newer tokens.
      expect((await h.vault.readBundle(id)).oauthAccount).toEqual({
        ...anchors,
        displayName: 'X renamed',
      });
      expect(await h.live.readOauthAccount()).toMatchObject(anchors);
      expect(await h.vault.getAccount(id)).toMatchObject(anchors);
    }
  });

  it('fills an anchor nothing here holds only from text, never from another kind of value', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('n', { accountUuid: 'u-n' });
    await h.engine.importBundle(row.id, {
      claudeAiOauth: { accessToken: 'N1', refreshToken: 'r-N1', expiresAt: NOW + HOUR },
      oauthAccount: { accountUuid: 'u-n', emailAddress: null, organizationUuid: 'org-n' } as never,
    });
    const block = (await h.vault.readBundle(row.id)).oauthAccount!;
    expect(block).toEqual({ accountUuid: 'u-n', organizationUuid: 'org-n' });
    expect(await h.vault.getAccount(row.id)).toMatchObject({ organizationUuid: 'org-n' });
  });

  it('for a row with no login, takes only a block echoing every anchor the row has', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('m', {
      emailAddress: 'm@x.com',
      organizationUuid: 'org-m',
    });
    const brought = (block: Record<string, string>): CredentialBundle => ({
      claudeAiOauth: { accessToken: 'M1', refreshToken: 'r-M1', expiresAt: NOW + HOUR },
      oauthAccount: block,
    });
    await expect(
      h.engine.importBundle(row.id, brought({ emailAddress: 'm@x.com' })),
    ).rejects.toThrow('do not show the organizationUuid stored here');
    const res = await h.engine.importBundle(
      row.id,
      brought({ emailAddress: 'm@x.com', organizationUuid: 'org-m', accountUuid: 'u-m' }),
    );
    expect(res.replaced).toBe(true);
    expect((await h.vault.getAccount(row.id))?.accountUuid).toBe('u-m');
  });
});

describe('adding an account brought from another machine', () => {
  const OTHER_ID = '5f0e8a2c-1d3b-4c5e-9f7a-0123456789ab';

  it('fills each anchor a partial identity block lacks from the stated identity', async () => {
    const h = await harness();
    const partial: CredentialBundle = {
      claudeAiOauth: { accessToken: 'P1', refreshToken: 'r-P1', expiresAt: NOW + HOUR },
      oauthAccount: { emailAddress: 'p@x.com' },
    };
    const row = await h.engine.addAccount('p', partial, {
      identity: { accountUuid: 'u-p', emailAddress: 'other@x.com', organizationUuid: 'org-p' },
    });
    // The block's own email wins; what it lacks comes from the caller.
    expect(row).toMatchObject({
      accountUuid: 'u-p',
      emailAddress: 'p@x.com',
      organizationUuid: 'org-p',
    });
    await expect(
      h.engine.addAccount('p again', partial, { identity: { accountUuid: 'u-p' } }),
    ).rejects.toThrow(/already stored/);
  });

  it('keeps the id it had, refusing one that is not a uuid or that another account has', async () => {
    const h = await harness();
    const row = await h.engine.addAccount('a', bundle('A1', 'u-a', NOW + HOUR), { id: OTHER_ID });
    expect(row.id).toBe(OTHER_ID);
    expect((await h.vault.readBundle(OTHER_ID)).claudeAiOauth.accessToken).toBe('A1');
    await expect(
      h.engine.addPendingAccount('b', { accountUuid: 'u-b' }, { id: OTHER_ID }),
    ).rejects.toThrow(`account "a" already has the id ${OTHER_ID}`);
    await expect(
      h.engine.addAccount('c', bundle('C1', 'u-c', NOW + HOUR), { id: '../escape' }),
    ).rejects.toThrow('an account id must be a lower-case uuid');
    expect((await h.engine.listAllAccounts()).map((r) => r.label)).toEqual(['a']);
  });

  it('refuses to keep an id another account here carries as its label, in any case', async () => {
    const h = await harness();
    await h.engine.addAccount(OTHER_ID.toUpperCase(), bundle('L1', 'u-l', NOW + HOUR));
    await expect(
      h.engine.addAccount('p', bundle('P1', 'u-p', NOW + HOUR), { id: OTHER_ID }),
    ).rejects.toThrow(`is labelled with the id ${OTHER_ID}`);
    await expect(
      h.engine.addPendingAccount('q', { accountUuid: 'u-q' }, { id: OTHER_ID }),
    ).rejects.toThrow(`is labelled with the id ${OTHER_ID}`);
    expect((await h.engine.listAllAccounts()).map((r) => r.label)).toEqual([
      OTHER_ID.toUpperCase(),
    ]);
  });

  it('shows the plan of an account waiting for a login until its first login replaces it', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount(
      'away',
      { accountUuid: 'u-away' },
      { plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } },
    );
    expect(row).toMatchObject({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });
    await h.engine.importBundle(row.id, {
      claudeAiOauth: {
        accessToken: 'W1',
        refreshToken: 'r-W1',
        expiresAt: NOW + HOUR,
        subscriptionType: 'pro',
      },
      oauthAccount: { accountUuid: 'u-away' },
    });
    const after = await h.vault.getAccount(row.id);
    expect(after?.subscriptionType).toBe('pro');
    expect(after?.rateLimitTier).toBeUndefined();
  });
});

describe('importRules: a rule an earlier import made part way', () => {
  const ORIGIN = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';

  it('grows the rule carrying its identity with the scopes it lacks, as one rule and one slot', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const first = await h.engine.importRules([
      {
        scopes: [{ kind: 'folder', folder: p1 }],
        include: [x.id],
        exclude: [],
        label: 'Client',
        origin: ORIGIN,
      },
    ]);
    const ruleId = (first.outcomes[0] as { rule: { id: string } }).rule.id;
    const res = await h.engine.importRules([
      {
        scopes: [
          { kind: 'folder', folder: p1 },
          { kind: 'folder', folder: p2 },
          { kind: 'alias', folder: p1, alias: 'deploy' },
        ],
        include: [x.id],
        exclude: [],
        origin: ORIGIN,
      },
    ]);
    expect(res.plan.rules[0]).toMatchObject({ kind: 'grow', include: [], exclude: [] });
    expect(res.outcomes[0]).toMatchObject({ ok: true, created: false });
    const rules = await h.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: ruleId, label: 'Client', include: [x.id] });
    expect(rules[0]!.folders).toHaveLength(2);
    expect(rules[0]!.aliases).toHaveLength(1);
    expect(rules[0]!.activeId).toBe(x.id);
  });

  it('grows it even when it holds a scope the spec does not, which stays its own', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const p3 = await ruleFolder(h, 'p3');
    await h.engine.importRules([
      {
        scopes: [
          { kind: 'folder', folder: p1 },
          { kind: 'folder', folder: p3 },
        ],
        include: [x.id],
        exclude: [],
        origin: ORIGIN,
      },
    ]);
    const res = await h.engine.importRules([
      {
        scopes: [
          { kind: 'folder', folder: p1 },
          { kind: 'folder', folder: p2 },
        ],
        include: [x.id],
        exclude: [],
        origin: ORIGIN,
      },
    ]);
    // The source dropped p3 from the rule since the first import: the rule here still holds it,
    // and gains p2 rather than a second rule being made beside it.
    expect(res.outcomes[0]).toMatchObject({ ok: true, created: false });
    const rules = await h.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.folders).toHaveLength(3);
    expect(rules[0]!.activeId).toBe(x.id);
  });

  it('says a rule here that already has all of it is unchanged, writing nothing', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const spec = {
      scopes: [{ kind: 'folder' as const, folder: p1 }],
      include: [x.id],
      exclude: [],
      origin: ORIGIN,
    };
    await h.engine.importRules([spec]);
    const before = await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8');
    const res = await h.engine.importRules([spec]);
    expect(res.plan.rules[0]).toMatchObject({ kind: 'unchanged' });
    expect(res.outcomes).toEqual([undefined]);
    expect(await readFile(join(h.paths.vaultDir, 'groups.json'), 'utf8')).toBe(before);
  });
});

describe('importRules: a rule lands whole or not at all', () => {
  const ORIGIN = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
  const OTHER = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';

  it("refuses a spec one of whose scopes a rule of this machine's own holds, making nothing", async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    const q = await h.engine.addAccount('q', bundle('Q1', 'u-q', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const mine = await h.vault.createRule({ folders: [p2], include: [q.id], label: 'mine' });
    // With an identity no rule here carries, with none, and on exactly the rule's own folder.
    for (const spec of [
      { scopes: [p1, p2], origin: ORIGIN },
      { scopes: [p1, p2] },
      { scopes: [p2], origin: ORIGIN },
    ]) {
      const res = await h.engine.importRules([
        {
          scopes: spec.scopes.map((folder) => ({ kind: 'folder' as const, folder })),
          include: [x.id],
          exclude: [],
          ...(spec.origin !== undefined ? { origin: spec.origin } : {}),
        },
      ]);
      expect(res.plan.rules[0]).toMatchObject({
        kind: 'refused',
        conflict: { scope: { kind: 'folder', folder: p2 }, rule: { id: mine.id, label: 'mine' } },
      });
      expect((res.plan.rules[0] as { message: string }).message).toContain(
        `folder ${p2} already has a rule here ("mine")`,
      );
    }
    expect(await h.engine.listRules()).toEqual([mine]);
  });

  it('never grows a rule here that carries another identity', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    await h.engine.importRules([
      { scopes: [{ kind: 'folder', folder: p1 }], include: [x.id], exclude: [], origin: OTHER },
    ]);
    const before = await h.engine.listRules();
    const res = await h.engine.importRules([
      {
        scopes: [
          { kind: 'folder', folder: p1 },
          { kind: 'folder', folder: p2 },
        ],
        include: [x.id],
        exclude: [],
        origin: ORIGIN,
      },
    ]);
    expect(res.plan.rules[0]).toMatchObject({ kind: 'refused' });
    expect(await h.engine.listRules()).toEqual(before);
  });

  it('grows the rule itself when the identity is its own id (the file came from here)', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const mine = await h.vault.createRule({ folders: [p1], include: [x.id] });
    const res = await h.engine.importRules([
      {
        scopes: [
          { kind: 'folder', folder: p1 },
          { kind: 'folder', folder: p2 },
        ],
        include: [x.id],
        exclude: [],
        origin: mine.id,
      },
    ]);
    expect(res.plan.rules[0]).toMatchObject({ kind: 'grow', rule: { id: mine.id } });
    const rules = await h.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.folders).toEqual([p1, p2]);
    expect(rules[0]!.origin).toBeUndefined();
  });

  it('refuses the later of two specs that hold one scope, and a rule split here in two', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    const res = await h.engine.importRules([
      { scopes: [{ kind: 'folder', folder: p1 }], include: [x.id], exclude: [] },
      {
        scopes: [
          { kind: 'folder', folder: p2 },
          { kind: 'folder', folder: p1 },
        ],
        include: [y.id],
        exclude: [],
      },
    ]);
    expect(res.plan.rules.map((v) => v.kind)).toEqual(['create', 'refused']);
    expect(res.plan.rules[1]).toMatchObject({ conflict: { scope: { folder: p1 } } });
    expect((await h.engine.listRules()).map((r) => r.folders)).toEqual([[p1]]);

    // Two rules here with one identity (only a hand edit makes them): neither is grown.
    const h2 = await harness();
    const z = await h2.engine.addAccount('z', bundle('Z1', 'u-z', NOW + HOUR));
    const q1 = await ruleFolder(h2, 'q1');
    const q2 = await ruleFolder(h2, 'q2');
    await h2.vault.createRule({ folders: [q1], exclude: [z.id], origin: ORIGIN });
    const file = join(h2.paths.vaultDir, 'groups.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      rules: Array<Record<string, unknown>>;
    };
    raw.rules.push({ ...raw.rules[0]!, id: OTHER, folders: [q2] });
    await writeFile(file, JSON.stringify(raw));
    const split = await h2.engine.importRules([
      { scopes: [{ kind: 'folder', folder: q1 }], include: [], exclude: [z.id], origin: ORIGIN },
    ]);
    expect((split.plan.rules[0] as { message: string }).message).toContain('split between rules');
  });

  it('refuses a spec the vault would refuse part way, before anything is written', async () => {
    // Its exclusion is written before its inclusions, which pass the cap on a rule's accounts:
    // tried against a draft first, so the rule is never left half made.
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const many: string[] = [];
    for (let i = 0; i < 32; i += 1) {
      many.push((await h.vault.addPendingAccount(`m${i}`, {}, 'w')).id);
    }
    const res = await h.engine.importRules([
      { scopes: [{ kind: 'folder', folder: p1 }], include: [x.id, ...many], exclude: [y.id] },
    ]);
    expect(res.plan.rules[0]).toMatchObject({
      kind: 'refused',
      message: 'a folder rule cannot include more than 32 accounts',
    });
    expect(res.outcomes).toEqual([undefined]);
    expect(await h.engine.listRules()).toEqual([]);
  });
});

describe("a rule's identity across machines (its origin)", () => {
  const ORIGIN = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

  it('is stored on a rule an import creates, and read back from disk', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const res = await h.engine.importRules([
      { scopes: [{ kind: 'folder', folder: p1 }], include: [x.id], exclude: [], origin: ORIGIN },
    ]);
    expect(res.outcomes[0]).toMatchObject({ ok: true, created: true });
    expect((await h.vault.listRules())[0]!.origin).toBe(ORIGIN);
  });

  it('refuses, before anything moves, a rule naming an identity that is not a rule id', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    const p2 = await ruleFolder(h, 'p2');
    await h.vault.createRule({ folders: [p1], exclude: [x.id] });
    const res = await h.engine.importRules([
      { scopes: [{ kind: 'folder', folder: p2 }], include: [x.id], exclude: [], origin: 'x/../y' },
    ]);
    expect(res.plan.rules[0]).toMatchObject({ kind: 'refused' });
    expect(res.handedOff).toEqual([]);
    expect(await h.engine.listRules()).toHaveLength(1);
    expect((await h.engine.listAllAccounts()).find((a) => a.id === x.id)?.ruleIds ?? []).toEqual(
      [],
    );
  });

  it('refuses a registry whose rule carries an origin that is not a uuid', async () => {
    const h = await harness();
    const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
    const p1 = await ruleFolder(h, 'p1');
    await h.vault.createRule({ folders: [p1], exclude: [x.id], origin: ORIGIN });
    const file = join(h.paths.vaultDir, 'groups.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as { rules: { origin: unknown }[] };
    expect(raw.rules[0]!.origin).toBe(ORIGIN);
    raw.rules[0]!.origin = 7;
    await writeFile(file, JSON.stringify(raw));
    await expect(
      new Vault(h.paths.vaultDir, new InsecurePassthroughProtector(), () => NOW).listRules(),
    ).rejects.toThrow('origin is not a rule id');
  });
});

describe('importRules: the caps, counted over the batch', () => {
  it('creates rules in spec order up to the rule cap, never an exclusion-only one first', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('a', bundle('A1', 'u-a', NOW + HOUR));
    const b = await h.engine.addAccount('b', bundle('B1', 'u-b', NOW + HOUR));
    await h.engine.addAccount('c', bundle('C1', 'u-c', NOW + HOUR));
    for (let i = 0; i < 63; i += 1) {
      await h.vault.createRule({ folders: [await ruleFolder(h, `r${i}`)], exclude: [b.id] });
    }
    const res = await h.engine.importRules([
      {
        scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'inc') }],
        include: [a.id],
        exclude: [],
      },
      {
        scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'exc') }],
        include: [],
        exclude: [b.id],
      },
    ]);
    expect(res.outcomes.map((o) => o?.ok)).toEqual([true, undefined]);
    expect((res.plan.rules[1] as { message: string }).message).toContain('max 64');
    expect(await h.engine.listRules()).toHaveLength(64);
  });

  it('refuses up front, writing nothing, a rule that would pass the reserved-account cap', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 255; i += 1) {
      ids.push((await h.vault.addPendingAccount(`p${i}`, {}, 'waiting')).id);
    }
    for (let r = 0; r * 32 < ids.length; r += 1) {
      await h.vault.createRule({
        folders: [await ruleFolder(h, `held${r}`)],
        include: ids.slice(r * 32, r * 32 + 32),
      });
    }
    const one = await h.engine.addAccount('one', bundle('O1', 'u-one', NOW + HOUR));
    const two = await h.engine.addAccount('two', bundle('T1', 'u-two', NOW + HOUR));
    await h.engine.addAccount('free', bundle('F1', 'u-free', NOW + HOUR));
    const before = (await h.engine.listRules()).length;
    const res = await h.engine.importRules([
      {
        scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'n1') }],
        include: [one.id],
        exclude: [],
      },
      // Its exclusion would be written before its inclusion is refused: a rule half made.
      {
        scopes: [{ kind: 'folder', folder: await ruleFolder(h, 'n2') }],
        include: [two.id],
        exclude: [one.id],
      },
    ]);
    expect(res.outcomes[0]).toMatchObject({ ok: true });
    expect(res.plan.rules[1]).toEqual({
      kind: 'refused',
      message: 'cannot reserve more than 256 accounts',
    });
    expect(await h.engine.listRules()).toHaveLength(before + 1);
  });
});

describe('planImportRules: the decision importRules then carries out', () => {
  const ORIGIN = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  const OTHER = '1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f';
  const LATER = '2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a';

  /** The credential store over a rule's profile, to plant what a by-hand login there leaves. */
  function ruleStore(h: Harness, ruleId: string): CredentialStore {
    const profileDir = groupProfileDir(h.paths.vaultDir, ruleId);
    return new CredentialStore({
      claudeDir: profileDir,
      credentialsPath: join(profileDir, '.credentials.json'),
      claudeJsonPath: join(profileDir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
  }

  /** Log `bundle`'s login in by hand inside a rule's profile, as `/login` there would. */
  async function loginInProfile(h: Harness, ruleId: string, b: CredentialBundle): Promise<void> {
    await ruleStore(h, ruleId).writeLiveCredentials(b.claudeAiOauth);
    await ruleStore(h, ruleId).writeOauthAccount(b.oauthAccount!);
  }

  const folder = (f: string): RuleScopeRef => ({ kind: 'folder', folder: f });

  /** One case: a machine set up, and the specs imported into it. */
  type Case = (h: Harness) => Promise<ImportRuleSpec[]>;

  const cases: Record<string, Case> = {
    'a new rule': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
      return [{ scopes: [folder(await ruleFolder(h, 'p'))], include: [x.id], exclude: [] }];
    },
    'the rule carrying its identity, grown': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
      await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      await h.vault.createRule({ folders: [p], include: [x.id], origin: ORIGIN });
      const scopes = [folder(p), folder(await ruleFolder(h, 'q'))];
      return [{ scopes, include: [x.id, y.id], exclude: [], origin: ORIGIN }];
    },
    'the rule carrying its identity, unchanged': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      await h.vault.createRule({ folders: [p], include: [x.id], origin: ORIGIN });
      return [{ scopes: [folder(p)], include: [x.id], exclude: [], origin: ORIGIN }];
    },
    "a folder of this machine's own rule": async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const q = await h.engine.addAccount('q', bundle('Q1', 'u-q', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      await h.vault.createRule({ folders: [p], include: [q.id] });
      return [
        { scopes: [folder(await ruleFolder(h, 'n')), folder(p)], include: [x.id], exclude: [] },
      ];
    },
    'a rule here with another identity': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      await h.vault.createRule({ folders: [p], include: [x.id], origin: OTHER });
      return [{ scopes: [folder(p)], include: [x.id], exclude: [], origin: ORIGIN }];
    },
    'a grown rule past the cap on session aliases': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      const aliases = Array.from({ length: 256 }, (_, i) => ({ folder: p, alias: `s${i}` }));
      await h.vault.createRule({ folders: [p], aliases, include: [x.id], origin: ORIGIN });
      const extra: RuleScopeRef = { kind: 'alias', folder: p, alias: 'extra' };
      return [{ scopes: [folder(p), extra], include: [x.id], exclude: [], origin: ORIGIN }];
    },
    'the rule cap, in spec order': async (h) => {
      const a = await h.engine.addAccount('a', bundle('A1', 'u-a', NOW + HOUR));
      const b = await h.engine.addAccount('b', bundle('B1', 'u-b', NOW + HOUR));
      await h.engine.addAccount('c', bundle('C1', 'u-c', NOW + HOUR));
      for (let i = 0; i < 63; i += 1) {
        await h.vault.createRule({ folders: [await ruleFolder(h, `r${i}`)], exclude: [b.id] });
      }
      return [
        { scopes: [folder(await ruleFolder(h, 'inc'))], include: [a.id], exclude: [] },
        { scopes: [folder(await ruleFolder(h, 'exc'))], include: [], exclude: [b.id] },
      ];
    },
    'the main login moved off an account a rule reserves': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
      await h.engine.activate(x.id);
      return [{ scopes: [folder(await ruleFolder(h, 'p'))], include: [x.id], exclude: [] }];
    },
    'the main login with nothing to move to': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      await h.engine.activate(x.id);
      return [{ scopes: [folder(await ruleFolder(h, 'p'))], include: [x.id], exclude: [] }];
    },
    'a slot recorded empty that runs the account': async (h) => {
      const other = await h.engine.addAccount('other', bundle('O1', 'u-o', NOW + HOUR));
      await h.engine.activate(other.id);
      const side = await h.engine.excludeInFolder(await ruleFolder(h, 'side'), [other.id]);
      const c = bundle('C1', 'u-c', NOW + HOUR);
      await loginInProfile(h, side.rule.id, c);
      const client = await h.engine.addAccount('client', c);
      return [{ scopes: [folder(await ruleFolder(h, 'p'))], include: [client.id], exclude: [] }];
    },
    'a slot recorded on one account that runs another': async (h) => {
      await h.engine.addAccount('work', bundle('W1', 'u-w', NOW + HOUR));
      const other = await h.engine.addAccount('other', bundle('O1', 'u-o', NOW + HOUR));
      await h.engine.activate(other.id);
      const side = await h.engine.excludeInFolder(await ruleFolder(h, 'side'), [other.id]);
      const c = bundle('C1', 'u-c', NOW + HOUR);
      const client = await h.engine.addAccount('client', c);
      await loginInProfile(h, side.rule.id, c);
      return [{ scopes: [folder(await ruleFolder(h, 'p'))], include: [client.id], exclude: [] }];
    },
    'members the rule here has the other way round, or another rule reserves': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
      const r = await h.engine.addAccount('r', bundle('R1', 'u-r', NOW + HOUR));
      await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      await h.vault.createRule({ folders: [p], include: [x.id], exclude: [y.id], origin: ORIGIN });
      await h.vault.createRule({ folders: [await ruleFolder(h, 'held')], include: [r.id] });
      return [
        { scopes: [folder(p)], include: [y.id], exclude: [x.id, r.id], origin: ORIGIN },
        { scopes: [folder(await ruleFolder(h, 'n'))], include: [], exclude: [r.id] },
      ];
    },
    'two specs on one folder': async (h) => {
      const x = await h.engine.addAccount('x', bundle('X1', 'u-x', NOW + HOUR));
      const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
      await h.engine.addAccount('s', bundle('S1', 'u-s', NOW + HOUR));
      const p = await ruleFolder(h, 'p');
      return [
        { scopes: [folder(p)], include: [x.id], exclude: [] },
        { scopes: [folder(await ruleFolder(h, 'q')), folder(p)], include: [y.id], exclude: [] },
      ];
    },
    'a rule the vault refuses part way': async (h) => {
      const y = await h.engine.addAccount('y', bundle('Y1', 'u-y', NOW + HOUR));
      const many: string[] = [];
      for (let i = 0; i < 33; i += 1) {
        many.push((await h.vault.addPendingAccount(`m${i}`, {}, 'w')).id);
      }
      return [{ scopes: [folder(await ruleFolder(h, 'p'))], include: many, exclude: [y.id] }];
    },
  };

  /** What each case is decided as: the verdict on each spec, and how many slots it moves. */
  const expected: Record<string, [ImportRuleVerdict['kind'][], number]> = {
    'a new rule': [['create'], 0],
    'the rule carrying its identity, grown': [['grow'], 0],
    'the rule carrying its identity, unchanged': [['unchanged'], 0],
    "a folder of this machine's own rule": [['refused'], 0],
    'a rule here with another identity': [['refused'], 0],
    'a grown rule past the cap on session aliases': [['refused'], 0],
    'the rule cap, in spec order': [['create', 'refused'], 0],
    'the main login moved off an account a rule reserves': [['create'], 1],
    'the main login with nothing to move to': [['refused'], 0],
    'a slot recorded empty that runs the account': [['refused'], 0],
    'a slot recorded on one account that runs another': [['create'], 1],
    'members the rule here has the other way round, or another rule reserves': [
      ['unchanged', 'unchanged'],
      0,
    ],
    'two specs on one folder': [['create', 'refused'], 0],
    'a rule the vault refuses part way': [['refused'], 0],
  };

  for (const [name, setUp] of Object.entries(cases)) {
    it(`decides ${name} as the real run does`, async () => {
      const h = await harness();
      const specs = await setUp(h);
      const plan = await h.engine.planImportRules(specs);
      const res = await h.engine.importRules(specs);
      expect([plan.rules.map((v) => v.kind), plan.handOffs.length]).toEqual(expected[name]);
      expect(res.plan).toEqual(plan);
      expect(res.handedOff).toEqual(plan.handOffs);
      for (const [i, verdict] of plan.rules.entries()) {
        const writes = verdict.kind === 'create' || verdict.kind === 'grow';
        expect(res.outcomes[i]?.ok).toBe(writes ? true : undefined);
      }
    });
  }

  it('decides, for accounts not stored yet, what the run decides once they are', async () => {
    // client's login runs on the main login before any account here is it; the import stores it
    // with its id kept, and a rule of the file reserves it.
    const PENDING = '3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b';
    for (const spare of [false, true]) {
      const h = await harness();
      if (spare) {
        const other = await h.engine.addAccount('other', bundle('O1', 'u-o', NOW + HOUR));
        await h.engine.activate(other.id);
      }
      const c = bundle('C1', 'u-c', NOW + HOUR);
      await h.live.writeLiveCredentials(c.claudeAiOauth);
      await h.live.writeOauthAccount(c.oauthAccount!);
      const specs: ImportRuleSpec[] = [
        { scopes: [folder(await ruleFolder(h, 'p'))], include: [PENDING], exclude: [] },
      ];
      const plan = await h.engine.planImportRules(specs, {
        pending: [{ id: PENDING, label: 'client', accountUuid: 'u-c', withTokens: true }],
      });
      expect(plan.rules[0]!.kind).toBe(spare ? 'create' : 'refused');
      await h.engine.addAccount('client', c, { id: PENDING });
      const res = await h.engine.importRules(specs);
      expect(res.plan).toEqual(plan);
    }
    // Planning wrote nothing: no account, no rule.
    const h = await harness();
    await h.engine.planImportRules(
      [{ scopes: [folder(await ruleFolder(h, 'p'))], include: [LATER], exclude: [] }],
      { pending: [{ id: LATER, label: 'later', withTokens: false }] },
    );
    expect(await h.engine.listAllAccounts()).toEqual([]);
    expect(await h.engine.listRules()).toEqual([]);
  });
});
