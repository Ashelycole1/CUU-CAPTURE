import 'server-only';
import { getBlobStore } from '../storage';
import { NotFoundError } from '../errors';
import type { AuthorizedFile } from '../services/documents';

/**
 * Fetch, decrypt and stream an authorized file. Never redirects to a provider URL.
 * Use after an `authorize*File(actor, ...)` service call.
 */
export async function serveAuthorizedFile(file: AuthorizedFile, opts: { download?: boolean } = {}): Promise<Response> {
  const bytes = await getBlobStore().get(file.storageKey);
  if (!bytes) throw new NotFoundError('File');
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Disposition': `${opts.download ? 'attachment' : 'inline'}; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
    },
  });
}
