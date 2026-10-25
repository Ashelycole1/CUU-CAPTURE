# VisaDesk: Decisions log

Each entry records a choice we made where the spec was silent, ambiguous, or overridden. Newest at the bottom of each section. When you resolve a new ambiguity, add it here.

## Platform and architecture

### D-01 Vercel + GitHub only; SQLite via libSQL/Turso; encrypted Vercel Blob (overrides architecture.md §2, §6, §10)
The owner wants to stay on free resources and avoid the Supabase free tier, which pauses projects when they sit idle. Deployment is **Vercel Hobby (serverless) + GitHub**, with:
- **Database:** SQLite semantics through `@libsql/client` + `drizzle-orm/libsql`. Locally and in tests: `DATABASE_URL=file:./data/visadesk.db`, a plain SQLite file opened by the same client. Production: **Turso** (hosted libSQL, provisioned from the Vercel Marketplace) with `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`. `better-sqlite3` was dropped because it needs a persistent disk and native bindings, which Vercel functions do not offer.
- **Storage:** `BlobStore` interface. `VercelBlobStore` (`@vercel/blob`, `access: 'private'`, `addRandomSuffix`) in production and `LocalDiskStore` in dev/tests. Every byte at rest is encrypted in the app by `EncryptedBlobStore` (AES-256-GCM, random IV per file, key id in the header). See D-09.
- **Email:** Resend over plain `fetch` (`RESEND_API_KEY` set). Without the key, `DevOutboxChannel` writes to the `outbox` table, readable at `/dev/outbox`.
- **Jobs:** no in-process scheduler (`node-cron` was not installed). Jobs are HTTP routes under `/api/cron/*`, protected by `Authorization: Bearer $CRON_SECRET`. `vercel.json` schedules them at 03:00 UTC (06:00 Kampala), once a day, the maximum on Hobby.
- No `output: 'standalone'`, and production code paths never write to the filesystem.
- The data-access layer stays thin (Drizzle sqlite-core, ISO strings, JSON text) so a later move to Postgres is mechanical.

### D-02 Authorization in the app instead of Postgres RLS
SQLite has no RLS. `src/server/authz.ts` is the policy module, and every service function takes an `Actor` and checks it before touching data. Student reads are always scoped to `applications.student_id = actor.id`. When a student asks for another student's rows the service raises **NotFound** rather than Forbidden, so it does not reveal whether the row exists. Roles always come from the DB through the session join and never from client input. Integration tests in `tests/integration/isolation.test.ts` cover PRD story 6.

### D-03 Single Next.js app at the repo root (no monorepo)
architecture.md §3 proposes `apps/web` + `packages/shared` with pnpm workspaces. With one deployable and one team, a single app is simpler. "Shared" code lives in `src/domain/` (pure; ESLint blocks server and framework imports there) and is used by both client and server. We use npm, not pnpm.

### D-04 Our own email OTP and sessions (no auth vendor)
Codes are 6 digits, stored as HMAC-SHA256(SESSION_SECRET, email:code), expire after 10 minutes, and allow at most 5 attempts. Requesting a new code invalidates the old one. Requests are rate-limited per email (5/15 min) and per IP (20/15 min), and verification per IP (30/15 min), using a DB-backed fixed-window limiter (`rate_limits`) so the limits hold across serverless instances.
Sessions are a random 32-byte token in an httpOnly, SameSite=Lax cookie (Secure in production). Only the SHA-256 of the token is stored. Expiry is a sliding idle window enforced in the DB: 12 h for staff, admin and liaison, 30 days for students (FR-AUTH-3). The cookie max-age is 30 days for everyone because the DB is the authority. `last_seen_at` is refreshed at most every 5 minutes to limit writes.
Student self-sign-up is limited to allow-listed domains (`settings.allowed_email_domains`, falling back to `ALLOWED_EMAIL_DOMAINS`). Any existing, active profile can sign in, so invited staff may use other domains (FR-AUTH-2). SSO (FR-AUTH-4) is not built; the `feature_flags.sso` setting exists.

