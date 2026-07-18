// Structural guard for the package's zero-credential rule (see index.ts's module comment):
// control-plane-bot must never pull in @claude-control/switch-engine, directly or through any
// other workspace package it depends on. Walks the REAL package.json files on disk — the same
// files pnpm resolves from — rather than re-asserting the rule in prose a second time, so a
// future dependency added here without rereading that comment fails a test instead of shipping.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This file lives at packages/control-plane-bot/src/, so two levels up is packages/, where
// every workspace package's directory name matches its unscoped package name.
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROOT_PACKAGE = '@claude-control/control-plane-bot';
const FORBIDDEN_PACKAGE = '@claude-control/switch-engine';

function readWorkspacePackageJson(packageName: string): { dependencies?: Record<string, string> } {
  const dirName = packageName.replace('@claude-control/', '');
  const path = join(PACKAGES_DIR, dirName, 'package.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> };
}

/** Recursively collects every `@claude-control/*` workspace package reachable from
 *  `packageName` via production `dependencies` only — devDependencies never ship, so they are
 *  irrelevant to what actually ends up in a built/deployed bot. */
function collectWorkspaceClosure(packageName: string, seen = new Set<string>()): Set<string> {
  if (seen.has(packageName)) return seen;
  seen.add(packageName);
  const { dependencies = {} } = readWorkspacePackageJson(packageName);
  for (const dep of Object.keys(dependencies)) {
    if (dep.startsWith('@claude-control/')) collectWorkspaceClosure(dep, seen);
  }
  return seen;
}

describe('control-plane-bot dependency closure', () => {
  it('never resolves @claude-control/switch-engine, directly or transitively', () => {
    const closure = collectWorkspaceClosure(ROOT_PACKAGE);
    expect(closure.has(FORBIDDEN_PACKAGE)).toBe(false);
  });
});
