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
