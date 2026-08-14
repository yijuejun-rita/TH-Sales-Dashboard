(async function () {
  renderTopNav('nav', 'category-sku');
  let data;
  try {
    data = await loadWeeklyData();
  } catch (e) {
    document.getElementById('categoryTable').replaceWith(emptyState('Unable to load weekly data: ' + e.message));
    return;
  }
  renderSyncStatus('syncStatus', data);

  const cw = completeWeeks(data);
  const weekSel = document.getElementById('weekSel');
  const drillCategorySel = document.getElementById('drillCategorySel');
  const skuSearch = document.getElementById('skuSearch');
  const skuSel = document.getElementById('skuSel');

  if (!cw.length) {
    document.getElementById('categoryTable').replaceWith(emptyState('No complete week is available yet.'));
    return;
  }
  cw.slice().reverse().forEach((w) => weekSel.appendChild(el('option', { value: w.week_key, text: weekLabel(w) })));
  weekSel.value = data.meta.latest_complete_week;

  const categories = Object.keys(data.category_weekly).sort();
  categories.forEach((c) => drillCategorySel.appendChild(el('option', { value: c, text: c })));

  // whole-SKU-basis series (sum across all categories) for "对SKU口径整体变化的贡献"
  const skuBasisTotal = {};
  Object.values(data.category_weekly).forEach((series) => {
    Object.entries(series).forEach(([wk, v]) => {
      skuBasisTotal[wk] = (skuBasisTotal[wk] || 0) + v;
    });
  });

  // per-SKU merged-channel series
  function skuMergedSeries(sku) {
    const s = {};
    Object.entries(sku.weekly_by_channel).forEach(([wk, byCh]) => {
      s[wk] = Object.values(byCh).reduce((a, b) => a + b, 0);
    });
    return s;
  }

  data.skus.slice().sort((a, b) => a.item.localeCompare(b.item)).forEach((sku) =>
    skuSel.appendChild(el('option', { value: sku.sku_key, text: sku.item.slice(0, 60) }))
  );

  weekSel.addEventListener('change', renderAll);
  drillCategorySel.addEventListener('change', renderSkuTable);
  skuSearch.addEventListener('input', renderSkuTable);
  skuSel.addEventListener('change', renderSkuChannel);

  let catBarChart = null;
  let skuChChart = null;

  function renderCategoryTable() {
    const weekKey = weekSel.value;
    const totalM = computeWeekMetric(skuBasisTotal, data, weekKey);
    const rows = categories.map((cat) => {
      const m = computeWeekMetric(data.category_weekly[cat], data, weekKey);
      const shr = share(m.value, totalM.value);
      const contrib = contribution(m.wowAbs, totalM.wowAbs);
      return { cat, m, shr, contrib };
    });

    const thead = document.querySelector('#categoryTable thead');
    const tbody = document.querySelector('#categoryTable tbody');
    thead.innerHTML =
      '<tr><th>品类名称</th><th>本周销量PCS</th><th>上周销量PCS</th><th>过去3周平均PCS</th><th>WoW</th><th>vs过去3周平均</th><th>绝对变化PCS</th><th>本周品类占比</th><th>对SKU口径整体变化的贡献</th></tr>';
    tbody.innerHTML = '';
    const sorted = rows.slice().sort((a, b) => (b.m.value || 0) - (a.m.value || 0));
    sorted.forEach((r) => {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: r.cat }),
          el('td', { text: fmtPCS(r.m.value) }),
          el('td', { text: fmtPCS(r.m.prevValue) }),
          el('td', { text: fmtPCS(r.m.avg3) }),
          el('td', { class: 'chg ' + changeClass(r.m.wowPct), text: fmtPct(r.m.wowPct) }),
          el('td', { class: 'chg ' + changeClass(r.m.vsAvg3Pct), text: fmtPct(r.m.vsAvg3Pct) }),
          el('td', { class: 'chg ' + changeClass(r.m.wowAbs), text: fmtSignedPCS(r.m.wowAbs) }),
          el('td', { text: r.shr === null ? 'N/A' : (r.shr * 100).toFixed(1) + '%' }),
          el('td', { text: r.contrib === null ? 'N/A' : fmtPct(r.contrib) }),
        ])
      );
    });

    const ctx = document.getElementById('categoryBarChart').getContext('2d');
    if (catBarChart) catBarChart.destroy();
    catBarChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: sorted.map((r) => r.cat), datasets: [{ label: 'Sales Volume (PCS)', data: sorted.map((r) => Math.round(r.m.value || 0)), backgroundColor: '#2a78d6' }] },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtPCS(c.parsed.x) } } },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } } },
      },
    });
  }

  function renderSkuTable() {
    const weekKey = weekSel.value;
    const category = drillCategorySel.value || categories[0];
    if (!drillCategorySel.value) drillCategorySel.value = category;
    const q = skuSearch.value.trim().toLowerCase();
    const catM = computeWeekMetric(data.category_weekly[category], data, weekKey);

    let rows = data.skus
      .filter((sku) => sku.category === category)
      .filter((sku) => !q || sku.item.toLowerCase().includes(q))
      .map((sku) => {
        const series = skuMergedSeries(sku);
        const m = computeWeekMetric(series, data, weekKey);
        const shr = share(m.value, catM.value);
        const contrib = contribution(m.wowAbs, catM.wowAbs);
        const last4 = cw.slice(Math.max(0, cw.findIndex((w) => w.week_key === weekKey) - 3), cw.findIndex((w) => w.week_key === weekKey) + 1).map((w) => (series[w.week_key] !== undefined ? series[w.week_key] : null));
        return { sku, m, shr, contrib, last4 };
      });

    rows.sort((a, b) => Math.abs(b.m.wowAbs || 0) - Math.abs(a.m.wowAbs || 0));

    const thead = document.querySelector('#skuTable thead');
    const tbody = document.querySelector('#skuTable tbody');
    thead.innerHTML =
      '<tr><th>SKU标准名称</th><th>Barcode</th><th>品类</th><th>本周销量</th><th>上周销量</th><th>过去3周平均</th><th>WoW</th><th>vs过去3周平均</th><th>绝对变化PCS</th><th>对品类变化的贡献</th><th>品类内占比</th><th>近4周趋势</th><th>状态</th></tr>';
    tbody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 13;
      td.innerHTML = '<div class="empty-state">没有匹配的SKU。</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach((r) => {
      const tr = el('tr', {}, [
        el('td', { text: r.sku.item.length > 50 ? r.sku.item.slice(0, 50) + '…' : r.sku.item }),
        el('td', { text: r.sku.barcodes.join(', ') || 'N/A' }),
        el('td', { text: r.sku.category }),
        el('td', { text: fmtPCS(r.m.value) }),
        el('td', { text: fmtPCS(r.m.prevValue) }),
        el('td', { text: fmtPCS(r.m.avg3) }),
        el('td', { class: 'chg ' + changeClass(r.m.wowPct), text: fmtPct(r.m.wowPct) }),
        el('td', { class: 'chg ' + changeClass(r.m.vsAvg3Pct), text: fmtPct(r.m.vsAvg3Pct) }),
        el('td', { class: 'chg ' + changeClass(r.m.wowAbs), text: fmtSignedPCS(r.m.wowAbs) }),
        el('td', { text: r.contrib === null ? 'N/A' : fmtPct(r.contrib) }),
        el('td', { text: r.shr === null ? 'N/A' : (r.shr * 100).toFixed(1) + '%' }),
      ]);
      const spark = document.createElement('td');
      spark.innerHTML = sparklineSvg(r.last4);
      tr.appendChild(spark);
      const statusTd = document.createElement('td');
      statusTd.innerHTML = r.m.value === null ? '<span class="badge severity-medium">无数据</span>' : '<span class="badge status-complete">正常</span>';
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    });
  }

  function sparklineSvg(values) {
    const w = 90, h = 26, pad = 3;
    const nums = values.filter((v) => v !== null && v !== undefined);
    if (!nums.length) return '<span class="empty-state" style="padding:2px 6px;">N/A</span>';
    const min = Math.min(...nums), max = Math.max(...nums), range = max - min || 1;
    const stepX = (w - pad * 2) / Math.max(1, values.length - 1);
    const points = [];
    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${points.join(' ')}" fill="none" stroke="#2a78d6" stroke-width="1.6"/></svg>`;
  }

  function renderSkuChannel() {
    const weekKey = weekSel.value;
    const sku = data.skus.find((s) => s.sku_key === skuSel.value) || data.skus[0];
    if (!sku) return;
    const mergedM = computeWeekMetric(skuMergedSeries(sku), data, weekKey);

    const rows = data.channels.map((ch) => {
      const series = {};
      Object.entries(sku.weekly_by_channel).forEach(([wk, byCh]) => {
        series[wk] = byCh[ch] || 0;
      });
      const m = computeWeekMetric(series, data, weekKey);
      const contrib = contribution(m.wowAbs, mergedM.wowAbs);
      return { ch, m, contrib };
    });

    const thead = document.querySelector('#skuChannelTable thead');
    const tbody = document.querySelector('#skuChannelTable tbody');
    thead.innerHTML = '<tr><th>渠道名称</th><th>本周SKU销量</th><th>上周SKU销量</th><th>过去3周平均</th><th>WoW</th><th>vs过去3周平均</th><th>绝对变化PCS</th><th>渠道对该SKU变化的贡献</th></tr>';
    tbody.innerHTML = '';
    rows
      .slice()
      .sort((a, b) => (b.m.value || 0) - (a.m.value || 0))
      .forEach((r) => {
        tbody.appendChild(
          el('tr', {}, [
            el('td', { text: r.ch }),
            el('td', { text: fmtPCS(r.m.value) }),
            el('td', { text: fmtPCS(r.m.prevValue) }),
            el('td', { text: fmtPCS(r.m.avg3) }),
            el('td', { class: 'chg ' + changeClass(r.m.wowPct), text: fmtPct(r.m.wowPct) }),
            el('td', { class: 'chg ' + changeClass(r.m.vsAvg3Pct), text: fmtPct(r.m.vsAvg3Pct) }),
            el('td', { class: 'chg ' + changeClass(r.m.wowAbs), text: fmtSignedPCS(r.m.wowAbs) }),
            el('td', { text: r.contrib === null ? 'N/A' : fmtPct(r.contrib) }),
          ])
        );
      });

    const ctx = document.getElementById('skuChannelChart').getContext('2d');
    if (skuChChart) skuChChart.destroy();
    const sorted = rows.slice().sort((a, b) => (b.m.value || 0) - (a.m.value || 0));
    skuChChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: sorted.map((r) => r.ch), datasets: [{ label: 'Sales Volume (PCS)', data: sorted.map((r) => Math.round(r.m.value || 0)), backgroundColor: '#2a78d6' }] },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtPCS(c.parsed.x) } } },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } } },
      },
    });
  }

  function renderSkuAlerts() {
    const weekKey = weekSel.value;
    const prevArr = precedingCompleteWeeks(data, weekKey, 2);
    const box = document.getElementById('skuAlerts');
    box.innerHTML = '';
    const alerts = [];

    data.skus.forEach((sku) => {
      const series = skuMergedSeries(sku);
      const m = computeWeekMetric(series, data, weekKey);
      if (!sku.barcodes.length) {
        alerts.push({ sev: 'medium', text: `SKU「${sku.item}」没有关联 Barcode（Barcode 未映射）。` });
      }
      if (m.value === null) return;
      if (m.wowPct !== null && m.wowPct < -0.3) {
        alerts.push({ sev: 'high', text: `SKU「${sku.item}」WoW ${fmtPct(m.wowPct)}，绝对变化 ${fmtSignedPCS(m.wowAbs)}。` });
      }
      if (m.vsAvg3Pct !== null && m.vsAvg3Pct < -0.3) {
        alerts.push({ sev: 'medium', text: `SKU「${sku.item}」vs过去3周平均 ${fmtPct(m.vsAvg3Pct)}，绝对变化 ${fmtSignedPCS(m.vsAvg3Abs)}。` });
      }
      if (m.value === 0 && m.avg3 !== null && m.avg3 > 0) {
        alerts.push({ sev: 'high', text: `SKU「${sku.item}」本周销量为 0 PCS，但过去3周平均为 ${fmtPCS(m.avg3)}。` });
      }
      // consecutive two-week decline
      if (prevArr.length === 2) {
        const v1 = seriesValue(series, prevArr[0].week_key);
        const v2 = seriesValue(series, prevArr[1].week_key);
        if (m.value !== null && v1 !== null && v2 !== null && m.value < v1 && v1 < v2) {
          alerts.push({ sev: 'medium', text: `SKU「${sku.item}」连续两周下降（${fmtPCS(v2)} → ${fmtPCS(v1)} → ${fmtPCS(m.value)}）。` });
        }
      }
      const firstIdx = cw.findIndex((w) => seriesValue(series, w.week_key) !== null);
      const thisIdx = cw.findIndex((w) => w.week_key === weekKey);
      if (firstIdx >= 0 && thisIdx === cw.length - 1 && firstIdx >= cw.length - 2) {
        alerts.push({ sev: 'low', text: `SKU「${sku.item}」是近期新出现的SKU（历史记录不足2周）。` });
      }
    });

    (data.data_quality.duplicate_barcodes || []).forEach((d) => {
      if (d.type === 'sku_has_multiple_barcodes') {
        alerts.push({ sev: 'info', text: `SKU「${d.sku}」对应多个 Barcode（${d.barcodes.join(', ')}），已合并计算总销量。` });
      } else if (d.type === 'barcode_maps_to_multiple_skus') {
        alerts.push({ sev: 'high', text: `Barcode「${d.barcode}」被映射到多个不同SKU（${d.skus.join(' / ')}），存在数据冲突，请核对源表。` });
      }
    });
    (data.data_quality.reconciliation || []).forEach((r) => {
      if (r.type === 'sku_total_missing_barcodes' || r.type === 'channel_sheets_missing_barcodes') {
        alerts.push({ sev: 'medium', text: r.detail });
      }
    });

    if (!alerts.length) {
      box.appendChild(emptyState('本周没有触发SKU预警条件。'));
      return;
    }
    alerts.forEach((a) => {
      box.appendChild(
        el('div', { class: 'dq-item' }, [el('span', { class: 'badge severity-' + a.sev, text: a.sev.toUpperCase() }), el('span', { class: 'dq-detail', text: a.text })])
      );
    });
  }

  function renderDQ() {
    const box = document.getElementById('dqPanel');
    box.innerHTML = '';
    const dq = data.data_quality;
    const all = [];
    Object.entries(dq).forEach(([cat, items]) => items.forEach((it) => all.push({ cat, ...it })));
    if (!all.length) {
      box.appendChild(emptyState('本次同步未发现数据质量问题。'));
      return;
    }
    all
      .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
      .forEach((it) => {
        box.appendChild(
          el('div', { class: 'dq-item' }, [
            el('span', { class: 'badge severity-' + (it.severity || 'info'), text: (it.severity || 'info').toUpperCase() }),
            el('span', { class: 'dq-detail', text: `[${it.cat}${it.week ? ' · ' + it.week : ''}] ${it.detail || JSON.stringify(it)}` }),
          ])
        );
      });
  }
  function sevRank(s) {
    return { high: 3, medium: 2, low: 1, info: 0 }[s] || 0;
  }

  function renderAll() {
    renderCategoryTable();
    renderSkuTable();
    renderSkuChannel();
    renderSkuAlerts();
  }

  skuSel.value = data.skus[0] ? data.skus[0].sku_key : '';
  renderAll();
  renderDQ();
  document.getElementById('footerNote').textContent = `数据来源: ${data.meta.sheet_mapping.channel_sheets.join('/')}（渠道SKU表汇总）· 最后同步: ${new Date(data.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })}`;
})();
