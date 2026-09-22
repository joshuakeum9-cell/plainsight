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

// Large documents (multi-MB XBRL instances from the Archives) go through
// node:https rather than fetch: Node 24's undici trips an internal assertion
// (`assert(!this.paused)`) on some big streamed bodies and takes the whole
// process down with it, which is not something a try/catch can see.
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
function httpsText(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip', ...headers } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpsText(new URL(res.headers.location, url).href, headers).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') { try { buf = gunzipSync(buf); } catch (e) { return reject(e); } }
        resolve({ status: res.statusCode, text: buf.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  });
}

export async function fetchText(url, { headers = {}, retries = 3, backoff = 1200 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await httpsText(url, headers);
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status };
      return { ok: true, status: r.status, text: r.text };
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
