// Refresh per-ticker price history for charts: 1y daily + 10y monthly candles,
// plus latest session OHLCV. Output: data/history/<TICKER>.json
import { fetchJSON, pool, writeJSON, readJSON, round, toYahoo } from './lib.mjs';

const universe = await readJSON('data/universe.json');
const INDICES = ['^GSPC', '^DJI', '^IXIC', '^RUT'];
const targets = [...INDICES, ...universe.companies.map((c) => c.t)];

function compact(result) {
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const adj = result?.indicators?.adjclose?.[0]?.adjclose;
  const t = [], c = [], v = [];
  for (let i = 0; i < ts.length; i++) {
    const close = (adj && adj[i] != null) ? adj[i] : q.close?.[i];
    if (close == null) continue;
    t.push(ts[i]);
    c.push(round(close, close < 5 ? 4 : 2));
    v.push(q.volume?.[i] ?? 0);
  }
  return { t, c, v };
}

async function fetchRange(ySym, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=${range}&interval=${interval}&events=div`;
  const r = await fetchJSON(url);
  if (!r.ok) return null;
  return r.data.chart?.result?.[0] || null;
}

let ok = 0, fail = 0;
await pool(
  targets,
  async (sym) => {
    const ySym = toYahoo(sym);
    const daily = await fetchRange(ySym, '1y', '1d');
    const monthly = await fetchRange(ySym, '10y', '1mo');
    if (!daily) { fail++; return; }
    const meta = daily.meta || {};
    const q = daily.indicators?.quote?.[0] || {};
    const last = (daily.timestamp || []).length - 1;
    const out = {
      updated: new Date().toISOString(),
      symbol: sym,
      name: meta.longName || meta.shortName || sym,
      exchange: meta.fullExchangeName || null,
      currency: meta.currency || 'USD',
      last: {
        o: round(q.open?.[last], 2), h: round(q.high?.[last], 2),
        l: round(q.low?.[last], 2), c: round(q.close?.[last], 2),
        v: q.volume?.[last] ?? null,
        dayHigh: round(meta.regularMarketDayHigh, 2),
        dayLow: round(meta.regularMarketDayLow, 2),
        volume: meta.regularMarketVolume ?? null,
      },
      daily: compact(daily),
      monthly: monthly ? compact(monthly) : { t: [], c: [], v: [] },
    };
    const fileSym = sym.replace(/[\^]/g, '_IDX_').replace(/\./g, '-');
    await writeJSON(`data/history/${fileSym}.json`, out);
    ok++;
  },
  { concurrency: 4, spacingMs: 180, label: 'history' }
);

console.log(`history done: ${ok} ok, ${fail} failed of ${targets.length}`);
if (ok < targets.length * 0.7) process.exit(1);
