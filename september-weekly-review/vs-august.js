(async function () {
  renderTopNav('nav', 'vs-august');
  let data;
  try {
    data = await loadSeptemberData();
  } catch (e) {
    document.getElementById('kpiRow').appendChild(emptyState('Unable to load review data: ' + e.message));
    return;
  }
  renderScopeBanner('scopeBanner');

  const ac = data.augustComparison;
  if (!ac) {
    document.getElementById('kpiRow').appendChild(emptyState('august_comparison.json not found — run `npm run refresh-data` followed by `python3 etl/september_review/build_august_comparison.py "<source file>"`.'));
    return;
  }

  const combinedDq = { items: [...(data.dataQuality.items || []), ...(ac.data_quality_additions || [])] };
  initDataQualityDrawer(combinedDq);

  const methodBox = document.getElementById('methodBanner');
  methodBox.appendChild(
    el('div', { class: 'scope-banner coverage' }, [
      el('strong', { text: '口径说明' }),
      el('span', { text: `— 8月有完整${ac.meta.aug_weeks}周数据，9月目前只有${ac.meta.sep_weeks}周，直接比总额会失真，所以下面所有"变化"都按周均口径（期间总额 ÷ 周数）计算；原始总额仅作参考展示。` }),
    ])
  );

  // ---------------- KPI cards ----------------
  function kpiCard(label, value, changeVal, sub) {
    const card = el('div', { class: 'kpi' }, [el('p', { class: 'label', html: label }), el('p', { class: 'value', text: value })]);
    if (changeVal !== null && changeVal !== undefined) {
      card.appendChild(el('p', { class: 'change ' + changeClass(changeVal), text: (changeVal >= 0 ? '▲ ' : '▼ ') + fmtPct(changeVal) }));
    }
    if (sub) card.appendChild(el('p', { class: 'base', text: sub }));
    return card;
  }

  const kpiRow = document.getElementById('kpiRow');
  kpiRow.appendChild(kpiCard(
    `整体周均销售额变化 ${unitBadge('THB')}`, fmtPct(ac.overall.weekly_pace_change_pct), ac.overall.weekly_pace_change_pct,
    `8月周均 ${fmtTHB(ac.overall.aug_weekly_pace)} → 9月周均 ${fmtTHB(ac.overall.sep_weekly_pace)}`
  ));
  kpiRow.appendChild(kpiCard(
    `3渠道品类周均量变化 ${unitBadge('PCS')}`, fmtPct(ac.total_3channel.weekly_pace_change_pct), ac.total_3channel.weekly_pace_change_pct,
    `8月周均 ${fmtPCS(ac.total_3channel.aug_weekly_pace)} → 9月周均 ${fmtPCS(ac.total_3channel.sep_weekly_pace)}`
  ));
  const chRows = Object.entries(ac.channels).map(([ch, v]) => ({ ch, ...v }));
  const worstCh = chRows.slice().sort((a, b) => (a.weekly_pace_change_pct ?? 0) - (b.weekly_pace_change_pct ?? 0))[0];
  const bestCh = chRows.slice().sort((a, b) => (b.weekly_pace_change_pct ?? -1) - (a.weekly_pace_change_pct ?? -1))[0];
  kpiRow.appendChild(kpiCard('降幅最大渠道', `${worstCh.ch} ${fmtPct(worstCh.weekly_pace_change_pct)}`, worstCh.weekly_pace_change_pct, `8月周均 ${fmtTHB(worstCh.aug_weekly_pace)} → 9月周均 ${fmtTHB(worstCh.sep_weekly_pace)}`));
  kpiRow.appendChild(kpiCard('最抗跌渠道', `${bestCh.ch} ${fmtPct(bestCh.weekly_pace_change_pct)}`, bestCh.weekly_pace_change_pct, `8月周均 ${fmtTHB(bestCh.aug_weekly_pace)} → 9月周均 ${fmtTHB(bestCh.sep_weekly_pace)}`));

  // ---------------- channel chart + table ----------------
  const chSorted = chRows.slice().sort((a, b) => (b.sep_weekly_pace || 0) - (a.sep_weekly_pace || 0));
  const chCtx = document.getElementById('channelPaceChart').getContext('2d');
  new Chart(chCtx, {
    type: 'bar',
    data: {
      labels: chSorted.map((r) => r.ch),
      datasets: [
        { label: '8月周均 (THB/周)', data: chSorted.map((r) => Math.round(r.aug_weekly_pace || 0)), backgroundColor: '#c3c2b7', valueLabelFormatter: (v) => '฿' + Math.round(v).toLocaleString('en-US') },
        { label: '9月周均 (THB/周)', data: chSorted.map((r) => Math.round(r.sep_weekly_pace || 0)), backgroundColor: '#2a78d6', valueLabelFormatter: (v) => '฿' + Math.round(v).toLocaleString('en-US') },
      ],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 60 } },
      plugins: { legend: { display: true, position: 'bottom' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtTHB(c.parsed.x)}` } } },
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } } },
    },
  });

  const cThead = document.querySelector('#channelTable thead');
  const cTbody = document.querySelector('#channelTable tbody');
  cThead.innerHTML = '<tr><th>渠道</th><th>8月总额</th><th>8月周均</th><th>9月W1–3总额</th><th>9月周均</th><th>周均变化</th></tr>';
  chSorted.forEach((r) => {
    cTbody.appendChild(el('tr', {}, [
      el('td', { text: r.ch }),
      el('td', { text: fmtTHB(r.aug_total) }),
      el('td', { text: fmtTHB(r.aug_weekly_pace) }),
      el('td', { text: fmtTHB(r.sep_total) }),
      el('td', { text: fmtTHB(r.sep_weekly_pace) }),
      el('td', { class: 'chg ' + changeClass(r.weekly_pace_change_pct), text: fmtPct(r.weekly_pace_change_pct) }),
    ]));
  });

  // ---------------- category chart + table ----------------
  const catSorted = ac.categories.slice().sort((a, b) => (b.sep_weekly_pace || 0) - (a.sep_weekly_pace || 0));
  const catCtx = document.getElementById('categoryPaceChart').getContext('2d');
  new Chart(catCtx, {
    type: 'bar',
    data: {
      labels: catSorted.map((r) => r.category),
      datasets: [
        { label: '8月周均 (PCS/周)', data: catSorted.map((r) => +(r.aug_weekly_pace || 0).toFixed(1)), backgroundColor: '#e3c9a8', valueLabelFormatter: (v) => v.toFixed(1) },
        { label: '9月周均 (PCS/周)', data: catSorted.map((r) => +(r.sep_weekly_pace || 0).toFixed(1)), backgroundColor: '#c2660c', valueLabelFormatter: (v) => v.toFixed(1) },
      ],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 60 } },
      plugins: { legend: { display: true, position: 'bottom' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtPCS(c.parsed.x)}` } } },
      scales: { x: { beginAtZero: true } },
    },
  });

  const catThead = document.querySelector('#categoryTable thead');
  const catTbody = document.querySelector('#categoryTable tbody');
  catThead.innerHTML = '<tr><th>品类</th><th>8月总量</th><th>8月周均</th><th>9月W1–3总量</th><th>9月周均</th><th>周均变化</th></tr>';
  catSorted.forEach((r) => {
    catTbody.appendChild(el('tr', {}, [
      el('td', { text: r.category }),
      el('td', { text: fmtPCS(r.aug_total) }),
      el('td', { text: fmtPCS(r.aug_weekly_pace) }),
      el('td', { text: fmtPCS(r.sep_total) }),
      el('td', { text: fmtPCS(r.sep_weekly_pace) }),
      el('td', { class: 'chg ' + changeClass(r.weekly_pace_change_pct), text: fmtPct(r.weekly_pace_change_pct) }),
    ]));
  });

  // ---------------- SKU table ----------------
  const skuSearch = document.getElementById('skuSearch');
  skuSearch.addEventListener('input', renderSkuTable);
  function renderSkuTable() {
    const q = skuSearch.value.trim().toLowerCase();
    const thead = document.querySelector('#skuTable thead');
    const tbody = document.querySelector('#skuTable tbody');
    thead.innerHTML = '<tr><th>Barcode</th><th>SKU</th><th>品类</th><th>8月周均</th><th>9月周均</th><th>周均变化</th><th>周均绝对变化</th></tr>';
    tbody.innerHTML = '';
    let rows = ac.skus.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.barcodes || []).some((b) => b.includes(q)));
    rows = rows.slice().sort((a, b) => Math.abs(b.weekly_pace_change_abs || 0) - Math.abs(a.weekly_pace_change_abs || 0));
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.innerHTML = '<div class="empty-state">没有匹配的 SKU。</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach((s) => {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: (s.barcodes || []).join(', ') || 'N/A' }),
        el('td', { text: s.name }),
        el('td', { text: s.category || '(未分类)' }),
        el('td', { text: fmtPCS(s.aug_weekly_pace) }),
        el('td', { text: fmtPCS(s.sep_weekly_pace) }),
        el('td', { class: 'chg ' + changeClass(s.weekly_pace_change_pct), text: fmtPct(s.weekly_pace_change_pct) }),
        el('td', { class: 'chg ' + changeClass(s.weekly_pace_change_abs), text: fmtSignedPCS(s.weekly_pace_change_abs) }),
      ]));
    });
  }
  renderSkuTable();

  // ---------------- data quality (comparison-specific) ----------------
  const dqBox = document.getElementById('compareDqPanel');
  const relevant = (ac.data_quality_additions || []);
  if (!relevant.length) dqBox.appendChild(emptyState('本对比未产生专属数据质量提示。'));
  relevant.sort((a, b) => sevRank(b.severity) - sevRank(a.severity)).forEach((it) => dqBox.appendChild(dqItemEl(it)));

  document.getElementById('footerNote').textContent =
    `口径: ${ac.meta.basis} · 8月${ac.meta.aug_weeks}周 vs 9月${ac.meta.sep_weeks}周 · ETL 运行时间: ${new Date(ac.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })}`;
})();
