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

  // ---- annual fundamentals charts ----
  const A = f.annual;
  const grid = document.getElementById('annualCharts');
  const card = (title, sub) => {
    const div = document.createElement('div');
    div.className = 'chart-card';
    div.innerHTML = `<h3>${title}</h3>${sub ? `<p class="chart-sub">${sub}</p>` : ''}<div class="chart-box"></div>`;
    grid.appendChild(div);
    return div.querySelector('.chart-box');
  };
  const align = (series, base) => base.map((b) => series.find((r) => r.end === b.end)?.v ?? null);
  const years = A.revenue.slice(-10);
  const yl = years.map((r) => PS.fyLabel(r.end));

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

  // A fiscal year can be up to ~12 months stale (Apple's FY2026 doesn't close
  // until late September), so append a trailing-twelve-month bar covering the
  // four most recent reported quarters. Skipped when the latest quarter IS the
  // fiscal year end, where TTM would just duplicate the final bar.
  const lastQEnd = (f.quarterly?.revenue || []).at(-1)?.end;
  const lastFYEnd = years.at(-1)?.end;
  const ttmOn = lastQEnd && lastFYEnd && Date.parse(lastQEnd) - Date.parse(lastFYEnd) > 45 * 86400000;
  const ttmNote = ttmOn ? `TTM = 12 months to ${PS.qLabel(lastQEnd)}` : '';
  const withTTM = (labels, values, ttmValue) => (ttmOn && ttmValue != null
    ? { labels: [...labels, 'TTM'], values: [...values, ttmValue], lastBarColor: 'var(--chart-5)', lastBarNote: ttmNote }
    : { labels, values });
  const ttmSub = ttmOn ? ' · final bar is trailing 12 months' : '';
  // Balance sheets and share counts are snapshots, not flows, so "current" for
  // them is the newest quarter end rather than a trailing window.
  const newerThan = (end, base) => end && base && Date.parse(end) - Date.parse(base) > 45 * 86400000;

  if (years.length >= 2) {
    const rev = withTTM(yl, years.map((r) => r.v), s.revTTM);
    PSCharts.barChart(card('Revenue', 'total annual revenue · % is growth vs. prior year' + ttmSub), {
      labels: rev.labels, series: [{ name: 'Revenue', color: 'var(--chart-1)', values: rev.values }],
      fmt: PS.fmtMoney, negativeColor: 'var(--down)', growthLag: 1,
      lastBarColor: rev.lastBarColor, lastBarNote: rev.lastBarNote,
    });
    const ni = withTTM(yl, align(A.netIncome, years), s.niTTM);
    PSCharts.barChart(card('Net income', 'profit after all expenses and tax · % vs. prior year' + ttmSub), {
      labels: ni.labels, series: [{ name: 'Net income', color: 'var(--chart-2)', values: ni.values }],
      fmt: PS.fmtMoney, negativeColor: 'var(--down)', growthLag: 1,
      lastBarColor: ni.lastBarColor, lastBarNote: ni.lastBarNote,
    });
    // margins
    const gm = years.map((r, i) => { const g = align(A.grossProfit, years)[i]; return g != null && r.v ? (g / r.v) * 100 : null; });
    const om = years.map((r, i) => { const o = align(A.opIncome, years)[i]; return o != null && r.v ? (o / r.v) * 100 : null; });
    const nm = years.map((r, i) => { const n = align(A.netIncome, years)[i]; return n != null && r.v ? (n / r.v) * 100 : null; });
    PSCharts.lineChart(card('Margins', 'profitability as % of revenue'), {
      labels: yl,
      series: [
        { name: 'Gross', color: 'var(--chart-1)', values: gm },
        { name: 'Operating', color: 'var(--chart-2)', values: om },
        { name: 'Net', color: 'var(--chart-3)', values: nm },
      ].filter((sr) => sr.values.some((v) => v != null)),
      fmt: (v) => PS.fmtPct(v), fillGaps: true,
    });
    if (!unreliable && A.eps.length >= 2) {
      const e = A.eps.slice(-10);
      const ef = splitFactors(e.map((r) => r.end), sharesByEnd);
      const eVals = e.map((r, i) => (r.v == null ? null : r.v / ef[i]));
      const eps = withTTM(e.map((r) => PS.fyLabel(r.end)), eVals, s.epsTTM);
      PSCharts.barChart(card('EPS (diluted)', 'earnings per share · % vs. prior year' + ttmSub), {
        labels: eps.labels,
        series: [{ name: 'EPS', color: 'var(--chart-4)', values: eps.values }],
        fmt: (v) => '$' + (v == null ? '-' : v.toFixed(2)), negativeColor: 'var(--down)', growthLag: 1,
        lastBarColor: eps.lastBarColor, lastBarNote: eps.lastBarNote,
      });
    }
    // cash flow
    const ocf = align(A.ocf, years), capex = align(A.capex, years);
    const fcf = years.map((_, i) => (ocf[i] != null && capex[i] != null ? ocf[i] - capex[i] : null));
    const cfTTM = ttmOn && s.ocfTTM != null;
    PSCharts.barChart(card('Cash flow', 'operating cash flow, capex, and free cash flow' + (cfTTM ? ttmSub : '')), {
      labels: cfTTM ? [...yl, 'TTM'] : yl,
      series: [
        { name: 'Operating CF', color: 'var(--chart-1)', values: cfTTM ? [...ocf, s.ocfTTM] : ocf },
        { name: 'Capex', color: 'var(--chart-2)', values: (cfTTM ? [...capex, s.capexTTM] : capex).map((v) => (v == null ? null : -v)) },
        { name: 'Free CF', color: 'var(--chart-4)', values: cfTTM ? [...fcf, s.fcfTTM] : fcf },
      ].filter((sr) => sr.values.some((v) => v != null)),
      fmt: PS.fmtMoney,
    });
    // balance sheet
    const B = f.balances;
    const bl = (B.assets || []).slice(-10);
    if (bl.length >= 2) {
      const lb = f.latestBalance;
      const bsNow = lb && newerThan(lb.end, bl.at(-1).end) && lb.assets != null;
      const bYl = bl.map((r) => PS.fyLabel(r.end));
      PSCharts.barChart(card('Balance sheet', 'assets vs. liabilities vs. equity at fiscal year end'
        + (bsNow ? ` · final column is the latest quarter (${PS.qLabel(lb.end)})` : '')), {
        labels: bsNow ? [...bYl, PS.qLabel(lb.end)] : bYl,
        series: [
          { name: 'Assets', color: 'var(--chart-1)', values: bsNow ? [...bl.map((r) => r.v), lb.assets] : bl.map((r) => r.v) },
          { name: 'Liabilities', color: 'var(--chart-2)', values: bsNow ? [...align(B.liabilities || [], bl), lb.liabilities] : align(B.liabilities || [], bl) },
          { name: 'Equity', color: 'var(--chart-4)', values: bsNow ? [...align(B.equity || [], bl), lb.equity] : align(B.equity || [], bl) },
        ].filter((sr) => sr.values.some((v) => v != null)),
        fmt: PS.fmtMoney,
      });
    }
    // shares outstanding
    if (f.dilutedShares?.length >= 3) {
      const sh = f.dilutedShares.slice(-10);
      const sf = splitFactors(sh.map((r) => r.end), sharesByEnd);
      const ls = f.latestShares;
      const shNow = ls && newerThan(ls.end, sh.at(-1).end) && ls.v != null;
      const shVals = sh.map((r, i) => (r.v == null ? null : r.v * sf[i]));
      PSCharts.lineChart(card('Shares outstanding', 'diluted weighted average, split-adjusted; falling means buybacks are shrinking the float'
        + (shNow ? ` · to ${PS.qLabel(ls.end)}` : '')), {
        labels: shNow ? [...sh.map((r) => PS.fyLabel(r.end)), PS.qLabel(ls.end)] : sh.map((r) => PS.fyLabel(r.end)),
        series: [{ name: 'Shares', color: 'var(--chart-1)', values: shNow ? [...shVals, ls.v] : shVals }],
        fmt: (v, tick) => PS.fmtNum(v, tick),
      });
    }
    // capital returns
    const bb = align(A.buybacks, years), dv = align(A.dividendsPaid, years);
    if (bb.some((v) => v) || dv.some((v) => v)) {
      const crTTM = ttmOn && (s.buybacksTTM != null || s.dividendsTTM != null);
      PSCharts.barChart(card('Capital returned', 'cash spent on buybacks and dividends' + (crTTM ? ttmSub : '')), {
        labels: crTTM ? [...yl, 'TTM'] : yl,
        series: [
          { name: 'Buybacks', color: 'var(--chart-1)', values: crTTM ? [...bb, s.buybacksTTM] : bb },
          { name: 'Dividends', color: 'var(--chart-3)', values: crTTM ? [...dv, s.dividendsTTM] : dv },
        ].filter((sr) => sr.values.some((v) => v != null)),
        stacked: true, fmt: PS.fmtMoney,
      });
    }
  } else {
    grid.innerHTML = '<p class="body-md" style="color:var(--muted)">Not enough filed history for annual charts.</p>';
  }

  // ---- quarterly ----
  const Q = f.quarterly;
  const qgrid = document.getElementById('quarterCharts');
  const qcard = (title, sub) => {
    const div = document.createElement('div');
    div.className = 'chart-card';
    div.innerHTML = `<h3>${title}</h3>${sub ? `<p class="chart-sub">${sub}</p>` : ''}<div class="chart-box"></div>`;
    qgrid.appendChild(div);
    return div.querySelector('.chart-box');
  };
  const qr = (Q.revenue || []).slice(-12);
  if (qr.length >= 4) {
    PSCharts.barChart(qcard('Quarterly revenue', '% is growth vs. the same quarter a year ago'), {
      labels: qr.map((r) => PS.qLabel(r.end)),
      series: [{ name: 'Revenue', color: 'var(--chart-1)', values: qr.map((r) => r.v) }],
      fmt: PS.fmtMoney, flags: qr.map((r) => (r.d ? '(derived Q4)' : '')), negativeColor: 'var(--down)', growthLag: 4,
    });
    const qn = (Q.netIncome || []).slice(-12);
    if (qn.length >= 4) {
      PSCharts.barChart(qcard('Quarterly net income', '% vs. the same quarter a year ago'), {
        labels: qn.map((r) => PS.qLabel(r.end)),
        series: [{ name: 'Net income', color: 'var(--chart-2)', values: qn.map((r) => r.v) }],
        fmt: PS.fmtMoney, flags: qn.map((r) => (r.d ? '(derived Q4)' : '')), negativeColor: 'var(--down)', growthLag: 4,
      });
    }
  } else {
    qgrid.innerHTML = '<p class="body-md" style="color:var(--muted)">Quarterly data unavailable for this company.</p>';
  }

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
