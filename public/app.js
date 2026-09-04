'use strict';

const RANGES = [
  { id: '1d', label: '1D' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '1M' },
  { id: '180d', label: '6M' },
  { id: '365d', label: '1Y' },
  { id: 'all', label: 'ALL' },
];

const TYPE_SERIES = [
  { key: 'input', label: 'Input', color: 'var(--c-input)' },
  { key: 'output', label: 'Output', color: 'var(--c-output)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--c-cwrite)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--c-cread)' },
];

// Categorical palette for stacking by project / model.
const PALETTE = [
  '#d97757', '#6aa9ff', '#4fbf87', '#b98cff', '#f2c14e', '#ff7eb6',
  '#5fd3d3', '#ff9f43', '#9bb0c9', '#c8e06b', '#e26d6d', '#7f8cff',
];
const OTHER_COLOR = '#3f4a5c';
const MAX_STACK_KEYS = 8;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const state = {
  range: '30d',
  metric: 'tokens',
  stack: 'type',
  compactOpen: true,
  data: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const tip = $('tip');

/* ---------------------------------------------------------------- *
 * persistence
 * ---------------------------------------------------------------- */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('claudinator.prefs') || '{}');
    if (RANGES.some((r) => r.id === p.range)) state.range = p.range;
    if (['tokens', 'cost', 'output'].includes(p.metric)) state.metric = p.metric;
    if (['type', 'project', 'model'].includes(p.stack)) state.stack = p.stack;
    if (typeof p.compactOpen === 'boolean') state.compactOpen = p.compactOpen;
  } catch {
    /* ignore */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      'claudinator.prefs',
      JSON.stringify({
        range: state.range,
        metric: state.metric,
        stack: state.stack,
        compactOpen: state.compactOpen,
      })
    );
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- *
 * formatting
 * ---------------------------------------------------------------- */

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function full(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function money(n) {
  n = Number(n) || 0;
  if (n === 0) return '$0';
  if (n >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 10) return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}

function pct(n) {
  return (n * 100).toFixed(1) + '%';
}

function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

function niceDate(iso) {
  const dt = new Date(iso + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function windowText(d) {
  const f = new Date(d.from);
  const t = new Date(d.to);
  const o = { day: 'numeric', month: 'short' };
  if (f.toDateString() === t.toDateString()) return f.toLocaleDateString(undefined, o);
  return f.toLocaleDateString(undefined, o) + ' – ' + t.toLocaleDateString(undefined, o);
}

/* ---------------------------------------------------------------- *
 * tooltip
 * ---------------------------------------------------------------- */

function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function hideTip() {
  tip.hidden = true;
}

function tipHtml(title, rows) {
  return (
    `<div class="t">${esc(title)}</div>` +
    rows
      .map(([k, v, color]) => {
        const sw = color ? `<span class="sw" style="background:${color}"></span>` : '';
        return `<div class="r"><span>${sw}${esc(k)}</span><b>${esc(v)}</b></div>`;
      })
      .join('')
  );
}

/* ---------------------------------------------------------------- *
 * column chart (drawn at real pixel size, redrawn on resize)
 * ---------------------------------------------------------------- */

function svgEl(name, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

const charts = new Map(); // host -> draw fn

/**
 * rows: [{ label, tipHtml, parts:[{color,value}], total }]
 */
function drawColumns(host, rows, opts) {
  const o = Object.assign({ height: 240, valueFmt: fmt, labelWidth: 34 }, opts || {});
  const draw = () => {
    host.textContent = '';
    if (!rows.length) {
      host.innerHTML = '<p class="empty">No data in this range.</p>';
      return;
    }
    const W = Math.max(280, host.clientWidth || 600);
    const H = o.height;
    const padL = 56;
    const padR = 8;
    const padT = 10;
    const padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const max = Math.max(1e-9, ...rows.map((r) => r.total));

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i;
      const y = padT + plotH - (v / max) * plotH;
      svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'gridline' }));
      const t = svgEl('text', { x: padL - 8, y: y + 3, class: 'axis', 'text-anchor': 'end' });
      t.textContent = o.valueFmt(v);
      svg.appendChild(t);
    }

    const slot = plotW / rows.length;
    const bw = Math.max(1.5, Math.min(slot * 0.74, 48));
    const labelEvery = Math.max(1, Math.ceil(o.labelWidth / slot));

    rows.forEach((row, i) => {
      const cx = padL + slot * i + slot / 2;
      const g = svgEl('g', { class: 'bar' });
      let acc = 0;
      for (const p of row.parts) {
        if (!p.value) continue;
        const h = (p.value / max) * plotH;
        const y = padT + plotH - ((acc + p.value) / max) * plotH;
        g.appendChild(svgEl('rect', { x: cx - bw / 2, y, width: bw, height: Math.max(h, 0.6), fill: p.color }));
        acc += p.value;
      }
      if (!row.total) {
        g.appendChild(svgEl('rect', { x: cx - bw / 2, y: padT + plotH - 1, width: bw, height: 1, fill: 'var(--line)' }));
      }
      g.appendChild(svgEl('rect', { x: cx - slot / 2, y: padT, width: slot, height: plotH, fill: 'transparent' }));
      g.addEventListener('mousemove', (e) => showTip(e, row.tipHtml));
      g.addEventListener('mouseleave', hideTip);
      svg.appendChild(g);

      if (i % labelEvery === 0) {
        const t = svgEl('text', { x: cx, y: H - 7, class: 'axis', 'text-anchor': 'middle' });
        t.textContent = row.label;
        svg.appendChild(t);
      }
    });

    host.appendChild(svg);
  };
  charts.set(host, draw);
  draw();
}

