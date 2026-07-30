#!/usr/bin/env node
// Bundles the cctl CLI into one publishable file. The entry point is the *source*
// packages/cli/src/bin.ts, not that package's own tsc output — esbuild transpiles TypeScript
// itself, and bundling from source lets it inline every `@claude-control/*` workspace import
// (resolved through each package's "main" — compiled dist/, which is why prepublishOnly runs
// the workspace `pnpm build` first: a stale dist would silently ship outdated package code)
// into a single dist/bin.js with no workspace symlinks left to resolve at install time.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const readPackageJson = (relative) => JSON.parse(readFileSync(join(here, relative), 'utf8'));

// The Agent SDK is the one dependency this package must DECLARE rather than inline (see the
// `external` note below), which means its version range is written down twice: once where the
// code imports it (session-runtime) and once where npm installs it (here). Nothing else keeps
// the two honest, and a silent divergence would ship users a different SDK than the one the
// bundled code was built and tested against — so the build refuses to produce a bundle until
// they match.
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const declaredRange = readPackageJson('../package.json').dependencies?.[SDK_PACKAGE];
const sourceRange = readPackageJson('../../session-runtime/package.json').dependencies?.[
  SDK_PACKAGE
];
if (declaredRange !== sourceRange) {
  process.stderr.write(
    `error: ${SDK_PACKAGE} version range differs between packages.\n` +
      `  session-runtime (imports it): ${sourceRange ?? '<absent>'}\n` +
      `  cctl-publish (installs it):   ${declaredRange ?? '<absent>'}\n` +
      'Make them identical, then rebuild.\n',
  );
  process.exit(1);
}

// Same class of hazard, second instance: the version a user sees from `cctl --version` is a
// constant in the CLI source, while the version npm actually publishes is this package's
// "version" field. Nothing linked them, and they HAD drifted — a 0.3.0 tarball packed cleanly
// while the bundle inside it still reported 0.2.2, which would have shipped a release that
// misreports itself and made the 'cli build' / 'daemon build' skew rows (see cli/src/settings.ts)
// lie about which build is running. Refuse to produce a bundle until they agree.
const publishedVersion = readPackageJson('../package.json').version;
const sourceVersion = /export const VERSION = '([^']+)'/.exec(
  readFileSync(join(here, '../../cli/src/settings.ts'), 'utf8'),
)?.[1];
if (publishedVersion !== sourceVersion) {
  process.stderr.write(
    'error: the published version and the version the CLI reports differ.\n' +
      `  cctl-publish/package.json (what npm publishes):      ${publishedVersion ?? '<absent>'}\n` +
      `  cli/src/settings.ts VERSION (what --version prints): ${sourceVersion ?? '<unparseable>'}\n` +
      'Make them identical, then rebuild.\n',
  );
  process.exit(1);
}

await build({
  entryPoints: [join(here, '../../cli/src/bin.ts')],
  outfile: join(here, '../dist/bin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node:sqlite is a builtin recent enough that esbuild otherwise treats the bare specifier
  // as an unresolvable npm package and fails the build; node-pty carries a native addon
  // esbuild cannot bundle. Neither is a direct dependency today, but excluding both up front
  // means a future one arriving transitively fails loudly in this build step, not silently at
  // runtime on a user's machine.
  //
  // The Agent SDK is external for a subtler reason: bundling its JavaScript SUCCEEDS but
  // produces a build that cannot run. The SDK does not implement Claude Code — it spawns a
  // ~250MB native CLI binary shipped as a separate per-platform package
  // (@anthropic-ai/claude-agent-sdk-<platform>-<arch>), which it locates at call time with
  // `createRequire(import.meta.url).resolve(...)` from its own module location. Inlined, that
  // location becomes this bundle, whose directory has no such sibling package, and the SDK
  // throws "Native CLI binary for <platform>-<arch> not found" the moment a session starts.
  // Left external, the specifier survives into the output, npm installs the real package tree
  // from the `dependencies` entry above, and the SDK resolves the binary from its own home as
  // designed. This is why the package has a dependency at all rather than shipping one file.
  external: ['node:sqlite', 'node-pty', SDK_PACKAGE],
  // Common Node/CJS interop shim: some bundled CommonJS dependencies reference `require`,
  // `__filename`, or `__dirname` even though nothing in this codebase calls them directly, and
  // plain ESM output has none of the three. pino in particular must stay configured
  // transport-free (no `transport:` option passed to `pino()`) — its worker-thread transports
  // resolve a module by string path at runtime, which only works against the real
  // node_modules layout the transport was written for, not a bundled file.
  banner: {
    js:
      "import { createRequire as __cctlCreateRequire } from 'node:module';\n" +
      "import { fileURLToPath as __cctlFileURLToPath } from 'node:url';\n" +
      "import { dirname as __cctlDirname } from 'node:path';\n" +
      'const require = __cctlCreateRequire(import.meta.url);\n' +
      'const __filename = __cctlFileURLToPath(import.meta.url);\n' +
      'const __dirname = __cctlDirname(__filename);\n',
  },
  logLevel: 'info',
});
