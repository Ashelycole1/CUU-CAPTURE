/**
 * Drizzle schema (SQLite / libSQL). Conventions:
 * - ids: TEXT uuid (crypto.randomUUID) except audit_log (INTEGER, ordered chain).
 * - dates: TEXT `YYYY-MM-DD` (Kampala calendar). timestamps: TEXT ISO-8601 UTC.
 * - arrays / objects: JSON text via `json<T>()` (typed).
 * - booleans: INTEGER 0/1 via `mode: 'boolean'`.
 * Generate migrations with `npm run db:generate` after editing; never edit applied migrations.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  customType,
} from 'drizzle-orm/sqlite-core';
import type {
  ApplicationStatus,
  DocumentSource,
  DocumentState,
  FeeStatus,
  Role,
  RuleSetStatus,
  SentMethod,
  StudentType,
} from '@/domain/types';

/** JSON stored as TEXT, typed on the TS side. */
export const json = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => JSON.parse(value) as T,
  })(name);

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString());
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ---------------------------------------------------------------- identity

export const profiles = sqliteTable(
  'profiles',
  {
    id: id(),
    email: text('email').notNull(),
    fullName: text('full_name'),
    role: text('role').$type<Role>().notNull().default('student'),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    emailStatus: text('email_status').$type<'ok' | 'bounced'>().notNull().default('ok'),
    invitedBy: text('invited_by'),
    lastLoginAt: text('last_login_at'),
    createdAt: createdAt(),
    updatedAt: text('updated_at'),
    deletedAt: text('deleted_at'),
  },
  (t) => [uniqueIndex('profiles_email_uq').on(t.email), index('profiles_role_idx').on(t.role)],
);

export const students = sqliteTable(
  'students',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    studentNo: text('student_no'),
    nationality: text('nationality'), // ISO 3166-1 alpha-2
    studentType: text('student_type').$type<StudentType>(),
    programme: text('programme'),
    phone: text('phone'),
    /** Best-known current pass expiry (Runway source for students without an active app). */
    passExpiry: text('pass_expiry'),
    noPass: bool('no_pass').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: text('updated_at'),
  },
  (t) => [
    uniqueIndex('students_student_no_uq').on(t.studentNo),
    index('students_pass_expiry_idx').on(t.passExpiry),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: text('last_seen_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_profile_idx').on(t.profileId)],
);

