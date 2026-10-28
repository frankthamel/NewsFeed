import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      DATABASE_URL: 'postgres://newsfeed:newsfeed@localhost:5432/newsfeed_test',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      NODE_ENV: 'test',
    },
  },
});
