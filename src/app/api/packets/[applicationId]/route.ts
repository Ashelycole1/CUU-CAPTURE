import { NextResponse } from 'next/server';
import { requireActorOrThrow } from '@/server/auth/current';
import { assertSameOrigin, route } from '@/server/http';
import { buildPacket } from '@/server/services/packet-builder';

export const runtime = 'nodejs';
/** Building ≤ 25 MB in memory takes a few seconds; leave headroom for slow blob reads. */
export const maxDuration = 60;

const STAFF = ['dos_staff', 'dos_admin'] as const;

/**
 * POST /api/packets/{applicationId}: generate the immigration packet (FR-PKT-1).
 * Staff only; the application must be approved (or already sent). Audited by the
 * packet services (`packet.started`, `packet.generated` / `packet.failed`).
 */
export const POST = route<{ params: Promise<{ applicationId: string }> }>(async (req, { params }) => {
  assertSameOrigin(req);
  const actor = await requireActorOrThrow(STAFF);
  const { applicationId } = await params;
  const packet = await buildPacket(actor, applicationId);
  return NextResponse.json({ packet }, { status: 201 });
});
