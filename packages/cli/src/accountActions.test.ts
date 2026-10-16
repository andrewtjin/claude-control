// The account actions on their own: each success result and each refusal, driven against a fake
// engine handed in through the context, so nothing here touches a real vault, a real login or a
// real `claude`. The command wrappers' exact output is pinned in program.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CadenceError,
  LockTimeoutError,
  QuarantineError,
  RefreshError,
  SharedTokenError,
  SlotError,
  SwitchEngineError,
  SwitchFailedError,
  UnknownAccountError,
  UnsettledSwitchError,
  VaultError,
  type AccountView,
  type ActivateResult,
  type StoredAccount,
} from '@claude-control/switch-engine';
import {
  AccountActionError,
  addAccount,
  removeAccount,
  renameAccount,
  runAccountAction,
  setExcluded,
  switchAccount,
  type AccountActionContext,
  type AccountActionErrorCode,
  type LoginWindow,
} from './accountActions.js';
import { CliFailure, reportFatal } from './context.js';

// The fresh add makes its throwaway dir beside the vault, so the vault is moved into a temp root
// for every test; nothing may land in the operator's real data dir.
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

// The engine an action builds when the caller hands none in, recorded so a test can see which log
// sink it was built with.
const built = vi.hoisted((): { calls: unknown[][]; engine: unknown } => ({
  calls: [],
  engine: undefined,
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: (...args: unknown[]) => {
    built.calls.push(args);
    return built.engine;
  },
}));

// The older-daemon check reads the running daemon's report from the real data dir; it is stubbed
// so a test decides whether such a daemon is running. Everything else in the module is real.
const folderIo = vi.hoisted(() => ({
  refuseOnOlderDaemon: vi.fn((): Promise<void> => Promise.resolve()),
}));
vi.mock('./folderCommands.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./folderCommands.js')>();
  return { ...real, refuseOnOlderDaemon: folderIo.refuseOnOlderDaemon };
});

const work: AccountView = {
  id: 'id-1',
  label: 'Work',
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
};

const activated: ActivateResult = {
  ok: true,
  activeAccountId: 'id-1',
  wroteCredentials: true,
  refreshed: false,
  adoptedPreviousRotation: false,
};

/** A fake engine with every method an action calls; each test overrides what it needs. */
function fakeEngine() {
  return {
    listAllAccounts: vi.fn((): Promise<AccountView[]> => Promise.resolve([work])),
    listRules: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    liveSlots: vi.fn((): Promise<Map<string, string | null>> => Promise.resolve(new Map())),
    activate: vi.fn((_id: string, _opts: { force: boolean; origin: string; slot?: string }) =>
      Promise.resolve(activated),
    ),
    setAutoSwitchExcluded: vi.fn((_id: string, _excluded: boolean) => Promise.resolve()),
    renameAccount: vi.fn((id: string, label: string): Promise<StoredAccount> =>
      Promise.resolve({ ...work, id, label: label.trim() }),
    ),
    removeAccount: vi.fn((_id: string) => Promise.resolve()),
    captureCurrentLogin: vi.fn((label: string): Promise<StoredAccount> =>
      Promise.resolve({ ...work, id: 'new-1', label }),
    ),
    captureFromConfigDir: vi.fn((label: string, _dir: string): Promise<StoredAccount> =>
      Promise.resolve({ ...work, id: 'new-1', label }),
    ),
    captureFromKeychainDelta: vi.fn(
      (label: string, _dir: string, _prior: unknown): Promise<StoredAccount> =>
        Promise.resolve({ ...work, id: 'new-1', label }),
    ),
    readLiveOauth: vi.fn(() => Promise.resolve(undefined)),
  };
}

let engine: ReturnType<typeof fakeEngine>;
let ctx: AccountActionContext;

beforeEach(async () => {
  pathsIo.dataRoot = await mkdtemp(join(tmpdir(), 'cctl-actions-'));
  engine = fakeEngine();
  ctx = { engine: engine as unknown as NonNullable<AccountActionContext['engine']> };
  built.calls = [];
  built.engine = engine;
  folderIo.refuseOnOlderDaemon.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(pathsIo.dataRoot, { recursive: true, force: true });
});

