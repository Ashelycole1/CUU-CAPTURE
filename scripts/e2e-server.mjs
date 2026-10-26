/**
 * Starts the app for Playwright: resets a DEDICATED database under ./data-e2e
 * (never ./data), seeds dev users, then runs `next dev` on port 3000.
 * Used by playwright.config.ts (webServer) and runnable by hand: `npm run e2e:server`.
 */
import { spawn, spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR || './data-e2e',
  DATABASE_URL: process.env.DATABASE_URL || 'file:./data-e2e/visadesk.db',
  APP_URL: process.env.APP_URL || 'http://localhost:3000',
  // Never send real email from e2e.
  RESEND_API_KEY: '',
  BLOB_READ_WRITE_TOKEN: '',
  CRON_SECRET: process.env.CRON_SECRET || 'e2e-cron-secret-0123456789',
  NEXT_TELEMETRY_DISABLED: '1',
};
if (!env.DATABASE_URL.startsWith('file:') || !env.DATA_DIR.includes('e2e')) {
  console.error('[e2e-server] refusing to reset a non-e2e database');
  process.exit(1);
}

const shell = process.platform === 'win32';
const reset = spawnSync('npm', ['run', 'db:reset'], { env, stdio: 'inherit', shell });
if (reset.status !== 0) process.exit(reset.status ?? 1);

const port = process.env.PORT || '3000';
const child = spawn('npx', ['next', 'dev', '--port', port], { env, stdio: 'inherit', shell });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
