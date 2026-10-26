# VisaDesk performance, load, caching and storage

Wave 3 performance pass, 2026-10-26. This covers what was measured, what changed, and how the free-tier hosting (Vercel Hobby, Turso free, Vercel Blob on Hobby, Resend free) holds up against a semester of real use. Limits were checked against the providers' own pages on 2026-10-26 (links at the end). Re-check them before relying on them, because free tiers change.

**Summary**

- Database round trips on the hot pages dropped by 30–55 %, and the round trips that have to happen one after another (the critical path) dropped by 60–70 %. The staff application page went from 20 round trips to 10, with a critical path of 3 (was 10). A student upload went from 35 to 20.
- On Turso in the same region (about 2 ms per round trip), pages are now database-bound at 10–25 ms. Students in Kampala are about 150–200 ms from Frankfurt, so their latency is dominated by their own network and by JS size, not by the server.
- **The binding free-tier limits are storage and email, not compute.** Vercel Blob on Hobby includes 1 GB of storage and 2,000 uploads ("advanced operations") a month. That is roughly **60–110 applications held at once** and **about 85 new applications a month**. When the limit is exceeded, Blob is **blocked for 30 days**. Resend free allows 100 emails a day, and sign-in codes are not covered by the daily cap. A start-of-semester login burst will exceed it. Both need a decision from the owner before launch (§5, §7).

---

## 1. How to run the checks

| What | Command | Notes |
|---|---|---|
| Round-trip budgets (CI) | `npm test` (includes `tests/perf/roundtrips.test.ts`) | Fails when a change adds a database round trip to a hot path |
| Round-trip table | `npm run test:perf` (or `node scripts/perf/run.mjs log` for every statement) | Prints the table in §3.1 |
| Simulated Turso latency | `npm run perf:sim` (about 5 min) | Injects a delay per round trip, §3.2 |
| JS budgets | `npm run build && npm run perf:js` | First-load JS per route, gzip, §3.4 |
| HTTP load (production build) | see §3.3 | Local SQLite, port 3100, `./data-perf` |

`tests/perf/instrument.ts` wraps the libSQL client and counts what each call would cost over Turso's HTTP protocol: `execute` and `batch` = 1 round trip each, every statement inside an interactive transaction = 1, and `COMMIT`/`ROLLBACK` = 1 (`BEGIN` is pipelined with the first statement). `tests/perf/scenarios.ts` replays the same service calls each page, route or action makes, including the real session lookup.

## 2. What changed

| Change | Where | Effect |
|---|---|---|
| Per-instance read cache for global, rarely-changing data: non-draft rule sets (until invalidated), the active rule-set id, reason templates and settings (60 s) | `src/server/services/read-cache.ts`, wired into `internal.ts` (`loadRuleSet`, `loadActiveRuleSetId`), `rules.ts`, `settings.ts`, `student-view.ts`, `packet-builder.ts` | −2 to −3 round trips on every checklist, detail and packet; −1 on the login page and OTP request |
| `getApplicationDetail` builds the checklist from rows it already loads, instead of calling `getChecklistForApplication` (which re-read the application, profile, student, rule set, documents and versions) | `applications.ts` | Detail: 18/20 → 9/10 round trips |
| `getChecklistForApplication` loads the student row only (not profile + student), and runs its four reads as one parallel wave after the authorization read | `applications.ts` | 7 → 4 round trips, critical path 2 |
| `getOrCreateDraft` reads first and only opens the write transaction when the student has no active application | `applications.ts` | `/apply` and `/profile` no longer take the single SQLite/Turso **write lock** on every view |
| Upload idempotency check is one owner-scoped query (`findActiveVersionByHash`) instead of loading the whole application detail | `documents.ts`, `api/uploads/route.ts` | Upload: 35 → 20 round trips |
| `authorizeVersionFile` reads version + application + document in one join | `documents.ts` | File view: −2 round trips |
| Dashboard summary counts open runway flags in the same statement | `staff.ts` | −1 round trip |
| Blob reads use the Blob CDN cache (`useCache: true`) | `storage/vercel.ts` | Repeat views of a file no longer use the Hobby "simple operations" allowance (§5.2) |
| `parallelReads` helper: independent reads run concurrently on Turso and sequentially on a local file | `internal.ts` | See the local-driver issue in §6 |