### D-05 CSRF
Server Actions rely on Next's built-in Origin check. Mutating route handlers are protected twice: `src/proxy.ts` rejects non-GET `/api/*` requests whose Origin/Referer host differs from the request host (except `/api/cron/*`), and route handlers may also call `assertSameOrigin(req)`.

### D-06 Strict CSP via nonce
`src/proxy.ts` (the Next 16 name for middleware) sets a per-request nonce CSP with `script-src 'self' 'nonce-…' 'strict-dynamic'`. The root layout reads `headers()`, which makes every page dynamic as nonces require (the app is auth-gated anyway). `style-src` allows `'unsafe-inline'` because inline style attributes (Runway geometry) cannot carry nonces. Scripts stay strict. Static headers (HSTS, nosniff, frame DENY, Referrer-Policy no-referrer, Permissions-Policy, COOP/CORP) are set in `next.config.ts`.

### D-07 Audit log: hash chain, append-only, no PII in meta
`hash = SHA-256(prev_hash || canonicalJSON({at, actorId, action, targetType, targetId, meta}))`. The first row's `prev_hash` is 64 zeros. Writes happen in the same transaction as the change. Service transactions are libSQL write transactions (`BEGIN IMMEDIATE`, which takes the write lock up front), so reading the previous hash and inserting are serialized even with concurrent serverless writers. A UNIQUE index on `prev_hash` makes any fork fail loudly, and `withTx` retries. SQLite triggers `RAISE(ABORT)` on UPDATE and DELETE. **`meta` holds only IDs and codes, never names, emails or free text**, so the retention sweep can delete personal data without breaking the chain. `actor_id` has no FK to `profiles`, so a profile can be deleted. `verifyAuditChain()` recomputes the chain.

### D-08 Files are served by the app, never by URL
`GET /api/files/[versionId]` checks authz, fetches the blob, decrypts it, and streams it with `Cache-Control: private, no-store`. Staff, admin and liaison views write a `file.viewed` audit row. The original brief proposed a ≤ 60 s HMAC-signed redirect. Streaming directly is strictly stronger (no URL to leak), so we did not build a signed-URL step and there is no `FILE_URL_SECRET`. Request bodies on Vercel functions are capped at 4.5 MB and stored JPGs are ≤ 3 MB, so the client posts the processed JPG straight to our upload route (no signed upload step).

### D-09 Encryption envelope
`"VDE1" | keyIdLen | keyId | iv(12) | tag(16) | ciphertext`. The header is bound as AAD, so any byte change fails decryption. `FILE_ENCRYPTION_KEY` holds 32 bytes, base64. `FILE_ENCRYPTION_KEY_ID` (default `k1`) is written into each file. To rotate, add the new key to the keyring (`keyringFromConfig` in `src/server/storage/index.ts`) and switch the current id. Old files stay readable by their key id.

### D-10 SQLite pragmas
`journal_mode=WAL` and `synchronous=NORMAL` are set when the DB is opened by scripts or tests. WAL persists in the file. `busy_timeout=5000` is set on every pooled connection through the libSQL `timeout` option. libSQL turns `foreign_keys` on by default on every connection, and a test asserts it. These pragmas apply only to local files. Turso manages its own.

## Domain and data

### D-11 IDs, dates, JSON
Primary keys are TEXT UUIDs (`crypto.randomUUID()`). `audit_log.id` is an INTEGER autoincrement, because the chain is ordered. Calendar dates are `YYYY-MM-DD` interpreted in Africa/Kampala. Timestamps are ISO-8601 UTC strings. Arrays and objects are stored as JSON text through the typed `json<T>()` column helper.

### D-12 Application reference assigned at submission
`VD-YYYY-NNNNN` comes from an atomic per-year counter (`ref_counters`, `INSERT … ON CONFLICT DO UPDATE … RETURNING`) when the application is **submitted**, not when the draft is created. That keeps the numbers dense, and the receipt (FR-SUB-3) is the first place a student needs the number. The year is the Kampala calendar year at submission.

