# VisaDesk security and privacy

This document covers how VisaDesk protects student data and how it meets the **Uganda Data Protection and Privacy Act, 2019** (DPPA) and its 2021 Regulations (NFR-PRIV, NFR-SEC). It is written for the Dean of Students (DOS) office, the university's data protection officer and whoever runs the deployment. The operational steps (deploy, back up, restore, rotate) are in [`RUNBOOK.md`](RUNBOOK.md).

> VisaDesk is a tool. The university remains the **data controller** under the DPPA and must keep its registration with the Personal Data Protection Office (PDPO) current and name a data protection officer. Vercel, Turso, Resend and GitHub act as **data processors/sub-processors**; keep their data processing terms on file.

## 1. What we hold and why (purpose limitation, DPPA s.3, s.13)

| Data | Purpose | Where |
|---|---|---|
| Email, full name (as in passport), student number, nationality, student type, programme, phone (optional) | Identify the student and compute the checklist and fee waiver | `profiles`, `students` (Turso) |
| Pass expiry date, application fields | Visa Runway reminders, DOS dashboard | `students`, `applications` |
| Document images (passport page, visa page, ID, letters, statements, photos) | Prepare the Student Pass application for immigration | Vercel Blob, **encrypted** |
| Review decisions, reasons, messages | Corrections workflow, student timeline | `application_documents`, `application_events`, `messages` |
| Fee payments (amount, date, reference, receipt image) | Fee tracking | `payments`, Vercel Blob (encrypted) |
| Audit log (IDs and codes only) | Accountability, tamper evidence (FR-AUD-1) | `audit_log` |

The data is used **only** to prepare and track Student Pass applications. It is not used for marketing, profiling or any other university process, and it is never sent to third parties except the immigration packet that DOS staff deliver themselves. OCR (FR-UP-7) is off by default and, if enabled, runs on the device.

The privacy notice shown to students should state these purposes, the retention period (section 4) and how to request access, correction or deletion (section 6).

## 2. Minimisation (DPPA s.3(1)(c))

- The checklist asks only for documents the immigration notice (or the university, clearly tagged) requires; the rule set is data (`rule_sets`), so dropping a document is an admin edit.
- Phone number is optional. No date of birth, passport number or address fields are collected as structured data.
- **Notification payloads hold IDs and codes only**. Names and email addresses are resolved at send time, so the queue does not copy personal data.
- **The audit log holds IDs and codes only** (D-07), never names, emails or free text. This is what lets retention delete personal data without breaking the hash chain.
- OTP codes are stored only as HMACs and the rows are deleted a day after expiry. Sessions store only a SHA-256 of the token. Expired sessions and rate-limit windows are pruned daily.
- Logs are structured JSON with counts and IDs only (`[cron]` lines in Vercel logs).

## 3. Access control (DPPA s.20 security safeguards)

