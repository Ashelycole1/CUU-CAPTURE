import 'server-only';
/**
 * Plain email templates (design §12). Single column, one primary link, plain-text
 * alternative. Copy comes from i18n. Later agents may restyle; keep `renderEmail`'s
 * signature stable.
 */
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import { formatDate } from '@/domain/dates';

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
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(ctx: EmailContext, subject: string, paragraphs: string[], cta: { label: string; path: string }): RenderedEmail {
  const greeting = ctx.recipientName ? `Hello ${ctx.recipientName},` : 'Hello,';
  const footer = interpolate(en.notify.footer, { app: ctx.appName });
  const url = `${ctx.appUrl}${cta.path}`;
  const text = [greeting, '', ...paragraphs, '', `${cta.label}: ${url}`, '', '--', footer].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#fbfaf7;font-family:Inter,Arial,sans-serif;color:#14181f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e3e0d8;border-radius:14px">
<tr><td style="padding:24px 24px 8px;font-size:14px;color:#13315c;font-weight:600">${esc(ctx.appName)}</td></tr>
<tr><td style="padding:0 24px 24px;font-size:16px;line-height:1.5">
<p>${esc(greeting)}</p>${paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}
<p><a href="${esc(url)}" style="display:inline-block;background:#1f5fbf;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e3e0d8;font-size:12px;color:#4b5563">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export function renderEmail(kind: NotificationKind, ctx: EmailContext): RenderedEmail {
  const ref = ctx.ref ?? '';
  switch (kind) {
    case 'receipt':
      return layout(
        ctx,
        interpolate(en.notify.receiptSubject, { ref }),
        [`Your reference number is ${ref}.`, 'The Dean of Students will review your documents soon. We will email you when anything changes.'],
        { label: 'View your application', path: '/status' },
      );
    case 'corrections_needed': {
      const items = ctx.rejected ?? [];
      return layout(
        ctx,
        interpolate(en.notify.correctionsSubject, { count: items.length, ref }),
        [
          'Please fix these documents:',
          items.map((d) => `- ${d.name}: ${d.reason}${d.note ? ` (${d.note})` : ''}`).join('\n'),
          'Everything else is fine. You only need to replace the documents listed above.',
        ],
        { label: 'Fix now', path: '/status' },
      );
    }
    case 'approved':
      return layout(
        ctx,
        interpolate(en.notify.approvedSubject, { ref }),
        ["Your documents are approved and being sent to immigration. You'll get an email when your pass is ready."],
        { label: 'View status', path: '/status' },
      );
    case 'sent_to_immigration':
      return layout(ctx, interpolate(en.notify.sentSubject, { ref }), ["We've sent your documents to immigration."], {
        label: 'View status',
        path: '/status',
      });
    case 'pass_issued':
      return layout(
        ctx,
        interpolate(en.notify.passIssuedSubject, { ref }),
        [`Your new pass expires on ${formatDate(ctx.newExpiry ?? null)}.`],
        { label: 'View status', path: '/status' },
      );
    case 'message':
      return layout(ctx, interpolate(en.notify.messageSubject, { ref }), [ctx.messagePreview ?? ''], {
        label: 'Read and reply',
        path: '/messages',
      });
    case 'reminder': {
      const expired = (ctx.day ?? 0) <= 0;
      return layout(
        ctx,
        expired ? en.notify.reminderExpiredSubject : interpolate(en.notify.reminderSubject, { date: formatDate(ctx.expiry ?? null) }),
        [
          expired
            ? 'Your Student Pass has expired. The illegal-stay penalty applies every day. Contact the Dean of Students today.'
            : `Your Student Pass expires on ${formatDate(ctx.expiry ?? null)}.`,
          ctx.applyBy ? `Apply by ${formatDate(ctx.applyBy)}.` : '',
        ].filter(Boolean),
        { label: 'Start your application', path: '/apply' },
      );
    }
    case 'staff_alert':
      return layout(ctx, `${ctx.appName}: ${ctx.text ?? 'Alert'}`, [ctx.text ?? ''], { label: 'Open dashboard', path: '/dashboard' });
  }
}
