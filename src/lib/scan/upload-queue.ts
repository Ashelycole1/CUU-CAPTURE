/**
 * Resilient uploads (FR-UP-4). Processed JPEGs are queued in IndexedDB so a reload
 * or a dropped connection never loses a scan; uploads retry with exponential
 * backoff and resume automatically on the `online` event. Progress comes from
 * XHR upload events. The server is idempotent per (slot, hash), so retries are safe.
 */
import { RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS } from './constants';
import type { UploadErrorBody, UploadResponse } from './upload-types';

export interface QueuedUpload {
  id: string;
  applicationId: string;
  docCode: string;
  slot: number;
  blob: Blob;
  quality: Record<string, unknown>;
  createdAt: number;
  attempts: number;
}

// ---------------------------------------------------------------- pure policy

/** Exponential backoff with full jitter, capped. `rand` is injectable for tests. */
export function backoffDelay(attempt: number, rand: () => number = Math.random, base = RETRY_BASE_MS, max = RETRY_MAX_MS): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

/** Network errors (status 0), timeouts, 408/429/5xx, and seq conflicts are retried; other 4xx are final. */
export function isRetryable(status: number, code?: string): boolean {
  if (status === 0 || status === 408 || status === 429 || status >= 500) return true;
  if (status === 409 && code === 'CONFLICT') return true;
  return false;
}

export function uploadUrl(u: Pick<QueuedUpload, 'applicationId' | 'docCode' | 'slot'>): string {
  const qs = new URLSearchParams({ applicationId: u.applicationId, docCode: u.docCode, slot: String(u.slot) });
  return `/api/uploads?${qs}`;
}

// ---------------------------------------------------------------- IndexedDB store

const DB_NAME = 'visadesk-uploads';
const STORE = 'queue';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // private mode etc.: memory only
    } catch {
      resolve(null);
    }
  });
}

const memory = new Map<string, QueuedUpload>();

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function enqueue(u: QueuedUpload): Promise<void> {
  memory.set(u.id, u);
  await tx('readwrite', (s) => s.put(u));
}

export async function dequeue(id: string): Promise<void> {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
}

export async function listQueued(filter?: { applicationId?: string; docCode?: string }): Promise<QueuedUpload[]> {
  const stored = (await tx<QueuedUpload[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedUpload[]>)) ?? [];
  const byId = new Map<string, QueuedUpload>([...memory.values(), ...stored].map((u) => [u.id, u]));
  return [...byId.values()]
    .filter((u) => (!filter?.applicationId || u.applicationId === filter.applicationId) && (!filter?.docCode || u.docCode === filter.docCode))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------- transport

export type UploadOutcome =
  | { ok: true; response: UploadResponse }
  | { ok: false; status: number; error: UploadErrorBody['error'] | null; retryable: boolean };

/** One XHR attempt with upload progress (0–1). */
export function sendOnce(u: QueuedUpload, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl(u));
    xhr.responseType = 'json';
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    const fail = () => resolve({ ok: false, status: 0, error: null, retryable: true });
    xhr.onerror = fail;
    xhr.ontimeout = fail;
    xhr.onabort = () => resolve({ ok: false, status: 0, error: { code: 'ABORTED', message: 'Cancelled' }, retryable: false });
    xhr.onload = () => {
      const body = xhr.response as UploadResponse | UploadErrorBody | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && 'version' in body) resolve({ ok: true, response: body });
      else {
        const error = body && 'error' in body ? body.error : null;
        resolve({ ok: false, status: xhr.status, error, retryable: isRetryable(xhr.status, error?.code) });
      }
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.set('applicationId', u.applicationId);
    form.set('docCode', u.docCode);
    form.set('slot', String(u.slot));
    form.set('quality', JSON.stringify(u.quality));
    form.set('file', u.blob, `${u.docCode}_${u.slot}.jpg`);
    xhr.send(form);
  });
}

export interface UploadEvents {
  onProgress?: (fraction: number) => void;
  /** Waiting `ms` before the next attempt (or until back online when ms = Infinity). */
  onWaiting?: (ms: number, attempt: number) => void;
}

function waitForOnline(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('online', done);
      resolve();
    };
    window.addEventListener('online', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Wake early when the connection comes back.
    const wake = () => {
      clearTimeout(t);
      window.removeEventListener('online', wake);
      resolve();
    };
    const t = setTimeout(wake, ms);
    window.addEventListener('online', wake);
    signal?.addEventListener('abort', wake, { once: true });
  });
}

const inflight = new Map<string, Promise<UploadOutcome>>();
const listeners = new Set<(id: string, outcome: UploadOutcome) => void>();

/** Notified whenever any queued upload finishes (success or permanent failure). */
export function onUploadSettled(fn: (id: string, outcome: UploadOutcome) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Upload a queued item until it succeeds or fails permanently. Keeps the item in
 * IndexedDB until the server confirms, so a reload can resume it. Concurrent
 * calls for the same item share one upload.
 */
export function uploadWithRetry(u: QueuedUpload, ev: UploadEvents = {}, signal?: AbortSignal): Promise<UploadOutcome> {
  const existing = inflight.get(u.id);
  if (existing) return existing;
  const p = runUpload(u, ev, signal).then((outcome) => {
    inflight.delete(u.id);
    if (outcome.ok || !outcome.retryable) listeners.forEach((fn) => fn(u.id, outcome));
    return outcome;
  });
  inflight.set(u.id, p);
  return p;
}

export function isInflight(id: string): boolean {
  return inflight.has(id);
}

async function runUpload(u: QueuedUpload, ev: UploadEvents, signal?: AbortSignal): Promise<UploadOutcome> {
  let last: UploadOutcome = { ok: false, status: 0, error: null, retryable: true };
  for (let attempt = u.attempts; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) break;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      ev.onWaiting?.(Infinity, attempt);
      await waitForOnline(signal);
    }
    last = await sendOnce(u, ev.onProgress, signal);
    if (last.ok) {
      await dequeue(u.id);
      return last;
    }
    if (!last.retryable) {
      await dequeue(u.id);
      return last;
    }
    u.attempts = attempt + 1;
    await enqueue(u);
    const ms = backoffDelay(attempt);
    ev.onWaiting?.(ms, attempt + 1);
    await sleep(ms, signal);
  }
  return last; // still queued; resumes on the next `online` event or page load
}
