import Link from 'next/link';
import { ClipboardCheck, ExternalLink, ImageOff } from 'lucide-react';
import { Chip } from '@/components/ui/chip';
import { documentStateChip, formatDateTime, type DocumentState } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';

export interface GridDocument {
  id: string | null;
  code: string;
  name: string;
  required: boolean;
  state: DocumentState;
  minFiles: number;
  reasonLabel: string | null;
  note: string | null;
  versions: { id: string; page: number; uploadedAt: string }[];
}

const D = staffText.detail;

/**
 * Staff document grid (design §7.2 centre column). Thumbnails come from
 * `/api/files/{versionId}?variant=thumb` (session-authorized, decrypted, audited).
 */
export function DocumentGrid({ applicationId, documents, reviewable }: { applicationId: string; documents: GridDocument[]; reviewable: boolean }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {documents.map((d) => {
        const chip = documentStateChip(d.state, d.required);
        return (
          <li key={d.code} className={`rounded-md border bg-surface p-3 shadow-1 ${d.state === 'rejected' && d.required ? 'border-warn' : 'border-line'} ${d.required ? '' : 'opacity-70'}`}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-sans text-sm font-semibold">{d.name}</h3>
              <Chip tone={chip.tone} className="shrink-0 text-xs">
                {chip.label}
              </Chip>
            </div>
            {d.versions.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {d.versions.map((v) => (
                  <li key={v.id}>
                    <a
                      href={`/api/files/${v.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative block overflow-hidden rounded-sm border border-line bg-paper"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- private, session-authorized image; next/image cannot optimise it */}
                      <img
                        src={`/api/files/${v.id}?variant=thumb`}
                        alt={fmt(D.thumbAlt, { doc: d.name, page: v.page, date: formatDateTime(v.uploadedAt), state: chip.label })}
                        loading="lazy"
                        decoding="async"
                        className="h-28 w-36 object-cover transition-transform duration-150 group-hover:scale-105"
                      />
                      {d.minFiles > 1 && (
                        <span className="absolute bottom-1 left-1 rounded-sm bg-surface/90 px-1.5 text-xs font-semibold">{fmt(D.pageN, { n: v.page })}</span>
                      )}
                      <ExternalLink aria-hidden className="absolute top-1 right-1 size-3.5 text-ink-muted opacity-0 group-hover:opacity-100" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-muted">
                <ImageOff aria-hidden className="size-4" />
                {D.noUpload}
              </p>
            )}
            {d.state === 'rejected' && d.reasonLabel && (
              <p className="mt-2 rounded-sm bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-2 py-1.5 text-sm">
                <span className="font-semibold">{D.reason}:</span> {d.reasonLabel}
                {d.note ? ` (${d.note})` : ''}
              </p>
            )}
            {!d.required && <p className="mt-1 text-xs text-ink-muted">{D.notRequired}</p>}
            {reviewable && d.required && d.state === 'uploaded' && (
              <Link
                href={`/review-mode?app=${applicationId}&doc=${encodeURIComponent(d.code)}`}
                className="mt-2 inline-flex items-center gap-1 text-sm font-semibold"
              >
                <ClipboardCheck aria-hidden className="size-4" />
                {D.reviewInMode}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
