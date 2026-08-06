// Build the ticker universe: S&P 500 constituents from Wikipedia
// (symbol, name, GICS sector, sub-industry, CIK) -> data/universe.json
import { fetchText, writeJSON } from './lib.mjs';

const WIKI = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

const r = await fetchText(WIKI);
if (!r.ok) {
  console.error('Failed to fetch Wikipedia S&P 500 list:', r.status || r.error);
  process.exit(1);
}

// The constituents table is the first table with id="constituents".
const tableMatch = r.text.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/);
if (!tableMatch) {
  console.error('Could not locate constituents table');
  process.exit(1);
}
const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/g).slice(1); // skip header

const companies = [];
for (const row of rows) {
  const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1]));
  if (cells.length < 7) continue;
  const [symbol, name, sector, subIndustry, hq, , cik] = cells;
  if (!symbol || !/^[A-Z][A-Z0-9.\-]*$/.test(symbol)) continue;
  companies.push({
    t: symbol,               // ticker as printed (BRK.B)
    n: name,
    s: sector,
    si: subIndustry,
    hq,
    cik: cik ? cik.padStart(10, '0') : null,
  });
}

if (companies.length < 400) {
  console.error(`Parsed only ${companies.length} companies — page layout may have changed. Aborting without overwrite.`);
  process.exit(1);
}

companies.sort((a, b) => a.t.localeCompare(b.t));
await writeJSON('data/universe.json', {
  updated: new Date().toISOString(),
  source: 'Wikipedia: List of S&P 500 companies',
  count: companies.length,
  companies,
});
console.log(`universe.json written: ${companies.length} companies`);
