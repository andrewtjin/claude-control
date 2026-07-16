import { defineConfig } from 'vitest/config';

// One flat root config covers the whole workspace: `pnpm test` scans every package's
// colocated `*.test.ts`. To scope to a single package, pass a path filter, e.g.
// `npx vitest run packages/switch-engine`. Tests are colocated with source (not a
// separate projects tree), so a flat include is simpler and correct here.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Credential shell-outs (DPAPI) and native node:sqlite handles are process-global;
    // keep files isolated in forks so one test's env/fs state can't leak into another.
    pool: 'forks',
  },
});
