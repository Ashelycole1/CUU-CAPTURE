import { requireActorOrThrow } from '@/server/auth/current';
import { route } from '@/server/http';
import { serveAuthorizedFile } from '@/server/http/files';
import { authorizeVersionFile } from '@/server/services';

/**
 * GET /api/files/{versionId}?variant=thumb|original[&download=1]
 * Owner or staff only (staff views are audit-logged). Decrypts and streams with
 * Cache-Control: private, no-store. Blob keys/URLs are never exposed.
 */
export const GET = route<{ params: Promise<{ versionId: string }> }>(async (req, { params }) => {
  const actor = await requireActorOrThrow();
  const { versionId } = await params;
  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') === 'thumb' ? 'thumb' : 'original';
  const file = await authorizeVersionFile(actor, versionId, variant);
  return serveAuthorizedFile(file, { download: url.searchParams.get('download') === '1' });
});
