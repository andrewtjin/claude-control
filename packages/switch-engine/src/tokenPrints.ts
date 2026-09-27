// Fingerprints of the tokens the vault stores, so "is this live token some OTHER account's?" can be
// answered without decrypting every bundle under the credential lock.
//
// Rotation adoption writes a live token into the bundle of the account the live identity block names.
// When the two live files disagree (a switch torn between its two writes, a copy made by hand), that
// token can be a different stored account's own token, and writing it there leaves one single-use
// refresh token in two bundles while destroying the other account's. Refusing that needs every stored
// token — every bundle decrypted. On Windows each decrypt is a PowerShell spawn: far too slow to run
// for every account inside the lock (whose holder must finish well inside the reclaim window) or on
// every daemon cycle.
//
// So each bundle's tokens are remembered as SHA-256 fingerprints, keyed by the digest of the exact
// encrypted blob they were read from. The key validates itself: a bundle rewritten by anyone (this
// process, another one, an older build) is a different blob with a different digest, so an entry can
// never be consulted for a bundle it does not describe — a changed bundle simply misses and is
// decrypted once. A fingerprint is one-way; nothing here holds a token. The index lives in memory and
// in a small file beside the bundles, so a short-lived CLI process starts warm as well.

import { createHash } from 'node:crypto';
import type { ClaudeOauth } from './types.js';
import { atomicWriteFile, readJsonIfExists } from './fsutil.js';

/** SHA-256 fingerprints (hex) of the two tokens one credential block holds. */
export interface TokenPrints {
  access: string;
  refresh: string;
}

/** Fingerprint a credential block's two tokens. */
export function tokenPrints(oauth: Pick<ClaudeOauth, 'accessToken' | 'refreshToken'>): TokenPrints {
  return { access: sha256(oauth.accessToken), refresh: sha256(oauth.refreshToken) };
}

/** The key an index entry is filed under: the digest of the encrypted blob it was read from. */
export function blobDigest(blob: string): string {
  return sha256(blob);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Which stored account holds which token, as fingerprints — the answer {@link Vault.readStoredTokens}
 *  builds for one moment of the registry. */
export class StoredTokens {
  constructor(
    private readonly byAccount: ReadonlyMap<string, TokenPrints>,
    /** Accounts whose bundle exists but could not be read or decrypted, with why. They hold nothing
     *  as far as these answers go, so a caller that reports on the whole vault must say they were
     *  left out rather than vouch for them. */
    readonly unreadable: ReadonlyMap<string, string> = new Map(),
  ) {}

  /** Ids of the OTHER stored accounts whose bundle holds the same refresh token as `accountId`'s. */
  refreshSharers(accountId: string): string[] {
    const own = this.byAccount.get(accountId);
    if (own === undefined) return [];
    const out: string[] = [];
    for (const [id, stored] of this.byAccount) {
      if (id !== accountId && stored.refresh === own.refresh) out.push(id);
    }
    return out;
  }

  /** Ids of the stored accounts whose bundle holds `oauth`'s refresh token or its access token. A
   *  token is issued to one account, so more than one id here is itself a contamination. */
  holdersOf(oauth: Pick<ClaudeOauth, 'accessToken' | 'refreshToken'>): string[] {
    const live = tokenPrints(oauth);
    const out: string[] = [];
    for (const [id, stored] of this.byAccount) {
      if (stored.refresh === live.refresh || stored.access === live.access) out.push(id);
    }
    return out;
  }

  /** Every set of two or more accounts whose bundles store the same refresh token. */
  sharedTokens(): string[][] {
    const byRefresh = new Map<string, string[]>();
    for (const [id, prints] of this.byAccount) {
      byRefresh.set(prints.refresh, [...(byRefresh.get(prints.refresh) ?? []), id]);
    }
    return [...byRefresh.values()].filter((ids) => ids.length > 1);
  }
}

/** On-disk shape of the index file. Versioned so a later layout is read as empty, not misread. */
interface PrintIndexFile {
  version: 1;
  prints: Record<string, TokenPrints>;
}

/** Read the persisted index; anything missing, unreadable or of another shape reads as empty — the
 *  index is only ever a cache, and an empty one costs decrypts, never correctness. */
export async function readPrintIndex(path: string): Promise<Map<string, TokenPrints>> {
  const out = new Map<string, TokenPrints>();
  let file: unknown;
  try {
    file = await readJsonIfExists<unknown>(path);
  } catch {
    return out;
  }
  if (typeof file !== 'object' || file === null) return out;
  const { version, prints } = file as Partial<PrintIndexFile>;
  if (version !== 1 || typeof prints !== 'object' || prints === null) return out;
  for (const [digest, entry] of Object.entries(prints)) {
    const p = entry as Partial<TokenPrints> | null;
    if (p !== null && typeof p.access === 'string' && typeof p.refresh === 'string') {
      out.set(digest, { access: p.access, refresh: p.refresh });
    }
  }
  return out;
}

/** Replace the persisted index with `entries`. */
export async function writePrintIndex(
  path: string,
  entries: ReadonlyMap<string, TokenPrints>,
): Promise<void> {
  const file: PrintIndexFile = { version: 1, prints: Object.fromEntries(entries) };
  await atomicWriteFile(path, JSON.stringify(file));
}
