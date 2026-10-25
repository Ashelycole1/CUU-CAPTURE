/**
 * Client-side conversion (FR-UP-1): JPG/PNG/WebP/HEIC/PDF → canvas → JPEG.
 * Browser only. Heavy libraries (heic2any, pdfjs-dist) are loaded lazily with
 * dynamic import so the student route bundle stays small (NFR-PERF).
 */
import { ANALYSIS_LONG_EDGE, MAX_STORED_BYTES } from './constants';
import { compressToLimit, targetDimensions } from './quality';

export type InputKind = 'image' | 'heic' | 'pdf' | 'unsupported';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

/** Decide how to open a file: MIME type, then extension, then magic bytes. */
export async function detectKind(file: Blob & { name?: string }): Promise<InputKind> {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/.test(name)) return 'heic';
  if (IMAGE_TYPES.has(type) || /\.(jpe?g|png|webp)$/.test(name)) return 'image';
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.slice(4, 8) === 'ftyp' && /heic|heix|hevc|mif1|msf1|heif/.test(ascii.slice(8, 12))) return 'heic';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image';
  return 'unsupported';
}

export type Source = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

export function sourceSize(s: Source): { width: number; height: number } {
  if (s instanceof HTMLImageElement) return { width: s.naturalWidth, height: s.naturalHeight };
  return { width: s.width, height: s.height };
}

/** Decode a browser-supported image, honouring EXIF orientation. */
export async function decodeImage(blob: Blob): Promise<Source> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall back to <img> (older Safari) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // Revoke after decode; the decoded bitmap stays usable.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** HEIC/HEIF (iPhone) → JPEG blob via heic2any (lazy). Safari can often decode HEIC natively; try that first. */
export async function heicToBlob(file: Blob): Promise<Blob> {
  try {
    const native = await createImageBitmap(file);
    native.close();
    return file;
  } catch {
    /* not natively supported */
  }
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(out) ? out[0]! : out;
}

// ---------------------------------------------------------------- PDF (lazy pdfjs-dist)

export interface PdfHandle {
  numPages: number;
  /** Render one page (1-based) so its long edge is about `longEdge` px. */
  render(page: number, longEdge: number): Promise<HTMLCanvasElement>;
  destroy(): void;
}

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
    }
    return pdfjs;
  });
  return pdfjsPromise;
}

export async function openPdf(file: Blob): Promise<PdfHandle> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  return {
    numPages: doc.numPages,
    async render(pageNo, longEdge) {
      const page = await doc.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = longEdge / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      return canvas;
    },
    destroy() {
      void doc.destroy();
    },
  };
}

/** PDF pages are rendered at this long edge (≈ 200 dpi for A4), comfortably above 1600 px. */
export const PDF_RENDER_LONG_EDGE = 2339;

// ---------------------------------------------------------------- canvas → JPEG

/** Draw a source onto a canvas, rotated by 0/90/180/270°, capped at 12 MP. */
export function drawToCanvas(src: Source, rotation: 0 | 90 | 180 | 270 = 0): HTMLCanvasElement {
  const { width: sw, height: sh } = sourceSize(src);
  const { width, height } = targetDimensions(sw, sh);
  const swap = rotation === 90 || rotation === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? height : width;
  canvas.height = swap ? width : height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // transparent PNG areas become white, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(src, -width / 2, -height / 2, width, height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality));
}

export interface EncodedScan {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
  overLimit: boolean;
}

/** Encode as JPEG at 0.85, stepping down to 0.70 until ≤ 3 MB (FR-UP-2). */
export async function canvasToJpeg(canvas: HTMLCanvasElement, maxBytes = MAX_STORED_BYTES): Promise<EncodedScan> {
  const r = await compressToLimit(async (q) => {
    const b = await toBlob(canvas, q);
    return { bytes: b, size: b.size };
  }, maxBytes);
  return { blob: r.bytes, width: canvas.width, height: canvas.height, quality: r.quality, overLimit: r.overLimit };
}

/** Downscaled RGBA copy for the quality worker. */
export function analysisPixels(canvas: HTMLCanvasElement): { data: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}