let resizeTimer = null;
let lastWidth = 0;
function redrawCharts() {
  hideTip();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = $('main').clientWidth;
    if (w === lastWidth) return;
    lastWidth = w;
    charts.forEach((draw) => draw());
  }, 120);
}
window.addEventListener('resize', redrawCharts);
// Also catches the page becoming visible after being laid out at zero width.
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(redrawCharts).observe($('main'));

/* ---------------------------------------------------------------- *
 * daily chart: bucketing + stacking
 * ---------------------------------------------------------------- */

function metricValue(b, metric) {
  if (metric === 'cost') return b.cost;
  if (metric === 'output') return b.output;
  return b.total;
}

// Group the daily series into weeks / months when there are too many days.
function bucketSeries(series) {
  const n = series.length;
  const mode = n > 400 ? 'month' : n > 70 ? 'week' : 'day';
  if (mode === 'day') return { mode, buckets: series.map((d) => Object.assign({ days: [d] }, d)) };

  const keyOf = (iso) => {
    const dt = new Date(iso + 'T00:00:00');
    if (mode === 'month') return iso.slice(0, 7);
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  };

  const map = new Map();
  for (const d of series) {
    const k = keyOf(d.date);
    let b = map.get(k);
    if (!b) {
      b = {
        date: k,
        input: 0, output: 0, thinking: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0,
        messages: 0, sessions: 0, byProject: {}, byModel: {}, days: [],
      };
      map.set(k, b);
    }
    for (const f of ['input', 'output', 'thinking', 'cacheWrite', 'cacheRead', 'total', 'cost', 'messages', 'sessions']) {
      b[f] += d[f] || 0;
    }
    for (const dim of ['byProject', 'byModel']) {
      for (const key in d[dim] || {}) {
        const s = b[dim][key] || (b[dim][key] = { total: 0, cost: 0, output: 0 });
        s.total += d[dim][key].total;
        s.cost += d[dim][key].cost;
        s.output += d[dim][key].output;
      }
    }
    b.days.push(d);
  }
  return { mode, buckets: [...map.values()] };
}

function bucketLabel(b, mode) {
  if (mode === 'month') {
    const [y, m] = b.date.split('-');
    return MONTHS[Number(m) - 1] + ' ' + y.slice(2);
  }
  return shortDate(b.date);
}

function bucketTitle(b, mode) {
  if (mode === 'day') return niceDate(b.date);
  if (mode === 'month') {
    const [y, m] = b.date.split('-');
    return MONTHS[Number(m) - 1] + ' ' + y;
  }
  const last = b.days[b.days.length - 1].date;
  return 'Week of ' + niceDate(b.date) + (last !== b.date ? ' → ' + shortDate(last) : '');
}

// Top-N keys across the whole window (by the chosen metric), rest folded into "other".
function stackKeys(buckets, dim, metric) {
  const tot = {};
  for (const b of buckets) {
    for (const k in b[dim]) tot[k] = (tot[k] || 0) + metricValue(b[dim][k], metric);
  }
  const sorted = Object.keys(tot).sort((a, b) => tot[b] - tot[a]);
  const keep = sorted.slice(0, MAX_STACK_KEYS);
  const colors = {};
  keep.forEach((k, i) => (colors[k] = PALETTE[i % PALETTE.length]));
  return { keys: keep, colors, hasOther: sorted.length > keep.length };
}

