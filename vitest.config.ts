import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts', 'test/**/*.test.mjs'], maxWorkers: 1, restoreMocks: true } });
