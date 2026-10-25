'use server';
/**
 * Admin server actions. Each re-checks the role (layouts are UX, not security) and
 * calls a service, which authorizes again and audits the change.
 */
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireActorOrThrow } from '@/server/auth/current';
import { toErrorBody } from '@/server/errors';
import { flushNotifications } from '@/server/notify';
import { inviteStaff, publishRuleSet, setProfileStatus } from '@/server/services';
import {
  deleteRuleSetDraft,
  migrateDraftApplications,
  saveReasonTemplate,
  saveRuleSetDraft,
  setRetentionDays,
  type ReasonTemplateInput,
} from '@/server/services/admin';
import type { RuleSetInput } from '@/server/services/rules';
import { decideDeletionRequest } from '@/server/services/privacy';
import type { Role } from '@/domain/types';

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string> } };

async function run<T>(fn: () => Promise<T>, paths: string[]): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string> } }> {
  try {
    const data = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (e) {
    const { body } = toErrorBody(e);
    return { ok: false, error: body.error };
  }
}

const admin = () => requireActorOrThrow(['dos_admin']);

export async function saveRuleSetDraftAction(id: string | null, input: RuleSetInput) {
  return run(async () => (await saveRuleSetDraft(await admin(), id, input)).id, ['/rules']);
}

export async function deleteRuleSetDraftAction(id: string) {
  return run(async () => deleteRuleSetDraft(await admin(), id), ['/rules']);
}

export async function publishRuleSetAction(id: string) {
  return run(async () => (await publishRuleSet(await admin(), id)).version, ['/rules']);
}

export async function migrateDraftsAction() {
  return run(async () => migrateDraftApplications(await admin()), ['/rules']);
}

export async function inviteStaffAction(input: { email: string; fullName?: string; role: Exclude<Role, 'student'> }) {
  return run(async () => {
    const p = await inviteStaff(await admin(), { ...input, fullName: input.fullName?.trim() || undefined });
    return { email: p.email };
  }, ['/staff']);
}

export async function setStaffStatusAction(profileId: string, status: 'active' | 'disabled') {
  return run(async () => setProfileStatus(await admin(), profileId, status), ['/staff']);
}

export async function saveReasonTemplateAction(input: ReasonTemplateInput) {
  return run(async () => (await saveReasonTemplate(await admin(), input)).code, ['/templates']);
}

export async function setRetentionDaysAction(days: number) {
  return run(async () => setRetentionDays(await admin(), days), ['/retention']);
}

export async function decideDeletionAction(requestId: string, decision: 'approve' | 'reject') {
  return run(async () => {
    const r = await decideDeletionRequest(await admin(), requestId, decision);
    after(() => flushNotifications());
    return r.status;
  }, ['/retention']);
}