/** The refusal an action threw, asserted to be an AccountActionError. */
async function refusal(run: Promise<unknown>): Promise<AccountActionError> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AccountActionError);
  return err as AccountActionError;
}

/** Expect an action to be refused with this code and exactly this line. */
async function expectRefused(
  run: Promise<unknown>,
  code: AccountActionErrorCode,
  message: string,
): Promise<void> {
  const err = await refusal(run);
  expect({ code: err.code, message: err.message }).toEqual({ code, message });
}

describe('the engine an action runs against', () => {
  it('reuses the engine the caller hands in and builds none', async () => {
    await removeAccount('Work', ctx);
    expect(built.calls).toEqual([]);
    expect(engine.removeAccount).toHaveBeenCalledWith('id-1');
  });

  it('builds one on the default paths, logging to stderr, when the caller hands none in', async () => {
    await removeAccount('Work');
    // Both undefined: buildEngine's own defaults, the real paths and process.stderr.
    expect(built.calls).toEqual([[undefined, undefined]]);
  });

  it("builds one logging to the caller's sink when it gives one", async () => {
    const sink = { write: () => true };
    await setExcluded('Work', true, { logSink: sink });
    expect(built.calls).toEqual([[undefined, sink]]);
  });
});

describe('resolving the account', () => {
  it('refuses an unknown ref before touching anything', async () => {
    await expectRefused(removeAccount('ghost', ctx), 'not_found', 'No account matches "ghost".');
    expect(engine.removeAccount).not.toHaveBeenCalled();
  });

  it('refuses a label two accounts answer to', async () => {
    engine.listAllAccounts.mockResolvedValue([work, { ...work, id: 'id-2' }]);
    await expectRefused(
      switchAccount('Work', {}, ctx),
      'ambiguous',
      '"Work" matches 2 accounts; use the id.',
    );
    expect(engine.activate).not.toHaveBeenCalled();
  });

  it('reaches a reserved account by label, case-insensitively', async () => {
    engine.listAllAccounts.mockResolvedValue([{ ...work, ruleIds: ['g1'] }]);
    const out = await setExcluded('work', true, ctx);
    expect(out.account.id).toBe('id-1');
  });
});

