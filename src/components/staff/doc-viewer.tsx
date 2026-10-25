'use client';
import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { RotateCcw, RotateCw, Search, SunMedium, Contrast, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fmt, staffText } from '@/i18n/staff';

const V = staffText.viewer;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const LOUPE = 180;
const LOUPE_FACTOR = 2.5;

export interface DocViewerPage {
  src: string;
  alt: string;
}

export interface DocViewerHandle {
  zoomIn(): void;
  zoomOut(): void;
  toggleZoom(): void;
  rotate(dir: 1 | -1): void;
  reset(): void;
  pan(dx: number, dy: number): void;
  setLoupe(on: boolean): void;
}

/**
 * FR-REV-2 / design §7.3 document viewer: zoom, pan (drag or arrow keys), rotate,
 * brightness/contrast, multi-page, and a magnifier loupe (hold Z, driven by the
 * parent's key handler through the imperative handle). Fully keyboard operable
 * when focused: + / - zoom, arrows pan, [ / ] rotate, 0 reset.
 * Give it a `key` per document so the view resets between documents.
 */
export const DocViewer = forwardRef<DocViewerHandle, { pages: DocViewerPage[]; className?: string }>(function DocViewer({ pages, className }, ref) {
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [loupe, setLoupe] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
  const reset = useCallback(() => {
    setZoom(1);
    setRot(0);
    setPos({ x: 0, y: 0 });
    setBrightness(100);
    setContrast(100);
  }, []);
  const pan = useCallback((dx: number, dy: number) => setPos((p) => ({ x: p.x + dx, y: p.y + dy })), []);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => setZoom((z) => clampZoom(z * 1.25)),
      zoomOut: () => setZoom((z) => clampZoom(z / 1.25)),
      toggleZoom: () => {
        setZoom((z) => (z > 1 ? 1 : 2));
        setPos({ x: 0, y: 0 });
      },
      rotate: (dir) => setRot((r) => (r + dir * 90 + 360) % 360),
      reset,
      pan,
      setLoupe,
    }),
    [reset, pan],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    const map: Record<string, () => void> = {
      '+': () => setZoom((z) => clampZoom(z * 1.25)),
      '=': () => setZoom((z) => clampZoom(z * 1.25)),
      '-': () => setZoom((z) => clampZoom(z / 1.25)),
      '0': reset,
      '[': () => setRot((r) => (r + 270) % 360),
      ']': () => setRot((r) => (r + 90) % 360),
      ArrowLeft: () => pan(step, 0),
      ArrowRight: () => pan(-step, 0),
      ArrowUp: () => pan(0, step),
      ArrowDown: () => pan(0, -step),
    };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  };

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (drag.current) setPos({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  };

  const current = pages[page];
  const filter = `brightness(${brightness}%) contrast(${contrast}%)`;

  // Loupe: magnify around the pointer (or the stage centre for keyboard users).
  const loupeStyle = (() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!loupe || !stage || !img || !current) return null;
    const s = stage.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    const p = pointer ?? { x: s.width / 2, y: s.height / 2 };
    const ix = p.x + s.left - r.left;
    const iy = p.y + s.top - r.top;
    const bw = r.width * LOUPE_FACTOR;
    const bh = r.height * LOUPE_FACTOR;
    return {
      left: p.x - LOUPE / 2,
      top: p.y - LOUPE / 2,
      backgroundImage: `url("${current.src}")`,
      backgroundSize: `${bw}px ${bh}px`,
      backgroundPosition: `${-(ix * LOUPE_FACTOR - LOUPE / 2)}px ${-(iy * LOUPE_FACTOR - LOUPE / 2)}px`,
      filter,
    };
  })();

  const btn = 'inline-flex size-9 items-center justify-center rounded-sm text-ink hover:bg-brand-100 focus-visible:outline-2';

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div role="toolbar" aria-label={V.label} className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
        <button type="button" className={btn} onClick={() => setZoom((z) => clampZoom(z / 1.25))} aria-label={V.zoomOut}>
          <ZoomOut aria-hidden className="size-4" />
        </button>
        <span className="w-14 text-center font-mono text-xs tabular" aria-live="polite">
          {fmt(V.zoomLevel, { pct: Math.round(zoom * 100) })}
        </span>
        <button type="button" className={btn} onClick={() => setZoom((z) => clampZoom(z * 1.25))} aria-label={V.zoomIn}>
          <ZoomIn aria-hidden className="size-4" />
        </button>
        <button type="button" className={btn} onClick={() => setRot((r) => (r + 270) % 360)} aria-label={V.rotateLeft}>
          <RotateCcw aria-hidden className="size-4" />
        </button>
        <button type="button" className={btn} onClick={() => setRot((r) => (r + 90) % 360)} aria-label={V.rotateRight}>
          <RotateCw aria-hidden className="size-4" />
        </button>
        <button type="button" className={btn} onClick={reset} aria-label={V.reset}>
          <Maximize aria-hidden className="size-4" />
        </button>
        <label className="ml-2 flex items-center gap-1.5 text-xs">
          <SunMedium aria-hidden className="size-4" />
          <span className="sr-only">{V.brightness}</span>
          <input type="range" min={40} max={200} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} className="w-24 accent-[var(--brand-500)]" aria-label={V.brightness} />
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <Contrast aria-hidden className="size-4" />
          <span className="sr-only">{V.contrast}</span>
          <input type="range" min={40} max={250} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} className="w-24 accent-[var(--brand-500)]" aria-label={V.contrast} />
        </label>
        {loupe && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-500">
            <Search aria-hidden className="size-3.5" />
            {V.loupe}
          </span>
        )}
        {pages.length > 1 && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label={fmt(V.page, { n: page + 1, total: pages.length })}>
            {pages.map((p, i) => (
              <button
                key={p.src}
                type="button"
                onClick={() => setPage(i)}
                aria-pressed={i === page}
                className={cn('min-h-8 rounded-sm border px-2 text-xs font-semibold', i === page ? 'border-brand-500 bg-brand-100' : 'border-line')}
              >
                {fmt(V.page, { n: i + 1, total: pages.length })}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        ref={stageRef}
        tabIndex={0}
        role="img"
        aria-label={`${current?.alt ?? ''}. ${V.instructions}`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setPointer(null)}
        onWheel={onWheel}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-[#1b1f27] select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] active:cursor-grabbing"
      >
        {current && (
          // eslint-disable-next-line @next/next/no-img-element -- private, session-authorized image
          <img
            ref={imgRef}
            src={current.src}
            alt=""
            draggable={false}
            className="absolute top-1/2 left-1/2 max-h-[92%] max-w-[92%] origin-center motion-safe:transition-transform motion-safe:duration-150"
            style={{ transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px) scale(${zoom}) rotate(${rot}deg)`, filter }}
          />
        )}
        {loupeStyle && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-full border-2 border-white bg-no-repeat shadow-[0_0_0_1px_rgba(0,0,0,.4),0_8px_24px_rgba(0,0,0,.5)]"
            style={{ width: LOUPE, height: LOUPE, ...loupeStyle }}
          />
        )}
      </div>
    </div>
  );
});
