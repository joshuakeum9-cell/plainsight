// Intraday price series for the whole universe: 1D at 5-minute bars,
// 5D at 15-minute bars, from Yahoo's batch spark endpoint (keyless).
// Output goes to intraday-out/ and is force-pushed to the single-commit
// `data-intraday` branch (NOT main) so 15-minute refreshes never bloat
// repo history. The site fetches it via raw.githubusercontent.com.
import { fetchJSON, pool, writeJSON, readJSON, round, toYahoo } from './lib.mjs';

const universe = await readJSON('data/universe.json');
const symbols = universe.companies.map((c) => toYahoo(c.t));
const INDEX_SYMS = ['^GSPC', '^DJI', '^IXIC', '^RUT', '^VIX', '^TNX'];
const all = [...INDEX_SYMS, ...symbols];

async function grab(range, interval) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20)); // spark caps at 20 symbols/call
  await pool(
    chunks,
    async (chunk) => {
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=${range}&interval=${interval}`;
      const r = await fetchJSON(url);
      if (!r.ok) return r;
      for (const item of r.data.spark?.result || []) {
        const resp = item.response?.[0];
        const ts = resp?.timestamp;
        const close = resp?.indicators?.quote?.[0]?.close;
        if (!ts || !close) continue;
        const t = [], c = [];
        for (let i = 0; i < ts.length; i++) {
          if (close[i] != null) { t.push(ts[i]); c.push(round(close[i], close[i] < 5 ? 4 : 2)); }
        }
        if (t.length >= 2) {
          out[item.symbol] = { t, c, pc: round(resp.meta?.chartPreviousClose ?? resp.meta?.previousClose, 2) };
        }
      }
      return { ok: true };
    },
    { concurrency: 3, spacingMs: 250, label: `spark ${range}` }
  );
  return out;
}

const d1 = await grab('1d', '5m');
const d5 = await grab('5d', '15m');

if (Object.keys(d1).length < all.length * 0.7) {
  console.error(`Only ${Object.keys(d1).length}/${all.length} 1D series fetched — refusing to publish.`);
  process.exit(1);
}

const updated = new Date().toISOString();
await writeJSON('intraday-out/intraday-1d.json', { updated, series: d1 });
await writeJSON('intraday-out/intraday-5d.json', { updated, series: d5 });
console.log(`intraday written: 1d=${Object.keys(d1).length} 5d=${Object.keys(d5).length} symbols`);
