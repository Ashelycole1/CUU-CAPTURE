import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_ENV, E2E_PORT } from './tests/e2e/env';

/**
 * Playwright e2e (NFR-TEST golden paths). The web server resets a dedicated
 * database under ./data-e2e (never ./data), seeds the dev users and starts
 * `next dev` on port 3000. Codes and emails are read from the DevOutbox table.
 *
 * Locally an already running server on :3000 is reused (start it with
 * `npm run e2e:server`); tests use unique students per run, so they are rerunnable
 * without a reset. CI always starts a fresh server.
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: false,
  // One dev server and one SQLite file: keep it to a single worker for determinism.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      // Student flows on a small Android phone. Staff/admin specs skip themselves here.
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } },
    },
  ],
  webServer: {
    command: 'npm run e2e:server',
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { ...E2E_ENV, PORT: String(E2E_PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
