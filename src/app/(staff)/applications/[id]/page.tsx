import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ClipboardCheck } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { isServiceError } from '@/server/errors';
import { getApplicationDetail, listReasonTemplates, type ApplicationDetail } from '@/server/services';
import { getPacketPlan } from '@/server/services/packet-builder';
import { Runway } from '@/components/runway';
import { Chip } from '@/components/ui/chip';
import { Timeline, type TimelineItem } from '@/components/staff/timeline';
import { DocumentGrid, type GridDocument } from '@/components/staff/document-grid';
import { FeePanel } from '@/components/staff/fee-panel';
import { MessageThread } from '@/components/staff/message-thread';
import { ApplicationActions, ClaimControl } from '@/components/staff/application-actions';
import { PacketPreview, type PreviewPacket } from '@/components/staff/packet-preview';
import { flagEmoji } from '@/components/staff/dashboard-params';
import {
  REVIEWABLE_STATUSES,
  applicationStatusTone,
  formatDate,
  formatDateTime,
  staffStatusLabel,
  todayInKampala,
  type ChipTone,
} from '@/domain';
import { fmt, staffText } from '@/i18n/staff';

export const metadata: Metadata = { title: 'Application' };

const D = staffText.detail;
const E = staffText.events;

type EventRow = ApplicationDetail['events'][number];

function eventItem(
  ev: EventRow,
  ctx: { docName: (code: string) => string; reason: (code: string | null | undefined) => string | null; who: (id: string | null) => string },
): TimelineItem {
  const data = ev.data as Record<string, unknown>;
  let title: string = ev.type;
  let tone: ChipTone = 'neutral';
  let description: string | undefined;
  switch (ev.type) {
    case 'status_changed': {
      const action = String(data.action ?? '');
      title = (E as Record<string, string>)[action] ?? staffStatusLabel(String(data.to) as never);
      tone = applicationStatusTone(String(data.to) as never);
      if (action === 'send_to_immigration' && data.method) title += ` (${D.actions.methods[data.method as 'email' | 'in_person'] ?? data.method})`;
      if (action === 'record_pass_issued' && data.newExpiry) description = `${D.actions.newExpiry}: ${formatDate(String(data.newExpiry))}`;
      if (action === 'request_corrections' && Array.isArray(data.rejected)) description = (data.rejected as string[]).map(ctx.docName).join(', ');
      break;
    }
    case 'document_reviewed': {
      const approve = data.decision === 'approve';
      title = `${approve ? E.document_reviewed_approve : E.document_reviewed_reject}: ${ctx.docName(String(data.docCode))}`;
      tone = approve ? 'ok' : 'warn';
      if (!approve) description = [ctx.reason(data.reasonCode as string | null), data.note ? String(data.note) : null].filter(Boolean).join(' · ');
      break;
    }
    case 'document_uploaded':
      title = `${E.document_uploaded}: ${ctx.docName(String(data.docCode))}${Number(data.page) > 1 ? ` (${fmt(D.pageN, { n: Number(data.page) })})` : ''}`;
      tone = 'teal';
      break;
    default:
      title = (E as Record<string, string>)[ev.type] ?? ev.type.replace(/_/g, ' ');
      if (ev.type === 'fee_paid') tone = 'ok';
  }
  return {
    id: ev.id,
    at: ev.at,
    title,
    description,
    tone,
    meta: ctx.who(ev.actorId),
    restricted: !ev.visibleToStudent,
    restrictedLabel: E.staffOnly,
  };
}