describe('switchAccount', () => {
  it('activates a shared account in the global slot and says what changed', async () => {
    engine.activate.mockResolvedValueOnce({ ...activated, refreshed: true });
    const out = await switchAccount('Work', {}, ctx);
    expect(engine.activate).toHaveBeenCalledWith('id-1', {
      force: false,
      origin: 'manual',
      slot: 'global',
    });
    expect(out).toMatchObject({
      account: { id: 'id-1' },
      folderRule: null,
      message: 'Activated Work (credentials written, token refreshed).',
    });
    expect(folderIo.refuseOnOlderDaemon).not.toHaveBeenCalled();
  });

  it('passes --force through', async () => {
    await switchAccount('Work', { force: true }, ctx);
    expect(engine.activate.mock.calls[0]?.[1]).toMatchObject({ force: true });
  });

  it('names the folder slot an included account went live in', async () => {
    engine.listAllAccounts.mockResolvedValue([{ ...work, ruleIds: ['g1'] }]);
    engine.listRules.mockResolvedValue([
      { id: 'g1', label: 'client', include: ['id-1'], exclude: [], folders: ['C:/repos/client'] },
    ]);
    engine.liveSlots.mockResolvedValue(new Map([['group:g1', 'id-1']]));
    const out = await switchAccount('Work', {}, ctx);
    expect(engine.activate.mock.calls[0]?.[1]).toMatchObject({ slot: 'group:g1' });
    expect(out.folderRule).toMatchObject({ label: 'client', folders: ['C:/repos/client'] });
    expect(out.message).toMatch(/^Activated Work in the folder slot of .*C:\/repos\/client/);
    // The account is reserved, not shared, so an older daemon cannot also seat it globally.
    expect(folderIo.refuseOnOlderDaemon).not.toHaveBeenCalled();
  });

  it('asserts no slot for an account several rules include', async () => {
    engine.listAllAccounts.mockResolvedValue([{ ...work, ruleIds: ['g1', 'g2'] }]);
    await switchAccount('Work', {}, ctx);
    expect(engine.activate.mock.calls[0]?.[1]).not.toHaveProperty('slot');
  });

  it('says the global slot took it when --folder names a folder no rule covers', async () => {
    const out = await switchAccount('Work', { folder: pathsIo.dataRoot }, ctx);
    expect(engine.activate.mock.calls[0]?.[1]).toMatchObject({ slot: 'global' });
    expect(out.message).toBe(
      `Activated Work in the global slot (no folder rule applies to ${pathsIo.dataRoot}) (credentials written).`,
    );
  });

  it('refuses a --folder that is not a usable folder, before switching', async () => {
    await expectRefused(
      switchAccount('Work', { folder: '' }, ctx),
      'bad_folder',
      'cannot use folder "": path is empty',
    );
    expect(engine.activate).not.toHaveBeenCalled();
  });

  it('refuses to put a shared account in a folder slot while an older daemon runs', async () => {
    engine.listRules.mockResolvedValue([
      { id: 'g1', label: 'client', include: [], exclude: [], folders: [pathsIo.dataRoot] },
    ]);
    folderIo.refuseOnOlderDaemon.mockRejectedValueOnce(
      new CliFailure('the running daemon predates folder rules. Nothing was changed.'),
    );
    await expectRefused(
      switchAccount('Work', { folder: pathsIo.dataRoot }, ctx),
      'older_daemon',
      'the running daemon predates folder rules. Nothing was changed.',
    );
    expect(engine.activate).not.toHaveBeenCalled();
  });

  it('maps every expected engine refusal onto its code and line', async () => {
    const cases: Array<[Error, AccountActionErrorCode, string]> = [
      [new QuarantineError('dead'), 'quarantined', 'Work is quarantined; re-login required.'],
      [
        new CadenceError('switched 5s ago', 1000),
        'cadence',
        'switched 5s ago. Use --force to override.',
      ],
      [new UnknownAccountError('id-1'), 'unknown_account', 'no account with id "id-1"'],
      [
        new SlotError('Work cannot go there', 'slot_ambiguous'),
        'slot_refused',
        'Work cannot go there. Nothing was changed - name the folder: cctl switch Work --folder <folder>.',
      ],
      [new SwitchFailedError('half written', 'restored'), 'switch_failed', 'half written'],
      [new UnsettledSwitchError('still settling'), 'switch_failed', 'still settling'],
      [new SharedTokenError('stored twice'), 'switch_failed', 'stored twice'],
      [
        new RefreshError('token endpoint overloaded (529)', 'http_529'),
        'overloaded',
        'token endpoint overloaded (529). Nothing was changed - try again shortly.',
      ],
    ];
    for (const [thrown, code, line] of cases) {
      engine.activate.mockRejectedValueOnce(thrown);
      const err = await refusal(switchAccount('Work', {}, ctx));
      expect({ code: err.code, message: err.message, cause: err.cause }).toEqual({
        code,
        message: line,
        cause: thrown,
      });
    }
  });

  it('lets an unexpected failure escape as itself', async () => {
    const boom = new SwitchEngineError('lock lost', 'lock_timeout');
    engine.activate.mockRejectedValueOnce(boom);
    await expect(switchAccount('Work', {}, ctx)).rejects.toBe(boom);
    const plain = new Error('disk on fire');
    engine.activate.mockRejectedValueOnce(plain);
    await expect(switchAccount('Work', {}, ctx)).rejects.toBe(plain);
  });
});

