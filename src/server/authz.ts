import 'server-only';
/**
 * Authorization policy (replaces Postgres RLS). EVERY service function takes an
 * `Actor` and calls one of these checks before reading or mutating data.
 *
 * - Actors are constructed server-side only (`getActor()` reads the session and the
 *   role from the DB). Never build an Actor from client input.
 * - Students are always scoped to rows they own (applications.student_id = actor.id).
 * - Unauthorized reads of another student's rows raise NotFound (not Forbidden) so
 *   existence is not leaked.
 */
import type { ApplicationStatus, Role } from '@/domain/types';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from './errors';

export interface Actor {
  /** profiles.id, or 'system' for jobs. */
  id: string;
  role: Role | 'system';
  email: string;
  fullName: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: 'system', role: 'system', email: 'system', fullName: 'System' };

export const STAFF_ROLES: readonly Role[] = ['dos_staff', 'dos_admin'];

export function isStudent(actor: Actor): boolean {
  return actor.role === 'student';
}
export function isStaff(actor: Actor): boolean {
  return actor.role === 'dos_staff' || actor.role === 'dos_admin';
}
export function isAdmin(actor: Actor): boolean {
  return actor.role === 'dos_admin';
}
export function isSystem(actor: Actor): boolean {
  return actor.role === 'system';
}
/** The audit/event actor id (null for system jobs). */
export function actorIdOf(actor: Actor): string | null {
  return isSystem(actor) ? null : actor.id;
}

export function requireAuthenticated(actor: Actor | null | undefined): asserts actor is Actor {
  if (!actor) throw new UnauthenticatedError();
}

export function assertRole(actor: Actor, roles: readonly (Role | 'system')[]): void {
  if (!roles.includes(actor.role)) throw new ForbiddenError();
}

export function assertStaff(actor: Actor): void {
  if (!isStaff(actor)) throw new ForbiddenError('Staff only');
}

export function assertAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ForbiddenError('Admins only');
}

export function assertStaffOrSystem(actor: Actor): void {
  if (!isStaff(actor) && !isSystem(actor)) throw new ForbiddenError('Staff only');
}

/** Liaison (phase 4) may read applications from `approved` onward. */
const LIAISON_VISIBLE: readonly ApplicationStatus[] = ['approved', 'sent_to_immigration', 'pass_issued', 'closed'];

interface OwnedApplication {
  id: string;
  studentId: string;
  status: ApplicationStatus;
}

export function canReadApplication(actor: Actor, app: OwnedApplication): boolean {
  if (isStaff(actor) || isSystem(actor)) return true;
  if (actor.role === 'liaison') return LIAISON_VISIBLE.includes(app.status);
  return actor.role === 'student' && app.studentId === actor.id;
}

export function assertCanReadApplication(actor: Actor, app: OwnedApplication | null | undefined): asserts app is OwnedApplication {
  if (!app || !canReadApplication(actor, app)) throw new NotFoundError('Application');
}

/** Student acting on their own application (draft edits, uploads, submit, withdraw). */
export function assertStudentOwns(actor: Actor, app: OwnedApplication | null | undefined): asserts app is OwnedApplication {
  if (!app) throw new NotFoundError('Application');
  if (actor.role !== 'student') throw new ForbiddenError('Only the student can do this');
  if (app.studentId !== actor.id) throw new NotFoundError('Application');
}

/** Internal staff notes (messages.internal) are never visible to students or liaison. */
export function canSeeInternalNotes(actor: Actor): boolean {
  return isStaff(actor);
}

/** Reading a stored file (document version / thumbnail / packet). */
export function canReadFile(actor: Actor, app: OwnedApplication, kind: 'document' | 'packet' | 'receipt'): boolean {
  if (kind === 'packet') return isStaff(actor) || (actor.role === 'liaison' && LIAISON_VISIBLE.includes(app.status));
  if (kind === 'receipt') return isStaff(actor);
  return canReadApplication(actor, app);
}

/** Does reading this file need an audit row? (staff/liaison viewing student files: FR-AUD-1) */
export function fileViewIsAudited(actor: Actor): boolean {
  return !isStudent(actor);
}
