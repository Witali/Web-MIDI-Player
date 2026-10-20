import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/ui',
  testMatch: '**/*.spec.mjs',
  outputDir: './.cache/playwright',
  forbidOnly: Boolean(process.env.CI),
  workers: 3,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'narrow', use: { viewport: { width: 375, height: 667 } } },
    { name: 'short', use: { viewport: { width: 844, height: 390 } } },
  ],
});