describe('setExcluded', () => {
  it('excludes, and says so', async () => {
    const out = await setExcluded('Work', true, ctx);
    expect(engine.setAutoSwitchExcluded).toHaveBeenCalledWith('id-1', true);
    expect(out).toMatchObject({
      excluded: true,
      changed: true,
      message: 'Excluded Work from auto-switch (manual switches still work).',
    });
  });

  it('includes an excluded account again', async () => {
    engine.listAllAccounts.mockResolvedValue([{ ...work, autoSwitchExcluded: true }]);
    const out = await setExcluded('Work', false, ctx);
    expect(engine.setAutoSwitchExcluded).toHaveBeenCalledWith('id-1', false);
    expect(out).toMatchObject({
      changed: true,
      message: 'Work is available to auto-switch again.',
    });
  });

  it('writes nothing when the account is already in the asked state', async () => {
    expect(await setExcluded('Work', false, ctx)).toMatchObject({
      changed: false,
      message: 'Work is already available to auto-switch.',
    });
    engine.listAllAccounts.mockResolvedValue([{ ...work, autoSwitchExcluded: true }]);
    expect(await setExcluded('Work', true, ctx)).toMatchObject({
      changed: false,
      message: 'Work is already excluded from auto-switch.',
    });
    expect(engine.setAutoSwitchExcluded).not.toHaveBeenCalled();
  });
});

describe('renameAccount', () => {
  it('renames by id and reports the label the vault stored', async () => {
    const out = await renameAccount('Work', '  Personal  ', ctx);
    expect(engine.renameAccount).toHaveBeenCalledWith('id-1', '  Personal  ');
    expect(out).toMatchObject({
      previousLabel: 'Work',
      account: { label: 'Personal' },
      changed: true,
      message: 'Renamed Work to Personal (id-1).',
    });
  });

  it('writes nothing for the label it already has', async () => {
    const out = await renameAccount('Work', ' Work ', ctx);
    expect(engine.renameAccount).not.toHaveBeenCalled();
    expect(out).toMatchObject({ changed: false, message: 'Work already has that label.' });
  });

  it("refuses with the vault's own words on a collision or an empty label", async () => {
    engine.renameAccount.mockRejectedValueOnce(
      new VaultError('"home" already refers to x', { code: 'label_taken' }),
    );
    await expectRefused(
      renameAccount('Work', 'home', ctx),
      'vault_refused',
      '"home" already refers to x',
    );
  });

  it('lets any other failure escape as itself', async () => {
    const boom = new Error('disk on fire');
    engine.renameAccount.mockRejectedValueOnce(boom);
    await expect(renameAccount('Work', 'home', ctx)).rejects.toBe(boom);
  });

  it('lets a vault fault escape as itself rather than call it a refusal', async () => {
    const malformed = new VaultError('the account registry at x is malformed');
    engine.renameAccount.mockRejectedValueOnce(malformed);
    await expect(renameAccount('Work', 'home', ctx)).rejects.toBe(malformed);
  });

  it('refuses an empty label with the vault words', async () => {
    engine.renameAccount.mockRejectedValueOnce(
      new VaultError('a label cannot be empty', { code: 'label_empty' }),
    );
    await expectRefused(
      renameAccount('Work', ' ', ctx),
      'vault_refused',
      'a label cannot be empty',
    );
  });
});

describe('removeAccount', () => {
  it('removes by id and names the account', async () => {
    const out = await removeAccount('id-1', ctx);
    expect(engine.removeAccount).toHaveBeenCalledWith('id-1');
    expect(out).toMatchObject({ account: { label: 'Work' }, message: 'Removed Work.' });
  });
});

