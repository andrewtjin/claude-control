// What an export file carries once it is opened: accounts (with or without their credentials),
// the folder and session rules over them, and the persisted daemon settings.
//
// Two halves. `buildExportPayload` assembles it from what the engine and the config file hold on
// this machine, and is the one place that decides what does NOT travel. `parseExportPayload`
// checks an opened payload field by field before anything acts on it: the file authenticated
// under the passphrase, but whoever knew the passphrase wrote it, so its contents are input like
// any other, bounded and shape-checked here so the import planner can trust the types.
//
// Never carried: the relay pairing identity, the hook secret, the vault key, switch-recovery
// files, token fingerprints, the guard snapshot, profiles, the daemon's database (sessions,
// outbox, cards) and usage history. Settings that name a path are dropped too: a path on this
// machine means nothing on another.

import {
  MAX_RULE_ACCOUNTS,
  MAX_RULE_ALIASES,
  MAX_RULE_FOLDERS,
  type AccountView,
  type ClaudeOauth,
  type CredentialBundle,
  type FolderRule,
  type OauthAccount,
} from '@claude-control/switch-engine';
import { ExportFileError } from './exportEnvelope.js';
import { findDaemonEnvSetting, type DaemonFileConfig } from './settings.js';

/** One account as it travels. Members of rules point at it by `accountUuid ?? label`. */
export interface ExportedAccount {
  label: string;
  accountUuid?: string;
  emailAddress?: string;
  autoSwitchExcluded: boolean;
  /** Absent when the export was made with `--no-tokens`, or when the account was quarantined
   *  (its login is dead, so its tokens are worth nothing): the import then stores it as an account
   *  waiting for a login. */
  bundle?: CredentialBundle;
}

/** One session-alias scope of a rule: sessions titled `alias` recorded in exactly `folder`. */
export interface ExportedAliasScope {
  folder: string;
  alias: string;
}

/** One rule as it travels: its scopes and its members, each member as `accountUuid ?? label` of an
 *  exported account. */
export interface ExportedRule {
  label: string;
  folders: string[];
  aliases: ExportedAliasScope[];
  include: string[];
  exclude: string[];
}

/** The persisted daemon settings: the relay and the `env` block of config.json. */
export interface ExportedSettings {
  relayUrl?: string;
  env: Record<string, string>;
}

/** The payload, version 1 of the export format. */
export interface ExportPayload {
  exportedAtMs: number;
  cctlVersion: string;
  platform: NodeJS.Platform;
  accounts: ExportedAccount[];
  rules: ExportedRule[];
  settings: ExportedSettings;
}

/** What {@link buildExportPayload} reads. `bundles` holds the credentials of the accounts whose
 *  tokens travel; an account missing from it travels without them. */
export interface ExportSource {
  accounts: readonly AccountView[];
  bundles: ReadonlyMap<string, CredentialBundle>;
  rules: readonly FolderRule[];
  config: DaemonFileConfig | undefined;
  nowMs: number;
  cctlVersion: string;
  platform: NodeJS.Platform;
}

/** How a rule member is named in the file: its login when known (stable across machines), else
 *  its label. */
export function memberRef(account: Pick<AccountView, 'accountUuid' | 'label'>): string {
  return account.accountUuid ?? account.label;
}

/**
 * Assemble the payload for `source.accounts` (already the selection to export). A rule keeps only
 * the members that travel; a rule left with no member, or with no scope, is left out, since it
 * would be refused on the other side anyway. Settings that name a path, and names this build does
 * not know, are dropped.
 */
export function buildExportPayload(source: ExportSource): ExportPayload {
  const refById = new Map(source.accounts.map((a) => [a.id, memberRef(a)]));
  const accounts: ExportedAccount[] = source.accounts.map((a) => {
    const bundle = source.bundles.get(a.id);
    return {
      label: a.label,
      ...(a.accountUuid !== undefined ? { accountUuid: a.accountUuid } : {}),
      ...(a.emailAddress !== undefined ? { emailAddress: a.emailAddress } : {}),
      autoSwitchExcluded: a.autoSwitchExcluded === true,
      ...(bundle !== undefined ? { bundle } : {}),
    };
  });
  const rules: ExportedRule[] = [];
  for (const rule of source.rules) {
    const include = rule.include.flatMap((id) => refById.get(id) ?? []);
    const exclude = rule.exclude.flatMap((id) => refById.get(id) ?? []);
    const aliases = (rule.aliases ?? []).map((a) => ({ folder: a.folder, alias: a.alias }));
    if (include.length + exclude.length === 0) continue;
    if (rule.folders.length + aliases.length === 0) continue;
    rules.push({ label: rule.label, folders: [...rule.folders], aliases, include, exclude });
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source.config?.env ?? {})) {
    const setting = findDaemonEnvSetting(name);
    if (setting === undefined || setting.kind === 'path') continue;
    env[setting.name] = value;
  }
  const relayUrl = source.config?.relayUrl;
  return {
    exportedAtMs: source.nowMs,
    cctlVersion: source.cctlVersion,
    platform: source.platform,
    accounts,
    rules,
    settings: { ...(relayUrl !== undefined ? { relayUrl } : {}), env },
  };
}

