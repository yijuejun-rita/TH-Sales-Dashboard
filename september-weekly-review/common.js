/* Shared data loading + helpers for the September Weekly Review (Sep W1-W3,
 * month not closed). Mirrors etl/september_review/build_data.py output
 * exactly -- these 6 JSON files are the only source of truth; nothing here
 * recomputes a control total independently. */

const REVIEW_SCOPE_LABEL = 'September Weeks 1–3 | Month Not Closed';
const DATA_FILES = {
  channelValue: '../data/september/weekly_channel_value.json',
  storeValue: '../data/september/weekly_store_value.json',
  skuUnits: '../data/september/weekly_sku_units.json',
  categoryUnits: '../data/september/weekly_category_units.json',
  dataQuality: '../data/september/data_quality.json',
  keyFindings: '../data/september/key_findings.json',
  augustComparison: '../data/september/august_comparison.json',
};

async function loadSeptemberData() {
  const entries = Object.entries(DATA_FILES);
  const results = await Promise.all(
    entries.map(([, url]) => fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`${url} fetch failed: ${r.status}`);
      return r.json();
    }))
  );
  const out = {};
  entries.forEach(([key], i) => (out[key] = results[i]));
  return out;
}

// ---- null-safe metric primitives (same rules as weekly/common.js) ----
function safeDiv(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return a / b;
}
function pctChange(current, base) {
  const d = safeDiv(current, base);
  return d === null ? null : d - 1;
}
function absChange(current, base) {
  if (current === null || current === undefined || base === null || base === undefined) return null;
  return current - base;
}
function share(part, whole) {
  return safeDiv(part, whole);
}
function contribution(partChangeAbs, wholeChangeAbs) {
  if (partChangeAbs === null || partChangeAbs === undefined) return null;
  if (wholeChangeAbs === null || wholeChangeAbs === undefined || wholeChangeAbs === 0) return null;
  return partChangeAbs / wholeChangeAbs;
}
function avg2(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return (a + b) / 2;
}

// ---- formatting (THB vs PCS must never be mixed up) ----
function fmtTHB(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  return '฿' + Math.round(v).toLocaleString('en-US');
}
function fmtSignedTHB(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  const r = Math.round(v);
  const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
  return sign + '฿' + Math.abs(r).toLocaleString('en-US');
}
function fmtPCS(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-US') + ' PCS';
}
function fmtSignedPCS(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  const r = Math.round(v);
  const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
  return sign + Math.abs(r).toLocaleString('en-US') + ' PCS';
}
function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-US');
}
function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v) || !Number.isFinite(v)) return 'N/A';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return sign + Math.abs(pct).toFixed(digits) + '%';
}
function changeClass(v) {
  if (v === null || v === undefined) return 'neutral';
  return v > 0 ? 'up' : v < 0 ? 'down' : 'neutral';
}

// ---- DOM helpers ----
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}
function emptyState(msg) {
  return el('div', { class: 'empty-state', text: msg });
}
function unitBadge(unit) {
  return `<span class="unit-badge ${unit.toLowerCase()}">${unit}</span>`;
}

// ---- shared nav ----
function renderTopNav(containerId, currentPage) {
  const pages = [
    { href: '../index.html', label: '← All Dashboards', key: 'home' },
    { href: 'index.html', label: '① Executive Overview', key: 'exec' },
    { href: 'channel-store.html', label: '② Channel & Store', key: 'channel-store' },
    { href: 'category-sku.html', label: '③ Category & SKU', key: 'category-sku' },
    { href: 'vs-august.html', label: '④ vs August', key: 'vs-august' },
  ];
  const nav = el(
    'div',
    { class: 'top-nav' },
    pages.map((p) => el('a', { href: p.href, class: p.key === currentPage ? 'current' : '', text: p.label }))
  );
  document.getElementById(containerId).appendChild(nav);
}

function renderScopeBanner(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.appendChild(
    el('div', { class: 'scope-banner' }, [
      el('strong', { text: REVIEW_SCOPE_LABEL }),
      el('span', { text: '— covers Sep W1–W3 only, not a full-month close. Week boundaries follow the source workbook’s own "Sep Week 1/2/3" labels; no calendar dates are inferred.' }),
    ])
  );
}

function renderCoverageBanner(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.appendChild(
    el('div', { class: 'scope-banner coverage' }, [
      el('strong', { text: 'Coverage: 3 of 4 channels' }),
      el('span', { text: '| Konvy SKU weekly data missing — all Category & SKU figures below are Beautrium + Eveandboy + KIS only.' }),
    ])
  );
}

// ---- Data Quality drawer (shared across all 3 pages) ----
function sevRank(s) {
  return { high: 3, medium: 2, low: 1, info: 0 }[s] || 0;
}
function dqItemEl(it) {
  return el('div', { class: 'dq-item' }, [
    el('span', { class: 'badge severity-' + (it.severity || 'info'), text: (it.severity || 'info').toUpperCase() }),
    el('span', { class: 'dq-detail', text: `[${it.category || it.id}] ${it.detail}` }),
  ]);
}
function initDataQualityDrawer(dq) {
  const items = (dq && dq.items) || [];
  const overlay = el('div', { class: 'dq-drawer-overlay', id: 'dqOverlay' });
  const drawer = el('div', { class: 'dq-drawer', id: 'dqDrawer' });
  const body = el('div', { class: 'dq-drawer-body' });
  items
    .slice()
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
    .forEach((it) => body.appendChild(dqItemEl(it)));
  if (!items.length) body.appendChild(emptyState('No data quality notes recorded.'));
  drawer.appendChild(
    el('div', { class: 'dq-drawer-header' }, [
      el('h3', { text: `Data Quality (${items.length})` }),
      el('button', { class: 'dq-drawer-close', text: '×', onclick: () => closeDrawer() }),
    ])
  );
  drawer.appendChild(body);
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  const fab = el('button', { class: 'dq-fab', text: `⚠ Data Quality (${items.length})`, onclick: () => openDrawer() });
  document.body.appendChild(fab);

  function openDrawer() {
    overlay.classList.add('open');
    drawer.classList.add('open');
  }
  function closeDrawer() {
    overlay.classList.remove('open');
    drawer.classList.remove('open');
  }
  overlay.addEventListener('click', closeDrawer);
}

// ---- inline Chart.js plugin: draw the numeric value above/below each point
// or bar, since every chart on this review must show actual value labels. No
// external plugin dependency -- keeps the same single-CDN footprint as the
// rest of the site. ----
const valueLabelPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((ds, dsIndex) => {
      if (ds.hideValueLabels) return;
      const meta = chart.getDatasetMeta(dsIndex);
      if (meta.hidden) return;
      ctx.save();
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = ds.valueLabelColor || '#26251f';
      ctx.textAlign = 'center';
      meta.data.forEach((point, i) => {
        const raw = ds.data[i];
        if (raw === null || raw === undefined) return;
        const label = typeof ds.valueLabelFormatter === 'function' ? ds.valueLabelFormatter(raw) : Math.round(raw).toLocaleString('en-US');
        if (chart.config.type === 'bar' && chart.options.indexAxis === 'y') {
          ctx.textAlign = raw >= 0 ? 'left' : 'right';
          ctx.fillText(label, point.x + (raw >= 0 ? 6 : -6), point.y + 4);
        } else {
          ctx.fillText(label, point.x, point.y - 10);
        }
      });
      ctx.restore();
    });
  },
};
if (typeof Chart !== 'undefined') Chart.register(valueLabelPlugin);
