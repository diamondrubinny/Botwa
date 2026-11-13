import { defineConfig } from 'vitest/config';

// Test files share one database and reset its schema, so they must not run in parallel.
export default defineConfig({ test: { fileParallelism: false } });
