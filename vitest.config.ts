import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',

    // RLS is a database behavior and the suite provisions a database per
    // run (AD-11). Parallel files would race on role and database creation,
    // so the suite is serial by default. Slower, and correct.
    fileParallelism: false,

    // T-05 is a blocking precondition, not merely a test: if the app role
    // is superuser, owns the RLS tables, or FORCE ROW LEVEL SECURITY is
    // missing, every other isolation result is meaningless. Bail so a
    // vacuous green is never reported.
    bail: 1,

    // A real Postgres round-trip is slower than a mock. This is the cost
    // of testing the thing that actually enforces isolation.
    testTimeout: 30_000,
    hookTimeout: 60_000,

    setupFiles: [],
  },
});
