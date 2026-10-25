'use client';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Camera, Check, FolderOpen, ImagePlus, Plus, RotateCw, ScanLine, Video, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { cn } from '@/lib/cn';
import { analyzePixels } from '@/lib/scan/analyze';
import { ACCEPT_INPUT, docProfile } from '@/lib/scan/constants';
import {
  analysisPixels,
  canvasToJpeg,
  decodeImage,
  detectKind,
  drawToCanvas,
  heicToBlob,
  openPdf,
  PDF_RENDER_LONG_EDGE,
  type PdfHandle,
  type Source,
} from '@/lib/scan/convert';
import { qualityAnnouncement } from '@/lib/scan/messages';
import { evaluateQuality, hasHardFail, type QualityIssue, type QualityMetrics } from '@/lib/scan/quality';
import { enqueue, listQueued, onUploadSettled, uploadWithRetry, type QueuedUpload } from '@/lib/scan/upload-queue';
import { CameraView } from './camera-view';
import { firstOpenSlot, type Slot } from './logic';
import { PdfPagePicker } from './pdf-page-picker';
import { QualityReport } from './quality-report';

type Origin = 'camera' | 'file' | 'pdf' | 'live';
type Rotation = 0 | 90 | 180 | 270;

interface Scan {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  jpegQuality: number;
  metrics: QualityMetrics;
  issues: QualityIssue[];
  origin: Origin;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'pdf'; pdf: PdfHandle }
  | { kind: 'review'; scan: Scan }
  | { kind: 'uploading'; scan: Scan; pct: number; waiting: number | null }
  | { kind: 'done' };

export interface ScanCoachProps {
  applicationId: string;
  docCode: string;
  docName: string;
  minFiles: number;
  initialSlots: Slot[];
  initialSlot: number;
  canUpload: boolean;
  nextHref: string | null;
}

/**
 * Scan Coach (FR-UP-1/2/4, design §6.2 screen 4). Camera / gallery / drag-and-drop
 * → convert to JPEG → quality checks in a worker → upload with progress and retry.
 * One document per screen; multi-page items show page slots (FR-CHK-5).
 */