describe('addAccount (the current login)', () => {
  it('stores the live login and says it is active', async () => {
    const out = await addAccount('new', {}, ctx);
    expect(engine.captureCurrentLogin).toHaveBeenCalledWith('new');
    expect(out).toMatchObject({
      fresh: false,
      message: 'Added new (new-1) and set it active.',
    });
  });

  it("refuses a duplicate with the vault's words, keeping the cause", async () => {
    const duplicate = new VaultError('"new" already refers to x', { code: 'label_taken' });
    engine.captureCurrentLogin.mockRejectedValueOnce(duplicate);
    const err = await refusal(addAccount('new', {}, ctx));
    expect({ code: err.code, message: err.message, cause: err.cause }).toEqual({
      code: 'vault_refused',
      message: '"new" already refers to x',
      cause: duplicate,
    });
  });

  it('calls onAdded with the outcome it returns', async () => {
    const onAdded = vi.fn();
    const out = await addAccount('new', { onAdded }, ctx);
    expect(onAdded.mock.calls).toEqual([[out]]);
  });

  it('points a capture inside a folder profile at --fresh', async () => {
    engine.captureCurrentLogin.mockRejectedValueOnce(
      new SwitchEngineError('cannot capture inside a folder profile', 'capture_in_profile'),
    );
    await expectRefused(
      addAccount('new', {}, ctx),
      'capture_in_profile',
      'cannot capture inside a folder profile. Onboard a new account from a normal ' +
        '(non-folder-bound) shell, or use: cctl accounts add <label> --fresh.',
    );
  });

  it('refuses as no live login when the engine found none, keeping the cause', async () => {
    const cause = new RefreshError('no live credentials to capture; log in first', 'no_live_login');
    engine.captureCurrentLogin.mockRejectedValueOnce(cause);
    const err = await refusal(addAccount('new', {}, ctx));
    expect(err.code).toBe('no_live_login');
    expect(err.message).toBe(
      'no live login to capture. Run `claude` and log in first, then retry.',
    );
    expect(err.cause).toBe(cause);
  });

  it('lets any other failure escape as itself rather than call it a missing login', async () => {
    // A registry that cannot be parsed, a credential store that cannot be read: real faults, not
    // a person who forgot to log in.
    const boom = new Error('accounts.json is not valid JSON; fix the file or move it aside');
    engine.captureCurrentLogin.mockRejectedValueOnce(boom);
    await expect(addAccount('new', {}, ctx)).rejects.toBe(boom);
  });

  it('lets a vault fault escape as itself rather than call it a refusal', async () => {
    const malformed = new VaultError('the account registry at x is malformed');
    engine.captureCurrentLogin.mockRejectedValueOnce(malformed);
    await expect(addAccount('new', {}, ctx)).rejects.toBe(malformed);
  });

  it('refuses a login already stored, and an empty label, in the vault words', async () => {
    engine.captureCurrentLogin.mockRejectedValueOnce(
      new VaultError('this login is account id-1 ("Work"), which is already stored', {
        code: 'login_stored',
      }),
    );
    await expectRefused(
      addAccount('new', {}, ctx),
      'vault_refused',
      'this login is account id-1 ("Work"), which is already stored',
    );
    engine.captureCurrentLogin.mockRejectedValueOnce(
      new VaultError('a label cannot be empty', { code: 'label_empty' }),
    );
    await expectRefused(addAccount(' ', {}, ctx), 'vault_refused', 'a label cannot be empty');
  });
});

