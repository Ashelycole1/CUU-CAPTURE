/** Scan Coach pure math (FR-UP-2) on synthetic pixel arrays. */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  analyzeRgba,
  compressToLimit,
  croppedSides,
  downscaleGray,
  evaluateQuality,
  glareRatio,
  glareSide,
  hasHardFail,
  laplacianVariance,
  qualitySteps,
  targetDimensions,
  textOrientation,
  toGray,
  type Gray,
  type QualityMetrics,
} from '@/lib/scan/quality';
import { BLUR_HARD, BLUR_SOFT, MAX_STORED_BYTES, MIN_LONG_EDGE, MIN_LONG_EDGE_ID, docProfile } from '@/lib/scan/constants';
import { issueMessage, qualityAnnouncement } from '@/lib/scan/messages';
import { hasJpegEnd, isJpegMagic } from '@/lib/scan/jpeg';

function gray(width: number, height: number, f: (x: number, y: number) => number): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
  return { data, width, height };
}

/** Horizontal "text lines": dark bars on paper. */
const textPage = (w = 400, h = 300) => gray(w, h, (x, y) => (y % 12 < 5 && (x >> 3) % 4 !== 0 ? 30 : 235));

/** Box blur, applied `passes` times. */
function blur(g: Gray, passes = 3, r = 2): Gray {
  let cur = g;
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(cur.data.length);
    for (let y = 0; y < cur.height; y++) {
      for (let x = 0; x < cur.width; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= cur.width || yy >= cur.height) continue;
            s += cur.data[yy * cur.width + xx]!;
            n++;
          }
        }
        out[y * cur.width + x] = s / n;
      }
    }
    cur = { data: out, width: cur.width, height: cur.height };
  }
  return cur;
}

describe('blur (Laplacian variance)', () => {
  it('is 0 for a flat image and high for sharp text', () => {
    expect(laplacianVariance(gray(50, 50, () => 128))).toBe(0);
    expect(laplacianVariance(textPage())).toBeGreaterThan(BLUR_SOFT * 10);
  });

  it('drops sharply after blurring, below the hard threshold', () => {
    const sharpScore = laplacianVariance(textPage());
    const blurred = laplacianVariance(blur(textPage(), 4, 3));
    expect(blurred).toBeLessThan(sharpScore / 20);
    expect(blurred).toBeLessThan(BLUR_HARD);
  });

  it('matches a hand-computed value on a tiny image', () => {
    // 3×3 with a single bright centre: one interior pixel, lap = 0+0+0+0-4*100 = -400 → variance 0 (n=1).
    expect(laplacianVariance(gray(3, 3, (x, y) => (x === 1 && y === 1 ? 100 : 0)))).toBe(0);
    // 4×3: interior pixels (1,1)=100 and (2,1)=0 → laps -400 and 100 → mean -150, variance 62500.
    expect(laplacianVariance(gray(4, 3, (x, y) => (x === 1 && y === 1 ? 100 : 0)))).toBe(62500);
  });
});

describe('glare', () => {
  it('measures the blown-out fraction and where it is', () => {
    const g = gray(300, 100, (x) => (x >= 240 ? 255 : 120)); // right fifth blown out
    expect(glareRatio(g)).toBeCloseTo(0.2, 2);
    expect(glareSide(g)).toBe('right');
    expect(glareSide(gray(300, 100, () => 120))).toBeNull();
  });
});

describe('orientation and crop hints', () => {
  it('detects text lines as upright and the rotated page as sideways', () => {
    const page = textPage(300, 300);
    expect(textOrientation(page)).toBe('upright');
    const rotated = gray(300, 300, (x, y) => page.data[x * 300 + y]!);
    expect(textOrientation(rotated)).toBe('sideways');
    expect(textOrientation(gray(100, 100, () => 200))).toBe('unknown');
  });

  it('flags a side where the content runs into the edge', () => {
    // Plain dark background with a white page; the page runs off the right side and has text near it.
    const g = gray(400, 300, (x, y) => {
      if (x < 40 || y < 30 || y > 270) return 20; // background
      return x > 380 && y % 6 < 3 ? 20 : 235; // busy content in the right band
    });
    expect(croppedSides(g)).toContain('right');
    // A centred page with even margins is not flagged.
    const centred = gray(400, 300, (x, y) => (x > 40 && x < 360 && y > 30 && y < 270 ? 235 : 20));
    expect(croppedSides(centred)).toEqual([]);
  });
});

describe('helpers', () => {
  it('converts RGBA to luma', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const g = toGray(rgba, 3, 1);
    expect([...g.data]).toEqual([255, 0, 76]);
  });

  it('downscales for analysis keeping the aspect ratio', () => {
    const g = downscaleGray(gray(4000, 2000, () => 1), 1000);
    expect([g.width, g.height]).toEqual([1000, 500]);
  });

  it('analyzeRgba produces sane metrics for a clean page', () => {
    const page = textPage(400, 300);
    const rgba = new Uint8ClampedArray(page.data.length * 4);
    page.data.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
    const m = analyzeRgba(rgba, 400, 300);
    expect(m.blur).toBeGreaterThan(BLUR_SOFT);
    expect(m.glare).toBe(0);
    expect(m.orientation).toBe('upright');
  });
});

