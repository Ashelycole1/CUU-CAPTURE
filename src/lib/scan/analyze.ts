/**
 * Client wrapper around the quality Web Worker. Falls back to the main thread
 * if workers are unavailable (old WebViews) so checks never silently vanish.
 */
import { analyzeRgba, type QualityMetrics } from './quality';
import type { QualityWorkerRequest } from './quality.worker';

type Metrics = Omit<QualityMetrics, 'width' | 'height' | 'bytes'>;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (m: Metrics) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./quality.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; metrics?: Metrics; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok && e.data.metrics) p.resolve(e.data.metrics);
      else p.reject(new Error(e.data.error ?? 'analysis failed'));
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('worker error'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

export async function analyzePixels(px: { data: Uint8ClampedArray; width: number; height: number }): Promise<Metrics> {
  const w = getWorker();
  if (!w) return analyzeRgba(px.data, px.width, px.height);
  const id = ++seq;
  try {
    return await new Promise<Metrics>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const msg: QualityWorkerRequest = { id, data: px.data, width: px.width, height: px.height };
      // Copied, not transferred (≈3 MB at 1024 px), so the main-thread fallback still has the pixels.
      w.postMessage(msg);
    });
  } catch {
    return analyzeRgba(px.data, px.width, px.height);
  }
}
