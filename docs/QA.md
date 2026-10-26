# QA

How VisaDesk is tested, how to run the tests, and what is not covered yet.

## 1. Test layers

| Layer | Tool | Where | Runs in CI |
|---|---|---|---|
| Unit + integration (services, rules, state machine, jobs, routes, server actions) | Vitest, temp SQLite files, local encrypted blobs | `tests/{unit,integration,student,staff,jobs,admin}` | `check` job |
| End-to-end golden paths, real browser | Playwright (Chromium) against `next dev` | `tests/e2e/golden.spec.ts` | `e2e` job |
| Accessibility, real browser | `@axe-core/playwright` (WCAG 2.0/2.1 A + AA) plus keyboard checks | `tests/e2e/a11y.spec.ts` | `e2e` job |
| Account deletion request (FR-AUD-3), real browser | Playwright | `tests/e2e/account.spec.ts` | `e2e` job |

Both Playwright specs run in two projects: **desktop** (1280×800 Chrome) and **mobile** (Pixel 7 at 360×780). Staff screens are desktop-only (design §7), so the staff a11y test skips itself on mobile. The golden test always runs the staff half on a desktop context.

## 2. What the e2e suite covers

### Golden path (`golden.spec.ts`, one continuous story in two browser contexts)
1. **Student sign-in by OTP** through the real UI. The code is read from the dev outbox, because no email is sent without `RESEND_API_KEY`.
2. **Profile wizard**: 3 steps with autosave, a nationality combobox and the pass expiry.
3. **Story 1**: continuing student from Kenya with expiry in 45 days → 8 checklist items, fee waived, "You have 15 days to apply".
4. **Uploads through the real Scan Coach file input** for all 8 documents (9 pages; the admission letter has 2). Fixtures are synthetic document photos that pass every quality check.
5. **Story 2**: a PNG is converted and stored as a real JPEG, verified through the authorised file route.
6. **Submit** → reference `VD-YYYY-NNNNN` and a receipt email that contains it.
7. **Staff**: dashboard search by ref → detail → Review Mode.
8. **Story 3, keyboard only**: `R` and arrow keys pick "Glare hides details" for the passport page, then `A` × 7 approves the rest. After the 8 s undo window, exactly one document is `rejected`, the status is `corrections_needed`, and one corrections email names only that document and reason.
9. **Student fix**: "Needs fixing" on `/status` lists exactly one item. Approved cards are not links. Re-uploading puts the application back to `under_review` automatically.
10. **Staff approve**: approve the fixed document, then approve the application → approval email.
11. **Story 5 packet**: generate and download the ZIP. Checks 9 JPGs plus `cover_sheet.pdf`, `NN_doc_Surname_StudentNo.jpg` naming in checklist order, and a `manifest.json` whose SHA-256 and byte counts match every file.
12. **Mark sent to immigration → record pass issued** → email. The student sees "Your new pass is ready."
13. **Mobile only**: no horizontal scroll on the checklist, document, review and status screens.

### Accessibility (`a11y.spec.ts`)
- axe on: login, verify, profile wizard, checklist, Scan Coach, review, status and messages (student); dashboard, application detail, Review Mode, the Review Mode reject chips and packets (staff).
- The skip link is the first Tab stop, is visible when focused, and moves focus to `<main>` (login, checklist, dashboard).
- The reject chips get focus when you press `R` (keyboard path).
- Violations are attached to the report as `axe-<screen>.json`. The test fails on any violation.

### Account deletion (`account.spec.ts`)
- A student who has only a draft opens `/status` → "Your data" → "Delete my account". The confirm dialog passes axe and warns that the draft will be withdrawn. After confirming, the draft is `withdrawn` and the request is `pending`. `/apply` then redirects to `/status` instead of starting a new draft. Cancelling brings back the button.

### Fixed during this QA pass
- Light-theme text colours were below 4.5:1 on tinted status chips and on paper: `--ok`, `--warn`, `--info`, `--risk-safe`, `--risk-plan` and `--risk-urgent` were darkened (`src/app/globals.css`). Dark theme is unchanged.
- `/review`: the details `<dl>` held `div > div` and `div > a`. It now holds only dt/dd groups.
- Staff detail: 8 "Open in Review mode" links had the same name. Each now includes its document name (sr-only).
- Staff dashboard: the chevron column header read "Close". It now reads "Open application".
- Skip link: student and auth `<main>` were not focusable (`tabIndex={-1}` added, as staff/admin already had).
- Scan Coach: a hydration mismatch from reading `navigator` during render. It now uses `useSyncExternalStore` with a server snapshot.
- Dialog footers wrap on narrow phones.

