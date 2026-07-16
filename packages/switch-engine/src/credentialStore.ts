// Read/write the two live files the Claude CLI actually consumes.
//
//   <claudeDir>/.credentials.json   holds the `claudeAiOauth` block (Windows: plaintext)
//   ~/.claude.json                  holds `oauthAccount` among much else
//
// Both writes are SURGICAL: we read the existing file, replace exactly one top-level key,
// and atomically write it back. `~/.claude.json` in particular is the CLI's entire config
// (projects, history, settings) — clobbering unrelated keys would be data loss, so we never
// author the whole file, only its `oauthAccount` block.

import { readFile } from 'node:fs/promises';
import type { ClaudeOauth, OauthAccount } from './types.js';
import type { Paths } from './paths.js';
import { atomicWriteFile } from './fsutil.js';

/** A record with arbitrary extra keys we must preserve when rewriting. */
type JsonObject = Record<string, unknown>;

export class CredentialStore {
  constructor(private readonly paths: Paths) {}

  /** The live access/refresh token, or `undefined` if no one is logged in. */
  async readLiveCredentials(): Promise<ClaudeOauth | undefined> {
    const file = await this.readJson(this.paths.credentialsPath);
    const block = file?.claudeAiOauth;
    return isOauth(block) ? block : undefined;
  }

  /** Replace the `claudeAiOauth` block, preserving any other keys already in the file. */
  async writeLiveCredentials(oauth: ClaudeOauth): Promise<void> {
    const file = (await this.readJson(this.paths.credentialsPath)) ?? {};
    file.claudeAiOauth = oauth;
    await atomicWriteFile(this.paths.credentialsPath, JSON.stringify(file, null, 2));
  }

  /** The live `oauthAccount` block from `~/.claude.json`, if present. */
  async readOauthAccount(): Promise<OauthAccount | undefined> {
    const file = await this.readJson(this.paths.claudeJsonPath);
    const block = file?.oauthAccount;
    return isObject(block) ? block : undefined;
  }

  /**
   * Replace the `oauthAccount` block in `~/.claude.json`, preserving every other key.
   * If the file does not exist yet it is created with just this block — the CLI fills in
   * the rest on next run.
   */
  async writeOauthAccount(account: OauthAccount): Promise<void> {
    const file = (await this.readJson(this.paths.claudeJsonPath)) ?? {};
    file.oauthAccount = account;
    await atomicWriteFile(this.paths.claudeJsonPath, JSON.stringify(file));
  }

  private async readJson(path: string): Promise<JsonObject | undefined> {
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
