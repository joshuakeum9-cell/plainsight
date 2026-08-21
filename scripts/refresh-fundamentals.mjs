// Refresh fundamentals from SEC EDGAR companyfacts (official filing data).
// Extracts 10 fiscal years of annual series + recent quarters for key concepts,
// derives Q4 values, computes TTM aggregates, and writes data/fundamentals/<TICKER>.json.
// Also merges EDGAR submissions metadata (SIC industry, HQ, fiscal year end).
import { fetchJSON, pool, writeJSON, readJSON, round } from './lib.mjs';

const universe = await readJSON('data/universe.json');
let companies = universe.companies.filter((c) => c.cik);
if (process.env.ONLY) companies = companies.filter((c) => process.env.ONLY.split(',').includes(c.t));
if (process.env.LIMIT) companies = companies.slice(0, +process.env.LIMIT);

// Concept fallback chains: first tag present wins (per data point, merged in order).
const FLOW_CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense'],
  costOfRevenue: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold', 'CostOfServices'],
  grossProfit: ['GrossProfit'],
  opIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  rnd: ['ResearchAndDevelopmentExpense'],
  sga: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  buybacks: ['PaymentsForRepurchaseOfCommonStock'],
  dividendsPaid: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
};
const PER_SHARE_FLOW = {
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  divPS: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'],
};
const INSTANT_CONCEPTS = {
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  ltDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
};

const isAnnualSpan = (u) => u.start && u.end && (Date.parse(u.end) - Date.parse(u.start)) / 86400000 > 320;
const isQuarterSpan = (u) => u.start && u.end && (() => { const d = (Date.parse(u.end) - Date.parse(u.start)) / 86400000; return d > 75 && d < 105; })();

function unitEntries(fact) {
  if (!fact?.units) return [];
  const key = Object.keys(fact.units).find((k) => k === 'USD' || k === 'USD/shares' || k === 'shares') || Object.keys(fact.units)[0];
  return fact.units[key] || [];
}

