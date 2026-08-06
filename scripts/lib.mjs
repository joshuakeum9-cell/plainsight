// Shared helpers for the Plainsight data pipeline.
// All sources are free and keyless: Yahoo Finance (quotes/prices) + SEC EDGAR (fundamentals).

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const UA = 'Plainsight/1.0 (open-source research tool; contact: joshuakeum9@gmail.com)';

export async function fetchJSON(url, { headers = {}, retries = 3, backoff = 1200 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, status: r.status, data: await r.json() };
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(backoff * (i + 1) + Math.random() * 400);
    }
  }
  return { ok: false, error: String(lastErr) };
}

export async function fetchText(url, { headers = {}, retries = 3, backoff = 1200 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, status: r.status, text: await r.text() };
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(backoff * (i + 1) + Math.random() * 400);
    }
  }
  return { ok: false, error: String(lastErr) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run tasks with bounded concurrency and a minimum spacing between launches (rate limit).
export async function pool(items, worker, { concurrency = 4, spacingMs = 0, label = '' } = {}) {
  const results = new Array(items.length);
  let next = 0, done = 0, failed = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      if (spacingMs) await sleep(spacingMs);
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { ok: false, error: String(e) };
        failed++;
      }
      done++;
      if (label && done % 50 === 0) console.log(`[${label}] ${done}/${items.length} (${failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  if (label) console.log(`[${label}] complete: ${done}/${items.length}, ${failed} failed`);
  return results;
}

export async function writeJSON(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj));
}

export async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export const round = (x, dp = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

// Yahoo uses '-' where dots appear in share classes (BRK.B -> BRK-B).
export const toYahoo = (sym) => sym.replace(/\./g, '-');