/** FR-DOS-4 / design §7.2: three columns — student + Runway + fee | documents | actions, timeline, messages. */
export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor(['dos_staff', 'dos_admin']);
  const { id } = await params;
  let detail: ApplicationDetail;
  try {
    detail = await getApplicationDetail(actor, id);
  } catch (e) {
    if (isServiceError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const [templates, plan] = await Promise.all([listReasonTemplates(actor, { includeInactive: true }), getPacketPlan(actor, id, detail)]);
  const { application: app, student, checklist } = detail;
  const today = todayInKampala();
  const now = new Date().toISOString();

  const docNames = new Map(checklist.items.map((i) => [i.item.code, i.item.name]));
  const docName = (code: string) => docNames.get(code) ?? code.replace(/_/g, ' ');
  const reason = (code: string | null | undefined) => (code ? (templates.find((t) => t.code === code)?.label ?? code) : null);
  const who = (actorId: string | null) =>
    actorId === null ? staffText.common.system : actorId === actor.id ? staffText.common.you : actorId === student.profileId ? (student.fullName ?? staffText.common.student) : staffText.common.staff;

  const docsByCode = new Map(detail.documents.map((d) => [d.docCode, d]));
  const toGrid = (code: string, name: string): GridDocument => {
    const d = docsByCode.get(code);
    const current = (d?.versions ?? []).filter((v) => !v.supersededAt).sort((a, b) => a.page - b.page);
    return {
      id: d?.id ?? null,
      code,
      name,
      required: d?.required ?? true,
      state: d?.state ?? 'missing',
      minFiles: d?.minFiles ?? 1,
      reasonLabel: reason(d?.reviewerReasonCode),
      note: d?.reviewerNote ?? null,
      versions: current.map((v) => ({ id: v.id, page: v.page, uploadedAt: v.uploadedAt })),
    };
  };
  const gridDocs: GridDocument[] = [
    ...checklist.items.map((i) => toGrid(i.item.code, i.item.name)),
    ...checklist.notRequired.map((d) => toGrid(d.docCode, docName(d.docCode))),
  ];
  const required = detail.documents.filter((d) => d.required);
  const allApproved = required.length > 0 && required.every((d) => d.state === 'approved');
  const pendingReview = required.filter((d) => d.state === 'uploaded').length;
  const reviewable = REVIEWABLE_STATUSES.includes(app.status);
  const claimActive = !!app.claimedBy && !!app.claimedUntil && app.claimedUntil > now;

  const timeline = detail.events.map((ev) => eventItem(ev, { docName, reason, who }));
  const messages = detail.messages.map((m) => ({
    id: m.id,
    body: m.body,
    internal: m.internal,
    at: m.at,
    sender: who(m.senderId),
    fromStudent: m.senderId === student.profileId,
  }));
  const packets: PreviewPacket[] = detail.packets.map((p) => ({
    id: p.id,
    status: p.status,
    createdAt: p.createdAt,
    readyAt: p.readyAt,
    sha256: p.sha256,
    bytes: p.bytes,
    error: p.error,
    sentAt: p.sentAt,
    sentMethod: p.sentMethod,
    files: (p.manifest?.files ?? []).map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes })),
  }));

  const info: [string, React.ReactNode][] = [
    [D.email, student.email],
    [D.studentNo, <span key="no" className="font-mono">{student.studentNo ?? '-'}</span>],
    [
      D.nationality,
      student.nationality ? (
        <span key="nat">
          <span aria-hidden>{flagEmoji(student.nationality)} </span>
          <span className="font-mono">{student.nationality}</span>
        </span>
      ) : (
        '-'
      ),
    ],
    [D.type, student.studentType ? staffText.dashboard.types[student.studentType] : '-'],
    [D.programme, student.programme ?? '-'],
    [D.phone, student.phone ?? '-'],
    [D.currentExpiry, app.noPass ? D.noPass : formatDate(app.currentExpiry)],
    [D.requestedMonths, app.requestedMonths ? fmt(D.months, { n: app.requestedMonths }) : '-'],
    [D.submitted, app.submittedAt ? formatDateTime(app.submittedAt) : '-'],
  ];

  return (
    <div className="space-y-4">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm font-semibold no-underline">
        <ArrowLeft aria-hidden className="size-4" />
        {D.back}
      </Link>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl">{student.fullName ?? student.email}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span className="font-mono tabular">{app.ref ?? '-'}</span>
            <span aria-hidden>·</span>
            <span>{fmt(D.ruleSet, { version: detail.ruleSetVersion })}</span>
            <Chip tone={applicationStatusTone(app.status)}>{staffStatusLabel(app.status)}</Chip>
          </p>
        </div>
        {reviewable && pendingReview > 0 && (
          <Link
            href={`/review-mode?app=${app.id}`}
            className="inline-flex min-h-12 items-center gap-2 rounded-sm bg-brand-500 px-4 font-semibold text-on-brand no-underline hover:bg-brand-700"
          >
            <ClipboardCheck aria-hidden className="size-5" />
            {D.reviewInMode} ({pendingReview})
          </Link>
        )}
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,24rem)]">
        {/* Left: student, Runway, fee */}
        <div className="space-y-4">
          <section aria-labelledby="student-title" className="rounded-md border border-line bg-surface p-4 shadow-1">
            <h2 id="student-title" className="font-sans text-base font-semibold">
              {D.studentInfo}
            </h2>
            <dl className="mt-2 space-y-1.5 text-sm">
              {info.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                  <dt className="text-ink-muted">{k}</dt>
                  <dd className="min-w-0 break-words">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <Runway summary={checklist.runway} />
          <FeePanel
            applicationId={app.id}
            feeStatus={app.feeStatus}
            feeRequired={checklist.feeRequired}
            feeUsd={checklist.feeUsd}
            payments={detail.payments.map((p) => ({ id: p.id, amountUgx: p.amountUgx, paidOn: p.paidOn, reference: p.reference, hasReceipt: !!p.receiptKey }))}
            canRecord={app.status !== 'draft' && app.status !== 'withdrawn'}
            today={today}
          />
        </div>

        {/* Centre: documents + packet */}
        <div className="space-y-4">
          <section aria-labelledby="docs-title" className="space-y-2">
            <h2 id="docs-title" className="font-sans text-base font-semibold">
              {D.documents}{' '}
              <span className="text-sm font-normal text-ink-muted tabular">
                {fmt(staffText.dashboard.docsApproved, { approved: required.filter((d) => d.state === 'approved').length, required: required.length })}
              </span>
            </h2>
            <DocumentGrid applicationId={app.id} documents={gridDocs} reviewable={reviewable} />
          </section>
          {(plan.files.length > 0 || packets.length > 0) && (
            <PacketPreview
              applicationId={app.id}
              status={app.status}
              canGenerate={plan.canGenerate}
              files={plan.files.map((f) => ({ name: f.name, docName: f.docName, page: f.page, pages: f.pages, bytes: f.bytes }))}
              packets={packets}
              today={today}
            />
          )}
        </div>

        {/* Right: actions, messages, timeline */}
        <div className="space-y-4">
          <section className="space-y-3 rounded-md border border-line bg-surface p-4 shadow-1">
            {reviewable && <ClaimControl applicationId={app.id} claim={{ mine: claimActive && app.claimedBy === actor.id, other: claimActive && app.claimedBy !== actor.id, until: app.claimedUntil }} />}
            <ApplicationActions applicationId={app.id} status={app.status} allApproved={allApproved} today={today} />
          </section>
          <section aria-labelledby="msg-title" className="rounded-md border border-line bg-surface p-4 shadow-1">
            <h2 id="msg-title" className="mb-2 font-sans text-base font-semibold">
              {D.messages}
            </h2>
            <MessageThread applicationId={app.id} messages={messages} />
          </section>
          <section aria-labelledby="tl-title" className="rounded-md border border-line bg-surface p-4 shadow-1">
            <h2 id="tl-title" className="mb-3 font-sans text-base font-semibold">
              {D.timeline}
            </h2>
            <Timeline items={timeline} label={D.timeline} newestFirst />
          </section>
        </div>
      </div>
    </div>
  );
}