// Merge fallback concepts: collect entries, prefer earlier concepts on collisions.
function collect(gaap, tags, filter) {
  const byKey = new Map();
  for (const tag of tags) {
    for (const u of unitEntries(gaap[tag])) {
      if (!/^10-[KQ]/.test(u.form || '')) continue;
      if (!filter(u)) continue;
      const key = (u.start || '') + '|' + u.end;
      const existing = byKey.get(key);
      // Keep first-listed concept; within a concept keep the latest filing (restatements).
      if (!existing || (existing.tag === tag && (u.filed || '') > (existing.filed || ''))) {
        byKey.set(key, { start: u.start, end: u.end, val: u.val, fy: u.fy, fp: u.fp, filed: u.filed, tag });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.end.localeCompare(b.end));
}

// TTM for cumulative-only flows (cash flow statements are year-to-date in 10-Qs):
// TTM = last full FY + latest YTD - prior-year matching YTD.
function ttmFromYTD(gaap, tags, annual) {
  const lastFY = annual.at(-1);
  if (!lastFY) return null;
  const spans = collect(gaap, tags, (u) => u.start && u.end && (Date.parse(u.end) - Date.parse(u.start)) / 86400000 < 310);
  const after = spans.filter((r) => r.end > lastFY.end);
  if (!after.length) return lastFY.v; // FY is the freshest period we have
  // Longest span ending at the most recent date = the current YTD.
  const lastEnd = after.at(-1).end;
  const candidates = after.filter((r) => r.end === lastEnd);
  const cur = candidates.sort((a, b) => (Date.parse(b.end) - Date.parse(b.start)) - (Date.parse(a.end) - Date.parse(a.start)))[0];
  const curSpan = Date.parse(cur.end) - Date.parse(cur.start);
  const prior = spans.find((r) => {
    const dEnd = Math.abs(Date.parse(cur.end) - 365.25 * 86400000 - Date.parse(r.end));
    const dSpan = Math.abs(Date.parse(r.end) - Date.parse(r.start) - curSpan);
    return dEnd < 20 * 86400000 && dSpan < 20 * 86400000;
  });
  if (!prior) return lastFY.v;
  return lastFY.v + cur.val - prior.val;
}

function annualSeries(gaap, tags) {
  const rows = collect(gaap, tags, isAnnualSpan);
  const byEndYear = new Map();
  for (const r of rows) byEndYear.set(r.end.slice(0, 4), r); // later end dates win within a year label
  return [...byEndYear.entries()].map(([, r]) => ({ end: r.end, v: r.val })).slice(-11);
}

function quarterSeries(gaap, tags) {
  return collect(gaap, tags, isQuarterSpan).slice(-20).map((r) => ({ end: r.end, v: r.val }));
}

function instantAnnual(gaap, tags) {
  // Instant (balance sheet) values: dedupe by end date, keep latest filed.
  // A date counts as fiscal-year-end if ANY filing reports it in a 10-K
  // (10-Qs restate the prior FY-end balance, so form of the winner is unreliable).
  const byKey = new Map();
  for (const tag of tags) {
    for (const u of unitEntries(gaap[tag])) {
      if (!/^10-[KQ]/.test(u.form || '')) continue;
      const existing = byKey.get(u.end);
      if (!existing) byKey.set(u.end, { end: u.end, val: u.val, filed: u.filed, hasK: u.form.startsWith('10-K') });
      else {
        if ((u.filed || '') > (existing.filed || '')) { existing.val = u.val; existing.filed = u.filed; }
        existing.hasK ||= u.form.startsWith('10-K');
      }
    }
  }
  const all = [...byKey.values()].sort((a, b) => a.end.localeCompare(b.end));
  const annual = all.filter((r) => r.hasK);
  const series = (annual.length >= 3 ? annual : all).slice(-11).map((r) => ({ end: r.end, v: r.val }));
  const latest = all.at(-1) || null;
  return { series, latest: latest ? { end: latest.end, v: latest.val } : null };
}

// Derive Q4 = FY - (Q1+Q2+Q3) for flow concepts, then build a full quarter list.
function withDerivedQ4(quarters, annuals) {
  const out = [...quarters];
  for (const a of annuals) {
    const fyEnd = Date.parse(a.end);
    const inYear = quarters.filter((q) => {
      const d = fyEnd - Date.parse(q.end);
      return d > 45 * 86400000 && d < 320 * 86400000;
    });
    const already = quarters.some((q) => Math.abs(Date.parse(q.end) - fyEnd) < 20 * 86400000);
    if (!already && inYear.length === 3) {
      out.push({ end: a.end, v: a.v - inYear.reduce((s, q) => s + q.v, 0), d: 1 });
    }
  }
  return out.sort((a, b) => a.end.localeCompare(b.end)).slice(-17);
}

const ttm = (quarters) => {
  const last4 = quarters.slice(-4);
  if (last4.length < 4) return null;
  // Quarters must be consecutive-ish: newest within 400 days of oldest.
  if (Date.parse(last4[3].end) - Date.parse(last4[0].end) > 400 * 86400000) return null;
  return last4.reduce((s, q) => s + q.v, 0);
};

let ok = 0, fail = 0, noFacts = 0;
await pool(
  companies,
  async (co) => {
    const facts = await fetchJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${co.cik}.json`);
    if (!facts.ok) { fail++; return; }
    const gaap = facts.data.facts?.['us-gaap'];
    const dei = facts.data.facts?.dei;
    if (!gaap) { noFacts++; return; }

    const annual = {}, quarterly = {};
    for (const [name, tags] of Object.entries(FLOW_CONCEPTS)) {
      annual[name] = annualSeries(gaap, tags);
      const q = quarterSeries(gaap, tags);
      quarterly[name] = withDerivedQ4(q, annual[name]);
    }
    for (const [name, tags] of Object.entries(PER_SHARE_FLOW)) {
      annual[name] = annualSeries(gaap, tags);
      quarterly[name] = quarterSeries(gaap, tags); // per-share values don't sum across restatements; no Q4 derivation for eps display, but ttm eps uses derived below
    }
    const balances = {};
    for (const [name, tags] of Object.entries(INSTANT_CONCEPTS)) balances[name] = instantAnnual(gaap, tags);

    // Gross profit fallback: revenue - costOfRevenue
    if ((!annual.grossProfit || annual.grossProfit.length < 2) && annual.revenue.length && annual.costOfRevenue.length) {
      const cost = new Map(annual.costOfRevenue.map((r) => [r.end, r.v]));
      annual.grossProfit = annual.revenue.filter((r) => cost.has(r.end)).map((r) => ({ end: r.end, v: r.v - cost.get(r.end) }));
    }

    // Shares outstanding: dei latest + weighted diluted annual series
    const sharesLatest = (() => {
      const entries = unitEntries(dei?.EntityCommonStockSharesOutstanding).sort((a, b) => (a.end || '').localeCompare(b.end || ''));
      if (!entries.length) return null;
      // Multi-class companies file one cover-page fact per share class with the same
      // end date — sum them (correct for Alphabet-style 1:1 classes; Berkshire's
      // unequal A/B classes remain approximate and are sanity-gated at render time).
      const lastEnd = entries.at(-1).end;
      const sameEnd = entries.filter((e) => e.end === lastEnd);
      return { end: lastEnd, v: sameEnd.reduce((s, e) => s + e.val, 0) };
    })();
    const dilutedShares = annualSeries(gaap, ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic']);

    // EPS TTM via netIncome TTM / latest diluted shares (more robust than summing eps restatements).
    // Income-statement TTM sums discrete quarters; cash-flow TTM uses YTD arithmetic
    // (10-Q cash flow statements are cumulative). Each falls back to the other method.
    const niTTM = ttm(quarterly.netIncome) ?? ttmFromYTD(gaap, FLOW_CONCEPTS.netIncome, annual.netIncome);
    const revTTM = ttm(quarterly.revenue) ?? ttmFromYTD(gaap, FLOW_CONCEPTS.revenue, annual.revenue);
    const ocfTTM = ttmFromYTD(gaap, FLOW_CONCEPTS.ocf, annual.ocf);
    const capexTTM = ttmFromYTD(gaap, FLOW_CONCEPTS.capex, annual.capex);
    const sh = sharesLatest?.v || dilutedShares.at(-1)?.v || null;

    const summary = {
      revTTM, niTTM, ocfTTM, capexTTM,
      fcfTTM: ocfTTM != null && capexTTM != null ? ocfTTM - capexTTM : null,
      epsTTM: niTTM != null && sh ? round(niTTM / sh, 2) : null,
      sharesOut: sh,
      netMarginTTM: niTTM != null && revTTM ? round((niTTM / revTTM) * 100, 1) : null,
      equity: balances.equity.latest?.v ?? null,
      assets: balances.assets.latest?.v ?? null,
      cash: balances.cash.latest?.v ?? null,
      ltDebt: balances.ltDebt.latest?.v ?? null,
      divPS: annual.divPS?.at(-1)?.v ?? null,
      roeTTM: niTTM != null && balances.equity.latest?.v ? round((niTTM / balances.equity.latest.v) * 100, 1) : null,
    };

    // Company profile from submissions (industry, HQ, fiscal year end).
    // Profiles rarely change, so reuse last night's and refetch only on the
    // 1st of the month — halves our EDGAR request volume (fair-use: 10 req/s).
    let profile = null;
    try { profile = (await readJSON(`data/fundamentals/${co.t.replace(/\./g, '-')}.json`)).profile || null; } catch { /* first run */ }
    if (!profile || new Date().getUTCDate() === 1) {
      const sub = await fetchJSON(`https://data.sec.gov/submissions/CIK${co.cik}.json`);
      if (sub.ok) {
        profile = {
          sic: sub.data.sicDescription || null,
          fye: sub.data.fiscalYearEnd || null,
          city: sub.data.addresses?.business?.city || null,
          state: sub.data.addresses?.business?.stateOrCountry || null,
          website: sub.data.website || null,
          exchange: sub.data.exchanges?.[0] || null,
        };
      }
    }

    await writeJSON(`data/fundamentals/${co.t.replace(/\./g, '-')}.json`, {
      updated: new Date().toISOString(),
      symbol: co.t,
      name: facts.data.entityName || co.n,
      cik: co.cik,
      profile,
      annual,
      quarterly: {
        revenue: quarterly.revenue, netIncome: quarterly.netIncome,
        eps: quarterly.eps, opIncome: quarterly.opIncome, ocf: quarterly.ocf,
      },
      balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, v.series])),
      dilutedShares,
      sharesLatest,
      summary,
    });
    ok++;
  },
  // SEC EDGAR fair-use is 10 req/s per IP; exceeding earns a ~10-minute block
  // (which is what a half-failed nightly looks like). These settings keep the
  // effective rate near ~5 req/s with headroom for fast cache hits.
  { concurrency: 2, spacingMs: 300, label: 'fundamentals' }
);

console.log(`fundamentals done: ${ok} ok, ${fail} fetch-failed, ${noFacts} no us-gaap of ${companies.length}`);
if (ok < companies.length * 0.7) process.exit(1);
