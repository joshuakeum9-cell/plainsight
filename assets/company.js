/* Company report page: live header, price chart, key metrics, fundamentals charts. */
(async function () {
  PS.burger();

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
  document.getElementById('navStamp').textContent = `Updated ${PS.fmtUpdated(q.updated)}`;
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
  function renderPrice(range) {
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

  if (years.length >= 2) {
    PSCharts.barChart(card('Revenue', 'total annual revenue · % is growth vs. prior year'), {
      labels: yl, series: [{ name: 'Revenue', color: 'var(--chart-1)', values: years.map((r) => r.v) }],
      fmt: PS.fmtMoney, negativeColor: 'var(--down)', growthLag: 1,
    });
    PSCharts.barChart(card('Net income', 'profit after all expenses and tax · % vs. prior year'), {
      labels: yl, series: [{ name: 'Net income', color: 'var(--chart-2)', values: align(A.netIncome, years) }],
      fmt: PS.fmtMoney, negativeColor: 'var(--down)', growthLag: 1,
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
      PSCharts.barChart(card('EPS (diluted)', 'earnings per share · % vs. prior year'), {
        labels: A.eps.slice(-10).map((r) => PS.fyLabel(r.end)),
        series: [{ name: 'EPS', color: 'var(--chart-4)', values: A.eps.slice(-10).map((r) => r.v) }],
        fmt: (v) => '$' + (v == null ? '-' : v.toFixed(2)), negativeColor: 'var(--down)', growthLag: 1,
      });
    }
    // cash flow
    const ocf = align(A.ocf, years), capex = align(A.capex, years);
    const fcf = years.map((_, i) => (ocf[i] != null && capex[i] != null ? ocf[i] - capex[i] : null));
    PSCharts.barChart(card('Cash flow', 'operating cash flow, capex, and free cash flow'), {
      labels: yl,
      series: [
        { name: 'Operating CF', color: 'var(--chart-1)', values: ocf },
        { name: 'Capex', color: 'var(--chart-2)', values: capex.map((v) => (v == null ? null : -v)) },
        { name: 'Free CF', color: 'var(--chart-4)', values: fcf },
      ].filter((sr) => sr.values.some((v) => v != null)),
      fmt: PS.fmtMoney,
    });
    // balance sheet
    const B = f.balances;
    const bl = (B.assets || []).slice(-10);
    if (bl.length >= 2) {
      const bYl = bl.map((r) => PS.fyLabel(r.end));
      PSCharts.barChart(card('Balance sheet', 'assets vs. liabilities vs. equity at fiscal year end'), {
        labels: bYl,
        series: [
          { name: 'Assets', color: 'var(--chart-1)', values: bl.map((r) => r.v) },
          { name: 'Liabilities', color: 'var(--chart-2)', values: align(B.liabilities || [], bl) },
          { name: 'Equity', color: 'var(--chart-4)', values: align(B.equity || [], bl) },
        ].filter((sr) => sr.values.some((v) => v != null)),
        fmt: PS.fmtMoney,
      });
    }
    // shares outstanding
    if (f.dilutedShares?.length >= 3) {
      PSCharts.lineChart(card('Shares outstanding', 'diluted weighted average; falling means buybacks are shrinking the float'), {
        labels: f.dilutedShares.slice(-10).map((r) => PS.fyLabel(r.end)),
        series: [{ name: 'Shares', color: 'var(--chart-1)', values: f.dilutedShares.slice(-10).map((r) => r.v) }],
        fmt: (v, tick) => PS.fmtNum(v, tick),
      });
    }
    // capital returns
    const bb = align(A.buybacks, years), dv = align(A.dividendsPaid, years);
    if (bb.some((v) => v) || dv.some((v) => v)) {
      PSCharts.barChart(card('Capital returned', 'cash spent on buybacks and dividends'), {
        labels: yl,
        series: [
          { name: 'Buybacks', color: 'var(--chart-1)', values: bb },
          { name: 'Dividends', color: 'var(--chart-3)', values: dv },
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
