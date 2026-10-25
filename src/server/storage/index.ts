import 'server-only';
import path from 'node:path';
import { config } from '../config';
import { decryptBytes, encryptBytes, type Keyring } from './crypto';
import { LocalDiskStore } from './local';
import type { BlobStore } from './types';
import { VercelBlobStore } from './vercel';

export type { BlobStore } from './types';
export { blobKeys } from './types';
export { DecryptionError } from './crypto';

/** Wraps any driver so all bytes at rest are encrypted (AES-256-GCM). */
export class EncryptedBlobStore implements BlobStore {
  constructor(
    private readonly inner: BlobStore,
    private readonly keyring: Keyring,
  ) {}
  put(key: string, bytes: Uint8Array, contentType: string) {
    return this.inner.put(key, encryptBytes(bytes, this.keyring), contentType);
  }
  async get(key: string) {
    const data = await this.inner.get(key);
    return data ? decryptBytes(data, this.keyring) : null;
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
}

/**
 * Current key from config plus optional retired keys for reading old files during a
 * rotation: `FILE_ENCRYPTION_PREVIOUS_KEYS="k1:<base64>,k2:<base64>"` (docs/SECURITY.md).
 */
export function keyringFromConfig(): Keyring {
  const c = config();
  const keys: Record<string, Buffer> = {};
  for (const part of (process.env.FILE_ENCRYPTION_PREVIOUS_KEYS ?? '').split(',')) {
    const [id, b64] = part.trim().split(':');
    if (!id || !b64) continue;
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`FILE_ENCRYPTION_PREVIOUS_KEYS: key ${id} must be 32 bytes, base64`);
    keys[id] = key;
  }
  keys[c.fileEncryptionKeyId] = c.fileEncryptionKey;
  return { currentKeyId: c.fileEncryptionKeyId, keys };
}

let store: BlobStore | null = null;

/**
 * The app's encrypted blob store. `BLOB_READ_WRITE_TOKEN` set => Vercel Blob,
 * otherwise local disk under `${DATA_DIR}/blobs` (dev/test only).
 */
export function getBlobStore(): BlobStore {
  if (store) return store;
  const c = config();
  const driver: BlobStore = c.blobToken
    ? new VercelBlobStore(c.blobToken)
    : new LocalDiskStore(path.resolve(c.dataDir, 'blobs'));
  store = new EncryptedBlobStore(driver, keyringFromConfig());
  return store;
}

/** Test hook. */
export function setBlobStore(s: BlobStore | null): void {
  store = s;
}