export const otpCodes = sqliteTable(
  'otp_codes',
  {
    id: id(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: text('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: text('consumed_at'),
    ip: text('ip'),
  },
  (t) => [index('otp_codes_email_idx').on(t.email, t.createdAt)],
);

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: integer('window_start').notNull(), // epoch ms
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

// ---------------------------------------------------------------- rules

export const ruleSets = sqliteTable(
  'rule_sets',
  {
    id: id(),
    version: integer('version').notNull(),
    status: text('status').$type<RuleSetStatus>().notNull().default('draft'),
    feeUsd: integer('fee_usd').notNull(),
    feeNote: text('fee_note'),
    penaltyUsdPerDay: integer('penalty_usd_per_day').notNull(),
    applyBeforeDays: integer('apply_before_days').notNull(),
    maxPassMonths: integer('max_pass_months').notNull(),
    exemptCountries: json<string[]>('exempt_countries').notNull(),
    reminderDays: json<number[]>('reminder_days').notNull(),
    noticeDate: text('notice_date'),
    submissionEmail: text('submission_email'),
    publishedAt: text('published_at'),
    publishedBy: text('published_by'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rule_sets_version_uq').on(t.version), index('rule_sets_status_idx').on(t.status)],
);

export const ruleDocuments = sqliteTable(
  'rule_documents',
  {
    id: id(),
    ruleSetId: text('rule_set_id')
      .notNull()
      .references(() => ruleSets.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    helpText: text('help_text').notNull().default(''),
    whereToGet: text('where_to_get').notNull().default(''),
    examplePath: text('example_path'),
    appliesToTypes: json<StudentType[] | null>('applies_to_types'),
    minFiles: integer('min_files').notNull().default(1),
    source: text('source').$type<DocumentSource>().notNull().default('notice'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('rule_documents_set_code_uq').on(t.ruleSetId, t.code)],
);

// ---------------------------------------------------------------- applications

export const refCounters = sqliteTable('ref_counters', {
  year: integer('year').primaryKey(),
  last: integer('last').notNull().default(0),
});

export const applications = sqliteTable(
  'applications',
  {
    id: id(),
    /** VD-YYYY-NNNNN, assigned atomically at submission (null while draft). */
    ref: text('ref'),
    studentId: text('student_id')
      .notNull()
      .references(() => profiles.id),
    ruleSetId: text('rule_set_id')
      .notNull()
      .references(() => ruleSets.id),
    status: text('status').$type<ApplicationStatus>().notNull().default('draft'),
    currentExpiry: text('current_expiry'),
    noPass: bool('no_pass').notNull().default(false),
    requestedMonths: integer('requested_months'),
    notes: text('notes'),
    feeStatus: text('fee_status').$type<FeeStatus>().notNull().default('unpaid'),
    submittedAt: text('submitted_at'),
    claimedBy: text('claimed_by'),
    claimedUntil: text('claimed_until'),
    approvedAt: text('approved_at'),
    approvedBy: text('approved_by'),
    sentAt: text('sent_at'),
    sentMethod: text('sent_method').$type<SentMethod>(),
    passIssuedAt: text('pass_issued_at'),
    newExpiry: text('new_expiry'),
    closedAt: text('closed_at'),
    withdrawnAt: text('withdrawn_at'),
    /** Incremented each time a corrections round is sent (dedupe for FR-REV-5). */
    correctionsRound: integer('corrections_round').notNull().default(0),
    lastActivityAt: text('last_activity_at').notNull(),
    createdAt: createdAt(),
    updatedAt: text('updated_at'),
  },
  (t) => [
    uniqueIndex('applications_ref_uq').on(t.ref),
    index('applications_status_expiry_idx').on(t.status, t.currentExpiry),
    index('applications_student_idx').on(t.studentId),
    index('applications_expiry_idx').on(t.currentExpiry),
    index('applications_fee_idx').on(t.feeStatus),
    index('applications_activity_idx').on(t.lastActivityAt),
    index('applications_submitted_idx').on(t.submittedAt),
    // FR-APP-4: at most one active application per student.
    uniqueIndex('applications_one_active_uq')
      .on(t.studentId)
      .where(sql`status NOT IN ('pass_issued','closed','withdrawn')`),
  ],
);

export const applicationDocuments = sqliteTable(
  'application_documents',
  {
    id: id(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    docCode: text('doc_code').notNull(),
    /** false = orphaned after a profile change (kept, shown as "not required"; PRD §7). */
    required: bool('required').notNull().default(true),
    minFiles: integer('min_files').notNull().default(1),
    state: text('state').$type<DocumentState>().notNull().default('missing'),
    currentVersionId: text('current_version_id'),
    reviewerId: text('reviewer_id'),
    reviewerReasonCode: text('reviewer_reason_code'),
    reviewerNote: text('reviewer_note'),
    reviewedAt: text('reviewed_at'),
    updatedAt: text('updated_at'),
  },
  (t) => [
    uniqueIndex('app_docs_app_code_uq').on(t.applicationId, t.docCode),
    index('app_docs_app_state_idx').on(t.applicationId, t.state),
    index('app_docs_state_idx').on(t.state, t.docCode),
  ],
);

export interface QualityReport {
  blur?: number;
  glare?: number;
  warnings?: string[];
  [k: string]: unknown;
}

export const documentVersions = sqliteTable(
  'document_versions',
  {
    id: id(),
    applicationDocumentId: text('application_document_id')
      .notNull()
      .references(() => applicationDocuments.id, { onDelete: 'cascade' }),
    /** Denormalised for authz checks and duplicate detection. */
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** 1-based page/slot for multi-file items (FR-CHK-5). */
    page: integer('page').notNull().default(1),
    storageKey: text('storage_key').notNull(),
    thumbKey: text('thumb_key'),
    contentType: text('content_type').notNull().default('image/jpeg'),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    quality: json<QualityReport | null>('quality'),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedAt: text('uploaded_at').notNull(),
    supersededAt: text('superseded_at'),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    uniqueIndex('doc_versions_doc_seq_uq').on(t.applicationDocumentId, t.seq),
    index('doc_versions_app_sha_idx').on(t.applicationId, t.sha256),
  ],
);

export const applicationEvents = sqliteTable(
  'application_events',
  {
    id: id(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: json<Record<string, unknown>>('data').notNull(),
    actorId: text('actor_id'),
    /** Staff-only events (e.g. claims) are hidden from the student timeline. */
    visibleToStudent: bool('visible_to_student').notNull().default(true),
    at: text('at').notNull(),
  },
  (t) => [index('app_events_app_at_idx').on(t.applicationId, t.at)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').notNull(),
    body: text('body').notNull(),
    internal: bool('internal').notNull().default(false),
    at: text('at').notNull(),
  },
  (t) => [index('messages_app_at_idx').on(t.applicationId, t.at)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: id(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    amountUgx: integer('amount_ugx').notNull(),
    paidOn: text('paid_on').notNull(),
    reference: text('reference'),
    receiptKey: text('receipt_key'),
    recordedBy: text('recorded_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('payments_app_idx').on(t.applicationId)],
);

export interface PacketManifestEntry {
  name: string;
  sha256: string;
  bytes: number;
  docCode?: string;
  versionId?: string;
}
export interface PacketManifest {
  generatedAt: string;
  applicationRef: string | null;
  files: PacketManifestEntry[];
  [k: string]: unknown;
}

export const packets = sqliteTable(
  'packets',
  {
    id: id(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    status: text('status').$type<'generating' | 'ready' | 'failed'>().notNull().default('generating'),
    generatedBy: text('generated_by').notNull(),
    storageKey: text('storage_key'),
    sha256: text('sha256'),
    bytes: integer('bytes'),
    manifest: json<PacketManifest | null>('manifest'),
    error: text('error'),
    createdAt: createdAt(),
    readyAt: text('ready_at'),
    sentAt: text('sent_at'),
    sentMethod: text('sent_method').$type<SentMethod>(),
    sentBy: text('sent_by'),
  },
  (t) => [index('packets_app_idx').on(t.applicationId)],
);

export const reasonTemplates = sqliteTable('reason_templates', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  body: text('body').notNull().default(''),
  active: bool('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

// ---------------------------------------------------------------- notifications

export const notifications = sqliteTable(
  'notifications',
  {
    id: id(),
    applicationId: text('application_id'),
    recipientId: text('recipient_id'),
    kind: text('kind').notNull(),
    channel: text('channel').notNull().default('email'),
    dedupeKey: text('dedupe_key').notNull(),
    /** IDs and codes only; templates resolve names/emails at send time. */
    payload: json<Record<string, unknown>>('payload').notNull(),
    status: text('status').$type<'queued' | 'sending' | 'sent' | 'failed' | 'skipped'>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    providerId: text('provider_id'),
    createdAt: createdAt(),
    sentAt: text('sent_at'),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey),
    index('notifications_status_idx').on(t.status, t.createdAt),
    index('notifications_app_idx').on(t.applicationId),
    index('notifications_recipient_idx').on(t.recipientId, t.createdAt),
  ],
);

/** Dev/test mail sink (DevOutboxChannel). Never used when RESEND_API_KEY is set. */
export const outbox = sqliteTable(
  'outbox',
  {
    id: id(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    html: text('html'),
    kind: text('kind'),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_created_idx').on(t.createdAt)],
);

// ---------------------------------------------------------------- runway flags (FR-RUN-3)

export const runwayFlags = sqliteTable(
  'runway_flags',
  {
    id: id(),
    studentId: text('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    expiry: text('expiry').notNull(),
    /** Reminder day crossed (60/30/14/7/0). */
    day: integer('day').notNull(),
    band: text('band').notNull(),
    flaggedAt: text('flagged_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    uniqueIndex('runway_flags_uq').on(t.studentId, t.expiry, t.day),
    index('runway_flags_open_idx').on(t.resolvedAt, t.band),
  ],
);

// ---------------------------------------------------------------- staff UX

export const savedViews = sqliteTable(
  'saved_views',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    filters: json<Record<string, unknown>>('filters').notNull(),
    shared: bool('shared').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('saved_views_owner_idx').on(t.ownerId)],
);

// ---------------------------------------------------------------- governance

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** IDs and codes only, never PII (see docs/DECISIONS.md). */
    meta: text('meta').notNull().default('{}'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    // A UNIQUE prev_hash makes a forked chain (two concurrent writers) fail loudly.
    uniqueIndex('audit_log_prev_hash_uq').on(t.prevHash),
    uniqueIndex('audit_log_hash_uq').on(t.hash),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    index('audit_log_actor_idx').on(t.actorId, t.at),
    index('audit_log_action_idx').on(t.action, t.at),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: text('updated_at'),
  updatedBy: text('updated_by'),
});
