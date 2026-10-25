import 'server-only';
import { config } from '../config';

export const MAX_HOPS = 8;

/**
 * Self-continuation for a cron run that hit its time budget: call the same cron route
 * again (a new function invocation with a fresh `maxDuration`). Runs are resumable via
 * `job_runs.cursor`, so a lost continuation only delays work until the next schedule.
 */
export async function continueCron(path: string, hop: number): Promise<void> {
  const c = config();
  if (!c.cronSecret || hop > MAX_HOPS) return;
  try {
    await fetch(`${c.appUrl}${path}?hop=${hop}`, {
      headers: { authorization: `Bearer ${c.cronSecret}` },
      cache: 'no-store',
    });
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'cron continuation failed', path, hop, error: String(e) }));
  }
}

export function hopOf(req: Request): number {
  const n = Number(new URL(req.url).searchParams.get('hop') ?? '0');
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** One structured JSON log line per job run (NFR-OBS; visible in Vercel logs). */
export function logJob(job: string, data: Record<string, unknown>): void {
  console.info(JSON.stringify({ level: 'info', job, at: new Date().toISOString(), ...data }));
}
