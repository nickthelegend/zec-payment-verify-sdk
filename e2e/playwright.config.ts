import { defineConfig } from '@playwright/test';

// Real Google Chrome (channel: 'chrome') against the real Hanko stack from ./stack.sh. Nothing is
// mocked or routed: the verify API runs zpay-verify against live testnet lightwalletd with the
// published viewing keys, the null-402 tab reads Avalanche Fuji from the browser, and the paywall
// checks the published mined payments.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    channel: 'chrome',
    headless: true,
    video: 'on',
    trace: 'on',
    screenshot: 'on',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    // The paywall spec presents the one published payment to one paywall store, so it runs once (desktop).
    { name: 'mobile', testIgnore: /paywall\.spec/, use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});
