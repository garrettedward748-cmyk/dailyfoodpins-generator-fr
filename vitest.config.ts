import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A single forked process: src/db/index.ts holds a module-level database
    // handle, so suites must not run in parallel workers against it.
    pool: 'forks',
    isolate: true,
  },
});