### D-13 One active application per student
"Active" means `draft, submitted, under_review, corrections_needed, approved, sent_to_immigration`. A partial UNIQUE index on `applications(student_id)` enforces it. `pass_issued`, `closed` and `withdrawn` count as history, so a student can start the next cycle once the pass is issued.

### D-14 Lifecycle details (PRD §2)
- `submitted → under_review` happens when staff claim the application or review its first document.
- After a corrections round, the student does not press "resubmit". When the last rejected required document is replaced, the application moves back to `under_review` automatically (`corrections_resubmitted` event).
- When every required document is approved, the status **stays `under_review`** until staff click Approve (`markApproved`; PRD: "staff action, one click"). Only then is the approval email queued.
- FR-REV-5 batching: when no required document is left `uploaded` and at least one is `rejected`, we move to `corrections_needed` and queue **one** `corrections_needed` notification listing every rejected document (dedupe `corrections:{appId}:{round}`). If staff reject a re-upload while the application is already in `corrections_needed`, that opens a new round, which means a new single email.
- Students may upload: any non-approved document while `draft`; only `rejected` documents while `under_review` or `corrections_needed` (FR-SUB-4); nothing otherwise. Approved documents are locked.
- Students can withdraw from `draft`, `submitted`, `under_review` or `corrections_needed`, but not after approval.
- `close` is allowed from `sent_to_immigration` (outcome unknown) or `pass_issued`.

### D-15 Multi-file documents (FR-CHK-5)
Each upload is a `document_versions` row with a `page` (1..min_files) and a per-document `seq`. A new version supersedes the previous active version of the same page (`superseded_at`). A document becomes `uploaded` only when every page 1..min_files has an active version. Storage keys follow `{application_id}/{doc_code}/{seq}.jpg` (+ `_thumb.jpg`). `prepareDocumentUpload` reserves the next seq, and a racing duplicate seq fails with ConflictError so the client retries.

### D-16 Orphaned documents after profile changes (PRD §7)
When the student's type or nationality changes on a draft, documents that no longer apply keep their state and versions but get `required = false` (shown as "Not required"). New items are added as `missing`. The fee status is recomputed (`paid` is never overwritten). The profile is **locked once the application is submitted**.

### D-17 Duplicate student number (PRD §7)
`students.student_no` is UNIQUE. A duplicate raises a ValidationError: "This student number is already registered. Contact the Dean of Students."

### D-18 Expired at submission (PRD §7)
If the pass has already expired when the student submits, every active admin gets a `staff_alert` notification (dedupe `expired_submit:{appId}:{adminId}`). Daily flagging of students without an application is left to the jobs agent (`runway_flags`).

### D-19 Risk ordering of `no_pass`
The default dashboard sort is risk band, then expiry. The rank is `expired < critical < urgent < no_pass < plan < safe`. We placed students with no pass yet (usually new students entering on another visa) after `urgent` and before `plan`. The rank is defined once in `RISK_RANK` and mirrored in the SQL `CASE` in `listApplicationsForStaff`.

### D-20 Notifications are queued in-transaction and delivered after commit
`queueNotification(tx, …)` inserts with `ON CONFLICT(dedupe_key) DO NOTHING` inside the service transaction (FR-RUN-5). Delivery runs in `flushNotifications()`: each row is claimed with a conditional UPDATE, sent, and marked `sent` or `failed` (up to 5 attempts). Callers trigger it after commit (`after(() => flushNotifications())`), and the daily cron retries leftovers. Payloads hold IDs and codes. Recipient emails and names are resolved at send time. OTP emails are sent directly and never stored in `notifications`. Resend calls pass the dedupe key as `Idempotency-Key`.

