/* Plainsight chart library - hand-rolled SVG, no dependencies.
   Specs: 2px lines, thin bars with 4px rounded outward ends anchored to the
   baseline, 2px canvas gaps between adjacent fills, recessive hairline grid,
   crosshair+tooltip on lines, per-mark tooltip on bars, legends for >=2 series,
   and a data-table fallback under every chart. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  function niceTicks(min, max, count = 4) {
    if (min === max) { max = min + 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) || mag * 10;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { lo, hi, ticks };
  }

  function makeTip(box) {
    let tip = box.querySelector('.chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      box.appendChild(tip);
    }
    return tip;
  }
  function placeTip(tip, box, px, py) {
    const bw = box.clientWidth;
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = px + 14;
    if (x + tw > bw - 4) x = px - tw - 14;
    let y = py - th - 10;
    if (y < 0) y = py + 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const tipRow = (color, name, val) =>
    `<div class="row"><span class="sw" style="background:${color}"></span><span>${name ? name + ': ' : ''}<strong>${val}</strong></span></div>`;

  function legend(box, series) {
    if (series.length < 2) return;
    const lg = document.createElement('div');
    lg.className = 'chart-legend';
    lg.innerHTML = series.map((s) => `<span class="li"><span class="sw" style="background:${s.color}"></span>${s.name}</span>`).join('');
    box.appendChild(lg);
  }

  function dataTable(box, labels, series, fmt, growth) {
    const d = document.createElement('details');
    d.className = 'data-table';
    const gCell = (i) => {
      if (!growth) return '';
      const g = growth[i];
      return `<td class="num" style="color:${g == null ? 'var(--muted)' : g >= 0 ? 'var(--up)' : 'var(--down)'}">${g == null ? '-' : fmtGrowth(g)}</td>`;
    };
    const rows = labels.map((lab, i) =>
      `<tr><td>${lab}</td>${series.map((s) => `<td class="num">${s.values[i] == null ? '-' : fmt(s.values[i])}</td>`).join('')}${gCell(i)}</tr>`).join('');
    d.innerHTML = `<summary>View as table</summary><table class="data"><thead><tr><th></th>${series
      .map((s) => `<th class="num">${s.name}</th>`).join('')}${growth ? '<th class="num">YoY</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
    box.appendChild(d);
  }

  // ---------- line chart (1..4 series, shared x) ----------
  // opts: {labels, series:[{name,color,values}], fmt, height, area, fillGaps}
  function lineChart(box, opts) {
    box.innerHTML = '';
    const W = 640, H = opts.height || 260, padL = 46, padR = 12, padT = 12, padB = 24;
    const labels = opts.labels;
    const series = opts.series.filter((s) => s.values.some((v) => v != null));
    if (!series.length || labels.length < 2) { box.innerHTML = '<p class="body-sm" style="color:var(--muted)">Not enough data.</p>'; return; }
    const flat = series.flatMap((s) => s.values).filter((v) => v != null);
    const { lo, hi, ticks } = niceTicks(Math.min(...flat), Math.max(...flat));
    const X = (i) => padL + (i / (labels.length - 1)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

    for (const t of ticks) {
      svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), stroke: 'var(--chart-grid)', 'stroke-width': 1 }));
      const txt = el('text', { x: padL - 8, y: Y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' });
      txt.textContent = opts.fmt(t, true);
      svg.appendChild(txt);
    }
    // x labels: first, middle, last
    const xIdx = [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
    for (const i of new Set(xIdx)) {
      const txt = el('text', { x: X(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle', 'font-size': 11, fill: 'var(--muted)' });
      txt.textContent = labels[i];
      svg.appendChild(txt);
    }

    for (const s of series) {
      let d = '', started = false;
      const pts = [];
      for (let i = 0; i < labels.length; i++) {
        const v = s.values[i];
        if (v == null) { if (!opts.fillGaps) started = false; continue; }
        d += (started ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
        started = true;
        pts.push(i);
      }
      if (opts.area && series.length === 1) {
        const first = pts[0], lastI = pts[pts.length - 1];
        const areaD = d + `L${X(lastI).toFixed(1)} ${Y(Math.max(lo, Math.min(hi, 0)) > lo ? lo : lo).toFixed(1)}L${X(first).toFixed(1)} ${(H - padB).toFixed(1)}Z`;
        const area = el('path', { d: d + `L${X(lastI).toFixed(1)} ${H - padB}L${X(first).toFixed(1)} ${H - padB}Z`, fill: s.color, opacity: 0.08 });
        svg.appendChild(area);
      }
      svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }

    // crosshair + tooltip
    const cross = el('line', { y1: padT, y2: H - padB, stroke: 'var(--muted-soft)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
    svg.appendChild(cross);
    const dots = series.map((s) => { const c = el('circle', { r: 4, fill: s.color, stroke: 'var(--canvas)', 'stroke-width': 2, visibility: 'hidden' }); svg.appendChild(c); return c; });
    const tip = makeTip(box);
    svg.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const fx = ((ev.clientX - rect.left) / rect.width) * W;
      let i = Math.round(((fx - padL) / (W - padL - padR)) * (labels.length - 1));
      i = Math.max(0, Math.min(labels.length - 1, i));
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      let rows = '';
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v == null) { dots[si].setAttribute('visibility', 'hidden'); return; }
        dots[si].setAttribute('cx', X(i)); dots[si].setAttribute('cy', Y(v)); dots[si].setAttribute('visibility', 'visible');
        rows += tipRow(s.color, series.length > 1 ? s.name : '', opts.fmt(v));
      });
      tip.innerHTML = `<div class="tl">${labels[i]}</div>` + rows;
      placeTip(tip, box, (X(i) / W) * rect.width, (ev.clientY - rect.top));
    });
    svg.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      tip.style.display = 'none';
    });

    box.appendChild(svg);
    legend(box, series);
    if (opts.table !== false) dataTable(box, labels, series, opts.fmt);
  }

  // Growth vs `lag` periods back (lag 1 = prior year, lag 4 = same quarter last year).
  // Null when the base is missing, zero, or negative (a % from a negative base is meaningless).
  function growthSeries(values, lag) {
    return values.map((v, i) => {
      const base = i >= lag ? values[i - lag] : null;
      if (v == null || base == null || base <= 0) return null;
      return ((v - base) / base) * 100;
    });
  }
  const fmtGrowth = (g) => {
    if (g == null) return null;
    if (Math.abs(g) > 999) return (g > 0 ? '+' : '−') + '999%+';
    const n = Math.abs(g) >= 10 ? Math.abs(g).toFixed(0) : Math.abs(g).toFixed(1);
    return (g >= 0 ? '+' : '−') + n + '%';
  };

  // ---------- bar chart (grouped or stacked; supports negatives) ----------
  // opts: {labels, series:[{name,color,values}], stacked, fmt, height,
  //        growthLag: show YoY % labels + tooltip rows (single-series only)}
  function barChart(box, opts) {
    box.innerHTML = '';
    const growth = opts.growthLag && opts.series.length === 1
      ? growthSeries(opts.series[0].values, opts.growthLag) : null;
    const W = 640, H = opts.height || 260, padL = 46, padR = 12, padT = growth ? 26 : 12, padB = 24;
    const labels = opts.labels;
    const series = opts.series.filter((s) => s.values.some((v) => v != null));
    if (!series.length || !labels.length) { box.innerHTML = '<p class="body-sm" style="color:var(--muted)">Not enough data.</p>'; return; }

    let mins = [0], maxs = [0];
    if (opts.stacked) {
      for (let i = 0; i < labels.length; i++) {
        let pos = 0, neg = 0;
        for (const s of series) { const v = s.values[i]; if (v == null) continue; if (v >= 0) pos += v; else neg += v; }
        maxs.push(pos); mins.push(neg);
      }
    } else {
      const flat = series.flatMap((s) => s.values).filter((v) => v != null);
      mins.push(Math.min(...flat)); maxs.push(Math.max(...flat));
    }
    const { lo, hi, ticks } = niceTicks(Math.min(...mins), Math.max(...maxs));
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

    for (const t of ticks) {
      svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), stroke: t === 0 ? 'var(--hairline)' : 'var(--chart-grid)', 'stroke-width': 1 }));
      const txt = el('text', { x: padL - 8, y: Y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' });
      txt.textContent = opts.fmt(t, true);
      svg.appendChild(txt);
    }

    const plotW = W - padL - padR;
    const slot = plotW / labels.length;
    const gap = 2;
    const groupW = Math.min(slot * 0.72, 64);
    const barW = opts.stacked ? groupW : (groupW - gap * (series.length - 1)) / series.length;
    const tip = makeTip(box);

    // rounded outward end, flat at baseline
    function barPath(x, v, y0, y1, w) {
      const r = Math.min(4, w / 2, Math.abs(y1 - y0));
      if (v >= 0) {
        const top = Math.min(y0, y1), bot = Math.max(y0, y1);
        return `M${x} ${bot}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + w - r}Q${x + w} ${top} ${x + w} ${top + r}V${bot}Z`;
      } else {
        const top = Math.min(y0, y1), bot = Math.max(y0, y1);
        return `M${x} ${top}V${bot - r}Q${x} ${bot} ${x + r} ${bot}H${x + w - r}Q${x + w} ${bot} ${x + w} ${bot - r}V${top}Z`;
      }
    }

    for (let i = 0; i < labels.length; i++) {
      const gx = padL + slot * i + (slot - groupW) / 2;
      let stackPos = 0, stackNeg = 0;
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v == null) return;
        let x, y0, y1;
        if (opts.stacked) {
          x = gx;
          if (v >= 0) { y0 = Y(stackPos); y1 = Y(stackPos + v); stackPos += v; }
          else { y0 = Y(stackNeg); y1 = Y(stackNeg + v); stackNeg += v; }
          if (si > 0) { if (v >= 0) y0 -= 0; } // gap handled by stroke below
        } else {
          x = gx + si * (barW + gap);
          y0 = Y(0); y1 = Y(v);
        }
        const color = (opts.negativeColor && v < 0 && series.length === 1) ? opts.negativeColor : s.color;
        const p = el('path', { d: barPath(x, v, y0, y1, opts.stacked ? groupW : barW), fill: color });
        if (opts.stacked) p.setAttribute('stroke', 'var(--canvas)'), p.setAttribute('stroke-width', 1);
        const g = growth ? growth[i] : null;
        p.addEventListener('pointerenter', (ev) => {
          p.setAttribute('opacity', '0.85');
          const rect = svg.getBoundingClientRect();
          tip.innerHTML = `<div class="tl">${labels[i]}${opts.flags?.[i] ? ' <span style="color:var(--muted);font-weight:400">' + opts.flags[i] + '</span>' : ''}</div>` +
            tipRow(color, series.length > 1 ? s.name : '', opts.fmt(v)) +
            (g != null ? `<div class="row"><span class="sw" style="background:${g >= 0 ? 'var(--up)' : 'var(--down)'}"></span><span>${opts.growthLag === 4 ? 'vs. yr ago' : 'YoY'}: <strong style="color:${g >= 0 ? 'var(--up)' : 'var(--down)'}">${fmtGrowth(g)}</strong></span></div>` : '');
          placeTip(tip, box, ((x + barW / 2) / W) * rect.width, (Math.min(y0, y1) / H) * rect.height);
        });
        p.addEventListener('pointerleave', () => { p.removeAttribute('opacity'); tip.style.display = 'none'; });
        svg.appendChild(p);
        // growth label riding the bar's outward end
        if (g != null && labels.length <= 14) {
          const ly = v >= 0 ? Math.min(y0, y1) - 6 : Math.max(y0, y1) + 13;
          const txt = el('text', { x: x + barW / 2, y: ly, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 600,
            fill: g >= 0 ? 'var(--up)' : 'var(--down)' });
          txt.textContent = fmtGrowth(g);
          svg.appendChild(txt);
        }
      });
    }

    // x labels: sparse (max ~8)
    const every = Math.ceil(labels.length / 8);
    for (let i = 0; i < labels.length; i++) {
      if (i % every && i !== labels.length - 1) continue;
      const txt = el('text', { x: padL + slot * i + slot / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' });
      txt.textContent = labels[i];
      svg.appendChild(txt);
    }

    box.appendChild(svg);
    legend(box, series);
    if (opts.table !== false) dataTable(box, labels, series, opts.fmt, growth);
  }

  window.PSCharts = { lineChart, barChart };
})();
