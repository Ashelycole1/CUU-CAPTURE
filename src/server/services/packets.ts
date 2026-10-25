import 'server-only';
/**
 * Packet RECORDS and status (FR-PKT-1/3). Building the ZIP / cover sheet is done
 * by the packet builder (another module) which calls these functions:
 *   1. const p = await startPacket(actor, appId)            // status 'generating'
 *   2. build zip, `const { key } = await getBlobStore().put(blobKeys.packet(appId, p.id), zip, 'application/zip')`
 *   3. await completePacket(actor, p.id, { storageKey: key, sha256, bytes, manifest })
 *      or await failPacket(actor, p.id, message)
 */
import { desc, eq } from 'drizzle-orm';
import { assertStaff, type Actor } from '../authz';
import { getDb } from '../db/client';
import { packets, type PacketManifest } from '../db/schema';
import { InvalidStateError, NotFoundError, ValidationError } from '../errors';
import { audit, loadApplicationOrThrow, nowIso, recordEvent, withTx } from './internal';

export type Packet = typeof packets.$inferSelect;
export type PacketView = Omit<Packet, 'storageKey'>;

const strip = ({ storageKey: _k, ...rest }: Packet): PacketView => rest;

/** Staff: begin a packet for an approved (or already sent) application. */
export async function startPacket(actor: Actor, applicationId: string): Promise<PacketView> {
  assertStaff(actor);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    if (app.status !== 'approved' && app.status !== 'sent_to_immigration') {
      throw new InvalidStateError('Packets can only be generated for approved applications.');
    }
    const [p] = await tx.insert(packets).values({ applicationId: app.id, generatedBy: actor.id, status: 'generating' }).returning();
    await audit(tx, actor, 'packet.started', { type: 'packet', id: p!.id }, { applicationId: app.id });
    return strip(p!);
  });
}

export async function completePacket(
  actor: Actor,
  packetId: string,
  input: { storageKey: string; sha256: string; bytes: number; manifest: PacketManifest },
): Promise<PacketView> {
  assertStaff(actor);
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new ValidationError('Invalid packet hash');
  return withTx(async (tx) => {
    const p = (await tx.select().from(packets).where(eq(packets.id, packetId)))[0];
    if (!p) throw new NotFoundError('Packet');
    if (p.status !== 'generating') throw new InvalidStateError('Packet is not being generated.');
    const now = nowIso();
    const [updated] = await tx
      .update(packets)
      .set({ status: 'ready', storageKey: input.storageKey, sha256: input.sha256, bytes: input.bytes, manifest: input.manifest, readyAt: now })
      .where(eq(packets.id, p.id))
      .returning();
    await recordEvent(tx, actor, p.applicationId, 'packet_generated', { packetId: p.id }, { visibleToStudent: false });
    await audit(tx, actor, 'packet.generated', { type: 'packet', id: p.id }, { applicationId: p.applicationId, sha256: input.sha256, files: input.manifest.files.length });
    return strip(updated!);
  });
}

export async function failPacket(actor: Actor, packetId: string, error: string): Promise<void> {
  assertStaff(actor);
  await withTx(async (tx) => {
    const p = (await tx.select().from(packets).where(eq(packets.id, packetId)))[0];
    if (!p) throw new NotFoundError('Packet');
    await tx.update(packets).set({ status: 'failed', error: error.slice(0, 500) }).where(eq(packets.id, p.id));
    await audit(tx, actor, 'packet.failed', { type: 'packet', id: p.id }, { applicationId: p.applicationId });
  });
}

export async function listPackets(actor: Actor, applicationId: string): Promise<PacketView[]> {
  assertStaff(actor);
  const rows = await getDb().select().from(packets).where(eq(packets.applicationId, applicationId)).orderBy(desc(packets.createdAt));
  return rows.map(strip);
}

export async function getPacket(actor: Actor, packetId: string): Promise<PacketView> {
  assertStaff(actor);
  const p = (await getDb().select().from(packets).where(eq(packets.id, packetId)))[0];
  if (!p) throw new NotFoundError('Packet');
  return strip(p);
}
