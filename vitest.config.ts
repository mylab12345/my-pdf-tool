import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
    setupFiles: ['tests/renderer/setup.ts'],
    environmentMatchGlobs: [
      ['tests/renderer/**', 'jsdom'],
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/core/**', 'src/shared/**', 'src/main/**'],
    },
  },
});