describe('sizing and compression math', () => {
  it('caps at 12 MP and never upscales', () => {
    const big = targetDimensions(4032 * 1.5, 3024 * 1.5); // ~27 MP
    expect(big.scaled).toBe(true);
    expect(big.width * big.height).toBeLessThanOrEqual(12_000_000);
    expect(big.width / big.height).toBeCloseTo(4 / 3, 2);
    expect(targetDimensions(2000, 1500)).toEqual({ width: 2000, height: 1500, scaled: false });
  });

  it('quality ladder is 0.85 → 0.70 and never below 0.7', () => {
    expect(qualitySteps()).toEqual([0.85, 0.8, 0.75, 0.7]);
  });

  it('steps quality down until the file fits', async () => {
    const sizes: Record<string, number> = { '0.85': 4e6, '0.8': 3.5e6, '0.75': 2.9e6, '0.7': 2e6 };
    const tried: number[] = [];
    const r = await compressToLimit(async (q) => {
      tried.push(q);
      return { bytes: q, size: sizes[String(q)]! };
    });
    expect(tried).toEqual([0.85, 0.8, 0.75]);
    expect(r).toMatchObject({ quality: 0.75, overLimit: false });
  });

  it('reports overLimit at the floor instead of going below 0.7', async () => {
    const r = await compressToLimit(async () => ({ bytes: null, size: MAX_STORED_BYTES + 1 }));
    expect(r.quality).toBe(0.7);
    expect(r.overLimit).toBe(true);
  });

  it('works with a real encoder (sharp stands in for canvas.toBlob)', async () => {
    const noise = Buffer.alloc(2400 * 1800 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const img = sharp(noise, { raw: { width: 2400, height: 1800, channels: 3 } });
    const r = await compressToLimit(async (q) => {
      const b = await img.clone().jpeg({ quality: Math.round(q * 100) }).toBuffer();
      return { bytes: b, size: b.byteLength };
    });
    expect(isJpegMagic(r.bytes)).toBe(true);
    expect(hasJpegEnd(r.bytes)).toBe(true);
    if (!r.overLimit) expect(r.size).toBeLessThanOrEqual(MAX_STORED_BYTES);
    expect(r.quality).toBeGreaterThanOrEqual(0.7);
  });
});

describe('verdict and messages', () => {
  const base: QualityMetrics = { width: 2000, height: 1500, bytes: 900_000, blur: 300, glare: 0, glareSide: null, brightness: 180, orientation: 'upright', cropped: [] };

  it('passes a good scan', () => {
    expect(evaluateQuality(base, docProfile('fees_statement'))).toEqual([]);
    expect(qualityAnnouncement([])).toMatch(/sharp\. Ready to upload/);
  });

  it('hard-fails tiny, very blurry or glare-washed scans; soft-warns the rest', () => {
    const issues = evaluateQuality({ ...base, width: 1500, height: 1000, blur: 10, glare: 0.3, glareSide: 'right' }, docProfile('fees_statement'));
    expect(issues.map((i) => i.code)).toEqual(['too_small', 'too_blurry', 'glare_hard']);
    expect(hasHardFail(issues)).toBe(true);
    const soft = evaluateQuality({ ...base, blur: 40, glare: 0.08, glareSide: 'left', brightness: 30, orientation: 'sideways', cropped: ['top'] }, docProfile('x'));
    expect(soft.every((i) => i.severity === 'soft')).toBe(true);
    expect(soft.map((i) => i.code)).toEqual(['blurry', 'glare', 'too_dark', 'sideways', 'cropped']);
  });

  it('uses 1200 px for passport/ID and 1600 px otherwise', () => {
    expect(docProfile('passport_data_page').minLongEdge).toBe(MIN_LONG_EDGE_ID);
    expect(docProfile('student_id_face').minLongEdge).toBe(MIN_LONG_EDGE_ID);
    expect(docProfile('admission_letter').minLongEdge).toBe(MIN_LONG_EDGE);
    const m = { ...base, width: 1300, height: 900 };
    expect(evaluateQuality(m, docProfile('passport_data_page'))).toEqual([]);
    expect(evaluateQuality(m, docProfile('admission_letter'))[0]!.code).toBe('too_small');
  });

  it('messages are plain-language instructions', () => {
    expect(issueMessage({ code: 'too_blurry', severity: 'hard' })).toBe('Too blurry. Hold steady, tap to focus, and retake.');
    expect(issueMessage({ code: 'glare', severity: 'soft', detail: 'right' })).toMatch(/on the right side/);
    expect(issueMessage({ code: 'cropped', severity: 'soft', detail: 'top,left' })).toMatch(/\(top, left\)/);
    expect(issueMessage({ code: 'too_small', severity: 'hard', detail: '1600' })).toMatch(/1600 px/);
  });
});
