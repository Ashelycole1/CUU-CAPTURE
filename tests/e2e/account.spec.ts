import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { applicationIdFor, db, newContext, signIn, uniqueStudentEmail } from './helpers';

/**
 * FR-AUD-3 / SECURITY §6: a student with only a draft asks for account deletion from
 * /status ("Your data"); the draft is withdrawn, the request is pending, /apply no longer
 * starts a new draft, and the student can cancel. Admin approval is unit-tested.
 */
test('student can request and cancel account deletion', async ({ browser }, testInfo) => {
  const ctx = await newContext(browser, 'project', testInfo);
  const page = await ctx.newPage();
  const email = uniqueStudentEmail('delete');
  await signIn(page, email, /\/profile/);
  const draftId = await applicationIdFor(email);

  await page.goto('/status');
  const section = page.getByRole('region', { name: 'Your data' });
  await section.getByRole('button', { name: 'Delete my account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Your unsubmitted draft application will be withdrawn.');
  const axe = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await dialog.getByRole('button', { name: 'Yes, ask to delete my account' }).click();

  await expect(section.getByRole('status')).toContainText('You asked for your account to be deleted');
  const r = await db().execute({ sql: 'SELECT status FROM applications WHERE id = ?', args: [draftId] });
  expect(String(r.rows[0]![0])).toBe('withdrawn');
  const req = await db().execute({
    sql: `SELECT d.status FROM deletion_requests d JOIN profiles p ON p.id = d.profile_id WHERE lower(p.email) = lower(?)`,
    args: [email],
  });
  expect(req.rows.map((x) => String(x[0]))).toEqual(['pending']);

  // No new draft while the request is pending.
  await page.goto('/apply');
  await page.waitForURL(/\/status$/);

  await section.getByRole('button', { name: 'Cancel my request' }).click();
  await expect(section.getByRole('button', { name: 'Delete my account' })).toBeVisible();
  await ctx.close();
});
