# VisaDesk — Product Requirements Document (PRD)

Read `concept.md` first (why), then this file (what), then `architecture.md` (how) and `design.md` (look and feel).

## 0. Instructions for Claude Code

- Build in the **phases in section 9**. Finish, test and commit each phase before starting the next.
- Every requirement has an ID (`FR-…`, `NFR-…`). Reference IDs in commit messages and tests.
- Policy values (document list, exempt countries, fee, penalty, deadlines) are **data in the `rule_sets` table**, never hard-coded in components. Seed them from section 5.
- Never store files in public buckets. Never trust client-side validation alone: re-validate on the server.
- When something is ambiguous, pick the simplest behaviour consistent with `concept.md`, note it in `docs/DECISIONS.md`, and continue.

## 1. Roles and permissions

| Role | Can |
|---|---|
| `student` | Create/edit own draft, upload/replace own documents, submit, view own status and messages. Cannot see others' data. |
| `dos_staff` | View all applications, review documents, approve/reject with reasons, mark fee, send reminders, export packets. |
| `dos_admin` | Everything staff can, plus manage staff, edit rule sets, templates, retention, view audit log and analytics. |
| `liaison` (phase 4, optional) | Read-only access to approved applications and packets. |

## 2. Application lifecycle

States: `draft → submitted → under_review → corrections_needed → under_review → approved → sent_to_immigration → pass_issued → closed`. Also `withdrawn` (student) and `expired_unfiled` (system flag, not a state; see FR-RUN-3).

Document states: `missing → uploaded → approved | rejected → (re-uploaded) uploaded …`.

Rules:
- Application becomes `submitted` only when every required document is `uploaded` (FR-SUB-2).
- When all documents are `approved` the application may move to `approved` (staff action, one click).
- Any rejected document moves the application to `corrections_needed` and notifies the student.
- Every transition writes an `audit_log` row and an `application_events` row (shown to the student as a timeline).

## 3. Functional requirements

### 3.1 Authentication (FR-AUTH)
- **FR-AUTH-1** Sign in by email one-time code (OTP) or magic link; only `@cavendish.ac.ug` addresses (configurable allow-list of domains) can create student accounts.
- **FR-AUTH-2** Staff accounts are invited by an admin; role is assigned server-side, never self-selected.
- **FR-AUTH-3** Sessions expire after 12 hours of inactivity for staff, 30 days for students (remember device).
- **FR-AUTH-4** Optional SSO (Google/Microsoft) behind a feature flag if the university supports it.

### 3.2 Student profile and application (FR-APP)
- **FR-APP-1** Profile fields: full name (as in passport), student number, nationality, student type (`new | continuing | masters`), phone (optional), programme.
- **FR-APP-2** Application fields: current visa/pass expiry date (or "no pass yet"), requested duration (3, 6, 12 months; informational), notes.
- **FR-APP-3** Form autosaves every change as a draft; a student may leave and resume on any device.
- **FR-APP-4** A student has at most one active application at a time; previous ones are read-only history.

### 3.3 Smart checklist (FR-CHK)
- **FR-CHK-1** The checklist is computed from the active rule set using student type and nationality.
- **FR-CHK-2** Each item shows: name, why it's needed, where to get it (e.g. "Tuition statement: ask Accounts"), an example thumbnail, and its state.
- **FR-CHK-3** Fee-exempt nationalities see a clear banner: "Visa fee waived. The illegal-stay penalty still applies."
- **FR-CHK-4** Items marked `student_addition` in the rule set (passport photos, Masters transcripts) are visually tagged "Required by the university".
- **FR-CHK-5** Page-count hints (e.g. admission letter needs pages 1 and 2): item supports multiple images with `min_files`.

