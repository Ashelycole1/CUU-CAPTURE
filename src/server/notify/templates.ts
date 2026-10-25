import 'server-only';
/**
 * Transactional email (FR-NOT-1, design §12): single column, 560 px, one primary
 * button, plain-text alternative, explicit subjects, Runway line in reminders and a
 * Dean of Students footer. Copy lives in `src/i18n/jobs.ts`.
 *
 * Contract: keep `renderEmail(kind, ctx)` and the `NotificationKind` names stable.
 */
import { jobs } from '@/i18n/jobs';
import { interpolate } from '@/i18n';
import { diffDays, formatDate, todayInKampala } from '@/domain/dates';

export const NOTIFICATION_KINDS = [
  'receipt',
  'corrections_needed',
  'approved',
  'sent_to_immigration',
  'pass_issued',
  'message',
  'reminder',
  'staff_alert',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface EmailContext {
  appName: string;
  appUrl: string;
  recipientName: string | null;
  ref: string | null;
  /** corrections_needed */
  rejected?: { name: string; reason: string; note?: string | null }[];
  newExpiry?: string | null;
  expiry?: string | null;
  applyBy?: string | null;
  day?: number;
  messagePreview?: string;
  text?: string;
  /** Raw notification payload (IDs and codes only), for template-specific flags. */
  payload?: Record<string, unknown>;
  /** Override "today" (tests). Defaults to the Kampala date. */
  today?: string;
  /** Dean of Students contact address for the footer. */
  dosEmail?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const E = jobs.email;
const DEFAULT_DOS_EMAIL = 'dos@cavendish.ac.ug';

// Palette mirrors design tokens (inline: email clients ignore CSS variables).
const C = {
  paper: '#fbfaf7',
  surface: '#ffffff',
  line: '#e3e0d8',
  ink: '#14181f',
  muted: '#4b5563',
  brand: '#13315c',
  button: '#1f5fbf',
  urgentBg: '#fff4e0',
  urgentInk: '#7a4600',
  badBg: '#fdecea',
  badInk: '#8a1c12',
  infoBg: '#eaf1fb',
  infoInk: '#13315c',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type Tone = 'info' | 'urgent' | 'bad';

interface EmailSpec {
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Bulleted list (e.g. rejected documents). */
  list?: string[];
  /** Highlighted line, e.g. the Runway summary in reminders. */
  callout?: { text: string; tone: Tone };
  after?: string[];
  cta: { label: string; path: string };
}

function layout(ctx: EmailContext, spec: EmailSpec): RenderedEmail {
  const greeting = ctx.recipientName ? interpolate(E.greeting, { name: ctx.recipientName }) : E.greetingAnon;
  const url = `${ctx.appUrl}${spec.cta.path}`;
  const footer = [
    interpolate(E.footerContact, { email: ctx.dosEmail ?? DEFAULT_DOS_EMAIL }),
    E.footerHours,
    interpolate(E.footerAutomated, { app: ctx.appName }),
  ];

  const text = [
    spec.heading,
    '',
    greeting,
    '',
    ...spec.paragraphs.flatMap((p) => [p, '']),
    ...(spec.list?.length ? [...spec.list.map((l) => `- ${l}`), ''] : []),
    ...(spec.callout ? [spec.callout.text, ''] : []),
    ...(spec.after ?? []).flatMap((p) => [p, '']),
    `${spec.cta.label}: ${url}`,
    '',
    '--',
    ctx.appName,
    E.org,
    ...footer,
  ].join('\n');

  const toneColors = { info: [C.infoBg, C.infoInk], urgent: [C.urgentBg, C.urgentInk], bad: [C.badBg, C.badInk] } as const;
  const p = (s: string) => `<p style="margin:0 0 16px">${esc(s).replace(/\n/g, '<br>')}</p>`;
  const list = spec.list?.length
    ? `<ul style="margin:0 0 16px;padding-left:20px">${spec.list.map((l) => `<li style="margin:0 0 6px">${esc(l)}</li>`).join('')}</ul>`
    : '';
  const callout = spec.callout
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${toneColors[spec.callout.tone][0]};color:${toneColors[spec.callout.tone][1]};border-radius:8px;padding:12px 16px;font-weight:600">${esc(spec.callout.text)}</td></tr></table>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(spec.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.paper};font-family:Inter,Segoe UI,Arial,sans-serif;color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(spec.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:${C.surface};border:1px solid ${C.line};border-radius:14px">
<tr><td style="padding:20px 24px;border-bottom:1px solid ${C.line}">
<div style="font-size:16px;font-weight:700;color:${C.brand}">${esc(ctx.appName)}</div>
<div style="font-size:12px;color:${C.muted}">${esc(E.org)}</div>
</td></tr>
<tr><td style="padding:24px 24px 8px;font-size:16px;line-height:1.55">
<h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:${C.ink}">${esc(spec.heading)}</h1>
${p(greeting)}${spec.paragraphs.map(p).join('')}${list}${callout}${(spec.after ?? []).map(p).join('')}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:${C.button}">
<a href="${esc(url)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(spec.cta.label)}</a>
</td></tr></table>
<p style="margin:0 0 16px;font-size:13px;color:${C.muted}">${esc(E.buttonFallback)}<br><a href="${esc(url)}" style="color:${C.button};word-break:break-all">${esc(url)}</a></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid ${C.line};font-size:12px;line-height:1.5;color:${C.muted}">${footer.map((f) => esc(f)).join('<br>')}</td></tr>
</table></td></tr></table></body></html>`;

  return { subject: spec.subject, text, html };
}

function reminder(ctx: EmailContext): EmailSpec {
  const R = E.reminder;
  const today = ctx.today ?? todayInKampala();
  const expiry = ctx.expiry ?? null;
  const days = expiry ? diffDays(expiry, today) : (ctx.day ?? 0);
  const date = formatDate(expiry);
  const applyBy = ctx.applyBy ? formatDate(ctx.applyBy) : null;
  const hasDraft = ctx.payload?.hasDraft === true;
  const rate = typeof ctx.payload?.penaltyUsdPerDay === 'number' ? ctx.payload.penaltyUsdPerDay : 20;
  const cta = { label: hasDraft ? R.ctaDraft : R.ctaStart, path: '/apply' };
  const body = hasDraft ? R.bodyDraft : R.bodyStart;

  if (days < 0 || (ctx.day ?? 0) < 0) {
    return {
      subject: R.subjectExpired,
      preheader: interpolate(R.runwayExpired, { date, rate }),
      heading: R.headingExpired,
      paragraphs: [R.bodyExpired],
      callout: { text: interpolate(R.runwayExpired, { date, rate }), tone: 'bad' },
      after: [body],
      cta,
    };
  }
  if (days === 0) {
    return {
      subject: R.subjectToday,
      preheader: R.headingToday,
      heading: R.headingToday,
      paragraphs: [body],
      callout: { text: R.runwayToday, tone: 'bad' },
      cta,
    };
  }
  const pastApplyBy = ctx.applyBy ? diffDays(ctx.applyBy, today) < 0 : false;
  return {
    subject: !applyBy
      ? interpolate(R.subjectNoApplyBy, { date })
      : interpolate(pastApplyBy ? R.subjectPastApplyBy : R.subject, { date, applyBy }),
    preheader: interpolate(R.preheader, { date }),
    heading: interpolate(R.heading, { date }),
    paragraphs: [body],
    callout: applyBy
      ? { text: interpolate(pastApplyBy ? R.runwayLinePast : R.runwayLine, { applyBy }), tone: pastApplyBy || days <= 30 ? 'urgent' : 'info' }
      : undefined,
    cta,
  };
}

export function renderEmail(kind: NotificationKind, ctx: EmailContext): RenderedEmail {
  const ref = ctx.ref ?? '';
  switch (kind) {
    case 'receipt':
      return layout(ctx, {
        subject: interpolate(E.receipt.subject, { ref }),
        preheader: interpolate(E.receipt.preheader, { ref }),
        heading: E.receipt.heading,
        paragraphs: E.receipt.body.map((b) => interpolate(b, { ref })),
        cta: { label: E.receipt.cta, path: '/status' },
      });
    case 'corrections_needed': {
      const items = ctx.rejected ?? [];
      return layout(ctx, {
        subject: interpolate(items.length === 1 ? E.corrections.subjectOne : E.corrections.subjectMany, { count: items.length, ref }),
        preheader: E.corrections.preheader,
        heading: E.corrections.heading,
        paragraphs: [],
        list: items.map((d) => `${d.name}: ${d.reason}${d.note ? ` (${d.note})` : ''}`),
        after: [E.corrections.outro],
        cta: { label: E.corrections.cta, path: '/status' },
      });
    }
    case 'approved':
      return layout(ctx, {
        subject: interpolate(E.approved.subject, { ref }),
        preheader: E.approved.preheader,
        heading: E.approved.heading,
        paragraphs: [...E.approved.body],
        cta: { label: E.approved.cta, path: '/status' },
      });
    case 'sent_to_immigration':
      return layout(ctx, {
        subject: interpolate(E.sent.subject, { ref }),
        preheader: E.sent.preheader,
        heading: E.sent.heading,
        paragraphs: [...E.sent.body],
        cta: { label: E.sent.cta, path: '/status' },
      });
    case 'pass_issued': {
      const date = formatDate(ctx.newExpiry ?? null);
      return layout(ctx, {
        subject: interpolate(E.passIssued.subject, { ref }),
        preheader: interpolate(E.passIssued.preheader, { date }),
        heading: E.passIssued.heading,
        paragraphs: E.passIssued.body.map((b) => interpolate(b, { date })),
        cta: { label: E.passIssued.cta, path: '/status' },
      });
    }
    case 'message':
      return layout(ctx, {
        subject: ref ? interpolate(E.message.subject, { ref }) : E.message.subjectNoRef,
        preheader: E.message.preheader,
        heading: E.message.heading,
        paragraphs: [ctx.messagePreview ?? ''].filter(Boolean),
        cta: { label: E.message.cta, path: '/messages' },
      });
    case 'reminder':
      return layout(ctx, reminder(ctx));
    case 'staff_alert':
      return layout(ctx, {
        subject: interpolate(E.staffAlert.subject, { app: ctx.appName, text: ctx.text ?? 'Alert' }),
        preheader: ctx.text ?? '',
        heading: E.staffAlert.heading,
        paragraphs: [ctx.text ?? ''],
        cta: { label: E.staffAlert.cta, path: typeof ctx.payload?.path === 'string' ? ctx.payload.path : '/dashboard' },
      });
  }
}
