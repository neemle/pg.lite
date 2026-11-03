// Browser tests (rulebook 702.5): every test records a Full HD video, the run writes an HTML report, step screenshots are attached by
// the helpers in ui.ts, and a failed test keeps an execution trace. Everything lands in tools/reports/browser (BROWSER_REPORT_DIR
// overrides it): report/ the HTML report, results/ the video, trace and screenshots of every test.
import { defineConfig } from '@playwright/test';
import path from 'node:path';

const reports = process.env['BROWSER_REPORT_DIR'] ?? path.resolve(__dirname, '..', '..', '..', 'reports', 'browser');
const FULL_HD = { width: 1920, height: 1080 };

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  timeout: 240000,
  workers: 1,
  outputDir: path.join(reports, 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(reports, 'report'), open: 'never' }]],
  use: {
    browserName: 'chromium',
    viewport: FULL_HD,
    video: { mode: 'on', size: FULL_HD },
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
});
