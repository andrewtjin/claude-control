// What an export file carries once it is opened: accounts (with or without their credentials),
// the folder and session rules over them, and the persisted daemon settings.
//
// Two halves. `buildExportPayload` assembles it from what the engine and the config file hold on
// this machine, and is the one place that decides what does NOT travel. `parseExportPayload`
// checks an opened payload field by field before anything acts on it: the file authenticated
// under the passphrase, but whoever knew the passphrase wrote it, so its contents are input like
// any other, bounded and shape-checked here so the import planner can trust the types.
//
// Never carried: the relay (its URL and its pairing identity: a daemon's pairing token belongs to
// the relay that issued it, so sending it to another relay would hand that relay this machine's
// credential), the hook secret, the vault key, switch-recovery files, token fingerprints, the
// guard snapshot, profiles, the daemon's database (sessions, outbox, cards) and usage history.
// Settings that name a path are dropped too: a path on this machine means nothing on another.

import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_PLAN_KEYS,
  MAX_RULES,
  MAX_RULE_ACCOUNTS,
  MAX_RULE_ALIASES,
  MAX_RULE_FOLDERS,
  sanitizeTerminalText,
  type AccountPlanFacts,
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
  /** The account's id on the machine it was exported from. The import stores it under the same
   *  id, so a second import finds it whatever it is labelled and whatever identity it carries. */
  id?: string;
  accountUuid?: string;
  emailAddress?: string;
  /** Kept for an account that travels without tokens, so its row here carries every identity
   *  anchor a re-login is checked against. */
  organizationUuid?: string;
  /** The plan facts of an account that travels without tokens (its bundle would carry them), so
   *  its row here shows its plan before its first login. */
  plan?: AccountPlanFacts;
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
  /** The rule's identity across machines: its origin, or for a rule made by hand, its id (see
   *  FolderRule.origin). An import finds by it the rule an earlier import of this one made. Absent
   *  for a rule whose id is not a uuid (a hand-edited registry). */
  origin?: string;
  folders: string[];
  aliases: ExportedAliasScope[];
  include: string[];
  exclude: string[];
}

/** The persisted daemon settings: the `env` block of config.json. `relayUrl` is never written; a
 *  file that carries one (an earlier build wrote it) is read, and the import leaves it out. */
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
 *  tokens travel; an account missing from it travels without them. `allAccounts` is every account
 *  here, selected or not, so a rule member that stays behind can still be named. */
export interface ExportSource {
  accounts: readonly AccountView[];
  allAccounts: readonly AccountView[];
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
 * Assemble the payload for `source.accounts` (already the selection to export). A rule travels
 * when at least one selected account is among its members, and then with EVERY member named,
 * selected or not: a member that stays behind may already be stored on the other machine (the
 * import finds it there by login, or leaves it out and says so), and dropping it here would change
 * what the rule means — a folder pinned to one account would arrive open to any. A rule with no
 * scope is left out. Settings that name a path, names this build does not know, and the relay are
 * dropped.
 */
export function buildExportPayload(source: ExportSource): ExportPayload {
  const selected = new Set(source.accounts.map((a) => a.id));
  const refById = new Map(
    [...source.allAccounts, ...source.accounts].map((a) => [a.id, memberRef(a)]),
  );
  const accounts: ExportedAccount[] = source.accounts.map((a) => {
    const bundle = source.bundles.get(a.id);
    const plan = bundle === undefined ? planFacts(a) : undefined;
    return {
      label: a.label,
      // Every id the vault makes is a uuid; one that is not (a hand-edited registry) stays here.
      ...(ACCOUNT_ID_PATTERN.test(a.id) ? { id: a.id } : {}),
      ...(a.accountUuid !== undefined ? { accountUuid: a.accountUuid } : {}),
      ...(a.emailAddress !== undefined ? { emailAddress: a.emailAddress } : {}),
      ...(a.organizationUuid !== undefined ? { organizationUuid: a.organizationUuid } : {}),
      ...(plan !== undefined ? { plan } : {}),
      autoSwitchExcluded: a.autoSwitchExcluded === true,
      ...(bundle !== undefined ? { bundle } : {}),
    };
  });
  const rules: ExportedRule[] = [];
  for (const rule of source.rules) {
    if (![...rule.include, ...rule.exclude].some((id) => selected.has(id))) continue;
    const include = rule.include.flatMap((id) => refById.get(id) ?? []);
    const exclude = rule.exclude.flatMap((id) => refById.get(id) ?? []);
    const aliases = (rule.aliases ?? []).map((a) => ({ folder: a.folder, alias: a.alias }));
    if (rule.folders.length + aliases.length === 0) continue;
    // A rule made here by hand is known elsewhere by its own id; one an import brought keeps the
    // identity it came with, so a rule passed on from machine to machine stays one rule.
    const origin = rule.origin ?? rule.id;
    rules.push({
      label: rule.label,
      ...(ACCOUNT_ID_PATTERN.test(origin) ? { origin } : {}),
      folders: [...rule.folders],
      aliases,
      include,
      exclude,
    });
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source.config?.env ?? {})) {
    const setting = findDaemonEnvSetting(name);
    if (setting === undefined || setting.kind === 'path') continue;
    env[setting.name] = value;
  }
  return {
    exportedAtMs: source.nowMs,
    cctlVersion: source.cctlVersion,
    platform: source.platform,
    accounts,
    rules,
    settings: { env },
  };
}

