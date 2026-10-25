/** Shared domain enums and types. Pure; safe for client and server. */

export const ROLES = ['student', 'dos_staff', 'dos_admin', 'liaison'] as const;
export type Role = (typeof ROLES)[number];

export const STUDENT_TYPES = ['new', 'continuing', 'masters'] as const;
export type StudentType = (typeof STUDENT_TYPES)[number];

export const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'corrections_needed',
  'approved',
  'sent_to_immigration',
  'pass_issued',
  'closed',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses that count as the student's single "active" application (FR-APP-4). */
export const ACTIVE_STATUSES: readonly ApplicationStatus[] = [
  'draft',
  'submitted',
  'under_review',
  'corrections_needed',
  'approved',
  'sent_to_immigration',
];

export const DOCUMENT_STATES = ['missing', 'uploaded', 'approved', 'rejected'] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const FEE_STATUSES = ['not_required', 'unpaid', 'paid'] as const;
export type FeeStatus = (typeof FEE_STATUSES)[number];

export const RISK_BANDS = ['expired', 'critical', 'urgent', 'plan', 'safe', 'no_pass'] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export const REQUESTED_MONTHS = [3, 6, 12] as const;
export type RequestedMonths = (typeof REQUESTED_MONTHS)[number];

export const SENT_METHODS = ['email', 'in_person'] as const;
export type SentMethod = (typeof SENT_METHODS)[number];

export const RULE_SET_STATUSES = ['draft', 'published', 'retired'] as const;
export type RuleSetStatus = (typeof RULE_SET_STATUSES)[number];

export type DocumentSource = 'notice' | 'student_addition';

/** Rule-set data as consumed by the rule engine (decoupled from DB row shape). */
export interface RuleDocument {
  code: string;
  name: string;
  helpText: string;
  whereToGet: string;
  examplePath: string | null;
  /** null or empty = applies to every student type. */
  appliesToTypes: StudentType[] | null;
  minFiles: number;
  source: DocumentSource;
  sort: number;
}

export interface RuleSet {
  id: string;
  version: number;
  feeUsd: number;
  penaltyUsdPerDay: number;
  applyBeforeDays: number;
  maxPassMonths: number;
  exemptCountries: string[];
  reminderDays: number[];
  noticeDate: string | null;
  documents: RuleDocument[];
}
