/**
 * Rule set v1 (PRD §5, from the Nov 2024 notice) and reason templates.
 * This is seed DATA only; at runtime everything is read from the database.
 */
import type { DocumentSource, StudentType } from '@/domain/types';

export const RULE_SET_V1 = {
  version: 1,
  feeUsd: 100,
  feeNote: 'About USD 100, paid in Uganda shillings. Same fee for 3, 6 or 12 months.',
  penaltyUsdPerDay: 20,
  applyBeforeDays: 30,
  maxPassMonths: 12,
  exemptCountries: ['KE', 'TZ', 'RW', 'BI', 'SS'],
  reminderDays: [60, 30, 14, 7, 0],
  noticeDate: '2024-11-01',
  submissionEmail: 'dos@cavendish.ac.ug',
};

export interface SeedRuleDocument {
  code: string;
  name: string;
  helpText: string;
  whereToGet: string;
  appliesToTypes: StudentType[] | null;
  minFiles: number;
  source: DocumentSource;
  sort: number;
}

export const RULE_DOCUMENTS_V1: SeedRuleDocument[] = [
  {
    code: 'visa_status_page',
    name: 'Current visa status page',
    helpText: 'The page in your passport that shows your current visa or Student Pass and its expiry date.',
    whereToGet: 'In your passport.',
    appliesToTypes: null,
    minFiles: 1,
    source: 'notice',
    sort: 1,
  },
  {
    code: 'passport_data_page',
    name: 'Passport data page',
    helpText: 'The page with your photo, name, passport number and expiry date.',
    whereToGet: 'In your passport.',
    appliesToTypes: null,
    minFiles: 1,
    source: 'notice',
    sort: 2,
  },
  {
    code: 'passport_photos',
    name: 'Passport photos',
    helpText: 'A recent passport-size photo with a plain light background.',
    whereToGet: 'Any photo studio, or take one against a plain wall.',
    appliesToTypes: null,
    minFiles: 1,
    source: 'student_addition',
    sort: 3,
  },
  {
    code: 'student_id_face',
    name: 'Face of student ID card',
    helpText: 'The front of your Cavendish student ID card, showing your photo and student number.',
    whereToGet: 'Your student ID card. Lost it? Ask the Registry.',
    appliesToTypes: null,
    minFiles: 1,
    source: 'notice',
    sort: 4,
  },
  {
    code: 'proof_of_registration',
    name: 'Current Proof of Registration form',
    helpText: 'Shows you are registered for the current semester.',
    whereToGet: 'Download it from the student portal, or ask the Registry.',
    appliesToTypes: null,
    minFiles: 1,
    source: 'notice',
    sort: 5,
  },
  {
    code: 'admission_letter',
    name: 'Acceptance / admission letter (pages 1 and 2)',
    helpText: 'Your admission letter from Cavendish. Both page 1 and page 2 are needed.',
    whereToGet: 'Your admission email, or ask Admissions for a copy.',
    appliesToTypes: null,
    minFiles: 2,
    source: 'notice',
    sort: 6,
  },
  {
    code: 'fees_statement',
    name: 'Tuition/fees statement',
    helpText: 'A recent statement of your tuition fees account.',
    whereToGet: 'Ask Accounts for a tuition statement.',
    appliesToTypes: null,
    minFiles: 1,
    source: 'notice',
    sort: 7,
  },
  {
    code: 'exam_results',
    name: 'Stamped exam results, last semester',
    helpText: 'Your results for last semester, with the official stamp.',
    whereToGet: 'Ask your Faculty office or the Registry for stamped results.',
    appliesToTypes: ['continuing'],
    minFiles: 1,
    source: 'notice',
    sort: 8,
  },
  {
    code: 'transcripts',
    name: 'Transcripts of past studies',
    helpText: 'Transcripts from your previous degree.',
    whereToGet: 'The university where you completed your previous degree.',
    appliesToTypes: ['masters'],
    minFiles: 1,
    source: 'student_addition',
    sort: 9,
  },
];

export const REASON_TEMPLATES: { code: string; label: string; body: string }[] = [
  { code: 'blurry', label: 'Image too blurry', body: 'We could not read the details. Hold steady, tap to focus, and retake.' },
  { code: 'cut_off', label: 'Part of the document is cut off', body: 'Make sure all four corners of the document are in the photo.' },
  { code: 'wrong_page', label: 'Wrong page uploaded', body: 'This is not the page we need. Check the example and upload the right page.' },
  { code: 'expired', label: 'Document expired', body: 'This document has expired. Please upload a current one.' },
  { code: 'name_mismatch', label: 'Name does not match passport', body: 'The name on this document does not match your passport.' },
  { code: 'stamp_missing', label: 'Stamp or signature missing', body: 'This document needs an official stamp or signature.' },
  { code: 'glare', label: 'Glare hides details', body: 'Light reflection hides part of the document. Move away from direct light and retake.' },
  { code: 'other', label: 'Other (explain)', body: '' },
];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  retention_days: 90,
  allowed_email_domains: ['cavendish.ac.ug'],
  feature_flags: { sso: false, ocr: false, sms: false, liaison: false },
  claim_minutes: 15,
};

export const DEV_USERS = {
  admin: { email: 'admin@cavendish.ac.ug', fullName: 'Dev Admin', role: 'dos_admin' as const },
  staff: { email: 'staff@cavendish.ac.ug', fullName: 'Dev Staff', role: 'dos_staff' as const },
  student1: {
    email: 'student1@cavendish.ac.ug',
    fullName: 'Amani Wanjiru',
    role: 'student' as const,
    student: { studentNo: 'CUU-2024-0001', nationality: 'KE', studentType: 'continuing' as const, programme: 'BSc Computer Science' },
  },
  student2: {
    email: 'student2@cavendish.ac.ug',
    fullName: 'Chidi Okafor',
    role: 'student' as const,
    student: { studentNo: 'CUU-2025-0002', nationality: 'NG', studentType: 'masters' as const, programme: 'MBA' },
  },
};
