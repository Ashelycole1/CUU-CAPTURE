/// <reference lib="webworker" />
/**
 * Quality checks off the main thread (FR-UP-2). Receives a downscaled RGBA
 * buffer (transferred), returns the metrics from `analyzeRgba`.
 */
import { analyzeRgba } from './quality';

export interface QualityWorkerRequest {
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<QualityWorkerRequest>) => {
  const { id, data, width, height } = e.data;
  try {
    ctx.postMessage({ id, ok: true, metrics: analyzeRgba(data, width, height) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) });
  }
};
