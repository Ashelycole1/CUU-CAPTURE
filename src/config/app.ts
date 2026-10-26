/**
 * Public, client-safe app constants. The product name lives here and only here.
 * (Server-only configuration is in `src/server/config.ts`.)
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'VisaDesk';
export const UNIVERSITY_NAME = 'Cavendish University Uganda';
export const DOS_EMAIL = 'dos@cavendish.ac.ug';
export const DEFAULT_TIMEZONE = 'Africa/Kampala';
export const SESSION_COOKIE = 'vd_session';
/**
 * Official university crest. Drop the file into `public/brand/` and set this path
 * (e.g. '/brand/cuu-logo.png'); until then a plain shield placeholder is shown.
 */
export const UNIVERSITY_LOGO_SRC: string | null = null;
