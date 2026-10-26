import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Synthetic "document photos" for the Scan Coach. Each is a light page on a
 * darker desk with rows of dark word-blocks: sharp edges (Laplacian variance far
 * above the blur threshold), mostly horizontal structure (reads as upright), no
 * blown-out pixels (no glare) and a quiet outer band (not "cropped").
 * Every file is different (seeded layout + a label) so no duplicate warnings.
 */
export const FIXTURE_DIR = path.resolve('test-results', 'e2e-fixtures');

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

function documentSvg(width: number, height: number, seed: number, label: string): string {
  const r = rng(seed);
  const mx = Math.round(width * 0.08);
  const my = Math.round(height * 0.08);
  const pw = width - 2 * mx;
  const ph = height - 2 * my;
  const parts: string[] = [
    `<rect width="${width}" height="${height}" fill="#6b6257"/>`,
    `<rect x="${mx}" y="${my}" width="${pw}" height="${ph}" fill="#e9e4d8"/>`,
    `<text x="${mx + 60}" y="${my + 110}" font-family="Arial" font-size="72" font-weight="bold" fill="#1d2a3a">${label}</text>`,
  ];
  const lineH = Math.max(28, Math.round(ph / 46));
  for (let y = my + 180; y < my + ph - 80; y += lineH) {
    let x = mx + 60;
    while (x < mx + pw - 140) {
      const w = 30 + Math.round(r() * 140);
      if (x + w > mx + pw - 60) break;
      const shade = 20 + Math.round(r() * 60);
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${Math.round(lineH * 0.45)}" fill="rgb(${shade},${shade},${shade + 10})"/>`);
      x += w + 14 + Math.round(r() * 16);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

export interface Fixture {
  path: string;
  name: string;
}

let counter = 0;

/** Make a JPEG (default) or PNG document photo. Landscape for passport-type pages. */
export async function makeDocImage(label: string, opts: { landscape?: boolean; format?: 'jpeg' | 'png'; seed?: number } = {}): Promise<Fixture> {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const [w, h] = opts.landscape ? [1800, 1270] : [1700, 2200];
  const seed = opts.seed ?? Date.now() + ++counter * 7919;
  const img = sharp(Buffer.from(documentSvg(w, h, seed, label)));
  const format = opts.format ?? 'jpeg';
  const name = `${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${seed}.${format === 'png' ? 'png' : 'jpg'}`;
  const file = path.join(FIXTURE_DIR, name);
  await (format === 'png' ? img.png({ compressionLevel: 6 }) : img.jpeg({ quality: 88 })).toFile(file);
  return { path: file, name };
}

/** A small, blurry image the Scan Coach must refuse (hard fail). */
export async function makeTooSmallImage(): Promise<Fixture> {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `too_small_${Date.now()}.jpg`);
  await sharp(Buffer.from(documentSvg(800, 1000, 42, 'SMALL'))).blur(6).jpeg().toFile(file);
  return { path: file, name: path.basename(file) };
}

/** Raw JPEG bytes for direct API calls (isolation tests). */
export async function docJpegBytes(label: string, seed = Date.now()): Promise<Buffer> {
  return sharp(Buffer.from(documentSvg(1700, 2200, seed, label))).jpeg({ quality: 85 }).toBuffer();
}

export const PASSPORT_LIKE = new Set(['passport_data_page', 'student_id_face']);
