import 'server-only';
/**
 * Server re-validation of an uploaded scan (FR-UP-3). Never trusts the client:
 * JPEG magic bytes, a full decode, dimensions and size limits, orientation applied
 * and EXIF/metadata stripped (re-encode only when needed), SHA-256 of the stored
 * bytes, and a 400 px thumbnail.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ValidationError } from '@/server/errors';
import {
  MAX_LONG_EDGE,
  MAX_PIXELS,
  MAX_STORED_BYTES,
  SERVER_REENCODE_QUALITY,
  THUMB_LONG_EDGE,
  THUMB_QUALITY,
} from '@/lib/scan/constants';
import { isJpegMagic } from '@/lib/scan/jpeg';

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
type SharpOutput = { data: Buffer; info: { width: number; height: number } };

export interface ProcessedScan {
  /** Bytes to store (a clean JPEG, no EXIF). */
  jpeg: Buffer;
  thumb: Buffer;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  /** True when the server re-encoded the file (orientation/metadata removed). */
  reencoded: boolean;
}

function reject(message: string, field = 'file'): never {
  throw new ValidationError(message, { [field]: message });
}

/** Rotate by EXIF orientation, drop all metadata, encode; step quality down if needed. */
async function reencode(input: Buffer): Promise<SharpOutput> {
  for (const quality of [SERVER_REENCODE_QUALITY, 80, 75, 70]) {
    // sharp drops EXIF/XMP/IPTC/ICC unless keepMetadata/withMetadata is called.
    const out = await sharp(input, { failOn: 'error', limitInputPixels: MAX_LONG_EDGE * MAX_LONG_EDGE })
      .rotate()
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (out.data.byteLength <= MAX_STORED_BYTES) return out;
  }
  reject('The image is too large. Retake it or choose a smaller photo.');
}

export async function processScan(input: Uint8Array, opts: { minLongEdge: number }): Promise<ProcessedScan> {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isJpegMagic(buf)) reject('Only JPG images can be uploaded. Use the Scan Coach to convert your file.');
  if (buf.byteLength > MAX_STORED_BYTES) reject('The image is larger than 3 MB. Retake it or let the Scan Coach compress it.');

  let meta: SharpMetadata;
  try {
    meta = await sharp(buf, { failOn: 'error', limitInputPixels: MAX_LONG_EDGE * MAX_LONG_EDGE }).metadata();
  } catch {
    reject("We couldn't read this image. Try retaking it.");
  }
  if (meta.format !== 'jpeg' || !meta.width || !meta.height) reject("We couldn't read this image. Try retaking it.");

  const longEdge = Math.max(meta.width, meta.height);
  if (longEdge > MAX_LONG_EDGE || meta.width * meta.height > MAX_PIXELS * 1.05) {
    reject('The image is too large. Let the Scan Coach resize it and try again.');
  }
  if (longEdge < opts.minLongEdge) {
    reject(`The image is too small. It needs at least ${opts.minLongEdge} px on the long side. Move closer or use a better photo.`);
  }

  const hasOrientation = meta.orientation !== undefined && meta.orientation !== 1;
  const hasMetadata = Boolean(meta.exif || meta.xmp || meta.iptc || meta.icc || (meta.comments && meta.comments.length));
  let jpeg: Buffer;
  let width = meta.width;
  let height = meta.height;
  let reencoded = false;
  try {
    if (hasOrientation || hasMetadata) {
      const out = await reencode(buf);
      jpeg = out.data;
      width = out.info.width;
      height = out.info.height;
      reencoded = true;
    } else {
      // Full decode to prove the file is a complete, valid JPEG (also catches truncation).
      await sharp(buf, { failOn: 'error', limitInputPixels: MAX_LONG_EDGE * MAX_LONG_EDGE }).raw().toBuffer();
      jpeg = buf;
    }
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    reject("We couldn't read this image. Try retaking it.");
  }

  const thumb = await sharp(jpeg)
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();

  return {
    jpeg,
    thumb,
    sha256: createHash('sha256').update(jpeg).digest('hex'),
    width,
    height,
    bytes: jpeg.byteLength,
    reencoded,
  };
}
