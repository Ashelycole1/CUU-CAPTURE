# VisaDesk: Contracts for parallel agents

This is the foundation API. The student UI, staff UI and jobs/infra agents build on it **without changing it**. If you need a contract change, add a new function or field (additive only) and note it in `docs/DECISIONS.md`. Do not change existing signatures or semantics.

Read first: `docs/DECISIONS.md` (especially D-01 platform, D-14 lifecycle, D-20 notifications).

---

## 1. Platform summary

| Concern | Choice | Where |
|---|---|---|
| Hosting | Vercel Hobby (serverless) + GitHub | `vercel.json`, `next.config.ts` |
| App | Next.js 16 App Router, TS strict, `src/`, single app at the repo root | `src/app` |
| DB | libSQL via `@libsql/client` + Drizzle (`sqlite-core`). Local `file:` / Turso in production. **Async.** | `src/server/db` |
| Files | `BlobStore` → `EncryptedBlobStore` (AES-256-GCM) over `VercelBlobStore` (prod) / `LocalDiskStore` (dev) | `src/server/storage` |
| Email | `NotificationChannel`: `ResendChannel` (prod) / `DevOutboxChannel` (dev, `/dev/outbox`) | `src/server/notify` |
| Auth | Own email OTP + DB sessions | `src/server/auth` |
| Authz | Policy module (replaces RLS) | `src/server/authz.ts` |
| Jobs | `GET /api/cron/*` with `Authorization: Bearer $CRON_SECRET`, daily at 03:00 UTC | `src/app/api/cron` |

Commands: `npm run dev | build | start | typecheck | lint | test | db:generate | db:migrate | db:seed | db:reset`.
First run: `npm run db:reset` (creates `./data/visadesk.db`, migrates, seeds dev users), then `npm run dev`, then sign in as `student1@cavendish.ac.ug` / `staff@cavendish.ac.ug` / `admin@cavendish.ac.ug` and read the code at **http://localhost:3000/dev/outbox**.

**Do not run `npm install`.** Every dependency is already installed: next, react, drizzle-orm, @libsql/client, @vercel/blob, zod, react-hook-form, @hookform/resolvers, sharp, pdf-lib, fflate, heic2any, pdfjs-dist, lucide-react, clsx, server-only; dev: drizzle-kit, vitest, @vitest/coverage-v8, @playwright/test (no browsers downloaded), tsx, typescript, eslint, prettier, tailwindcss, autocannon. There is **no node-cron and no better-sqlite3**.

---

## 2. Directory ownership

| Path | Owner | Notes |
|---|---|---|
| `src/domain/**` | foundation (additive changes OK) | Pure TS. No `@/server`, `next/*`, `react`, `node:*` (ESLint enforces it). Safe in client components. |
| `src/i18n/en.ts` | shared | **Add** keys freely (namespaced: `student.*`, `staff.*`, `admin.*`, `jobs.*`). Don't rename existing keys. |
| `src/server/db/schema.ts`, `drizzle/**` | foundation | Need a column or table? Add it, run `npm run db:generate -- --name <what>`, commit the SQL. Never edit an applied migration. **Coordinate:** only one agent should generate a migration at a time (see §13). |
| `src/server/services/**` | foundation | The ONLY way state changes. You may add new service files (e.g. `jobs.ts`, `packet-builder.ts`) that follow the same rules (§5). |
| `src/server/{auth,authz.ts,audit.ts,errors.ts,config.ts,http}` | foundation | Use them; don't fork them. |
| `src/server/storage/**` | foundation + infra | Infra may add drivers. Keep the `BlobStore` interface. |
| `src/server/notify/**` | foundation + jobs | Jobs may improve `templates.ts` copy and design. Keep `renderEmail(kind, ctx)` and the `NotificationKind` names. |
| `src/components/ui/**`, `src/components/runway/**` | foundation | Shared. Additive props only. |
| `src/components/student/**`, `src/app/(student)/**` | **student UI agent** | Replace the stubs `apply`, `status`, `messages`. Add `checklist`, `documents/[type]`, `review`, `profile`, … |
| `src/app/api/uploads/**` | **student UI agent** (upload pipeline) | See §8. |
| `src/components/staff/**`, `src/app/(staff)/**`, `src/app/(admin)/**` | **staff UI agent** | Replace the stubs `dashboard`, `rules`. Add `applications/[id]`, `review-mode`, `packets`, `staff`, `templates`, `audit`, … |
| `src/app/api/packets/**`, `src/server/services/packet-builder.ts` | staff UI or jobs agent (whoever is assigned packets) | Uses `startPacket`/`completePacket` (§5.6). |
| `src/app/api/cron/**`, `src/server/jobs/**`, `vercel.json` | **jobs/infra agent** | Replace the stub bodies. |
| `tests/helpers/**` | foundation (additive) | Reuse `createTestDb` and the factories. |
| `tests/<area>/**` | each agent | e.g. `tests/student/`, `tests/staff/`, `tests/jobs/`. |

