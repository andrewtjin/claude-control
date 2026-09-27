// Property run over the group state machine with alias scopes: random sequences of bindAlias /
// unbindAlias / bindFolder / unbindFolder / addGroupMembers / removeGroupMembers / activate /
// ensureGroupLive / repairSlots / removeAccount, with crashes injected at the labelled fault points
// (each followed by a "restart": a fresh engine over the same files, then recover()). After EVERY
// step the physical and registry invariants must hold:
//   - checkSlots(): no account in two slots, no reserved account in global (after a crash only these
//     two are required; a completed step must leave no violation at all);
//   - groups disjoint, no row in both files outside a crash window, the global active id a shared
//     row, every group with at least one scope;
//   - the guard snapshot fresh after every completed mutation that started from a fresh one.
// A refusal an op documents (RefreshError / VaultError / ...) is fine; any other throw is a failure.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { FileCredentialChannel } from './credentialStore.js';
import { sandboxPaths } from './paths.js';
import type { ClaudeOauth, CredentialBundle, StoredAccount } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** A small deterministic PRNG (LCG), so a failing seed replays exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The error a fault checkpoint throws: a simulated crash, told apart from a real refusal. */
class Crash extends Error {}

/** Every labelled checkpoint of the group mutations. */
const FAULT_POINTS = [
  'bind:after-global-switch',
  'bind:after-row-move',
  'bind:after-ensure-live',
  'grow:after-global-switch',
  'grow:after-row-move',
  'grow:after-ensure-live',
  'shrink:after-switch-off',
  'shrink:after-release',
  'unbind:after-adopt',
  'unbind:after-clear-live',
  'unbind:after-release',
];

/** Refusals the ops document; anything else escaping an op is a failure. */
const DOCUMENTED = [
  'RefreshError',
  'VaultError',
  'UnknownAccountError',
  'CadenceError',
  'QuarantineError',
  'SlotError',
];

