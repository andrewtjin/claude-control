// Slot-aware switch engine: the folder-rule slots layered on top of the global slot.
//
// These cover the behaviour that only exists once a folder can have its own slot: routing an
// activation by the rules (an included account to its rule's slot, a shared one to the global slot
// unless a rule slot is named), per-slot cadence/intent/rollback, reconciling each slot against its
// own profile identity, and the refusals that keep every slot inside its pool and an account live in
// at most one slot. The global-slot behaviour itself is exercised in switchEngine.test.ts and is only
// touched here where a rule slot and the global slot must be shown not to interfere.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { IntentStore } from './intent.js';
import { sandboxPaths, groupProfileDir, type Paths } from './paths.js';
import { ruleSlotId } from './types.js';
import { CadenceError } from './errors.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';
import type { Protector } from './dpapi.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  protector: Protector;
  /** The GLOBAL slot's live credential store, for asserting global stays untouched. */
  credStore: CredentialStore;
  setNow: (n: number) => void;
  clock: () => number;
}

/** A default refresh that rotates the token an hour out — matches switchEngine.test.ts's shape so a
 *  near-expiry account can be refreshed deterministically. */
function makeRefresh(clock: () => number) {
  return (cur: ClaudeOauth): Promise<ClaudeOauth> =>
    Promise.resolve({
      ...cur,
      accessToken: 'refreshed-' + cur.accessToken,
      refreshToken: 'rotated-' + cur.refreshToken,
      expiresAt: clock() + HOUR,
    });
}