Route groups do not add URL segments: `(student)/apply` → `/apply`, `(staff)/dashboard` → `/dashboard`, `(admin)/rules` → `/rules`. Each group's `layout.tsx` already enforces the role server-side (students → `/apply`, others → `/dashboard`). **Still check roles in services.** Layouts are UX, not security.

---

## 3. Getting the current actor

```ts
import { getActor, requireActor, requireActorOrThrow, homePathFor } from '@/server/auth/current';
import type { Actor } from '@/server/authz';
// Actor = { id: string; role: 'student'|'dos_staff'|'dos_admin'|'liaison'|'system'; email: string; fullName: string|null }
```

| Context | Call | On failure |
|---|---|---|
| Server Component / layout / page | `const actor = await requireActor(['student'])` | redirects to `/login`, or to the role home if the role is wrong |
| Optional (public page) | `const actor = await getActor()` | `null` |
| Route handler | `const actor = await requireActorOrThrow(['dos_staff','dos_admin'])` inside `route(...)` | throws `UnauthenticatedError` (401) / `ForbiddenError` (403), which `route()` maps to JSON |
| Server Action | `const actor = await requireActorOrThrow()` | throws, so catch it and map with `toErrorBody(e)` |
| Cron / system job | `import { SYSTEM_ACTOR } from '@/server/authz'` | System is allowed by `assertStaffOrSystem` only. Most staff services require a real staff actor, so jobs should call the lower-level helpers (§12). |

`getActor` is wrapped in React `cache()`, so it runs once per request. The role is read from `profiles` through the session join on every request (FR-AUTH-2). Sessions slide: 12 h idle for staff, 30 days for students.

Sign out: `<SignOutButton />` from `@/components/auth/sign-out-button` (server action, POST).

---

## 4. Writing an authz-checked route handler / server action

```ts
// src/app/api/example/[id]/route.ts
import { NextResponse, after } from 'next/server';
import { requireActorOrThrow } from '@/server/auth/current';
import { route, assertSameOrigin } from '@/server/http';
import { flushNotifications } from '@/server/notify';
import { markApproved } from '@/server/services';

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  assertSameOrigin(req);                       // CSRF (proxy.ts also blocks cross-origin /api mutations)
  const actor = await requireActorOrThrow();   // role checks happen inside the service
  const { id } = await params;
  const app = await markApproved(actor, id);   // throws typed errors → route() maps to JSON + status
  after(() => flushNotifications());           // deliver queued emails after the response
  return NextResponse.json({ application: app });
});
```

Server Action pattern (Next checks Origin for actions automatically):

```ts
'use server';
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireActorOrThrow } from '@/server/auth/current';
import { toErrorBody } from '@/server/errors';
import { flushNotifications } from '@/server/notify';
import { submitApplication } from '@/server/services';

export async function submitAction(applicationId: string) {
  try {
    const actor = await requireActorOrThrow(['student']);
    const app = await submitApplication(actor, applicationId);
    after(() => flushNotifications());
    revalidatePath('/status');
    return { ok: true as const, ref: app.ref };
  } catch (e) {
    return { ok: false as const, ...toErrorBody(e).body };  // { error: { code, message, fieldErrors?, details? } }
  }
}
```

Error JSON shape (from `route()` / `toErrorBody`): `{ error: { code: 'NOT_FOUND'|'FORBIDDEN'|'UNAUTHENTICATED'|'INVALID_STATE'|'VALIDATION'|'RATE_LIMITED'|'CONFLICT'|'INTERNAL', message, fieldErrors?, details? } }`. HTTP status: 404/403/401/409/422/429/409/500. `429` responses also carry `Retry-After`.

---

## 5. Services (`import { … } from '@/server/services'`)

**Rules every service follows (and new services must follow too):**
1. First argument is `actor: Actor`, and the service authorizes before reading or writing.
2. All writes for one call happen in **one** write transaction (`withTx` in `services/internal.ts`, which is `BEGIN IMMEDIATE` with retry on busy or an audit fork).
3. Every state change writes an `application_events` row (the student timeline; staff-only events use `visibleToStudent:false`) **and** an `audit_log` row (`writeAudit`, meta = IDs and codes only) in that same transaction.
4. Status changes go through `transition(tx, actor, app, action, extra)`, which validates against `src/domain/state.ts`.
5. Notifications are queued with `queueNotification(tx, …)` inside the transaction. Callers deliver after commit with `flushNotifications()`.
6. Inputs are re-validated with the shared Zod schemas from `@/domain/schemas`.