### 3.4 Scan Coach and upload (FR-UP)
- **FR-UP-1** Accept camera capture, gallery pick, drag-and-drop. Accept JPG/JPEG, PNG, HEIC/HEIF, WebP and single or multi-page PDF **as input**; the client converts everything to **JPG** before upload. Stored files are always real JPEGs.
- **FR-UP-2** Client-side quality checks with plain-language results: minimum long edge 1600 px (passport/ID: 1200 px minimum), max stored size 3 MB (auto-compress to quality 0.85, never below 0.7), blur score (Laplacian variance threshold), glare/overexposure, rough orientation, and edge-crop suggestion. Failing a hard check blocks upload; soft warnings allow "use anyway".
- **FR-UP-3** Server re-validates: magic bytes are JPEG, dimensions and size within limits, EXIF stripped (except orientation applied), file hashed (SHA-256).
- **FR-UP-4** Uploads are resumable and show progress; a dropped connection resumes without user action.
- **FR-UP-5** Students can retake/replace a document until it is approved. Old versions are kept (versioned) for audit.
- **FR-UP-6** Duplicate detection: warn if the same hash is uploaded for two different document types.
- **FR-UP-7** Optional (feature flag): on-device OCR to pre-fill/verify passport name and expiry; never sent to third parties.

### 3.5 Submission (FR-SUB)
- **FR-SUB-1** A review screen shows every document thumbnail and entered data before submit.
- **FR-SUB-2** Submit is disabled until all required items are `uploaded` and profile fields are valid. The button explains what is missing.
- **FR-SUB-3** After submit, the student gets an email receipt with a reference number (`VD-YYYY-NNNNN`).
- **FR-SUB-4** The submitted application is frozen except for documents the DOS rejects.

### 3.6 Visa Runway and reminders (FR-RUN)
- **FR-RUN-1** For every student compute `days_to_expiry` and `apply_by` (expiry minus `apply_before_days`, default 30). Show the Runway visual (see `design.md`).
- **FR-RUN-2** Risk bands: `safe` (> 60 days), `plan` (31–60), `urgent` (8–30), `critical` (0–7), `expired` (< 0), `no_pass`.
- **FR-RUN-3** A daily job flags students with no active application at 60, 30, 14, 7 days and on expiry; flags appear on the DOS dashboard and trigger emails.
- **FR-RUN-4** For expired students show "Estimated penalty: USD 20 × days" (rate from rule set). Label clearly as an estimate.
- **FR-RUN-5** Reminders are idempotent (never send the same reminder twice) and logged in `notifications`.

### 3.7 DOS dashboard (FR-DOS)
- **FR-DOS-1** Table with search, filters (status, student type, nationality, risk band, fee status, date range), sort (default: risk then expiry date), and saved views.
- **FR-DOS-2** Summary tiles: needs review, corrections pending, critical/expired, ready for immigration, fees unpaid.
- **FR-DOS-3** Bulk actions: send reminder, mark fee paid, export packets.
- **FR-DOS-4** Application detail: student info, Runway, document grid, timeline, messages, internal staff notes (not visible to student).

### 3.8 Review Mode (FR-REV)
- **FR-REV-1** Full-screen queue of documents awaiting review (filterable by application or document type).
- **FR-REV-2** Large viewer with zoom, rotate, brightness/contrast adjust, and side-by-side with the student's entered data.
- **FR-REV-3** Approve or reject with a **mandatory reason** on rejection: pick from reason templates (editable by admin) plus optional free text.
- **FR-REV-4** Hotkeys: `A` approve, `R` reject, `N`/`P` next/previous, `Z` zoom, `?` help.
- **FR-REV-5** When the last pending document of an application is decided, the application state updates and the student is notified once (batched, not one email per document).
- **FR-REV-6** Staff may "claim" an application to avoid two reviewers working the same one; claims expire after 15 minutes of inactivity.

### 3.9 Fees (FR-FEE)
- **FR-FEE-1** Fee status per application: `not_required | unpaid | paid`. Exempt nationalities default to `not_required`.
- **FR-FEE-2** Staff record payment: amount (UGX), date, reference, optional receipt image. Fee amount and currency note come from the rule set (about USD 100, paid in shillings).