/** The plan facts a row holds, or undefined when it holds none. */
function planFacts(account: AccountPlanFacts): AccountPlanFacts | undefined {
  const out: AccountPlanFacts = {};
  for (const key of ACCOUNT_PLAN_KEYS) {
    const value = account[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The login an entry belongs to: the uuid recorded with it, else the one its tokens name. */
export function loginOf(entry: ExportedAccount): string | undefined {
  const fromBundle = entry.bundle?.oauthAccount?.accountUuid;
  return entry.accountUuid ?? (typeof fromBundle === 'string' ? fromBundle : undefined);
}

// ---------------------------------------------------------------------------
// Reading an opened payload
// ---------------------------------------------------------------------------

/** Bounds on an opened payload. A real export is far below each; a payload past one is refused
 *  rather than walked, so a hostile file cannot make the import spend memory or time on it. */
export const PAYLOAD_LIMITS = {
  accounts: 512,
  /** No machine holds more rules than this, so no real export carries more. */
  rules: MAX_RULES,
  settings: 64,
  /** Labels, emails, uuids, aliases, setting values. */
  text: 1024,
  /** Folder paths. */
  path: 4096,
  /** Scopes (folders and session aliases) of all the rules together. Each one is looked up on
   *  the disk and checked on its own, so this bounds what a file can make an import spend on them.
   *  The per-rule caps alone allow tens of thousands, which takes minutes; no real setup scopes
   *  this many folders. */
  scopes: 1024,
  /** One token. */
  token: 16 * 1024,
  /** Keys of an identity block (it is upstream JSON kept verbatim), and of any object in it. */
  identityKeys: 64,
  /** How deep an identity block may nest (Claude Code's holds an object or two). */
  identityDepth: 6,
  /** Values in an identity block, counted through every level. */
  identityValues: 1024,
} as const;

/** The platforms Node runs on: a file naming anything else was not written by cctl. */
const PLATFORMS: ReadonlySet<string> = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);

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

/** A string that is printed and stored as it is (an email, a login id): no terminal control or
 *  bidirectional character may ride in it. */
function plainText(value: string, where: string): string {
  if (sanitizeTerminalText(value) !== value) {
    bad(`${where} holds a control or bidirectional character`);
  }
  return value;
}

/** An optional bounded string that must be plain text. */
function optPlain(value: unknown, where: string): string | undefined {
  const s = optStr(value, where);
  return s === undefined ? undefined : plainText(s, where);
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
      plainText(str(s, `${where}.scopes[${i}]`), `${where}.scopes[${i}]`),
    );
  }
  // The plan facts are copied onto the account's row, like the identity block's.
  const subscriptionType = optPlain(o['subscriptionType'], `${where}.subscriptionType`);
  if (subscriptionType !== undefined) oauth.subscriptionType = subscriptionType;
  const rateLimitTier = optPlain(o['rateLimitTier'], `${where}.rateLimitTier`);
  if (rateLimitTier !== undefined) oauth.rateLimitTier = rateLimitTier;
  return oauth;
}

/** The identity block, kept verbatim: it is Claude Code's own JSON (which nests — its onboarding
 *  flags are an object), and the vault preserves keys it does not know. Bounded instead: its depth,
 *  its keys per object and its values in all, each string's length, and no key that reaches a
 *  prototype. Every string in it must be plain text: the vault copies a row's identity and plan
 *  facts out of it (the email, the billing type) and the CLI prints them, it is written into the
 *  live config Claude Code reads, and the fields printed today are not the only ones ever to be. */
