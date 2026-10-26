import crypto from 'node:crypto';
import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import {
  addDaysIso,
  applicationIdFor,
  db,
  expectNoHorizontalScroll,
  newContext,
  nowIso,
  signIn,
  uniqueStudentEmail,
  waitForEmail,
} from './helpers';
import { completeProfile, KE_CONTINUING_DOCS, uploadDocument } from './student-flow';

/**
 * NFR-TEST golden path, one continuous story across two browser contexts:
 * student submit (stories 1, 2) → staff targeted rejection (story 3) → student
 * fix → staff approve → packet (story 5) → sent → pass issued.
 * The student runs on the project's device (phone in the `mobile` project); staff always on desktop.
 */
test.setTimeout(15 * 60_000);

async function docStates(appId: string): Promise<Record<string, string>> {
  const r = await db().execute({ sql: 'SELECT doc_code, state FROM application_documents WHERE application_id = ? AND required = 1', args: [appId] });
  return Object.fromEntries(r.rows.map((x) => [String(x[0]), String(x[1])]));
}

async function appStatus(appId: string): Promise<string> {
  const r = await db().execute({ sql: 'SELECT status FROM applications WHERE id = ?', args: [appId] });
  return String(r.rows[0]![0]);
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`Condition not met in ${timeoutMs} ms; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Move the Review Mode cursor (N key) until the given document is shown. */
async function gotoDocInReviewMode(page: Page, docName: string): Promise<void> {
  const heading = page.locator('aside h2');
  for (let i = 0; i < 12; i++) {
    if ((await heading.textContent())?.trim() === docName) return;
    await page.keyboard.press('n');
    await page.waitForTimeout(150);
  }
  throw new Error(`Document ${docName} not found in Review Mode`);
}

test('golden path: submit → targeted rejection → fix → approve → packet → sent → pass issued', async ({ browser }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  const student = await newContext(browser, 'project', testInfo);
  const page = await student.newPage();
  const email = uniqueStudentEmail('golden');
  const tag = Date.now().toString(36).slice(-5).toUpperCase();
  const fullName = `Achieng ${tag} Otieno`;
  const studentNo = `CUU-E2E-${tag}`;

  // ---------------------------------------------------------------- student: sign in + profile
  await signIn(page, email, /\/profile/);
  await completeProfile(page, {
    fullName,
    studentNo,
    type: 'Continuing',
    country: 'Kenya',
    programme: 'BSc Computer Science',
    expiry: addDaysIso(45),
    months: 12,
  });

  // Story 1: continuing KE, expiry +45 d → 8 items, fee waived, 15 days runway.
  await expect(page.getByRole('heading', { level: 1, name: 'Your checklist' })).toBeVisible();
  await expect(page.getByText('Visa fee waived.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Visa runway' })).toContainText('You have 15 days to apply');
  await expect(page.locator('main ul > li h3')).toHaveCount(8);
  if (mobile) {
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: 'docs/screenshots/student-checklist-mobile.png', fullPage: true });
  }

  // ---------------------------------------------------------------- student: upload everything (real file input)
  for (const d of KE_CONTINUING_DOCS) {
    // fees_statement goes in as a PNG: story 2 (format-proof upload, converted to JPEG).
    await uploadDocument(page, d.code, d.pages, { png: d.code === 'fees_statement' });
    if (mobile && d.code === 'visa_status_page') await expectNoHorizontalScroll(page);
  }
  const appId = await applicationIdFor(email);
  expect(Object.values(await docStates(appId)).every((s) => s === 'uploaded')).toBe(true);

  // Story 2: the PNG upload is stored as a valid JPEG (fetched back through the authz'd file route).
  const fsVersion = await db().execute({
    sql: `SELECT v.id FROM document_versions v JOIN application_documents d ON d.id = v.application_document_id WHERE d.application_id = ? AND d.doc_code = 'fees_statement' AND v.superseded_at IS NULL`,
    args: [appId],
  });
  const fileRes = await page.request.get(`/api/files/${fsVersion.rows[0]![0]}?variant=original`, { timeout: 60_000 });
  expect(fileRes.status()).toBe(200);
  expect(fileRes.headers()['content-type']).toContain('image/jpeg');
  const jpg = await fileRes.body();
  expect([jpg[0], jpg[1], jpg[2]]).toEqual([0xff, 0xd8, 0xff]);

  // ---------------------------------------------------------------- student: review + submit
  await page.goto('/apply');
  await expect(page.getByText('8 of 8', { exact: false }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Review and submit' }).click();
  await page.waitForURL(/\/review$/);
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByLabel(/I confirm these are my original documents/).check();
  let since = nowIso();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await page.waitForURL(/\/status$/);
  const refEl = page.getByText(/VD-\d{4}-\d{5}/).first();
  await expect(refEl).toBeVisible();
  const ref = (await refEl.textContent())!.match(/VD-\d{4}-\d{5}/)![0];
  const receipt = await waitForEmail(email, (m) => m.kind === 'receipt', since);
  expect(receipt.subject + receipt.text).toContain(ref);
  if (mobile) await expectNoHorizontalScroll(page);

  // ---------------------------------------------------------------- staff: dashboard → detail → Review Mode
  const staffCtx = await newContext(browser, 'desktop', testInfo);
  const staff = await staffCtx.newPage();
  await signIn(staff, 'staff@cavendish.ac.ug', /\/dashboard/);
  await staff.getByRole('searchbox').or(staff.getByLabel(/search/i)).first().fill(ref);
  await staff.keyboard.press('Enter');
  const row = staff.getByRole('row').filter({ hasText: fullName });
  await expect(row).toBeVisible();
  if (!mobile) await staff.screenshot({ path: 'docs/screenshots/staff-dashboard.png' });
  await row.getByRole('link', { name: fullName }).first().click();
  await staff.waitForURL(new RegExp(`/applications/${appId}`));
  await staff.getByRole('link', { name: /^Open in Review mode \(\d+\)$/ }).click();
  await staff.waitForURL(/\/review-mode\?app=/);
  await expect(staff.getByText(/Document 1 of 8/)).toBeVisible();

  // Story 3: reject ONLY the passport data page for glare, by keyboard (R, pick reason, Enter); approve the rest (A).
  await gotoDocInReviewMode(staff, 'Passport data page');
  if (!mobile) await staff.screenshot({ path: 'docs/screenshots/review-mode.png' });
  await staff.keyboard.press('r');
  const firstReason = staff.getByRole('radio', { name: 'Image too blurry' });
  await expect(firstReason).toBeFocused();
  // Arrow keys move through the radio chips: blurry → … → glare is the 7th chip.
  for (let i = 0; i < 6; i++) await staff.keyboard.press('ArrowRight');
  await expect(staff.getByRole('radio', { name: 'Glare hides details' })).toBeChecked();
  await staff.keyboard.press('Enter');
  await expect(staff.getByText('Rejected: Passport data page')).toBeVisible();
  for (let i = 0; i < 7; i++) {
    await expect(staff.getByRole('button', { name: /^Approve/ })).toBeEnabled();
    await staff.keyboard.press('a');
    await staff.waitForTimeout(250);
  }
  // Undo window (8 s) passes, then every decision commits in order.
  const states = await waitFor(
    () => docStates(appId),
    (s) => Object.values(s).every((x) => x !== 'uploaded'),
    40_000,
  );
  expect(states.passport_data_page).toBe('rejected');
  expect(Object.entries(states).filter(([, v]) => v === 'rejected').map(([k]) => k)).toEqual(['passport_data_page']);
  await waitFor(() => appStatus(appId), (s) => s === 'corrections_needed');

  // One corrections email listing exactly that document + reason.
  const corrections = await waitForEmail(email, (m) => m.kind === 'corrections_needed', since);
  expect(corrections.text).toContain('Passport data page');
  expect(corrections.text).toContain('Glare hides details');
  for (const other of KE_CONTINUING_DOCS.filter((d) => d.code !== 'passport_data_page')) expect(corrections.text).not.toContain(other.name);

  // ---------------------------------------------------------------- student: sees exactly that item as Needs fixing
  await page.goto('/status');
  const fixSection = page.getByRole('region', { name: 'Needs fixing' }).or(page.locator('section[aria-labelledby="fix-title"]'));
  await expect(fixSection).toContainText('Passport data page');
  await expect(fixSection).toContainText('Glare hides details');
  await expect(fixSection.getByRole('listitem')).toHaveCount(1);
  await page.goto('/apply');
  const cards = page.locator('main ul > li');
  await expect(cards.filter({ hasText: 'Needs fixing' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Passport data page' })).toContainText('Needs fixing');
  await expect(cards.filter({ hasText: 'Approved' })).toHaveCount(7);
  // Only the rejected item is re-openable: approved cards are not links.
  await expect(page.locator('main ul > li a[href^="/documents/"]')).toHaveCount(1);

  // Re-upload → the application goes back to review automatically.
  since = nowIso();
  await cards.filter({ hasText: 'Passport data page' }).getByRole('link').first().click();
  await expect(page.getByRole('alert').filter({ hasText: 'The Dean of Students asked you to fix this' })).toBeVisible();
  await uploadDocument(page, 'passport_data_page', 1);
  await waitFor(() => appStatus(appId), (s) => s === 'under_review');

  // ---------------------------------------------------------------- staff: approve the fix, approve the application
  await staff.goto(`/review-mode?app=${appId}`);
  await expect(staff.locator('aside h2')).toHaveText('Passport data page');
  await expect(staff.getByRole('button', { name: /^Approve/ })).toBeEnabled();
  await staff.keyboard.press('a');
  await waitFor(() => docStates(appId), (s) => Object.values(s).every((x) => x === 'approved'), 30_000);
  await staff.goto(`/applications/${appId}`);
  await staff.getByRole('button', { name: 'Approve application' }).click();
  await expect(staff.getByText('Approved', { exact: true }).first()).toBeVisible();
  await waitFor(() => appStatus(appId), (s) => s === 'approved');
  await waitForEmail(email, (m) => m.kind === 'approved', since);

  // ---------------------------------------------------------------- staff: packet (story 5)
  const packetSection = staff.locator('#packet');
  await packetSection.getByRole('button', { name: 'Generate packet' }).click();
  await expect(packetSection.getByRole('link', { name: 'Download ZIP' }).first()).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([staff.waitForEvent('download'), packetSection.getByRole('link', { name: 'Download ZIP' }).first().click()]);
  const zipPath = testInfo.outputPath('packet.zip');
  await download.saveAs(zipPath);
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const names = Object.keys(files).sort();
  const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as { files: { name: string; sha256: string; bytes: number }[] };
  const jpgs = names.filter((n) => n.endsWith('.jpg'));
  expect(jpgs).toHaveLength(9); // 8 documents, admission letter has 2 pages
  expect(names).toContain('cover_sheet.pdf');
  const safeNo = studentNo.replace(/[^A-Za-z0-9-]/g, '-');
  jpgs.forEach((n, i) => expect(n).toMatch(new RegExp(`^${String(i + 1).padStart(2, '0')}_[a-z_]+_Otieno_${safeNo}\\.jpg$`)));
  expect(jpgs[0]).toContain('visa_status_page');
  expect(jpgs[1]).toContain('passport_data_page');
  expect(jpgs.filter((n) => n.includes('admission_letter'))).toHaveLength(2);
  for (const f of manifest.files) {
    const bytes = files[f.name];
    expect(bytes, `manifest entry ${f.name} is in the ZIP`).toBeTruthy();
    expect(crypto.createHash('sha256').update(bytes!).digest('hex')).toBe(f.sha256);
    expect(bytes!.byteLength).toBe(f.bytes);
  }
  expect(manifest.files.map((f) => f.name).sort()).toEqual([...jpgs, 'cover_sheet.pdf'].sort());

  // ---------------------------------------------------------------- staff: mark sent → pass issued
  await staff.getByRole('button', { name: 'Mark sent to immigration' }).first().click();
  const sentDialog = staff.getByRole('dialog', { name: 'Mark sent to immigration' });
  await sentDialog.getByRole('button', { name: 'Mark sent to immigration' }).click();
  await waitFor(() => appStatus(appId), (s) => s === 'sent_to_immigration');
  await staff.reload();
  const newExpiry = addDaysIso(365);
  await staff.getByRole('button', { name: 'Record pass issued' }).click();
  const passDialog = staff.getByRole('dialog', { name: 'Record pass issued' });
  await passDialog.getByLabel('New pass expiry date').fill(newExpiry);
  await passDialog.getByRole('button', { name: 'Record pass issued' }).click();
  await waitFor(() => appStatus(appId), (s) => s === 'pass_issued');
  await waitForEmail(email, (m) => m.kind === 'pass_issued', since);

  // Student sees the final state.
  await page.goto('/status');
  await expect(page.getByText('Your new pass is ready.', { exact: false })).toBeVisible();

  await staffCtx.close();
  await student.close();
});