function bucketTipRows(b) {
  return [
    ['Total tokens', full(b.total)],
    ['Input', full(b.input)],
    ['Output', full(b.output) + (b.thinking ? ` (${full(b.thinking)} thinking)` : '')],
    ['Cache write', full(b.cacheWrite)],
    ['Cache read', full(b.cacheRead)],
    ['Messages', full(b.messages)],
    ['Sessions', full(b.sessions)],
    ['Est. cost', money(b.cost)],
  ];
}

function renderDaily() {
  const d = state.data;
  const metric = state.metric;
  const stack = state.stack;
  const valueFmt = metric === 'cost' ? money : fmt;
  const { mode, buckets } = bucketSeries(d.series);

  $('bucketNote').textContent = mode === 'day' ? '' : `· grouped by ${mode}`;

  let legend = [];
  let rows;

  if (stack === 'type' && metric === 'tokens') {
    legend = TYPE_SERIES;
    rows = buckets.map((b) => ({
      label: bucketLabel(b, mode),
      tipHtml: tipHtml(bucketTitle(b, mode), bucketTipRows(b)),
      parts: TYPE_SERIES.map((s) => ({ color: s.color, value: b[s.key] })),
      total: b.total,
    }));
  } else if (stack === 'type') {
    const color = metric === 'cost' ? 'var(--good)' : 'var(--c-output)';
    legend = [{ label: metric === 'cost' ? 'Estimated cost' : 'Output tokens', color }];
    rows = buckets.map((b) => ({
      label: bucketLabel(b, mode),
      tipHtml: tipHtml(bucketTitle(b, mode), bucketTipRows(b)),
      parts: [{ color, value: metricValue(b, metric) }],
      total: metricValue(b, metric),
    }));
  } else {
    const dim = stack === 'project' ? 'byProject' : 'byModel';
    const { keys, colors, hasOther } = stackKeys(buckets, dim, metric);
    legend = keys.map((k) => ({ label: k, color: colors[k] }));
    if (hasOther) legend.push({ label: 'other', color: OTHER_COLOR });
    rows = buckets.map((b) => {
      const parts = [];
      const tipRows = [];
      let other = 0;
      let total = 0;
      const entries = Object.entries(b[dim]).sort((x, y) => metricValue(y[1], metric) - metricValue(x[1], metric));
      for (const [k, v] of entries) {
        const val = metricValue(v, metric);
        total += val;
        if (colors[k]) {
          parts.push({ color: colors[k], value: val, key: k });
          tipRows.push([k, valueFmt(val), colors[k]]);
        } else other += val;
      }
      parts.sort((x, y) => keys.indexOf(x.key) - keys.indexOf(y.key));
      if (other) {
        parts.push({ color: OTHER_COLOR, value: other });
        tipRows.push(['other', valueFmt(other), OTHER_COLOR]);
      }
      tipRows.unshift([metric === 'cost' ? 'Est. cost' : metric === 'output' ? 'Output' : 'Total tokens', valueFmt(total)]);
      return { label: bucketLabel(b, mode), tipHtml: tipHtml(bucketTitle(b, mode), tipRows), parts, total };
    });
  }

  drawColumns($('dailyChart'), rows, { height: 260, valueFmt, labelWidth: mode === 'month' ? 44 : 34 });
  $('legend').innerHTML = legend
    .map((s) => `<div><span class="sw" style="background:${s.color}"></span>${esc(s.label)}</div>`)
    .join('');
}

/* ---------------------------------------------------------------- *
 * calendar heatmap
 * ---------------------------------------------------------------- */

