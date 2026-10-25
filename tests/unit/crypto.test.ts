import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptBytes, DecryptionError, encryptBytes, type Keyring } from '@/server/storage/crypto';
import { EncryptedBlobStore } from '@/server/storage';
import { LocalDiskStore } from '@/server/storage/local';

const keyring: Keyring = { currentKeyId: 'k1', keys: { k1: Buffer.alloc(32, 1) } };

describe('file encryption (AES-256-GCM)', () => {
  it('round-trips bytes', () => {
    const plain = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]);
    const enc = encryptBytes(plain, keyring);
    expect(Buffer.from(enc).subarray(0, 4).toString()).toBe('VDE1');
    expect(Buffer.from(enc).includes(Buffer.from(plain))).toBe(false);
    expect(Array.from(decryptBytes(enc, keyring))).toEqual(Array.from(plain));
  });
  it('uses a fresh IV per file', () => {
    const plain = new Uint8Array(100);
    expect(Buffer.from(encryptBytes(plain, keyring)).equals(Buffer.from(encryptBytes(plain, keyring)))).toBe(false);
  });
  it('detects tampering of ciphertext, tag, IV and header', () => {
    const enc = encryptBytes(new Uint8Array(64).fill(9), keyring);
    for (const idx of [enc.length - 1, 5 + 2 + 12 + 3, 5 + 2 + 1, 6]) {
      const bad = new Uint8Array(enc);
      bad[idx] = bad[idx]! ^ 0x01;
      expect(() => decryptBytes(bad, keyring)).toThrow(DecryptionError);
    }
  });
  it('rejects unknown key ids and supports rotation', () => {
    const enc = encryptBytes(new Uint8Array([1, 2, 3]), keyring);
    expect(() => decryptBytes(enc, { currentKeyId: 'k2', keys: { k2: Buffer.alloc(32, 2) } })).toThrow(DecryptionError);
    const rotated: Keyring = { currentKeyId: 'k2', keys: { k1: keyring.keys.k1!, k2: Buffer.alloc(32, 2) } };
    expect(Array.from(decryptBytes(enc, rotated))).toEqual([1, 2, 3]);
    const enc2 = encryptBytes(new Uint8Array([4]), rotated);
    expect(Buffer.from(enc2).subarray(5, 7).toString()).toBe('k2');
  });
  it('rejects non-envelope data', () => {
    expect(() => decryptBytes(new Uint8Array([1, 2, 3]), keyring)).toThrow(DecryptionError);
  });
  it('EncryptedBlobStore stores only ciphertext on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-blob-'));
    const store = new EncryptedBlobStore(new LocalDiskStore(dir), keyring);
    const plain = new TextEncoder().encode('SECRET PASSPORT BYTES');
    const { key } = await store.put('app1/passport_data_page/1.jpg', plain, 'image/jpeg');
    expect(key).toBe('app1/passport_data_page/1.jpg');
    const raw = fs.readFileSync(path.join(dir, key));
    expect(raw.includes(Buffer.from('SECRET'))).toBe(false);
    expect(new TextDecoder().decode((await store.get(key))!)).toBe('SECRET PASSPORT BYTES');
    expect(await store.exists(key)).toBe(true);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    await expect(store.put('../escape.jpg', plain, 'image/jpeg')).rejects.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