async function run(seed: number, steps: number): Promise<string[]> {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const root = await mkdtemp(join(tmpdir(), 'ce-alias-prop-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const folders: string[] = [];
  for (const f of ['f1', 'f2', join('f2', 'sub')]) {
    await mkdir(join(root, f), { recursive: true });
    folders.push(realpathSync.native(join(root, f)));
  }
  let now = NOW;
  const clock = (): number => now;
  const bindFs: BindFs = {
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    cwd: () => root,
    homedir: () => join(root, 'home'),
  };
  const refresh = (cur: ClaudeOauth): Promise<ClaudeOauth> =>
    Promise.resolve({ ...cur, expiresAt: clock() + 10 * HOUR });
  let crashAt: string | null = null;
  const mk = (): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector: new InsecurePassthroughProtector(),
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 60_000,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      bindFs,
      isProcessAlive: () => false,
      bindEnforce: 'block',
      faultAt: (cp) => {
        if (crashAt !== null && cp === crashAt) {
          crashAt = null;
          throw new Crash(cp);
        }
      },
    });
  let engine = mk();
  const accounts: StoredAccount[] = [];
  const bundle = (label: string, refreshSuffix = ''): CredentialBundle => ({
    claudeAiOauth: {
      accessToken: label,
      refreshToken: 'r-' + label + refreshSuffix,
      expiresAt: now + 10 * HOUR,
    },
    oauthAccount: { accountUuid: 'uuid-' + label, emailAddress: label + '@x.com' },
  });
  for (const l of ['A', 'B', 'C', 'D', 'E']) accounts.push(await engine.addAccount(l, bundle(l)));
  await engine.activate(accounts[0]!.id, { force: true });

  const aliases = ['x', 'X ', 'y'];
  const failures: string[] = [];
  const subset = (): string[] => {
    const some = accounts.filter(() => rand() < 0.4).map((a) => a.id);
    return some.length > 0 ? some : [pick(accounts).id];
  };

  for (let step = 0; step < steps && failures.length <= 5; step += 1) {
    now += 2 * 60_000;
    if (rand() < 0.15) crashAt = pick(FAULT_POINTS);
    const groups = await engine.listGroups();
    const g = groups.length > 0 ? pick(groups) : undefined;
    const op = Math.floor(rand() * 10);
    const freshBefore = (await engine.getGuardSnapshotFreshness()).fresh;
    let desc = '';
    let crashed = false;
    try {
      switch (op) {
        case 0:
          desc = 'bindAlias';
          await engine.bindAlias(pick(folders), pick(aliases), subset());
          break;
        case 1:
          desc = 'unbindAlias';
          await engine.unbindAlias(pick(folders), pick(aliases), { force: rand() < 0.5 });
          break;
        case 2:
          desc = 'bindFolder';
          await engine.bindFolder(pick(folders), subset());
          break;
        case 3:
          desc = 'unbindFolder';
          await engine.unbindFolder(pick(folders), { force: rand() < 0.5 });
          break;
        case 4:
          desc = 'addGroupMembers';
          if (g) await engine.addGroupMembers(g.id, subset());
          break;
        case 5: {
          desc = 'removeGroupMembers';
          if (g) {
            const ids = [
              g.members[0]!.id,
              ...g.members.filter(() => rand() < 0.5).map((m) => m.id),
            ];
            await engine.removeGroupMembers(g.id, [...new Set(ids)], { force: rand() < 0.5 });
          }
          break;
        }
        case 6:
          desc = 'activate';
          await engine.activate(pick(accounts).id, { force: rand() < 0.5 });
          break;
        case 7:
          desc = 'ensureGroupLive';
          if (g) await engine.ensureGroupLive(g.id);
          break;
        case 8:
          desc = 'repairSlots';
          await engine.repairSlots();
          break;
        case 9: {
          desc = 'removeAccount+readd';
          const victim = pick(accounts);
          await engine.removeAccount(victim.id);
          accounts[accounts.indexOf(victim)] = await engine.addAccount(
            victim.label,
            bundle(victim.label, String(step)),
          );
          break;
        }
      }
    } catch (err) {
      if (err instanceof Crash) {
        crashed = true;
        desc += ` crashed at ${err.message}`;
      } else if (!DOCUMENTED.includes((err as Error).name)) {
        failures.push(
          `seed ${seed} step ${step} ${desc}: ${(err as Error).name} ${(err as Error).message}`,
        );
      }
    }
    crashAt = null;
    if (crashed) {
      engine = mk(); // restart: a fresh process over the same files
      try {
        await engine.recover();
      } catch (err) {
        failures.push(
          `seed ${seed} step ${step} ${desc}: recover() threw ${(err as Error).message}`,
        );
      }
    }

    const violations = (await engine.checkSlots()).filter((v) => v.kind !== 'broken_profile_link');
    const severe = violations.filter(
      (v) => v.kind === 'account_in_multiple_slots' || v.kind === 'reserved_live_in_global',
    );
    if (severe.length > 0) {
      failures.push(`seed ${seed} step ${step} ${desc}: ${severe.map((v) => v.detail).join('; ')}`);
    }
    if (!crashed && violations.length > 0) {
      failures.push(
        `seed ${seed} step ${step} ${desc} (no crash): ${violations.map((v) => `${v.kind}: ${v.detail}`).join('; ')}`,
      );
    }
    const acc = JSON.parse(await readFile(join(paths.vaultDir, 'accounts.json'), 'utf8')) as {
      activeId: string | null;
      accounts: { id: string }[];
    };
    const groupsPath = join(paths.vaultDir, 'groups.json');
    const grp = existsSync(groupsPath)
      ? (JSON.parse(await readFile(groupsPath, 'utf8')) as {
          groups: {
            id: string;
            members: { id: string }[];
            folders: string[];
            aliases?: unknown[];
          }[];
        })
      : { groups: [] };
    const memberIds = grp.groups.flatMap((x) => x.members.map((m) => m.id));
    if (new Set(memberIds).size !== memberIds.length) {
      failures.push(`seed ${seed} step ${step} ${desc}: an account in two groups`);
    }
    if (!crashed && acc.accounts.some((a) => memberIds.includes(a.id))) {
      failures.push(`seed ${seed} step ${step} ${desc}: a row in both files`);
    }
    if (acc.activeId !== null && memberIds.includes(acc.activeId)) {
      failures.push(`seed ${seed} step ${step} ${desc}: the global active id is reserved`);
    }
    for (const x of grp.groups) {
      if (x.folders.length + (x.aliases?.length ?? 0) === 0) {
        failures.push(`seed ${seed} step ${step} ${desc}: group ${x.id} has no scope`);
      }
    }
    if (!crashed && freshBefore && grp.groups.length > 0) {
      const fresh = await engine.getGuardSnapshotFreshness();
      if (fresh.present && !fresh.fresh) {
        failures.push(`seed ${seed} step ${step} ${desc}: guard snapshot stale after the step`);
      }
    }
  }
  return failures;
}

describe('random alias/folder binding sequences with crashes keep the slot invariants', () => {
  it('seeds 1..4, 80 steps each', async () => {
    const all: string[] = [];
    for (let seed = 1; seed <= 4; seed += 1) all.push(...(await run(seed, 80)));
    expect(all).toEqual([]);
  }, 300_000);
});