export function ScanCoach(p: ScanCoachProps) {
  const c = studentText.capture;
  const router = useRouter();
  const toast = useToast();
  const profile = docProfile(p.docCode);
  const [slots, setSlots] = useState(p.initialSlots);
  const [slot, setSlot] = useState(p.initialSlot);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [camera, setCamera] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const source = useRef<{ src: Source; rotation: Rotation; origin: Origin } | null>(null);
  const pdfQueue = useRef<{ pdf: PdfHandle; pages: number[] } | null>(null);
  const multi = p.minFiles > 1;

  const say = useCallback((msg: string) => {
    // Re-announce identical messages by clearing first.
    setAnnounce('');
    requestAnimationFrame(() => setAnnounce(msg));
  }, []);

  // Revoke preview URLs when replaced.
  const previewUrl = phase.kind === 'review' || phase.kind === 'uploading' ? phase.scan.url : null;
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  // Resume uploads for this document left in the queue (reload / offline).
  // <PendingUploads/> in the layout performs the actual resume; here we only reflect it.
  useEffect(() => {
    let cancelled = false;
    void listQueued({ applicationId: p.applicationId, docCode: p.docCode }).then((items) => {
      if (!cancelled && items.length) setNotice(c.queued);
    });
    const off = onUploadSettled((_id, outcome) => {
      if (!outcome.ok || outcome.response.document?.docCode !== p.docCode) return;
      const v = outcome.response.version;
      setSlots((xs) => xs.map((x) => (x.page === v.page ? { ...x, versionId: v.id } : x)));
      setNotice(null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [p.applicationId, p.docCode, c.queued]);

  function reset(focus = true) {
    if (source.current?.src instanceof ImageBitmap) source.current.src.close();
    source.current = null;
    setPhase({ kind: 'idle' });
    if (focus) setTimeout(() => firstAction.current?.focus(), 0);
  }

  async function process(src: Source, rotation: Rotation, origin: Origin) {
    source.current = { src, rotation, origin };
    setPhase({ kind: 'busy', label: c.checking });
    const canvas = drawToCanvas(src, rotation);
    const [encoded, m] = await Promise.all([canvasToJpeg(canvas), analyzePixels(analysisPixels(canvas))]);
    const metrics: QualityMetrics = { ...m, width: encoded.width, height: encoded.height, bytes: encoded.blob.size };
    const issues = evaluateQuality(metrics, profile);
    if (encoded.overLimit && !issues.some((i) => i.code === 'too_big')) issues.push({ code: 'too_big', severity: 'hard' });
    const scan: Scan = { blob: encoded.blob, url: URL.createObjectURL(encoded.blob), width: encoded.width, height: encoded.height, jpegQuality: encoded.quality, metrics, issues, origin };
    setPhase({ kind: 'review', scan });
    say(qualityAnnouncement(issues));
  }

  async function handleFile(file: Blob & { name?: string }, origin: Origin) {
    setError(null);
    setNotice(null);
    try {
      const kind = await detectKind(file);
      if (kind === 'unsupported') {
        setError(c.unsupported);
        say(c.unsupported);
        return;
      }
      if (kind === 'pdf') {
        setPhase({ kind: 'busy', label: c.convertingPdf });
        const pdf = await openPdf(file);
        if (pdf.numPages === 1) {
          await process(await pdf.render(1, PDF_RENDER_LONG_EDGE), 0, 'pdf');
          pdf.destroy();
        } else {
          setPhase({ kind: 'pdf', pdf });
          say(interpolate(c.pdfPickBody, { n: pdf.numPages }));
        }
        return;
      }
      setPhase({ kind: 'busy', label: kind === 'heic' ? c.convertingHeic : c.converting });
      const blob = kind === 'heic' ? await heicToBlob(file) : file;
      await process(await decodeImage(blob), 0, origin);
    } catch (e) {
      console.error('[scan]', e);
      setError(c.readFailed);
      say(c.readFailed);
      reset(false);
    }
  }

  async function pickPdfPages(pdf: PdfHandle, pages: number[]) {
    pdfQueue.current = { pdf, pages: pages.slice(1) };
    setPhase({ kind: 'busy', label: c.convertingPdf });
    await process(await pdf.render(pages[0]!, PDF_RENDER_LONG_EDGE), 0, 'pdf');
  }

  async function rotate() {
    const s = source.current;
    if (!s) return;
    await process(s.src, (((s.rotation + 90) % 360) as Rotation), s.origin);
  }

  async function accept(scan: Scan) {
    const item = newQueuedUpload({
      applicationId: p.applicationId,
      docCode: p.docCode,
      slot,
      blob: scan.blob,
      quality: {
        blur: scan.metrics.blur,
        glare: scan.metrics.glare,
        brightness: scan.metrics.brightness,
        warnings: scan.issues.map((i) => i.code),
        usedAnyway: scan.issues.length > 0,
        source: scan.origin,
        jpegQuality: scan.jpegQuality,
      },
    });
    await enqueue(item); // survives reloads until the server confirms
    await runUpload(item, scan);
  }

  async function runUpload(item: QueuedUpload, scan: Scan | null) {
    if (scan) setPhase({ kind: 'uploading', scan, pct: 0, waiting: null });
    const outcome = await uploadWithRetry(item, {
      onProgress: (f) => scan && setPhase((ph) => (ph.kind === 'uploading' ? { ...ph, pct: Math.round(f * 100), waiting: null } : ph)),
      onWaiting: (ms) => {
        if (scan) setPhase((ph) => (ph.kind === 'uploading' ? { ...ph, waiting: ms } : ph));
        else setNotice(Number.isFinite(ms) ? interpolate(c.retrying, { s: Math.ceil(ms / 1000) }) : c.queued);
      },
    });
    if (!outcome.ok) {
      if (outcome.retryable) {
        // Still queued: PendingUploads resumes it when the connection returns.
        setNotice(c.queued);
        if (scan) reset(false);
        return;
      }
      const msg = interpolate(c.serverRejected, { reason: outcome.error?.message ?? studentText.common.errorBody });
      setError(msg);
      say(msg);
      if (scan) setPhase({ kind: 'review', scan: { ...scan, url: URL.createObjectURL(scan.blob) } });
      return;
    }
    setNotice(null);
    const r = outcome.response;
    const nextSlots = slots.map((s) => (s.page === item.slot ? { ...s, versionId: r.version.id } : s));
    setSlots(nextSlots);
    if (r.duplicateOf.length) {
      const msg = interpolate(c.duplicateWarning, { docs: r.duplicateOf.map((d) => d.replace(/_/g, ' ')).join(', ') });
      toast({ title: msg, tone: 'info', duration: 9000 });
    }
    const open = nextSlots.filter((s) => !s.versionId);
    const q = pdfQueue.current;
    if (q && q.pages.length && open.length) {
      const nextSlot = firstOpenSlot(nextSlots);
      setSlot(nextSlot);
      const [page, ...rest] = q.pages;
      pdfQueue.current = { pdf: q.pdf, pages: rest };
      say(interpolate(c.uploadedPage, { n: item.slot }));
      await process(await q.pdf.render(page!, PDF_RENDER_LONG_EDGE), 0, 'pdf');
      return;
    }
    if (q) {
      q.pdf.destroy();
      pdfQueue.current = null;
    }
    if (open.length) {
      setSlot(open[0]!.page);
      say(`${interpolate(c.uploadedPage, { n: item.slot })} ${interpolate(c.pageAdd, { n: open[0]!.page })}.`);
      reset();
    } else {
      if (source.current?.src instanceof ImageBitmap) source.current.src.close();
      source.current = null;
      setPhase({ kind: 'done' });
      say(multi ? c.allPagesDone : c.uploaded);
    }
    router.refresh();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f, 'file');
  }

  if (!p.canUpload) return null;

  return (
    <div className="space-y-4">
      <p aria-live="assertive" role="status" className="sr-only">
        {announce}
      </p>

      {multi && (
        <div role="group" aria-label={c.pageSlot.replace(' {n}', 's')} className="flex flex-wrap gap-2">
          {slots.map((s) => (
            <button
              key={s.page}
              type="button"
              aria-pressed={slot === s.page}
              disabled={phase.kind === 'uploading' || phase.kind === 'busy'}
              onClick={() => {
                setSlot(s.page);
                reset(false);
              }}
              className={cn(
                'inline-flex min-h-12 items-center gap-2 rounded-full border px-4 font-semibold',
                slot === s.page ? 'border-brand-500 bg-brand-100' : 'border-line bg-surface',
              )}
            >
              {s.versionId ? <Check aria-hidden className="size-4 text-ok" /> : <Plus aria-hidden className="size-4" />}
              {interpolate(c.pageSlot, { n: s.page })}
              <span className="sr-only">{s.versionId ? ` (${interpolate(c.pageDone, { n: s.page })})` : ''}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-sm border border-bad bg-[color-mix(in_srgb,var(--bad)_8%,var(--surface))] p-3 text-sm font-medium">
          {error}
        </p>
      )}
      {notice && (
        <p className="flex items-center gap-2 rounded-sm border border-line bg-surface p-3 text-sm">
          <WifiOff aria-hidden className="size-4 text-warn" />
          {notice}
        </p>
      )}

      {phase.kind === 'idle' && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn('space-y-3 rounded-md border-2 border-dashed p-4 transition-colors', dragging ? 'border-brand-500 bg-brand-100' : 'border-line')}
        >
          {multi && <p className="font-semibold">{interpolate(slots.find((s) => s.page === slot)?.versionId ? c.pageReplace : c.pageAdd, { n: slot })}</p>}
          <Button ref={firstAction} fullWidth size="lg" onClick={() => cameraInput.current?.click()} icon={<Camera aria-hidden className="size-5" />}>
            {c.takePhoto}
          </Button>
          {typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && (
            <Button fullWidth variant="secondary" onClick={() => setCamera(true)} icon={<Video aria-hidden className="size-5" />}>
              {c.liveCamera}
            </Button>
          )}
          <Button fullWidth variant="secondary" onClick={() => fileInput.current?.click()} icon={<FolderOpen aria-hidden className="size-5" />}>
            {c.chooseFile}
          </Button>
          <p className="text-center text-sm text-ink-muted">{c.acceptedTypes}</p>
          <p className="hidden text-center text-sm text-ink-muted sm:block">
            <ImagePlus aria-hidden className="mr-1 inline size-4" />
            {dragging ? c.dropActive : c.dropHere}
          </p>
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-label={c.takePhoto}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void handleFile(f, 'camera');
            }}
          />
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT_INPUT}
            className="sr-only"
            tabIndex={-1}
            aria-label={c.chooseFile}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void handleFile(f, 'file');
            }}
          />
        </div>
      )}

      {phase.kind === 'busy' && (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-md border border-line bg-surface p-6" aria-busy="true">
          <ScanLine aria-hidden className="size-8 animate-pulse text-brand-500 motion-reduce:animate-none" />
          <p className="font-medium" role="status">
            {phase.label}
          </p>
        </div>
      )}

      {phase.kind === 'pdf' && (
        <PdfPagePicker
          pdf={phase.pdf}
          max={Math.max(1, multi ? slots.filter((s) => !s.versionId).length || slots.length : 1)}
          onCancel={() => {
            phase.pdf.destroy();
            reset();
          }}
          onPick={(pages) => void pickPdfPages(phase.pdf, pages)}
        />
      )}

      {(phase.kind === 'review' || phase.kind === 'uploading') && (
        <ReviewPanel
          phase={phase}
          onRotate={rotate}
          onRetake={() => reset()}
          onAccept={() => phase.kind === 'review' && void accept(phase.scan)}
        />
      )}

      {phase.kind === 'done' && (
        <div className="space-y-3 rounded-md border border-[color-mix(in_srgb,var(--ok)_50%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,var(--surface))] p-4">
          <p className="flex items-center gap-2 font-semibold">
            <Check aria-hidden className="size-5 text-ok" />
            {multi ? c.allPagesDone : c.uploaded}
          </p>
          {p.nextHref ? (
            <Link href={p.nextHref} className="flex min-h-12 items-center justify-center gap-2 rounded-sm bg-brand-500 px-4 font-semibold text-on-brand no-underline">
              {c.nextDoc}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          ) : (
            <Link href="/apply" className="flex min-h-12 items-center justify-center gap-2 rounded-sm bg-brand-500 px-4 font-semibold text-on-brand no-underline">
              {c.backToChecklist}
            </Link>
          )}
        </div>
      )}

      {camera && (
        <CameraView
          profile={profile}
          onClose={() => setCamera(false)}
          onCapture={(blob) => {
            setCamera(false);
            void handleFile(blob, 'live');
          }}
        />
      )}
    </div>
  );
}

