/**
 * Pure image-quality math (FR-UP-2). Operates on plain pixel arrays so it runs in
 * a Web Worker, in tests, or anywhere else. No DOM, no Node.
 */
import {
  ANALYSIS_LONG_EDGE,
  BLUR_HARD,
  BLUR_SOFT,
  DARK_MEAN,
  EDGE_BAND,
  EDGE_CROP_RATIO,
  GLARE_HARD,
  GLARE_PIXEL,
  GLARE_SOFT,
  JPEG_QUALITY_MIN,
  JPEG_QUALITY_START,
  JPEG_QUALITY_STEP,
  MAX_PIXELS,
  MAX_STORED_BYTES,
  type DocProfile,
} from './constants';

export interface Gray {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** RGBA (canvas ImageData layout) → luma (BT.601). */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (rgba[i]! * 299 + rgba[i + 1]! * 587 + rgba[i + 2]! * 114) / 1000;
  }
  return { data: out, width, height };
}

/**
 * Variance of the 4-neighbour Laplacian. Sharp images have strong second
 * derivatives (high variance); blurred images do not.
 */
export function laplacianVariance(g: Gray): number {
  const { data, width: w, height: h } = g;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const lap = data[i - w]! + data[i + w]! + data[i - 1]! + data[i + 1]! - 4 * data[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Fraction of pixels at or above `threshold` (blown-out highlights / glare). */
export function glareRatio(g: Gray, threshold = GLARE_PIXEL): number {
  let c = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i]! >= threshold) c++;
  return g.data.length ? c / g.data.length : 0;
}

export function meanBrightness(g: Gray): number {
  let s = 0;
  for (let i = 0; i < g.data.length; i++) s += g.data[i]!;
  return g.data.length ? s / g.data.length : 0;
}

/** Where is the glare? Splits the image into left/centre/right thirds. */
export function glareSide(g: Gray, threshold = GLARE_PIXEL): 'left' | 'centre' | 'right' | null {
  const counts = [0, 0, 0];
  const third = g.width / 3;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (g.data[y * g.width + x]! >= threshold) counts[Math.min(2, Math.floor(x / third))]!++;
    }
  }
  const total = counts[0]! + counts[1]! + counts[2]!;
  if (!total) return null;
  const max = Math.max(...counts);
  if (max / total < 0.5) return null;
  return (['left', 'centre', 'right'] as const)[counts.indexOf(max)]!;
}

/**
 * Rough orientation: text lines produce more horizontal edges (vertical
 * gradients) than vertical ones. Returns 'sideways' when vertical edges clearly
 * dominate, which usually means the page is rotated 90°.
 */
export function textOrientation(g: Gray): 'upright' | 'sideways' | 'unknown' {
  const { data, width: w, height: h } = g;
  let gx = 0;
  let gy = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx += Math.abs(data[i + 1]! - data[i - 1]!);
      gy += Math.abs(data[i + w]! - data[i - w]!);
    }
  }
  if (gx + gy < w * h) return 'unknown'; // almost no structure
  if (gx > gy * 1.35) return 'sideways';
  if (gy > gx * 1.05) return 'upright';
  return 'unknown';
}

export type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * Edge-crop hint: strong gradients in a thin outer band suggest the document
 * runs off that side of the frame.
 */
export function croppedSides(g: Gray, band = EDGE_BAND, ratio = EDGE_CROP_RATIO): Side[] {
  const { data, width: w, height: h } = g;
  const bw = Math.max(2, Math.round(w * band));
  const bh = Math.max(2, Math.round(h * band));
  const grad = (x: number, y: number) => {
    const i = y * w + x;
    return Math.abs(data[i + 1]! - data[i - 1]!) + Math.abs(data[i + w]! - data[i - w]!);
  };
  let total = 0;
  let n = 0;
  const acc: Record<Side, [number, number]> = { top: [0, 0], bottom: [0, 0], left: [0, 0], right: [0, 0] };
  const add = (a: [number, number], v: number) => {
    a[0] += v;
    a[1]++;
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = grad(x, y);
      total += v;
      n++;
      if (y <= bh) add(acc.top, v);
      if (y >= h - 1 - bh) add(acc.bottom, v);
      if (x <= bw) add(acc.left, v);
      if (x >= w - 1 - bw) add(acc.right, v);
    }
  }
  const mean = n ? total / n : 0;
  if (mean < 1) return [];
  return (Object.keys(acc) as Side[]).filter((s) => acc[s][1] > 0 && acc[s][0] / acc[s][1] > mean * ratio);
}