### D-21 Student messages notify the claiming or last-replying staff member
FR-NOT-3 says replies email "the other party". For a student message, that is the reviewer holding the claim, or else the last staff member who wrote in the thread. If neither exists, no email is sent and the message still appears on the staff detail page.

### D-22 Rule-set versions
Publishing a draft retires the previously published set. Existing applications keep their `rule_set_id` and only new drafts use the new set. Migrating an in-flight application to a new version ("unless staff opt to migrate", FR-ADM-1) is not built yet.

### D-23 Seed
`npm run db:seed` is idempotent. It inserts rule set v1 (PRD §5), the 8 reason templates, and settings (`retention_days` 90, `allowed_email_domains`, `feature_flags`, `claim_minutes` 15). Dev users (admin, staff, student1 KE continuing, student2 NG masters) are added outside production, or never if `SEED_DEV_USERS=0`. `vercel-build` runs migrate, then seed, then build. Production seeding never creates dev users because `NODE_ENV=production`.

## UI

### D-24 Tailwind v4 theme instead of `tailwind.config`
design.md says to mirror tokens in `tailwind.config`. Tailwind v4 is configured in CSS, so the tokens are CSS variables in `src/app/globals.css` and are mapped to utilities with `@theme inline` (`bg-brand-500`, `text-risk-urgent`, `rounded-md`, `shadow-1`, `font-serif`, `font-mono`).

### D-25 Contrast adjustments
`--risk-urgent` and `--warn` were darkened from `#c77a00` to `#a86600` so text meets 4.5:1 on paper. The dark theme raises the lightness of every risk and status colour.

### D-26 Login flow
`/login` takes the email and sends the code, then redirects to `/verify?email=…` (6 boxes, paste, auto-advance, `autocomplete=one-time-code`, 60 s resend countdown). After verifying, students go to `/apply` and staff, admin and liaison to `/dashboard`. Sign-out is a server action form (POST).

## Toolchain

### D-27 Versions pinned for Node 20
Node 20.20 is installed. vitest 5 and better-sqlite3 13 need Node ≥ 22, so we use **vitest 4**, **TypeScript 5.9** (TypeScript 7 lacks the JS API that Next uses), **ESLint 9** with `eslint-config-next` 16 flat config, Next 16.4, React 19, Zod 4 and `@hookform/resolvers` 5 (resolvers 6 has broken peer dependencies). Playwright is installed without browsers.

### D-28 Fonts via next/font/google
Inter, Fraunces (600, H1/H2) and JetBrains Mono are self-hosted by `next/font/google` at build time, so `font-src 'self'` holds. The build downloads the font files. One local build failed on a transient fetch error and passed on retry. If builds become flaky offline, switch to `next/font/local` with committed woff2 files.

## Staff UI