function parseIdentity(value: unknown, where: string): OauthAccount {
  let budget = PAYLOAD_LIMITS.identityValues;
  const walk = (v: unknown, at: string, depth: number): unknown => {
    budget -= 1;
    if (budget < 0) bad(`${where} holds too many values`);
    if (typeof v === 'string') return plainText(str(v, at), at);
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v;
    if (depth >= PAYLOAD_LIMITS.identityDepth) bad(`${at} is nested too deeply`);
    if (Array.isArray(v)) {
      return arr(v, at, PAYLOAD_LIMITS.identityKeys).map((x, i) =>
        walk(x, `${at}[${i}]`, depth + 1),
      );
    }
    if (typeof v !== 'object') bad(`${at} is not a JSON value`);
    const o = obj(v, at);
    const keys = Object.keys(o);
    if (keys.length > PAYLOAD_LIMITS.identityKeys) bad(`${at} has too many fields`);
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = walk(o[key], `${at}.${key}`, depth + 1);
    return out;
  };
  return walk(obj(value, where), where, 0) as OauthAccount;
}

/** An account's plan facts: only the keys a row keeps, each plain text (the row is printed). */
function parsePlan(value: unknown, where: string): AccountPlanFacts {
  const o = obj(value, where);
  for (const key of Object.keys(o)) {
    if (!(ACCOUNT_PLAN_KEYS as readonly string[]).includes(key)) {
      bad(`${where} has a field ${sanitizeTerminalText(key)}`);
    }
  }
  const plan: AccountPlanFacts = {};
  for (const key of ACCOUNT_PLAN_KEYS) {
    const v = optPlain(o[key], `${where}.${key}`);
    if (v !== undefined) plan[key] = v;
  }
  return plan;
}

/**
 * One account entry. Its identity and its bundle's identity must agree: on the login when both name
 * one, and — when neither does, so the email is all either has to go by — on the email.
 */
function parseAccount(value: unknown, i: number): ExportedAccount {
  const where = `accounts[${i}]`;
  const o = obj(value, where);
  const accountUuid = optPlain(o['accountUuid'], `${where}.accountUuid`);
  const emailAddress = optPlain(o['emailAddress'], `${where}.emailAddress`);
  const organizationUuid = optPlain(o['organizationUuid'], `${where}.organizationUuid`);
  const id = optStr(o['id'], `${where}.id`);
  if (id !== undefined && !ACCOUNT_ID_PATTERN.test(id)) bad(`${where}.id is not an account id`);
  const plan = o['plan'] === undefined ? undefined : parsePlan(o['plan'], `${where}.plan`);
  const autoSwitchExcluded = o['autoSwitchExcluded'];
  if (typeof autoSwitchExcluded !== 'boolean') bad(`${where}.autoSwitchExcluded is not true/false`);
  const account: ExportedAccount = {
    label: nonEmpty(o['label'], `${where}.label`),
    ...(id !== undefined ? { id } : {}),
    ...(accountUuid !== undefined ? { accountUuid } : {}),
    ...(emailAddress !== undefined ? { emailAddress } : {}),
    ...(organizationUuid !== undefined ? { organizationUuid } : {}),
    ...(plan !== undefined ? { plan } : {}),
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
      const bundleEmail = bundle.oauthAccount.emailAddress;
      const otherLogin =
        accountUuid !== undefined && typeof bundleUuid === 'string'
          ? bundleUuid !== accountUuid
          : accountUuid === undefined &&
            typeof bundleUuid !== 'string' &&
            emailAddress !== undefined &&
            typeof bundleEmail === 'string' &&
            bundleEmail.toLowerCase() !== emailAddress.toLowerCase();
      if (otherLogin) bad(`${where} names one login and carries the tokens of another`);
    }
    account.bundle = bundle;
  }
  return account;
}

/** A list of bounded strings. */
function strList(value: unknown, where: string, max: number, maxLen?: number): string[] {
  return arr(value, where, max).map((s, i) => nonEmpty(s, `${where}[${i}]`, maxLen));
}

/** One rule entry. A member listed twice counts once; one both included and excluded is a rule no
 *  vault can hold, so it is refused. */
