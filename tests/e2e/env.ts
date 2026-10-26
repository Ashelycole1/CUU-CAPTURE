/** Shared constants for the Playwright suite (kept in sync with scripts/e2e-server.mjs). */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATA_DIR = './data-e2e';
export const E2E_DB_URL = 'file:./data-e2e/visadesk.db';
export const E2E_ENV = {
  DATA_DIR: E2E_DATA_DIR,
  DATABASE_URL: E2E_DB_URL,
  APP_URL: E2E_BASE_URL,
};