## 3. Measurements

### 3.1 Database round trips per request (warm instance)

Counted with `tests/perf/roundtrips.test.ts` on a realistic fixture: a draft with 6 of 7 documents uploaded, a submitted application under review, and an approved application with real encrypted JPEGs. "Before" is commit `d49635a`.

| Hot path | Before | After | Write tx |
|---|---|---|---|
| Session lookup (every authenticated request) | 1 | 1 | 0 |
| Student `/apply` (checklist home) | 10 (+1 write tx) | **6** | 0 (was 1) |
| Student `/documents/[type]` | 9 | **6** | 0 |
| Student `/review` | 15 | **12** | 0 |
| Student `/status` (detail) | 18 | **9** | 0 |
| Staff `/dashboard` (first page or filtered) | 6 | **5** | 0 |
| Staff `/applications/[id]` | 20 | **10** | 0 |
| Staff file view (thumbnail, audited) | 7 | **5** | 1 |
| Student file view (original) | 4 | **2** | 0 |
| `POST /api/uploads` | 35 | **20** | 1 |
| Review decision (server action only) | 10 | 10 | 1 |
| Packet generation | 32 | **22** | 2 |
| Daily cron, per newly flagged student | 7 | 7 | 1 |
| Daily cron, steady state (43 students, nothing new) | 15 | 12 | 1 |

These are now the CI budgets in `tests/perf/roundtrips.test.ts`. Raising one should be a deliberate decision, recorded here.

### 3.2 Simulated latency against Turso

`tests/perf/rtt-sim.test.ts` runs each path against a local SQLite file and injects a fixed delay before every round trip. Parallel reads overlap as they would against Turso. "Critical path" is the number of round trips that cannot overlap, measured with a 100 ms probe delay. The modelled time is local compute + critical path × RTT. Turso in the same region as the function (both `fra1`) is about 1–3 ms; 15–80 ms covers a mis-placed database.

**Before (d49635a)**

| Hot path | RT | Critical path | Local compute | RTT 2 ms | RTT 15 ms | RTT 40 ms | RTT 80 ms |
|---|---|---|---|---|---|---|---|
| Student `/apply` | 10 | 10 | 9 ms | 29 ms | 159 ms | 409 ms | 809 ms |
| Student `/documents/[type]` | 9 | 9 | 9 ms | 27 ms | 144 ms | 369 ms | 729 ms |
| Student `/review` | 15 | 9 | 118 ms* | 136 ms | 253 ms | 478 ms | 838 ms |
| Student `/status` | 18 | 11 | 24 ms | 46 ms | 189 ms | 464 ms | 904 ms |
| Staff `/dashboard` | 6 | 3 | 10 ms | 16 ms | 55 ms | 130 ms | 250 ms |
| Staff `/applications/[id]` | 20 | 10 | 31 ms | 51 ms | 181 ms | 431 ms | 831 ms |
| Staff thumbnail view | 7 | 7 | 6 ms | 20 ms | 111 ms | 286 ms | 566 ms |
| Student original view | 4 | 4 | 11 ms | 19 ms | 71 ms | 171 ms | 331 ms |
| `POST /api/uploads` (597 KB JPEG) | 35 | 29 | 691 ms* | 749 ms | 1126 ms | 1851 ms | 3011 ms |
| Review decision | 10 | 10 | 23 ms | 43 ms | 173 ms | 423 ms | 823 ms |
| Packet generation | 32 | 25 | 224 ms | 274 ms | 599 ms | 1224 ms | 2224 ms |

\* One-off outliers on a busy machine (JIT and sharp warm-up). The critical-path column is the reliable one.

**After**

