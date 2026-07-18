#!/usr/bin/env node
// Bundles the cctl CLI into one publishable file. The entry point is the *source*
// packages/cli/src/bin.ts, not that package's own tsc output — esbuild transpiles TypeScript
// itself, and bundling from source lets it inline every `@claude-control/*` workspace import
// (resolved through each package's "main", so run `pnpm run build` first so those dist/
// folders exist) into a single dist/bin.js with no workspace symlinks left to resolve at
// install time.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

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
  external: ['node:sqlite', 'node-pty'],
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
