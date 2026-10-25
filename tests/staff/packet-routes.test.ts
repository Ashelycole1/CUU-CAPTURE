/** POST /api/packets/[applicationId] and GET /api/packets/[applicationId]/[packetId]: staff-only, audited, streamed. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { createStaff, createTestDb, type TestDb } from '../helpers/db';
import { auditLog } from '@/server/db/schema';
import type { Actor } from '@/server/authz';
import { createApprovedWithFiles, req, setActor, sha } from './helpers';

vi.mock('@/server/auth/current', async () => (await import('./helpers')).authMock());

let t: TestDb;
let staff: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
});
afterAll(() => t.cleanup());

const load = async () => ({
  gen: (await import('@/app/api/packets/[applicationId]/route')).POST,
  dl: (await import('@/app/api/packets/[applicationId]/[packetId]/route')).GET,
});

describe('packet routes', () => {
  it('staff generate (201) and download a streamed ZIP with a packet.downloaded audit row', async () => {
    const { gen, dl } = await load();
    const { app } = await createApprovedWithFiles(t.db, staff, {});
    setActor(staff);
    const res = await gen(req(`/api/packets/${app.id}`, { method: 'POST' }), { params: Promise.resolve({ applicationId: app.id }) });
    expect(res.status).toBe(201);
    const { packet } = (await res.json()) as { packet: { id: string; sha256: string; storageKey?: string } };
    expect(packet.storageKey).toBeUndefined();

    const down = await dl(req(`/api/packets/${app.id}/${packet.id}`), { params: Promise.resolve({ applicationId: app.id, packetId: packet.id }) });
    expect(down.status).toBe(200);
    expect(down.headers.get('content-type')).toBe('application/zip');
    expect(down.headers.get('cache-control')).toContain('no-store');
    expect(down.headers.get('content-disposition')).toContain('attachment');
    expect(down.body).toBeInstanceOf(ReadableStream);
    const bytes = new Uint8Array(await down.arrayBuffer());
    expect(sha(bytes)).toBe(packet.sha256);
    expect(Object.keys(unzipSync(bytes))).toContain('manifest.json');

    const rows = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'packet.downloaded'), eq(auditLog.targetId, packet.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(staff.id);
  });

  it('students get 403 on generate and download; anonymous gets 401', async () => {
    const { gen, dl } = await load();
    const { app, student } = await createApprovedWithFiles(t.db, staff, {});
    setActor(staff);
    const ok = await gen(req(`/api/packets/${app.id}`, { method: 'POST' }), { params: Promise.resolve({ applicationId: app.id }) });
    const { packet } = (await ok.json()) as { packet: { id: string } };

    setActor(student);
    const r1 = await gen(req(`/api/packets/${app.id}`, { method: 'POST' }), { params: Promise.resolve({ applicationId: app.id }) });
    expect(r1.status).toBe(403);
    const r2 = await dl(req(`/api/packets/${app.id}/${packet.id}`), { params: Promise.resolve({ applicationId: app.id, packetId: packet.id }) });
    expect(r2.status).toBe(403);

    setActor(null);
    const r3 = await dl(req(`/api/packets/${app.id}/${packet.id}`), { params: Promise.resolve({ applicationId: app.id, packetId: packet.id }) });
    expect(r3.status).toBe(401);

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'packet.downloaded'), eq(auditLog.targetId, packet.id)));
    expect(audits).toHaveLength(0);
  });

  it('404 when the packet belongs to another application; 409 when not approved; 403 cross-origin', async () => {
    const { gen, dl } = await load();
    const a = await createApprovedWithFiles(t.db, staff, {});
    const b = await createApprovedWithFiles(t.db, staff, { skipApprove: true });
    setActor(staff);
    const ok = await gen(req(`/api/packets/${a.app.id}`, { method: 'POST' }), { params: Promise.resolve({ applicationId: a.app.id }) });
    const { packet } = (await ok.json()) as { packet: { id: string } };
    const wrong = await dl(req(`/api/packets/${b.app.id}/${packet.id}`), { params: Promise.resolve({ applicationId: b.app.id, packetId: packet.id }) });
    expect(wrong.status).toBe(404);

    const notApproved = await gen(req(`/api/packets/${b.app.id}`, { method: 'POST' }), { params: Promise.resolve({ applicationId: b.app.id }) });
    expect(notApproved.status).toBe(409);

    const xorigin = await gen(req(`/api/packets/${a.app.id}`, { method: 'POST', headers: { origin: 'https://evil.example' } }), {
      params: Promise.resolve({ applicationId: a.app.id }),
    });
    expect(xorigin.status).toBe(403);
  });
});