### 3.10 Immigration packet (FR-PKT)
- **FR-PKT-1** For an `approved` application, staff click **Generate packet**: a ZIP containing JPGs named `{NN}_{document_type}_{Surname}_{StudentNo}.jpg`, `cover_sheet.pdf`, and `manifest.json` (file names, SHA-256, timestamps).
- **FR-PKT-2** The cover sheet lists student details, visa dates, document manifest, fee status, and reviewer name/date.
- **FR-PKT-3** Generating/downloading a packet is audit-logged. Marking *Sent to immigration* records date and method (email/in person).
- **FR-PKT-4** Staff can record the outcome: `pass_issued` with new expiry date, which seeds the student's next Runway.

### 3.11 Notifications and messages (FR-NOT)
- **FR-NOT-1** Email templates for: receipt, corrections needed (listing only rejected documents and reasons), approved, sent to immigration, pass issued, reminders (60/30/14/7/expired).
- **FR-NOT-2** In-app inbox mirrors emails; a student can reply in a per-application thread (staff see it on the detail page).
- **FR-NOT-3** Per the source notice, all inquiries go through the student email; thread replies also email the other party.
- **FR-NOT-4** Channel interface allows SMS/WhatsApp providers later (phase 4).

### 3.12 Admin (FR-ADM)
- **FR-ADM-1** Rule-set editor: documents, applicability (student type, nationality), `min_files`, help text, example image, exempt countries, fee, penalty rate, apply-before days, reminder schedule. Rule sets are versioned; publishing creates a new version; in-flight applications keep their version unless staff opt to migrate.
- **FR-ADM-2** Manage staff accounts and roles; manage reason templates and email copy.
- **FR-ADM-3** Retention settings and a dry-run report of what the next sweep would delete.
- **FR-ADM-4** Audit log viewer with filters and CSV export.
- **FR-ADM-5** Analytics: submissions per week, first-pass approval rate, average review time, rejection reasons breakdown, risk-band distribution.

### 3.13 Audit and privacy (FR-AUD)
- **FR-AUD-1** Append-only `audit_log` of logins, uploads, views of sensitive files by staff, reviews, status changes, exports, rule changes. Each row stores a hash of the previous row (tamper-evidence).
- **FR-AUD-2** Retention sweep job deletes document files and personal data after the configured period (default 90 days after `closed`), keeping anonymised aggregates and the audit trail (with personal identifiers redacted).
- **FR-AUD-3** Student can request deletion of their account after the cycle ends (admin approves).

## 4. Non-functional requirements

- **NFR-PERF** Student upload page interactive in < 3 s on a mid-range Android over 3G (JS budget < 200 KB gzipped for the student route). Dashboard loads 500 applications in < 1.5 s (server pagination).
- **NFR-A11Y** WCAG 2.2 AA; full keyboard operation; screen-reader labels on all uploads; contrast ≥ 4.5:1; respects `prefers-reduced-motion`.
- **NFR-I18N** English at launch; all strings externalised for later Swahili/French. Dates shown as `23 Oct 2026` (unambiguous); timezone `Africa/Kampala`.
- **NFR-SEC** Private storage only; signed URLs ≤ 60 s; RLS on every table; rate-limit OTP and uploads; CSP and security headers; no secrets in client bundle.
- **NFR-PRIV** Compliance with the Uganda Data Protection and Privacy Act, 2019: purpose limitation, minimisation, retention, access controls, breach procedure documented in `docs/SECURITY.md`.
- **NFR-REL** Daily database backups; jobs are idempotent and retried; uptime target 99.5% during term time.
- **NFR-OBS** Structured logs, error tracking (Sentry or equivalent), and a `/api/health` endpoint.
- **NFR-TEST** Unit tests for rule engine, risk bands, validation; integration tests for RLS policies; Playwright e2e for the golden paths (student submit, staff reject, student fix, staff approve, packet).

## 5. Seed data (rule set v1, from the Nov 2024 notice)

Fee: about USD 100, paid in UGX, same for 3/6/12 months; pass max 12 months; apply ≥ 30 days before expiry; illegal stay USD 20/day; fee-exempt nationalities: Kenya, Tanzania, Rwanda, Burundi, South Sudan (penalty still applies). Submission email: `dos@cavendish.ac.ug`.

