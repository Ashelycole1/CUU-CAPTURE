'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileJson, FileText, FolderArchive, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useToast } from '@/components/ui/toast';
import { formatDate, formatDateTime, type ApplicationStatus } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import { MarkSentButton } from './application-actions';

const P = staffText.packets;

export interface PreviewFile {
  name: string;
  docName: string;
  page: number;
  pages: number;
  bytes: number;
}

export interface PreviewPacket {
  id: string;
  status: 'generating' | 'ready' | 'failed';
  createdAt: string;
  readyAt: string | null;
  sha256: string | null;
  bytes: number | null;
  error: string | null;
  sentAt: string | null;
  sentMethod: 'email' | 'in_person' | null;
  files: { name: string; sha256: string; bytes: number }[];
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(n < 1024 * 1024 ? 2 : 1);
const STATUS_TONE = { generating: 'info', ready: 'ok', failed: 'bad' } as const;

/**
 * Design §7.4: export order + names, Generate / download / Mark sent, and the
 * stored manifest hashes of generated packets (FR-PKT-1/3).
 */
export function PacketPreview({
  applicationId,
  status,
  canGenerate,
  files,
  packets,
  today,
}: {
  applicationId: string;
  status: ApplicationStatus;
  canGenerate: boolean;
  files: PreviewFile[];
  packets: PreviewPacket[];
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [showAll, setShowAll] = useState(false);
  const latest = packets.find((p) => p.status === 'ready');
  const eligible = status === 'approved' || status === 'sent_to_immigration';

  const generate = () =>
    start(async () => {
      try {
        const res = await fetch(`/api/packets/${applicationId}`, { method: 'POST', headers: { accept: 'application/json' } });
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (!res.ok) {
          toast({ title: body?.error?.message ?? staffText.common.error, tone: 'error' });
        } else {
          toast({ title: P.generated, tone: 'success' });
        }
      } catch {
        toast({ title: staffText.common.error, tone: 'error' });
      }
      router.refresh();
    });

  return (
    <section aria-labelledby="packet-title" id="packet" className="space-y-4 rounded-md border border-line bg-surface p-4 shadow-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="packet-title" className="flex items-center gap-2 font-sans text-base font-semibold">
          <FolderArchive aria-hidden className="size-4" />
          {P.previewTitle}
        </h2>
        <div className="flex flex-wrap gap-2">
          {eligible && (
            <Button size="sm" onClick={generate} loading={pending} disabled={!canGenerate}>
              {pending ? P.generating : latest ? P.regenerate : P.generate}
            </Button>
          )}
          {latest && (
            <a
              href={`/api/packets/${applicationId}/${latest.id}`}
              download
              className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line bg-surface px-3 text-sm font-semibold text-ink no-underline hover:bg-brand-100"
            >
              <Download aria-hidden className="size-4" />
              {P.download}
            </a>
          )}
          {status === 'approved' && latest && <MarkSentButton applicationId={applicationId} today={today} size="sm" />}
        </div>
      </div>

      {!eligible && <p className="text-sm text-ink-muted">{P.notApproved}</p>}

      <div>
        <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{P.exportOrder}</h3>
        <ol className="mt-1 divide-y divide-line rounded-sm border border-line font-mono text-xs">
          {files.map((f) => (
            <li key={f.name} className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <ImageIcon aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
                <span className="truncate" title={f.name}>
                  {f.name}
                </span>
              </span>
              <span className="shrink-0 font-sans text-ink-muted">
                {f.docName}
                {f.pages > 1 ? ` (${fmt(staffText.detail.pageN, { n: f.page })})` : ''}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-1.5 px-2 py-1.5">
            <FileText aria-hidden className="size-3.5 text-ink-muted" />
            {P.coverSheet}
          </li>
          <li className="flex items-center gap-1.5 px-2 py-1.5">
            <FileJson aria-hidden className="size-3.5 text-ink-muted" />
            {P.manifestFile}
          </li>
        </ol>
      </div>

      <div>
        <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{P.history}</h3>
        {packets.length === 0 ? (
          <p className="text-sm text-ink-muted">{P.noPackets}</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {(showAll ? packets : packets.slice(0, 3)).map((p) => (
              <li key={p.id} className="rounded-sm border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Chip tone={STATUS_TONE[p.status]} spinning={p.status === 'generating'} className="text-xs">
                      {P.status[p.status]}
                    </Chip>
                    <span className="text-xs text-ink-muted tabular">{formatDateTime(p.readyAt ?? p.createdAt)}</span>
                    {p.bytes ? <span className="text-xs text-ink-muted">{fmt(P.size, { mb: mb(p.bytes) })}</span> : null}
                  </span>
                  {p.status === 'ready' && (
                    <a href={`/api/packets/${applicationId}/${p.id}`} download className="inline-flex items-center gap-1 text-xs font-semibold">
                      <Download aria-hidden className="size-3.5" />
                      {P.download}
                    </a>
                  )}
                </div>
                {p.sentAt && (
                  <p className="mt-1 text-xs text-ok">
                    {fmt(P.sentOn, { date: formatDate(p.sentAt.slice(0, 10)), method: p.sentMethod ? staffText.detail.actions.methods[p.sentMethod] : '' })}
                  </p>
                )}
                {p.error && <p className="mt-1 text-xs text-bad">{p.error}</p>}
                {p.status === 'ready' && p === latest && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold">{P.manifestHashes}</summary>
                    <dl className="mt-1 space-y-1 font-mono text-[11px] break-all">
                      {p.sha256 && (
                        <div>
                          <dt className="font-sans font-semibold">{P.zipHash}</dt>
                          <dd>{p.sha256}</dd>
                        </div>
                      )}
                      {p.files.map((f) => (
                        <div key={f.name}>
                          <dt className="font-sans text-ink-muted">{f.name}</dt>
                          <dd>{f.sha256}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {packets.length > 3 && !showAll && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            +{packets.length - 3}
          </Button>
        )}
      </div>
    </section>
  );
}