function renderHeatmap() {
  const d = state.data;
  const panel = $('heatPanel');
  if (d.series.length < 28) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const series = d.series;
  const max = Math.max(1, ...series.map((x) => x.total));
  const level = (t) => (t <= 0 ? 0 : t < max * 0.25 ? 1 : t < max * 0.5 ? 2 : t < max * 0.75 ? 3 : 4);

  // Align the first column to Monday.
  const first = new Date(series[0].date + 'T00:00:00');
  const lead = (first.getDay() + 6) % 7;
  const cells = Array(lead).fill(null).concat(series);
  const cols = [];
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

  const months = [];
  let lastMonth = null;
  const colHtml = cols
    .map((col) => {
      const firstReal = col.find(Boolean);
      const m = firstReal ? firstReal.date.slice(0, 7) : null;
      months.push(m && m !== lastMonth ? MONTHS[Number(m.slice(5)) - 1] : '');
      if (m) lastMonth = m;
      const cellHtml = Array.from({ length: 7 }, (_, i) => {
        const c = col[i];
        if (!c) return '<div class="cell future"></div>';
        return `<div class="cell l${level(c.total)}" data-date="${c.date}"></div>`;
      }).join('');
      return `<div class="col">${cellHtml}</div>`;
    })
    .join('');

  $('heatmap').innerHTML =
    `<div class="heat-months">${months.map((m) => `<span>${m}</span>`).join('')}</div>` +
    `<div class="heat">${colHtml}</div>`;

  const byDate = new Map(series.map((x) => [x.date, x]));
  $('heatmap').addEventListener('mousemove', (e) => {
    const cell = e.target.closest('.cell[data-date]');
    if (!cell) {
      hideTip();
      return;
    }
    const day = byDate.get(cell.dataset.date);
    showTip(e, tipHtml(niceDate(day.date), bucketTipRows(day)));
  });
  $('heatmap').addEventListener('mouseleave', hideTip);
}

/* ---------------------------------------------------------------- *
 * rhythm
 * ---------------------------------------------------------------- */

function renderRhythm() {
  const d = state.data;
  const typeParts = (b) => TYPE_SERIES.map((s) => ({ color: s.color, value: b[s.key] }));

  drawColumns(
    $('hourChart'),
    d.hours.map((h) => {
      const hh = String(h.hour).padStart(2, '0');
      return { label: hh, tipHtml: tipHtml(`${hh}:00 – ${hh}:59`, bucketTipRows(h)), parts: typeParts(h), total: h.total };
    }),
    { height: 150, labelWidth: 22 }
  );

  drawColumns(
    $('weekChart'),
    d.weekdays.map((w) => ({
      label: WEEKDAYS[w.day],
      tipHtml: tipHtml(WEEKDAYS[w.day], bucketTipRows(w)),
      parts: typeParts(w),
      total: w.total,
    })),
    { height: 150, labelWidth: 30 }
  );
}

/* ---------------------------------------------------------------- *
 * KPIs
 * ---------------------------------------------------------------- */

function deltaHtml(cur, prev, fmtFn) {
  // No comparison for ALL, or when the previous window has no data at all.
  if (!state.data.previous || !state.data.previous.total) return '';
  if (!prev) return cur ? `<div class="delta up">new · prev 0</div>` : '';
  const ratio = cur / prev - 1;
  const cls = Math.abs(ratio) < 0.02 ? 'flat' : ratio > 0 ? 'up' : 'down';
  const sign = ratio > 0 ? '+' : '';
  return `<div class="delta ${cls}">${sign}${(ratio * 100).toFixed(0)}% vs prev · ${fmtFn(prev)}</div>`;
}

function renderKpis() {
  const d = state.data;
  const t = d.totals;
  const p = d.previous || {};
  const cards = [
    { k: 'Total tokens', v: fmt(t.total), s: full(t.total), delta: deltaHtml(t.total, p.total, fmt), hero: true },
    { k: 'Est. cost', v: money(t.cost), s: money(d.costPerActiveDay) + ' per active day', delta: deltaHtml(t.cost, p.cost, money) },
    { k: 'Output', v: fmt(t.output), s: fmt(t.thinking) + ' thinking', delta: deltaHtml(t.output, p.output, fmt) },
    { k: 'Cache hit rate', v: pct(d.cacheHitRate), s: 'of prompt tokens served from cache' },
    { k: 'Messages', v: full(t.messages), s: full(d.sessionCount) + ' sessions', delta: deltaHtml(t.messages, p.messages, full) },
    { k: 'Active days', v: full(d.activeDays), s: fmt(d.avgPerActiveDay) + ' tok/day avg' },
    { k: 'Input', v: fmt(t.input), s: 'uncached input' },
    { k: 'Cache write', v: fmt(t.cacheWrite), s: fmt(t.cacheRead) + ' cache read' },
  ];
  $('kpis').innerHTML = cards
    .map(
      (c) =>
        `<div class="kpi${c.hero ? ' hero' : ''}"><div class="k">${esc(c.k)}</div>` +
        `<div class="v">${esc(c.v)}</div><div class="s">${esc(c.s || '')}</div>${c.delta || ''}</div>`
    )
    .join('');
}

