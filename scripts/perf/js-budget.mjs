#!/usr/bin/env node
/**
 * First-load JS budget per App Router route (NFR-PERF: student routes < 200 KB gzipped).
 *
 * Run after `next build`:  node scripts/perf/js-budget.mjs [--json] [--budget 200]
 *
 * Next 16 (Turbopack) no longer prints "First Load JS" in the build output, so this reads
 * the build manifests instead: first-load JS of a route = the root main files (framework +
 * runtime, shared by every page) + every chunk in `entryJSFiles` of the route's segments
 * (root layout, group layout, error/loading boundaries, page). Polyfills are excluded
 * (served `nomodule`, never downloaded by modern browsers). Sizes are gzip -9 of each chunk.
 * Also checks that lazily-loaded heavy libraries (heic2any, pdfjs-dist) are NOT in any
 * route's initial chunks.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const next = path.join(root, '.next');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const budgetKb = Number(args[args.indexOf('--budget') + 1]) || 200;

const build = JSON.parse(fs.readFileSync(path.join(next, 'build-manifest.json'), 'utf8'));
const rootMain = build.rootMainFiles ?? [];

const sizeCache = new Map();
function chunkInfo(rel) {
  if (sizeCache.has(rel)) return sizeCache.get(rel);
  const buf = fs.readFileSync(path.join(next, rel));
  const text = buf.toString('utf8');
  const info = {
    raw: buf.length,
    gz: zlib.gzipSync(buf, { level: 9 }).length,
    heic2any: /heic2any|libheif/i.test(text),
    // Library-internal identifiers, not the lazy loader (which only touches GlobalWorkerOptions).
    pdfjs: /InvalidPDFException|pdfjsVersion/.test(text),
  };
  sizeCache.set(rel, info);
  return info;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'page_client-reference-manifest.js') out.push(p);
  }
  return out;
}

const rows = [];
for (const file of walk(path.join(next, 'server', 'app'))) {
  globalThis.self = globalThis;
  globalThis.__RSC_MANIFEST = {};
  // The manifest is a tiny script that assigns globalThis.__RSC_MANIFEST[route] = {...}.
  new Function(fs.readFileSync(file, 'utf8'))();
  for (const [route, m] of Object.entries(globalThis.__RSC_MANIFEST)) {
    if (!route.endsWith('/page')) continue;
    const chunks = new Set(rootMain);
    for (const list of Object.values(m.entryJSFiles ?? {})) for (const c of list) chunks.add(c);
    let raw = 0;
    let gz = 0;
    let heic = false;
    let pdf = false;
    for (const c of chunks) {
      const i = chunkInfo(c);
      raw += i.raw;
      gz += i.gz;
      heic ||= i.heic2any;
      pdf ||= i.pdfjs;
    }
    const url = route.replace(/\/page$/, '').replace(/\/\([^)]+\)/g, '') || '/';
    const group = (route.match(/\/\(([^)]+)\)/) ?? [])[1] ?? 'root';
    rows.push({ route: url, group, chunks: chunks.size, rawKb: +(raw / 1024).toFixed(1), gzKb: +(gz / 1024).toFixed(1), heic2any: heic, pdfjs: pdf });
  }
}
rows.sort((a, b) => a.group.localeCompare(b.group) || a.route.localeCompare(b.route));

let shared = 0;
for (const c of rootMain) shared += chunkInfo(c).gz;

// Lazy chunks containing the heavy libraries (should exist, but never in a route's first load).
const lazy = [];
for (const f of fs.readdirSync(path.join(next, 'static', 'chunks'))) {
  if (!f.endsWith('.js')) continue;
  const i = chunkInfo(path.join('static', 'chunks', f));
  if (i.heic2any || i.pdfjs) lazy.push({ chunk: f, gzKb: +(i.gz / 1024).toFixed(1), lib: i.heic2any ? 'heic2any' : 'pdfjs' });
}

const failures = rows.filter((r) => r.group === 'student' && r.gzKb > budgetKb);
const leaks = rows.filter((r) => r.heic2any || r.pdfjs);
if (asJson) {
  console.log(JSON.stringify({ sharedGzKb: +(shared / 1024).toFixed(1), budgetKb, rows, lazy, failures, leaks }, null, 2));
} else {
  console.log(`Shared framework/runtime (every route): ${(shared / 1024).toFixed(1)} KB gz`);
  console.log('| Route | Group | Chunks | Raw KB | Gzip KB | heic2any | pdfjs |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.route} | ${r.group} | ${r.chunks} | ${r.rawKb} | ${r.gzKb} | ${r.heic2any ? 'YES' : 'no'} | ${r.pdfjs ? 'YES' : 'no'} |`);
  console.log('\nLazy chunks with heavy libs (loaded on demand only):');
  for (const l of lazy) console.log(`  ${l.chunk}  ${l.lib}  ${l.gzKb} KB gz`);
}
if (failures.length || leaks.length) {
  console.error(`\nFAIL: ${failures.length} student route(s) over ${budgetKb} KB gz, ${leaks.length} route(s) load heic2any/pdfjs eagerly.`);
  process.exit(1);
}
