// Revenue by segment, read from the filings' own XBRL.
// Both SEC APIs (companyfacts, frames) drop every dimensional fact, so the only
// place a company's revenue split by product, business segment or geography
// exists is inside the 10-K / 10-Q instance documents. A 10-K carries three
// fiscal years of it; each 10-Q carries its quarter and the same quarter a year
// earlier. Output: data/segments/<TICKER>.json
//
// Cached by accession number: a company is only re-read when it has filed
// something new, so after the first pass a nightly run touches a handful.
import { fetchJSON, fetchText, pool, writeJSON, readJSON, round, sleep } from './lib.mjs';
import { existsSync } from 'node:fs';

const universe = await readJSON('data/universe.json');
let companies = universe.companies.filter((c) => c.cik);
if (process.env.ONLY) companies = companies.filter((c) => process.env.ONLY.split(',').includes(c.t));
if (process.env.LIMIT) companies = companies.slice(0, +process.env.LIMIT);

const REVENUE_TAGS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
  'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense', 'RegulatedAndUnregulatedOperatingRevenue'];
// Preference order when a filer breaks revenue down several ways.
const AXES = ['srt:ProductOrServiceAxis', 'us-gaap:StatementBusinessSegmentsAxis', 'srt:StatementGeographicalAxis'];
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const fileSym = (t) => t.replace(/\./g, '-');

// ---- instance parsing ----
function parseContexts(xml) {
  const ctx = new Map();
  const re = /<(?:\w+:)?context[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g;
  for (let m; (m = re.exec(xml));) {
    const inner = m[2];
    const sd = /<(?:\w+:)?startDate>([\d-]+)</.exec(inner), ed = /<(?:\w+:)?endDate>([\d-]+)</.exec(inner);
    if (!sd || !ed) continue;
    const dims = [...inner.matchAll(/dimension="([^"]+)"[^>]*>([^<]+)</g)].map((d) => [d[1], d[2].trim()]);
    // Two axes are wrappers rather than breakdowns: ConsolidationItems ("operating
    // segments" vs eliminations/corporate) and MajorCustomers ("external" vs
    // "intersegment"). UnitedHealth books $168B of intersegment revenue; only
    // the external view reconciles to the income statement.
    const WRAP = { 'srt:ConsolidationItemsAxis': /OperatingSegmentsMember/, 'us-gaap:MajorCustomersAxis': /ExternalCustomer/ };
    let skip = false, ext = false;
    for (const [axis, member] of dims) {
      if (!WRAP[axis]) continue;
      if (!WRAP[axis].test(member)) skip = true;
      if (axis === 'us-gaap:MajorCustomersAxis') ext = true;
    }
    if (skip) continue;
    const real = dims.filter(([axis]) => !WRAP[axis]);
    if (real.length > 1) continue; // two-way splits (segment x geography) are not a single breakdown
    ctx.set(m[1], { start: sd[1], end: ed[1], axis: real[0]?.[0] || null, member: real[0]?.[1] || null, ext });
  }
  return ctx;
}

function parseFacts(xml, ctx) {
  // tag -> [{start, end, axis, member, val}]
  const out = new Map();
  const re = /<us-gaap:([A-Za-z0-9]+)\s+[^>]*contextRef="([^"]+)"[^>]*>([-\d.]+)<\/us-gaap:[A-Za-z0-9]+>/g;
  for (let m; (m = re.exec(xml));) {
    if (!REVENUE_TAGS.includes(m[1])) continue;
    const c = ctx.get(m[2]);
    const val = Number(m[3]);
    if (!c || !isFinite(val)) continue;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push({ ...c, val });
  }
  return out;
}