/* ---------------------------------------------------------------- *
 * panels
 * ---------------------------------------------------------------- */

function renderBestDays() {
  const d = state.data;
  const host = $('bestDays');
  if (!d.bestDays.length) {
    host.innerHTML = '<p class="empty">No activity in this range.</p>';
    return;
  }
  const max = d.bestDays[0].total || 1;
  const medals = ['🥇', '🥈', '🥉'];
  host.innerHTML = d.bestDays
    .map((day, i) => {
      const w = ((day.total / max) * 100).toFixed(1);
      const topProj = Object.entries(day.byProject || {}).sort((a, b) => b[1].total - a[1].total)[0];
      return (
        `<div class="bd${i < 3 ? ' top' : ''}">` +
        `<div class="track" style="width:${w}%"></div>` +
        `<div class="rank">${medals[i] || '#' + (i + 1)}</div>` +
        `<div class="meta"><div class="d">${esc(niceDate(day.date))}</div>` +
        `<div class="sm">${full(day.messages)} msgs · ${full(day.sessions)} sessions · ${fmt(day.output)} out` +
        (topProj ? ` · mostly ${esc(topProj[0])}` : '') +
        `</div></div>` +
        `<div class="amt"><b>${fmt(day.total)}</b><div class="sm">${money(day.cost)}</div></div>` +
        `</div>`
      );
    })
    .join('');
}

