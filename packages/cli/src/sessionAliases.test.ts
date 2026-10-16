// Integration tests for `cctl session show` / `cctl session aliases`, end to end over real files:
// a temp Claude config dir holding transcripts in Claude Code's on-disk layout, a temp vault with a
// registry (one shared account, one reserved by a folder rule) and the daemon database
// beside it, seeded through the same Store methods the daemon writes with. Nothing here reads the
// developer's real ~/.claude, vault or daemon database.
//
// What only an end-to-end run can prove: the catalog, the per-session transcript read, the store's
// intervals and slot spans and the registry labels all meet in one answer — which accounts a
// session's turns were billed to — and the commands' edges (default ref, failures, exit code)
// behave as the operator sees them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, projectDirStem } from '@claude-control/daemon';
import {
  InsecurePassthroughProtector,
  Vault,
  sandboxPaths,
  type CredentialBundle,
  type Paths,
} from '@claude-control/switch-engine';
import { CliFailure, daemonDbPath } from './context.js';
import {
  runSessionAliases,
  runSessionShow,
  SESSION_ID_ENV,
  type SessionAliasDeps,
} from './sessionAliases.js';

const HOUR = 3_600_000;
/** Every account went live at T0; turns before it belong to nobody. */
const T0 = Date.parse('2026-09-01T00:00:00.000Z');

// Session ids in Claude Code's UUID shape.
const S_RESUMED = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_HAND = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_FORK = 'aaaaaaaa-0000-4000-8000-000000000003';
const S_AWAY = 'bbbbbbbb-0000-4000-8000-000000000001';
const S_DUP1 = 'cccccccc-0000-4000-8000-000000000001';
const S_DUP2 = 'cccccccc-0000-4000-8000-000000000002';

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: 999 },
  oauthAccount: { accountUuid: 'uuid-' + token, emailAddress: token + '@example.com' },
});

/** An assistant turn line carrying `message.id`, `message.usage` and a timestamp. `input` is the
 *  only non-zero token kind, so a session's token total is just the sum of its inputs. */
const turnLine = (id: string, tsMs: number, input: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      id,
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: input,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
const userLine = (cwd: string, tsMs: number): string =>
  JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'user', content: 'hi' },
  });
const customTitle = (title: string): string =>
  JSON.stringify({ type: 'custom-title', customTitle: title });
const aiTitle = (title: string): string => JSON.stringify({ type: 'ai-title', aiTitle: title });

let root: string;
let paths: Paths;
let here: string;
let away: string;
let dupA: string;
let dupB: string;
let mainId: string;
let clientId: string;
let groupSlot: string;

