(async function () {
  renderTopNav('nav', 'exec');
  let data;
  try {
    data = await loadSeptemberData();
  } catch (e) {
    document.getElementById('kpiRow').appendChild(emptyState('Unable to load September review data: ' + e.message));
    return;
  }
  renderScopeBanner('scopeBanner');
  initDataQualityDrawer(data.dataQuality);

  const cv = data.channelValue;
  const ov = cv.overall;
  const w1 = ov.w1, w2 = ov.w2, w3 = ov.w3;
  const avg12 = avg2(w1, w2);
  const wowAbs = absChange(w3, w2);
  const wowPct = pctChange(w3, w2);
  const vsAvgAbs = absChange(w3, avg12);
  const vsAvgPct = pctChange(w3, avg12);

  function kpiCard(labelHtml, value, changeVal, sub) {
    const labelP = el('p', { class: 'label' });
    labelP.innerHTML = labelHtml;
    const card = el('div', { class: 'kpi' }, [labelP, el('p', { class: 'value', text: value })]);
    if (changeVal !== null && changeVal !== undefined) {
      card.appendChild(el('p', { class: 'change ' + changeClass(changeVal), text: (changeVal >= 0 ? '▲ ' : '▼ ') + fmtPct(changeVal) }));
    }
    if (sub) card.appendChild(el('p', { class: 'base', text: sub }));
    return card;
  }

  const kpiRow = document.getElementById('kpiRow');
  kpiRow.appendChild(kpiCard(`W1–W3 累计销售额 ${unitBadge('THB')}`, fmtTHB(ov.cum), null, 'Sep W1 + W2 + W3（并非完整9月月度总额）'));
  kpiRow.appendChild(kpiCard(`Sep W3 销售额 ${unitBadge('THB')}`, fmtTHB(w3), null, '店铺销量口径，渠道 Total 行汇总'));
  kpiRow.appendChild(kpiCard('W3 vs W2', fmtPct(wowPct), wowPct, `${fmtSignedTHB(wowAbs)} · 基准 W2 = ${fmtTHB(w2)}`));
  kpiRow.appendChild(kpiCard('W3 vs (W1–W2平均)', fmtPct(vsAvgPct), vsAvgPct, `${fmtSignedTHB(vsAvgAbs)} · 基准 = ${fmtTHB(avg12)}`));

  // ---- trend chart: exactly 3 points, W3 highlighted, avg12 reference line, no fill/smoothing/dual-axis ----
  const labels = ['Sep W1', 'Sep W2', 'Sep W3'];
  const values = [w1, w2, w3];
  const pointColors = ['#c3c2b7', '#c3c2b7', '#2a78d6'];
  const pointRadii = [5, 5, 7];

  const ctx = document.getElementById('trendChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Sales Value (THB)',
          data: values,
          borderColor: '#2a78d6',
          backgroundColor: '#2a78d6',
          fill: false,
          tension: 0,
          pointBackgroundColor: pointColors,
          pointRadius: pointRadii,
          pointHoverRadius: 9,
          valueLabelFormatter: (v) => '฿' + Math.round(v).toLocaleString('en-US'),
        },
        {
          label: `W1–W2 avg (฿${Math.round(avg12).toLocaleString('en-US')})`,
          data: [avg12, avg12, avg12],
          borderColor: '#a9a89d',
          borderDash: [5, 4],
          fill: false,
          pointRadius: 0,
          borderWidth: 1.5,
          hideValueLabels: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? 'N/A' : fmtTHB(c.parsed.y)}`,
          },
        },
      },
      scales: {
        y: { beginAtZero: false, ticks: { callback: (v) => v.toLocaleString('en-US') } },
        x: { grid: { display: false } },
      },
    },
  });

  // ---- channel overview table + sorted bar chart ----
  const channels = Object.keys(cv.channels);
  const rows = channels
    .map((ch) => {
      const c = cv.channels[ch];
      return {
        ch,
        w3: c.w3,
        w3Share: share(c.w3, ov.w3),
        wowAbs: absChange(c.w3, c.w2),
        wowPct: pctChange(c.w3, c.w2),
        cum: c.cum,
        cumShare: share(c.cum, ov.cum),
      };
    })
    .sort((a, b) => (b.w3 || 0) - (a.w3 || 0));

  const thead = document.querySelector('#channelTable thead');
  const tbody = document.querySelector('#channelTable tbody');
  thead.innerHTML =
    '<tr><th>渠道</th><th>Sep W3 销量 THB</th><th>W3 销量占比</th><th>W3 vs W2</th><th>绝对变化 THB</th><th>W1–W3 累计 THB</th><th>累计占比</th></tr>';
  rows.forEach((r) => {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: r.ch }),
        el('td', { text: fmtTHB(r.w3) }),
        el('td', { text: r.w3Share === null ? 'N/A' : (r.w3Share * 100).toFixed(1) + '%' }),
        el('td', { class: 'chg ' + changeClass(r.wowPct), text: fmtPct(r.wowPct) }),
        el('td', { class: 'chg ' + changeClass(r.wowAbs), text: fmtSignedTHB(r.wowAbs) }),
        el('td', { text: fmtTHB(r.cum) }),
        el('td', { text: r.cumShare === null ? 'N/A' : (r.cumShare * 100).toFixed(1) + '%' }),
      ])
    );
  });

  const barCtx = document.getElementById('channelBarChart').getContext('2d');
  new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.ch),
      datasets: [{
        label: 'Sep W3 Sales (THB)',
        data: rows.map((r) => Math.round(r.w3 || 0)),
        backgroundColor: '#2a78d6',
        valueLabelFormatter: (v) => '฿' + Math.round(v).toLocaleString('en-US'),
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 60 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtTHB(c.parsed.x) } } },
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } } },
    },
  });

  // ---- Weekly Key Findings (from key_findings.json -- not recomputed here) ----
  const list = document.getElementById('findingsList');
  (data.keyFindings.findings || []).slice(0, 5).forEach((f) => list.appendChild(el('li', { text: f })));
  if (!(data.keyFindings.findings || []).length) list.appendChild(el('li', { text: '暂无可用结论。' }));

  document.getElementById('footerNote').textContent =
    `数据来源: 店铺销量（整体/渠道，THB）· ETL 运行时间: ${new Date(data.channelValue.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })} (Asia/Bangkok) · 源文件本身不含数据更新时间字段，详见 Data Quality。`;
})();