## 3. How to run

```bash
npm run typecheck && npm run lint && npm test     # unit + integration
npx playwright install chromium                    # once
npm run test:e2e                                   # starts the e2e server itself
```

- `npm run test:e2e` starts `scripts/e2e-server.mjs` when nothing is listening on :3000. That script **resets a dedicated database in `./data-e2e`** (it refuses any other path), seeds the dev users and runs `next dev --port 3000`. It never touches `./data`.
- For quicker reruns, keep a server running in another terminal with `npm run e2e:server`. Playwright reuses it locally, and each test makes its own unique student, so you don't need to reset between runs.
- Global setup warms every route first, because `next dev` compiles each route on its first request (10–40 s on a slow disk). Set `E2E_SKIP_WARMUP=1` to skip this when the server is already warm.
- One project or file: `npx playwright test golden --project=desktop`. Report: `npx playwright show-report`.
- Timing: on the development laptop, the golden path takes about 6–8 min per project and the a11y spec about 4 min. Most of that is dev-mode compilation and the 8 s undo windows.

## 4. Screenshots

`docs/screenshots/` is written by the e2e run:

| File | Screen |
|---|---|
| `student-checklist-mobile.png` | Checklist with Runway, 360 px (golden, mobile) |
| `staff-dashboard.png` | Dashboard search result (golden, desktop) |
| `review-mode.png` | Review Mode on the passport page (golden, desktop) |
| `login-{desktop,mobile}.png` | Sign-in |
| `student-profile-*.png`, `student-scan-coach-*.png`, `student-review-*.png`, `student-status-*.png` | Student screens |
| `staff-application-detail-desktop.png` | Staff detail with documents, Runway, actions and timeline |

## 5. CI

`.github/workflows/ci.yml` → job **`e2e`** (needs `check`). It installs Chromium (cached), runs `npm run test:e2e` with `CI=true` (a fresh server, 1 retry, GitHub reporter) and uploads `playwright-report/` and `test-results/` when it fails. It needs no secrets.

## 6. Known gaps

- **No real devices or real photos.** Scan Coach thresholds (blur/glare/brightness) are tested with synthetic images. They still need tuning on real Android phones in Kampala lighting (DECISIONS SU-02). Camera capture (`capture` input, live camera) is not exercised. Only the file input is.
- **HEIC and multi-page PDF imports** are not covered end to end (unit-level only).
- **Offline/resume** (IndexedDB upload queue, `online` event) has no e2e test.
- **Admin screens** (`/rules`, `/retention`, `/staff`, `/audit`, `/analytics`, `/templates`) have unit/integration tests but no e2e or axe scan.
- **Account deletion**: the e2e test covers request and cancel. Admin approval on `/retention` (the purge) is unit-tested only.
- **Production build** is not what e2e runs against (`next dev` only). The perf work covers `next build`/`next start` separately.
- **Firefox/Safari (WebKit)** are not in the matrix. Students on iPhones should get a manual pass.
- **Screen readers**: axe catches markup problems, not the listening experience. A manual pass with TalkBack (Android) and NVDA (staff PCs) is still needed.
- **Email rendering** is checked only as text in the outbox, not in real mail clients.
- **Bounces**: the "Student unreachable" badge needs `RESEND_WEBHOOK_SECRET` and the webhook configured in Resend. It is unit-tested only.
- **Runway labels overlap in narrow columns.** When "apply by" is today, the TODAY / APPLY BY / EXPIRY date labels collide in the 20rem left column of the staff detail page (see `staff-application-detail-desktop.png`). This is a layout bug in `components/runway/runway.tsx` and is not fixed yet.
- **Dev-server flakiness on small machines.** On the 8 GB development laptop, `next dev` sometimes stalls on recompiles when free memory runs low (for example with "Saving decision…" stuck in Review Mode) or when source files change during a run. A rerun on a fresh server passes. CI uses one retry.

## 7. Last run (2026-10-26, Wave 3)

- `npm run typecheck`, `npm run lint`: clean.
- `npm test`: 27 files passed, 1 skipped; 286 tests passed, 13 skipped.
- `npm run test:e2e`: desktop 4/4 passed (golden, a11y student, a11y staff, account). Mobile: account passed in the full run, and golden plus a11y student passed in a rerun on a fresh server after a memory-pressure stall (a11y staff is skipped on mobile by design).