| Hot path | RT | Critical path | Local compute | RTT 2 ms | RTT 15 ms | RTT 40 ms | RTT 80 ms |
|---|---|---|---|---|---|---|---|
| Session lookup | 1 | 1 | 2 ms | 4 ms | 17 ms | 42 ms | 82 ms |
| Student `/apply` | 6 | 4 | 6 ms | 14 ms | 66 ms | 166 ms | 326 ms |
| Student `/documents/[type]` | 6 | 4 | 5 ms | 13 ms | 65 ms | 165 ms | 325 ms |
| Student `/review` | 12 | 5 | 9 ms | 19 ms | 84 ms | 209 ms | 409 ms |
| Student `/status` | 9 | 4 | 6 ms | 14 ms | 66 ms | 166 ms | 326 ms |
| Staff `/dashboard` | 5 | 3 | 6 ms | 12 ms | 51 ms | 126 ms | 246 ms |
| Staff `/dashboard` (filtered + search) | 5 | 3 | 19 ms | 25 ms | 64 ms | 139 ms | 259 ms |
| Staff `/applications/[id]` | 10 | 3 | 7 ms | 13 ms | 52 ms | 127 ms | 247 ms |
| Staff thumbnail view | 5 | 5 | 5 ms | 15 ms | 80 ms | 205 ms | 405 ms |
| Student original view | 2 | 2 | 6 ms | 10 ms | 36 ms | 86 ms | 166 ms |
| `POST /api/uploads` (597 KB JPEG) | 20 | 19 | 211 ms | 249 ms | 496 ms | 971 ms | 1731 ms |
| Review decision | 10 | 10 | 12 ms | 32 ms | 162 ms | 412 ms | 812 ms |
| Packet generation | 22 | 19 | 189 ms | 227 ms | 474 ms | 949 ms | 1709 ms |

What this means:

- At the deployed placement (function and Turso both in Frankfurt, about 2 ms), every page renders its data in **10–25 ms**. That is negligible next to the 150–200 ms Kampala ↔ Frankfurt network round trip. Uploads (~250 ms) and packets (~230 ms) are bound by image processing CPU (sharp, fflate, AES), not by the database.
- **Keep Turso and the function region together.** If they drift apart (for example a function in `cpt1` and a database in `fra1`, about 40 ms), the staff application page goes from 13 ms to 127 ms. A review decision goes from 32 ms to 412 ms, holding the database's single write lock the whole time.
- Write transactions are the remaining long sequences: upload registration has 13 statements in one transaction, and a review decision has 10. Each holds the write lock for all its round trips, and Turso, like SQLite, has one writer. At 2 ms per round trip that is 20–30 ms of lock time, so roughly 30–50 writes per second are possible. That is far above VisaDesk's load. At 40 ms it would be about 2 writes per second, another reason to keep the database co-located.

### 3.3 HTTP load on a production build (local)

`next build` and `next start -p 3100` on `./data-perf`, seeded by `scripts/perf/seed-perf.ts`. The seed has 2,000 students and 1,500 applications in a realistic mix of states, with versions, events, notifications, a valid audit chain and encrypted blobs. The load came from `scripts/perf/load.mjs` (autocannon, every request authenticated with a real session). The database is a **local file**, so this measures server CPU per request on this laptop, not Turso latency.

Seeded database: 2,005 profiles, 1,800 applications, 13,488 application documents, 13,206 versions, 23,275 audit rows, 26,412 encrypted blob files. The database is 44.7 MB. The seed took 24 min, mostly writing blob files.

10 concurrent connections, 10 s per scenario. The laptop was shared with a running `next dev` and Playwright session, so treat absolute numbers as pessimistic and compare rows with each other:

| Scenario | req/s | p50 | p90 | p99 | non-2xx / errors |
|---|---|---|---|---|---|
| `GET /api/health` (no session) | 53 | 128 ms | 373 ms | 1,023 ms | 0 |
| Student `/apply` | 28 | 298 ms | 621 ms | 808 ms | 0 |
| Student `/status` | 43 | 221 ms | 283 ms | 390 ms | 0 |
| Staff `/dashboard` (1,800 applications) | 7 | 1,329 ms | 1,464 ms | 1,753 ms | 0 |
| Staff `/applications/[id]` | 29 | 325 ms | 396 ms | 621 ms | 0 |
| Staff thumbnail `/api/files/[id]` (audited write) | ~1–2 | 330–700 ms serially; 6.5 s at 10 connections | | | timeouts at 10 connections |

What the numbers show:

