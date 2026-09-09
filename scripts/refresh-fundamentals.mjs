// Refresh fundamentals from SEC EDGAR companyfacts (official filing data).
// Extracts 10 fiscal years of annual series + recent quarters for key concepts,
// derives Q4 values, computes TTM aggregates, and writes data/fundamentals/<TICKER>.json.
// Also merges EDGAR submissions metadata (SIC industry, HQ, fiscal year end).
import { fetchJSON, fetchText, pool, writeJSON, readJSON, round } from './lib.mjs';

const universe = await readJSON('data/universe.json');
let companies = universe.companies.filter((c) => c.cik);
if (process.env.ONLY) companies = companies.filter((c) => process.env.ONLY.split(',').includes(c.t));
if (process.env.LIMIT) companies = companies.slice(0, +process.env.LIMIT);

// Concept fallback chains: first tag present wins (per data point, merged in order).
const FLOW_CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingLeaseLeaseIncome', 'OperatingLeasesIncomeStatementLeaseRevenue'],
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
// Filers that never report a single "total revenue" line: banks state net
// interest income and noninterest income separately (their sum is what the
// street calls revenue), and some utilities split regulated from unregulated.
// Used only when the single-tag chain above comes up short.
const COMPOSITE_REVENUE = [
  [['InterestIncomeExpenseNet', 'InterestIncomeExpenseAfterProvisionForLoanLoss'], ['NoninterestIncome']],
  [['RegulatedOperatingRevenue'], ['UnregulatedOperatingRevenue']],
  // Last resort for filers that tag no total at all (APA reports its oil and gas
  // sales only in its own namespace): revenue == operating income + the costs
  // and expenses deducted to reach it.
  [['OperatingIncomeLoss'], ['CostsAndExpenses']],
];
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

// ---- recent-period backfill from EDGAR's frames endpoint ----
// companyfacts can trail a filing by weeks: Abbott's Q2 2026 10-Q was filed
// 2026-07-28 and was still absent in September, leaving ~70 S&P companies a
// quarter behind. frames serves one concept for one period across every filer
// in a single call and already carries those numbers, so a few dozen requests
// up front fill the gap for the whole index.
const FRAME_CONCEPTS = [
  ...FLOW_CONCEPTS.revenue, ...FLOW_CONCEPTS.netIncome, ...FLOW_CONCEPTS.opIncome,
  ...FLOW_CONCEPTS.grossProfit, ...FLOW_CONCEPTS.ocf, ...FLOW_CONCEPTS.capex,
  ...COMPOSITE_REVENUE.flat(2),
].map((t) => [t, 'USD']).concat(PER_SHARE_FLOW.eps.map((t) => [t, 'USD-per-shares']));

// Completed calendar quarters (the current one has not closed) plus recent
// full years, which is where any lag can bite.
function recentFrames(now = new Date()) {
  const y = now.getUTCFullYear();
  let yy = y, qq = Math.floor(now.getUTCMonth() / 3);
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (qq < 1) { qq = 4; yy--; }
    out.push(`CY${yy}Q${qq}`);
    qq--;
  }
  return [...out, `CY${y - 1}`, `CY${y - 2}`];
}