/** Write one session transcript where Claude Code would, and pin its mtime (= last activity). */
async function writeSession(
  folder: string,
  sessionId: string,
  lines: string[],
  lastActivityMs: number,
): Promise<void> {
  const dir = join(paths.claudeDir, 'projects', projectDirStem(folder));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  await utimes(file, lastActivityMs / 1000, lastActivityMs / 1000);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-session-aliases-'));
  // The engine the command builds resolves a few defaults from the environment; keep every one of
  // them inside the sandbox (and the bind-enforce read off the real config file entirely).
  vi.stubEnv('CCTL_BIND_ENFORCE', 'block');
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('CCTL_LOG_FILE', undefined);
  paths = sandboxPaths(root);
  here = join(root, 'repo');
  away = join(root, 'elsewhere');
  dupA = join(root, 'dup-a');
  dupB = join(root, 'dup-b');

  // Registry: `main` stays shared (global slot); `client` is reserved by a folder rule.
  const vault = new Vault(paths.vaultDir, new InsecurePassthroughProtector());
  const main = await vault.addAccount('main', bundle('a'));
  const client = await vault.addAccount('client', bundle('b'));
  const groupFolder = join(root, 'client-work');
  await mkdir(groupFolder, { recursive: true });
  const group = await vault.createRule({ include: [client.id], folders: [groupFolder] });
  mainId = main.id;
  clientId = client.id;
  groupSlot = `group:${group.id}`;

  // Daemon database: both accounts live in their slots from T0 on; two sessions have recorded
  // slot spans (neither is registered, so the spans are the only record of their slot).
  const store = new Store(daemonDbPath(paths));
  try {
    store.replaceActivationIntervals([
      { accountId: mainId, startedAtMs: T0, endedAtMs: null, origin: null, slot: 'global' },
      { accountId: clientId, startedAtMs: T0, endedAtMs: null, origin: null, slot: groupSlot },
    ]);
    // Resumed from the global profile into the group's at T0+2h.
    store.recordSessionSlot(S_RESUMED, groupSlot, T0 + 2 * HOUR);
    // Hand-started in the bound folder: in the group slot from its first event.
    store.recordSessionSlot(S_HAND, groupSlot, T0);
  } finally {
    store.close();
  }

  // Transcripts.
  const inherited = turnLine('msg_r2', T0 + HOUR, 20);
  await writeSession(
    here,
    S_RESUMED,
    [
      userLine(here, T0 - HOUR),
      turnLine('msg_r1', T0 - HOUR, 1), // before any account was tracked
      inherited, // global slot -> main
      turnLine('msg_r3', T0 + 3 * HOUR, 300), // after the span -> client
      customTitle('Auth Work'),
    ],
    T0 + 3 * HOUR,
  );
  await writeSession(
    here,
    S_HAND,
    [userLine(here, T0 + HOUR), turnLine('msg_h1', T0 + HOUR, 4000), aiTitle('Generated title')],
    T0 + 4 * HOUR,
  );
  // A fork of the resumed session: it carries the parent's turn (same message id) plus its own.
  await writeSession(
    here,
    S_FORK,
    [
      userLine(here, T0 + HOUR),
      inherited,
      turnLine('msg_f1', T0 + HOUR, 50000),
      customTitle('fork'),
    ],
    T0 + 5 * HOUR,
  );
  await writeSession(
    away,
    S_AWAY,
    [userLine(away, T0 + HOUR), turnLine('msg_a1', T0 + HOUR, 7), customTitle('away-only')],
    T0 + HOUR,
  );
  // Distinct last-activity instants throughout, so every "most recent first" order is strict.
  await writeSession(dupA, S_DUP1, [userLine(dupA, T0), customTitle('dup')], T0 + 1.5 * HOUR);
  await writeSession(dupB, S_DUP2, [userLine(dupB, T0), customTitle('dup')], T0 + 2 * HOUR);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** The command's edges over the sandbox, capturing what it writes and notes. */
function harness(over: Partial<SessionAliasDeps> = {}) {
  const written: string[] = [];
  const notes: string[] = [];
  const deps: SessionAliasDeps = {
    paths,
    env: {},
    cwd: here,
    platform: process.platform,
    write: (text) => written.push(text),
    note: (text) => notes.push(text),
    ...over,
  };
  return {
    deps,
    notes,
    text: () => written.join(''),
    json: () => JSON.parse(written.join('')) as JsonOut,
  };
}

interface JsonAccount {
  accountId: string | null;
  label: string;
  turns: number;
  tokens: number;
}
interface JsonSession {
  sessionId: string;
  alias: string | null;
  aliasSource: string | null;
  folder: string | null;
  accounts: JsonAccount[];
}
interface JsonOut {
  matchedBy?: string;
  inScope?: boolean;
  currentSessionId?: string;
  folder?: string | null;
  ambiguous?: boolean;
  alias?: string;
  folders?: { folder: string; sessionIds: string[] }[];
  sessions: JsonSession[];
}

/** A real folder, a junction to it, and a session named `title` recorded under one of the two
 *  spellings. Claude Code records the folder as it was spelled at launch: the real path for a
 *  session started there, the link for one started through it. */
async function linkedSession(
  recordedUnder: 'target' | 'link',
  title = 'linked',
): Promise<{ target: string; link: string; id: string }> {
  const id = 'dddddddd-0000-4000-8000-000000000001';
  await mkdir(join(root, 'target'), { recursive: true });
  const target = realpathSync.native(join(root, 'target'));
  const link = join(root, 'link');
  symlinkSync(target, link, 'junction');
  const recorded = recordedUnder === 'target' ? target : link;
  await writeSession(recorded, id, [userLine(recorded, T0), customTitle(title)], T0 + HOUR);
  return { target, link, id };
}

/** A session's per-account use as [label, turns, tokens] triples, in first-use order. */
const uses = (s: JsonSession | undefined) => s?.accounts.map((a) => [a.label, a.turns, a.tokens]);

describe('runSessionShow', () => {
  it('bills a session resumed into a group: unattributed, then global, then the group member', async () => {
    const h = harness();
    await runSessionShow('auth work', { json: true }, h.deps);
    const out = h.json();
    expect(out.matchedBy).toBe('alias');
    expect(out.inScope).toBe(true);
    expect(out.sessions.map((s) => s.sessionId)).toEqual([S_RESUMED]);
    const s = out.sessions[0];
    expect(s?.alias).toBe('Auth Work');
    expect(s?.aliasSource).toBe('custom');
    // `client` is a reserved group member: its label must still resolve, not fall back to its id.
    expect(uses(s)).toEqual([
      ['unattributed', 1, 1],
      ['main', 1, 20],
      ['client', 1, 300],
    ]);
    expect(s?.accounts.map((a) => a.accountId)).toEqual([null, mainId, clientId]);
    // An in-folder alias match never widens the search.
    expect(h.notes).toEqual([]);
  });

  it('leaves a fork its own turns only, once the daemon saw its parent run the copied one', async () => {
    // Forked from S_RESUMED after its group-slot turn: Claude Code copies that turn (same message
    // id, same timestamp) into the fork's file, and the daemon first saw the fork after it was made.
    const forkId = 'aaaaaaaa-0000-4000-8000-000000000004';
    const store = new Store(daemonDbPath(paths));
    try {
      store.recordSessionSlot(forkId, groupSlot, T0 + 3.5 * HOUR);
    } finally {
      store.close();
    }
    await writeSession(
      here,
      forkId,
      [
        userLine(here, T0 - HOUR),
        turnLine('msg_r3', T0 + 3 * HOUR, 300),
        turnLine('msg_f2', T0 + 4 * HOUR, 9),
        customTitle('Auth Work'),
      ],
      T0 + 6 * HOUR,
    );
    const h = harness();
    await runSessionShow('auth work', { json: true }, h.deps);
    const out = h.json();
    expect(out.sessions.map((s) => s.sessionId).sort()).toEqual([S_RESUMED, forkId].sort());
    // The copy is the parent's spend: neither billed again nor to the global account.
    expect(uses(out.sessions.find((s) => s.sessionId === forkId))).toEqual([['client', 1, 9]]);
    expect(uses(out.sessions.find((s) => s.sessionId === S_RESUMED))).toEqual([
      ['unattributed', 1, 1],
      ['main', 1, 20],
      ['client', 1, 300],
    ]);
    // Shown on its own (by id, or as the current session) the parent is not listed, but its file
    // is still what says who made the copy.
    const byId = harness();
    await runSessionShow(forkId, { json: true }, byId.deps);
    expect(uses(byId.json().sessions[0])).toEqual([['client', 1, 9]]);
    const current = harness({ env: { [SESSION_ID_ENV]: forkId } });
    await runSessionShow(undefined, { json: true }, current.deps);
    expect(uses(current.json().sessions[0])).toEqual([['client', 1, 9]]);
  });

  it('defaults to the current session from CLAUDE_CODE_SESSION_ID, billed from its span alone', async () => {
    const h = harness({ env: { [SESSION_ID_ENV]: S_HAND } });
    await runSessionShow(undefined, { json: true }, h.deps);
    const out = h.json();
    expect(out.matchedBy).toBe('id');
    expect(out.currentSessionId).toBe(S_HAND);
    expect(out.sessions.map((s) => s.sessionId)).toEqual([S_HAND]);
    // Never registered, so only the recorded span says it ran in the group slot: every turn goes
    // to the group's member, none to the global account live at the same instant.
    expect(uses(out.sessions[0])).toEqual([['client', 1, 4000]]);
    expect(out.sessions[0]?.aliasSource).toBe('auto');
  });

  it('lets an explicit ref override the current session', async () => {
    const h = harness({ env: { [SESSION_ID_ENV]: S_HAND } });
    await runSessionShow('fork', { json: true }, h.deps);
    expect(h.json().sessions.map((s) => s.sessionId)).toEqual([S_FORK]);
  });

  it('fails with a clear message outside a session when no ref is given', async () => {
    const h = harness();
    await expect(runSessionShow(undefined, {}, h.deps)).rejects.toBeInstanceOf(CliFailure);
    await expect(runSessionShow(undefined, {}, h.deps)).rejects.toThrow(
      /no session given.*CLAUDE_CODE_SESSION_ID is unset.*cctl session show <id\|alias>/,
    );
    // A blank variable is as good as none.
    const blank = harness({ env: { [SESSION_ID_ENV]: '   ' } });
    await expect(runSessionShow(undefined, {}, blank.deps)).rejects.toBeInstanceOf(CliFailure);
  });

  it('fails with a clear message when nothing matches, after searching every folder', async () => {
    const h = harness();
    await expect(runSessionShow('no-such-alias', {}, h.deps)).rejects.toThrow(
      /no session with id or alias "no-such-alias"/,
    );
    expect(h.notes.join('\n')).toContain('Searching every project');
  });

  it('finds an id from any folder, case-insensitively', async () => {
    const h = harness();
    await runSessionShow(S_AWAY.toUpperCase(), { json: true }, h.deps);
    const out = h.json();
    expect(out.matchedBy).toBe('id');
    expect(out.sessions.map((s) => s.sessionId)).toEqual([S_AWAY]);
    expect(uses(out.sessions[0])).toEqual([['main', 1, 7]]);
  });

  it('lets an id win over a session in this folder whose alias is that same id', async () => {
    // A session here renamed to another folder's session id must not shadow the real id.
    const decoy = 'dddddddd-0000-4000-8000-000000000001';
    await writeSession(here, decoy, [userLine(here, T0), customTitle(S_AWAY)], T0 + 6 * HOUR);
    const h = harness();
    await runSessionShow(S_AWAY, { json: true }, h.deps);
    const out = h.json();
    expect(out.matchedBy).toBe('id');
    expect(out.sessions.map((s) => s.sessionId)).toEqual([S_AWAY]);
  });

  it('falls back to the one other folder that uses the alias, and says so', async () => {
    const h = harness();
    await runSessionShow('away-only', { json: true }, h.deps);
    const out = h.json();
    expect(out.matchedBy).toBe('alias');
    expect(out.inScope).toBe(false);
    expect(out.sessions.map((s) => [s.sessionId, s.folder])).toEqual([[S_AWAY, away]]);
    expect(h.notes.join('\n')).toContain('Searching every project');

    const text = harness();
    await runSessionShow('away-only', {}, text.deps);
    expect(text.text()).toContain(
      `No session with that alias in ${here}; showing the one in ${away}.`,
    );
  });

  it('resolves an alias in the --cwd folder instead of the process cwd', async () => {
    const h = harness();
    await runSessionShow('away-only', { cwd: away, json: true }, h.deps);
    expect(h.json()).toMatchObject({ matchedBy: 'alias', inScope: true });
  });

  it('takes a relative --cwd against the current directory', async () => {
    const h = harness({ cwd: root });
    await runSessionShow('away-only', { cwd: 'elsewhere', json: true }, h.deps);
    expect(h.json()).toMatchObject({ matchedBy: 'alias', inScope: true });
    expect(h.notes.join('\n')).not.toContain('Searching every project');
  });

  it('follows a --cwd junction to the folder it points at', async () => {
    const { link, id } = await linkedSession('target');
    const h = harness();
    await runSessionShow('linked', { cwd: link, json: true }, h.deps);
    const out = h.json();
    expect(out).toMatchObject({ matchedBy: 'alias', inScope: true });
    expect(out.sessions.map((x) => x.sessionId)).toEqual([id]);
  });

  describe('a session recorded under a junction', () => {
    it('is in scope when run from the junction', async () => {
      const { link, id } = await linkedSession('link', 'plinked');
      const h = harness({ cwd: link });
      await runSessionShow('plinked', { json: true }, h.deps);
      const out = h.json();
      expect(out).toMatchObject({ matchedBy: 'alias', inScope: true });
      expect(out.sessions.map((x) => x.sessionId)).toEqual([id]);
      expect(h.notes.join('\n')).not.toContain('Searching every project');
    });

    it('is in scope from the folder the junction points at', async () => {
      const { target, id } = await linkedSession('link', 'plinked');
      const h = harness({ cwd: target });
      await runSessionShow('plinked', { json: true }, h.deps);
      const out = h.json();
      expect(out).toMatchObject({ matchedBy: 'alias', inScope: true });
      expect(out.sessions.map((x) => x.sessionId)).toEqual([id]);
    });
  });

  describe('an alias used in several other folders', () => {
    let previousExitCode: typeof process.exitCode;
    beforeEach(() => {
      previousExitCode = process.exitCode;
    });
    afterEach(() => {
      process.exitCode = previousExitCode;
    });

    it('lists the candidates as JSON and exits non-zero rather than guessing', async () => {
      const h = harness();
      await runSessionShow('dup', { json: true }, h.deps);
      expect(process.exitCode).toBe(1);
      expect(h.json()).toEqual({
        ambiguous: true,
        alias: 'dup',
        // Most recently active folder first.
        folders: [
          { folder: dupB, sessionIds: [S_DUP2] },
          { folder: dupA, sessionIds: [S_DUP1] },
        ],
      });
    });

    it('explains how to pick in text mode, also exiting non-zero', async () => {
      const h = harness();
      await runSessionShow('dup', {}, h.deps);
      expect(process.exitCode).toBe(1);
      expect(h.text()).toContain(
        '"dup" is not a session in this folder, and 2 other folders use it:',
      );
      expect(h.text()).toContain('pass --cwd <folder>');
    });
  });

  it('renders the details as text, marking the current session', async () => {
    const h = harness({ env: { [SESSION_ID_ENV]: S_RESUMED } });
    await runSessionShow(undefined, {}, h.deps);
    const out = h.text();
    expect(out).toContain('Auth Work');
    expect(out).toContain('<- this session');
    expect(out).toContain(`Session   ${S_RESUMED}`);
    expect(out).toContain('unattributed');
    expect(out).toContain('client');
  });

  it('reports every turn as unattributed when the daemon never recorded a switch', async () => {
    // A machine where the daemon has never run: no intervals, no spans, an empty database.
    const fresh = await mkdtemp(join(tmpdir(), 'cctl-session-aliases-fresh-'));
    try {
      const freshPaths = sandboxPaths(fresh);
      const dir = join(freshPaths.claudeDir, 'projects', projectDirStem(here));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${S_RESUMED}.jsonl`),
        [userLine(here, T0), turnLine('m1', T0 + HOUR, 5), customTitle('solo')].join('\n'),
        'utf8',
      );
      const h = harness({ paths: freshPaths });
      await runSessionShow('solo', { json: true }, h.deps);
      expect(uses(h.json().sessions[0])).toEqual([['unattributed', 1, 5]]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe('runSessionAliases', () => {
  it('lists only hand-named sessions in the folder by default, most recent first', async () => {
    const h = harness();
    await runSessionAliases({ json: true }, h.deps);
    const out = h.json();
    expect(out.folder).toBe(here);
    // S_HAND has only a generated title, so it is left out.
    expect(out.sessions.map((s) => s.sessionId)).toEqual([S_FORK, S_RESUMED]);
    // Both the parent and its fork are read in ONE scan here, so this is where per-session de-dup
    // shows: each keeps its own copy of the shared turn instead of whichever file was read second
    // losing it.
    expect(uses(out.sessions.find((s) => s.sessionId === S_RESUMED))).toEqual([
      ['unattributed', 1, 1],
      ['main', 1, 20],
      ['client', 1, 300],
    ]);
    expect(uses(out.sessions.find((s) => s.sessionId === S_FORK))).toEqual([['main', 2, 50020]]);
  });

  it('leaves a named fork of an unlisted session its own turns only', async () => {
    // Forked from S_HAND (a generated title only, so not listed) after its group-slot turn.
    const forkId = 'aaaaaaaa-0000-4000-8000-000000000005';
    const store = new Store(daemonDbPath(paths));
    try {
      store.recordSessionSlot(forkId, groupSlot, T0 + 2 * HOUR);
    } finally {
      store.close();
    }
    await writeSession(
      here,
      forkId,
      [
        userLine(here, T0 + HOUR),
        turnLine('msg_h1', T0 + HOUR, 4000),
        turnLine('msg_f9', T0 + 3 * HOUR, 9),
        customTitle('mine'),
      ],
      T0 + 6 * HOUR,
    );
    const h = harness();
    await runSessionAliases({ json: true }, h.deps);
    const out = h.json();
    expect(out.sessions.map((s) => s.sessionId)).not.toContain(S_HAND);
    expect(uses(out.sessions.find((s) => s.sessionId === forkId))).toEqual([['client', 1, 9]]);
  });

  it('includes generated titles with auto', async () => {
    const h = harness();
    await runSessionAliases({ auto: true, json: true }, h.deps);
    expect(h.json().sessions.map((s) => s.sessionId)).toEqual([S_FORK, S_HAND, S_RESUMED]);
  });

  it('lists every folder with all, saying it is reading them', async () => {
    const h = harness();
    await runSessionAliases({ all: true, json: true }, h.deps);
    const out = h.json();
    expect(out.folder).toBeNull();
    expect(out.sessions.map((s) => s.sessionId)).toEqual([
      S_FORK,
      S_RESUMED,
      S_DUP2,
      S_DUP1,
      S_AWAY,
    ]);
    expect(h.notes.join('\n')).toContain('Reading every project');
  });

  it('lists the --cwd folder instead of the process cwd', async () => {
    const h = harness();
    await runSessionAliases({ cwd: away, json: true }, h.deps);
    expect(h.json().sessions.map((s) => s.sessionId)).toEqual([S_AWAY]);
  });

  it('lists a relative --cwd taken against the current directory', async () => {
    const h = harness({ cwd: root });
    await runSessionAliases({ cwd: 'elsewhere', json: true }, h.deps);
    expect(h.json().sessions.map((s) => s.sessionId)).toEqual([S_AWAY]);
  });

  it('lists the folder a --cwd junction points at', async () => {
    const { link, id } = await linkedSession('target');
    const h = harness();
    await runSessionAliases({ cwd: link, json: true }, h.deps);
    expect(h.json().sessions.map((s) => s.sessionId)).toEqual([id]);
  });

  describe('a session recorded under a junction', () => {
    it('is listed for a --cwd naming the junction', async () => {
      const { link, id } = await linkedSession('link', 'plinked');
      const h = harness();
      await runSessionAliases({ cwd: link, json: true }, h.deps);
      expect(h.json().sessions.map((s) => s.sessionId)).toEqual([id]);
    });

    it('is listed when run from the junction', async () => {
      const { link, id } = await linkedSession('link', 'plinked');
      const h = harness({ cwd: link });
      await runSessionAliases({ json: true }, h.deps);
      expect(h.json().sessions.map((s) => s.sessionId)).toEqual([id]);
    });

    it('is listed only where its project directory is, as claude --resume scopes it, while show still finds it', async () => {
      const { target, id } = await linkedSession('link', 'plinked');
      // From the folder the junction points at, the listing reads only the project directories
      // named after that folder; the junction's directory is not one of them.
      const fromTarget = harness({ cwd: target });
      await runSessionAliases({ json: true }, fromTarget.deps);
      expect(fromTarget.json().sessions).toEqual([]);
      const withCwd = harness();
      await runSessionAliases({ cwd: target, json: true }, withCwd.deps);
      expect(withCwd.json().sessions).toEqual([]);
      // `session show` widens to every project on a miss, and then counts the session as here.
      const show = harness({ cwd: target });
      await runSessionShow('plinked', { json: true }, show.deps);
      const out = show.json();
      expect(out).toMatchObject({ matchedBy: 'alias', inScope: true });
      expect(out.sessions.map((x) => x.sessionId)).toEqual([id]);
    });
  });

  it('renders a table in text mode, and a hint for a folder with no named sessions', async () => {
    const h = harness({ env: { [SESSION_ID_ENV]: S_FORK } });
    await runSessionAliases({}, h.deps);
    const out = h.text();
    expect(out).toMatch(/ALIAS\s+LAST ACTIVE\s+ACCOUNTS\s+SESSION/);
    expect(out).toContain('Auth Work');
    expect(out).toContain('fork *');

    const empty = harness({ cwd: join(root, 'nothing-here') });
    await runSessionAliases({}, empty.deps);
    expect(empty.text()).toContain('No named sessions in');
  });
});
