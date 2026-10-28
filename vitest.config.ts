import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // src/config/env.ts exits the process when these are missing, which killed any test importing a controller.
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
      JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-test-secret-test-secret-0',
    },
  },
});