function parseRule(value: unknown, i: number): ExportedRule {
  const where = `rules[${i}]`;
  const o = obj(value, where);
  const include = [...new Set(strList(o['include'], `${where}.include`, MAX_RULE_ACCOUNTS))];
  const exclude = [...new Set(strList(o['exclude'], `${where}.exclude`, MAX_RULE_ACCOUNTS))];
  const both = include.find((ref) => exclude.includes(ref));
  if (both !== undefined) bad(`${where} both includes and excludes ${both}`);
  const origin = optStr(o['origin'], `${where}.origin`);
  if (origin !== undefined && !ACCOUNT_ID_PATTERN.test(origin))
    bad(`${where}.origin is not a rule id`);
  return {
    label: str(o['label'], `${where}.label`),
    ...(origin !== undefined ? { origin } : {}),
    folders: strList(o['folders'], `${where}.folders`, MAX_RULE_FOLDERS, PAYLOAD_LIMITS.path),
    aliases: arr(o['aliases'], `${where}.aliases`, MAX_RULE_ALIASES).map((a, j) => {
      const scope = obj(a, `${where}.aliases[${j}]`);
      return {
        folder: nonEmpty(scope['folder'], `${where}.aliases[${j}].folder`, PAYLOAD_LIMITS.path),
        alias: nonEmpty(scope['alias'], `${where}.aliases[${j}].alias`),
      };
    }),
    include,
    exclude,
  };
}

/** The settings entry: a relay and a flat map of strings. Which names are honored is the planner's
 *  call (it reports the ones it skips); here they only have to be strings, and no setting may be
 *  named twice (an alias and its env name, say), since only one value can be saved for it. */
function parseSettings(value: unknown): ExportedSettings {
  const o = obj(value, 'settings');
  const relayUrl = optStr(o['relayUrl'], 'settings.relayUrl');
  const envRaw = obj(o['env'], 'settings.env');
  const names = Object.keys(envRaw);
  if (names.length > PAYLOAD_LIMITS.settings) bad('settings.env has too many entries');
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of names) {
    const canonical = findDaemonEnvSetting(name)?.name ?? name;
    if (seen.has(canonical)) bad(`settings.env names ${sanitizeTerminalText(canonical)} twice`);
    seen.add(canonical);
    env[str(name, 'a setting name')] = str(envRaw[name], `settings.env.${name}`);
  }
  return { ...(relayUrl !== undefined ? { relayUrl } : {}), env };
}

/** The largest magnitude a Date can hold, in milliseconds either side of the epoch. */
const MAX_DATE_MS = 8.64e15;

/**
 * Check an opened payload and return it typed. Refuses ({@link ExportFileError} `malformed`) any
 * field of the wrong type or past its bound, an account whose identity and tokens name different
 * logins, the same login listed twice (by the uuid recorded with it or the one its tokens name),
 * a platform no build runs on, and a date no date can hold.
 */
export function parseExportPayload(text: string): ExportPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad('it is not JSON');
  }
  const o = obj(raw, 'the payload');
  const platformText = str(o['platform'], 'platform');
  if (!PLATFORMS.has(platformText)) bad('platform is not one a cctl build runs on');
  const platform = platformText as NodeJS.Platform;
  const accounts = arr(o['accounts'], 'accounts', PAYLOAD_LIMITS.accounts).map(parseAccount);
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const a of accounts) {
    if (a.id !== undefined) {
      if (ids.has(a.id)) bad(`the account id ${a.id} is listed twice`);
      ids.add(a.id);
    }
    const login = loginOf(a);
    if (login === undefined) continue;
    if (seen.has(login)) bad(`the login ${sanitizeTerminalText(login)} is listed twice`);
    seen.add(login);
  }
  const rules = arr(o['rules'], 'rules', PAYLOAD_LIMITS.rules).map(parseRule);
  // One rule per identity: two would both be the rule an earlier import made here.
  const origins = new Set<string>();
  for (const r of rules) {
    if (r.origin === undefined) continue;
    if (origins.has(r.origin)) bad(`the rule ${r.origin} is listed twice`);
    origins.add(r.origin);
  }
  const scopes = rules.reduce((n, r) => n + r.folders.length + r.aliases.length, 0);
  if (scopes > PAYLOAD_LIMITS.scopes) {
    bad(`the rules hold more than ${PAYLOAD_LIMITS.scopes} folders and session aliases in all`);
  }
  const exportedAtMs = num(o['exportedAtMs'], 'exportedAtMs');
  if (Math.abs(exportedAtMs) > MAX_DATE_MS) bad('exportedAtMs is not a date');
  return {
    exportedAtMs,
    cctlVersion: str(o['cctlVersion'], 'cctlVersion'),
    platform,
    accounts,
    rules,
    settings: parseSettings(o['settings']),
  };
}
