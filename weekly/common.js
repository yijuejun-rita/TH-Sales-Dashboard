/* Shared data loading + metric helpers for the 3 Weekly Dashboard pages.
 * Mirrors etl/metrics.py exactly (null/zero-safe, no NaN/Infinity ever
 * reaches the DOM) so the frontend and the ETL agree on every number. */

const DATA_URL = '../data/weekly_data.json';

async function loadWeeklyData() {
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('data fetch failed: ' + res.status);
  return res.json();
}

// ---- null-safe metric primitives (mirrors etl/metrics.py) ----
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
function avgOfWeeks(values) {
  const usable = values.filter((v) => v !== null && v !== undefined);
  if (!usable.length) return { avg: null, n: 0 };
  return { avg: usable.reduce((a, b) => a + b, 0) / usable.length, n: usable.length };
}
function share(part, whole) {
  return safeDiv(part, whole);
}
function contribution(partChangeAbs, wholeChangeAbs) {
  if (partChangeAbs === null || wholeChangeAbs === null || wholeChangeAbs === 0) return null;
  return partChangeAbs / wholeChangeAbs;
}

// ---- formatting ----
function fmtPCS(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-US') + ' PCS';
}
function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-US');
}
function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v) || !Number.isFinite(v)) return 'N/A';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '±';
  return sign + pct.toFixed(digits) + '%';
}
function fmtSignedPCS(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  const r = Math.round(v);
  const sign = r > 0 ? '+' : r < 0 ? '' : '±';
  return sign + r.toLocaleString('en-US') + ' PCS';
}
// The store-sales sheet ("店铺销量") has no PCS/quantity column at all -- every
// numeric column on it is Thai Baht sales VALUE (verified against the channel
// sheets' own "TTL Value" columns, see etl/build_json.py meta comment and
// README). So overall/channel/store figures are reported in THB; only
// SKU/category figures (sourced from the 4 channel sheets' QTY columns) are
// genuine PCS. Never label a THB number as PCS or vice versa.
function fmtTHB(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-US') + ' THB';
}
function fmtSignedTHB(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'N/A';
  const r = Math.round(v);
  const sign = r > 0 ? '+' : r < 0 ? '' : '±';
  return sign + r.toLocaleString('en-US') + ' THB';
}
function changeClass(v) {
  if (v === null || v === undefined) return 'neutral';
  return v > 0 ? 'up' : v < 0 ? 'down' : 'neutral';
}

// ---- week helpers ----
function weekLabel(w) {
  if (!w) return 'N/A';
  return `${w.month}月 W${w.week_idx} (${w.week_start.slice(5)}~${w.week_end.slice(5)})`;
}
function completeWeeks(data) {
  return data.weeks.filter((w) => w.status === 'complete').sort((a, b) => a.week_key.localeCompare(b.week_key));
}
function weekIndexMap(data) {
  const sorted = [...data.weeks].sort((a, b) => a.week_key.localeCompare(b.week_key));
  const map = {};
  sorted.forEach((w, i) => (map[w.week_key] = i));
  return { sorted, map };
}
// preceding N complete weeks strictly before `weekKey`, most-recent-first
function precedingCompleteWeeks(data, weekKey, n) {
  const cw = completeWeeks(data);
  const idx = cw.findIndex((w) => w.week_key === weekKey);
  if (idx <= 0) return [];
  return cw.slice(Math.max(0, idx - n), idx).reverse();
}

// ---- generic weekly-series lookup with source-scope awareness ----
function seriesValue(seriesObj, weekKey) {
  const v = seriesObj ? seriesObj[weekKey] : undefined;
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && 'value' in v) return v.value; // {value, source} shape (channel_weekly)
  return typeof v === 'number' ? v : null;
}

function computeWeekMetric(seriesObj, data, weekKey) {
  const value = seriesValue(seriesObj, weekKey);
  const prevWeeks = precedingCompleteWeeks(data, weekKey, 1);
  const prevValue = prevWeeks.length ? seriesValue(seriesObj, prevWeeks[0].week_key) : null;
  const avg3Weeks = precedingCompleteWeeks(data, weekKey, 3);
  const avg3Vals = avg3Weeks.map((w) => seriesValue(seriesObj, w.week_key));
  const { avg: avg3, n: avg3N } = avgOfWeeks(avg3Vals);
  return {
    value,
    prevValue,
    wowPct: pctChange(value, prevValue),
    wowAbs: absChange(value, prevValue),
    avg3,
    avg3N,
    avg3Insufficient: avg3N < 3,
    vsAvg3Pct: pctChange(value, avg3),
    vsAvg3Abs: absChange(value, avg3),
  };
}

// ---- DOM helpers ----
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
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

// ---- shared nav + sync-status header, injected on every weekly page ----
function renderTopNav(containerId, currentPage) {
  const pages = [
    { href: '../index.html', label: 'Monthly Dashboard', key: 'monthly' },
    { href: 'overview.html', label: '① Weekly Sales Overview', key: 'overview' },
    { href: 'channel-store.html', label: '② Channel & Store Performance', key: 'channel-store' },
    { href: 'category-sku.html', label: '③ Category & SKU Performance', key: 'category-sku' },
  ];
  const nav = el(
    'div',
    { class: 'top-nav' },
    pages.map((p) => el('a', { href: p.href, class: p.key === currentPage ? 'current' : '', text: p.label }))
  );
  document.getElementById(containerId).appendChild(nav);
}

function renderSyncStatus(containerId, data) {
  const meta = data.meta || {};
  const box = document.getElementById(containerId);
  if (!box) return;
  const failed = meta.sync_status === 'failed';
  const line1 = failed
    ? `⚠ Data sync failed at ${meta.sync_failed_at || 'unknown time'} — showing last successful data.`
    : `Last synced: ${meta.generated_at ? new Date(meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }) + ' (Asia/Bangkok)' : 'N/A'}`;
  const wk = (data.weeks || []).find((w) => w.week_key === meta.latest_complete_week);
  box.className = 'sync-status' + (failed ? ' failed' : '');
  box.innerHTML = '';
  box.appendChild(el('div', { text: line1 }));
  box.appendChild(el('div', { text: `Latest complete week: ${wk ? weekLabel(wk) : 'N/A'}` }));
}
