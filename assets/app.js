/* Terminal page: indices, movers, sector performance, full sortable screener. */
(async function () {
  PS.burger();
  PS.attachSearch(document.getElementById('search'), document.getElementById('searchResults'));

  const [q, u] = await Promise.all([PS.quotes(), PS.universe()]);
  document.getElementById('stamp').textContent = `Updated ${PS.fmtUpdated(q.updated)}`;

  // ---- indices ---- (^TNX quotes the 10-yr yield ×10)
  document.getElementById('indices').innerHTML = Object.entries(q.indices).map(([k, d]) => {
    const col = d.c > 0 ? 'var(--up)' : d.c < 0 ? 'var(--down)' : 'var(--muted)';
    const arrow = d.c > 0 ? '▲' : d.c < 0 ? '▼' : '·';
    const val = k === '^TNX' ? (d.p / 10).toFixed(2) + '%' : PS.fmtPrice(d.p);
    const chg = k === '^TNX' ? (Math.abs(d.c ?? 0) * 10).toFixed(0) + ' bps' : Math.abs(d.c ?? 0).toFixed(2) + ` (${Math.abs(d.cp ?? 0).toFixed(2)}%)`;
    return `<div class="stat-tile"><div class="lab">${d.label}</div><div class="val">${val}</div>
      <div class="sub" style="color:${col}">${arrow} ${chg}</div></div>`;
  }).join('');

  // ---- join universe + quotes ----
  const rows = u.companies.map((c) => {
    const d = q.quotes[PS.qKey(c.t)] || {};
    const pos52 = d.p != null && d.h52 != null && d.l52 != null && d.h52 > d.l52
      ? ((d.p - d.l52) / (d.h52 - d.l52)) * 100 : null;
    return { ...c, p: d.p ?? null, c: d.c ?? null, cp: d.cp ?? null, h52: d.h52, l52: d.l52, pos52 };
  });

  // ---- movers ----
  const valid = rows.filter((r) => r.cp != null);
  const moverRow = (r) => {
    const cls = r.cp > 0 ? 'chip-up' : 'chip-down';
    const arrow = r.cp > 0 ? '▲' : '▼';
    return `<a class="mover-row" href="company.html?t=${encodeURIComponent(r.t)}">
      <span class="sym-chip">${r.t}</span><span class="nm">${r.n}</span>
      <span class="px">$${PS.fmtPrice(r.p)}</span>
      <span class="badge-pill ${cls}">${arrow} ${Math.abs(r.cp).toFixed(2)}%</span></a>`;
  };
  document.getElementById('gainers').innerHTML = [...valid].sort((a, b) => b.cp - a.cp).slice(0, 6).map(moverRow).join('');
  document.getElementById('losers').innerHTML = [...valid].sort((a, b) => a.cp - b.cp).slice(0, 6).map(moverRow).join('');

  // ---- sector performance (avg % move, signed bars around zero) ----
  const bySector = {};
  for (const r of valid) (bySector[r.s] ??= []).push(r.cp);
  const sectors = Object.entries(bySector).map(([s, list]) => ({ s, avg: list.reduce((a, b) => a + b, 0) / list.length, n: list.length }))
    .sort((a, b) => b.avg - a.avg);
  const maxAbs = Math.max(...sectors.map((x) => Math.abs(x.avg)), 0.2);
  document.getElementById('sectors').innerHTML = sectors.map(({ s, avg }) => {
    const w = (Math.abs(avg) / maxAbs) * 50;
    const up = avg >= 0;
    return `<div class="sector-row">
      <span style="color:var(--body)">${s}</span>
      <div class="bar-track"><span class="zero"></span>
        <span class="bar" style="${up ? `left:50%` : `right:50%`};width:${w}%;background:${up ? 'var(--up)' : 'var(--down)'};opacity:.75"></span>
      </div>
      <span class="pct" style="color:${up ? 'var(--up)' : 'var(--down)'}">${up ? '+' : ''}${avg.toFixed(2)}%</span>
    </div>`;
  }).join('');

  // ---- screener table ----
  const tbody = document.querySelector('#screenTable tbody');
  let sortK = 't', sortDir = 1, sectorFilter = null, textFilter = '';

  function render() {
    let list = rows;
    if (sectorFilter) list = list.filter((r) => r.s === sectorFilter);
    if (textFilter) {
      const f = textFilter.toUpperCase();
      list = list.filter((r) => r.t.toUpperCase().includes(f) || r.n.toUpperCase().includes(f));
    }
    list = [...list].sort((a, b) => {
      const av = a[sortK], bv = b[sortK];
      if (av == null) return 1; if (bv == null) return -1;
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sortDir;
    });
    tbody.innerHTML = list.map((r) => {
      const col = r.cp > 0 ? 'var(--up)' : r.cp < 0 ? 'var(--down)' : 'var(--muted)';
      const range = r.pos52 == null ? '-'
        : `<span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:64px;height:4px;border-radius:2px;background:var(--surface-strong);position:relative"><span style="position:absolute;left:calc(${r.pos52.toFixed(0)}% - 3px);top:-2px;width:8px;height:8px;border-radius:50%;background:var(--chart-1)"></span></span>${r.pos52.toFixed(0)}%</span>`;
      return `<tr onclick="location.href='company.html?t=${encodeURIComponent(r.t)}'" style="cursor:pointer">
        <td><span class="sym-chip">${r.t}</span></td><td>${r.n}</td><td style="color:var(--muted)">${r.s}</td>
        <td class="num">${r.p == null ? '-' : '$' + PS.fmtPrice(r.p)}</td>
        <td class="num" style="color:${col};font-weight:600">${r.cp == null ? '-' : (r.cp > 0 ? '+' : '') + r.cp.toFixed(2) + '%'}</td>
        <td class="num">${range}</td></tr>`;
    }).join('');
  }

  document.querySelectorAll('#screenTable th').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortK === k) sortDir *= -1; else { sortK = k; sortDir = k === 't' || k === 'n' || k === 's' ? 1 : -1; }
      render();
    });
  });
  document.getElementById('filter').addEventListener('input', (e) => { textFilter = e.target.value; render(); });

  const sectorNames = [...new Set(u.companies.map((c) => c.s))].sort();
  const tabs = document.getElementById('sectorTabs');
  tabs.innerHTML = `<button class="category-tab active" data-s="">All</button>` +
    sectorNames.map((s) => `<button class="category-tab" data-s="${s}">${s.replace(' Technology', ' Tech')}</button>`).join('');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    sectorFilter = b.dataset.s || null;
    render();
  });

  render();
})();
