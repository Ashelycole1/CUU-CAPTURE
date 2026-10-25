import 'server-only';
/** Per-application message thread (FR-NOT-2/3) and internal staff notes (FR-DOS-4). */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { messageSchema } from '@/domain/schemas';
import { assertCanReadApplication, canSeeInternalNotes, isStaff, isStudent, type Actor } from '../authz';
import { getDb } from '../db/client';
import { messages, profiles } from '../db/schema';
import { ForbiddenError } from '../errors';
import { queueNotification } from '../notify';
import { zodToValidation } from './applications';
import { audit, loadApplication, nowIso, touchApplication, withTx } from './internal';

export type Message = typeof messages.$inferSelect;

/**
 * Post a message. Students may only post non-internal messages on their own
 * application; staff may post either. Non-internal messages email the other party
 * (student → the claiming/last-replying staff member, if any; staff → student).
 */
export async function postMessage(actor: Actor, applicationId: string, input: { body: string; internal?: boolean }): Promise<Message> {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const { body, internal } = parsed.data;
  if (!isStudent(actor) && !isStaff(actor)) throw new ForbiddenError();
  if (isStudent(actor) && internal) throw new ForbiddenError('Students cannot post internal notes.');
  return withTx(async (tx) => {
    const app = await loadApplication(tx, applicationId);
    assertCanReadApplication(actor, app);
    const now = nowIso();
    const [msg] = await tx.insert(messages).values({ applicationId: app.id, senderId: actor.id, body, internal, at: now }).returning();
    await touchApplication(tx, app.id);
    await audit(tx, actor, 'message.posted', { type: 'message', id: msg!.id }, { applicationId: app.id, internal });
    if (!internal) {
      const preview = body.length > 280 ? `${body.slice(0, 277)}…` : body;
      if (isStaff(actor)) {
        await queueNotification(tx, { kind: 'message', recipientId: app.studentId, applicationId: app.id, dedupeKey: `message:${msg!.id}`, payload: { preview } });
      } else {
        let staffId = app.claimedBy;
        if (!staffId) {
          const lastStaff = (
            await tx
              .select({ senderId: messages.senderId })
              .from(messages)
              .innerJoin(profiles, eq(profiles.id, messages.senderId))
              .where(and(eq(messages.applicationId, app.id), inArray(profiles.role, ['dos_staff', 'dos_admin'])))
              .orderBy(desc(messages.at))
              .limit(1)
          )[0];
          staffId = lastStaff?.senderId ?? null;
        }
        if (staffId) {
          await queueNotification(tx, { kind: 'message', recipientId: staffId, applicationId: app.id, dedupeKey: `message:${msg!.id}`, payload: { preview } });
        }
      }
    }
    return msg!;
  });
}

/** Thread for an application; internal notes only for staff. */
export async function listMessages(actor: Actor, applicationId: string): Promise<Message[]> {
  const db = getDb();
  const app = await loadApplication(db, applicationId);
  assertCanReadApplication(actor, app);
  const where = canSeeInternalNotes(actor)
    ? eq(messages.applicationId, app.id)
    : and(eq(messages.applicationId, app.id), eq(messages.internal, false));
  return db.select().from(messages).where(where).orderBy(asc(messages.at));
}
