import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { requireActorOrThrow } from '@/server/auth/current';
import { ValidationError } from '@/server/errors';
import { assertSameOrigin, route } from '@/server/http';
import { blobKeys, getBlobStore } from '@/server/storage';
import { recordPayment } from '@/server/services';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STAFF = ['dos_staff', 'dos_admin'] as const;
/** Request bodies on Vercel are capped at 4.5 MB; keep the image comfortably under. */
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

/**
 * POST /applications/{id}/payments (multipart): record a fee payment (FR-FEE-2)
 * with an optional receipt image. A route handler (not a Server Action) because
 * Server Action bodies are limited to 1 MB by default. The image is re-encoded
 * with sharp (orientation applied, EXIF stripped, ≤ 2000 px) and stored through
 * the encrypted BlobStore; only the returned key is persisted.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  assertSameOrigin(req);
  const actor = await requireActorOrThrow(STAFF);
  const { id } = await params;
  const form = await req.formData();
  const amountUgx = Number(String(form.get('amountUgx') ?? '').replace(/[,\s]/g, ''));
  const paidOn = String(form.get('paidOn') ?? '');
  const reference = String(form.get('reference') ?? '').trim() || null;
  const file = form.get('receipt');

  let receiptKey: string | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RECEIPT_BYTES) throw new ValidationError('The receipt image is too large (max 4 MB).', { receipt: 'Too large' });
    let jpeg: Buffer;
    try {
      jpeg = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      throw new ValidationError('We could not read that image. Upload a JPG or PNG photo of the receipt.', { receipt: 'Unreadable' });
    }
    // The payment id is generated inside recordPayment, so the key uses its own UUID.
    const put = await getBlobStore().put(blobKeys.receipt(id, crypto.randomUUID()), new Uint8Array(jpeg), 'image/jpeg');
    receiptKey = put.key;
  }

  try {
    const payment = await recordPayment(actor, id, { amountUgx, paidOn, reference, receiptKey });
    return NextResponse.json({ payment: { id: payment.id, amountUgx: payment.amountUgx, paidOn: payment.paidOn, hasReceipt: !!payment.receiptKey } }, { status: 201 });
  } catch (e) {
    if (receiptKey) await getBlobStore().delete(receiptKey).catch(() => undefined);
    throw e;
  }
});
