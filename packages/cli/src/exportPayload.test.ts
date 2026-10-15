// What an export carries, and how an opened payload is checked before anything acts on it.

import { describe, it, expect } from 'vitest';
import type { AccountView, CredentialBundle, FolderRule } from '@claude-control/switch-engine';
import { ExportFileError } from './exportEnvelope.js';
import {
  PAYLOAD_LIMITS,
  buildExportPayload,
  parseExportPayload,
  type ExportPayload,
} from './exportPayload.js';

function account(id: string, label: string, extra: Partial<AccountView> = {}): AccountView {
  return { id, label, quarantined: false, createdAtMs: 1, updatedAtMs: 1, ...extra };
}

function bundle(access: string, uuid?: string): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt: 5 },
    ...(uuid !== undefined ? { oauthAccount: { accountUuid: uuid } } : {}),
  };
}

function rule(id: string, extra: Partial<FolderRule>): FolderRule {
  return {
    id,
    label: 'r',
    folders: [],
    include: [],
    exclude: [],
    activeId: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...extra,
  };
}

const work = account('id-work', 'work', { accountUuid: 'u-work', emailAddress: 'w@x.com' });
const home = account('id-home', 'home', { autoSwitchExcluded: true });
const spare = account('id-spare', 'spare', { accountUuid: 'u-spare' });

/** A payload as the builder makes it, for the parser tests. */
function payload(): ExportPayload {
  return buildExportPayload({
    accounts: [work, home],
    bundles: new Map([['id-work', bundle('W', 'u-work')]]),
    rules: [rule('r1', { folders: ['/p'], include: ['id-work'], exclude: ['id-home'] })],
    allAccounts: [work, home],
    config: { relayUrl: 'wss://relay.example', env: { CCTL_AUTOSWITCH: 'off' } },
    nowMs: 42,
    cctlVersion: '1.1.0',
    platform: 'linux',
  });
}

