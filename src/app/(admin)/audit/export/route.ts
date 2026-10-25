import { requireActorOrThrow } from '@/server/auth/current';
import { route } from '@/server/http';
import { exportAuditCsv } from '@/server/services/admin';
import { auditFiltersFrom } from '@/components/admin/audit-filters';
import { todayInKampala } from '@/domain/dates';

/** GET /audit/export?… — CSV of the filtered audit log (FR-ADM-4). Admin only; the export is itself audited. */
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const actor = await requireActorOrThrow(['dos_admin']);
  const { csv } = await exportAuditCsv(actor, auditFiltersFrom(new URL(req.url).searchParams));
  return new Response(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="visadesk-audit-${todayInKampala()}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
