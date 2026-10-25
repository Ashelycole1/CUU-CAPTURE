/**
 * Re-encrypt every stored file with the CURRENT file key (docs/SECURITY.md "Key rotation").
 * Run with the new key as FILE_ENCRYPTION_KEY / FILE_ENCRYPTION_KEY_ID and the old one in
 * FILE_ENCRYPTION_PREVIOUS_KEYS, plus DATABASE_URL/DATABASE_AUTH_TOKEN/BLOB_READ_WRITE_TOKEN:
 *   npx tsx --conditions=react-server --env-file=.env.rotate scripts/rotate-file-key.ts [--dry-run]
 * Files already on the current key are skipped, so it is safe to re-run after an interruption.
 */
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from '../src/server/db/client';
import { config } from '../src/server/config';
import { documentVersions, packets, payments } from '../src/server/db/schema';
import { decryptBytes, encryptBytes } from '../src/server/storage/crypto';
import { keyringFromConfig } from '../src/server/storage';
import { LocalDiskStore } from '../src/server/storage/local';
import { VercelBlobStore } from '../src/server/storage/vercel';
import type { BlobStore } from '../src/server/storage/types';

function keyIdOf(data: Uint8Array): string | null {
  if (data.length < 6 || Buffer.from(data.subarray(0, 4)).toString('ascii') !== 'VDE1') return null;
  return Buffer.from(data.subarray(5, 5 + data[4]!)).toString('ascii');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const c = config();
  const keyring = keyringFromConfig();
  const driver: BlobStore = c.blobToken ? new VercelBlobStore(c.blobToken) : new LocalDiskStore(path.resolve(c.dataDir, 'blobs'));
  const h = await openDb(c.databaseUrl, c.databaseAuthToken);
  const stats = { checked: 0, rotated: 0, missing: 0, skipped: 0 };

  async function rotate(key: string | null): Promise<string | null> {
    if (!key) return key;
    stats.checked++;
    const raw = await driver.get(key);
    if (!raw) {
      stats.missing++;
      return key;
    }
    if (keyIdOf(raw) === keyring.currentKeyId) {
      stats.skipped++;
      return key;
    }
    if (dryRun) {
      stats.rotated++;
      return key;
    }
    const plain = decryptBytes(raw, keyring);
    const logical = key.replace(/-[A-Za-z0-9]{20,}(\.[a-z]+)$/, '$1'); // drop Vercel's random suffix
    const { key: newKey } = await driver.put(logical, encryptBytes(plain, keyring), 'application/octet-stream');
    stats.rotated++;
    return newKey;
  }

  for (const v of await h.db.select().from(documentVersions)) {
    if (v.deletedAt) continue;
    const storageKey = await rotate(v.storageKey);
    const thumbKey = await rotate(v.thumbKey);
    if (storageKey !== v.storageKey || thumbKey !== v.thumbKey) {
      await h.db.update(documentVersions).set({ storageKey: storageKey!, thumbKey }).where(eq(documentVersions.id, v.id));
      if (storageKey !== v.storageKey) await driver.delete(v.storageKey);
      if (thumbKey !== v.thumbKey && v.thumbKey) await driver.delete(v.thumbKey);
    }
  }
  for (const p of await h.db.select().from(packets)) {
    const k = await rotate(p.storageKey);
    if (k !== p.storageKey) {
      await h.db.update(packets).set({ storageKey: k }).where(eq(packets.id, p.id));
      if (p.storageKey) await driver.delete(p.storageKey);
    }
  }
  for (const p of await h.db.select().from(payments)) {
    const k = await rotate(p.receiptKey);
    if (k !== p.receiptKey) {
      await h.db.update(payments).set({ receiptKey: k }).where(eq(payments.id, p.id));
      if (p.receiptKey) await driver.delete(p.receiptKey);
    }
  }
  h.client.close();
  console.log(JSON.stringify({ ok: true, dryRun, currentKeyId: keyring.currentKeyId, ...stats }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