// ---------------------------------------------------------------------------
// Reading an opened payload
// ---------------------------------------------------------------------------

/** Bounds on an opened payload. A real export is far below each; a payload past one is refused
 *  rather than walked, so a hostile file cannot make the import spend memory or time on it. */
export const PAYLOAD_LIMITS = {
  accounts: 512,
  rules: 256,
  settings: 64,
  /** Labels, emails, uuids, aliases, setting values. */
  text: 1024,
  /** Folder paths. */
  path: 4096,
  /** One token. */
  token: 16 * 1024,
  /** Keys of an identity block (it is upstream JSON kept verbatim). */
  identityKeys: 64,
} as const;

/** Keys that would reach an object's prototype if a payload were ever merged naively. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Refuse the payload, naming what is wrong. */
function bad(what: string): never {
  throw new ExportFileError(`the file's contents are not a valid export: ${what}`, 'malformed');
}

/** A plain JSON object with none of the prototype-reaching keys. */
function obj(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    bad(`${where} is not an object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) bad(`${where} has a key named ${key}`);
  }
  return value as Record<string, unknown>;
}

/** A bounded string. */
function str(value: unknown, where: string, max: number = PAYLOAD_LIMITS.text): string {
  if (typeof value !== 'string') bad(`${where} is not a string`);
  if (value.length > max) bad(`${where} is longer than ${max} characters`);
  if (value.includes('\u0000')) bad(`${where} holds a NUL character`);
  return value;
}

/** A bounded, non-empty string. */
function nonEmpty(value: unknown, where: string, max?: number): string {
  const s = str(value, where, max);
  if (s.trim() === '') bad(`${where} is empty`);
  return s;
}

/** An optional bounded string. */
function optStr(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : str(value, where);
}

/** A bounded array. */
function arr(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) bad(`${where} is not a list`);
  if (value.length > max) bad(`${where} has more than ${max} entries`);
  return value;
}

/** A finite number. */
function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${where} is not a number`);
  return value;
}

/** The token block, keeping only the fields this build knows (so nothing unknown is written into
 *  a vault bundle). */
function parseOauth(value: unknown, where: string): ClaudeOauth {
  const o = obj(value, where);
  const oauth: ClaudeOauth = {
    accessToken: nonEmpty(o['accessToken'], `${where}.accessToken`, PAYLOAD_LIMITS.token),
    refreshToken: nonEmpty(o['refreshToken'], `${where}.refreshToken`, PAYLOAD_LIMITS.token),
    expiresAt: num(o['expiresAt'], `${where}.expiresAt`),
  };
  if (o['refreshTokenExpiresAt'] !== undefined) {
    oauth.refreshTokenExpiresAt = num(o['refreshTokenExpiresAt'], `${where}.refreshTokenExpiresAt`);
  }
  if (o['scopes'] !== undefined) {
    oauth.scopes = arr(o['scopes'], `${where}.scopes`, 64).map((s, i) =>
      str(s, `${where}.scopes[${i}]`),
    );
  }
  const subscriptionType = optStr(o['subscriptionType'], `${where}.subscriptionType`);
  if (subscriptionType !== undefined) oauth.subscriptionType = subscriptionType;
  const rateLimitTier = optStr(o['rateLimitTier'], `${where}.rateLimitTier`);
  if (rateLimitTier !== undefined) oauth.rateLimitTier = rateLimitTier;
  return oauth;
}

/** The identity block, kept verbatim (it is Claude Code's own JSON, and the vault preserves keys it
 *  does not know), but flat: only strings, numbers, booleans and null, so nothing nested or
 *  oversized rides along. */
function parseIdentity(value: unknown, where: string): OauthAccount {
  const o = obj(value, where);
  const keys = Object.keys(o);
  if (keys.length > PAYLOAD_LIMITS.identityKeys) bad(`${where} has too many fields`);
  const out: OauthAccount = {};
  for (const key of keys) {
    const v = o[key];
    if (typeof v === 'string') out[key] = str(v, `${where}.${key}`);
    else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      out[key] = v;
    else bad(`${where}.${key} is not a plain value`);
  }
  return out;
}

