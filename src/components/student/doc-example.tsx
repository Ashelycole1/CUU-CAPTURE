'use client';
import { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { FRAME_ASPECT, type FrameShape } from '@/lib/scan/constants';

/**
 * Example thumbnail (FR-CHK-2), tap to enlarge. Uses the rule set's
 * `examplePath` (a fictional SPECIMEN image, design §11) when provided, otherwise
 * a drawn specimen in the document's shape.
 */
export function DocExample({ name, examplePath, frame }: { name: string; examplePath: string | null; frame: FrameShape }) {
  const c = studentText.capture;
  const [open, setOpen] = useState(false);
  const alt = interpolate(c.exampleAlt, { doc: name });
  const art = examplePath ? (
    // eslint-disable-next-line @next/next/no-img-element -- small static specimen from the rule set
    <img src={examplePath} alt={alt} className="h-full w-full object-contain" />
  ) : (
    <Specimen frame={frame} label={alt} />
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-12 w-full items-center gap-3 rounded-md border border-line bg-surface p-2 text-left hover:border-brand-500"
      >
        <span className="grid h-16 w-20 shrink-0 place-items-center overflow-hidden rounded-sm bg-paper">{art}</span>
        <span>
          <span className="block font-semibold">{c.example}</span>
          <span className="block text-sm text-ink-muted">{c.enlarge}</span>
        </span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={name}>
        <div className="mx-auto max-h-[70vh] w-full max-w-md">{art}</div>
      </Dialog>
    </>
  );
}

function Specimen({ frame, label }: { frame: FrameShape; label: string }) {
  const a = FRAME_ASPECT[frame];
  const landscape = frame === 'passport' || frame === 'id_card';
  const ratio = landscape ? Math.max(a, 1 / a) : Math.min(a, 1 / a);
  const w = ratio >= 1 ? 120 : 120 * ratio;
  const h = ratio >= 1 ? 120 / ratio : 120;
  const x = (120 - w) / 2;
  const y = (120 - h) / 2;
  return (
    <svg viewBox="0 0 120 120" role="img" aria-label={label} className="h-full w-full">
      <rect x={x} y={y} width={w} height={h} rx="4" fill="var(--surface)" stroke="var(--brand-700)" strokeWidth="1.5" />
      {frame !== 'photo' && landscape && <rect x={x + 6} y={y + 8} width={w * 0.28} height={h * 0.55} rx="2" fill="var(--brand-100)" stroke="var(--brand-700)" strokeWidth="1" />}
      {frame === 'photo' && <circle cx="60" cy={y + h * 0.42} r={w * 0.22} fill="var(--brand-100)" stroke="var(--brand-700)" strokeWidth="1" />}
      {Array.from({ length: frame === 'a4' ? 7 : 4 }, (_, i) => (
        <rect
          key={i}
          x={landscape ? x + w * 0.38 : x + 8}
          y={y + 10 + i * ((h - 20) / (frame === 'a4' ? 7 : 4))}
          width={landscape ? w * 0.52 : w - 16}
          height="2.5"
          rx="1"
          fill="var(--ink-muted)"
          opacity="0.5"
        />
      ))}
      <text x="60" y="64" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--accent-500)" transform="rotate(-20 60 60)" opacity="0.9">
        SPECIMEN
      </text>
    </svg>
  );
}
