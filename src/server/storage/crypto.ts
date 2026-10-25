import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest file encryption: AES-256-GCM, random 96-bit IV per file.
 *
 * Envelope layout (all files written through `EncryptedBlobStore`):
 *   magic "VDE1" (4) | keyIdLen (1) | keyId (ascii) | iv (12) | tag (16) | ciphertext
 * The header (magic + keyId) is bound as AAD, so tampering with any byte fails.
 * The key id lets us rotate keys: decryption looks up the key by id in the keyring.
 */
const MAGIC = Buffer.from('VDE1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;

export interface Keyring {
  /** Key used for new writes. */
  currentKeyId: string;
  keys: Record<string, Buffer>;
}

export class DecryptionError extends Error {
  constructor(message = 'File could not be decrypted (tampered or wrong key)') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function encryptBytes(plain: Uint8Array, keyring: Keyring): Uint8Array {
  const key = keyring.keys[keyring.currentKeyId];
  if (!key || key.length !== 32) throw new Error('Encryption key missing or not 32 bytes');
  const keyId = Buffer.from(keyring.currentKeyId, 'ascii');
  if (keyId.length === 0 || keyId.length > 255) throw new Error('Invalid key id');
  const header = Buffer.concat([MAGIC, Buffer.from([keyId.length]), keyId]);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([header, iv, tag, ct]));
}

export function decryptBytes(data: Uint8Array, keyring: Keyring): Uint8Array {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < MAGIC.length + 1 + IV_LEN + TAG_LEN || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new DecryptionError('Not an encrypted VisaDesk file');
  }
  const keyIdLen = buf[4]!;
  const headerLen = 5 + keyIdLen;
  if (buf.length < headerLen + IV_LEN + TAG_LEN) throw new DecryptionError();
  const keyId = buf.subarray(5, headerLen).toString('ascii');
  const key = keyring.keys[keyId];
  if (!key) throw new DecryptionError(`Unknown encryption key id: ${keyId}`);
  const header = buf.subarray(0, headerLen);
  const iv = buf.subarray(headerLen, headerLen + IV_LEN);
  const tag = buf.subarray(headerLen + IV_LEN, headerLen + IV_LEN + TAG_LEN);
  const ct = buf.subarray(headerLen + IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch {
    throw new DecryptionError();
  }
}
