import 'server-only';
import { z } from 'zod';

/**
 * Server-only configuration, validated with Zod. Import `config()` (lazy, cached)
 * rather than reading process.env directly.
 */
const DEV_SESSION_SECRET = 'dev-only-session-secret-do-not-use-in-production!!';
// 32 zero-ish bytes, base64 — dev/test only.
const DEV_FILE_KEY = Buffer.from('visadesk-dev-file-key-32-bytes!!').toString('base64');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('VisaDesk'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default('file:./data/visadesk.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  DATA_DIR: z.string().min(1).default('./data'),
  SESSION_SECRET: z.string().min(32).optional(),
  FILE_ENCRYPTION_KEY: z.string().optional(),
  FILE_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default('k1'),
  CRON_SECRET: z.string().min(16).optional(),
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('VisaDesk <no-reply@visadesk.example>'),
  ALLOWED_EMAIL_DOMAINS: z.string().default('cavendish.ac.ug'),
  DEFAULT_TIMEZONE: z.string().default('Africa/Kampala'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProd: boolean;
  appName: string;
  appUrl: string;
  databaseUrl: string;
  databaseAuthToken: string | undefined;
  dataDir: string;
  sessionSecret: string;
  fileEncryptionKey: Buffer;
  fileEncryptionKeyId: string;
  cronSecret: string | undefined;
  blobToken: string | undefined;
  resendApiKey: string | undefined;
  emailFrom: string;
  allowedEmailDomains: string[];
  timezone: string;
}

let cached: AppConfig | null = null;

function emptyToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === '' ? undefined : v;
  return out;
}

export function config(): AppConfig {
  if (cached) return cached;
  const env = schema.parse(emptyToUndefined(process.env));
  const isProd = env.NODE_ENV === 'production';
  // `next build` runs with NODE_ENV=production but without runtime secrets.
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build';

  if (isProd && !isBuild) {
    const missing = (['SESSION_SECRET', 'FILE_ENCRYPTION_KEY', 'CRON_SECRET'] as const).filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing required production env: ${missing.join(', ')}`);
  }

  const fileKey = Buffer.from(env.FILE_ENCRYPTION_KEY ?? DEV_FILE_KEY, 'base64');
  if (fileKey.length !== 32) throw new Error('FILE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');

  cached = {
    nodeEnv: env.NODE_ENV,
    isProd,
    appName: env.APP_NAME,
    appUrl: env.APP_URL.replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL,
    databaseAuthToken: env.DATABASE_AUTH_TOKEN,
    dataDir: env.DATA_DIR,
    sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    fileEncryptionKey: fileKey,
    fileEncryptionKeyId: env.FILE_ENCRYPTION_KEY_ID,
    cronSecret: env.CRON_SECRET,
    blobToken: env.BLOB_READ_WRITE_TOKEN,
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS.split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    timezone: env.DEFAULT_TIMEZONE,
  };
  return cached;
}

/** Test hook: drop the cached config so changed env vars take effect. */
export function resetConfigCache(): void {
  cached = null;
}