function newQueuedUpload(u: Omit<QueuedUpload, 'id' | 'createdAt' | 'attempts'>): QueuedUpload {
  return { ...u, id: crypto.randomUUID(), createdAt: Date.now(), attempts: 0 };
}

function ReviewPanel({
  phase,
  onRotate,
  onRetake,
  onAccept,
}: {
  phase: Extract<Phase, { kind: 'review' | 'uploading' }>;
  onRotate: () => void;
  onRetake: () => void;
  onAccept: () => void;
}) {
  const c = studentText.capture;
  const { scan } = phase;
  const hard = hasHardFail(scan.issues);
  const uploading = phase.kind === 'uploading';
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-md border border-line bg-[repeating-conic-gradient(var(--line)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
        <img src={scan.url} alt={c.preview} className="mx-auto max-h-[55vh] w-auto object-contain" />
        {!uploading && (
          <button
            type="button"
            onClick={onRotate}
            className="absolute top-2 right-2 inline-flex min-h-12 items-center gap-2 rounded-full bg-surface/90 px-4 font-semibold shadow-1"
          >
            <RotateCw aria-hidden className="size-4" />
            {c.rotate}
          </button>
        )}
      </div>
      <QualityReport issues={scan.issues} width={scan.width} height={scan.height} />
      {uploading ? (
        <div className="space-y-2" role="status" aria-live="polite">
          <div className="h-3 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.pct} aria-label={c.uploading.replace(' {pct}%', '')}>
            <div className="h-full bg-brand-500 transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${phase.pct}%` }} />
          </div>
          <p className="text-sm font-medium">
            {phase.waiting === null
              ? interpolate(c.uploading, { pct: phase.pct })
              : Number.isFinite(phase.waiting)
                ? interpolate(c.retrying, { s: Math.ceil(phase.waiting / 1000) })
                : c.queued}
          </p>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onRetake}>
            {c.retake}
          </Button>
          <Button className="flex-1" disabled={hard} onClick={onAccept} variant={hard ? 'secondary' : 'primary'}>
            {!hard && scan.issues.length ? c.useAnyway : c.useScan}
          </Button>
        </div>
      )}
    </div>
  );
}
