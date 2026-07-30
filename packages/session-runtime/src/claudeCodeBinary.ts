// Whether a session could actually start — i.e. whether the Agent SDK can find the Claude Code
// binary it spawns.
//
// The SDK does not implement Claude Code. It shells out to a ~250MB native binary published as
// a separate per-platform package (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`) that it
// declares as an OPTIONAL dependency and locates lazily, at the first `query()`, via
// `createRequire(import.meta.url).resolve(...)` from its own module location. Two consequences
// shape this file:
//
//   - The lookup is invisible until someone starts a session. An install missing that package
//     (`npm install --omit=optional`, a partial install, a disk that filled mid-download) runs
//     every other cctl command perfectly and fails only on `/run` — remotely, where the error
//     surfaces as a failed session card rather than something the user can debug.
//   - Nothing in this repo can ask the SDK to perform the lookup without also starting a real
//     session, so `cctl doctor` reproduces it instead. That makes this a FAITHFUL COPY of
//     someone else's resolution rule, which is a thing worth stating plainly: the candidate
//     list is read from the SDK's own shipped manifest rather than hardcoded here, so a new
//     platform or a renamed binary needs no edit, but a future SDK that changes HOW it resolves
//     would need this updated alongside it. It is a diagnostic, never a gate — no cctl code
//     path consults it before spawning.
//
// The resolution is expressed against injected `resolve`/`readFile` functions so the whole rule
// is unit-testable against fixed inputs, with no dependency on how the test runner's own
// node_modules happen to be laid out.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The SDK package whose native binary backs every managed session. */
export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export interface ClaudeCodeBinaryLookup {
  /** Absolute path to the native Claude Code binary, when one was found. */
  path?: string;
  /** Every package name tried, in order — the useful half of a failure message. */
  tried: string[];
  /** Human-readable cause, present only on failure. */
  error?: string;
}

/** The IO this lookup needs, injected so the rule can be tested without a real install. */
export interface ClaudeCodeBinaryDeps {
  /** Resolve a module specifier from the SDK's own location (default: a real `createRequire`
   *  rooted at this module, which is where the SDK sits at runtime in both the workspace and
   *  the published bundle). */
  resolveFromSdk?: (specifier: string) => string;
  /** Read the SDK's manifest, listing the binary filename per platform key. */
  readManifest?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Default resolver: find the SDK from THIS module, then resolve further specifiers from the
 *  SDK's own entry — matching the SDK's runtime behaviour, where the per-platform package is
 *  visible in the SDK's tree and not necessarily in ours. */
function defaultDeps(): Required<Pick<ClaudeCodeBinaryDeps, 'resolveFromSdk' | 'readManifest'>> {
  const sdkEntry = createRequire(import.meta.url).resolve(AGENT_SDK_PACKAGE);
  const fromSdk = createRequire(sdkEntry);
  return {
    resolveFromSdk: (specifier) => fromSdk.resolve(specifier),
    readManifest: () => readFileSync(join(dirname(sdkEntry), 'manifest.json'), 'utf8'),
  };
}

/**
 * Locate the native Claude Code binary the way the SDK will, and report the outcome rather than
 * throwing — a doctor check wants the reason, not an exception.
 *
 * Tries the plain `<platform>-<arch>` package first and the musl build second, which is how a
 * glibc host and an Alpine host each land on their own package.
 */
export function findClaudeCodeBinary(deps: ClaudeCodeBinaryDeps = {}): ClaudeCodeBinaryLookup {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  let resolveFromSdk = deps.resolveFromSdk;
  let readManifest = deps.readManifest;
  if (resolveFromSdk === undefined || readManifest === undefined) {
    try {
      const fallback = defaultDeps();
      resolveFromSdk ??= fallback.resolveFromSdk;
      readManifest ??= fallback.readManifest;
    } catch (err) {
      // The SDK package itself is missing. In the published bundle this cannot happen without
      // the CLI also failing to boot (the import is static), so this is mainly the shape a
      // half-finished `npm install` leaves behind.
      return {
        tried: [AGENT_SDK_PACKAGE],
        error: `${AGENT_SDK_PACKAGE} is not installed (${(err as Error).message})`,
      };
    }
  }

  let platforms: Record<string, { binary?: string } | undefined>;
  try {
    platforms = (JSON.parse(readManifest()) as { platforms?: typeof platforms }).platforms ?? {};
  } catch (err) {
    return {
      tried: [],
      error: `could not read the SDK's platform manifest: ${(err as Error).message}`,
    };
  }

  const tried: string[] = [];
  for (const key of [`${platform}-${arch}`, `${platform}-${arch}-musl`]) {
    const binary = platforms[key]?.binary;
    if (binary === undefined) continue;
    const packageName = `${AGENT_SDK_PACKAGE}-${key}`;
    tried.push(packageName);
    try {
      return { path: resolveFromSdk(`${packageName}/${binary}`), tried };
    } catch {
      // Try the next candidate; the aggregate failure is reported below.
    }
  }

  return {
    tried,
    error:
      tried.length === 0
        ? `the SDK publishes no Claude Code binary for ${platform}-${arch}`
        : `no Claude Code binary found — install ${tried.join(' or ')} ` +
          '(a `--omit=optional` install skips it; reinstall cctl without that flag)',
  };
}
