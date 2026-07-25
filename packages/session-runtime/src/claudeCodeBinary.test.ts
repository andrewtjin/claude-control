import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { findClaudeCodeBinary, AGENT_SDK_PACKAGE } from './claudeCodeBinary.js';

/** A manifest shaped like the SDK's own: platform key → the binary filename it ships. */
const MANIFEST = JSON.stringify({
  platforms: {
    'win32-x64': { binary: 'claude.exe' },
    'linux-x64': { binary: 'claude' },
    'linux-x64-musl': { binary: 'claude' },
  },
});

/** A resolver that succeeds for exactly the specifiers listed and throws for everything else,
 *  mirroring `require.resolve`'s all-or-nothing behaviour. */
const resolverFor = (available: Record<string, string>) => (specifier: string) => {
  const hit = available[specifier];
  if (hit === undefined) throw new Error(`Cannot find module '${specifier}'`);
  return hit;
};

describe('findClaudeCodeBinary', () => {
  it('resolves the plain platform package for this host', () => {
    const result = findClaudeCodeBinary({
      platform: 'win32',
      arch: 'x64',
      readManifest: () => MANIFEST,
      resolveFromSdk: resolverFor({
        [`${AGENT_SDK_PACKAGE}-win32-x64/claude.exe`]: 'C:/n_m/claude.exe',
      }),
    });

    expect(result.path).toBe('C:/n_m/claude.exe');
    expect(result.error).toBeUndefined();
    expect(result.tried).toEqual([`${AGENT_SDK_PACKAGE}-win32-x64`]);
  });

  it('falls back to the musl package when the glibc one is absent', () => {
    const result = findClaudeCodeBinary({
      platform: 'linux',
      arch: 'x64',
      readManifest: () => MANIFEST,
      resolveFromSdk: resolverFor({
        [`${AGENT_SDK_PACKAGE}-linux-x64-musl/claude`]: '/n_m/musl/claude',
      }),
    });

    expect(result.path).toBe('/n_m/musl/claude');
    // Both were attempted, in the SDK's own order — the failure list is the useful diagnostic.
    expect(result.tried).toEqual([
      `${AGENT_SDK_PACKAGE}-linux-x64`,
      `${AGENT_SDK_PACKAGE}-linux-x64-musl`,
    ]);
  });

  it('reports an actionable error when no platform package is installed', () => {
    // The `--omit=optional` shape: the SDK is present, its native binary package is not.
    const result = findClaudeCodeBinary({
      platform: 'win32',
      arch: 'x64',
      readManifest: () => MANIFEST,
      resolveFromSdk: resolverFor({}),
    });

    expect(result.path).toBeUndefined();
    expect(result.tried).toEqual([`${AGENT_SDK_PACKAGE}-win32-x64`]);
    expect(result.error).toContain(`${AGENT_SDK_PACKAGE}-win32-x64`);
    expect(result.error).toContain('--omit=optional');
  });

  it('reports the gap when the SDK publishes no binary for this platform at all', () => {
    const result = findClaudeCodeBinary({
      platform: 'sunos',
      arch: 'sparc',
      readManifest: () => MANIFEST,
      resolveFromSdk: resolverFor({}),
    });

    expect(result.path).toBeUndefined();
    expect(result.tried).toEqual([]);
    expect(result.error).toContain('sunos-sparc');
  });

  it('never throws when the manifest is unreadable — it reports why', () => {
    const result = findClaudeCodeBinary({
      platform: 'win32',
      arch: 'x64',
      readManifest: () => {
        throw new Error('ENOENT: manifest.json');
      },
      resolveFromSdk: resolverFor({}),
    });

    expect(result.path).toBeUndefined();
    expect(result.error).toContain('ENOENT');
  });

  it('never throws when the manifest is present but malformed', () => {
    const result = findClaudeCodeBinary({
      platform: 'win32',
      arch: 'x64',
      readManifest: () => 'not json',
      resolveFromSdk: resolverFor({}),
    });

    expect(result.path).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it('finds the real binary in this workspace with no injected deps', () => {
    // The one test that exercises the DEFAULT resolution against the actual install, which is
    // what the published package relies on. Injected-dep tests prove the rule; this proves the
    // rule is pointed at something real — asserted as "a file that exists on disk" rather than
    // by path shape, which differs per platform and per package manager layout.
    const result = findClaudeCodeBinary();

    expect(result.error).toBeUndefined();
    expect(result.path).toBeDefined();
    expect(existsSync(result.path as string)).toBe(true);
    expect(basename(result.path as string)).toMatch(/^claude(\.exe)?$/);
  });
});
