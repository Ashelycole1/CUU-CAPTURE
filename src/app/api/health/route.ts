import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';

/** GET /api/health — liveness + DB check (NFR-OBS). Public; reveals nothing sensitive. */
export async function GET() {
  const started = Date.now();
  try {
    await getDb().run(sql`select 1`);
    return NextResponse.json({ ok: true, db: 'ok', ms: Date.now() - started }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, db: 'error' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