/** Downscale factor so that the long edge is ≤ `longEdge` (nearest-neighbour, for analysis only). */
export function downscaleGray(g: Gray, longEdge = ANALYSIS_LONG_EDGE): Gray {
  const scale = Math.min(1, longEdge / Math.max(g.width, g.height));
  if (scale === 1) return g;
  const w = Math.max(1, Math.round(g.width * scale));
  const h = Math.max(1, Math.round(g.height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) out[y * w + x] = g.data[sy * g.width + Math.min(g.width - 1, Math.floor(x / scale))]!;
  }
  return { data: out, width: w, height: h };
}

// ---------------------------------------------------------------- sizing

/**
 * Target canvas size: keep the aspect ratio, cap at MAX_PIXELS (PRD §7).
 * Never upscales.
 */
export function targetDimensions(width: number, height: number, maxPixels = MAX_PIXELS): { width: number; height: number; scaled: boolean } {
  const px = width * height;
  if (px <= maxPixels) return { width, height, scaled: false };
  const s = Math.sqrt(maxPixels / px);
  return { width: Math.floor(width * s), height: Math.floor(height * s), scaled: true };
}

/** The quality ladder: 0.85, 0.80, 0.75, 0.70 (never below the floor). */
export function qualitySteps(start = JPEG_QUALITY_START, step = JPEG_QUALITY_STEP, min = JPEG_QUALITY_MIN): number[] {
  const out: number[] = [];
  for (let q = start; q >= min - 1e-9; q -= step) out.push(Math.round(q * 100) / 100);
  return out;
}

export interface CompressResult<T> {
  bytes: T;
  size: number;
  quality: number;
  /** True when even the floor quality is still above the limit. */
  overLimit: boolean;
}

/**
 * Encode at decreasing quality until ≤ maxBytes. `encode` is injected (canvas in
 * the browser, sharp in tests). Stops at the floor and reports `overLimit`.
 */
export async function compressToLimit<T>(
  encode: (quality: number) => Promise<{ bytes: T; size: number }>,
  maxBytes = MAX_STORED_BYTES,
): Promise<CompressResult<T>> {
  let last: { bytes: T; size: number; quality: number } | null = null;
  for (const q of qualitySteps()) {
    const r = await encode(q);
    last = { ...r, quality: q };
    if (r.size <= maxBytes) return { ...last, overLimit: false };
  }
  return { ...last!, overLimit: true };
}

// ---------------------------------------------------------------- verdict

export type IssueCode = 'too_small' | 'too_blurry' | 'blurry' | 'glare_hard' | 'glare' | 'too_dark' | 'sideways' | 'cropped' | 'too_big';

export interface QualityIssue {
  code: IssueCode;
  severity: 'hard' | 'soft';
  /** Extra info for the message (e.g. which side). */
  detail?: string;
}

export interface QualityMetrics {
  width: number;
  height: number;
  bytes: number;
  blur: number;
  glare: number;
  glareSide: 'left' | 'centre' | 'right' | null;
  brightness: number;
  orientation: 'upright' | 'sideways' | 'unknown';
  cropped: Side[];
}

/** Turn metrics into hard fails (block upload) and soft warnings ("Use anyway"). */
export function evaluateQuality(m: QualityMetrics, profile: Pick<DocProfile, 'minLongEdge'>, maxBytes = MAX_STORED_BYTES): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (Math.max(m.width, m.height) < profile.minLongEdge) issues.push({ code: 'too_small', severity: 'hard', detail: String(profile.minLongEdge) });
  if (m.bytes > maxBytes) issues.push({ code: 'too_big', severity: 'hard' });
  if (m.blur < BLUR_HARD) issues.push({ code: 'too_blurry', severity: 'hard' });
  else if (m.blur < BLUR_SOFT) issues.push({ code: 'blurry', severity: 'soft' });
  if (m.glare > GLARE_HARD) issues.push({ code: 'glare_hard', severity: 'hard', detail: m.glareSide ?? undefined });
  else if (m.glare > GLARE_SOFT) issues.push({ code: 'glare', severity: 'soft', detail: m.glareSide ?? undefined });
  if (m.brightness < DARK_MEAN) issues.push({ code: 'too_dark', severity: 'soft' });
  if (m.orientation === 'sideways') issues.push({ code: 'sideways', severity: 'soft' });
  if (m.cropped.length) issues.push({ code: 'cropped', severity: 'soft', detail: m.cropped.join(',') });
  return issues;
}

export function hasHardFail(issues: QualityIssue[]): boolean {
  return issues.some((i) => i.severity === 'hard');
}

/** Analyse an RGBA buffer (what the worker does). */
export function analyzeRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Omit<QualityMetrics, 'width' | 'height' | 'bytes'> {
  const g = downscaleGray(toGray(rgba, width, height));
  return {
    blur: Math.round(laplacianVariance(g) * 10) / 10,
    glare: Math.round(glareRatio(g) * 10000) / 10000,
    glareSide: glareSide(g),
    brightness: Math.round(meanBrightness(g)),
    orientation: textOrientation(g),
    cropped: croppedSides(g),
  };
}
