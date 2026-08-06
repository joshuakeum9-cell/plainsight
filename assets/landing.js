/* Landing page: live hero chips, ticker tape, pulse card, and the real AAPL mini-report. */
(async function () {
  PS.burger();
  const GH = 'https://github.com/joshuakeum9-cell/plainsight';
  for (const id of ['ghLink', 'ghLink2']) {
    const a = document.getElementById(id);
    if (a) { a.href = GH; a.target = '_blank'; }
  }

  try {
    const q = await PS.quotes();

    // hero chips
    const chips = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow']];
    document.getElementById('heroChips').innerHTML = chips.map(([k, label]) => {
      const d = q.indices[k];
      if (!d) return '';
      const cls = d.c > 0 ? 'chip-up' : d.c < 0 ? 'chip-down' : 'chip-flat';
      const arrow = d.c > 0 ? '▲' : d.c < 0 ? '▼' : '·';
      return `<span class="badge-pill ${cls}">${label} ${PS.fmtPrice(d.p)} ${arrow} ${Math.abs(d.cp ?? 0).toFixed(2)}%</span>`;
    }).join('');

    // pulse card
    const pulse = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^VIX', 'VIX']];
    document.getElementById('pulseRows').innerHTML = pulse.map(([k, label]) => {
      const d = q.indices[k];
      if (!d) return '';
      const col = d.c > 0 ? 'var(--up)' : d.c < 0 ? 'var(--down)' : 'var(--muted)';
      return `<div class="mr"><span>${label}</span><b style="color:${col}">${PS.fmtPrice(d.p)} (${d.cp > 0 ? '+' : ''}${(d.cp ?? 0).toFixed(2)}%)</b></div>`;
    }).join('');

    // ticker tape: top 40 by |change%|, doubled for seamless loop
    const universe = await PS.universe();
    const nameOf = Object.fromEntries(universe.companies.map((c) => [PS.qKey(c.t), c.t]));
    const movers = Object.entries(q.quotes)
      .filter(([, v]) => v.cp != null)
      .sort((a, b) => Math.abs(b[1].cp) - Math.abs(a[1].cp))
      .slice(0, 40);
    const tapeHTML = movers.map(([sym, v]) => {
      const t = nameOf[sym] || sym;
      const cls = v.cp > 0 ? 'u' : 'd';
      const arrow = v.cp > 0 ? '▲' : '▼';
      return `<a href="company.html?t=${encodeURIComponent(t)}"><span class="s">${t}</span> ${PS.fmtPrice(v.p)} <span class="${cls}">${arrow} ${Math.abs(v.cp).toFixed(2)}%</span></a>`;
    }).join('');
    document.getElementById('tape').innerHTML = tapeHTML + tapeHTML;

    document.getElementById('stamp').textContent = `Quotes updated ${PS.fmtUpdated(q.updated)}.`;
    document.getElementById('navStamp').textContent = `Updated ${PS.fmtUpdated(q.updated)}`;
  } catch (e) { console.error(e); }

  // real AAPL revenue mini-chart + price
  try {
    const [f, q] = await Promise.all([PS.fundamentals('AAPL'), PS.quotes()]);
    const aapl = q.quotes['AAPL'];
    const priceEl = document.getElementById('mockPrice');
    if (aapl) {
      priceEl.classList.remove('skeleton');
      const col = aapl.c > 0 ? 'var(--up)' : aapl.c < 0 ? 'var(--down)' : 'var(--muted)';
      priceEl.innerHTML = `<strong>$${PS.fmtPrice(aapl.p)}</strong> <span class="caption" style="color:${col}">${aapl.c > 0 ? '+' : ''}${(aapl.cp ?? 0).toFixed(2)}%</span>`;
    }
    const rev = f.annual.revenue.slice(-10);
    PSCharts.barChart(document.getElementById('mockChart'), {
      labels: rev.map((r) => PS.fyLabel(r.end)),
      series: [{ name: 'Revenue', color: 'var(--chart-1)', values: rev.map((r) => r.v) }],
      fmt: PS.fmtMoney, height: 180, table: false,
    });
  } catch (e) { console.error(e); }
})();