- **Pages are cheap.** On one Node process a student page costs about 25–35 ms of server time (10 connections ÷ ~30–40 req/s). The staff dashboard is the heaviest page at about 140 ms per render with 1,800 applications: its summary and list count scan `applications`. It still meets NFR-PERF (500 applications in under 1.5 s) with a wide margin when serial. On Turso that scan time moves from the function's Active CPU to the database (and counts as rows read, §5.1).
- **Single-request latency (warm, serial):** `/apply` 67–87 ms, `/applications/[id]` 96–125 ms, `/dashboard` 306 ms.
- **The audited file view is slow only on a local file.** Every staff or admin file view writes an audit row in a write transaction. On a local libSQL file each commit fsyncs (pooled connections keep `synchronous=FULL`, and Windows fsync is slow). Concurrent `BEGIN IMMEDIATE`s also busy-wait inside the native driver, which blocks Node's event loop, so at 10 concurrent viewers requests queue for seconds. Turso writes are asynchronous network calls, so this does not apply in production. In production each audited view costs 3 extra round trips (~6 ms) inside the single write lock. It is a known cost of auditing every view (SECURITY.md). It explains slow thumbnail grids in **local dev and e2e** when many images load at once.

### 3.4 First-load JavaScript (production build)

`node scripts/perf/js-budget.mjs`: root runtime chunks plus every chunk the route's segments load, gzip -9. The budget (NFR-PERF) is under 200 KB gzip for student routes. The check also fails if `heic2any` or `pdfjs-dist` end up in any route's initial chunks: they must load on demand only.

Measured after the production build of this branch: **all student routes are within budget**, and no route loads `heic2any` or `pdfjs-dist` eagerly.

| Route group | Routes | First-load JS (gzip) |
|---|---|---|
| Shared framework and runtime (every route) | — | 129.1 KB |
| Student | `/apply`, `/checklist` 145.9 · `/messages` 147.6 · `/review` 150.3 · `/status` 151.1 · `/documents/[type]` 159.3 · **`/profile` 186.2** | 146–186 KB (budget 200) |
| Auth | `/login` 138.7 · `/verify` 142.2 | 139–142 KB |
| Staff | `/packets` 145.3 · `/applications/[id]` 185.4 · `/dashboard` 186.6 · `/review-mode` 187.2 | 145–187 KB |
| Admin | `/analytics`, `/audit` 151.0 · … · `/rules` 156.2 | 151–156 KB |

Lazy chunks that load on demand only: `heic2any` 330 KB gzip (HEIC photos only), `pdfjs-dist` 350 + 124 KB gzip (PDF pages only).

`/profile` is the student route closest to the budget (14 KB of headroom). It carries the form stack (react-hook-form, zod schemas). Any new client dependency on that page needs care, so check with `npm run perf:js` after changes.

## 4. Load balancing, scaling and cold starts (Vercel Hobby)

**What Vercel provides.** There is nothing to configure: no load balancer, instance count or autoscaling policy. Requests reach Vercel's edge network, and the proxy runs `src/proxy.ts`, which only sets the CSP nonce and checks same-origin. Vercel then routes each request to a function instance in the single region set in `vercel.json` (`fra1`; Hobby allows one region). With Fluid compute (the default for new projects) **one instance serves many requests at once**. That suits VisaDesk, because most request time is spent waiting on Turso and Blob, not computing.

| Hobby limit | Value | VisaDesk usage / headroom |
|---|---|---|
| Concurrency | Auto-scales to 30,000; burst of 1,000 new concurrent executions per 10 s per region; beyond that `503 FUNCTION_THROTTLED` | A university office will not approach this. A start-of-semester peak of a few hundred students is tens of concurrent requests. |
| Max duration | 300 s (default and maximum) | Packet POST sets 60 s; cron jobs use a 40 s budget and continue on the next run |
| Memory / CPU | 2 GB / 1 vCPU per instance | sharp re-encodes one ≤ 12 MP image per upload; fine |
| Request / response body | 4.5 MB | Uploads are ≤ 3 MB JPEGs (`MAX_REQUEST_BYTES` 4.4 MB); packet downloads stream |
| Function invocations | 1,000,000 / month | ~25 per student application lifecycle plus page views; under 5 % even at 1,000 applications |
| Active CPU | 4 h / month | About 0.25 s CPU per upload, 5–30 ms per page. 1,000 applications × 12 uploads ≈ 50 min; page views are smaller |
| Provisioned memory | 360 GB-hrs / month (2 GB × ~180 instance-hours) | Counted while an instance is serving. At 15–30 ms per page this allows millions of requests |
| Fast Data Transfer | 100 GB / month | Uploads in plus files and packets out: about 20–25 MB per application, so about 4,000 applications |
| Cron jobs | Once a day, ±59 min precision | Daily runway at 03:00 UTC, retention at 03:30 UTC. The optional GitHub Actions workflow calls `/api/cron/flush` every 6 h |
| Commercial use | **Hobby is for non-commercial personal use only** | A university office using it is probably commercial use under Vercel's definition. Open question for the owner (already in the build notes) |

