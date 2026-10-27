const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  timeout: 120000,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium' },
});