function breakdownTable(host, list, opts) {
  const o = Object.assign({ subKey: null, empty: 'Nothing here yet.' }, opts || {});
  if (!list.length) {
    host.innerHTML = `<p class="empty">${esc(o.empty)}</p>`;
    return;
  }
  const max = Math.max(...list.map((r) => r.total)) || 1;
  const grand = state.data.totals.total || 1;
  const rows = list
    .map((r) => {
      const w = ((r.total / max) * 100).toFixed(1);
      const sub = o.subKey && r[o.subKey] ? `<div class="sm hint">${esc(r[o.subKey])}</div>` : '';
      return (
        `<tr>` +
        `<td class="rowbar"><div class="fill" style="width:${w}%"></div>` +
        `<div class="lbl name" title="${esc(r.title || r.name)}">${esc(r.name)}${sub}</div></td>` +
        `<td>${fmt(r.total)}</td><td>${pct(r.total / grand)}</td><td>${fmt(r.output)}</td>` +
        `<td>${fmt(r.cacheRead)}</td><td>${full(r.messages)}</td><td>${money(r.cost)}</td>` +
        `</tr>`
      );
    })
    .join('');
  host.innerHTML =
    `<table><thead><tr><th>${esc(o.nameHead || 'Name')}</th><th>Tokens</th><th>Share</th>` +
    `<th>Output</th><th>Cache read</th><th>Msgs</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderProjects() {
  const d = state.data;
  const list = d.projects.map((p) => {
    const n = p.cwds || 0;
    const sub = n > 1 ? `${p.path} · ${n} folders` : p.path;
    const title = n > 1 ? `${p.path}\n\nFolders in use:\n` + (p.cwdList || []).join('\n') : p.path;
    return Object.assign({}, p, { sub, title });
  });
  breakdownTable($('projects'), list, { nameHead: 'Project', subKey: 'sub' });
}

function ago(ts) {
  const h = (Date.now() - ts) / 3600000;
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm ago';
  if (h < 48) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function renderCompact() {
  const c = state.data.compact;
  const host = $('compact');
  const list = c.suggestions;
  const active = list.filter((s) => !s.idle).length;
  $('compactHint').textContent =
    `${list.length} of ${c.sessionsChecked} sessions carry ≥ ${fmt(c.threshold)} tokens of context` +
    (list.length ? ` · ${active} active, ${list.length - active} idle` : '') +
    ' · thresholds in config.json';

  if (!list.length) {
    host.innerHTML =
      `<p class="empty">Every session in this range is under ${fmt(c.threshold)} tokens of context. Nothing to compact.</p>`;
    return;
  }

  const byProject = new Map();
  for (const s of list) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }

  const ctxMax = 1e6; // 1M context window on current models
  host.innerHTML = [...byProject.entries()]
    .map(([project, items]) => {
      const cards = items
        .map((s) => {
          const title = s.title || s.session.slice(0, 8);
          const comp = s.compactions ? `<span class="badge">compacted ${s.compactions}×</span>` : '';
          const idle = s.idle ? `<span class="badge">idle ${Math.round(s.idleHours / 24)}d</span>` : '';
          // Share of each turn's cost that is just re-reading the discussion.
          const tax = s.costPerMsgNow ? Math.min(0.99, s.savePerMsg / s.costPerMsgNow) : 0;
          const growth = tax ? ` — ${Math.round(tax * 100)}% of it is re-reading context` : '';
          const since = s.markedAt
            ? `<div class="sm">counting since you marked it ${ago(s.markedAt)}</div>`
            : '';
          return (
            `<div class="cs${s.idle ? ' idle' : ''}" title="${esc(s.session)}">` +
            `<div><div class="t">${esc(title)}${comp}${idle}</div>` +
            `<div class="sm">${full(s.messages)} turns · last ${ago(s.lastActivity)} · ${esc(s.session.slice(0, 8))}</div>${since}</div>` +
            `<div><div class="big">${fmt(s.contextNow)}</div><div class="sm">context per turn · peak ${fmt(s.contextPeak)}</div>` +
            `<div class="meter"><i style="width:${Math.min(100, (s.contextNow / ctxMax) * 100).toFixed(1)}%"></i></div></div>` +
            `<div class="save"><div>${money(s.costPerMsgNow)} / turn now<span class="sm">${esc(growth)}</span></div>` +
            `<div class="sm">compact saves ≈ <b>${money(s.savePerMsg)}</b> / turn · <b>${money(s.saveNext50)}</b> over 50 turns</div></div>` +
            `<div class="act"><div class="cmd">/compact</div>` +
            `<button class="markbtn" data-mark="${esc(s.session)}">Compacted ✓</button></div>` +
            `</div>`
          );
        })
        .join('');
      return `<div class="cgroup"><h3 class="mini">${esc(project)} · ${items.length} session${items.length > 1 ? 's' : ''}</h3>${cards}</div>`;
    })
    .join('');

  if (c.marks && c.marks.length) {
    host.innerHTML +=
      `<div class="marklist"><span class="mini">Marked compacted</span>` +
      c.marks
        .map(
          (m) =>
            `<span class="markchip" title="${esc(m.session)}">` +
            `${esc((m.title || m.session.slice(0, 8)).slice(0, 44))} · ${ago(m.markedAt)} · ` +
            `${m.turnsSince ? full(m.turnsSince) + ' turns since' : 'no turns since'}` +
            `<button class="undo" data-unmark="${esc(m.session)}" title="Forget this mark and count the whole session again">undo</button></span>`
        )
        .join('') +
      `</div>`;
  }
}

async function markCompacted(session, clear) {
  try {
    const res = await fetch('/api/compact-mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clear ? { session, clear: true } : { session, ts: Date.now() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
  } catch (err) {
    $('status').className = 'status err';
    $('status').textContent = 'Could not save the mark: ' + err.message;
    return;
  }
  doFetch();
}

$('compact').addEventListener('click', (e) => {
  const mark = e.target.closest('[data-mark]');
  if (mark) {
    mark.disabled = true;
    mark.textContent = 'saving…';
    markCompacted(mark.dataset.mark, false);
    return;
  }
  const unmark = e.target.closest('[data-unmark]');
  if (unmark) {
    unmark.disabled = true;
    markCompacted(unmark.dataset.unmark, true);
  }
});

function renderSessions() {
  const d = state.data;
  const host = $('sessions');
  if (!d.sessions.length) {
    host.innerHTML = '<p class="empty">No sessions in this range.</p>';
    return;
  }
  const rows = d.sessions
    .map((s) => {
      const when = new Date(s.last).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const mins = Math.max(1, Math.round((s.last - s.first) / 60000));
      const span = mins >= 90 ? (mins / 60).toFixed(1) + 'h' : mins + 'm';
      const title = s.title || s.name.slice(0, 8);
      return (
        `<tr><td title="${esc(s.name)}${s.title ? '\n' + esc(s.title) : ''}">` +
        `<span class="title">${esc(title)}</span>` +
        `<div class="sm hint">${esc(s.project)} · ${when} · ${s.name.slice(0, 8)}</div></td>` +
        `<td>${fmt(s.total)}</td><td>${fmt(s.output)}</td><td>${full(s.messages)}</td>` +
        `<td>${fmt(s.contextNow)}</td><td>${span}</td><td>${money(s.cost)}</td></tr>`
      );
    })
    .join('');
  host.innerHTML =
    `<table><thead><tr><th>Session</th><th>Tokens</th><th>Output</th><th>Msgs</th><th title="Context size of the latest main-thread turn">Ctx now</th><th>Span</th><th>Cost</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

function renderScanInfo() {
  const s = state.data.scan;
  const gen = new Date(state.data.generatedAt).toLocaleTimeString();
  $('scaninfo').innerHTML =
    `${s.files} transcript files (${(s.bytes / 1048576).toFixed(1)} MB) · ${s.records} usage records · ` +
    `${s.filesParsed} parsed / ${s.filesCached} cached · scan ${s.scanMs} ms · fetched ${gen} · ` +
    `roots: ${esc(s.roots.join(', '))} · press <kbd>R</kbd> to refetch`;
}

function renderAll() {
  const d = state.data;
  $('main').hidden = false; // charts need real layout widths
  renderKpis();
  renderCompact();
  renderDaily();
  renderHeatmap();
  renderRhythm();
  renderBestDays();
  renderProjects();
  breakdownTable($('agents'), d.agents, {
    nameHead: 'Agent',
    empty: 'No agent activity — every token came from the main thread.',
  });
  breakdownTable(
    $('agentRuns'),
    (d.agentRuns || []).map((r) => Object.assign({}, r, { path: r.agent + ' · ' + r.project })),
    { nameHead: 'Task', subKey: 'path', empty: 'No subagents were launched in this range.' }
  );
  breakdownTable($('models'), d.models, { nameHead: 'Model' });
  renderSessions();
  $('projCount').textContent = d.projects.length + ' project(s)';
  $('agentCount').textContent = d.agents.length + ' agent(s)';
  renderScanInfo();
  $('main').hidden = false;
}

/* ---------------------------------------------------------------- *
 * fetching
 * ---------------------------------------------------------------- */

async function doFetch() {
  if (state.busy) return;
  state.busy = true;
  const btn = $('fetch');
  btn.disabled = true;
  btn.textContent = 'SCANNING…';
  $('status').className = 'status';
  $('status').textContent = 'Reading transcripts…';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/usage?range=' + encodeURIComponent(state.range));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    state.data = body;
    renderAll();
    const label = RANGES.find((r) => r.id === state.range).label;
    $('status').textContent =
      `${label} · ${windowText(body)} · ${full(body.totals.total)} tokens · ${money(body.totals.cost)} estimated · ` +
      `${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    $('status').className = 'status err';
    $('status').textContent = 'Fetch failed: ' + err.message;
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = 'FETCH';
  }
}

/* ---------------------------------------------------------------- *
 * wiring
 * ---------------------------------------------------------------- */

function syncSeg(host, attr, value) {
  for (const el of host.children) el.classList.toggle('on', el.dataset[attr] === value);
}

function buildRanges() {
  $('ranges').innerHTML = RANGES.map((r) => `<button data-range="${r.id}">${r.label}</button>`).join('');
  syncSeg($('ranges'), 'range', state.range);
  $('csv').href = '/api/usage.csv?range=' + state.range;
  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.range = b.dataset.range;
    syncSeg($('ranges'), 'range', state.range);
    $('csv').href = '/api/usage.csv?range=' + state.range;
    savePrefs();
    doFetch();
  });
}

$('metricToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.metric = b.dataset.metric;
  syncSeg($('metricToggle'), 'metric', state.metric);
  savePrefs();
  if (state.data) renderDaily();
});

$('stackToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.stack = b.dataset.stack;
  syncSeg($('stackToggle'), 'stack', state.stack);
  savePrefs();
  if (state.data) renderDaily();
});

function applyCompactFold() {
  $('compactPanel').classList.toggle('closed', !state.compactOpen);
  $('compactToggle').setAttribute('aria-expanded', String(state.compactOpen));
}

$('compactToggle').addEventListener('click', () => {
  state.compactOpen = !state.compactOpen;
  applyCompactFold();
  savePrefs();
});

$('fetch').addEventListener('click', doFetch);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) doFetch();
});

loadPrefs();
buildRanges();
syncSeg($('metricToggle'), 'metric', state.metric);
syncSeg($('stackToggle'), 'stack', state.stack);
applyCompactFold();
doFetch();
