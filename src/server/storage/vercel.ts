import 'server-only';
import { del, get, head, put, BlobNotFoundError } from '@vercel/blob';
import type { BlobStore } from './types';

/**
 * Production driver: Vercel Blob, `access: 'private'`, random unguessable suffix.
 * Bytes passed in are already encrypted by `EncryptedBlobStore`, so even a leaked
 * URL reveals nothing. The returned key is the blob pathname (stored server-side only).
 */
export class VercelBlobStore implements BlobStore {
  constructor(private readonly token: string) {}

  async put(key: string, bytes: Uint8Array): Promise<{ key: string }> {
    const res = await put(key, Buffer.from(bytes), {
      access: 'private',
      addRandomSuffix: true,
      contentType: 'application/octet-stream',
      token: this.token,
    });
    return { key: res.pathname };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await get(key, { access: 'private', token: this.token, useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return new Uint8Array(await new Response(res.stream).arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await del(key, { token: this.token });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await head(key, { token: this.token });
      return true;
    } catch (e) {
      if (e instanceof BlobNotFoundError) return false;
      throw e;
    }
  }
}
