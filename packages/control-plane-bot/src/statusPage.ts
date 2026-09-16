// The status page served at `/`: a static HTML shell (assets/status/index.html) that fetches
// `/api/status` and renders it client-side, plus the Content-Security-Policy that lets exactly that
// shell's own <style> and <script> run and nothing else.
//
// The page is loaded ONCE at startup and served from memory: it never changes while the process
// runs, and reading it per request would put a disk read on the internet-facing path for no gain.
// The CSP is hash-based rather than `'unsafe-inline'` so that even if a later change let attacker
// text into the page (it renders nothing but the relay's own JSON today), no injected script or
// style would execute. That is only sound if the shell has exactly one <style> and one <script>
// block, so loading fails loudly when it does not.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export interface StatusPage {
  html: string;
  /** Value for the `content-security-policy` response header. */
  csp: string;
}

// Resolved relative to this module's compiled location (dist/statusPage.js -> ../assets/status),
// the same way the progress-bar sprites are found; the Dockerfile copies the assets directory
// alongside dist for exactly this reason.
const DEFAULT_PAGE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'status',
  'index.html',
);

function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** Extract the single inline block of `tag` from the page. Exactly one, or the CSP below would
 *  either block a block it did not hash or hash something that is not a block. */
function onlyBlock(html: string, tag: 'style' | 'script'): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const matches = [...html.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`status page must contain exactly one <${tag}> block, found ${matches.length}`);
  }
  return matches[0]![1]!;
}

/** Build the page from an HTML string. Exported for tests and for `loadStatusPage`. */
export function buildStatusPage(html: string): StatusPage {
  const styleHash = sha256Base64(onlyBlock(html, 'style'));
  const scriptHash = sha256Base64(onlyBlock(html, 'script'));
  const csp = [
    "default-src 'none'",
    `style-src 'sha256-${styleHash}'`,
    `script-src 'sha256-${scriptHash}'`,
    // The shell fetches /api/status from its own origin and nothing else.
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html, csp };
}

/** Read the shipped page from disk. Throws if it is missing or malformed: a bot that cannot serve
 *  its status page is a packaging defect worth failing startup over, not a 404 to discover later. */
export function loadStatusPage(path: string = DEFAULT_PAGE_PATH): StatusPage {
  return buildStatusPage(readFileSync(path, 'utf8'));
}