**Cold starts.** A new instance has to load the Next server and the route's bundle, plus the libSQL client, and sharp for the upload route. It also opens its first HTTPS connection to Turso. Fluid compute reuses warm instances, so cold starts mainly hit the first request after a quiet period (overnight, at weekends), or new instances during a sudden ramp-up. Locally, on a freshly started production server, the first request to each route took 0.9–3.9 s (`/apply` 2.8 s, `/applications/[id]` 0.87 s, `/dashboard` 3.9 s), against 67–306 ms warm. That cost is loading each route's server bundle the first time. On Vercel, expect a few hundred ms more for the first request on a new instance. The per-instance read cache starts empty, so the first checklist on a new instance costs about 3 extra round trips (~6 ms in-region). Students see this as one slower page, not an error. Nothing here needs a keep-warm ping, and Hobby crons can't run often enough to provide one anyway.

**Where the real bottlenecks are.** These are the **single database writer** (§3.2, so keep transactions short and the database co-located) and the provider quotas in §5 and §7. Raw compute or concurrency is not one of them.

## 5. Storage

### 5.1 Database (Turso free)

| Limit (free plan) | Value | VisaDesk |
|---|---|---|
| Storage | 5 GB | The perf seed (2,000 students, 1,800 applications, full history, audit chain) is **44.7 MB**, about 25 KB per application. 5 GB is more than 100,000 applications |
| Rows read | 500 M / month | Biggest readers: the dashboard summary and list count (each scans `applications`, ~3 × N rows per dashboard load), the daily runway job (all students once), and audit-chain verification (all audit rows). At 1,500 applications, 5 staff × 100 dashboard loads a day ≈ 70 M rows a month. Comfortable, but this is the metric to watch if the dashboard gets busier |
| Rows written | 10 M / month | An upload writes about 6 rows, a review about 5. Negligible |
| Point-in-time restore | 1 day | Plus the nightly encrypted GitHub artifact backup (RUNBOOK §4) |

### 5.2 Files (Vercel Blob on Hobby) — the tightest limit

| Limit (Hobby, included per month) | Value |
|---|---|
| Storage | **1 GB** (monthly average) |
| Advanced operations (upload, copy, list) | **2,000** |
| Simple operations (read that misses the CDN cache, `head`) | 10,000 |
| Blob data transfer | 10 GB |
| On exceeding any of them | **Blob is unavailable until 30 days have passed.** Students cannot upload and staff cannot view documents or build packets |

**Usage per application (assumptions).** There are 7–9 checklist items, about 9 files once multi-page items are counted, and about 15 % re-uploads (retakes and rejections), so ~10.5 stored versions. Each version is one encrypted JPEG (≤ 3 MB, typically 0.6–1.2 MB after server re-encoding; ~0.8 MB assumed) plus one ~30 KB thumbnail. Each approved application also gets a packet ZIP (~7.5 MB), and some get a payment receipt (~0.3 MB).

| Per application | Estimate | Hobby allowance | Applications covered |
|---|---|---|---|
| Storage (documents) | ~8.7 MB | 1 GB | **~115 held at once** |
| Storage (documents + packet) | ~16 MB | 1 GB | **~60 held at once** |
| Advanced ops (2 puts per version + packet + receipt) | ~23 | 2,000 / month | **~85 new applications a month** |
| Simple ops (first view of each thumbnail and original, packet build reads; repeat views are now CDN hits) | ~25 | 10,000 / month | ~400 a month |
| Blob data transfer (staff views, packet build, packet download) | ~22 MB | 10 GB / month | ~450 a month |

Retention deletes files 90 days after an application closes (deletes are free), so storage is the sum of open applications plus the last 90 days of closed ones. **Even a modest intake (150–300 international students per semester, most applying in the first 4–6 weeks) exceeds both the storage and the upload allowance, and the penalty is a 30-day outage.** The RUNBOOK's earlier "watch usage at ~1,000 active applications" was far too optimistic and has been corrected.