// Member labels from the label linkbase: "aapl:WearablesHomeandAccessoriesMember" -> "Wearables, Home and Accessories".
function parseLabels(xml) {
  // Attribute order varies between filers, so read each tag's attributes
  // individually rather than in sequence.
  const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  const locs = new Map(); // xlink:label -> concept id
  for (const m of xml.matchAll(/<(?:link:)?loc\b[^>]*>/g)) {
    const href = attr(m[0], 'xlink:href'), label = attr(m[0], 'xlink:label');
    if (href && label && href.includes('#')) locs.set(label, href.split('#').pop());
  }
  const arcs = new Map(); // to -> from
  for (const m of xml.matchAll(/<(?:link:)?labelArc\b[^>]*>/g)) {
    const from = attr(m[0], 'xlink:from'), to = attr(m[0], 'xlink:to');
    if (from && to) arcs.set(to, from);
  }
  const byRole = new Map(); // concept id -> {role: text}
  for (const m of xml.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)<\/(?:link:)?label>/g)) {
    const lab = attr(m[1], 'xlink:label'), role = (attr(m[1], 'xlink:role') || '').split('/').pop();
    if (!lab) continue;
    // Arc chain when present; otherwise the near-universal lab_<concept> convention.
    const concept = locs.get(arcs.get(lab)) || (lab.startsWith('lab_') ? lab.slice(4) : null);
    if (!concept) continue;
    if (!byRole.has(concept)) byRole.set(concept, {});
    byRole.get(concept)[role] = m[2].trim();
  }
  const labels = new Map();
  for (const [concept, roles] of byRole) {
    const text = roles.label || roles.terseLabel || roles.verboseLabel || Object.values(roles)[0];
    if (text) labels.set(concept, cleanLabel(text));
  }
  return labels;
}
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// "North America Segment [Member]" -> "North America"; "UNITED STATES" -> "United States"
function cleanLabel(text) {
  let s = decode(text).replace(/\s*\[Member\]\s*$/i, '').replace(/\s+segments?$/i, '').trim();
  if (s.length > 3 && s === s.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
const humanize = (member) => {
  const [ns, local] = member.split(':');
  if (ns === 'country') { try { return regionName.of(local); } catch { return local; } }
  const bare = local.replace(/Member$/, '');
  if (/^NonUs$/i.test(bare)) return 'Outside the US';
  if (/^(US|UnitedStates)$/i.test(bare)) return 'United States';
  return bare.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\band\b/gi, 'and').trim();
};

// ---- choosing the breakdown ----
// Members whose value equals the sum of some other members are subtotals
// (Apple tags "Product" alongside iPhone, Mac, iPad and Wearables); drop them.
function dropSubtotals(entries) {
  const vals = entries.map((e) => e.val);
  const keep = [];
  for (let i = 0; i < entries.length; i++) {
    const others = vals.filter((_, j) => j !== i).filter((v) => v > 0 && v < vals[i]);
    let isSubtotal = false;
    if (others.length >= 2 && others.length <= 16) {
      const n = others.length;
      for (let mask = 3; mask < (1 << n) && !isSubtotal; mask++) {
        if ((mask & (mask - 1)) === 0) continue; // single member
        let sum = 0;
        for (let b = 0; b < n; b++) if (mask & (1 << b)) sum += others[b];
        // Filed subtotals reconcile to the rounding of the statement, so demand a
        // near-exact match: at 2% Apple's iPhone was "explained" by the coincidence
        // that Services + Mac + iPad + Wearables came within 1.4% of it.
        if (Math.abs(sum - vals[i]) <= Math.abs(vals[i]) * 0.003) isSubtotal = true;
      }
    }
    if (!isSubtotal) keep.push(entries[i]);
  }
  return keep;
}

// The external-customers view of a member beats the plain one (it excludes
// intersegment sales); otherwise the later occurrence wins, which favours the
// most recent filing's restatement.
function oneRowPerMember(rows) {
  const byMember = new Map();
  for (const r of rows) {
    const prev = byMember.get(r.member);
    if (!prev || r.ext || !prev.ext) byMember.set(r.member, r);
  }
  return [...byMember.values()];
}

function chooseBreakdown(facts) {
  // total revenue per period (undimensioned), any tag
  const totals = new Map();
  for (const rows of facts.values()) for (const r of rows) if (!r.axis) totals.set(r.start + '|' + r.end, r.val);
  let best = null;
  for (const [tag, rows] of facts) {
    for (const axis of AXES) {
      // Judge each axis on its newest full fiscal year; the 10-Qs contribute
      // later quarter-length rows that must not pass for "the latest period".
      const dimmed = rows.filter((r) => r.axis === axis && days(r.start, r.end) > 320);
      if (!dimmed.length) continue;
      const latest = dimmed.map((r) => r.end).sort().at(-1);
      const latestRows = dimmed.filter((r) => r.end === latest);
      const period = latestRows.find(Boolean);
      if (!period) continue;
      // One row per member (the same fact recurs across statements), then drop
      // members that are aliases of another (identical value: "Service" and
      // "Services") so neither inflates the count or the coverage.
      const seen = [];
      const distinct = oneRowPerMember(latestRows.filter((r) => r.start === period.start)).filter((r) => {
        if (seen.some((v) => Math.abs(v - r.val) <= Math.abs(r.val) * 0.001)) return false;
        seen.push(r.val); return true;
      });
      const members = dropSubtotals(distinct);
      if (members.length < 2) continue;
      const total = totals.get(period.start + '|' + period.end);
      const coverage = total ? members.reduce((s, r) => s + r.val, 0) / total : null;
      if (coverage != null && (coverage < 0.7 || coverage > 1.15)) continue;
      // A split the company also reports quarterly is worth more than one that
      // only appears in the 10-K (Amazon: NA / International / AWS every quarter,
      // country geography once a year).
      const hasQuarters = rows.some((r) => r.axis === axis && (() => { const d = days(r.start, r.end); return d > 75 && d < 125; })());
      // A split made of the taxonomy's own generic members (Product / Service)
      // says little; a company-named split (Semiconductor Solutions /
      // Infrastructure Software) is what a reader wants when both exist.
      const generic = members.filter((r) => /^us-gaap:(Product|Service|ServiceOther|ProductAndService)Member$/.test(r.member)).length;
      const score = members.length + (coverage != null ? 5 : 0) + (hasQuarters ? 3 : 0) - AXES.indexOf(axis) - (generic * 2 >= members.length ? 2 : 0);
      if (!best || score > best.score) best = { tag, axis, score, memberIds: members.map((r) => r.member), coverage };
    }
  }
  return best;
}

function seriesFor(facts, choice, filter) {
  const rows = facts.get(choice.tag).filter((r) => r.axis === choice.axis && choice.memberIds.includes(r.member) && filter(r));
  const byEnd = new Map();
  for (const r of rows) {
    if (!byEnd.has(r.end)) byEnd.set(r.end, []);
    byEnd.get(r.end).push(r);
  }
  return [...byEnd.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([end, list]) => ({ end, values: Object.fromEntries(oneRowPerMember(list).map((r) => [r.member, r.val])) }));
}

// ---- per company ----
// The submissions JSON lists only the newest ~1,000 filings inline; a company
// that files a lot (Microsoft: 8-Ks, Form 4s, ...) keeps its ten-year-old
// 10-Qs in paginated overflow files, which are fetched and appended here.
const COLS = ['form', 'reportDate', 'filingDate', 'accessionNumber', 'primaryDocument'];
async function allFilings(data) {
  const r = Object.fromEntries(COLS.map((k) => [k, [...(data.filings.recent[k] || [])]]));
  for (const f of data.filings.files || []) {
    const page = await fetchJSON(`https://data.sec.gov/submissions/${f.name}`);
    await sleep(200);
    if (!page.ok) continue;
    for (const k of COLS) r[k].push(...(page.data[k] || []));
  }
  return r;
}

// Same holdco rule as refresh-fundamentals: ExxonMobil Holdings has no 10-K yet,
// the operating company under the old CIK has decades of them.
const PREDECESSOR_CIK = { XOM: '0000034088' };

async function refresh(co) {
  const path = `data/segments/${fileSym(co.t)}.json`;
  let cik = co.cik;
  let sub = await fetchJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!sub.ok) return 'nosub';
  if (!sub.data.filings.recent.form.includes('10-K') && PREDECESSOR_CIK[co.t]) {
    cik = PREDECESSOR_CIK[co.t];
    sub = await fetchJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
    if (!sub.ok) return 'nosub';
  }
  const r = await allFilings(sub.data);
  // Ten years, matching the revenue chart, from as few documents as possible: a
  // 10-K carries three fiscal years of segment data, so every third 10-K covers
  // the annual series; a 10-Q carries its quarter and the same quarter a year
  // earlier, so the 10-Qs of every other year cover the quarterly series (the
  // skipped years arrive as comparatives), and Q4s derive from the annual totals.
  const idx = r.form.map((f, i) => i).filter((i) => r.form[i] === '10-K' || r.form[i] === '10-Q');
  const kAll = idx.filter((i) => r.form[i] === '10-K');
  const kIdx = kAll.filter((_, n) => n % 3 === 0).slice(0, 4);
  const qAll = idx.filter((i) => r.form[i] === '10-Q');
  const newestYear = qAll.length ? +r.reportDate[qAll[0]].slice(0, 4) : 0;
  const qIdx = qAll.filter((i) => { const y = +r.reportDate[i].slice(0, 4); return newestYear - y < 11 && (newestYear - y) % 2 === 0; }).slice(0, 18);
  const wanted = [...kIdx, ...qIdx];
  if (!wanted.length) return 'nofilings';
  const accns = wanted.map((i) => r.accessionNumber[i]);
  if (existsSync(path)) {
    try {
      const prev = await readJSON(path);
      if (prev.source?.v === 2 && JSON.stringify(prev.source?.accns) === JSON.stringify(accns)) return 'cached';
    } catch { /* rewrite */ }
  }
  const cikNum = parseInt(cik, 10);
  const facts = new Map();
  let labels = new Map();
  for (const i of wanted) {
    const acc = r.accessionNumber[i].replace(/-/g, '');
    const stem = (r.primaryDocument[i] || '').replace(/\.htm$/, '');
    if (!stem) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${stem}`;
    // Inline-XBRL filings (mid-2019 on) expose the instance as <stem>_htm.xml;
    // older ones ship a plain <stem>.xml. Without the fallback nothing before
    // 2019 was being read, for any company.
    let xml = await fetchText(`${base}_htm.xml`);
    await sleep(250);
    if (!xml.ok && xml.status === 404) { xml = await fetchText(`${base}.xml`); await sleep(250); }
    if (!xml.ok) continue;
    const parsed = parseFacts(xml.text, parseContexts(xml.text));
    for (const [tag, rows] of parsed) facts.set(tag, [...(facts.get(tag) || []), ...rows]);
    if (r.form[i] === '10-K' && i === kIdx[0]) {
      const lab = await fetchText(`${base}_lab.xml`);
      await sleep(250);
      if (lab.ok) labels = parseLabels(lab.text);
    }
  }
  const choice = chooseBreakdown(facts);
  if (!choice) {
    await writeJSON(path, { updated: new Date().toISOString(), symbol: co.t, axis: null, members: [], annual: [], quarterly: [], source: { v: 2, accns } });
    return 'nobreakdown';
  }
  const label = (m) => labels.get(m.replace(':', '_')) || humanize(m);
  const annual = seriesFor(facts, choice, (x) => days(x.start, x.end) > 320);
  const quarters = seriesFor(facts, choice, (x) => { const d = days(x.start, x.end); return d > 75 && d < 125; });
  // Q4 = FY - (Q1+Q2+Q3) per member, where the three are present
  for (const a of annual) {
    if (quarters.some((q) => Math.abs(days(q.end, a.end)) < 20)) continue;
    const inYear = quarters.filter((q) => { const d = days(q.end, a.end); return d > 45 && d < 320; });
    if (inYear.length !== 3) continue;
    const values = {};
    for (const m of choice.memberIds) {
      if (a.values[m] == null || inYear.some((q) => q.values[m] == null)) continue;
      values[m] = a.values[m] - inYear.reduce((s, q) => s + q.values[m], 0);
    }
    if (Object.keys(values).length) quarters.push({ end: a.end, values, d: 1 });
  }
  quarters.sort((a, b) => a.end.localeCompare(b.end));
  const rnd = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v, 0)]));
  await writeJSON(path, {
    updated: new Date().toISOString(),
    symbol: co.t,
    tag: choice.tag,
    axis: choice.axis,
    coverage: choice.coverage != null ? round(choice.coverage, 3) : null,
    members: choice.memberIds.map((id) => ({ id, label: label(id) })),
    annual: annual.map((a) => ({ end: a.end, values: rnd(a.values) })),
    quarterly: quarters.map((q) => ({ end: q.end, values: rnd(q.values), ...(q.d ? { d: 1 } : {}) })),
    source: { v: 2, accns },
  });
  return 'ok';
}

const tally = {};
await pool(companies, async (co) => {
  const res = await refresh(co);
  tally[res] = (tally[res] || 0) + 1;
}, { concurrency: 2, spacingMs: 300, label: 'segments' });
console.log('segments done:', JSON.stringify(tally));
