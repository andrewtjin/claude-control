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
import { isDeepStrictEqual } from 'node:util';
import type { ClaudeOauth, OauthAccount } from './types.js';
import type { Paths } from './paths.js';
import { atomicWriteFile, removeIfExists } from './fsutil.js';

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
  /** Remove the live login, leaving "not logged in". Optional: a channel without it is cleared by
   *  removing `.credentials.json` (see {@link CredentialStore.clearLiveCredentials}). */
  clearLiveCredentials?(): Promise<void>;
  /** Diagnostic only: the exact identity this channel reads/writes, for channels that have one
   *  (KeychainCredentialChannel's service/account). Absent on channels a plain path already
   *  identifies (FileCredentialChannel) — callers reporting a target must read it from HERE,
   *  never recompute it independently, or the two can drift apart. */
  readonly target?: { service: string; account: string };
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

  /** Remove `.credentials.json` — an absent file is "not logged in". A no-op when already absent. */
  async clearLiveCredentials(): Promise<void> {
    await removeIfExists(this.credentialsPath);
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

  /**
   * Remove the live login ("not logged in") wherever this platform keeps it — what undoing a switch
   * that found nobody logged in has to leave behind.
   *
   * A channel that cannot clear itself falls back to removing `.credentials.json`. On macOS that
   * leaves the Keychain item in place; the caller removes the identity block either way, so what can
   * remain is a token with no identity statement, which Claude Code re-derives and cctl never adopts
   * on the strength of the registry alone.
   */
  async clearLiveCredentials(): Promise<void> {
    if (this.channel.clearLiveCredentials) await this.channel.clearLiveCredentials();
    else await removeIfExists(this.paths.credentialsPath);
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
   *
   * A block already equal to `account` is left as it is rather than rewritten. Beyond sparing a
   * rewrite of the CLI's whole config, this keeps an undo from depending on a write it does not need:
   * a switch whose identity write failed because another process holds `.claude.json` open still has
   * the previous identity in place, so putting the previous login back must not need that same
   * blocked write.
   */
  async writeOauthAccount(account: OauthAccount): Promise<void> {
    const file = (await readJson(this.paths.claudeJsonPath)) ?? {};
    if (isDeepStrictEqual(file.oauthAccount, account)) return;
    file.oauthAccount = account;
    await atomicWriteFile(this.paths.claudeJsonPath, JSON.stringify(file));
  }

  /**
   * REMOVE the `oauthAccount` block from `~/.claude.json`, preserving every other key — the
   * surgical counterpart of {@link writeOauthAccount}, and a no-op when the file or the block
   * is already absent (so it never creates a file just to say nothing).
   *
   * Exists because there is no third option. Whoever writes the live credentials must leave the
   * identity block describing the account those credentials belong to; when there is no block to
   * write, the one already on disk names the PREVIOUS account and is a positive false statement
   * about who is logged in. Absence states nothing, and it is a state the CLI recovers from on
   * its own: it re-derives the block from whoever the live access token resolves to (CLI 2.1.220
   * fetches the OAuth profile and writes the block back) and it gates "logged in" on the token,
   * not on this block. A stale block gets no such correction — the CLI skips the re-derivation
   * while the block looks complete.
   */
  async clearOauthAccount(): Promise<void> {
    const file = await readJson(this.paths.claudeJsonPath);
    if (!file || !('oauthAccount' in file)) return;
    delete file.oauthAccount;
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
