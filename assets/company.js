/* Company report page: live header, price chart, key metrics, fundamentals charts. */
(async function () {
  PS.burger();
  PS.attachSearch(document.getElementById('search'), document.getElementById('searchResults'));

  const params = new URLSearchParams(location.search);
  const t = (params.get('t') || 'AAPL').toUpperCase();

  // Multi-class share structures where per-class SEC share counts don't sum to
  // an economically meaningful total - per-share/cap metrics are suppressed.
  const MULTI_CLASS_UNRELIABLE = new Set(['BRK.B']);

  let f, h, q;
  try {
    [f, h, q] = await Promise.all([PS.fundamentals(t), PS.history(t), PS.quotes()]);
  } catch (e) {
    document.getElementById('loadErr').textContent = `Couldn't load data for "${t}". Check the ticker, or head back to the terminal.`;
    return;
  }
  document.getElementById('loading').style.display = 'none';
  document.getElementById('report').style.display = 'block';

  const quote = q.quotes[PS.qKey(t)] || {};
  const price = quote.p ?? h.daily.c.at(-1);
  document.title = `${t} · ${h.name} · Plainsight`;

  // ---- header ----
  document.getElementById('rSym').textContent = t;
  document.getElementById('rName').textContent = h.name;
  const uni = await PS.universe();
  const meta = uni.companies.find((c) => c.t === t);
  const badges = [];
  if (meta) badges.push(meta.s, meta.si);
  if (h.exchange) badges.push(h.exchange);
  if (f.profile?.city) badges.push(`${f.profile.city.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase())}, ${f.profile.state || ''}`);
  document.getElementById('rBadges').innerHTML = badges.map((b) => `<span class="badge-pill">${b}</span>`).join('');
  document.getElementById('rPrice').textContent = price != null ? `$${PS.fmtPrice(price)}` : '-';
  document.getElementById('rChange').innerHTML = PS.changeChip(quote.c, quote.cp);
  document.getElementById('navStamp').textContent = `Updated ${PS.fmtUpdated(q.updated)}${PS.marketNote()}`;
  if (quote.h52 != null && quote.l52 != null && quote.h52 > quote.l52 && price != null) {
    const pos = ((price - quote.l52) / (quote.h52 - quote.l52)) * 100;
    document.querySelector('#r52track .fill').style.left = `calc(${Math.max(0, Math.min(100, pos)).toFixed(1)}% - 6px)`;
    document.getElementById('r52lo').textContent = `$${PS.fmtPrice(quote.l52)}`;
    document.getElementById('r52hi').textContent = `$${PS.fmtPrice(quote.h52)}`;
  }

  // ---- price chart with range tabs ----
  const yy = (d) => " '" + String(d.getFullYear()).slice(2);
  const fmtD = (ts) => { const d = new Date(ts * 1000); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + yy(d); };
  const fmtM = (ts) => { const d = new Date(ts * 1000); return d.toLocaleDateString('en-US', { month: 'short' }) + yy(d); };
  // Intraday (1D/5D) lives on the force-pushed data-intraday branch, fetched
  // lazily via raw.githubusercontent.com (CORS-enabled) only when a tab needs it.
  const INTRADAY_BASE = 'https://raw.githubusercontent.com/joshuakeum9-cell/plainsight/data-intraday/';
  const intradayCache = {};
  const intraday = (file) => (intradayCache[file] ??= fetch(INTRADAY_BASE + file).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }));
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const fmtDayTime = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }) + ' ' + fmtTime(ts);
  async function renderIntraday(range) {
    const box = document.getElementById('priceChart');
    box.textContent = 'Loading…';
    let data;
    try { data = await intraday(range === '1D' ? 'intraday-1d.json' : 'intraday-5d.json'); }
    catch { box.textContent = 'Intraday data unavailable right now.'; return; }
    const s = data.series[PS.qKey(t)];
    if (!s || s.c.length < 2) { box.textContent = 'No intraday data for this company yet.'; return; }
    const up = range === '1D' && s.pc != null ? s.c.at(-1) >= s.pc : s.c.at(-1) >= s.c[0];
    PSCharts.lineChart(box, {
      labels: s.t.map(range === '1D' ? fmtTime : fmtDayTime),
      series: [{ name: 'Price', color: up ? 'var(--chart-1)' : 'var(--down)', values: s.c }],
      fmt: (v, tick) => tick ? '$' + PS.fmtNum(v, true) : '$' + PS.fmtPrice(v),
      height: 300, area: true, table: false,
    });
  }
  function renderPrice(range) {
    if (range === '1D' || range === '5D') return renderIntraday(range);
    let src, labels, values;
    const days = { '1M': 22, '3M': 64, '6M': 128, '1Y': Infinity }[range];
    if (days) {
      src = h.daily;
      const n = Math.min(src.t.length, days === Infinity ? src.t.length : days);
      labels = src.t.slice(-n).map(fmtD);
      values = src.c.slice(-n);
    } else {
      src = h.monthly;
      const n = range === '5Y' ? 60 : src.t.length;
      labels = src.t.slice(-n).map(fmtM);
      values = src.c.slice(-n);
    }
    const up = values.at(-1) >= values[0];
    PSCharts.lineChart(document.getElementById('priceChart'), {
      labels, series: [{ name: 'Close', color: up ? 'var(--chart-1)' : 'var(--down)', values }],
      fmt: (v, tick) => tick ? '$' + PS.fmtNum(v, true) : '$' + PS.fmtPrice(v),
      height: 300, area: true, table: false,
    });
  }
  document.getElementById('rangeTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#rangeTabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    renderPrice(b.dataset.r);
  });
  renderPrice('1Y');

  // ---- key metrics ----
  const s = f.summary || {};
  const unreliable = MULTI_CLASS_UNRELIABLE.has(t) || !s.sharesOut;
  const cap = !unreliable && price != null ? price * s.sharesOut : null;
  const gate = (v, lo, hi) => (v != null && isFinite(v) && v > lo && v < hi ? v : null);
  const pe = gate(s.epsTTM > 0 && price != null ? price / s.epsTTM : null, 0, 400);
  const ps = gate(cap != null && s.revTTM ? cap / s.revTTM : null, 0, 200);
  const pb = gate(cap != null && s.equity > 0 ? cap / s.equity : null, 0, 150);
  const fcfY = gate(cap != null && s.fcfTTM != null ? (s.fcfTTM / cap) * 100 : null, -60, 60);
  const divY = gate(s.divPS != null && price ? (s.divPS / price) * 100 : null, 0, 25);
  const x = (v) => (v == null ? '-' : v.toFixed(1) + '×');
  const tiles = [
    ['Market cap', cap != null ? PS.fmtMoney(cap) : 'n/a', unreliable && MULTI_CLASS_UNRELIABLE.has(t) ? 'multi-class' : ''],
    ['P/E (TTM)', x(pe), pe == null ? 'not meaningful' : ''],
    ['P/S (TTM)', x(ps), ''],
    ['P/B', x(pb), ''],
    ['EPS (TTM)', s.epsTTM != null && !unreliable ? PS.fmtEps(s.epsTTM) : '-', 'diluted'],
    ['Revenue (TTM)', PS.fmtMoney(s.revTTM), ''],
    ['Net margin', PS.fmtPct(s.netMarginTTM), 'TTM'],
    ['ROE', PS.fmtPct(s.roeTTM), 'TTM'],
    ['FCF yield', fcfY != null ? fcfY.toFixed(1) + '%' : '-', 'TTM'],
    ['Dividend yield', divY != null ? divY.toFixed(2) + '%' : '-', s.divPS ? `$${s.divPS.toFixed(2)}/sh` : 'no dividend'],
    ['Cash', PS.fmtMoney(s.cash), 'latest quarter'],
    ['LT debt', PS.fmtMoney(s.ltDebt), 'latest quarter'],
  ];
  document.getElementById('stats').innerHTML = tiles.map(([lab, val, sub]) =>
    `<div class="stat-tile"><div class="lab">${lab}</div><div class="val">${val}</div>${sub ? `<div class="sub" style="color:var(--muted)">${sub}</div>` : ''}</div>`).join('');

  document.getElementById('fStamp').textContent = `updated ${PS.fmtUpdated(f.updated)}`;

  // ---- fundamentals: one chart per metric, quarterly or annual ----
  const A = f.annual, Q = f.quarterly || {}, BQ = f.balancesQ || {};
  const seg = await PS.segments(t);
  const grid = document.getElementById('fundCharts');
  const card = (title, sub, wide) => {
    const div = document.createElement('div');
    div.className = 'chart-card' + (wide ? ' wide' : '');
    div.innerHTML = `<h3>${title}</h3>${sub ? `<p class="chart-sub">${sub}</p>` : ''}<div class="chart-box"></div>`;
    grid.appendChild(div);
    return div.querySelector('.chart-box');
  };
  const align = (series, base) => base.map((b) => series.find((r) => r.end === b.end)?.v ?? null);
  const some = (vals) => vals.some((v) => v != null);

  // Per-share figures sit on mixed bases: a 10-K restates only its two
  // comparative years, so anything older keeps the pre-split numbers (Apple's
  // FY2017 EPS still reads $9.21 next to a post-split $2.98 for FY2018, which
  // charts as a 68% collapse that never happened). The diluted-share series
  // shows where the basis changes; Yahoo's split events supply the exact ratio,
  // so a share count that jumps for any other reason (a merger, a big issuance)
  // is left alone. Returns the cumulative factor to apply at each index.
  function splitFactors(ends, sharesByEnd) {
    const out = new Array(ends.length).fill(1);
    const splits = h.splits || [];
    if (!splits.length) return out;
    let factor = 1;
    for (let i = ends.length - 1; i >= 1; i--) {
      const cur = sharesByEnd.get(ends[i]), prev = sharesByEnd.get(ends[i - 1]);
      if (cur && prev) {
        const jump = cur / prev;
        if (jump > 1.35 || jump < 0.75) {
          const fwd = splits.find((sp) => Math.abs(sp.r - jump) / sp.r < 0.15);
          const rev = splits.find((sp) => Math.abs(1 / sp.r - jump) * sp.r < 0.15);
          if (fwd) factor *= fwd.r;
          else if (rev) factor /= rev.r;
        }
      }
      out[i - 1] = factor;
    }
    return out;
  }
  const sharesByEnd = new Map((f.dilutedShares || []).map((r) => [r.end, r.v]));
  const shareEnds = (f.dilutedShares || []).map((r) => r.end);
  const shareFactors = splitFactors(shareEnds, sharesByEnd);
  // A quarter takes the factor of the fiscal year it falls in.
  const factorAt = (end) => { const i = shareEnds.findIndex((e) => e >= end); return i < 0 ? 1 : shareFactors[i]; };
  const newerThan = (end, base) => end && base && Date.parse(end) - Date.parse(base) > 45 * 86400000;
  const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)',
    'var(--brand-peach)', 'var(--brand-lavender)', 'var(--brand-coral)', 'var(--brand-ochre)'];
  const AXIS_NAME = { 'srt:ProductOrServiceAxis': 'by product and service', 'us-gaap:StatementBusinessSegmentsAxis': 'by business segment', 'srt:StatementGeographicalAxis': 'by geography' };

  function render(period) {
    grid.innerHTML = '';
    const isQ = period === 'Q';
    const src = isQ ? Q : A;
    const base = (src.revenue || []).slice(isQ ? -44 : -10);
    if (base.length < 2) { grid.innerHTML = '<p class="body-md" style="color:var(--muted)">Not enough filed history for this view.</p>'; return; }
    const labelOf = (r) => (isQ ? PS.qLabel(r.end) : PS.fyLabel(r.end));
    const labels = base.map(labelOf);
    const flags = base.map((r) => (r.d ? '(derived)' : ''));
    const lag = isQ ? 4 : 1;
    const growthNote = isQ ? '% vs. the same quarter a year ago' : '% vs. prior year';
    // A fiscal year can be up to ~12 months stale (Apple's FY2026 does not close
    // until late September), so the annual view appends a trailing-twelve-month
    // bar. Skipped when the newest quarter IS the fiscal year end, where it
    // would only duplicate the final bar, and never drawn in the quarterly view.
    const lastQEnd = (Q.revenue || []).at(-1)?.end, lastFYEnd = base.at(-1)?.end;
    const ttmOn = !isQ && newerThan(lastQEnd, lastFYEnd);
    const ttmNote = ttmOn ? `TTM = 12 months to ${PS.qLabel(lastQEnd)}` : '';
    const H = 250;

    const bar = (title, sub, values, color, o = {}) => {
      if (!some(values)) return;
      const useTTM = ttmOn && o.ttm != null;
      PSCharts.barChart(card(title, sub + (useTTM ? ' · final bar is trailing 12 months' : '')), {
        labels: useTTM ? [...labels, 'TTM'] : labels,
        series: [{ name: title, color, values: useTTM ? [...values, o.ttm] : values }],
        fmt: o.fmt || PS.fmtMoney, negativeColor: 'var(--down)', growthLag: o.growth === false ? 0 : lag,
        flags, height: H,
        lastBarColor: useTTM ? 'var(--chart-5)' : undefined, lastBarNote: useTTM ? ttmNote : undefined,
      });
    };
    const grouped = (title, sub, series, o = {}) => {
      const live = series.filter((sr) => some(sr.values));
      if (!live.length) return;
      PSCharts.barChart(card(title, sub), { labels: o.labels || labels, series: live, fmt: PS.fmtMoney, height: H, stacked: !!o.stacked, flags: o.flags || flags });
    };

    // 1. revenue
    const rev = base.map((r) => r.v);
    bar('Revenue', 'total revenue · ' + growthNote, rev, 'var(--chart-1)', { ttm: s.revTTM });

    // 2. revenue by segment, straight from the filings' XBRL
    // Same timeline as the Revenue chart, period for period; a quarter the
    // filings have not broken down yet is simply an empty slot.
    const segByEnd = new Map(((seg && seg.members?.length >= 2 ? (isQ ? seg.quarterly : seg.annual) : null) || []).map((r) => [r.end, r]));
    if (segByEnd.size >= (isQ ? 4 : 2)) {
      grouped('Revenue by segment', `${AXIS_NAME[seg.axis] || 'as reported'} · from the 10-K${isQ ? ' and 10-Qs' : ''}`,
        seg.members.map((m, i) => ({ name: m.label, color: PALETTE[i % PALETTE.length], values: base.map((b) => segByEnd.get(b.end)?.values[m.id] ?? null) })),
        { stacked: true, flags: base.map((b) => (segByEnd.get(b.end)?.d ? '(derived)' : '')) });
    }

    // 3. profitability
    const gp = align(src.grossProfit || [], base);
    bar('Gross profit', 'revenue minus cost of revenue · ' + growthNote, gp, 'var(--chart-2)');
    const op = align(src.opIncome || [], base);
    bar('Operating income', 'profit from operations, before interest and tax · ' + growthNote, op, 'var(--chart-4)');
    const da = align(src.da || [], base);
    const ebitda = base.map((_, i) => (op[i] != null && da[i] != null ? op[i] + da[i] : null));
    if (ebitda.filter((v) => v != null).length >= base.length / 2) bar('EBITDA', 'operating income plus depreciation and amortization · ' + growthNote, ebitda, 'var(--chart-2)');
    const ni = align(src.netIncome || [], base);
    bar('Net income', 'profit after all expenses and tax · ' + growthNote, ni, 'var(--chart-2)', { ttm: s.niTTM });
    const pct = (num) => base.map((r, i) => (num[i] != null && r.v ? (num[i] / r.v) * 100 : null));
    const margins = [
      { name: 'Gross', color: 'var(--chart-1)', values: pct(gp) },
      { name: 'Operating', color: 'var(--chart-2)', values: pct(op) },
      { name: 'Net', color: 'var(--chart-3)', values: pct(ni) },
    ].filter((sr) => some(sr.values));
    if (margins.length) PSCharts.lineChart(card('Margins', 'gross, operating and net profit as % of revenue'), { labels, series: margins, fmt: (v) => PS.fmtPct(v), fillGaps: true, height: H });

    // 4. per share
    if (!unreliable) {
      const eps = align(src.eps || [], base).map((v, i) => (v == null ? null : v / factorAt(base[i].end)));
      bar('EPS (diluted)', 'earnings per share, split-adjusted · ' + growthNote, eps, 'var(--chart-4)', { ttm: s.epsTTM, fmt: (v) => '$' + (v == null ? '-' : v.toFixed(2)) });
    }
    const dps = align(src.divPS || [], base).map((v, i) => (v == null ? null : v / factorAt(base[i].end)));
    bar('Dividends per share', 'declared per share, split-adjusted', dps, 'var(--chart-3)', { growth: false, fmt: (v) => '$' + (v == null ? '-' : v.toFixed(2)) });

    // 5. cash flow
    const ocf = align(src.ocf || [], base), capex = align(src.capex || [], base);
    bar('Cash from operations', 'net cash generated by the business · ' + growthNote, ocf, 'var(--chart-1)', { ttm: s.ocfTTM });
    bar('Capital expenditure', 'cash spent on property, plant and equipment', capex.map((v) => (v == null ? null : -v)), 'var(--chart-2)', { growth: false, ttm: s.capexTTM != null ? -s.capexTTM : null });
    const fcf = base.map((_, i) => (ocf[i] != null && capex[i] != null ? ocf[i] - capex[i] : null));
    bar('Free cash flow', 'cash from operations minus capital expenditure · ' + growthNote, fcf, 'var(--chart-4)', { ttm: s.fcfTTM });

    // 6. balance sheet at each period end
    const B = isQ ? BQ : f.balances;
    const cash = align(B.cash || [], base);
    const debt = base.map((r, i) => {
      const lt = (B.ltDebt || []).find((x) => x.end === r.end)?.v, cur = (B.debtCurrent || []).find((x) => x.end === r.end)?.v;
      return lt == null && cur == null ? null : (lt || 0) + (cur || 0);
    });
    grouped('Cash and debt', 'cash and equivalents against total borrowings', [
      { name: 'Cash', color: 'var(--chart-1)', values: cash },
      { name: 'Debt', color: 'var(--chart-2)', values: debt },
    ]);
    const bl = isQ ? base : (B.assets || []).slice(-10);
    const lb = f.latestBalance;
    const bsNow = !isQ && lb && newerThan(lb.end, bl.at(-1)?.end) && lb.assets != null;
    const bsLabels = bl.map(labelOf).concat(bsNow ? [PS.qLabel(lb.end)] : []);
    grouped('Balance sheet', 'assets vs. liabilities vs. equity' + (bsNow ? ` · final column is the latest quarter (${PS.qLabel(lb.end)})` : ''), [
      { name: 'Assets', color: 'var(--chart-1)', values: align(B.assets || [], bl).concat(bsNow ? [lb.assets] : []) },
      { name: 'Liabilities', color: 'var(--chart-2)', values: align(B.liabilities || [], bl).concat(bsNow ? [lb.liabilities] : []) },
      { name: 'Equity', color: 'var(--chart-4)', values: align(B.equity || [], bl).concat(bsNow ? [lb.equity] : []) },
    ], { labels: bsLabels, flags: bsLabels.map(() => '') });

    // 7. shareholders
    const bb = align(src.buybacks || [], base), dv = align(src.dividendsPaid || [], base);
    if (some(bb) || some(dv)) {
      const crTTM = ttmOn && (s.buybacksTTM != null || s.dividendsTTM != null);
      grouped('Capital returned', 'cash spent on buybacks and dividends' + (crTTM ? ' · final bar is trailing 12 months' : ''), [
        { name: 'Buybacks', color: 'var(--chart-1)', values: crTTM ? [...bb, s.buybacksTTM] : bb },
        { name: 'Dividends', color: 'var(--chart-3)', values: crTTM ? [...dv, s.dividendsTTM] : dv },
      ], { stacked: true, labels: crTTM ? [...labels, 'TTM'] : labels });
    }
    if (f.dilutedShares?.length >= 3) {
      const sh = f.dilutedShares.slice(-10);
      const sf = splitFactors(sh.map((r) => r.end), sharesByEnd);
      const ls = f.latestShares;
      const shNow = ls && newerThan(ls.end, sh.at(-1).end) && ls.v != null;
      const shVals = sh.map((r, i) => (r.v == null ? null : r.v * sf[i]));
      PSCharts.lineChart(card('Shares outstanding', 'diluted weighted average by fiscal year, split-adjusted; falling means buybacks are shrinking the float' + (shNow ? ` · to ${PS.qLabel(ls.end)}` : '')), {
        labels: shNow ? [...sh.map((r) => PS.fyLabel(r.end)), PS.qLabel(ls.end)] : sh.map((r) => PS.fyLabel(r.end)),
        series: [{ name: 'Shares', color: 'var(--chart-1)', values: shNow ? [...shVals, ls.v] : shVals }],
        fmt: (v, tick) => PS.fmtNum(v, tick), height: H,
      });
    }

    // 8. operating expenses
    grouped('Operating expenses', 'research and development, and selling, general and administrative', [
      { name: 'R&D', color: 'var(--chart-4)', values: align(src.rnd || [], base) },
      { name: 'SG&A', color: 'var(--chart-2)', values: align(src.sga || [], base) },
    ], { stacked: true });
  }

  const tabs = document.getElementById('periodTabs');
  const remember = (p) => { try { localStorage.setItem('ps-period', p); } catch { /* private mode */ } };
  let period = 'Q';
  try { period = localStorage.getItem('ps-period') || 'Q'; } catch { /* private mode */ }
  const setPeriod = (p) => {
    period = p; remember(p);
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.p === p));
    render(p);
  };
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setPeriod(b.dataset.p); });
  setPeriod(period);
  // Charts are drawn at their card's width, so redraw when that changes.
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(period), 200); });

  // ---- profile ----
  const p = f.profile || {};
  const fye = p.fye ? `${p.fye.slice(0, 2)}/${p.fye.slice(2)}` : null;
  const rows = [
    ['Industry (SIC)', p.sic],
    ['Sector', meta?.s],
    ['Headquarters', meta?.hq || (p.city ? `${p.city}, ${p.state}` : null)],
    ['Fiscal year end', fye],
    ['Exchange', p.exchange || h.exchange],
    ['CIK', f.cik ? `<a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${f.cik}&type=10-K&dateb=&owner=include&count=40" target="_blank" rel="noopener">${f.cik} · view filings ↗</a>` : null],
    ['Shares outstanding', s.sharesOut && !MULTI_CLASS_UNRELIABLE.has(t) ? PS.fmtNum(s.sharesOut) : null],
    ['Data sources', 'SEC EDGAR + Yahoo Finance'],
  ].filter(([, v]) => v);
  document.getElementById('profile').innerHTML = rows.map(([lab, val]) =>
    `<div><div class="caption-upper">${lab}</div><div class="body-md" style="color:var(--ink);margin-top:4px">${val}</div></div>`).join('');
})();