Typed errors (`@/server/errors`): `NotFoundError` (404; also returned when a student asks for someone else's row), `ForbiddenError` (403, wrong role), `UnauthenticatedError` (401), `InvalidStateError` (409, not allowed in this state; `details.from/action`), `ConflictError` (409, e.g. claim held or seq race; `details`), `ValidationError` (422, `fieldErrors: Record<field,message>`, `details`), `RateLimitedError` (429, `retryAfterSeconds`). `isServiceError(e)`, `toErrorBody(e)`.

Row types are Drizzle `$inferSelect` types: `Application`, `ApplicationDocument`, `DocumentVersion` (exported from services). Dates are `YYYY-MM-DD` strings and timestamps are ISO strings.

### 5.1 Student: application and profile (`services/applications.ts`)

| Function | Who | Semantics | Errors |
|---|---|---|---|
| `getOrCreateDraft(actor): Promise<Application>` | student | Returns the active application (any active status), or creates a `draft` under the current published rule set with `application_documents` from the checklist (if the profile has type and nationality). Idempotent and race-safe. | Forbidden (non-student), InvalidState (no rule set) |
| `getMyActiveApplication(actor): Promise<Application \| null>` | student | Does not create. | |
| `listMyApplications(actor): Promise<Application[]>` | student | Newest first (history is read-only). | |
| `getStudentProfile(actor, profileId = actor.id): Promise<StudentProfileView>` | student (self) / staff | `{profileId,email,fullName,studentNo,nationality,studentType,programme,phone,passExpiry,noPass}` | NotFound |
| `updateStudentProfile(actor, patch: ProfilePatch): Promise<StudentProfileView>` | student | Autosave (FR-APP-1/3). Every field optional and validated by `profilePatchSchema`. Recomputes the draft checklist: new items are `missing`, items that no longer apply get `required=false` (kept), fee status is recomputed. **Locked once submitted.** | Validation (`studentNo` duplicate → "already registered…"), InvalidState (submitted) |
| `updateApplicationFields(actor, applicationId, patch: ApplicationFieldsPatch): Promise<Application>` | owner, draft only | `{noPass?, currentExpiry?, requestedMonths? (3\|6\|12), notes?}`. `noPass:true` clears the expiry. Also syncs `students.pass_expiry/no_pass`. Unknown keys are ignored. | NotFound, Forbidden, InvalidState, Validation |
| `getChecklistForApplication(actor, applicationId, today?): Promise<ChecklistView>` | owner / staff | `{applicationId,status,ruleSetVersion,profileComplete,items:[{item: ChecklistItem, document, currentVersions:[{id,page,seq,width,height,bytes,uploadedAt}], canUpload}], notRequired, feeRequired, feeUsd, feeStatus, runway: RunwaySummary, progress:{done,total}}`. `item` includes `name, helpText, whereToGet, examplePath, minFiles, universityAddition`. | NotFound |
| `getSubmitBlockers(actor, applicationId): Promise<SubmitBlockers>` | owner | `{missingDocs: docCode[], profileErrors, fieldErrors}`. All empty means ready (FR-SUB-2 button copy). | NotFound |
| `submitApplication(actor, applicationId): Promise<Application>` | owner, draft | Checks profile, fields and that every required doc is `uploaded`. Assigns `ref` VD-YYYY-NNNNN, sets `submittedAt` and fee status, `draft→submitted`, queues `receipt` (dedupe `receipt:{id}`). If the pass has expired, alerts admins. | Validation (`details` = blockers), InvalidState |
| `withdrawApplication(actor, applicationId): Promise<Application>` | owner | Allowed from draft/submitted/under_review/corrections_needed. Releases the claim. | InvalidState |
| `getApplicationDetail(actor, applicationId): Promise<ApplicationDetail>` | owner / staff | `{application, student, ruleSetVersion, checklist, documents:[…doc, versions[]], events, messages, payments, packets}`. **Students:** staff-only events, internal notes, `claimedBy/claimedUntil/approvedBy`, `reviewerId`, storage keys, payments and packets are removed or emptied. | NotFound |
| `syncApplicationDocuments(tx, app, student)` | internal | Exported for jobs/admin migration tooling. | |
| `notifyAdmins(tx, dedupePrefix, applicationId, text)` | internal | Queues `staff_alert` to every active admin. | |

### 5.2 Documents, uploads, review (`services/documents.ts`)

| Function | Who | Semantics | Errors |
|---|---|---|---|
| `prepareDocumentUpload(actor, {applicationId, docCode, page?=1}): Promise<PreparedUpload>` | owner | Read-only authz and state check. Returns `{applicationDocumentId, seq, storageKey, thumbKey}` with keys `{appId}/{docCode}/{seq}.jpg` and `…_thumb.jpg`. | NotFound, InvalidState (approved / not editable / not required), Validation (page out of 1..minFiles) |
| `registerDocumentVersion(actor, input: RegisterVersionInput): Promise<RegisterVersionResult>` | owner | Call **after** server validation and `put`. Input `{applicationId, docCode, page?, seq, storageKey, thumbKey?, sha256 (64 hex), width, height, bytes, quality?}` where **storageKey/thumbKey are the keys returned by `put`**. Supersedes the previous version of that page. The doc becomes `uploaded` when all pages are present (reviewer fields cleared). Returns `{version, document, application, duplicateOf: docCode[]}` (FR-UP-6 warning). If it was the last rejected doc of a `corrections_needed` app, the app moves to `under_review`. Allowed: draft (doc not approved); under_review/corrections_needed (doc `rejected` only). | NotFound, InvalidState, Conflict (seq taken: re-prepare and retry), Validation |
| `listDocumentVersions(actor, documentId): Promise<DocumentVersion[]>` | owner / staff | Full history, newest first. Students get blank storage keys. | NotFound |
| `claimApplication(actor, applicationId, now?): Promise<Application>` | staff | 15-min claim (refreshing your own claim extends it). `submitted→under_review`. | Conflict (`details.claimedBy/claimedUntil`), InvalidState |
| `releaseClaim(actor, applicationId): Promise<Application>` | staff (own) / admin (any) | | Conflict |
| `reviewDocument(actor, {documentId, decision:'approve'\|'reject', reasonCode?, note?}, now?): Promise<ReviewResult>` | staff | Reject needs an active `reasonCode` (and a `note` if `other`). Only `uploaded` docs. Refreshes the claim. When no required doc is left pending and ≥1 is rejected: `under_review→corrections_needed` and ONE `corrections_needed` email listing every rejected doc (dedupe `corrections:{appId}:{round}`). All approved: status stays `under_review`. Returns `{document, application, allDecided, correctionsNotified}`. | Validation, InvalidState, Conflict (claimed by someone else), NotFound |
| `listReviewQueue(actor, {applicationId?, docCode?, limit?=100, offset?}): Promise<{items: ReviewQueueItem[], total}>` | staff | Docs in `uploaded` on reviewable apps, oldest submission first. Item: `{documentId, docCode, docName, applicationId, ref, studentId, studentName, studentNo, submittedAt, currentExpiry, claimedBy, claimedUntil, versionIds[]}`. | Forbidden |
| `authorizeVersionFile(actor, versionId, variant:'original'\|'thumb'): Promise<AuthorizedFile>` | owner / staff | Staff views are audited (`file.viewed`). Returns `{storageKey, contentType, filename}`, **for server use only**. | NotFound |
| `authorizePacketFile(actor, packetId)` | staff | Audited `packet.downloaded`. | NotFound |
| `authorizeReceiptFile(actor, paymentId)` | staff | Audited. | NotFound |
| `CLAIM_MINUTES = 15` | | | |

### 5.3 Staff lifecycle, fees, listing (`services/staff.ts`)

| Function | Semantics | Errors |
|---|---|---|
| `markApproved(actor, applicationId)` | `under_review→approved` when every required doc is approved. Releases the claim. Queues `approved:{id}`. | InvalidState (`details.notApproved`) |
| `recordPayment(actor, applicationId, {amountUgx, paidOn, reference?, receiptKey?})` | Inserts a payment and sets `fee_status='paid'`. Event `fee_paid`. `receiptKey` = key returned by `put(blobKeys.receipt(...))`. | InvalidState (draft/withdrawn), Validation |
| `setFeeStatus(actor, applicationId, 'not_required'\|'unpaid'\|'paid')` | Manual override (audited). | |
| `markSentToImmigration(actor, applicationId, {method:'email'\|'in_person', sentOn?})` | `approved→sent_to_immigration`. Stamps the latest ready packet. Queues `sent:{id}`. | InvalidState |
| `recordPassIssued(actor, applicationId, {newExpiry})` | `sent_to_immigration→pass_issued`. Sets `students.pass_expiry` (next Runway) and resolves open `runway_flags`. Queues `pass_issued:{id}`. | InvalidState |
| `closeApplication(actor, applicationId)` | `pass_issued\|sent_to_immigration→closed`. | InvalidState |
| `listApplicationsForStaff(actor, {filters?, sort?='risk', cursor?, limit?=50 (≤200), today?}): Promise<{items: StaffListItem[], nextCursor, total}>` | FR-DOS-1. Filters: `q` (name/email/student no/ref), `status[]`, `studentType[]`, `nationality[]`, `riskBand[]`, `feeStatus[]`, `submittedFrom/To`, `claimedByMe`, `includeDrafts`. Drafts are excluded unless `includeDrafts` or a status filter is set. Sorts: `risk` (band then expiry), `expiry`, `submitted` (desc), `activity` (desc), `name`. Keyset cursor: pass `nextCursor` back with the **same** filters and sort. Item includes `riskBand, daysToExpiry, applyBy, runway (RunwaySummary for <RunwayCompact/>), docsRequired/Approved/Pending/Rejected, feeStatus, claimedBy, emailBounced, …`. | Validation (bad cursor) |
| `getDashboardSummary(actor, today?)` | `{needsReview, correctionsPending, criticalOrExpired, readyForImmigration, feesUnpaid, openRunwayFlags}` (FR-DOS-2). | |
| `listSavedViews(actor)` / `createSavedView(actor, {name, filters: StaffListFilters & {sort?}, shared?})` / `deleteSavedView(actor, id)` | Per user. Shared views are visible to every staff member. Only the owner or an admin can delete. | |
| `inviteStaff(actor, {email, fullName?, role:'dos_staff'\|'dos_admin'\|'liaison'})` | **Admin.** Creates or updates the profile role (revokes sessions on a role change). Students who have applications cannot be promoted. | Forbidden, Conflict, Validation |
| `setProfileStatus(actor, profileId, 'active'\|'disabled')` | **Admin.** Disabling revokes sessions. | |
| `listStaff(actor)` | **Admin.** | |

### 5.4 Messages (`services/messages.ts`)

| Function | Semantics |
|---|---|
| `postMessage(actor, applicationId, {body, internal?})` | Students: non-internal only, on their own application. Staff: either. Non-internal messages queue an email to the other party (`message:{messageId}`): staff → student, student → the claiming or last-replying staff member. |
| `listMessages(actor, applicationId)` | Internal notes are visible only to staff. |

### 5.5 Rules and settings (`services/rules.ts`, `services/settings.ts`)

`getActiveRuleSet(): Promise<RuleSet>`, `getRuleSet(id)`, `listRuleSets(actor)` (staff; includes `applicationCount` of in-flight apps), `createRuleSetDraft(actor, input: RuleSetInput)` (admin; next version, `draft`), `publishRuleSet(actor, id)` (admin; retires the previous set; in-flight apps keep their version), `listReasonTemplates(actor, {includeInactive?})` (staff).
`getSetting(db, key, fallback)`, `getAllowedEmailDomains(db)`, `getRetentionDays(db)`, `getFeatureFlags(db)`, `updateSetting(actor, key, value)` (admin, audited).

### 5.6 Packets: records only (`services/packets.ts`)

The ZIP and cover sheet builder is **not** in the foundation. The builder does:

```ts
const p = await startPacket(actor, appId);                    // app must be approved|sent_to_immigration; status 'generating'
const zip: Uint8Array = …;                                    // fflate + pdf-lib, files named {NN}_{doc_code}_{Surname}_{StudentNo}.jpg
const { key } = await getBlobStore().put(blobKeys.packet(appId, p.id), zip, 'application/zip');
await completePacket(actor, p.id, { storageKey: key, sha256, bytes: zip.byteLength, manifest }); // status 'ready'
// on error: await failPacket(actor, p.id, message)
```

`listPackets(actor, appId)` and `getPacket(actor, id)` return `PacketView` (no storage key). Download: `authorizePacketFile` + `serveAuthorizedFile(file, { download: true })`.

---

## 6. Domain layer (`import { … } from '@/domain'`)

- **Types:** `Role, StudentType, ApplicationStatus, DocumentState, FeeStatus, RiskBand, RuleSet, RuleDocument`, constant arrays (`APPLICATION_STATUSES`, …), `ACTIVE_STATUSES`.
- **Dates (Kampala):** `todayInKampala(now?)`, `addDays`, `diffDays(to, from)`, `addMonths`, `formatDate('2026-10-23') → '23 Oct 2026'`, `formatDateTime(iso)`, `isIsoDate`. **Never use `new Date().toISOString().slice(0,10)` for "today".**
- **Rules:** `computeChecklist(ruleSet, {studentType, nationality})`, `riskBand(expiry, today)`, `applyBy(expiry, days)`, `penaltyEstimate(expiry, today, rate)`, `runwaySummary(expiry|null, today, {applyBeforeDays, penaltyUsdPerDay})` (what `<Runway>` takes), `RISK_RANK`.
- **State:** `APPLICATION_TRANSITIONS`, `canTransition`, `assertTransition`, `nextDocumentState`, `canStudentUpload(appStatus, docState)`, `REVIEWABLE_STATUSES`.
- **Copy:** `studentStatusCopy(status, {newExpiry})` (design §13), `staffStatusLabel`, `documentStateChip(state, required)` (`{label, tone}`), `applicationStatusTone`, `riskLabel`.
- **Schemas (Zod 4, shared client/server):** `profileSchema`, `profilePatchSchema`, `applicationFieldsSchema`, `applicationFieldsPatchSchema`, `reviewDecisionSchema`, `paymentSchema`, `sentToImmigrationSchema`, `passIssuedSchema`, `messageSchema`, `staffListFiltersSchema`, `emailSchema`, `isoDateSchema`, `countryCodeSchema`, `STAFF_SORTS`. With RHF: `useForm({ resolver: zodResolver(profileSchema) })` from `@hookform/resolvers/zod`.

---

## 7. i18n (NFR-I18N)

```ts
import { t, messages, interpolate } from '@/i18n';
t('auth.codeSentTo', { email });              // typed dotted keys
messages.status.corrections_needed.label;     // direct access
```

Every user-facing string goes in `src/i18n/en.ts`. Add keys under your namespace. Dates must go through `formatDate`.

---

## 8. Storage (`@/server/storage`)

```ts
import { getBlobStore, blobKeys } from '@/server/storage';
const store = getBlobStore();                 // EncryptedBlobStore over Vercel Blob (prod) or local disk (dev)
const { key } = await store.put(blobKeys.documentVersion(appId, docCode, seq), jpegBytes, 'image/jpeg');
// PERSIST `key` (Vercel appends a random suffix). Never send keys or provider URLs to the client.
const bytes = await store.get(key);           // decrypted Uint8Array | null
await store.delete(key); await store.exists(key);
```

Interface (implement it for new drivers, e.g. S3/R2):

```ts
interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;   // idempotent
  exists(key: string): Promise<boolean>;
}
```

Key layout (`blobKeys`): `{application_id}/{doc_code}/{seq}.jpg`, `{application_id}/{doc_code}/{seq}_thumb.jpg`, `packets/{application_id}/{packet_id}.zip`, `receipts/{application_id}/{payment_id}.jpg`.

**Serving:** `GET /api/files/{versionId}?variant=thumb|original[&download=1]` (exists). Use it directly in `<img src>`, because the session cookie authorizes it. For other files: `authorize*File(actor, id)` then `serveAuthorizedFile(file, {download})` from `@/server/http/files` (decrypts, `Cache-Control: private, no-store`).

**Upload pipeline (student UI agent), suggested `POST /api/uploads` (multipart: applicationId, docCode, page, file, quality JSON):**
1. `assertSameOrigin(req)`, `requireActorOrThrow(['student'])`, `enforceRateLimit(getDb(), \`upload:${actor.id}\`, RATE_LIMITS.uploadPerUser.limit, RATE_LIMITS.uploadPerUser.windowMs)` (from `@/server/auth/rate-limit`).
2. `const prep = await prepareDocumentUpload(actor, {applicationId, docCode, page})`. This fails fast on authz or state before reading the body.
3. Server re-validation with `sharp` (FR-UP-3): JPEG magic bytes, dimensions (long edge ≥ 1600, or ≥ 1200 for passport/ID), ≤ 3 MB, `.rotate()` to apply orientation, strip EXIF (re-encode `jpeg({quality: 85})`), SHA-256 of the stored bytes, and a 400 px thumbnail.
4. `put` the original and thumbnail at `prep.storageKey` / `prep.thumbKey`.
5. `registerDocumentVersion(actor, {…, seq: prep.seq, storageKey: putKey, thumbKey: putThumbKey, sha256, width, height, bytes, quality})`. On `ConflictError`, delete the blobs and ask the client to retry.
6. Return `{version: {id, page}, document, duplicateOf}`. The request body must stay under Vercel's 4.5 MB.

---

## 9. Notifications (`@/server/notify`)

```ts
import { queueNotification, flushNotifications } from '@/server/notify';
// inside a service transaction:
await queueNotification(tx, { kind: 'reminder', recipientId: studentId, applicationId: null,
  dedupeKey: `reminder:${studentId}:${expiry}:${day}`, payload: { day, expiry, applyBy } }); // → false if already queued/sent
// after commit (route/action): after(() => flushNotifications());  cron: await flushNotifications({ limit: 200 })
```

- Kinds (`NotificationKind`): `receipt, corrections_needed, approved, sent_to_immigration, pass_issued, message, reminder, staff_alert`. Rendering is `renderEmail(kind, ctx)` in `notify/templates.ts`. Payload fields it reads: `items` (corrections), `newExpiry`, `expiry`, `applyBy`, `day`, `preview`, `text`.
- **Dedupe keys in use:** `receipt:{appId}`, `corrections:{appId}:{round}`, `approved:{appId}`, `sent:{appId}`, `pass_issued:{appId}`, `message:{messageId}`, `expired_submit:{appId}:{adminId}`. Jobs should use `reminder:{studentId}:{expiry}:{day}` (FR-RUN-5).
- Payloads hold **IDs and codes only**. Recipient email and name are resolved at send time. Disabled or deleted recipients are `skipped`.
- Channel: `getChannel()` (Resend if `RESEND_API_KEY`, else `DevOutboxChannel`). New providers implement `NotificationChannel { name; send(EmailMessage) }`.
- `sendEmailNow(msg)` exists only for OTP. Don't use it for anything else.
- Bounces: `profiles.email_status = 'bounced'` (surfaced as `emailBounced` in staff list items). A webhook to set it is not built yet.

---

## 10. Audit (`@/server/audit`)

`writeAudit(tx, { actorId, action, targetType, targetId, meta })`. Always pass the **transaction**. `meta` = IDs and codes only (no names, emails or free text). `verifyAuditChain(db) → {ok, checked, brokenAtId?, reason?}`. UPDATE and DELETE on `audit_log` are blocked by triggers. Action names in use: `application.<action>` (submit, start_review, request_corrections, corrections_resubmitted, approve, send_to_immigration, record_pass_issued, close, withdraw), `application.created|fields_updated|claimed|claim_released|fee_status_set`, `document.uploaded|reviewed`, `file.viewed`, `packet.started|generated|failed|downloaded`, `payment.recorded`, `message.posted`, `profile.updated|status_set`, `staff.invited`, `auth.login|signup`, `rule_set.seeded|draft_created|published`, `settings.updated`, `saved_view.created|deleted`.

---

## 11. Components

`import { … } from '@/components/ui'` (or per file):

| Component | Notes |
|---|---|
| `Button` | `variant: primary\|secondary\|ghost\|danger\|success`, `size: sm\|md(48px)\|lg`, `loading`, `icon`, `fullWidth` |
| `Chip` | Always icon + text. `tone: neutral\|info\|teal\|warn\|ok\|bad`, `spinning`. `RiskChip band=`. Also `RISK_ICONS`, `RISK_TEXT_CLASS`, `RISK_BG_CLASS` |
| `Card`, `CardHeader`, `CardBody`, `CardFooter` | |
| `Input`, `Select` (client) | `label`, `hint`, `error` wired with `aria-describedby`. `inputClass` for custom controls |
| `Dialog` (client) | native `<dialog>`: `open`, `onClose`, `title`, `description`, `footer` |
| `ToastProvider` / `useToast()` (client) | Provider already in the root layout. `toast({title, description?, tone?, duration?, action?})` |
| `Tabs` (client) | ARIA tabs with arrow keys |
| `TableContainer, Table, THead, TBody, TR, TH, TD` | |
| `Stepper` | `steps`, `current` |
| `Skeleton`, `SkeletonText` | Loading states |
| `Runway`, `RunwayCompact` (`@/components/runway`) | `summary: RunwaySummary`. Server-renderable, accessible text, reduced-motion aware. `runwayHeadline(summary)` gives the sentence |
| `CodeInput`, `EmailForm`, `VerifyForm`, `SignOutButton` (`@/components/auth/*`) | |
| `AppHeader` (`@/components/layout/app-header`) | Minimal. Replace freely in your group's layout |

Tokens: CSS variables in `src/app/globals.css`, Tailwind utilities `bg-paper bg-surface text-ink text-ink-muted border-line bg-brand-500 text-risk-urgent bg-risk-critical text-ok text-warn text-bad text-info rounded-sm|md|lg shadow-1 font-serif font-mono`. Dark mode is `[data-theme="dark"]` or the OS preference. H1/H2 automatically use Fraunces. Refs, dates and counts use `font-mono tabular`. **Living reference: `/dev/styleguide`** (404 in production).

Still to build (owned by the UI agents): `ChecklistCard`, `ScanCoach`, `QualityReport`, `DocViewer`, `ReasonPicker`, `Timeline`, `PacketPreview`.

---

## 12. Jobs (jobs/infra agent)

- Stubs: `src/app/api/cron/daily-runway/route.ts`, `src/app/api/cron/retention-sweep/route.ts`. Both are wrapped in `route()` + `assertCronAuth(req)`, scheduled in `vercel.json` at `0 3 * * *`. Bodies must be idempotent.
- Daily runway (FR-RUN-3): source expiry is `students.pass_expiry` (kept in sync by `updateApplicationFields`/`recordPassIssued`) for students with no active application, plus `applications.current_expiry` for active ones. Insert `runway_flags` (UNIQUE `student_id, expiry, day`) and queue `reminder` with dedupe `reminder:{studentId}:{expiry}:{day}` inside one `withTx` per student, with a `writeAudit` for system actions (`actorId: null`). Reminder days come from the rule set (`reminderDays`).
- Retention (FR-AUD-2): `getRetentionDays(db)`. Delete blobs (`getBlobStore().delete`), set `document_versions.deleted_at`, null personal columns. **Never touch `audit_log`** (it holds no PII by design).
- Housekeeping: `pruneExpiredSessions(db)`, `pruneRateLimits(db)`, `flushNotifications({limit})`.
- Jobs may write through internal helpers (`withTx`, `audit`, `recordEvent`, `transition` from `services/internal.ts`) with `SYSTEM_ACTOR` (its audit `actorId` is null).

---

## 13. Database and migrations

- Client: `getDb()` (singleton, async libSQL; `DbOrTx` type for helpers). Always `await`. Inside a transaction use **only `tx`**. Using `getDb()` inside a `withTx` callback deadlocks a local file DB (busy timeout).
- Schema: `src/server/db/schema.ts`. Migrations in `drizzle/` are generated with `npm run db:generate -- --name <change>`. Custom SQL (triggers) goes in a `--custom` migration. Apply with `npm run db:migrate` (production runs it in `vercel-build`).
- **Parallel-agent rule:** migrations are sequentially numbered, so two agents generating at once will collide. Generate your migration only after pulling the latest `drizzle/meta/_journal.json`. If a collision happens, delete your generated file and the snapshot and regenerate.
- Tables: profiles, students, sessions, otp_codes, rate_limits, rule_sets, rule_documents, ref_counters, applications, application_documents, document_versions, application_events, messages, payments, packets, reason_templates, notifications, outbox, runway_flags, saved_views, audit_log, settings.

---

## 14. Tests

```ts
import { createTestDb, createStudent, createStaff, createAdmin, createUser, actorOf, fakeSha, outboxFor } from '../helpers/db';
import { createDraft, createSubmittedApplication, uploadDoc, uploadAllRequired, docsOf } from '../helpers/factories';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });   // fresh temp SQLite + migrations + base seed;
afterAll(() => t.cleanup());                            // routes getDb()/getBlobStore()/getChannel() to it

const { student, app } = await createSubmittedApplication(t.db, { nationality: 'KE', studentType: 'continuing', expiryInDays: 45 });
const staff = await createStaff(t.db);
await flushNotifications();  const mails = await outboxFor(t.db, student.email);
```

- Vitest 4 (`npm test`), Node environment, `pool: 'forks'`, so each file is its own process and DB. `server-only` is aliased for tests.
- Existing suites: `tests/unit/{rules,state,crypto}.test.ts`, `tests/integration/{isolation,lifecycle,notifications-audit,auth,staff-list}.test.ts`.
- Playwright is installed without browsers. Add e2e under `e2e/` with your own config. Download browsers locally only if allowed.

---

## 15. Environment

See `.env.example`: `APP_NAME`, `NEXT_PUBLIC_APP_NAME`, `APP_URL`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `DATA_DIR`, `SESSION_SECRET` (≥ 32 chars), `FILE_ENCRYPTION_KEY` (32 bytes base64), `FILE_ENCRYPTION_KEY_ID`, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALLOWED_EMAIL_DOMAINS`, `DEFAULT_TIMEZONE`. Read config only through `config()` from `@/server/config`, which is validated, has dev defaults, and requires the secrets in production. `APP_NAME` for UI comes from `@/config/app`.
