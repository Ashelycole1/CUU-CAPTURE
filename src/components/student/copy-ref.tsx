'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';

/** Reference number with a copy button (design §6.2 Status). */
export function CopyRef({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const s = studentText.status;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard blocked: select the text so the student can copy it manually.
      const el = document.getElementById('app-ref');
      if (el) window.getSelection()?.selectAllChildren(el);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-line bg-surface p-3">
      <div>
        <p className="text-sm text-ink-muted">{s.reference}</p>
        <p id="app-ref" className="font-mono text-lg font-semibold tabular-nums">
          {value}
        </p>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={interpolate(s.copyLabel, { ref: value })}
        className="inline-flex min-h-12 items-center gap-2 rounded-sm border border-line px-4 font-semibold hover:bg-brand-100"
      >
        {copied ? <Check aria-hidden className="size-4 text-ok" /> : <Copy aria-hidden className="size-4" />}
        <span aria-live="polite">{copied ? s.copied : s.copy}</span>
      </button>
    </div>
  );
}