| # | Code | Document | Applies to | min_files | Source |
|---|---|---|---|---|---|
| 1 | `visa_status_page` | Current visa status page | all | 1 | notice |
| 2 | `passport_data_page` | Passport data page | all | 1 | notice |
| 3 | `passport_photos` | Passport photos | all | 1 | student addition |
| 4 | `student_id_face` | Face of student ID card | all | 1 | notice |
| 5 | `proof_of_registration` | Current Proof of Registration form | all | 1 | notice |
| 6 | `admission_letter` | Acceptance / admission letter (pages 1 and 2) | all | 2 | notice |
| 7 | `fees_statement` | Tuition/fees statement (from Accounts) | all | 1 | notice |
| 8 | `exam_results` | Stamped exam results, last semester | continuing | 1 | notice |
| 9 | `transcripts` | Transcripts of past studies | masters | 1 | student addition |

Reason templates (seed): "Image too blurry", "Part of the document is cut off", "Wrong page uploaded", "Document expired", "Name does not match passport", "Stamp or signature missing", "Glare hides details", "Other (explain)".

## 6. Key user stories and acceptance criteria

1. **Student submits.** *Given* a continuing student from Kenya with a pass expiring in 45 days, *when* they open the app, *then* they see 8 required items, a "fee waived" banner and a Runway showing 15 days until the apply-by date.
2. **Format-proof upload.** *Given* an iPhone HEIC photo, *when* the student selects it, *then* it is converted to JPG, quality-checked, uploaded, and the stored file is a valid JPEG.
3. **Targeted rejection.** *Given* a staff member rejects only the passport page for glare, *then* the student gets one email listing that document and reason, and only that item is re-openable.
4. **Expiry watch.** *Given* a student with no application and 30 days left, *then* the daily job flags them `urgent`, emails once, and the DOS dashboard lists them at the top.
5. **Packet.** *Given* an approved application, *when* staff click Generate packet, *then* they download a ZIP with correctly named JPGs, a cover sheet and a manifest whose hashes match the files.
6. **Isolation.** *Given* two students, *then* neither can read the other's rows or files via the UI or direct API calls (tested).

## 7. Edge cases

- Student's pass already expired at first login → application allowed, flagged `expired`, penalty estimate shown, DOS notified immediately.
- Student changes nationality/type after uploading → checklist recomputed; orphaned documents are kept but marked "not required".
- Rule set published mid-cycle → in-flight applications retain their version.
- Same student number registered twice → block and route to staff.
- Very large camera image (> 12 MP) → downscale client-side before checks.
- Staff leaves a claimed application → claim expires automatically.
- Email bounce → surface in staff UI as "student unreachable".

## 8. Out of scope for v1

Online payment of the visa fee, immigration system integration, dependants' passes, multilingual UI (strings externalised only), native mobile apps (PWA instead).

## 9. Build phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 Foundation** | Repo, CI, env config, Supabase project and migrations, design tokens, rule-set seed, RLS skeleton, auth | Login works for student/staff; migrations reproducible; RLS tests pass |
| **1 Submit** | Profile + application form, smart checklist, Scan Coach, upload pipeline with server validation, review screen, submit, receipt email, basic DOS table | Student can complete FR-APP, FR-CHK, FR-UP, FR-SUB; DOS can list and open applications |
| **2 Review** | Review Mode, reasons, per-document states, notifications, timeline, messages, claim | Golden path e2e (submit → reject → fix → approve) green |
| **3 Runway and packets** | Runway visuals, risk bands, daily jobs and reminders, fee tracking, packet export, immigration status | Reminders idempotent; packet hash test passes |
| **4 Governance and polish** | Audit hash chain viewer, retention sweep, admin rule-set editor, analytics, accessibility audit, PWA offline shell, optional SMS/WhatsApp, optional OCR | WCAG audit clean; retention dry-run verified; load test passed |

## 10. Definition of done (per feature)

Tests written and passing; RLS verified; accessible (keyboard + screen reader); empty/loading/error states built; strings externalised; audit events emitted; documented in `docs/`.