describe('addAccount (fresh, in a throwaway window)', () => {
  /** The throwaway dirs left under the data dir: none, after any flow. */
  async function leftoverCaptureDirs(): Promise<string[]> {
    const dir = join(pathsIo.dataRoot, 'claude-control');
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).filter((name) => name.startsWith('capture-'));
  }

  /** A window that records the dir it was given and checks it exists while the window is open. */
  function recordingWindow(result?: Error): { window: LoginWindow; dirs: string[] } {
    const dirs: string[] = [];
    return {
      dirs,
      window: (dir) => {
        dirs.push(dir);
        expect(existsSync(dir)).toBe(true);
        return Promise.resolve(result);
      },
    };
  }

  it('captures what the window logged into, without touching the live login', async () => {
    const { window, dirs } = recordingWindow();
    const out = await addAccount('second', { fresh: true, loginWindow: window }, ctx);
    expect(dirs).toHaveLength(1);
    const capture =
      process.platform === 'darwin' ? engine.captureFromKeychainDelta : engine.captureFromConfigDir;
    expect(capture.mock.calls[0]?.slice(0, 2)).toEqual(['second', dirs[0]]);
    expect(engine.captureCurrentLogin).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      fresh: true,
      account: { label: 'second' },
      message:
        'Added second (new-1). Your current login was not touched - `cctl switch second` to use it.',
    });
    expect(await leftoverCaptureDirs()).toEqual([]);
  });

  it('refuses when the window could not be opened, and still deletes the dir', async () => {
    const { window } = recordingWindow(new Error('spawn claude ENOENT'));
    await expectRefused(
      addAccount('second', { fresh: true, loginWindow: window }, ctx),
      'launch_failed',
      'could not launch `claude`: spawn claude ENOENT',
    );
    expect(engine.captureFromConfigDir).not.toHaveBeenCalled();
    expect(await leftoverCaptureDirs()).toEqual([]);
  });

  it('refuses when the window closed without a login, and still deletes the dir', async () => {
    const { window } = recordingWindow();
    const noLogin = new SwitchEngineError(
      'no login was completed in the window',
      'no_capture_login',
    );
    engine.captureFromConfigDir.mockRejectedValueOnce(noLogin);
    engine.captureFromKeychainDelta.mockRejectedValueOnce(noLogin);
    await expectRefused(
      addAccount('second', { fresh: true, loginWindow: window }, ctx),
      'no_capture_login',
      'no login was completed in the window',
    );
    expect(await leftoverCaptureDirs()).toEqual([]);
  });

  it("refuses a taken label or a stored login with the vault's words, as the plain add does", async () => {
    const { window } = recordingWindow();
    const taken = new VaultError('"second" already refers to account id-9', {
      code: 'label_taken',
    });
    engine.captureFromConfigDir.mockRejectedValueOnce(taken);
    engine.captureFromKeychainDelta.mockRejectedValueOnce(taken);
    const err = await refusal(addAccount('second', { fresh: true, loginWindow: window }, ctx));
    expect({ code: err.code, message: err.message, cause: err.cause }).toEqual({
      code: 'vault_refused',
      message: '"second" already refers to account id-9',
      cause: taken,
    });
    expect(await leftoverCaptureDirs()).toEqual([]);
  });

  it('lets a vault fault escape as itself, and still deletes the dir', async () => {
    const { window } = recordingWindow();
    const malformed = new VaultError('the account registry at x is malformed');
    engine.captureFromConfigDir.mockRejectedValueOnce(malformed);
    engine.captureFromKeychainDelta.mockRejectedValueOnce(malformed);
    await expect(addAccount('second', { fresh: true, loginWindow: window }, ctx)).rejects.toBe(
      malformed,
    );
    expect(await leftoverCaptureDirs()).toEqual([]);
  });

  it('lets any other capture failure escape as itself, and still deletes the dir', async () => {
    const { window } = recordingWindow();
    const boom = new Error('disk on fire');
    engine.captureFromConfigDir.mockRejectedValueOnce(boom);
    engine.captureFromKeychainDelta.mockRejectedValueOnce(boom);
    await expect(addAccount('second', { fresh: true, loginWindow: window }, ctx)).rejects.toBe(
      boom,
    );
    expect(await leftoverCaptureDirs()).toEqual([]);
  });

  it('reports the stored account through onAdded while the throwaway dir still exists', async () => {
    // Deleting the dir can take seconds on Windows (a `claude` that exited still holding a file
    // in it), so the person must hear about the stored account before that, not after.
    const { window, dirs } = recordingWindow();
    const seen: Array<{ message: string; dirExisted: boolean }> = [];
    const out = await addAccount(
      'second',
      {
        fresh: true,
        loginWindow: window,
        onAdded: (added) => seen.push({ message: added.message, dirExisted: existsSync(dirs[0]!) }),
      },
      ctx,
    );
    expect(seen).toEqual([{ message: out.message, dirExisted: true }]);
    expect(await leftoverCaptureDirs()).toEqual([]);
  });
});

