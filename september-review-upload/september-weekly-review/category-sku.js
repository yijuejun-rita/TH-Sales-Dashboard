(async function () {
  renderTopNav('nav', 'category-sku');
  let data;
  try {
    data = await loadSeptemberData();
  } catch (e) {
    document.getElementById('categoryTable').replaceWith(emptyState('Unable to load September review data: ' + e.message));
    return;
  }
  renderScopeBanner('scopeBanner');
  renderCoverageBanner('coverageBanner');
  initDataQualityDrawer(data.dataQuality);

  const cu = data.categoryUnits;
  const su = data.skuUnits;
  const total3ch = cu.total_3channel;
  const totalWowAbs = absChange(total3ch.w3, total3ch.w2);

  // ---------------- 品类表现 ----------------
  const catRows = cu.categories.map((c) => {
    const avg12 = avg2(c.w1, c.w2);
    return {
      ...c,
      vsAvgPct: pctChange(c.w3, avg12),
    };
  }).sort((a, b) => (b.w3 || 0) - (a.w3 || 0));

  const cThead = document.querySelector('#categoryTable thead');
  const cTbody = document.querySelector('#categoryTable tbody');
  cThead.innerHTML =
    '<tr><th>品类</th><th>W1 PCS</th><th>W2 PCS</th><th>W3 PCS</th><th>W3 vs W2</th><th>绝对变化 PCS</th><th>W3 vs (W1–W2平均)</th><th>W3 销量占比</th><th>对3渠道整体PCS变化的贡献</th></tr>';
  catRows.forEach((r) => {
    cTbody.appendChild(el('tr', {}, [
      el('td', { text: r.category }),
      el('td', { text: fmtPCS(r.w1) }),
      el('td', { text: fmtPCS(r.w2) }),
      el('td', { text: fmtPCS(r.w3) }),
      el('td', { class: 'chg ' + changeClass(r.w3_vs_w2_pct), text: fmtPct(r.w3_vs_w2_pct) }),
      el('td', { class: 'chg ' + changeClass(r.w3_vs_w2_abs), text: fmtSignedPCS(r.w3_vs_w2_abs) }),
      el('td', { class: 'chg ' + changeClass(r.vsAvgPct), text: fmtPct(r.vsAvgPct) }),
      el('td', { text: r.share_w3 === null ? 'N/A' : (r.share_w3 * 100).toFixed(1) + '%' }),
      el('td', { class: 'chg ' + changeClass(r.contribution_to_total_change), text: r.contribution_to_total_change === null ? 'N/A' : fmtPct(r.contribution_to_total_change) }),
    ]));
  });

  const barCtx = document.getElementById('categoryBarChart').getContext('2d');
  new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: catRows.map((r) => r.category),
      datasets: [{
        label: 'Sep W3 Units (PCS)',
        data: catRows.map((r) => Math.round(r.w3 || 0)),
        backgroundColor: '#c2660c',
        valueLabelFormatter: (v) => Math.round(v).toLocaleString('en-US') + ' PCS',
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 60 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtPCS(c.parsed.x) } } },
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } } },
    },
  });

  // ---------------- SKU 驱动分析 ----------------
  const categoryFilterSel = document.getElementById('categoryFilterSel');
  const skuSearch = document.getElementById('skuSearch');
  categoryFilterSel.appendChild(el('option', { value: '__all__', text: 'All Categories' }));
  catRows.forEach((c) => categoryFilterSel.appendChild(el('option', { value: c.category, text: c.category })));
  categoryFilterSel.value = '__all__';
  categoryFilterSel.addEventListener('change', renderSkuTable);
  skuSearch.addEventListener('input', renderSkuTable);

  function renderSkuTable() {
    const catFilter = categoryFilterSel.value;
    const q = skuSearch.value.trim().toLowerCase();
    const thead = document.querySelector('#skuTable thead');
    const tbody = document.querySelector('#skuTable tbody');
    thead.innerHTML =
      '<tr><th>Barcode</th><th>SKU</th><th>品类</th><th>W1 PCS</th><th>W2 PCS</th><th>W3 PCS</th><th>W3 vs W2</th><th>绝对变化 PCS</th><th>对品类变化的贡献</th><th>Beautrium Δ</th><th>Eveandboy Δ</th><th>KIS Δ</th></tr>';
    tbody.innerHTML = '';

    let rows = su.skus
      .filter((s) => catFilter === '__all__' || s.category === catFilter)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.barcodes.some((b) => b.includes(q)));
    rows = rows.slice().sort((a, b) => Math.abs(b.w3_vs_w2_abs || 0) - Math.abs(a.w3_vs_w2_abs || 0));

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 12;
      td.innerHTML = '<div class="empty-state">没有匹配的 SKU。</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    rows.forEach((s) => {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: s.barcodes.join(', ') || 'N/A' }),
        el('td', { text: s.name }),
        el('td', { text: s.category || '(未分类)' }),
        el('td', { text: fmtPCS(s.w1) }),
        el('td', { text: fmtPCS(s.w2) }),
        el('td', { text: fmtPCS(s.w3) }),
        el('td', { class: 'chg ' + changeClass(s.w3_vs_w2_pct), text: fmtPct(s.w3_vs_w2_pct) }),
        el('td', { class: 'chg ' + changeClass(s.w3_vs_w2_abs), text: fmtSignedPCS(s.w3_vs_w2_abs) }),
        el('td', { class: 'chg ' + changeClass(s.contribution_to_category_change), text: s.contribution_to_category_change === null ? 'N/A' : fmtPct(s.contribution_to_category_change) }),
        el('td', { class: 'chg ' + changeClass(s.by_channel_change.Beautrium), text: fmtSignedPCS(s.by_channel_change.Beautrium) }),
        el('td', { class: 'chg ' + changeClass(s.by_channel_change.Eveandboy), text: fmtSignedPCS(s.by_channel_change.Eveandboy) }),
        el('td', { class: 'chg ' + changeClass(s.by_channel_change.KIS), text: fmtSignedPCS(s.by_channel_change.KIS) }),
      ]));
    });
  }
  renderSkuTable();

  // ---------------- Data Quality (sku_mapping + coverage) ----------------
  const dqBox = document.getElementById('skuDqPanel');
  const relevantDq = (data.dataQuality.items || []).filter((it) => ['sku_mapping', 'coverage'].includes(it.category));
  if (!relevantDq.length) dqBox.appendChild(emptyState('本次同步未发现品类/SKU层面的数据质量问题。'));
  relevantDq
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
    .forEach((it) => dqBox.appendChild(dqItemEl(it)));

  document.getElementById('footerNote').textContent =
    `数据来源: Beautrium + Eveandboy + KIS 渠道SKU周度表（QTY列）· 单位 PCS · ${su.meta.coverage} · ETL 运行时间: ${new Date(su.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })}`;
})();
