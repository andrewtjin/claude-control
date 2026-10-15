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

  it('drops members that do not travel, and rules left with none', () => {
    const p = buildExportPayload({
      accounts: [work],
      bundles: new Map(),
      rules: [
        rule('r1', { folders: ['/a'], include: ['id-work', 'id-spare'] }),
        rule('r2', { folders: ['/b'], include: [spare.id] }),
      ],
      config: undefined,
      nowMs: 1,
      cctlVersion: 'x',
      platform: 'linux',
    });
    expect(p.rules.map((r) => r.folders)).toEqual([['/a']]);
    expect(p.rules[0]!.include).toEqual(['u-work']);
  });

  it('drops settings that name a path, and names this build does not persist', () => {
    const p = buildExportPayload({
      accounts: [],
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

  it('refuses a nested identity block', () => {
    const p = payload();
    (p.accounts[0]!.bundle!.oauthAccount as Record<string, unknown>)['deep'] = { a: 1 };
    expect(refusal(p)).toContain('not a plain value');
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