describe('runAccountAction with a fresh add', () => {
  it('prints the added line once, before the throwaway dir is deleted', async () => {
    const dirs: string[] = [];
    const window: LoginWindow = (dir) => {
      dirs.push(dir);
      return Promise.resolve(undefined);
    };
    const writes: Array<{ text: string; dirExisted: boolean }> = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push({ text: String(chunk), dirExisted: existsSync(dirs[0]!) });
      return true;
    });
    try {
      await runAccountAction((announce) =>
        addAccount('second', { fresh: true, loginWindow: window, onAdded: announce }, ctx),
      );
    } finally {
      write.mockRestore();
    }
    expect(writes).toEqual([
      {
        text:
          'Added second (new-1). Your current login was not touched - ' +
          '`cctl switch second` to use it.\n',
        dirExisted: true,
      },
    ]);
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it('reports a vault refusal and a vault fault as the same error line the entry point prints', async () => {
    // Before the actions existed, every VaultError from a fresh capture escaped to the entry
    // point's reporter. A refusal now goes through fail() and a fault still escapes; both must
    // reach the person as the identical `error: <vault words>` line.
    const window: LoginWindow = () => Promise.resolve(undefined);
    const lines: string[] = [];
    for (const thrown of [
      new VaultError('"second" already refers to account id-9', { code: 'label_taken' }),
      new VaultError('"second" already refers to account id-9'),
    ]) {
      engine.captureFromConfigDir.mockRejectedValueOnce(thrown);
      engine.captureFromKeychainDelta.mockRejectedValueOnce(thrown);
      const err = await runAccountAction(() =>
        addAccount('second', { fresh: true, loginWindow: window }, ctx),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err instanceof CliFailure).toBe(thrown.code === 'label_taken');
      let line = '';
      reportFatal(err, { write: (text: string) => (line += text) });
      process.exitCode = undefined;
      lines.push(line);
    }
    expect(lines).toEqual([
      'error: "second" already refers to account id-9\n',
      'error: "second" already refers to account id-9\n',
    ]);
  });
});

describe('runAccountAction', () => {
  it('prints the message as one line', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await runAccountAction(() => Promise.resolve({ message: 'Removed Work.' }));
    } finally {
      write.mockRestore();
    }
    expect(out).toEqual(['Removed Work.\n']);
  });

  it('prints an announced message when it is announced, and not again at the end', async () => {
    const events: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      events.push(`printed ${String(chunk)}`);
      return true;
    });
    try {
      await runAccountAction((announce) => {
        announce({ message: 'Added X.' });
        events.push('cleanup');
        return Promise.resolve({ message: 'Added X.' });
      });
    } finally {
      write.mockRestore();
    }
    expect(events).toEqual(['printed Added X.\n', 'cleanup']);
  });

  it("turns a refusal into the CLI's failure with the same words", async () => {
    const run = runAccountAction(() =>
      Promise.reject(new AccountActionError('not_found', 'No account matches "x".')),
    );
    await expect(run).rejects.toBeInstanceOf(CliFailure);
    await expect(run).rejects.toThrow('No account matches "x".');
  });

  it('lets anything else escape as itself', async () => {
    const boom = new Error('disk on fire');
    await expect(runAccountAction(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe('contention is a refusal, not a fault', () => {
  const busy = () =>
    new LockTimeoutError('could not acquire credential lock at /v/.lock within 15000ms');

  it('refuses a switch, an exclude, a rename and a remove that waited out the lock', async () => {
    engine.activate.mockRejectedValueOnce(busy());
    engine.setAutoSwitchExcluded.mockRejectedValueOnce(busy());
    engine.renameAccount.mockRejectedValueOnce(busy());
    engine.removeAccount.mockRejectedValueOnce(busy());
    for (const run of [
      switchAccount('Work', {}, ctx),
      setExcluded('Work', true, ctx),
      renameAccount('Work', 'home', ctx),
      removeAccount('Work', ctx),
    ]) {
      const err = await refusal(run);
      expect(err.code).toBe('busy');
      expect(err.message).toBe(
        'could not acquire credential lock at /v/.lock within 15000ms - another cctl ' +
          'operation is holding it. Nothing was changed; try again in a moment.',
      );
    }
  });

  it('refuses a remove an unsettled switch blocks, in the engine words', async () => {
    engine.removeAccount.mockRejectedValueOnce(
      new UnsettledSwitchError('an earlier switch did not settle; run cctl switch to finish it'),
    );
    await expectRefused(
      removeAccount('Work', ctx),
      'switch_failed',
      'an earlier switch did not settle; run cctl switch to finish it',
    );
  });

  it('refuses an exclude or rename of an account removed in between', async () => {
    engine.setAutoSwitchExcluded.mockRejectedValueOnce(new UnknownAccountError('id-1'));
    expect((await refusal(setExcluded('Work', true, ctx))).code).toBe('unknown_account');
    engine.renameAccount.mockRejectedValueOnce(new UnknownAccountError('id-1'));
    expect((await refusal(renameAccount('Work', 'x', ctx))).code).toBe('unknown_account');
  });
});