async function harness(platform: NodeJS.Platform = 'win32'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-slot-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });

  let now = NOW;
  const clock = (): number => now;
  const protector = new InsecurePassthroughProtector();
  const engine = new SwitchEngine({
    paths,
    protector,
    // Always a file channel so the darwin refusal test never reaches the real Keychain.
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: makeRefresh(clock),
    clock,
    refreshSkewMs: 5 * 60 * 1000,
    minSwitchIntervalMs: 60_000,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
    platform,
  });
  const vault = new Vault(paths.vaultDir, protector, clock, undefined, platform);
  return {
    root,
    paths,
    engine,
    vault,
    protector,
    credStore: new CredentialStore(paths),
    setNow: (n) => (now = n),
    clock,
  };
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function oauth(access: string, expiresAt: number, refresh = 'r-' + access): ClaudeOauth {
  return { accessToken: access, refreshToken: refresh, expiresAt };
}
function bundleFor(access: string, expiresAt: number): CredentialBundle {
  return {
    claudeAiOauth: oauth(access, expiresAt),
    oauthAccount: { accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' },
  };
}

/** A credential store over one rule's profile dir — how a test inspects a rule slot's live files. */
function ruleStore(paths: Paths, ruleId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, ruleId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** Seed four shared accounts A/B/C/D, then include A+B in a rule on one folder. C and D stay in the
 *  shared pool, which the rule also inherits. Every account is far from expiry so no activation
 *  triggers a refresh. The rule is written straight to the vault, so its slot starts empty. */
async function setupRule(h: Harness) {
  const A = await h.engine.addAccount('A', bundleFor('A', NOW + 10 * HOUR));
  const B = await h.engine.addAccount('B', bundleFor('B', NOW + 10 * HOUR));
  const C = await h.engine.addAccount('C', bundleFor('C', NOW + 10 * HOUR));
  const D = await h.engine.addAccount('D', bundleFor('D', NOW + 10 * HOUR));
  const rule = await h.vault.createRule({ folders: ['C:\\work'], include: [A.id, B.id] });
  return { A, B, C, D, rule, slotId: ruleSlotId(rule.id) };
}

describe('activate — routing by the rules', () => {
  it('routes an included account to its rule slot, leaving the global slot untouched', async () => {
    const h = await harness();
    const { A, rule, slotId } = await setupRule(h);

    const res = await h.engine.activate(A.id);

    expect(res.activeAccountId).toBe(A.id);
    // The rule profile now holds A's live credentials; the global slot holds nothing.
    expect((await ruleStore(h.paths, rule.id).readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
    expect((await h.vault.getRule(rule.id))?.activeId).toBe(A.id);
    expect(await h.engine.getActiveId(slotId)).toBe(A.id);
    expect(await h.engine.getActiveId('global')).toBeNull();
    // The global registry active id is never a reserved account.
    expect(await h.vault.getActiveId()).toBeNull();
  });

  it('routes a shared account to the global slot when no slot is named, never a rule slot', async () => {
    const h = await harness();
    const { C, slotId } = await setupRule(h);

    await h.engine.activate(C.id);

    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect(await h.engine.getActiveId(slotId)).toBeNull();
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
  });

  it('puts a shared account into a rule slot when that slot is named (the rule inherits it)', async () => {
    const h = await harness();
    const { C, rule, slotId } = await setupRule(h);

    const res = await h.engine.activate(C.id, { slot: slotId });

    expect(res.activeAccountId).toBe(C.id);
    expect((await ruleStore(h.paths, rule.id).readLiveCredentials())?.accessToken).toBe('C');
    expect((await h.vault.getRule(rule.id))?.activeId).toBe(C.id);
    expect(await h.engine.getActiveId(slotId)).toBe(C.id);
    // The shared account stays shared: it is live in the rule slot, and the global slot is empty.
    expect(await h.engine.getActiveId('global')).toBeNull();
    expect(await h.vault.getActiveId()).toBeNull();
    expect((await h.vault.listAccounts()).map((a) => a.id)).toContain(C.id);
  });

  it('refuses an explicit global slot for a reserved account', async () => {
    const h = await harness();
    const { A } = await setupRule(h);
    await expect(h.engine.activate(A.id, { slot: 'global' })).rejects.toMatchObject({
      code: 'slot_mismatch',
    });
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
  });

  it('refuses an explicit rule slot for an account the rule excludes', async () => {
    const h = await harness();
    const { C, D, rule, slotId } = await setupRule(h);
    await h.vault.excludeAccounts(rule.id, [D.id]);

    await expect(h.engine.activate(D.id, { slot: slotId })).rejects.toMatchObject({
      code: 'slot_mismatch',
      message: expect.stringMatching(/excludes it/) as unknown,
    });
    // Nothing was written to the profile, and a shared account the rule does not exclude still goes.
    expect(await ruleStore(h.paths, rule.id).readLiveCredentials()).toBeUndefined();
    await expect(h.engine.activate(C.id, { slot: slotId })).resolves.toMatchObject({ ok: true });
  });

  it('refuses an explicit rule slot for an account reserved only to another rule', async () => {
    const h = await harness();
    const { C, rule, slotId } = await setupRule(h);
    // C is included by a second rule only, so it is in no pool but that rule's.
    await h.vault.createRule({ folders: ['C:\\client'], include: [C.id] });

    await expect(h.engine.activate(C.id, { slot: slotId })).rejects.toMatchObject({
      code: 'slot_mismatch',
      message: expect.stringMatching(/reserved to other folders/) as unknown,
    });
    expect(await ruleStore(h.paths, rule.id).readLiveCredentials()).toBeUndefined();
  });

  it('refuses a rule-slot activation on macOS', async () => {
    const h = await harness('darwin');
    const { A, slotId } = await setupRule(h);
    await expect(h.engine.activate(A.id)).rejects.toMatchObject({ code: 'group_slot_unsupported' });
    // Nothing was written to the profile — the refusal is before any live write.
    expect(await h.engine.getActiveId(slotId)).toBeNull();
  });
});

describe('activate — an account several rules include', () => {
  /** A second rule on another folder that also includes A (a shared include). */
  async function shareA(h: Harness) {
    const base = await setupRule(h);
    const other = await h.vault.createRule({ folders: ['C:\\client'], include: [base.A.id] });
    return { ...base, other, otherSlot: ruleSlotId(other.id) };
  }

  it('is refused as slot_ambiguous when it is live in none of their slots and no slot is named', async () => {
    const h = await harness();
    const { A, rule, other } = await shareA(h);

    await expect(h.engine.activate(A.id)).rejects.toMatchObject({
      code: 'slot_ambiguous',
      message: expect.stringMatching(/name the folder slot/) as unknown,
    });
    // Nothing was picked for the caller: both rule slots and the global slot are untouched.
    expect(await ruleStore(h.paths, rule.id).readLiveCredentials()).toBeUndefined();
    expect(await ruleStore(h.paths, other.id).readLiveCredentials()).toBeUndefined();
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
  });

  it('goes to the slot it is live in when no slot is named', async () => {
    const h = await harness();
    const { A, rule, slotId, other, otherSlot } = await shareA(h);
    await h.engine.activate(A.id, { slot: otherSlot });

    // A heal of the account already live there, not a hop into the first rule's slot.
    const res = await h.engine.activate(A.id);

    expect(res.activeAccountId).toBe(A.id);
    expect(await h.engine.getActiveId(otherSlot)).toBe(A.id);
    expect(await h.engine.getActiveId(slotId)).toBeNull();
    expect((await h.vault.getRule(other.id))?.activeId).toBe(A.id);
    expect((await h.vault.getRule(rule.id))?.activeId).toBeNull();
  });

  it('is refused as live_elsewhere in one including slot while it is live in the other', async () => {
    const h = await harness();
    const { A, rule, slotId, otherSlot } = await shareA(h);
    await h.engine.activate(A.id, { slot: otherSlot });
    h.setNow(NOW + 2 * 60_000);

    await expect(h.engine.activate(A.id, { slot: slotId, force: true })).rejects.toMatchObject({
      code: 'live_elsewhere',
      message: expect.stringMatching(/C:\\client/) as unknown,
    });
    expect(await ruleStore(h.paths, rule.id).readLiveCredentials()).toBeUndefined();
    expect(await h.engine.getActiveId(otherSlot)).toBe(A.id);
  });
});

describe('the at-most-one-slot invariant', () => {
  it('keeps a global account and a rule account in disjoint slots', async () => {
    const h = await harness();
    const { A, C, slotId } = await setupRule(h);

    await h.engine.activate(C.id); // global
    await h.engine.activate(A.id); // rule slot (same clock; different slot)

    const live = await h.engine.liveSlots();
    expect(live.get('global')).toBe(C.id);
    expect(live.get(slotId)).toBe(A.id);
    // No account is live in two slots.
    const liveIds = [...live.values()].filter((v): v is string => v !== null);
    expect(new Set(liveIds).size).toBe(liveIds.length);
  });

  it('a rule-slot switch moves the live account within the rule and never the global slot', async () => {
    const h = await harness();
    const { A, B, C, rule, slotId } = await setupRule(h);

    await h.engine.activate(C.id);
    await h.engine.activate(A.id);
    h.setNow(NOW + 2 * 60_000); // clear both cadence windows
    await h.engine.activate(B.id);

    expect(await h.engine.getActiveId(slotId)).toBe(B.id);
    expect((await ruleStore(h.paths, rule.id).readLiveCredentials())?.accessToken).toBe('B');
    // The global slot is exactly where it was.
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
  });

  it('a rule slot refuses a shared account that is live in the global slot', async () => {
    const h = await harness();
    const { C, rule, slotId } = await setupRule(h);
    await h.engine.activate(C.id); // global

    await expect(h.engine.activate(C.id, { slot: slotId })).rejects.toMatchObject({
      code: 'live_elsewhere',
      message: expect.stringMatching(/global slot/) as unknown,
    });
    expect(await ruleStore(h.paths, rule.id).readLiveCredentials()).toBeUndefined();
    expect(await h.engine.getActiveId('global')).toBe(C.id);
  });

  it('the global slot refuses a shared account that is live in a rule slot', async () => {
    const h = await harness();
    const { C, D, slotId } = await setupRule(h);
    await h.engine.activate(D.id); // global = D
    await h.engine.activate(C.id, { slot: slotId }); // rule slot inherits C
    h.setNow(NOW + 2 * 60_000);

    // Neither a routed nor an explicitly global activation may put C in a second slot.
    await expect(h.engine.activate(C.id)).rejects.toMatchObject({
      code: 'live_elsewhere',
      message: expect.stringMatching(/C:\\work/) as unknown,
    });
    await expect(h.engine.activate(C.id, { slot: 'global' })).rejects.toMatchObject({
      code: 'live_elsewhere',
    });
    expect(await h.engine.getActiveId('global')).toBe(D.id);
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('D');
    expect(await h.engine.getActiveId(slotId)).toBe(C.id);
  });

  it('the global slot refuses a reserved account even when no rule slot holds it', async () => {
    const h = await harness();
    const { B } = await setupRule(h);
    await expect(h.engine.activate(B.id, { slot: 'global' })).rejects.toMatchObject({
      code: 'slot_mismatch',
      message: expect.stringMatching(/reserved to a folder rule/) as unknown,
    });
    expect(await h.engine.getActiveId('global')).toBeNull();
  });
});

describe('slotPool through the engine', () => {
  it('lists the included accounts first, then the inherited ones, minus excludes and quarantine', async () => {
    const h = await harness();
    const { A, B, C, D, rule, slotId } = await setupRule(h);
    const E = await h.engine.addAccount('E', bundleFor('E', NOW + 10 * HOUR));
    await h.vault.excludeAccounts(rule.id, [D.id]);
    await h.vault.quarantine(E.id, 'dead');

    const pool = await h.engine.slotPool(slotId);

    expect(pool.map((e) => [e.account.id, e.source])).toEqual([
      [A.id, 'include'],
      [B.id, 'include'],
      [C.id, 'inherited'],
    ]);
    // The global slot's pool is the shared pool: never a reserved account, minus quarantine only.
    expect((await h.engine.slotPool('global')).map((e) => e.account.id)).toEqual([C.id, D.id]);
  });

  it('reports liveElsewhere for an account live in another slot, token-aware', async () => {
    const h = await harness();
    const { A, B, C, D, slotId } = await setupRule(h);
    await h.engine.activate(C.id); // global = C
    await h.engine.activate(A.id); // rule slot = A

    const rulePool = await h.engine.slotPool(slotId);
    expect(rulePool.map((e) => [e.account.id, e.liveElsewhere])).toEqual([
      [A.id, null], // live HERE, which is not elsewhere
      [B.id, null],
      [C.id, 'global'],
      [D.id, null],
    ]);
    const globalPool = await h.engine.slotPool('global');
    expect(globalPool.map((e) => [e.account.id, e.liveElsewhere])).toEqual([
      [C.id, null],
      [D.id, null],
    ]);

    // Token-aware: D's token live in the global slot under C's identity still makes D live there.
    await h.credStore.writeLiveCredentials(oauth('D', NOW + 10 * HOUR, 'r-D'));
    const torn = await h.engine.slotPool(slotId);
    expect(torn.find((e) => e.account.id === D.id)?.liveElsewhere).toBe('global');
  });

  it('a slot with no live credentials holds nobody, whatever its records say', async () => {
    const h = await harness();
    const { A, rule, slotId } = await setupRule(h);
    // A second rule includes A too, so its pool reports where else A is live.
    const other = await h.vault.createRule({ folders: ['C:\\client'], include: [A.id] });
    const otherSlot = ruleSlotId(other.id);
    await h.engine.activate(A.id, { slot: slotId });
    expect(
      (await h.engine.slotPool(otherSlot)).find((e) => e.account.id === A.id)?.liveElsewhere,
    ).toBe(slotId);

    // The profile's credentials are removed by hand. Its identity block and the rule's record still
    // name A, but a session there has nothing to spend: A is free for the other slot.
    await rm(join(groupProfileDir(h.paths.vaultDir, rule.id), '.credentials.json'));
    expect((await h.vault.getRule(rule.id))?.activeId).toBe(A.id);

    expect(
      (await h.engine.slotPool(otherSlot)).find((e) => e.account.id === A.id)?.liveElsewhere,
    ).toBeNull();
    await expect(h.engine.activate(A.id, { slot: otherSlot })).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('per-slot cadence independence', () => {
  it('a rule-slot hop and a global hop at the same instant both succeed, then each blocks its own next', async () => {
    const h = await harness();
    const { A, B, C, D } = await setupRule(h);

    // Both slots hop at NOW. The rule-slot hop is NOT blocked by the global slot's just-set clock.
    await h.engine.activate(C.id); // global hop    -> global clock    = NOW
    await h.engine.activate(A.id); // rule-slot hop -> rule-slot clock = NOW (independent)

    // A second hop in either slot at the same instant is refused by THAT slot's clock.
    await expect(h.engine.activate(D.id)).rejects.toBeInstanceOf(CadenceError); // global
    await expect(h.engine.activate(B.id)).rejects.toBeInstanceOf(CadenceError); // rule slot
  });
});

describe('getActiveId reconciliation is per slot', () => {
  it('follows a login inside the rule profile to the account that owns it', async () => {
    const h = await harness();
    const { A, B, rule, slotId } = await setupRule(h);
    await h.engine.activate(A.id);

    // Simulate a `/login` to B performed inside the rule profile: the profile's live token is now
    // B's (matching B's stored refresh token) while the rule's registry still records A.
    const store = ruleStore(h.paths, rule.id);
    await store.writeLiveCredentials(oauth('B', NOW + 10 * HOUR, 'r-B'));
    await store.writeOauthAccount({ accountUuid: 'uuid-B', emailAddress: 'B@x.com' });

    expect(await h.engine.getActiveId(slotId)).toBe(B.id);
    expect((await h.vault.getRule(rule.id))?.activeId).toBe(A.id);
  });

  it('follows a login of an inherited shared account inside the rule profile', async () => {
    const h = await harness();
    const { A, C, rule, slotId } = await setupRule(h);
    await h.engine.activate(A.id);

    const store = ruleStore(h.paths, rule.id);
    await store.writeLiveCredentials(oauth('C', NOW + 10 * HOUR, 'r-C'));
    await store.writeOauthAccount({ accountUuid: 'uuid-C', emailAddress: 'C@x.com' });

    expect(await h.engine.getActiveId(slotId)).toBe(C.id);
  });
});

describe('crash recovery per slot', () => {
  it('rolls a rule slot forward from a written-phase intent', async () => {
    const h = await harness();
    const { A, rule } = await setupRule(h);
    const stateDir = join(h.paths.vaultDir, 'slots', rule.id);
    const store = ruleStore(h.paths, rule.id);

    // The target's credentials are already live in the profile, but the switch never committed.
    const bundle = await h.vault.readBundle(A.id);
    await store.writeLiveCredentials(bundle.claudeAiOauth);
    await new IntentStore(stateDir).write({
      phase: 'written',
      targetId: A.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('rolled_forward');
    expect((await h.vault.getRule(rule.id))?.activeId).toBe(A.id);
    expect(await new IntentStore(stateDir).read()).toBeUndefined();
  });

  it('rolls a rule slot forward to an inherited shared account', async () => {
    const h = await harness();
    const { C, rule } = await setupRule(h);
    const stateDir = join(h.paths.vaultDir, 'slots', rule.id);
    const store = ruleStore(h.paths, rule.id);

    const bundle = await h.vault.readBundle(C.id);
    await store.writeLiveCredentials(bundle.claudeAiOauth);
    await new IntentStore(stateDir).write({
      phase: 'written',
      targetId: C.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('rolled_forward');
    expect((await h.vault.getRule(rule.id))?.activeId).toBe(C.id);
    expect(await h.vault.getActiveId()).toBeNull();
  });

  it('clears a rule slot begin-phase intent without committing', async () => {
    const h = await harness();
    const { A, rule } = await setupRule(h);
    const stateDir = join(h.paths.vaultDir, 'slots', rule.id);
    await new IntentStore(stateDir).write({
      phase: 'begin',
      targetId: A.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('cleared');
    expect((await h.vault.getRule(rule.id))?.activeId).toBeNull();
    expect(await new IntentStore(stateDir).read()).toBeUndefined();
  });

  it('recovers a legacy root intent as the global slot', async () => {
    const h = await harness();
    const { C, D } = await setupRule(h);
    await h.engine.activate(C.id); // global live = C

    // A pre-upgrade intent lives at the vault-dir root (no slots/ path) and describes the global slot.
    const dBundle = await h.vault.readBundle(D.id);
    await h.credStore.writeLiveCredentials(dBundle.claudeAiOauth);
    await new IntentStore(h.paths.vaultDir).write({
      phase: 'written',
      targetId: D.id,
      prevActiveId: C.id,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('rolled_forward');
    expect(await h.vault.getActiveId()).toBe(D.id);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });
});

describe('rotation adoption per slot', () => {
  it('adopts a later CLI rotation from the rule profile into the previous account', async () => {
    const h = await harness();
    const { A, B, rule } = await setupRule(h);
    await h.engine.activate(A.id);

    // The CLI rotated A's token inside the profile: a different refresh token, later expiry.
    const store = ruleStore(h.paths, rule.id);
    await store.writeLiveCredentials(oauth('A', NOW + 20 * HOUR, 'rotated-r-A'));
    await store.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    h.setNow(NOW + 2 * 60_000);
    const res = await h.engine.activate(B.id);

    expect(res.adoptedPreviousRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rotated-r-A');
  });

  it('does not adopt a live token that is not newer (direction guard)', async () => {
    const h = await harness();
    const { A, B, rule } = await setupRule(h);
    await h.engine.activate(A.id);

    // A live token that expires no later than the stored one cannot be a later rotation.
    const store = ruleStore(h.paths, rule.id);
    await store.writeLiveCredentials(oauth('A', NOW + 5 * HOUR, 'stale-r-A'));
    await store.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    h.setNow(NOW + 2 * 60_000);
    const res = await h.engine.activate(B.id, { force: true });

    expect(res.adoptedPreviousRotation).toBe(false);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('r-A');
  });
});

describe('refreshToken and slots', () => {
  it('refuses a network refresh for an account live in its rule slot (adopt-only)', async () => {
    const h = await harness();
    const { A } = await setupRule(h);
    await h.engine.activate(A.id);

    const r = await h.engine.refreshToken(A.id);

    expect(r.refreshed).toBe(false);
    expect(r.skippedReason).toBe('active_account');
  });

  it('refuses a network refresh for a shared account live in a rule slot', async () => {
    // A rule slot can hold an inherited shared account; its single-use refresh token belongs to the
    // sessions in that folder exactly as an included account's does.
    const h = await harness();
    const C = await h.engine.addAccount('C', bundleFor('C', NOW + 60_000));
    const A = await h.engine.addAccount('A', bundleFor('A', NOW + 10 * HOUR));
    const rule = await h.vault.createRule({ folders: ['C:\\work'], include: [A.id] });
    await h.engine.activate(C.id, { slot: ruleSlotId(rule.id) });

    const r = await h.engine.refreshToken(C.id);

    expect(r.refreshed).toBe(false);
    expect(r.skippedReason).toBe('active_account');
  });

  it('network-refreshes a NON-live included account whose token is near expiry', async () => {
    const h = await harness();
    const { A, rule } = await setupRule(h);
    await h.engine.activate(A.id); // A is live; a different included account is what we refresh

    // Include a fresh near-expiry account E in the same rule.
    const E = await h.engine.addAccount('E', bundleFor('E', NOW + 60_000));
    await h.vault.includeAccounts(rule.id, [E.id]);

    const r = await h.engine.refreshToken(E.id);

    expect(r.refreshed).toBe(true);
    expect((await h.vault.readBundle(E.id)).claudeAiOauth.refreshToken).toBe('rotated-r-E');
  });
});

describe('relogin heals the slot where the account is live', () => {
  it('a re-login of an account live in a rule slot heals the profile, not the global files', async () => {
    const h = await harness();
    const { A, C, rule } = await setupRule(h);
    await h.engine.activate(C.id); // global live = C
    await h.engine.activate(A.id); // rule slot live = A

    const tdir = join(h.root, 'relogin-A');
    await mkdir(tdir, { recursive: true });
    const tstore = new CredentialStore({
      claudeDir: tdir,
      credentialsPath: join(tdir, '.credentials.json'),
      claudeJsonPath: join(tdir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await tstore.writeLiveCredentials(oauth('A-fresh', NOW + 30 * HOUR, 'r-A-fresh'));
    await tstore.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    const res = await h.engine.reloginFromConfigDir(A.id, tdir);

    expect(res.healedLiveLogin).toBe(true);
    // The rule profile now holds the fresh grant; the global slot is untouched.
    expect((await ruleStore(h.paths, rule.id).readLiveCredentials())?.accessToken).toBe('A-fresh');
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
  });
});

describe('capture refuses inside a profile', () => {
  it('captureFromConfigDir refuses a config dir inside the profiles root', async () => {
    // This refusal compares REAL sandbox paths (the profile dir vs the profiles root), so the
    // engine's path rules must match the host filesystem rather than the harness's win32 default.
    const h = await harness(process.platform);
    const { rule } = await setupRule(h);
    const profileDir = groupProfileDir(h.paths.vaultDir, rule.id);
    await mkdir(profileDir, { recursive: true });
    await expect(h.engine.captureFromConfigDir('x', profileDir)).rejects.toMatchObject({
      code: 'capture_in_profile',
    });
  });

  it('captureCurrentLogin refuses when the engine config dir is inside the profiles root', async () => {
    const h = await harness();
    // An engine whose CLAUDE_CONFIG_DIR points at a rule profile — the onboarding-in-a-profile mistake.
    const profileDir = groupProfileDir(h.paths.vaultDir, 'some-rule-id');
    const insidePaths: Paths = {
      claudeDir: profileDir,
      credentialsPath: join(profileDir, '.credentials.json'),
      claudeJsonPath: join(profileDir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    };
    const inside = new SwitchEngine({
      paths: insidePaths,
      protector: h.protector,
      liveCredentialChannel: new FileCredentialChannel(insidePaths.credentialsPath),
      clock: h.clock,
      // Real sandbox paths (profile dir inside the profiles root): host path rules, not win32.
      platform: process.platform,
    });
    await expect(inside.captureCurrentLogin('x')).rejects.toMatchObject({
      code: 'capture_in_profile',
    });
  });
});

describe('removeAccount / quarantine of an included account', () => {
  it('clears the rule slot when the removed included account was live in it', async () => {
    const h = await harness();
    const { A, B, rule, slotId } = await setupRule(h);
    await h.engine.activate(A.id);

    await h.engine.removeAccount(A.id);

    // The profile's live credentials are gone (the slot fails closed), the rule keeps B, and its
    // active id is cleared.
    expect(await ruleStore(h.paths, rule.id).readLiveCredentials()).toBeUndefined();
    const r = await h.vault.getRule(rule.id);
    expect(r?.include).toEqual([B.id]);
    expect(r?.activeId).toBeNull();
    expect(await h.engine.getActiveId(slotId)).toBeNull();
  });

  it('quarantine and clear-quarantine work on a reserved account', async () => {
    const h = await harness();
    const { B } = await setupRule(h);

    await h.vault.quarantine(B.id, 'dead token');
    expect((await h.vault.getAccount(B.id))?.quarantined).toBe(true);
    // A quarantined account cannot be activated.
    await expect(h.engine.activate(B.id)).rejects.toMatchObject({ code: 'invalid_grant' });

    await h.engine.clearQuarantine(B.id);
    expect((await h.vault.getAccount(B.id))?.quarantined).toBe(false);
  });
});

describe('liveSlots', () => {
  it('reports the reconciled live account of the global slot and every rule', async () => {
    const h = await harness();
    const { A, C, slotId } = await setupRule(h);
    await h.engine.activate(C.id);
    await h.engine.activate(A.id);

    const live = await h.engine.liveSlots();
    expect([...live.keys()].sort()).toEqual(['global', slotId].sort());
    expect(live.get('global')).toBe(C.id);
    expect(live.get(slotId)).toBe(A.id);
  });
});

describe('liveSlotToken', () => {
  it('reads the live token from the rule slot an account is live in, not the vault bundle', async () => {
    const h = await harness();
    const { A, rule, slotId } = await setupRule(h);
    await h.engine.activate(A.id); // A live in its rule slot

    const tok = await h.engine.liveSlotToken(A.id);
    expect(tok?.slot).toBe(slotId);
    expect(tok?.accessToken).toBe('A');
    expect(tok?.accountUuid).toBe('uuid-A');
    // Even after the rule profile's live token rotates (a running session refreshes it), the
    // getter reads the fresh slot copy, never the stale vault bundle.
    await ruleStore(h.paths, rule.id).writeLiveCredentials(oauth('A2', NOW + 9 * HOUR));
    expect((await h.engine.liveSlotToken(A.id))?.accessToken).toBe('A2');
  });

  it('reads the rule slot token for a shared account the rule slot inherited', async () => {
    const h = await harness();
    const { C, slotId } = await setupRule(h);
    await h.engine.activate(C.id, { slot: slotId });
    const tok = await h.engine.liveSlotToken(C.id);
    expect(tok?.slot).toBe(slotId);
    expect(tok?.accessToken).toBe('C');
  });

  it('reads the global slot token for a globally live account', async () => {
    const h = await harness();
    const { C } = await setupRule(h);
    await h.engine.activate(C.id);
    const tok = await h.engine.liveSlotToken(C.id);
    expect(tok?.slot).toBe('global');
    expect(tok?.accessToken).toBe('C');
  });

  it('returns undefined for an account not live in any slot', async () => {
    const h = await harness();
    const { A, B } = await setupRule(h);
    await h.engine.activate(A.id);
    // B is included but not the live one.
    expect(await h.engine.liveSlotToken(B.id)).toBeUndefined();
  });
});

describe('spawn/session slot resolution helpers', () => {
  it('configDirForAccount: an included account gets its rule profile, an idle shared one none', async () => {
    const h = await harness();
    const { A, C, rule } = await setupRule(h);
    expect(await h.engine.configDirForAccount(A.id)).toBe(
      groupProfileDir(h.paths.vaultDir, rule.id),
    );
    expect(await h.engine.configDirForAccount(C.id)).toBeUndefined();
  });

  it('configDirForAccount: a shared account live in a rule slot gets that profile', async () => {
    const h = await harness();
    const { C, D, rule, slotId } = await setupRule(h);
    await h.engine.activate(C.id, { slot: slotId });
    await h.engine.activate(D.id);

    expect(await h.engine.configDirForAccount(C.id)).toBe(
      groupProfileDir(h.paths.vaultDir, rule.id),
    );
    // A shared account live in the global slot runs in the main config dir.
    expect(await h.engine.configDirForAccount(D.id)).toBeUndefined();
  });

  it('configDirForAccount: an account several rules include gets the profile it is live in, else none', async () => {
    const h = await harness();
    const { A, rule } = await setupRule(h);
    const other = await h.vault.createRule({ folders: ['C:\\client'], include: [A.id] });

    // Live in neither: there is no single profile it belongs to.
    expect(await h.engine.configDirForAccount(A.id)).toBeUndefined();
    await h.engine.activate(A.id, { slot: ruleSlotId(other.id) });
    expect(await h.engine.configDirForAccount(A.id)).toBe(
      groupProfileDir(h.paths.vaultDir, other.id),
    );
    void rule;
  });

  it('configDirForSlot: a rule slot is its profile dir, the global slot none', async () => {
    const h = await harness();
    const { rule, slotId } = await setupRule(h);
    expect(h.engine.configDirForSlot(slotId)).toBe(groupProfileDir(h.paths.vaultDir, rule.id));
    expect(h.engine.configDirForSlot('global')).toBeUndefined();
  });

  it('slotForConfigDir maps a profile dir to its rule slot and everything else to global', async () => {
    const h = await harness();
    const { rule, slotId } = await setupRule(h);
    const profileDir = groupProfileDir(h.paths.vaultDir, rule.id);
    expect(await h.engine.slotForConfigDir(profileDir)).toBe(slotId);
    // Absent / main / unrecognized dirs are global.
    expect(await h.engine.slotForConfigDir(null)).toBe('global');
    expect(await h.engine.slotForConfigDir(undefined)).toBe('global');
    expect(await h.engine.slotForConfigDir(h.paths.claudeDir)).toBe('global');
    expect(await h.engine.slotForConfigDir('C:\\nowhere')).toBe('global');
    // A trailing separator and a different drive-letter case still match on win32.
    expect(await h.engine.slotForConfigDir(profileDir + '\\')).toBe(slotId);
    expect(await h.engine.slotForConfigDir(profileDir.toUpperCase())).toBe(slotId);
  });

  it('resolveFolderRule matches the longest ruled folder, else null', async () => {
    const h = await harness();
    const { rule } = await setupRule(h); // ruled folder: C:\work
    expect(await h.engine.resolveFolderRule('C:\\work')).toEqual({
      ruleId: rule.id,
      folder: 'C:\\work',
    });
    expect(await h.engine.resolveFolderRule('C:\\work\\sub\\deeper')).toEqual({
      ruleId: rule.id,
      folder: 'C:\\work',
    });
    expect(await h.engine.resolveFolderRule('C:\\other')).toBeNull();
    // Never a bare string prefix: C:\work2 is not within C:\work.
    expect(await h.engine.resolveFolderRule('C:\\work2')).toBeNull();
  });

  it('resolveFolderRule picks the nested rule for its subtree, with no merging', async () => {
    const h = await harness();
    const { C, rule } = await setupRule(h);
    const nested = await h.vault.createRule({ folders: ['C:\\work\\client'], exclude: [C.id] });
    expect(await h.engine.resolveFolderRule('C:\\work\\client\\src')).toEqual({
      ruleId: nested.id,
      folder: 'C:\\work\\client',
    });
    expect(await h.engine.resolveFolderRule('C:\\work\\other')).toEqual({
      ruleId: rule.id,
      folder: 'C:\\work',
    });
  });
});
