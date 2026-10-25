/**
 * Scan Coach thresholds (FR-UP-1/2/3). Single source of truth for the client
 * pipeline AND the server re-validation in `POST /api/uploads`. Pure (no DOM,
 * no Node), so it is safe on both sides.
 */

/** Stored JPEGs are at most 3 MB (FR-UP-2). */
export const MAX_STORED_BYTES = 3 * 1024 * 1024;
/** Request body guard (Vercel functions cap bodies at 4.5 MB). */
export const MAX_REQUEST_BYTES = Math.floor(4.4 * 1024 * 1024);
/** Default minimum long edge in px. */
export const MIN_LONG_EDGE = 1600;
/** Passport / ID minimum long edge in px. */
export const MIN_LONG_EDGE_ID = 1200;
/** Downscale anything above 12 megapixels before checks (PRD §7). */
export const MAX_PIXELS = 12_000_000;
/** Hard ceiling on accepted dimensions (decompression-bomb guard on the server). */
export const MAX_LONG_EDGE = 8000;
/** Initial JPEG quality, the step, and the floor (never below 0.7). */
export const JPEG_QUALITY_START = 0.85;
export const JPEG_QUALITY_STEP = 0.05;
export const JPEG_QUALITY_MIN = 0.7;
/** Thumbnail long edge in px (server). */
export const THUMB_LONG_EDGE = 400;
export const THUMB_QUALITY = 75;
/** Server re-encode quality when metadata must be stripped (sharp scale 1–100). */
export const SERVER_REENCODE_QUALITY = 85;

/** Quality analysis runs on a downscaled grey copy with this long edge. */
export const ANALYSIS_LONG_EDGE = 1024;

/**
 * Laplacian variance (on the analysis copy, 0–255 grey). Below HARD = blocked,
 * below SOFT = warning. Tuned conservatively: paper documents photographed in
 * focus usually score well above 150; motion blur drops below 40.
 */
export const BLUR_HARD = 25;
export const BLUR_SOFT = 60;

/** A pixel counts as blown out when its grey value is at least this. */
export const GLARE_PIXEL = 250;
/** Fraction of blown-out pixels: above SOFT = warning, above HARD = blocked. */
export const GLARE_SOFT = 0.04;
export const GLARE_HARD = 0.25;

/** Mean brightness below this is "too dark" (soft). */
export const DARK_MEAN = 45;

/**
 * Edge-crop hint: if the outer band (this fraction of each side) has strong
 * edges on a side, the document probably runs off that side.
 */
export const EDGE_BAND = 0.03;
/** Mean gradient magnitude in the outer band (relative to the whole image) that suggests a cut-off side. */
export const EDGE_CROP_RATIO = 1.6;

export type FrameShape = 'passport' | 'id_card' | 'photo' | 'a4';

export interface DocProfile {
  minLongEdge: number;
  frame: FrameShape;
  /** Expected orientation of the finished scan. */
  orientation: 'landscape' | 'portrait';
}

/** Per-document capture profile. Unknown codes get the A4 default. */
export const DOC_PROFILES: Record<string, DocProfile> = {
  passport_data_page: { minLongEdge: MIN_LONG_EDGE_ID, frame: 'passport', orientation: 'landscape' },
  visa_status_page: { minLongEdge: MIN_LONG_EDGE_ID, frame: 'passport', orientation: 'portrait' },
  student_id_face: { minLongEdge: MIN_LONG_EDGE_ID, frame: 'id_card', orientation: 'landscape' },
  passport_photos: { minLongEdge: MIN_LONG_EDGE_ID, frame: 'photo', orientation: 'portrait' },
};

export const DEFAULT_DOC_PROFILE: DocProfile = { minLongEdge: MIN_LONG_EDGE, frame: 'a4', orientation: 'portrait' };

export function docProfile(docCode: string): DocProfile {
  return DOC_PROFILES[docCode] ?? DEFAULT_DOC_PROFILE;
}

/** Aspect ratio (width / height) of the on-screen frame guide. */
export const FRAME_ASPECT: Record<FrameShape, number> = {
  passport: 125 / 88,
  id_card: 85.6 / 54,
  photo: 35 / 45,
  a4: 210 / 297,
};

/** Accepted input types (FR-UP-1). */
export const ACCEPT_INPUT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif,.jpg,.jpeg,.png,.webp,.pdf';

/** Upload retry policy (FR-UP-4). */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
export const RETRY_MAX_ATTEMPTS = 8;
