import { requireActorOrThrow } from '@/server/auth/current';
import { NotFoundError } from '@/server/errors';
import { route } from '@/server/http';
import { getBlobStore } from '@/server/storage';
import { authorizePacketFile, getPacket } from '@/server/services';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STAFF = ['dos_staff', 'dos_admin'] as const;
const CHUNK = 256 * 1024;

/**
 * GET /api/packets/{applicationId}/{packetId}: decrypt and STREAM the packet ZIP.
 * Staff only; every download writes a `packet.downloaded` audit row (FR-PKT-3).
 * The body is streamed in chunks so ZIPs larger than Vercel's 4.5 MB buffered
 * response limit still download.
 */
export const GET = route<{ params: Promise<{ applicationId: string; packetId: string }> }>(async (_req, { params }) => {
  const actor = await requireActorOrThrow(STAFF);
  const { applicationId, packetId } = await params;
  const meta = await getPacket(actor, packetId);
  if (meta.applicationId !== applicationId) throw new NotFoundError('Packet');
  const file = await authorizePacketFile(actor, packetId); // audited
  const bytes = await getBlobStore().get(file.storageKey);
  if (!bytes) throw new NotFoundError('File');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, Math.min(offset + CHUNK, bytes.byteLength)));
      offset += CHUNK;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