/** The code `parseExportPayload` refuses `value` with. */
function refusal(value: unknown): string {
  try {
    parseExportPayload(JSON.stringify(value));
  } catch (err) {
    expect(err).toBeInstanceOf(ExportFileError);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('buildExportPayload', () => {
  it('carries each account with its identity, exclusion and (only when given) tokens', () => {
    const p = payload();
    expect(p.accounts).toEqual([
      {
        label: 'work',
        accountUuid: 'u-work',
        emailAddress: 'w@x.com',
        autoSwitchExcluded: false,
        bundle: bundle('W', 'u-work'),
      },
      { label: 'home', autoSwitchExcluded: true },
    ]);
    expect(p).toMatchObject({ exportedAtMs: 42, cctlVersion: '1.1.0', platform: 'linux' });
  });

  it('names rule members by login, else by label', () => {
    expect(payload().rules).toEqual([
      { label: 'r', folders: ['/p'], aliases: [], include: ['u-work'], exclude: ['home'] },
    ]);
  });

  it('keeps alias scopes', () => {
    const p = buildExportPayload({
      accounts: [work],
      allAccounts: [work],
      bundles: new Map(),
      rules: [rule('r1', { aliases: [{ folder: '/p', alias: 'Big Job' }], include: ['id-work'] })],
      config: undefined,
      nowMs: 1,
      cctlVersion: 'x',
      platform: 'win32',
    });
    expect(p.rules[0]).toMatchObject({
      folders: [],
      aliases: [{ folder: '/p', alias: 'Big Job' }],
    });
  });

  it('carries the rules a selected account is in, naming every member, selected or not', () => {
    const p = buildExportPayload({
      accounts: [work],
      allAccounts: [work, spare, home],
      bundles: new Map(),
      rules: [
        rule('r1', { folders: ['/a'], include: ['id-work', 'id-spare'], exclude: ['id-home'] }),
        rule('r2', { folders: ['/b'], include: [spare.id] }),
      ],
      config: undefined,
      nowMs: 1,
      cctlVersion: 'x',
      platform: 'linux',
    });
    expect(p.rules.map((r) => r.folders)).toEqual([['/a']]);
    expect(p.rules[0]).toMatchObject({ include: ['u-work', 'u-spare'], exclude: ['home'] });
  });

  it('leaves the relay behind: it is paired to this machine', () => {
    expect(payload().settings).toEqual({ env: { CCTL_AUTOSWITCH: 'off' } });
  });

  it("carries an account's organization", () => {
    const p = buildExportPayload({
      accounts: [account('id-o', 'o', { accountUuid: 'u-o', organizationUuid: 'org-1' })],
      allAccounts: [],
      bundles: new Map(),
      rules: [],
      config: undefined,
      nowMs: 1,
      cctlVersion: 'x',
      platform: 'linux',
    });
    expect(p.accounts[0]).toMatchObject({ organizationUuid: 'org-1' });
  });

  it('drops settings that name a path, and names this build does not persist', () => {
    const p = buildExportPayload({
      accounts: [],
      allAccounts: [],
      bundles: new Map(),
      rules: [],
      config: { env: { CCTL_LOG_FILE: 'C:/logs/d.log', CCTL_LOG_LEVEL: 'info', CCTL_NOPE: '1' } },
      nowMs: 1,
      cctlVersion: 'x',
      platform: 'linux',
    });
    expect(p.settings).toEqual({ env: { CCTL_LOG_LEVEL: 'info' } });
  });
});

describe('parseExportPayload', () => {
  it('round-trips what the builder makes', () => {
    const p = payload();
    expect(parseExportPayload(JSON.stringify(p))).toEqual(p);
  });

  it('keeps only the token fields it knows', () => {
    const p = payload() as unknown as { accounts: { bundle?: { claudeAiOauth: object } }[] };
    p.accounts[0]!.bundle!.claudeAiOauth = {
      ...p.accounts[0]!.bundle!.claudeAiOauth,
      injected: 'x',
    };
    const parsed = parseExportPayload(JSON.stringify(p));
    expect(parsed.accounts[0]!.bundle!.claudeAiOauth).not.toHaveProperty('injected');
  });

  it('refuses an account whose tokens belong to another login', () => {
    const p = payload();
    p.accounts[0]!.bundle = bundle('W', 'u-someone-else');
    expect(refusal(p)).toContain('carries the tokens of another');
  });

  it('refuses the same login listed twice', () => {
    const p = payload();
    p.accounts.push({ ...p.accounts[0]!, label: 'again' });
    expect(refusal(p)).toContain('listed twice');
  });

  it('refuses wrong types, missing fields and prototype keys', () => {
    const base = payload();
    const cases: unknown[] = [
      null,
      [],
      { ...base, accounts: 'none' },
      { ...base, accounts: [{ label: '', autoSwitchExcluded: false }] },
      { ...base, accounts: [{ label: 'x', autoSwitchExcluded: 'yes' }] },
      {
        ...base,
        accounts: [{ label: 'x', autoSwitchExcluded: false, bundle: { claudeAiOauth: {} } }],
      },
      { ...base, rules: [{ label: 'r', folders: ['/a'], aliases: [], include: [1], exclude: [] }] },
      { ...base, rules: [{ label: 'r', folders: '/a', aliases: [], include: [], exclude: [] }] },
      { ...base, settings: { env: { CCTL_AUTOSWITCH: 1 } } },
      { ...base, exportedAtMs: 'yesterday' },
      JSON.parse('{"__proto__": {"polluted": true}}'),
    ];
    for (const value of cases) refusal(value);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps a nested identity block, as Claude Code writes one', () => {
    const p = payload();
    const identity = p.accounts[0]!.bundle!.oauthAccount as Record<string, unknown>;
    identity['ccOnboardingFlags'] = { seen: true, steps: ['a', 1, null] };
    identity['seatTier'] = null;
    expect(parseExportPayload(JSON.stringify(p)).accounts[0]!.bundle!.oauthAccount).toEqual(
      identity,
    );
  });

  it('refuses an identity block nested past its bound, or reaching a prototype', () => {
    const p = payload();
    let deep: Record<string, unknown> = {};
    const identity = p.accounts[0]!.bundle!.oauthAccount as Record<string, unknown>;
    identity['deep'] = deep;
    for (let i = 0; i < 20; i += 1) {
      const next: Record<string, unknown> = {};
      deep['d'] = next;
      deep = next;
    }
    expect(refusal(p)).toContain('nested too deeply');
    const q = JSON.parse(JSON.stringify(payload())) as {
      accounts: { bundle: { oauthAccount: object } }[];
    };
    q.accounts[0]!.bundle.oauthAccount = JSON.parse('{"flags": {"__proto__": {"x": 1}}}') as object;
    expect(refusal(q)).toContain('__proto__');
  });

  it('refuses lists and strings past their bounds', () => {
    const p = payload();
    const many = Array.from({ length: PAYLOAD_LIMITS.accounts + 1 }, (_, i) => ({
      label: `a${i}`,
      autoSwitchExcluded: false,
    }));
    expect(refusal({ ...p, accounts: many })).toContain('more than');
    expect(
      refusal({
        ...p,
        accounts: [{ label: 'x'.repeat(PAYLOAD_LIMITS.text + 1), autoSwitchExcluded: false }],
      }),
    ).toContain('longer than');
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseExportPayload('{')).toThrow(ExportFileError);
  });
});

describe('parseExportPayload: what a crafted file cannot carry', () => {
  const ESC = String.fromCharCode(27);

  it('refuses terminal controls in an email or a login, in the entry or its tokens', () => {
    const a = payload();
    a.accounts[0]!.emailAddress = `x${ESC}]52;c;AAAA@x.com`;
    expect(refusal(a)).toContain('control or bidirectional');
    const b = payload();
    b.accounts[0]!.bundle!.oauthAccount!.emailAddress = 'x‮@x.com';
    expect(refusal(b)).toContain('control or bidirectional');
    const c = payload();
    c.accounts[1]!.accountUuid = `u${ESC}[2J`;
    expect(refusal(c)).toContain('control or bidirectional');
  });

  it('refuses an export date no date can hold', () => {
    expect(refusal({ ...payload(), exportedAtMs: 1e300 })).toContain('exportedAtMs');
    expect(refusal({ ...payload(), exportedAtMs: -1e20 })).toContain('exportedAtMs');
  });

  it('refuses one login listed twice when an entry names it only in its tokens', () => {
    const p = payload();
    p.accounts.push({ label: 'again', autoSwitchExcluded: false, bundle: bundle('X', 'u-work') });
    expect(refusal(p)).toContain('listed twice');
  });

  it('refuses an entry whose email and tokens name different people when no login is named', () => {
    const p = payload();
    p.accounts[1]!.emailAddress = 'h@x.com';
    p.accounts[1]!.bundle = {
      claudeAiOauth: { accessToken: 'H', refreshToken: 'r-H', expiresAt: 5 },
      oauthAccount: { emailAddress: 'someone@x.com' },
    };
    expect(refusal(p)).toContain('carries the tokens of another');
  });

  it('refuses a rule that includes and excludes one account', () => {
    const p = payload();
    p.rules[0]!.exclude.push('u-work');
    expect(refusal(p)).toContain('both includes and excludes');
  });

  it('drops a rule member listed twice', () => {
    const p = payload();
    p.rules[0]!.include.push('u-work');
    expect(parseExportPayload(JSON.stringify(p)).rules[0]!.include).toEqual(['u-work']);
  });

  it('refuses a platform no build runs on', () => {
    expect(refusal({ ...payload(), platform: `linux${ESC}]0;x` })).toContain('platform');
  });

  it('refuses two spellings of one setting', () => {
    const p = payload();
    p.settings.env = { autoswitch: '0', CCTL_AUTOSWITCH: '1' };
    expect(refusal(p)).toContain('CCTL_AUTOSWITCH twice');
  });

  it('takes no more rules than one machine can hold', () => {
    const p = payload();
    p.rules = Array.from({ length: 65 }, (_, i) => ({ ...p.rules[0]!, folders: [`/r${i}`] }));
    expect(refusal(p)).toContain('more than 64');
  });
});
