/** JPEG sniffing helpers (pure; used by the server route and the client). */

/** JPEG files start with SOI (FF D8) followed by a marker byte (FF). */
export function isJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** JPEG files end with EOI (FF D9), allowing trailing padding zeros. */
export function hasJpegEnd(bytes: Uint8Array): boolean {
  let end = bytes.length;
  while (end > 2 && bytes[end - 1] === 0x00) end--;
  return end >= 2 && bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9;
}
