/**
 * Shared Zod schemas (client forms + server validation). Pure.
 * Server services ALWAYS re-parse input with these; client use is for UX only.
 */
import { z } from 'zod';
import { en } from '@/i18n/en';
import { isIsoDate } from './dates';
import {
  APPLICATION_STATUSES,
  FEE_STATUSES,
  RISK_BANDS,
  SENT_METHODS,
  STUDENT_TYPES,
} from './types';

const v = en.validation;

export const isoDateSchema = z.string().refine(isIsoDate, { message: 'Enter a valid date (YYYY-MM-DD).' });
export const countryCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, v.nationality));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: en.auth.invalidEmail }).max(254));

// ---------------------------------------------------------------- student profile (FR-APP-1)

export const profileSchema = z.object({
  fullName: z.string().trim().min(2, v.fullName).max(120, v.fullName),
  studentNo: z
    .string()
    .trim()
    .min(3, v.studentNo)
    .max(40, v.studentNo)
    .transform((s) => s.toUpperCase()),
  nationality: countryCodeSchema,
  studentType: z.enum(STUDENT_TYPES, { message: v.studentType }),
  programme: z.string().trim().min(2, v.programme).max(160, v.programme),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, v.phone)
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type ProfileInput = z.input<typeof profileSchema>;
export type ProfileData = z.output<typeof profileSchema>;

/** Autosave (FR-APP-3): every field optional, validated if present. */
export const profilePatchSchema = profileSchema.partial();
export type ProfilePatch = z.input<typeof profilePatchSchema>;

// ---------------------------------------------------------------- application fields (FR-APP-2)

const requestedMonthsSchema = z.union([z.literal(3), z.literal(6), z.literal(12)], { message: v.requestedMonths });

export const applicationFieldsSchema = z
  .object({
    noPass: z.boolean().default(false),
    currentExpiry: isoDateSchema.nullable().optional(),
    requestedMonths: requestedMonthsSchema,
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    if (!val.noPass && !val.currentExpiry) ctx.addIssue({ code: 'custom', path: ['currentExpiry'], message: v.expiry });
  });
export type ApplicationFieldsInput = z.input<typeof applicationFieldsSchema>;

/** Autosave patch for application fields. */
export const applicationFieldsPatchSchema = z.object({
  noPass: z.boolean().optional(),
  currentExpiry: isoDateSchema.nullable().optional(),
  requestedMonths: requestedMonthsSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type ApplicationFieldsPatch = z.input<typeof applicationFieldsPatchSchema>;

// ---------------------------------------------------------------- staff actions

export const reviewDecisionSchema = z
  .object({
    documentId: z.string().min(1),
    decision: z.enum(['approve', 'reject']),
    reasonCode: z.string().trim().min(1).optional().nullable(),
    note: z.string().trim().max(1000).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.decision === 'reject' && !val.reasonCode)
      ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: v.reasonRequired });
    if (val.decision === 'reject' && val.reasonCode === 'other' && !val.note)
      ctx.addIssue({ code: 'custom', path: ['note'], message: v.noteRequiredForOther });
  });
export type ReviewDecisionInput = z.input<typeof reviewDecisionSchema>;

export const paymentSchema = z.object({
  amountUgx: z.coerce.number().int().positive().max(100_000_000),
  paidOn: isoDateSchema,
  reference: z.string().trim().max(120).optional().nullable(),
  receiptKey: z.string().max(500).optional().nullable(),
});
export type PaymentInput = z.input<typeof paymentSchema>;

export const sentToImmigrationSchema = z.object({
  sentOn: isoDateSchema.optional(),
  method: z.enum(SENT_METHODS),
});

export const passIssuedSchema = z.object({ newExpiry: isoDateSchema });

export const messageSchema = z.object({
  body: z.string().trim().min(1, v.required).max(5000),
  internal: z.boolean().default(false),
});

// ---------------------------------------------------------------- staff list (FR-DOS-1)

export const staffListFiltersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.array(z.enum(APPLICATION_STATUSES)).optional(),
  studentType: z.array(z.enum(STUDENT_TYPES)).optional(),
  nationality: z.array(countryCodeSchema).optional(),
  riskBand: z.array(z.enum(RISK_BANDS)).optional(),
  feeStatus: z.array(z.enum(FEE_STATUSES)).optional(),
  /** Filters on submitted_at date (Kampala calendar). */
  submittedFrom: isoDateSchema.optional(),
  submittedTo: isoDateSchema.optional(),
  claimedByMe: z.boolean().optional(),
  includeDrafts: z.boolean().optional(),
});
export type StaffListFilters = z.input<typeof staffListFiltersSchema>;

export const STAFF_SORTS = ['risk', 'expiry', 'submitted', 'activity', 'name'] as const;
export type StaffSort = (typeof STAFF_SORTS)[number];
