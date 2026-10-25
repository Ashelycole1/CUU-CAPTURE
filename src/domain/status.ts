/** Student-facing status labels (design §13) and chip metadata. Pure. */
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import { formatDate } from './dates';
import type { ApplicationStatus, DocumentState, RiskBand } from './types';

export interface StatusCopy {
  label: string;
  explanation: string;
}

export function studentStatusCopy(status: ApplicationStatus, opts: { newExpiry?: string | null } = {}): StatusCopy {
  const c = en.status[status];
  return { label: c.label, explanation: interpolate(c.explanation, { date: formatDate(opts.newExpiry ?? null) }) };
}

export function staffStatusLabel(status: ApplicationStatus): string {
  return en.staffStatus[status];
}

export type ChipTone = 'neutral' | 'info' | 'teal' | 'warn' | 'ok' | 'bad';

export function documentStateChip(state: DocumentState, required = true): { label: string; tone: ChipTone } {
  if (!required) return { label: en.docState.notRequired, tone: 'neutral' };
  switch (state) {
    case 'missing':
      return { label: en.docState.missing, tone: 'neutral' };
    case 'uploaded':
      return { label: en.docState.uploaded, tone: 'teal' };
    case 'rejected':
      return { label: en.docState.rejected, tone: 'warn' };
    case 'approved':
      return { label: en.docState.approved, tone: 'ok' };
  }
}

export function applicationStatusTone(status: ApplicationStatus): ChipTone {
  switch (status) {
    case 'draft':
      return 'neutral';
    case 'submitted':
    case 'under_review':
      return 'info';
    case 'corrections_needed':
      return 'warn';
    case 'approved':
    case 'sent_to_immigration':
    case 'pass_issued':
      return 'ok';
    case 'closed':
    case 'withdrawn':
      return 'neutral';
  }
}

export function riskLabel(band: RiskBand): string {
  return en.risk[band];
}
