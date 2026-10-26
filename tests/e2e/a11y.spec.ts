import fs from 'node:fs';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { docJpegBytes } from './fixtures';
import { addDaysIso, applicationIdFor, latestCode, newContext, nowIso, signIn, typeCode, uniqueStudentEmail } from './helpers';
import { completeProfile, KE_CONTINUING_DOCS } from './student-flow';

/**
 * NFR-A11Y: axe-core (WCAG 2.0/2.1 A + AA) on every main student and staff screen,
 * plus keyboard basics (skip link, visible focus). Also saves the screenshots in
 * docs/screenshots/. Documents are uploaded through the API here (the golden path
 * already drives the Scan Coach UI) so this spec stays fast.
 */
test.setTimeout(10 * 60_000);

const SHOTS = 'docs/screenshots';

async function axe(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // Let client components hydrate and fonts settle before scanning.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // After a client-side navigation the <title> is applied a moment after the content.
  await expect(page).toHaveTitle(/\S/);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n').slice(1, 3).join(' ')}`),
  }));
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
  expect.soft(summary, `axe violations on ${name} (${page.url()})`).toEqual([]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${testInfo.project.name}.png`, fullPage: true });
}

/** Tab once from the top: the first stop is the skip link, it is visible, and it moves focus to <main>. */
async function expectSkipLink(page: Page): Promise<void> {
  // Fresh load so the sequential focus starting point is the top of the document.
  await page.goto(page.url());
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
}

async function uploadViaApi(page: Page, applicationId: string, docCode: string, slot: number): Promise<void> {
  const bytes = await docJpegBytes(`${docCode} ${slot}`, Date.now() + slot);
  const res = await page.request.post(`/api/uploads?applicationId=${applicationId}&docCode=${docCode}&slot=${slot}`, {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      applicationId,
      docCode,
      slot: String(slot),
      file: { name: `${docCode}_${slot}.jpg`, mimeType: 'image/jpeg', buffer: bytes },
    },
    timeout: 60_000,
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

test('student screens are accessible', async ({ browser }, testInfo) => {
  const ctx = await newContext(browser, 'project', testInfo);
  const page = await ctx.newPage();
  const email = uniqueStudentEmail('a11y');
  const tag = Date.now().toString(36).slice(-5).toUpperCase();

  // Sign-in screens.
  await page.goto('/login');
  await axe(page, testInfo, 'login');
  await expectSkipLink(page);
  await shot(page, testInfo, 'login');
  const since = nowIso();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForURL(/\/verify/);
  await axe(page, testInfo, 'verify');
  await typeCode(page, await latestCode(email, since));
  await page.waitForURL(/\/profile/, { timeout: 120_000 });

  // Profile wizard (step 1), then the rest via the shared helper.
  await expect(page.getByRole('heading', { level: 1, name: 'About you' })).toBeVisible();
  await axe(page, testInfo, 'profile');
  await shot(page, testInfo, 'student-profile');
  await completeProfile(page, {
    fullName: `Amina ${tag} Hassan`,
    studentNo: `CUU-A11Y-${tag}`,
    type: 'Continuing',
    country: 'Kenya',
    programme: 'BA Journalism',
    expiry: addDaysIso(40),
    months: 12,
  });

  await axe(page, testInfo, 'checklist');
  await expectSkipLink(page);
  await page.goto('/documents/passport_data_page');
  await expect(page.getByRole('button', { name: 'Use live camera' })).toBeVisible();
  await axe(page, testInfo, 'scan-coach');
  await shot(page, testInfo, 'student-scan-coach');

  const appId = await applicationIdFor(email);
  for (const d of KE_CONTINUING_DOCS) for (let s = 1; s <= d.pages; s++) await uploadViaApi(page, appId, d.code, s);

  await page.goto('/review');
  await expect(page.getByRole('button', { name: 'Submit application' })).toBeVisible();
  await axe(page, testInfo, 'review');
  await shot(page, testInfo, 'student-review');
  await page.getByLabel(/I confirm these are my original documents/).check();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await page.waitForURL(/\/status$/);
  await expect(page.getByText(/VD-\d{4}-\d{5}/).first()).toBeVisible();
  await axe(page, testInfo, 'status');
  await shot(page, testInfo, 'student-status');

  await page.goto('/messages');
  await axe(page, testInfo, 'messages');
  await ctx.close();
});

test('staff screens are accessible', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Staff screens are desktop-first (design §7).');
  // Make sure there is at least one submitted application to look at.
  const studentCtx = await newContext(browser, 'desktop', testInfo);
  const sp = await studentCtx.newPage();
  const email = uniqueStudentEmail('a11ystaff');
  const tag = Date.now().toString(36).slice(-5).toUpperCase();
  await signIn(sp, email, /\/profile/);
  await completeProfile(sp, {
    fullName: `Brian ${tag} Mwangi`,
    studentNo: `CUU-A11S-${tag}`,
    type: 'Continuing',
    country: 'Kenya',
    programme: 'BSc Nursing',
    expiry: addDaysIso(20),
    months: 6,
  });
  const appId = await applicationIdFor(email);
  for (const d of KE_CONTINUING_DOCS) for (let s = 1; s <= d.pages; s++) await uploadViaApi(sp, appId, d.code, s);
  await sp.goto('/review');
  await sp.getByLabel(/I confirm these are my original documents/).check();
  await sp.getByRole('button', { name: 'Submit application' }).click();
  await sp.waitForURL(/\/status$/);
  await studentCtx.close();

  const ctx = await newContext(browser, 'desktop', testInfo);
  const page = await ctx.newPage();
  await signIn(page, 'staff@cavendish.ac.ug', /\/dashboard/);
  await axe(page, testInfo, 'dashboard');
  await expectSkipLink(page);

  await page.goto(`/applications/${appId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Mwangi');
  await axe(page, testInfo, 'application-detail');
  await shot(page, testInfo, 'staff-application-detail');

  await page.goto(`/review-mode?app=${appId}`);
  await expect(page.getByText(/Document 1 of 8/)).toBeVisible();
  await axe(page, testInfo, 'review-mode');
  // Reject dialog/chips (keyboard path) are part of the review surface.
  await page.keyboard.press('r');
  await expect(page.getByRole('radio', { name: 'Image too blurry' })).toBeFocused();
  await axe(page, testInfo, 'review-mode-reject');
  await page.keyboard.press('Escape');

  await page.goto('/packets');
  await axe(page, testInfo, 'packets');
  await ctx.close();
});
