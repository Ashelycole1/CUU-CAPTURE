/**
 * Blob storage contract. Drivers store opaque bytes; `EncryptedBlobStore` wraps a
 * driver so every byte at rest is AES-256-GCM encrypted.
 *
 * Keys are logical paths, e.g. `{application_id}/{doc_code}/{seq}.jpg`. A driver MAY
 * rewrite the key on `put` (Vercel Blob appends a random suffix) — ALWAYS persist the
 * key returned by `put`, never the one you passed in.
 *
 * Never expose keys or provider URLs to clients; serve files only via
 * `GET /api/files/[versionId]` (authz-checked, decrypted, no-store).
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }>;
  /** null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Storage key helpers (single source of truth for the layout). */
export const blobKeys = {
  documentVersion: (applicationId: string, docCode: string, seq: number) => `${applicationId}/${docCode}/${seq}.jpg`,
  documentThumb: (applicationId: string, docCode: string, seq: number) => `${applicationId}/${docCode}/${seq}_thumb.jpg`,
  packet: (applicationId: string, packetId: string) => `packets/${applicationId}/${packetId}.zip`,
  receipt: (applicationId: string, paymentId: string) => `receipts/${applicationId}/${paymentId}.jpg`,
};
