// Property run over the rule state machine with alias scopes: random sequences of includeInAlias /
// excludeInAlias / resetAlias / includeInFolder / resetFolder / activate / ensureRuleLive /
// repairSlots / removeAccount, with crashes injected at the labelled fault points (each followed by
// a "restart": a fresh engine over the same files, then recover()). After EVERY step the physical and
// registry invariants must hold:
//   - checkSlots(): no account in two slots, no reserved account in global (after a crash only these
//     two are required; a completed step must leave no violation at all);
//   - a reserved row in exactly one file outside a crash window, the global active id a shared row,
//     every rule with at least one scope, the schema stamped 3 exactly while an alias rule exists;
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

/** Every labelled checkpoint of the rule mutations. */
const FAULT_POINTS = [
  'include:after-hand-off',
  'include:after-row-move',
  'include:after-ensure-live',
  'exclude:after-rule-write',
  'exclude:after-ensure-live',
  'reset:after-rule-write',
  'reset:after-adopt',
  'reset:after-clear-live',
  'reset:after-release',
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
    const rules = await engine.listRules();
    const g = rules.length > 0 ? pick(rules) : undefined;
    const op = Math.floor(rand() * 10);
    const freshBefore = (await engine.getGuardSnapshotFreshness()).fresh;
    let desc = '';
    let crashed = false;
    try {
      switch (op) {
        case 0:
          desc = 'includeInAlias';
          await engine.includeInAlias(pick(folders), pick(aliases), subset());
          break;
        case 1:
          desc = 'resetAlias';
          await engine.resetAlias(pick(folders), pick(aliases), undefined, {
            force: rand() < 0.5,
          });
          break;
        case 2:
          desc = 'includeInFolder';
          await engine.includeInFolder(pick(folders), subset());
          break;
        case 3:
          desc = 'resetFolder';
          await engine.resetFolder(pick(folders), undefined, { force: rand() < 0.5 });
          break;
        case 4:
          desc = 'excludeInAlias';
          await engine.excludeInAlias(pick(folders), pick(aliases), subset(), {
            force: rand() < 0.5,
          });
          break;
        case 5: {
          desc = 'resetAlias accounts';
          const scope = g?.aliases?.[0];
          if (g && scope) {
            const named = [...g.include, ...g.exclude];
            const ids = named.filter(() => rand() < 0.5);
            await engine.resetAlias(scope.folder, scope.alias, ids.length > 0 ? ids : named, {
              force: rand() < 0.5,
            });
          }
          break;
        }
        case 6:
          desc = 'activate';
          await engine.activate(pick(accounts).id, { force: rand() < 0.5 });
          break;
        case 7:
          desc = 'ensureRuleLive';
          if (g) await engine.ensureRuleLive(g.id);
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
    const rulesPath = join(paths.vaultDir, 'groups.json');
    const grp = existsSync(rulesPath)
      ? (JSON.parse(await readFile(rulesPath, 'utf8')) as {
          schemaVersion: number;
          reserved: { id: string }[];
          rules: { id: string; folders: string[]; aliases?: unknown[] }[];
        })
      : { schemaVersion: 2, reserved: [], rules: [] };
    const reservedIds = grp.reserved.map((r) => r.id);
    if (!crashed && acc.accounts.some((a) => reservedIds.includes(a.id))) {
      failures.push(`seed ${seed} step ${step} ${desc}: a row in both files`);
    }
    if (acc.activeId !== null && reservedIds.includes(acc.activeId)) {
      failures.push(`seed ${seed} step ${step} ${desc}: the global active id is reserved`);
    }
    for (const x of grp.rules) {
      if (x.folders.length + (x.aliases?.length ?? 0) === 0) {
        failures.push(`seed ${seed} step ${step} ${desc}: rule ${x.id} has no scope`);
      }
    }
    const anyAlias = grp.rules.some((x) => (x.aliases?.length ?? 0) > 0);
    if (grp.schemaVersion !== (anyAlias ? 3 : 2)) {
      failures.push(
        `seed ${seed} step ${step} ${desc}: schema ${grp.schemaVersion} with alias rules=${anyAlias}`,
      );
    }
    if (!crashed && freshBefore && grp.rules.length > 0) {
      const fresh = await engine.getGuardSnapshotFreshness();
      if (fresh.present && !fresh.fresh) {
        failures.push(`seed ${seed} step ${step} ${desc}: guard snapshot stale after the step`);
      }
    }
  }
  return failures;
}

describe('random alias/folder rule sequences with crashes keep the slot invariants', () => {
  it('seeds 1..4, 80 steps each', async () => {
    const all: string[] = [];
    for (let seed = 1; seed <= 4; seed += 1) all.push(...(await run(seed, 80)));
    expect(all).toEqual([]);
  }, 300_000);
});
