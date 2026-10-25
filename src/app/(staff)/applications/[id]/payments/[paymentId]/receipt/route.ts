import { requireActorOrThrow } from '@/server/auth/current';
import { route } from '@/server/http';
import { serveAuthorizedFile } from '@/server/http/files';
import { authorizeReceiptFile } from '@/server/services';

export const runtime = 'nodejs';

const STAFF = ['dos_staff', 'dos_admin'] as const;

/** GET /applications/{id}/payments/{paymentId}/receipt: staff only, audited (`file.viewed`), decrypted, no-store. */
export const GET = route<{ params: Promise<{ id: string; paymentId: string }> }>(async (_req, { params }) => {
  const actor = await requireActorOrThrow(STAFF);
  const { paymentId } = await params;
  const file = await authorizeReceiptFile(actor, paymentId);
  return serveAuthorizedFile(file);
});
