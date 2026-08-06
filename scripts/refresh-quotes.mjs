// Refresh live quotes for the whole universe + market indices.
// Uses Yahoo's batch spark endpoint (keyless). Output: data/quotes.json
import { fetchJSON, pool, writeJSON, readJSON, round, toYahoo } from './lib.mjs';

const INDICES = [
  { y: '^GSPC', label: 'S&P 500' },
  { y: '^DJI', label: 'Dow Jones' },
  { y: '^IXIC', label: 'Nasdaq' },
  { y: '^RUT', label: 'Russell 2000' },
  { y: '^VIX', label: 'VIX' },
  { y: '^TNX', label: '10-Yr Treasury' },
];

const universe = await readJSON('data/universe.json');
const symbols = universe.companies.map((c) => toYahoo(c.t));
const all = [...INDICES.map((i) => i.y), ...symbols];

const chunks = [];
for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20)); // spark caps at 20 symbols/call

const quotes = {};
const results = await pool(
  chunks,
  async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=1d&interval=30m`;
    const r = await fetchJSON(url);
    if (!r.ok) return r;
    for (const item of r.data.spark?.result || []) {
      const resp = item.response?.[0];
      const meta = resp?.meta;
      if (!meta || meta.regularMarketPrice == null) continue;
      const prev = meta.previousClose ?? meta.chartPreviousClose;
      const p = meta.regularMarketPrice;
      quotes[item.symbol] = {
        p: round(p, p < 5 ? 4 : 2),
        pc: round(prev, 2),
        c: round(p - prev, 2),
        cp: round(prev ? ((p - prev) / prev) * 100 : null, 2),
        h52: round(meta.fiftyTwoWeekHigh, 2),
        l52: round(meta.fiftyTwoWeekLow, 2),
        mt: meta.regularMarketTime || null,
      };
    }
    return { ok: true };
  },
  { concurrency: 3, spacingMs: 250, label: 'quotes' }
);

const okCount = Object.keys(quotes).length;
const failedChunks = results.filter((r) => !r?.ok).length;
if (okCount < all.length * 0.7) {
  console.error(`Only ${okCount}/${all.length} quotes fetched (${failedChunks} chunks failed) — refusing to overwrite quotes.json`);
  process.exit(1);
}

// Preserve previous values for symbols that failed this run.
let previous = {};
try { previous = (await readJSON('data/quotes.json')).quotes || {}; } catch { /* first run */ }
for (const s of all) if (!quotes[s] && previous[s]) quotes[s] = previous[s];

const indices = {};
for (const idx of INDICES) if (quotes[idx.y]) indices[idx.y] = { label: idx.label, ...quotes[idx.y] };

await writeJSON('data/quotes.json', {
  updated: new Date().toISOString(),
  count: okCount,
  indices,
  quotes: Object.fromEntries(symbols.filter((s) => quotes[s]).map((s) => [s, quotes[s]])),
});
console.log(`quotes.json written: ${okCount}/${all.length} fresh (${failedChunks} chunks failed)`);
