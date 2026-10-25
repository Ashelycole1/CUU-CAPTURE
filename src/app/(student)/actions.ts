'use server';
/**
 * Student server actions (FR-APP-3 autosave, FR-SUB, FR-NOT-2). Thin wrappers:
 * every rule lives in the services, which re-validate and authorize.
 */
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireActorOrThrow } from '@/server/auth/current';
import { toErrorBody } from '@/server/errors';
import { flushNotifications } from '@/server/notify';
import {
  postMessage,
  submitApplication,
  updateApplicationFields,
  updateStudentProfile,
} from '@/server/services';
import type { ApplicationFieldsPatch, ProfilePatch } from '@/domain/schemas';

export interface ActionError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
  details?: Record<string, unknown>;
}
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: ActionError };

function fail(e: unknown): { ok: false; error: ActionError } {
  const { status, body } = toErrorBody(e);
  if (status >= 500) console.error('[student action]', e);
  return { ok: false, error: body.error };
}

/** Autosave one or more profile fields (FR-APP-1/3). Recomputes the checklist. */
export async function saveProfileAction(patch: ProfilePatch): Promise<ActionResult> {
  try {
    const actor = await requireActorOrThrow(['student']);
    await updateStudentProfile(actor, patch);
    revalidatePath('/apply');
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

/** Autosave application fields (FR-APP-2): pass expiry / no pass / requested months / notes. */
export async function saveApplicationFieldsAction(applicationId: string, patch: ApplicationFieldsPatch): Promise<ActionResult> {
  try {
    const actor = await requireActorOrThrow(['student']);
    await updateApplicationFields(actor, applicationId, patch);
    revalidatePath('/apply');
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

/** Submit (FR-SUB-2/3). The service queues the receipt; we deliver it after the response. */
export async function submitApplicationAction(applicationId: string, confirmed: boolean): Promise<ActionResult<{ ref: string | null }>> {
  try {
    const actor = await requireActorOrThrow(['student']);
    if (!confirmed) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Tick the confirmation box first.', fieldErrors: { confirm: 'Required' } } };
    }
    const app = await submitApplication(actor, applicationId);
    after(() => flushNotifications());
    revalidatePath('/apply');
    revalidatePath('/status');
    return { ok: true, data: { ref: app.ref } };
  } catch (e) {
    return fail(e);
  }
}

/** Reply in the per-application thread (FR-NOT-2/3). Students can never post internal notes. */
export async function postMessageAction(applicationId: string, body: string): Promise<ActionResult> {
  try {
    const actor = await requireActorOrThrow(['student']);
    await postMessage(actor, applicationId, { body, internal: false });
    after(() => flushNotifications());
    revalidatePath('/messages');
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}
