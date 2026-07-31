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
    // Vitest's 5s default is too tight for this suite, which spawns real node subprocesses,
    // shells out to PowerShell, and binds real loopback servers rather than mocking any of it.
    // Several tests already sat within a few hundred milliseconds of the default and began
    // failing intermittently — never on an assertion, always on the deadline — once the suite
    // grew. A longer ceiling cannot mask a real failure (a genuinely hung test still fails, just
    // later); it only stops the timer from beating the work under parallel load.
    testTimeout: 20_000,
  },
});