/** One account entry. Its identity and its bundle's identity must agree when both name a login. */
function parseAccount(value: unknown, i: number): ExportedAccount {
  const where = `accounts[${i}]`;
  const o = obj(value, where);
  const accountUuid = optStr(o['accountUuid'], `${where}.accountUuid`);
  const emailAddress = optStr(o['emailAddress'], `${where}.emailAddress`);
  const autoSwitchExcluded = o['autoSwitchExcluded'];
  if (typeof autoSwitchExcluded !== 'boolean') bad(`${where}.autoSwitchExcluded is not true/false`);
  const account: ExportedAccount = {
    label: nonEmpty(o['label'], `${where}.label`),
    ...(accountUuid !== undefined ? { accountUuid } : {}),
    ...(emailAddress !== undefined ? { emailAddress } : {}),
    autoSwitchExcluded,
  };
  if (o['bundle'] !== undefined) {
    const b = obj(o['bundle'], `${where}.bundle`);
    const bundle: CredentialBundle = {
      claudeAiOauth: parseOauth(b['claudeAiOauth'], `${where}.bundle.claudeAiOauth`),
    };
    if (b['oauthAccount'] !== undefined) {
      bundle.oauthAccount = parseIdentity(b['oauthAccount'], `${where}.bundle.oauthAccount`);
      const bundleUuid = bundle.oauthAccount.accountUuid;
      if (accountUuid !== undefined && bundleUuid !== undefined && bundleUuid !== accountUuid) {
        bad(`${where} names one login and carries the tokens of another`);
      }
    }
    account.bundle = bundle;
  }
  return account;
}

/** A list of bounded strings. */
function strList(value: unknown, where: string, max: number, maxLen?: number): string[] {
  return arr(value, where, max).map((s, i) => nonEmpty(s, `${where}[${i}]`, maxLen));
}

/** One rule entry. */
function parseRule(value: unknown, i: number): ExportedRule {
  const where = `rules[${i}]`;
  const o = obj(value, where);
  return {
    label: str(o['label'], `${where}.label`),
    folders: strList(o['folders'], `${where}.folders`, MAX_RULE_FOLDERS, PAYLOAD_LIMITS.path),
    aliases: arr(o['aliases'], `${where}.aliases`, MAX_RULE_ALIASES).map((a, j) => {
      const scope = obj(a, `${where}.aliases[${j}]`);
      return {
        folder: nonEmpty(scope['folder'], `${where}.aliases[${j}].folder`, PAYLOAD_LIMITS.path),
        alias: nonEmpty(scope['alias'], `${where}.aliases[${j}].alias`),
      };
    }),
    include: strList(o['include'], `${where}.include`, MAX_RULE_ACCOUNTS),
    exclude: strList(o['exclude'], `${where}.exclude`, MAX_RULE_ACCOUNTS),
  };
}

/** The settings entry: a relay and a flat map of strings. Which names are honored is the planner's
 *  call (it reports the ones it skips); here they only have to be strings. */
function parseSettings(value: unknown): ExportedSettings {
  const o = obj(value, 'settings');
  const relayUrl = optStr(o['relayUrl'], 'settings.relayUrl');
  const envRaw = obj(o['env'], 'settings.env');
  const names = Object.keys(envRaw);
  if (names.length > PAYLOAD_LIMITS.settings) bad('settings.env has too many entries');
  const env: Record<string, string> = {};
  for (const name of names)
    env[str(name, 'a setting name')] = str(envRaw[name], `settings.env.${name}`);
  return { ...(relayUrl !== undefined ? { relayUrl } : {}), env };
}

/**
 * Check an opened payload and return it typed. Refuses ({@link ExportFileError} `malformed`) any
 * field of the wrong type or past its bound, an account whose identity and tokens name different
 * logins, and the same login listed twice.
 */
export function parseExportPayload(text: string): ExportPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad('it is not JSON');
  }
  const o = obj(raw, 'the payload');
  const platform = str(o['platform'], 'platform') as NodeJS.Platform;
  const accounts = arr(o['accounts'], 'accounts', PAYLOAD_LIMITS.accounts).map(parseAccount);
  const seen = new Set<string>();
  for (const a of accounts) {
    if (a.accountUuid === undefined) continue;
    if (seen.has(a.accountUuid)) bad(`the login ${a.accountUuid} is listed twice`);
    seen.add(a.accountUuid);
  }
  return {
    exportedAtMs: num(o['exportedAtMs'], 'exportedAtMs'),
    cctlVersion: str(o['cctlVersion'], 'cctlVersion'),
    platform,
    accounts,
    rules: arr(o['rules'], 'rules', PAYLOAD_LIMITS.rules).map(parseRule),
    settings: parseSettings(o['settings']),
  };
}
