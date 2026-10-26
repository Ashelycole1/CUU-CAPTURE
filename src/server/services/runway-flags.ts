import 'server-only';
/**
 * Runway flags for the DOS dashboard (FR-RUN-3, PRD story 4): students without a
 * submitted application whose pass is close to (or past) expiry. Written by the daily
 * job; read here by staff. Most urgent first (expired, critical, urgent, …), then expiry.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { todayInKampala, diffDays } from '@/domain/dates';
import { riskBand, RISK_RANK } from '@/domain/rules';
import type { RiskBand } from '@/domain/types';
import { assertStaff, type Actor } from '../authz';
import { getDb } from '../db/client';
import { applications, profiles, runwayFlags, students } from '../db/schema';

export interface RunwayFlagView {
  flagId: string;
  studentId: string;
  fullName: string | null;
  email: string;
  studentNo: string | null;
  nationality: string | null;
  expiry: string;
  /** Reminder stage (60/30/14/7/0, or -1 = expired). */
  day: number;
  /** Band today (recomputed, not the band at flag time). */
  band: RiskBand;
  daysToExpiry: number;
  flaggedAt: string;
  emailBounced: boolean;
  /** The student's draft application, if they started one (null = no application at all). */
  draftApplicationId: string | null;
}

/** Open flags, most urgent first. `studentId` narrows to one student (staff detail page). */
export async function listOpenRunwayFlags(actor: Actor, opts: { limit?: number; today?: string; studentId?: string } = {}): Promise<RunwayFlagView[]> {
  assertStaff(actor);
  const today = opts.today ?? todayInKampala();
  const rows = await getDb()
    .select({
      flagId: runwayFlags.id,
      studentId: runwayFlags.studentId,
      expiry: runwayFlags.expiry,
      day: runwayFlags.day,
      flaggedAt: runwayFlags.flaggedAt,
      fullName: profiles.fullName,
      email: profiles.email,
      emailStatus: profiles.emailStatus,
      studentNo: students.studentNo,
      nationality: students.nationality,
      draftApplicationId: sql<string | null>`(select ${applications.id} from ${applications} where ${applications.studentId} = ${runwayFlags.studentId} and ${applications.status} = 'draft' limit 1)`,
    })
    .from(runwayFlags)
    .innerJoin(profiles, eq(profiles.id, runwayFlags.studentId))
    .leftJoin(students, eq(students.profileId, runwayFlags.studentId))
    .where(and(isNull(runwayFlags.resolvedAt), isNull(profiles.deletedAt), opts.studentId ? eq(runwayFlags.studentId, opts.studentId) : undefined))
    .orderBy(asc(runwayFlags.expiry), sql`${runwayFlags.flaggedAt} desc`)
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows
    .map((r) => ({
      flagId: r.flagId,
      studentId: r.studentId,
      fullName: r.fullName,
      email: r.email,
      studentNo: r.studentNo,
      nationality: r.nationality,
      expiry: r.expiry,
      day: r.day,
      band: riskBand(r.expiry, today),
      daysToExpiry: diffDays(r.expiry, today),
      flaggedAt: r.flaggedAt,
      emailBounced: r.emailStatus === 'bounced',
      draftApplicationId: r.draftApplicationId ?? null,
    }))
    .sort((a, b) => RISK_RANK[a.band] - RISK_RANK[b.band] || a.expiry.localeCompare(b.expiry));
}