const FRAMES = new Map(); // tag -> Map(cik -> [{start, end, val}])
async function loadFrames(ciks) {
  const jobs = [];
  for (const [tag, uom] of FRAME_CONCEPTS) for (const p of recentFrames()) jobs.push({ tag, uom, p });
  await pool(jobs, async ({ tag, uom, p }) => {
    const r = await fetchJSON(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${uom}/${p}.json`);
    if (!r.ok) return; // a concept with no filers for a period simply 404s
    let m = FRAMES.get(tag);
    if (!m) FRAMES.set(tag, (m = new Map()));
    for (const d of r.data.data || []) {
      if (d.val == null || !d.start || !d.end || !ciks.has(d.cik)) continue;
      const row = { start: d.start, end: d.end, val: d.val };
      const arr = m.get(d.cik);
      if (arr) arr.push(row); else m.set(d.cik, [row]);
    }
  }, { concurrency: 2, spacingMs: 250, label: 'frames' });
  let n = 0;
  for (const m of FRAMES.values()) for (const a of m.values()) n += a.length;
  console.log(`frames loaded: ${FRAMES.size} concepts, ${n} facts for the universe`);
}

const isAnnualSpan = (u) => u.start && u.end && (Date.parse(u.end) - Date.parse(u.start)) / 86400000 > 320;
// Up to ~17 weeks: most quarters run 13 weeks, but retailers on a 52/53-week
// calendar use a 16-week opening quarter (Kroger's Q1 is 111 days). Six-month
// year-to-date spans (~180d) stay out.
const isQuarterSpan = (u) => u.start && u.end && (() => { const d = (Date.parse(u.end) - Date.parse(u.start)) / 86400000; return d > 75 && d < 125; })();

function unitEntries(fact) {
  if (!fact?.units) return [];
  const key = Object.keys(fact.units).find((k) => k === 'USD' || k === 'USD/shares' || k === 'shares') || Object.keys(fact.units)[0];
  return fact.units[key] || [];
}

// Merge fallback concepts into one series per period.
// Same tag -> the later filing wins, which picks up restatements. Different
// tags -> the first listed wins, EXCEPT under `pickMax` (revenue), where the
// largest wins: several filers put only a sliver of their revenue in the
// first-listed tag and the real total in another. Essex reported $0.01B of
// "revenue from contracts with customers" against $1.89B of Revenues, and
// American Tower $0.94B against $10.64B. A total is never smaller than a part,
// so the largest candidate is the total.
function collect(gaap, tags, filter, cik, pickMax) {
  const byKey = new Map();
  const consider = (u, tag, filed) => {
    if (!filter(u)) return;
    const key = (u.start || '') + '|' + u.end;
    const existing = byKey.get(key);
    let better;
    if (!existing) better = true;
    else if (existing.tag === tag) better = (filed || '') > (existing.filed || '');
    else better = pickMax ? Math.abs(u.val) > Math.abs(existing.val) : false;
    if (better) byKey.set(key, { start: u.start, end: u.end, val: u.val, fy: u.fy, fp: u.fp, filed, tag });
  };
  for (const tag of tags) {
    for (const u of unitEntries(gaap[tag])) {
      if (!/^10-[KQ]/.test(u.form || '')) continue;
      consider(u, tag, u.filed);
    }
  }
  // Frames fills periods companyfacts has not ingested yet; a frames fact has no
  // filing date, so it only ever loses a same-tag contest against a real one.
  if (cik != null) {
    for (const tag of tags) {
      for (const u of FRAMES.get(tag)?.get(cik) || []) consider(u, tag, '');
    }
  }
  return [...byKey.values()].sort((a, b) => a.end.localeCompare(b.end));
}

// TTM for cumulative-only flows (cash flow statements are year-to-date in 10-Qs):
// TTM = last full FY + latest YTD - prior-year matching YTD.
function ttmFromYTD(gaap, tags, annual, cik) {
  const lastFY = annual.at(-1);
  if (!lastFY) return null;
  const spans = collect(gaap, tags, (u) => u.start && u.end && (Date.parse(u.end) - Date.parse(u.start)) / 86400000 < 310, cik);
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

const toAnnual = (rows) => {
  const byEndYear = new Map();
  for (const r of rows) byEndYear.set(r.end.slice(0, 4), r); // later end dates win within a year label
  return [...byEndYear.values()].map((r) => ({ end: r.end, v: r.val })).slice(-11);
};
const toQuarter = (rows) => rows.slice(-20).map((r) => ({ end: r.end, v: r.val }));

function annualSeries(gaap, tags, cik, pickMax) {
  return toAnnual(collect(gaap, tags, isAnnualSpan, cik, pickMax));
}

function quarterSeries(gaap, tags, cik, pickMax) {
  return toQuarter(collect(gaap, tags, isQuarterSpan, cik, pickMax));
}

// Sum two or more concept groups over identical periods (see COMPOSITE_REVENUE).
// A period is only emitted when every part reports it, so partial sums can't
// masquerade as a total.
function compositeRows(gaap, filter, cik) {
  for (const parts of COMPOSITE_REVENUE) {
    const maps = parts.map((tags) => new Map(collect(gaap, tags, filter, cik).map((r) => [r.start + '|' + r.end, r.val])));
    if (maps.some((m) => !m.size)) continue;
    const rows = [...maps[0].keys()]
      .filter((k) => maps.every((m) => m.has(k)))
      .map((k) => ({ start: k.split('|')[0], end: k.split('|')[1], val: maps.reduce((s, m) => s + m.get(k), 0) }))
      .sort((a, b) => a.end.localeCompare(b.end));
    if (rows.length >= 2) return rows;
  }
  return [];
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
  return { series, latest: latest ? { end: latest.end, v: latest.val } : null, byEnd: new Map(all.map((r) => [r.end, r.val])) };
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

// Some filers tag a full-year figure with a quarter-length period: L3Harris put
// FY2025 revenue ($21.9B) on a 90-day span ending 2026-01-02, which would both
// strand the fiscal year and quadruple TTM. When a "quarter" dwarfs its peers,
// sits at a date with no annual figure, and is newer than every annual we have,
// it is that missing fiscal year -> move it across.
function reclassifyMistaggedAnnual(annual, quarterly) {
  if (quarterly.length < 4) return { annual, quarterly };
  const sorted = quarterly.slice(-8).map((q) => Math.abs(q.v)).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const newestAnnual = annual.at(-1)?.end || '';
  if (!med) return { annual, quarterly };
  // The date must also fall on the anniversary of the last fiscal year end,
  // otherwise a genuine surge gets mistaken for a year: Micron's revenue tripled
  // inside a year and its Q3 would otherwise have been swallowed as an annual.
  const anniversary = (end) => {
    if (!newestAnnual) return false;
    const a = new Date(newestAnnual), e = new Date(end);
    a.setUTCFullYear(a.getUTCFullYear() + 1);
    return Math.abs(e - a) < 12 * 86400000;
  };
  const keep = [], moved = [];
  for (const q of quarterly) {
    const outlier = Math.abs(q.v) > med * 2.5 && q.end > newestAnnual
      && anniversary(q.end) && !annual.some((a) => a.end === q.end);
    (outlier ? moved : keep).push(q);
  }
  if (!moved.length) return { annual, quarterly };
  const merged = [...annual, ...moved.map((m) => ({ end: m.end, v: m.v }))].sort((a, b) => a.end.localeCompare(b.end));
  return { annual: merged.slice(-11), quarterly: keep };
}

const ttm = (quarters) => {
  const last4 = quarters.slice(-4);
  if (last4.length < 4) return null;
  // Quarters must be consecutive-ish: newest within 400 days of oldest.
  if (Date.parse(last4[3].end) - Date.parse(last4[0].end) > 400 * 86400000) return null;
  // Refuse to sum a window still holding a mis-tagged full-year value rather
  // than publish a TTM (and a P/S built on it) that is quietly several x too big.
  const vals = last4.map((q) => Math.abs(q.v)).sort((a, b) => a - b);
  const med = (vals[1] + vals[2]) / 2;
  if (med > 0 && vals[3] > med * 2.5) return null;
  return last4.reduce((s, q) => s + q.v, 0);
};

await loadFrames(new Set(companies.map((c) => parseInt(c.cik, 10))));

let ok = 0, fail = 0, noFacts = 0;
// A holdco reorganisation moves the listed ticker to a brand-new CIK with no
// filing history while the operating company keeps filing under the old one:
// ExxonMobil Holdings Corp has a single 10-Q, Exxon Mobil Corp has 27. Merge the
// predecessor's facts so the report still shows a decade of history.
const PREDECESSOR_CIK = { XOM: '0000034088' };

function mergeFacts(into, extra) {
  for (const [tag, fact] of Object.entries(extra || {})) {
    if (!into[tag]) { into[tag] = fact; continue; }
    for (const [unit, rows] of Object.entries(fact.units || {})) {
      into[tag].units[unit] = [...(into[tag].units[unit] || []), ...rows];
    }
  }
}

async function buildCompany(co) {
    const facts = await fetchJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${co.cik}.json`);
    if (!facts.ok) { fail++; return; }
    const cikNum = parseInt(co.cik, 10);
    const gaap = facts.data.facts?.['us-gaap'];
    const predecessor = PREDECESSOR_CIK[co.t];
    if (predecessor && gaap) {
      const old = await fetchJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${predecessor}.json`);
      if (old.ok) mergeFacts(gaap, old.data.facts?.['us-gaap']);
    }
    const dei = facts.data.facts?.dei;
    if (!gaap) { noFacts++; return; }

    const annual = {}, quarterly = {};
    for (const [name, tags] of Object.entries(FLOW_CONCEPTS)) {
      const isRev = name === 'revenue';
      const fixed = reclassifyMistaggedAnnual(annualSeries(gaap, tags, cikNum, isRev), quarterSeries(gaap, tags, cikNum, isRev));
      annual[name] = fixed.annual;
      quarterly[name] = withDerivedQ4(fixed.quarterly, fixed.annual);
    }
    // Banks and split-revenue utilities: prefer the summed definition when the
    // single-tag chain came up empty, short, stale, or landed on a fragment tag
    // (e.g. Regions reports a $0.1B sliver under Revenues against $7B of real
    // revenue). Equal-quality single tags win, so filers like Citi and JPMorgan
    // that do report a true total keep it.
    {
      const cur = annual.revenue, ca = toAnnual(compositeRows(gaap, isAnnualSpan, cikNum));
      const a = cur.at(-1), b = ca.at(-1);
      // Never trade a current series for a longer but staler one: GE's
      // operating-income identity runs out in 2014 while its revenue tag is
      // current, so "more history" alone must not win.
      const fresher = !a || (b && b.end >= a.end);
      if (ca.length >= 3 && (cur.length < 3
          || (b && a && b.end > a.end)
          || (fresher && (ca.length > cur.length || b.v > a.v * 2)))) {
        annual.revenue = ca;
        // Only take the composite quarters if they are at least as fresh: a bank
        // can report net interest income quarterly long after it stops reporting
        // a matching noninterest-income period, which would strand the sum.
        const cq = withDerivedQ4(toQuarter(compositeRows(gaap, isQuarterSpan, cikNum)), ca);
        const curQ = quarterly.revenue;
        // If the annual total is the summed definition, quarters taken from a
        // single tag are measuring something narrower: Huntington's quarters came
        // out at $0.5B against $8.2B a year. Four typical quarters should roughly
        // reconstruct the year; when they fall far short, swap in the summed ones.
        const yr = ca.at(-1)?.v || 0;
        const q4 = curQ.slice(-4).map((q) => Math.abs(q.v)).sort((a, b) => a - b);
        const fragment = yr > 0 && q4.length > 0 && q4[Math.floor(q4.length / 2)] * 4 < yr * 0.5;
        if (cq.length && (!curQ.length || fragment || cq.at(-1).end >= curQ.at(-1).end)) quarterly.revenue = cq;
      }
      // Even when the annual total came from a single tag, that tag's QUARTERLY
      // series can dead-end while the components keep reporting: BNY's Revenues
      // stops in 2018 though net interest and noninterest income are current.
      const cq2 = withDerivedQ4(toQuarter(compositeRows(gaap, isQuarterSpan, cikNum)), annual.revenue);
      const q2 = quarterly.revenue;
      if (cq2.length && q2.length && cq2.at(-1).end > q2.at(-1).end) {
        const yr = annual.revenue.at(-1)?.v || 0;
        const m4 = cq2.slice(-4).map((q) => Math.abs(q.v)).sort((a, b) => a - b);
        const med4 = m4[Math.floor(m4.length / 2)] || 0;
        if (yr > 0 && med4 * 4 > yr * 0.5 && med4 * 4 < yr * 2) quarterly.revenue = cq2;
      }
    }
    for (const [name, tags] of Object.entries(PER_SHARE_FLOW)) {
      annual[name] = annualSeries(gaap, tags, cikNum);
      quarterly[name] = quarterSeries(gaap, tags, cikNum); // per-share values don't sum across restatements; no Q4 derivation for eps display, but ttm eps uses derived below
    }
    const balances = {};
    for (const [name, tags] of Object.entries(INSTANT_CONCEPTS)) balances[name] = instantAnnual(gaap, tags);
    // Liabilities are the least reliably tagged line on the balance sheet: Brown
    // & Brown stopped reporting the Liabilities element after 2019, and others
    // tag only a slice of it. Assets = liabilities + equity, so rebuild the
    // series on the assets dates and fall back to that identity wherever the
    // reported figure is missing or far below it. A modest shortfall is kept as
    // filed: that is normally noncontrolling interests, which sit outside
    // stockholders' equity and belong in neither column.
    {
      const impliedAt = (end) => {
        const a = balances.assets.byEnd.get(end), e = balances.equity.byEnd.get(end);
        return a != null && e != null ? a - e : null;
      };
      const pick = (end) => {
        const reported = balances.liabilities.byEnd.get(end) ?? null;
        const implied = impliedAt(end);
        if (implied != null && implied > 0 && (reported == null || reported < implied * 0.8)) return implied;
        return reported;
      };
      balances.liabilities.series = (balances.assets.series || [])
        .map((a) => { const v = pick(a.end); return v == null ? null : { end: a.end, v }; })
        .filter(Boolean);
    }

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
    const dilutedShares = annualSeries(gaap, ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'], cikNum);

    // EPS TTM via netIncome TTM / latest diluted shares (more robust than summing eps restatements).
    // Income-statement TTM sums discrete quarters; cash-flow TTM uses YTD arithmetic
    // (10-Q cash flow statements are cumulative). Each falls back to the other method.
    const niTTM = ttm(quarterly.netIncome) ?? ttmFromYTD(gaap, FLOW_CONCEPTS.netIncome, annual.netIncome, cikNum);
    const revTTM = ttm(quarterly.revenue) ?? ttmFromYTD(gaap, FLOW_CONCEPTS.revenue, annual.revenue, cikNum);
    const ocfTTM = ttmFromYTD(gaap, FLOW_CONCEPTS.ocf, annual.ocf, cikNum);
    const capexTTM = ttmFromYTD(gaap, FLOW_CONCEPTS.capex, annual.capex, cikNum);
    const sh = sharesLatest?.v || dilutedShares.at(-1)?.v || null;

    // Cash returned to shareholders is reported year-to-date in 10-Qs, same as
    // the cash-flow lines, so it takes the YTD arithmetic rather than a sum of
    // discrete quarters.
    const buybacksTTM = ttmFromYTD(gaap, FLOW_CONCEPTS.buybacks, annual.buybacks, cikNum);
    const dividendsTTM = ttmFromYTD(gaap, FLOW_CONCEPTS.dividendsPaid, annual.dividendsPaid, cikNum);
    // Balance sheets and share counts are point-in-time, so the newest QUARTER
    // is what "current" means for them, not a trailing twelve months.
    // Anchored on the newest assets date, reading the other lines at that same
    // date; a tag with nothing there stays null rather than borrowing an older
    // number and implying a balance sheet that never existed.
    const bEnd = balances.assets.latest?.end || null;
    const bAssets = bEnd ? balances.assets.byEnd.get(bEnd) ?? null : null;
    const bEquity = bEnd ? balances.equity.byEnd.get(bEnd) ?? null : null;
    let bLiab = bEnd ? balances.liabilities.byEnd.get(bEnd) ?? null : null;
    const bImplied = bAssets != null && bEquity != null ? bAssets - bEquity : null;
    if (bImplied != null && bImplied > 0 && (bLiab == null || bLiab < bImplied * 0.8)) bLiab = bImplied;
    const latestBalance = { end: bEnd, assets: bAssets, liabilities: bLiab, equity: bEquity };
    const qShares = quarterSeries(gaap, ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'], cikNum);
    const latestShares = qShares.at(-1) || null;

    const summary = {
      revTTM, niTTM, ocfTTM, capexTTM, buybacksTTM, dividendsTTM,
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
      latestBalance,
      latestShares,
      summary,
    });
    ok++;
}

await pool(
  companies,
  buildCompany,
  // SEC EDGAR fair-use is 10 req/s per IP; exceeding earns a ~10-minute block
  // (which is what a half-failed nightly looks like). These settings keep the
  // effective rate near ~5 req/s with headroom for fast cache hits.
  { concurrency: 2, spacingMs: 300, label: 'fundamentals' }
);

console.log(`fundamentals done: ${ok} ok, ${fail} fetch-failed, ${noFacts} no us-gaap of ${companies.length}`);

// ---- last resort: read the filing itself ----
// A filing can be weeks old and still be absent from BOTH companyfacts and
// frames (Duke filed Q2 2026 on 2026-08-04; neither API carried a single fact
// from it in September). The numbers do exist in the filing's own XBRL
// instance, so for the stragglers we fetch that and merge it in. Instances are
// small (Abbott's was 0.1 MB) and only a handful of companies ever need this.
const DEEP_TAGS = new Set(FRAME_CONCEPTS.map(([t]) => t));

function parseInstance(xml) {
  // contexts without a <segment> are the consolidated ones we want
  const ctx = new Map();
  const ctxRe = /<(?:\w+:)?context[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g;
  for (let m; (m = ctxRe.exec(xml));) {
    const [, id, inner] = m;
    if (/<(?:\w+:)?segment[\s>]/.test(inner)) continue; // dimensional breakdown, not the total
    const sd = /<(?:\w+:)?startDate>([\d-]+)</.exec(inner);
    const ed = /<(?:\w+:)?endDate>([\d-]+)</.exec(inner);
    if (sd && ed) ctx.set(id, { start: sd[1], end: ed[1] });
  }
  const out = new Map(); // tag -> [{start, end, val}]
  const factRe = /<us-gaap:([A-Za-z0-9]+)\s+[^>]*contextRef="([^"]+)"[^>]*>([-\d.]+)<\/us-gaap:[A-Za-z0-9]+>/g;
  for (let m; (m = factRe.exec(xml));) {
    const [, tag, ref, raw] = m;
    if (!DEEP_TAGS.has(tag)) continue;
    const period = ctx.get(ref);
    const val = Number(raw);
    if (!period || !isFinite(val)) continue;
    const rows = out.get(tag) || [];
    rows.push({ ...period, val });
    out.set(tag, rows);
  }
  return out;
}

async function deepBackfill() {
  const cutoff = Date.now() - 100 * 86400000; // a quarter's data should not be this old
  const behind = [];
  for (const co of companies) {
    try {
      const d = await readJSON(`data/fundamentals/${co.t.replace(/\./g, '-')}.json`);
      const last = (d.quarterly?.revenue || []).at(-1)?.end;
      if (!last || Date.parse(last) < cutoff) behind.push(co);
    } catch { /* nothing written for this one */ }
  }
  if (!behind.length) return console.log('deep backfill: nothing behind');
  let filled = 0;
  await pool(behind, async (co) => {
    const sub = await fetchJSON(`https://data.sec.gov/submissions/CIK${co.cik}.json`);
    if (!sub.ok) return;
    const r = sub.data.filings.recent;
    // Read the two most recent periodic filings: the newest alone can be a 10-K,
    // which carries the full year but no separate fourth quarter (Cardinal
    // Health), so the preceding 10-Q is what closes the gap.
    const idxs = r.form.map((f, i) => (f === '10-Q' || f === '10-K' ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    if (!idxs.length) return;
    const cikNum = parseInt(co.cik, 10);
    let got = 0;
    for (const i of idxs) {
      const acc = r.accessionNumber[i].replace(/-/g, '');
      const stem = (r.primaryDocument[i] || '').replace(/\.htm$/, '');
      if (!stem) continue;
      const xml = await fetchText(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${stem}_htm.xml`);
      if (!xml.ok) continue;
      const facts = parseInstance(xml.text);
      if (!facts.size) continue;
      for (const [tag, rows] of facts) {
        let m = FRAMES.get(tag);
        if (!m) FRAMES.set(tag, (m = new Map()));
        m.set(cikNum, [...(m.get(cikNum) || []), ...rows]);
      }
      got++;
    }
    if (!got) return;
    await buildCompany(co); // rebuild with the filings' facts merged in
    filled++;
  }, { concurrency: 2, spacingMs: 300, label: 'deep' });
  console.log(`deep backfill: ${filled}/${behind.length} rebuilt from filings`);
}

await deepBackfill();

if (ok < companies.length * 0.7) process.exit(1);
