import { createClient, type Client } from '@libsql/client';
import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { E2E_BASE_URL, E2E_DB_URL } from './env';

/**
 * Shared e2e helpers. Codes and emails come from the DevOutbox table (the app
 * sends no real email without RESEND_API_KEY); we read it with the libSQL
 * client directly, read-only, from the dedicated e2e database.
 */
let client: Client | null = null;
export function db(): Client {
  client ??= createClient({ url: E2E_DB_URL });
  return client;
}

export interface OutboxRow {
  id: string;
  to: string;
  subject: string;
  text: string;
  kind: string;
  createdAt: string;
}

export async function outboxFor(email: string, sinceIso = '1970-01-01'): Promise<OutboxRow[]> {
  const r = await db().execute({
    sql: 'SELECT id, "to", subject, text, kind, created_at FROM outbox WHERE lower("to") = lower(?) AND created_at >= ? ORDER BY created_at DESC',
    args: [email, sinceIso],
  });
  return r.rows.map((row) => ({
    id: String(row[0]),
    to: String(row[1]),
    subject: String(row[2]),
    text: String(row[3]),
    kind: String(row[4]),
    createdAt: String(row[5]),
  }));
}

/** Wait for an email to `email` matching `match` (created after `sinceIso`). */
export async function waitForEmail(email: string, match: (m: OutboxRow) => boolean, sinceIso = '1970-01-01', timeoutMs = 20_000): Promise<OutboxRow> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await outboxFor(email, sinceIso);
    const hit = rows.find(match);
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`No email to ${email} matching after ${timeoutMs} ms. Got: ${rows.map((x) => x.subject).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function latestCode(email: string, sinceIso: string): Promise<string> {
  const m = await waitForEmail(email, (x) => /\b\d{6}\b/.test(x.text), sinceIso);
  return /\b(\d{6})\b/.exec(m.text)![1]!;
}

/** A unique fake client IP per context, so the per-IP OTP limits don't couple tests. */
let ipCounter = 0;
export function uniqueIp(): string {
  ipCounter++;
  const n = (Date.now() % 200) + ipCounter;
  return `10.${(n >> 8) & 255}.${n & 255}.${(process.pid % 250) + 1}`;
}

export function nowIso(): string {
  // Small safety margin for clock rounding between processes.
  return new Date(Date.now() - 2000).toISOString();
}

export async function newContext(browser: Browser, kind: 'desktop' | 'project', testInfo: TestInfo): Promise<BrowserContext> {
  const base = kind === 'desktop' ? { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false } : testInfo.project.use;
  return browser.newContext({
    ...(kind === 'project' ? { viewport: base.viewport, isMobile: base.isMobile, hasTouch: base.hasTouch, userAgent: base.userAgent, deviceScaleFactor: base.deviceScaleFactor } : base),
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { 'x-forwarded-for': uniqueIp() },
  });
}

/** Full OTP sign-in through the real UI. Returns after landing on the role home. */
export async function signIn(page: Page, email: string, expectPath: RegExp): Promise<void> {
  const since = nowIso();
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForURL(/\/verify/);
  const code = await latestCode(email, since);
  await typeCode(page, code);
  await page.waitForURL(expectPath, { timeout: 120_000 });
}

export async function typeCode(page: Page, code: string): Promise<void> {
  const first = page.getByRole('textbox', { name: 'Digit 1 of 6' });
  await first.click();
  // Auto-advance + auto-submit on the 6th digit (no extra click: a second verify would burn the code).
  await page.keyboard.type(code, { delay: 25 });
}

export function uniqueStudentEmail(tag: string): string {
  return `e2e.${tag}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@cavendish.ac.ug`;
}

/** No horizontal page scroll at the current viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(r.sw, `scrollWidth ${r.sw} > clientWidth ${r.cw} on ${page.url()}`).toBeLessThanOrEqual(r.cw + 1);
}

export async function applicationIdFor(email: string): Promise<string> {
  const r = await db().execute({
    sql: `SELECT a.id FROM applications a JOIN profiles p ON p.id = a.student_id WHERE lower(p.email) = lower(?) ORDER BY a.created_at DESC LIMIT 1`,
    args: [email],
  });
  return String(r.rows[0]![0]);
}

export function addDaysIso(days: number): string {
  // Kampala is UTC+3 with no DST.
  const d = new Date(Date.now() + 3 * 3600_000 + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}
