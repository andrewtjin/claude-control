// Read/write the live credential state the Claude CLI actually consumes.
//
// WHERE the live `claudeAiOauth` block lives is platform-dependent:
//   Windows/Linux   <claudeDir>/.credentials.json (plaintext file)
//   macOS           the login Keychain (item owned by the CLI) — see keychain.ts
// That difference is isolated behind `LiveCredentialChannel`; everything above it (engine,
// capture, recovery) is platform-blind.
//
// `~/.claude.json` (`oauthAccount` among much else) is a plain JSON file on EVERY platform,
// so it stays file-based here.
//
// All file writes are SURGICAL: read the existing file, replace exactly one top-level key,
// atomically write it back. `~/.claude.json` in particular is the CLI's entire config
// (projects, history, settings) — clobbering unrelated keys would be data loss, so we never
// author the whole file, only its `oauthAccount` block.

import { readFile } from 'node:fs/promises';
import type { ClaudeOauth, OauthAccount } from './types.js';
import type { Paths } from './paths.js';
import { atomicWriteFile } from './fsutil.js';

/** A record with arbitrary extra keys we must preserve when rewriting. */
type JsonObject = Record<string, unknown>;

/** Where the live `claudeAiOauth` block is read from and written to. Implementations:
 *  {@link FileCredentialChannel} (win/linux) and keychain.ts's KeychainCredentialChannel
 *  (darwin). Kept structural so tests can inject an in-memory fake. */
export interface LiveCredentialChannel {
  /** The live access/refresh token, or `undefined` if no one is logged in. */
  readLiveCredentials(): Promise<ClaudeOauth | undefined>;
  /** Replace the live token block, preserving any sibling data the CLI stores with it. */
  writeLiveCredentials(oauth: ClaudeOauth): Promise<void>;
}

/** The `.credentials.json` channel — the historical (Windows) behavior, verbatim. */
export class FileCredentialChannel implements LiveCredentialChannel {
  constructor(private readonly credentialsPath: string) {}

  async readLiveCredentials(): Promise<ClaudeOauth | undefined> {
    const file = await readJson(this.credentialsPath);
    const block = file?.claudeAiOauth;
    return isOauth(block) ? block : undefined;
  }

  /** Replace the `claudeAiOauth` block, preserving any other keys already in the file. */
  async writeLiveCredentials(oauth: ClaudeOauth): Promise<void> {
    const file = (await readJson(this.credentialsPath)) ?? {};
    file.claudeAiOauth = oauth;
    await atomicWriteFile(this.credentialsPath, JSON.stringify(file, null, 2));
  }
}

export class CredentialStore {
  private readonly channel: LiveCredentialChannel;

  /** `channel` defaults to the file channel — the right answer everywhere except darwin,
   *  where composition roots pass a KeychainCredentialChannel via `defaultProtector`'s
   *  sibling factory (see protector.ts). Defaulting to the FILE keeps sandboxed tests and
   *  the transient-config-dir capture flow (which is file-based by contract) untouched. */
  constructor(
    private readonly paths: Paths,
    channel?: LiveCredentialChannel,
  ) {
    this.channel = channel ?? new FileCredentialChannel(paths.credentialsPath);
  }

  /** The live access/refresh token, or `undefined` if no one is logged in. */
  readLiveCredentials(): Promise<ClaudeOauth | undefined> {
    return this.channel.readLiveCredentials();
  }

  /** Replace the live `claudeAiOauth` block wherever this platform keeps it. */
  writeLiveCredentials(oauth: ClaudeOauth): Promise<void> {
    return this.channel.writeLiveCredentials(oauth);
  }

  /** The live `oauthAccount` block from `~/.claude.json`, if present. */
  async readOauthAccount(): Promise<OauthAccount | undefined> {
    const file = await readJson(this.paths.claudeJsonPath);
    const block = file?.oauthAccount;
    return isObject(block) ? block : undefined;
  }

  /**
   * Replace the `oauthAccount` block in `~/.claude.json`, preserving every other key.
   * If the file does not exist yet it is created with just this block — the CLI fills in
   * the rest on next run.
   */
  async writeOauthAccount(account: OauthAccount): Promise<void> {
    const file = (await readJson(this.paths.claudeJsonPath)) ?? {};
    file.oauthAccount = account;
    await atomicWriteFile(this.paths.claudeJsonPath, JSON.stringify(file));
  }
}

async function readJson(path: string): Promise<JsonObject | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  // JSON.parse tolerates the duplicate-key quirk seen in real ~/.claude.json files
  // (last value wins) — the same normalization any writer applies.
  return JSON.parse(raw) as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal structural check that a parsed block is a usable credential. */
function isOauth(value: unknown): value is ClaudeOauth {
  return (
    isObject(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string' &&
    typeof value.expiresAt === 'number'
  );
}
