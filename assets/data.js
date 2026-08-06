/* Plainsight shared data layer: fetching, formatting, predictive search, nav. */
(function () {
  const cache = {};
  async function load(path) {
    if (cache[path]) return cache[path];
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Failed to load ${path} (${r.status})`);
    return (cache[path] = await r.json());
  }

  const fileSym = (t) => t.replace(/\^/g, '_IDX_').replace(/\./g, '-');
  // quotes.json keys use Yahoo symbols (dots -> dashes)
  const qKey = (t) => t.replace(/\./g, '-');

  const PS = {
    universe: () => load('data/universe.json'),
    quotes: () => load('data/quotes.json'),
    fundamentals: (t) => load(`data/fundamentals/${fileSym(t)}.json`),
    history: (t) => load(`data/history/${fileSym(t)}.json`),
    qKey,

    // ---- formatters ----
    fmtPrice(v) {
      if (v == null) return '-';
      return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    fmtMoney(v, compactTick) {
      if (v == null || !isFinite(v)) return '-';
      const a = Math.abs(v);
      const sign = v < 0 ? '-' : '';
      const f = (x, d) => x.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
      if (a >= 1e12) return `${sign}$${f(a / 1e12, compactTick ? 1 : 2)}T`;
      if (a >= 1e9) return `${sign}$${f(a / 1e9, compactTick ? 0 : 1)}B`;
      if (a >= 1e6) return `${sign}$${f(a / 1e6, compactTick ? 0 : 1)}M`;
      if (a >= 1e3) return `${sign}$${f(a / 1e3, 1)}K`;
      return `${sign}$${f(a, 2)}`;
    },
    fmtNum(v, compactTick) {
      if (v == null || !isFinite(v)) return '-';
      const a = Math.abs(v), sign = v < 0 ? '-' : '';
      const f = (x, d) => x.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      if (a >= 1e12) return `${sign}${f(a / 1e12, 2)}T`;
      if (a >= 1e9) return `${sign}${f(a / 1e9, compactTick ? 0 : 1)}B`;
      if (a >= 1e6) return `${sign}${f(a / 1e6, compactTick ? 0 : 1)}M`;
      if (a >= 1e3) return `${sign}${f(a / 1e3, 1)}K`;
      return `${sign}${f(a, 2)}`;
    },
    fmtPct(v) { return v == null || !isFinite(v) ? '-' : `${v.toFixed(1)}%`; },
    fmtEps(v) { return v == null || !isFinite(v) ? '-' : `$${v.toFixed(2)}`; },
    changeChip(c, cp) {
      if (c == null || cp == null) return '<span class="badge-pill chip-flat">-</span>';
      const cls = c > 0 ? 'chip-up' : c < 0 ? 'chip-down' : 'chip-flat';
      const arrow = c > 0 ? '▲' : c < 0 ? '▼' : '·';
      return `<span class="badge-pill ${cls}">${arrow} ${Math.abs(c).toFixed(2)} (${Math.abs(cp).toFixed(2)}%)</span>`;
    },
    fmtUpdated(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    fyLabel: (end) => "FY'" + end.slice(2, 4),
    qLabel(end) {
      const d = new Date(end + 'T00:00:00');
      return `Q${Math.floor(d.getMonth() / 3) + 1} '${String(d.getFullYear()).slice(2)}`;
    },

    // ---- predictive search ----
    attachSearch(inputEl, resultsEl, { limit = 8 } = {}) {
      let companies = [];
      let sel = -1;
      PS.universe().then((u) => { companies = u.companies; });

      function rank(qq) {
        const q = qq.trim().toUpperCase();
        if (!q) return [];
        const scored = [];
        for (const c of companies) {
          const sym = c.t.toUpperCase(), name = c.n.toUpperCase();
          let score = -1;
          if (sym === q) score = 0;
          else if (sym.startsWith(q)) score = 1;
          else if (name.startsWith(q)) score = 2;
          else if (name.includes(' ' + q)) score = 3;
          else if (name.includes(q) || sym.includes(q)) score = 4;
          if (score >= 0) scored.push([score, sym.length, c]);
        }
        scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return scored.slice(0, limit).map((s) => s[2]);
      }

      function render(list) {
        sel = -1;
        if (!list.length) { resultsEl.classList.remove('open'); resultsEl.innerHTML = ''; return; }
        resultsEl.innerHTML = list.map((c) =>
          `<a href="company.html?t=${encodeURIComponent(c.t)}"><span class="sym-chip">${c.t}</span><span class="nm">${c.n}</span><span class="sec">${c.s}</span></a>`).join('');
        resultsEl.classList.add('open');
      }

      inputEl.addEventListener('input', () => render(rank(inputEl.value)));
      inputEl.addEventListener('focus', () => { if (inputEl.value) render(rank(inputEl.value)); });
      inputEl.addEventListener('keydown', (e) => {
        const items = [...resultsEl.querySelectorAll('a')];
        if (!items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; }
        else if (e.key === 'Enter') { e.preventDefault(); (items[sel] || items[0]).click(); return; }
        else if (e.key === 'Escape') { resultsEl.classList.remove('open'); return; }
        else return;
        items.forEach((a, i) => a.classList.toggle('sel', i === sel));
        if (items[sel]) items[sel].scrollIntoView({ block: 'nearest' });
      });
      document.addEventListener('click', (e) => {
        if (!resultsEl.contains(e.target) && e.target !== inputEl) resultsEl.classList.remove('open');
      });
    },

    burger() {
      const b = document.querySelector('.nav-burger');
      const m = document.querySelector('.mobile-menu');
      if (b && m) b.addEventListener('click', () => m.classList.toggle('open'));
    },
  };

  window.PS = PS;
})();
