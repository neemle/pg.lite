import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  timeout: 120000,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium' },
});
