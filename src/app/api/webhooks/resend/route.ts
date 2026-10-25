import { NextResponse } from 'next/server';
import { route } from '@/server/http';
import { handleResendEvent, jobsEnv, verifyWebhook, WebhookVerificationError, type ResendEvent } from '@/server/jobs';

/**
 * POST /api/webhooks/resend — Resend (Svix-signed) delivery events. Bounces and
 * complaints mark the recipient `email_status = 'bounced'` ("student unreachable" in
 * the staff UI); a later delivery marks it `ok` again. Exempt from the CSRF origin
 * check in proxy.ts because it authenticates with the signature instead.
 */
export const dynamic = 'force-dynamic';

export const POST = route(async (req) => {
  const raw = await req.text();
  try {
    verifyWebhook(jobsEnv().resendWebhookSecret, req.headers, raw);
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid webhook signature' } }, { status: 401 });
    }
    throw e;
  }
  let event: ResendEvent;
  try {
    event = JSON.parse(raw) as ResendEvent;
  } catch {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid JSON' } }, { status: 422 });
  }
  const outcome = await handleResendEvent(event);
  return NextResponse.json({ ok: true, outcome });
});