(Numbered `S-xx` so they don't collide with entries other agents add at the same time.)

### ST-01 Review Mode undo is a client-side 8-second delay
After a decision, Review Mode moves on straight away and shows an 8 s undo toast. The decision is only sent (`reviewDocumentAction` → `reviewDocument`) once the toast expires. Undo cancels the timer, so nothing was ever written. We chose this over a service-level undo for two reasons. The foundation has no undo service, and adding one would mean editing foundation code. More importantly, an undo after commit would have to reverse a status transition and an already-queued `corrections_needed` email (FR-REV-5). Commits run one at a time through a single promise chain, so FR-REV-5 batching still sees decisions in order. When the reviewer leaves the page (in-app navigation, a filter change, or the Exit/detail links), pending decisions are committed immediately. If they close the tab, `beforeunload` tries to commit and also shows the browser's "leave page?" prompt. Known risk: if the browser is killed within 8 s of a decision, that decision is lost. Nothing was written, so it stays visible as `uploaded` in the queue.

### ST-02 Claims in Review Mode
Opening a document claims its application (`claimApplication`). A heartbeat re-claims every 60 s, but only if the reviewer used the keyboard or pointer in the last 5 minutes. An idle reviewer's claim therefore lapses after the 15-minute service expiry (FR-REV-6). `reviewDocument` also renews the claim. When the reviewer moves to another application, the previous claim is released once its pending decisions have committed. A `ConflictError` shows the claim banner and disables Approve/Reject. Staff names are not shown ("Another reviewer"): no service maps profile ids to names for non-admins.

### ST-03 Packets: in memory, integrity-checked, streamed download
`buildPacket` (`src/server/services/packet-builder.ts`) builds the whole ZIP in memory with fflate. JPGs are stored with no compression, the PDF and JSON with level 6. Input is capped at `MAX_PACKET_BYTES` = 25 MB, and the POST route sets `maxDuration = 60`. Before zipping, every decrypted file's SHA-256 must equal `document_versions.sha256`. On a mismatch the packet is marked `failed` (`failPacket`), and any blob already stored is deleted. Export order is checklist (rule-set) order, then page. `NN` runs 01..N across all files, so the two admission-letter pages are two files with consecutive numbers and otherwise the same name pattern. File names are ASCII-folded (`Zoë O'Brien` → `OBrien`; `CUU/2024/7` → `CUU-2024-7`). The surname is the last word of the full name. The cover sheet uses only the standard Helvetica/Courier fonts (WinAnsi), so non-Latin-1 characters print as `?`. `manifest.json` lists every JPG plus `cover_sheet.pdf`, each with name, SHA-256, bytes, doc code, version id, upload and review timestamps. The same manifest is saved in `packets.manifest`. The download route `GET /api/packets/{appId}/{packetId}` decrypts the ZIP and returns it as a `ReadableStream` in 256 KB chunks. Vercel's 4.5 MB cap applies to buffered response bodies only, so streaming lets larger packets through. The ZIP is still decrypted fully in memory, because GCM needs the whole ciphertext. Each download writes one `packet.downloaded` audit row (`authorizePacketFile`).

### ST-04 Payment receipts go through a route handler under `(staff)`
`POST /applications/{id}/payments` (multipart) records the payment. It is a route handler because Server Action bodies default to 1 MB, and `next.config.ts` is foundation-owned. The receipt image (≤ 4 MB) is re-encoded with sharp: orientation applied, EXIF stripped, ≤ 2000 px, JPEG q82. It is then stored at `receipts/{appId}/{uuid}.jpg` through the encrypted BlobStore. The key uses its own UUID because `recordPayment` generates the payment id internally. Viewing happens at `GET /applications/{id}/payments/{paymentId}/receipt`, which is audited via `authorizeReceiptFile`. Both routes check the role themselves, because layouts don't run for route handlers, and the POST also calls `assertSameOrigin` (proxy.ts only covers `/api/*`).

### ST-05 Bulk actions
- **Send reminder** posts a normal (non-internal) message to each student through `postMessage`. That emails them (`message:{id}`), puts the reminder in their in-app thread, and audits it. We did this because there is no staff "send reminder" service, and the `reminder` notification kind is reserved for the daily runway job's dedupe scheme.
- **Mark fee paid** uses `setFeeStatus(…,'paid')`, which is audited. No payment row is created; use the detail page's form for real payments. Only selected rows that are `unpaid` are sent.
- **Export packets** builds packets for selected `approved`/`sent_to_immigration` applications, at most 10 per call because of function time limits. It returns download links. We don't build a ZIP of ZIPs, which would exceed the memory and response limits.
- At most 100 ids per call. Each id succeeds or is skipped/failed on its own.

### ST-06 Dashboard state lives in the URL; paging is keyset "next / first"
Filters, sort and cursor are URL params (`q,status,type,nat,risk,fee,from,to,sort,mine,drafts,cursor`), parsed leniently by `src/components/staff/dashboard-params.ts`. The page server-renders one 50-row keyset page from `listApplicationsForStaff` (one aggregated query plus a count), alongside the summary and saved views in parallel. Paging offers only "Next page" and "First page", because keyset cursors don't go backwards. An invalid cursor falls back to page 1. Summary tiles are links that apply their filter; clicking an active tile clears it. Three built-in presets ("Urgent this week", "Awaiting my review", "Ready to send") appear before saved views. Keyboard: `/` search, `j`/`k` (or arrows) move, `Enter` open, `x` select.

### ST-07 Staff UI copy in `src/i18n/staff.ts`
All staff strings, the cover-sheet text and the per-document review checklists live in `src/i18n/staff.ts` (`staffText`, `fmt`). Keeping them out of `en.ts` avoids edit collisions between agents. The lead can merge them into `en.ts` under `staff.*` later.

### ST-08 Gaps and limits
- "Student unreachable" (`emailBounced`) shows on dashboard rows. The detail page can't show it because `ApplicationDetail` has no `email_status`, and nothing sets `bounced` yet (no webhook).
- Staff can't withdraw: `withdrawApplication` is student-only. The detail page offers Close where the state machine allows it (`sent_to_immigration`/`pass_issued`).
- Timeline and messages show "Staff", "You", "System" or the student's name, not other staff members' names.
- The cover sheet shows the approver's name, read from `profiles` inside the packet-builder service.

## Student UI

### SU-01 Routes
`/apply` is the checklist home. It sends a draft with an incomplete profile to `/profile`, and `/checklist` redirects to `/apply`. The other routes are `/profile` (3 steps of 3 questions, read-only once submitted), `/documents/[type]?slot=N`, `/review`, `/status` and `/messages`. Every value saves on blur or change through server actions in `src/app/(student)/actions.ts`, which call `updateStudentProfile` / `updateApplicationFields` (FR-APP-3). Submit runs `submitApplication` and then `after(() => flushNotifications())` for the receipt. Student strings live in `src/i18n/student.ts`, separate from `en.ts`, so parallel agents don't collide on one file.

### SU-02 Scan Coach thresholds live in `src/lib/scan/constants.ts`
The client pipeline and the server route share one file. Limits: max 3 MB stored, 12 MP downscale cap, 8000 px hard ceiling on the server, JPEG quality 0.85 → 0.70 in 0.05 steps. Blur is the Laplacian variance on a 1024 px grey copy: hard fail < 25, warning < 60. Glare is the share of pixels ≥ 250: warning > 4 %, hard fail > 25 %. A mean brightness < 45 gives a "too dark" warning. The thresholds are first guesses and need tuning against real phone photos. Hard fails: too small, too blurry, heavy glare, and over 3 MB at quality 0.7. Everything else is a soft warning with "Use anyway", and the warning codes plus `usedAnyway` are stored in `document_versions.quality`.

### SU-03 1200 px minimum applies to passport-type and ID documents
`passport_data_page`, `visa_status_page` (a passport page), `student_id_face` and `passport_photos` use 1200 px on the long edge. Every other document uses 1600 px. Each document code also maps to a frame-guide shape (passport, ID card, photo, A4) in `DOC_PROFILES`.

### SU-04 Upload route details (`POST /api/uploads`)
- The client sends `applicationId/docCode/slot` in the query string **and** in the multipart body. The route reads the query first so `prepareDocumentUpload` (authz/state) can fail before the body is parsed.
- The server re-encodes only when needed. When the JPEG has a non-1 orientation or any EXIF/XMP/IPTC/ICC/comment, sharp rotates it, drops all metadata and re-encodes at quality 85, stepping down to 70 if it is still over 3 MB. Clean canvas JPEGs are stored byte-for-byte after a full decode check. That avoids a second round of compression loss.
- **Idempotency:** before anything is stored, the route checks `getApplicationDetail` for an active version with the same SHA-256 in the same slot. A match returns `200 {idempotent:true}` with the existing version. This also covers a retry after a successful corrections upload, where `prepareDocumentUpload` would otherwise fail with INVALID_STATE because the document is no longer `rejected`.
- On any error after `put` (including a seq ConflictError), both blobs are deleted. A Conflict is returned with `details.retry=true`, and the client retries it.

### SU-05 Client resilience
Each processed JPEG is written to IndexedDB (`visadesk-uploads`) **before** the upload starts and removed only when the server confirms. Uploads use XHR for progress, with full-jitter exponential backoff (1 s base, 30 s cap, 8 attempts). Status 0, 408, 429, 5xx and seq CONFLICT are retried; other 4xx are final. A pending retry wakes early on the `online` event. `<PendingUploads/>` in the student layout resumes the queue on page load and when the connection returns. When IndexedDB is unavailable (private mode), the queue is held in memory only.

### SU-06 Heavy libraries load lazily
`heic2any` and `pdfjs-dist` load through dynamic `import()` only when a HEIC or PDF file is chosen. The pdf.js worker and the quality worker are created with `new Worker(new URL(..., import.meta.url))`, which CSP `worker-src 'self' blob:` allows. Before falling back to heic2any, the client first tries the browser's own HEIC decoder (Safari). For a multi-page PDF, the student picks pages, and each chosen page fills the next empty `min_files` slot.

### SU-07 The student sees the DOS reason through a new read-only service
`listReasonTemplates` is staff-only. The new `src/server/services/student-view.ts` adds `getReasonLabelsForApplication(actor, applicationId, codes)`, which returns label and body text for the reason codes on an application the actor can read. It is additive, exported from that file only, and leaves `services/index.ts` unchanged.

### SU-08 Expired at first login
The application is still allowed. The checklist shows the Runway plus a separate "Estimated penalty: USD X so far (USD 20 per day)" card labelled as an estimate (FR-RUN-4). The profile wizard shows the same estimate as soon as the student enters a past expiry date. The admin alert at submission is handled by the services (D-18).

## Jobs/Admin/Infra

### D-J1 Reminder stages: only the current stage is sent
The daily Runway job (`src/server/jobs/daily-runway.ts`) computes, for each active student who has **not submitted** (no active application, or only a `draft`), the smallest configured reminder day `D` (rule set `reminderDays`, default 60/30/14/7/0) with `daysToExpiry <= D`, plus an implicit **expired stage `-1`** when `daysToExpiry < 0` ("reminders 60/30/14/7/expired", FR-NOT-1). Only that stage is flagged and emailed: a student first seen with 10 days left gets the 14-day reminder, not the 60 and 30 as well. Earlier open flags for the same expiry are resolved when a later stage is flagged; all open flags resolve when the student submits or their expiry changes. Students with a draft get "Finish your application" copy (`payload.hasDraft`). The active rule set's `reminderDays` applies to everyone.

### D-J2 Idempotency and resumability
Correctness comes from `runway_flags` UNIQUE(student, expiry, day) and the dedupe key `reminder:{studentId}:{expiry}:{day}` (stage `-1` for expired). A new `job_runs` table (UNIQUE job + run key = Kampala date) stores a keyset cursor per page of 200 students; runs stop at `CRON_BUDGET_MS` (40 s, below the 60 s `maxDuration`) and re-invoke themselves via `after()` with `?hop=N` (max 8). A lost continuation only delays work until the next call. Same-day re-runs return `alreadyDone`.

### D-J3 Expired students: one DOS digest per day
Instead of one alert per expired student per admin, admins get one `staff_alert` per day (`expired_digest:{date}:{adminId}`) with the count of students newly flagged expired. The student list is the Runway flags (`listOpenRunwayFlags(actor)` in `services/runway-flags.ts`, for the staff dashboard).

### D-J4 Notification retries with backoff and a daily cap
`notifications.next_attempt_at` was added. After a failed send the next attempt waits 0 (next flush), 15 min, 2 h, 12 h; `MAX_ATTEMPTS` stays 5 (small edit in `notify/index.ts`). The cron flushes with `flushWithinCap()`, which never sends more than `EMAIL_DAILY_CAP` (default 80) emails per rolling 24 h because Resend's free tier allows 100/day including OTP codes. `after()` flushes from user actions are not capped (they are small).

### D-J5 Intra-day work without paid crons
Vercel Hobby crons run once a day. `.github/workflows/health.yml` (free) calls `/api/health` and the new `/api/cron/flush` (email retries + stale-claim cleanup) every 6 hours with `CRON_SECRET`. It is optional and skips itself without the `APP_URL` variable.

### D-J6 Retention scope
Eligible: applications `closed` (by `closed_at`) **or `withdrawn`** (by `withdrawn_at`) more than `retention_days` ago, not yet purged. Purging deletes all files (versions, thumbnails, packets, receipts), blanks keys, clears packet manifests (they contain surnames), payment references, message bodies, reviewer notes (row and timeline `note`), notification payloads and application notes, and sets the new `applications.purged_at`. The application row stays as the anonymised aggregate. Students are anonymised automatically only when every application is purged, none is active and they have not signed in within the period. `audit_log` is never touched. `planRetention()` is the only planner, used by both the admin dry run and the sweep.

### D-J7 Account deletion (FR-AUD-3)
New table `deletion_requests` (one pending per student). Students may request only when they have no active application. Approval purges all their applications and anonymises the profile immediately (`services/privacy.ts`). The student-facing button belongs to the student UI (functions `requestAccountDeletion`, `getMyDeletionRequest`, `cancelDeletionRequest`); admins decide on `/retention`.

### D-J8 Rule-set editing and migration
Only one draft exists at a time; `saveRuleSetDraft` edits it in place (new audit action `rule_set.draft_updated`). The impact summary is generated from a pure diff (`services/rule-diff.ts`). "Migrate in-flight applications" moves **draft applications only** to the published version and recomputes their checklist; submitted-or-later applications always keep their version, because adding a required document to an application under review would break the review state machine (resolves D-22).

### D-J9 Email copy is versioned, not edited in the UI
FR-ADM-2 "email copy": `/templates` shows a live preview of every email, but copy is edited in `src/i18n/jobs.ts` through code review, so changes are versioned and tested. Reason templates are fully editable (deactivate instead of delete). Emails: 560 px single column, one button plus a plain fallback link, preheader, explicit subjects ("Action needed: fix 1 document for VD-2026-00042"), Runway line in reminders, DOS footer (contact, office hours placeholder, automated-message line).

### D-J10 Bounces
`/api/webhooks/resend` verifies the Svix signature (`RESEND_WEBHOOK_SECRET`, 5-minute timestamp tolerance) and sets `profiles.email_status` to `bounced` on permanent bounces and complaints, back to `ok` on a later delivery (audited `profile.email_status_set`, IDs only). `/api/webhooks/*` is exempt from the proxy's same-origin check (small edit in `src/proxy.ts`).

### D-J11 Backups stay on GitHub
`scripts/backup.ts` dumps via `@libsql/client` (no Turso CLI); the workflow gzips, encrypts with `openssl enc -aes-256-cbc -pbkdf2 -iter 200000`, verifies decryption and uploads a 30-day artifact. `scripts/restore.ts` loads into an empty database; triggers are created after data so the append-only audit triggers do not block the load. Blob files are not backed up (no free second store).

### D-J12 Region `fra1`
Hobby allows one function region. Database round trips dominate latency, so functions, Turso and Blob are co-located in Frankfurt rather than choosing `cpt1`, which has no matching Turso location.

### D-J13 File-key rotation
`keyringFromConfig()` also reads `FILE_ENCRYPTION_PREVIOUS_KEYS` (`id:base64,…`) so old files stay readable during a rotation; `scripts/rotate-file-key.ts` re-encrypts files not on the current key and updates their storage keys (small additive edit in `storage/index.ts`).

### D-J14 First admin
Production seeding creates no users. `scripts/bootstrap-admin.ts --email … --name …` creates or promotes the first `dos_admin` (audited `staff.bootstrapped`, actor null).