Options, cheapest first. The owner needs to decide before launch:

1. **Vercel Pro ($20/month)** removes the cliff (usage-based Blob, the 30-day block becomes a bill of a few dollars) and also settles the commercial-use question. This is the simplest fix.
2. **Halve the uploads per version** by not storing thumbnails in Blob: either keep them in Turso as a small BLOB column (~30 KB × 10.5 ≈ 315 KB per application; Turso has 5 GB and counts rows, not bytes), or generate them on demand from the original. Advanced ops fall to ~12 per application (~165 a month). Storage stays at 1 GB.
3. **Do not store packets.** Rebuild the ZIP on each download (the build takes ~230 ms and is already verified against stored hashes). This saves ~7.5 MB and 1 upload per application.
4. **Another free object store for documents** behind the existing `BlobStore` interface (for example Backblaze B2's 10 GB free tier). This keeps Hobby but adds a provider and a second set of credentials. It conflicts with D-01's "Vercel + GitHub only".
5. In any case, **set up Vercel usage alerts and check the Blob page weekly** during intake.

### 5.3 Email (Resend free)

| Limit | Value |
|---|---|
| Per day | **100** emails, including sign-in codes |
| Per month | **3,000** |

How VisaDesk sends today:

- **Sign-in codes are sent immediately** (`sendEmailNow` in `auth/otp.ts`) and are **not counted** against `EMAIL_DAILY_CAP`. The cap only counts rows in `notifications` that were sent.
- Notifications (receipt, corrections, approval, reminders) are queued. They are flushed right after the user action (`after()`, uncapped) and by the cron (capped at 80 per rolling 24 h).

**The start-of-semester risk.** Student sessions last 30 days (sliding), so each student needs a code on the first visit and whenever they switch device or browser. Suppose 300 new international students are told on the same day to "apply on VisaDesk". Assume half sign in on days 1–2 and ~1.3 codes each (typos, expired codes, "resend"). That is **about 100–200 codes a day on day 1–2, which alone exceeds 100/day.** Once Resend refuses, both sign-ins *and* receipts fail for the rest of the day, and the receipts sent via `after()` add to the overrun. The 3,000/month cap is also reachable during intake (about 300 students × (2 codes + 4 notifications) ≈ 1,800, plus staff sign-ins and reminders).

Mitigations, in order of effect:

1. **SSO for university accounts** (`feature_flags.sso` already exists). If Cavendish uses Microsoft 365 or Google Workspace, signing in with it costs no email at all. This is the only option that removes the problem.
2. **Stagger onboarding.** Invite cohorts (by faculty or intake list) over 3–5 days instead of one announcement. This is free and immediate.
3. **One shared daily email budget** (code change, recommended next). Count OTP sends in the same rolling 24 h window. Reserve them first: for example notifications only flush while `sent24h < 100 − otpReserve` (where `otpReserve` ≈ 40). When the budget is exhausted, say on the sign-in page "Too many sign-ins today, please try again after 06:00", instead of failing silently. Also send `after()` flushes through `flushWithinCap`.
4. **Longer student sessions during intake.** For example 120 days instead of 30 for students: fewer repeat codes, at a small security cost.
5. **A second free email provider as overflow** behind `NotificationChannel` (for example Brevo's free tier) when Resend returns a quota error. It needs its own domain verification.
6. **Resend Pro** (paid) if the intake is large.

## 6. Caching: what is cached where

| Layer | What | Freshness / invalidation | Risk |
|---|---|---|---|
| **Per-instance read cache** (`read-cache.ts`, module memory, namespaced per DB handle, values deep-frozen) | Non-draft rule set by id | Until the instance dies. Published and retired rule sets are immutable in the app (only drafts are editable) | **Editing a published rule set directly in SQL** (Turso console) would be served stale by warm instances until they recycle. Never do it; if you must, redeploy afterwards |
| | Active rule-set id | 60 s; invalidated on publish on the instance that published | Another warm instance may start a student's draft on the previous version for up to 60 s. Same effect as starting a minute earlier; the admin "migrate drafts" action fixes it |
| | Reason templates | 60 s; invalidated by `saveReasonTemplate` | A just-deactivated template can appear in another instance's picker for ≤ 60 s. `reviewDocument` still checks `active` in the database inside its transaction, so it can never be *used* |
| | Settings (allowed domains, retention days, feature flags) | 60 s; invalidated by `updateSetting` | Removing an allowed domain takes up to 60 s to apply on other instances |
| **Per request** | `getActor()` (session lookup) via React `cache()` | One request | None |
| **Blob CDN** | Encrypted bytes of each blob (`useCache: true`) | Pathnames are never reused (random suffix); a deleted blob may stay cached briefly | Cached content is AES-GCM ciphertext; the key is never in Blob |
| **Browser** | Next static assets (immutable hashed chunks) | Forever (content-hashed) | None |
| | Document files | `Cache-Control: private, no-store` (security decision) | Every view goes back to the server. Repeat views now hit the Blob CDN, so they cost no quota, but they still cost a function call and the student's bandwidth |
| **Not used** | Next data cache, `unstable_cache` / `'use cache'`, full-route cache | — | Every page depends on the session cookie, and the services also run from cron, scripts and tests outside a Next request. On Vercel the data cache is itself a network hop, so it would not beat a 2 ms Turso round trip. Per-instance memory is cheaper and simpler for this data |

Safety rules (enforced in code and tested in `tests/integration/read-cache.test.ts`):

- **Only global, non-personal data is cached.** There is no actor, profile, application or document data in the cache, and keys never contain user ids. A test drives student and staff paths and asserts that every key matches the allow-list. Authorization runs before a cached read; per-actor filtering and redaction run after it.
- Values are deep-frozen, so a caller that mutated a shared cached object would throw instead of leaking changes into other requests.
- Failed loads are not cached. Concurrent misses share one load. A load that started before an invalidation is not stored.
- It is safe on serverless: memory only, a handful of entries (rule sets × a few KB), no cross-instance coherence assumed, and short TTLs for anything mutable.

**Local-driver issue found during this work.** With a local `file:` database, the libSQL 0.18 client keeps a pool of connections. Under concurrent reads, one pooled connection was observed returning a **stale snapshot** (24 rows instead of 73 for the same `count(*)` in one `Promise.all`). This could not be reproduced in isolation, so the root cause is unknown. Turso over HTTP is not affected, because each statement is its own request. So services run independent reads through `parallelReads()`: in parallel on Turso, sequentially on a local file, where a round trip costs ~0 anyway. Override with `DB_PARALLEL_READS=1|0`; the RTT simulation forces `1`. Older `Promise.all` calls of top-level reads in pages (dashboard, packet plan) still run concurrently locally. If dev or e2e ever shows a page with data "missing" that is in the database, this is the first suspect.

## 7. Risks and recommendations

1. **Blob quota (high).** At ~85 new applications a month and ~60–115 held at once, Hobby Blob will be exceeded in the first intake, and the penalty is a 30-day outage of uploads and document views. Decide before launch: Pro, or thumbnails out of Blob plus packets rebuilt on demand (§5.2).
2. **Email quota (high).** Sign-in codes bypass the 80/day cap, and a launch-day announcement will exceed 100/day. Use SSO if available. Otherwise stagger invites and implement the shared daily budget with an OTP reserve (§5.3).
3. **Hobby is non-commercial.** A university deployment probably needs Pro anyway. Pro also fixes risk 1.
4. **Keep the function region and Turso co-located** (`fra1`). Every page has a 3–5 round-trip critical path and every write transaction holds the single write lock for all its round trips (§3.2).
5. **Turso rows read** is the database metric to watch as the dashboard gets busier (§5.1). If needed, cache the dashboard summary per instance for ~15 s; it is not personal data.
6. **Never edit published rule sets, templates or settings directly in SQL.** Use the admin UI, which invalidates the caches; otherwise redeploy (§6).

## Sources (checked 2026-10-26)

- Vercel limits: <https://vercel.com/docs/limits>, fair-use allotments: <https://vercel.com/docs/limits/fair-use-guidelines>, functions: <https://vercel.com/docs/functions/limitations>, concurrency: <https://vercel.com/docs/functions/concurrency-scaling>, cron: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- Vercel Blob pricing and Hobby limits: <https://vercel.com/docs/vercel-blob/usage-and-pricing>
- Turso pricing: <https://turso.tech/pricing>
- Resend pricing: <https://resend.com/pricing>