- **Authentication:** email one-time codes (6 digits, HMAC-stored, 10-minute expiry, 5 attempts, rate-limited per email and per IP in the database). No passwords to leak.
- **Sessions:** httpOnly, SameSite=Lax, Secure cookies; idle timeout 12 hours for staff, 30 days for students (FR-AUTH-3). Disabling an account or changing its role revokes all its sessions.
- **Authorization in the app** (`src/server/authz.ts`, D-02): every service function takes the actor and checks it first. Students only ever see their own rows; asking for someone else's returns *Not found*. Staff can read applications; only `dos_admin` can manage staff, rule sets, templates, retention, the audit log and analytics. Route-group layouts redirect, but **services enforce** (tests in `tests/integration/isolation.test.ts` and `tests/admin/admin.test.ts`).
- **Roles are assigned server-side** by an admin (FR-AUTH-2); a user can never choose one.
- **Files are never public.** They are served only through `/api/files/[id]` after an authorization check, decrypted on the fly with `Cache-Control: private, no-store`. Every staff view of a student file writes a `file.viewed` audit row.
- **Web hardening:** strict nonce-based CSP, HSTS, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`; cross-origin `POST`s to `/api/*` are rejected (except cron routes, which need `CRON_SECRET`, and the Resend webhook, which needs a valid Svix signature).
- **Secrets** live only in Vercel environment variables and GitHub Actions secrets. None are exposed to the browser (`NEXT_PUBLIC_*` holds only the app name).
- **Least privilege for operators:** give only the DOS system owner and one deputy access to the Vercel team, Turso, Resend and the GitHub repository. Turn on two-factor authentication for all four.

## 4. Retention (DPPA s.18) and deletion

- **Default:** files and personal fields are deleted **90 days after an application is closed or withdrawn** (setting `retention_days`, adjustable on `/retention`, 7 to 3650 days).
- The nightly `retention-sweep` (03:30 UTC) runs exactly the plan shown in the **dry-run report** on `/retention` (`planRetention()` is shared, and a test checks dry run = actual). For each eligible application it:
  1. deletes every stored file (document versions and thumbnails, packets, fee receipts) from Vercel Blob;
  2. marks the versions deleted and blanks their storage keys; clears packet manifests (they contain surnames), receipt keys and payment references; replaces message bodies; removes reviewer notes from documents and timeline events; empties notification payloads; clears application notes; sets `applications.purged_at`.
- A student is **anonymised** when all their applications are purged, none is active, and they have not signed in within the retention period: email replaced with `deleted+<id>@invalid.invalid`, name, student number, phone, programme, nationality and pass expiry cleared; sessions, OTPs and Runway flags removed; account disabled.
- **Kept:** the application row (status, dates, rule-set version, fee status, number of correction rounds) as an anonymised aggregate for analytics, and the **audit log, which is never modified** (it has no personal data, and SQLite triggers block UPDATE and DELETE).
- **Backups** are kept 30 days (section 7), so deleted data disappears from backups at most 30 days after the sweep. Say so in the privacy notice.

## 5. Encryption

- **In transit:** HTTPS everywhere (Vercel), TLS to Turso (`libsql://`), Resend and Vercel Blob.
- **At rest, application-level:** every file is encrypted by `EncryptedBlobStore` with **AES-256-GCM** before it leaves the function (random 96-bit IV per file; the header `VDE1 | keyId` is authenticated as AAD, so any tampering fails decryption). Vercel only ever stores ciphertext; a leaked blob URL reveals nothing. The key is `FILE_ENCRYPTION_KEY` (32 random bytes, base64), with id `FILE_ENCRYPTION_KEY_ID`.
- **Database:** Turso encrypts storage at rest at the provider level. The database itself does not hold document images.
- **Backups** are compressed and encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` using `BACKUP_PASSPHRASE` before upload as a GitHub artifact.

### Key rotation procedure

Rotate the **file key** yearly, when someone with access leaves, or immediately after a suspected leak.

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. In Vercel → Settings → Environment Variables (Production):
   - set `FILE_ENCRYPTION_PREVIOUS_KEYS` to `k1:<old key>` (comma-separate if several retired keys are still in use);
   - set `FILE_ENCRYPTION_KEY` to the new key and bump `FILE_ENCRYPTION_KEY_ID` (`k1` → `k2`);
   - redeploy. New files use `k2`; old files are still readable with `k1` (the key id is in each file's header).
3. Re-encrypt old files from a trusted laptop with a `.env.rotate` holding the production `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN` and the same key variables:
   `npx tsx --conditions=react-server --env-file=.env.rotate scripts/rotate-file-key.ts --dry-run` then without `--dry-run`. It skips files already on the current key, so it can be re-run safely.
4. When it reports `rotated: 0` on a dry run, remove `FILE_ENCRYPTION_PREVIOUS_KEYS`, redeploy, delete `.env.rotate` and destroy the old key.

Other secrets:

| Secret | How to rotate | Effect |
|---|---|---|
| `SESSION_SECRET` | New random value, redeploy | Outstanding OTP codes stop working; sessions continue (they are random tokens) |
| `CRON_SECRET` | New value in Vercel and the GitHub secret, redeploy | Vercel Cron picks it up automatically |
| `DATABASE_AUTH_TOKEN` | Turso dashboard → create token, update Vercel + GitHub secret, then revoke the old one | None if done in that order |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob → rotate | Redeploy |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend dashboard | Redeploy |
| `BACKUP_PASSPHRASE` | New GitHub secret | **Keep the old passphrase** (in the password manager) for 30 days to open older backups |

Store every secret in the university password manager, never in email or chat.

## 6. Data subject rights (DPPA Part IV)

- **Access:** students see their own application, documents, timeline and messages in the app. A full copy can be produced by an admin from the database on request.
- **Correction:** students edit their profile until they submit; afterwards DOS staff correct it through a message thread.
- **Deletion (FR-AUD-3):** after their cycle ends (no active application), a student can request deletion. Admins see pending requests on `/retention`; approving deletes the files and personal data immediately using the same code as the retention sweep. The service functions are `requestAccountDeletion`, `cancelDeletionRequest` (student) and `decideDeletionRequest` (admin) in `src/server/services/privacy.ts`.
- **Objection / complaints:** route to the university data protection officer; the student can also complain to the PDPO.

## 7. Backups and availability (NFR-REL)

- Nightly encrypted SQL dump of Turso via GitHub Actions, kept 30 days as a workflow artifact (`.github/workflows/backup.yml`). Files in Vercel Blob are not in the SQL dump; they are encrypted and Blob is durable storage, but there is no second copy on the free plan (see RUNBOOK "Limits").
- A **restore drill** is done each quarter and recorded in the RUNBOOK log; the audit chain is verified after every restore (`scripts/verify-audit.ts`).

## 8. Breach procedure (DPPA s.23)

The DPPA requires the controller to notify the PDPO **immediately** on discovering a breach, and the affected students where there is a real risk of harm. Treat "immediately" as within 72 hours at the latest.

1. **Detect and record (hour 0).** Anyone who suspects a breach (lost laptop with a `.env`, leaked token, wrong person given access, audit chain broken, unexpected admin account, files visible to the wrong student) tells the DOS system owner and the data protection officer at once. Start an incident log: time, who noticed, what was seen.
2. **Contain (first hours).**
   - Rotate the exposed secret (section 5). If unsure, rotate `CRON_SECRET`, `DATABASE_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN` and `SESSION_SECRET`.
   - Disable suspicious accounts on `/staff` (this revokes their sessions). To sign everyone out, delete all rows in `sessions`.
   - If a device with the file key was lost, start a file-key rotation.
3. **Assess (within 24 h).**
   - Check `/audit` (filter by actor, `file.viewed`, `packet.downloaded`, `staff.invited`, `audit.exported`) to see what was accessed. Export the relevant rows as CSV.
   - Confirm the audit chain status banner is green. A broken chain means the database was edited outside the app: restore the latest good backup into a new database and compare.
   - Decide which students are affected and what data (documents? only emails?).
4. **Notify (no later than 72 h).** The data protection officer notifies the PDPO with: nature of the breach, categories and approximate number of students, likely consequences, measures taken. Notify affected students by email in plain language, saying what happened, what data, what we did and what they should do (for example, watch for fraud using their passport details).
5. **Recover and review.** Restore from backup if data was altered, fix the cause, record lessons learned, and update this document and the RUNBOOK.

## 9. Known limits

- Vercel Hobby is for non-commercial use; the university should confirm this fits its use or move to Vercel Pro.
- Free-tier quotas (Resend 100 emails/day, Blob storage, Actions minutes) are listed in RUNBOOK "Limits". Running out degrades service but does not expose data.
- Error tracking (NFR-OBS "Sentry or equivalent") is not set up, to stay within Vercel + GitHub. Vercel function logs and the `job_runs` table on `/retention` are the observability tools.
