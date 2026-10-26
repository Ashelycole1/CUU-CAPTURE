import { expect, type Page } from '@playwright/test';
import { makeDocImage, PASSPORT_LIKE } from './fixtures';

export const KE_CONTINUING_DOCS = [
  { code: 'visa_status_page', name: 'Current visa status page', pages: 1 },
  { code: 'passport_data_page', name: 'Passport data page', pages: 1 },
  { code: 'passport_photos', name: 'Passport photos', pages: 1 },
  { code: 'student_id_face', name: 'Face of student ID card', pages: 1 },
  { code: 'proof_of_registration', name: 'Current Proof of Registration form', pages: 1 },
  { code: 'admission_letter', name: 'Acceptance / admission letter (pages 1 and 2)', pages: 2 },
  { code: 'fees_statement', name: 'Tuition/fees statement', pages: 1 },
  { code: 'exam_results', name: 'Stamped exam results, last semester', pages: 1 },
] as const;

export interface ProfileInput {
  fullName: string;
  studentNo: string;
  phone?: string;
  type: 'New' | 'Continuing' | 'Masters';
  country: string;
  programme: string;
  expiry: string; // YYYY-MM-DD
  months: 3 | 6 | 12;
}

/** The 3-step profile wizard, driven like a person would (labels, keyboard for the combobox). */
export async function completeProfile(page: Page, p: ProfileInput): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'About you' })).toBeVisible();
  await page.getByLabel('Full name (as in your passport)').fill(p.fullName);
  await page.getByLabel('Student number').fill(p.studentNo);
  await page.getByLabel('Phone (optional)').fill(p.phone ?? '+256 700 123456');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { level: 2, name: /Your studies/ })).toBeVisible();
  await page.getByText(p.type, { exact: true }).click();
  const combo = page.getByRole('combobox', { name: 'Nationality' });
  await combo.fill(p.country);
  await page.getByRole('option', { name: new RegExp(p.country) }).first().click();
  await page.getByRole('textbox', { name: 'Programme' }).fill(p.programme);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { level: 2, name: /Your pass/ })).toBeVisible();
  await page.getByLabel('When does your current pass or visa expire?').fill(p.expiry);
  await page.getByText(`${p.months} months`, { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.getByRole('button', { name: 'See my checklist' }).click();
  await page.waitForURL(/\/apply$/);
}

/** Upload one page through the REAL file input of the Scan Coach. */
export async function uploadThroughScanCoach(page: Page, code: string, opts: { png?: boolean; slot?: number } = {}): Promise<void> {
  const fx = await makeDocImage(`${code} p${opts.slot ?? 1}`, { landscape: PASSPORT_LIKE.has(code), format: opts.png ? 'png' : 'jpeg' });
  // The live-camera button renders only after hydration: a reliable 'handlers attached' signal.
  await expect(page.getByRole('button', { name: 'Use live camera' })).toBeVisible();
  await page.locator('input[type="file"]:not([capture])').setInputFiles(fx.path);
  await expect(page.getByRole('heading', { name: 'Quality check' })).toBeVisible({ timeout: 30_000 });
  // A clean fixture passes every check, so the primary button is "Use this scan" (not "Use anyway").
  await page.getByRole('button', { name: 'Use this scan' }).click();
}

export async function uploadDocument(page: Page, code: string, pages: number, opts: { png?: boolean } = {}): Promise<void> {
  await page.goto(`/documents/${code}`);
  for (let slot = 1; slot <= pages; slot++) {
    await uploadThroughScanCoach(page, code, { png: opts.png, slot });
    if (slot < pages) await expect(page.getByText(`Add page ${slot + 1}`, { exact: true })).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByText(pages > 1 ? 'All pages uploaded.' : 'Uploaded. Nice work.').first()).toBeVisible({ timeout: 30_000 });
}
