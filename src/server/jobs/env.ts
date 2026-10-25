import 'server-only';
/**
 * Jobs/infra settings that are optional and not part of the foundation `config()`.
 * Read lazily so tests can change them.
 */
export interface JobsEnv {
  /** Resend webhook signing secret (`whsec_…`). Without it the webhook rejects every call. */
  resendWebhookSecret: string | undefined;
  /**
   * Max notification emails the daily cron sends per rolling 24 h. Resend's free tier
   * allows 100/day (OTP codes count too), so the default leaves headroom for sign-ins.
   */
  emailDailyCap: number;
  /** Cron time budget (ms) before a run stops and resumes later. Keep below maxDuration. */
  cronBudgetMs: number;
}

export function jobsEnv(): JobsEnv {
  const cap = Number(process.env.EMAIL_DAILY_CAP ?? '');
  const budget = Number(process.env.CRON_BUDGET_MS ?? '');
  return {
    resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET || undefined,
    emailDailyCap: Number.isFinite(cap) && cap > 0 ? cap : 80,
    cronBudgetMs: Number.isFinite(budget) && budget > 0 ? budget : 40_000,
  };
}
