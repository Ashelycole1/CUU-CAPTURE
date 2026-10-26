import 'server-only';
/**
 * Student-facing read helpers (added by the student UI agent; read-only, additive).
 * Follows the service rules: actor first, authorize before reading.
 */
import { assertCanReadApplication, type Actor } from '../authz';
import { getDb } from '../db/client';
import { loadApplication } from './internal';
import { loadReasonTemplatesCached } from './rules';

export interface ReasonLabel {
  code: string;
  label: string;
  body: string;
}

/**
 * Labels and plain-language bodies of the rejection reasons used on one
 * application, so the student sees the DOS reason text (design §6.2 Status).
 * `listReasonTemplates` is staff-only; this exposes only the codes in use on
 * an application the actor can read. Inactive templates are included because a
 * rejection may predate an admin retiring the template.
 */
export async function getReasonLabelsForApplication(actor: Actor, applicationId: string, codes: string[]): Promise<Record<string, ReasonLabel>> {
  const db = getDb();
  const app = await loadApplication(db, applicationId);
  assertCanReadApplication(actor, app);
  const wanted = [...new Set(codes.filter(Boolean))].slice(0, 50);
  if (!wanted.length) return {};
  // Templates are global (not personal) and cached per instance; filter after authz.
  const want = new Set(wanted);
  const rows = (await loadReasonTemplatesCached()).filter((r) => want.has(r.code));
  return Object.fromEntries(rows.map((r) => [r.code, { code: r.code, label: r.label, body: r.body }]));
}
