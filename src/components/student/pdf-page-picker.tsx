'use client';
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import type { PdfHandle } from '@/lib/scan/convert';
import { cn } from '@/lib/cn';

const MAX_PAGES_SHOWN = 24;

/**
 * Multi-page PDF → pick the pages for this document (maps onto `min_files` slots).
 * Pages render lazily as small thumbnails.
 */
export function PdfPagePicker({ pdf, max, onPick, onCancel }: { pdf: PdfHandle; max: number; onPick: (pages: number[]) => void; onCancel: () => void }) {
  const c = studentText.capture;
  const count = Math.min(pdf.numPages, MAX_PAGES_SHOWN);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<number[]>(() => Array.from({ length: Math.min(max, pdf.numPages) }, (_, i) => i + 1));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let p = 1; p <= count; p++) {
        if (cancelled) return;
        try {
          const canvas = await pdf.render(p, 240);
          const url = canvas.toDataURL('image/jpeg', 0.7);
          if (!cancelled) setThumbs((t) => ({ ...t, [p]: url }));
        } catch {
          /* leave the placeholder */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, count]);

  function toggle(p: number) {
    setPicked((xs) => (xs.includes(p) ? xs.filter((x) => x !== p) : xs.length >= max ? [...xs.slice(1), p] : [...xs, p].sort((a, b) => a - b)));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg">{c.pdfPickTitle}</h2>
        <p className="text-sm text-ink-muted">{interpolate(c.pdfPickBody, { n: pdf.numPages })}</p>
      </div>
      <ul className="grid grid-cols-3 gap-3">
        {Array.from({ length: count }, (_, i) => i + 1).map((p) => {
          const on = picked.includes(p);
          return (
            <li key={p}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(p)}
                className={cn('relative block w-full overflow-hidden rounded-sm border-2 bg-surface', on ? 'border-brand-500' : 'border-line')}
              >
                {thumbs[p] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local data URL thumbnail
                  <img src={thumbs[p]} alt="" className="aspect-[3/4] w-full object-contain" />
                ) : (
                  <span className="block aspect-[3/4] w-full animate-pulse bg-line" />
                )}
                <span className="block p-1 text-center text-sm font-medium">{interpolate(c.pdfPage, { n: p })}</span>
                {on && (
                  <span className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-brand-500 text-on-brand">
                    <Check aria-hidden className="size-4" />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {studentText.common.cancel}
        </Button>
        <Button className="flex-1" disabled={picked.length === 0} onClick={() => onPick(picked)}>
          {c.pdfUseSelected}
        </Button>
      </div>
    </div>
  );
}
