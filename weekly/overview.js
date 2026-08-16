(async function () {
  renderTopNav('nav', 'overview');
  let data;
  try {
    data = await loadWeeklyData();
  } catch (e) {
    document.getElementById('kpiRow').appendChild(emptyState('Unable to load weekly data: ' + e.message));
    return;
  }
  renderSyncStatus('syncStatus', data);

  const cw = completeWeeks(data);
  const weekSel = document.getElementById('weekSel');
  const channelSel = document.getElementById('channelSel');
  const categorySel = document.getElementById('categorySel');

  if (!cw.length) {
    document.getElementById('kpiRow').appendChild(emptyState('No complete week is available yet — every week in the sheet is still pending validation.'));
    return;
  }

  cw.slice().reverse().forEach((w) => weekSel.appendChild(el('option', { value: w.week_key, text: weekLabel(w) })));
  weekSel.value = data.meta.latest_complete_week;

  channelSel.appendChild(el('option', { value: '__all__', text: 'All Channels' }));
  data.channels.forEach((ch) => channelSel.appendChild(el('option', { value: ch, text: ch })));
  channelSel.value = '__all__';

  const categories = Object.keys(data.category_weekly).sort();
  categorySel.appendChild(el('option', { value: '__all__', text: 'All Categories' }));
  categories.forEach((c) => categorySel.appendChild(el('option', { value: c, text: c })));
  categorySel.value = '__all__';

  [weekSel, channelSel, categorySel].forEach((s) => s.addEventListener('change', render));

  // ---- category-scope series built live from data.skus (barcode-deduped already) ----
  function categorySeries(category, channel) {
    const series = {};
    data.skus.forEach((sku) => {
      if (category !== '__all__' && sku.category !== category) return;
      Object.entries(sku.weekly_by_channel).forEach(([wk, byCh]) => {
        let v;
        if (channel === '__all__') v = Object.values(byCh).reduce((a, b) => a + b, 0);
        else v = byCh[channel] || 0;
        series[wk] = (series[wk] || 0) + v;
      });
    });
    return series;
  }

  function storeCountForWeek(weekKey, channel) {
    let n = 0;
    data.stores.forEach((s) => {
      if (channel !== '__all__' && s.channel !== channel) return;
      const v = s.weekly[weekKey];
      if (v !== null && v !== undefined && v > 0) n++;
    });
    return n;
  }

  function render() {
    const weekKey = weekSel.value;
    const channel = channelSel.value;
    const category = categorySel.value;
    const categoryScope = category !== '__all__';

    const scopeNote = document.getElementById('scopeNote');
    scopeNote.innerHTML = '';
    // Store-sales sheet has NO PCS column -- every number on it is Thai Baht
    // VALUE (verified in etl/build_json.py / README). So store-basis KPIs are
    // THB; only the SKU-basis (category-filtered) view is genuine PCS.
    let seriesObj, basisLabel, fmt, fmtSigned, unitLabel;
    if (categoryScope) {
      seriesObj = categorySeries(category, channel);
      basisLabel = 'SKU sales source (channel sheets)';
      fmt = fmtPCS; fmtSigned = fmtSignedPCS; unitLabel = 'PCS';
      scopeNote.appendChild(el('div', { class: 'badge severity-medium', text: 'Category/SKU scope – based on SKU sales source (PCS)' }));
    } else if (channel !== '__all__') {
      seriesObj = data.channel_weekly[channel];
      basisLabel = `Store sales source (${data.meta.sheet_mapping.store_sheet}) — ${channel} only`;
      fmt = fmtTHB; fmtSigned = fmtSignedTHB; unitLabel = 'THB';
    } else {
      seriesObj = data.overall_weekly;
      basisLabel = `Store sales source (${data.meta.sheet_mapping.store_sheet})`;
      fmt = fmtTHB; fmtSigned = fmtSignedTHB; unitLabel = 'THB';
    }

    const m = computeWeekMetric(seriesObj, data, weekKey);
    const wk = data.weeks.find((w) => w.week_key === weekKey);

    const kpiRow = document.getElementById('kpiRow');
    kpiRow.innerHTML = '';
    kpiRow.appendChild(kpiCard(`本周整体销量 (${unitLabel})`, fmt(m.value), null, null));
    kpiRow.appendChild(
      kpiCard(
        '本周 vs 过去3周平均',
        fmtPct(m.vsAvg3Pct),
        m.vsAvg3Pct,
        `${fmtSigned(m.vsAvg3Abs)} · 基准 ${fmt(m.avg3)}${m.avg3Insufficient ? ` (仅${m.avg3N}周历史)` : ''}`
      )
    );
    kpiRow.appendChild(kpiCard('本周 vs 上周', fmtPct(m.wowPct), m.wowPct, `${fmtSigned(m.wowAbs)} · 基准 ${fmt(m.prevValue)}`));
    if (categoryScope) {
      kpiRow.appendChild(kpiCard('本周有效销售门店数', 'N/A', null, 'Category/SKU 口径下无门店维度，见 Channel & Store 页面'));
    } else {
      const storeCount = storeCountForWeek(weekKey, channel);
      kpiRow.appendChild(kpiCard('本周有效销售门店数', fmtNum(storeCount), null, '本周销量 > 0 的门店数（Konvy 无门店级数据，未计入）'));
    }

    document.getElementById('trendSubtitle').textContent =
      `口径来源: ${basisLabel} · 单位 ${unitLabel} · 最新完整周: ${wk ? wk.week_start + '~' + wk.week_end : 'N/A'} · 数据更新时间: ${data.meta.generated_at ? new Date(data.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }) : 'N/A'}`;

    renderTrend(seriesObj, weekKey, unitLabel);
    renderFindings();
  }

  let chartInstance = null;
  function renderTrend(seriesObj, highlightWeekKey, unitLabel) {
    const last16 = cw.slice(-16);
    if (!last16.length) {
      return;
    }
    const labels = last16.map((w) => `${w.month}月W${w.week_idx}`);
    const values = last16.map((w) => {
      const v = seriesValue(seriesObj, w.week_key);
      return v === null ? null : Math.round(v);
    });
    const avg3AtLatest = computeWeekMetric(seriesObj, data, highlightWeekKey).avg3;
    const pointColors = last16.map((w) => (w.week_key === highlightWeekKey ? '#2a78d6' : '#c3c2b7'));
    const pointRadii = last16.map((w) => (w.week_key === highlightWeekKey ? 6 : 3));

    const ctx = document.getElementById('trendChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `Sales Volume (${unitLabel})`,
            data: values,
            borderColor: '#2a78d6',
            backgroundColor: '#2a78d6',
            fill: false,
            tension: 0,
            spanGaps: true,
            pointBackgroundColor: pointColors,
            pointRadius: pointRadii,
            pointHoverRadius: 7,
          },
          avg3AtLatest !== null
            ? {
                label: 'Past-3-week avg (at selected week)',
                data: last16.map(() => Math.round(avg3AtLatest)),
                borderColor: '#a9a89d',
                borderDash: [5, 4],
                fill: false,
                pointRadius: 0,
                borderWidth: 1.5,
              }
            : null,
        ].filter(Boolean),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y === null ? 'N/A' : ctx.parsed.y.toLocaleString('en-US') + ' ' + unitLabel}`,
            },
          },
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  function kpiCard(label, value, changeVal, sub) {
    const card = el('div', { class: 'kpi' }, [el('p', { class: 'label', text: label }), el('p', { class: 'value', text: value })]);
    if (changeVal !== null && changeVal !== undefined) {
      card.appendChild(el('p', { class: 'change ' + changeClass(changeVal), text: (changeVal >= 0 ? '▲ ' : '▼ ') + fmtPct(changeVal) }));
    }
    if (sub) card.appendChild(el('p', { class: 'base', text: sub }));
    return card;
  }

  // ---------------- Weekly Key Findings (always at All/All scope; latest complete week) ----------------
  function renderFindings() {
    const list = document.getElementById('findingsList');
    list.innerHTML = '';
    const latest = data.meta.latest_complete_week;
    const prevArr = precedingCompleteWeeks(data, latest, 1);
    if (!latest || !prevArr.length) {
      list.appendChild(el('li', { text: '数据不足：目前可用完整周不足2周，暂时无法生成环比结论。' }));
      return;
    }
    const prev = prevArr[0].week_key;
    const findings = [];

    // 1. overall vs 3-week avg (store-sales basis = THB, sheet has no PCS column)
    const overallM = computeWeekMetric(data.overall_weekly, data, latest);
    if (overallM.value !== null && overallM.avg3 !== null) {
      const dir = overallM.vsAvg3Pct >= 0 ? '增长' : '下降';
      const absPct = (Math.abs(overallM.vsAvg3Pct) * 100).toFixed(1);
      findings.push(
        `本周店铺销量口径整体销量为 ${fmtNum(overallM.value)} THB，较过去3周平均${dir} ${absPct}%，${overallM.vsAvg3Abs >= 0 ? '增加' : '减少'} ${Math.abs(Math.round(overallM.vsAvg3Abs)).toLocaleString('en-US')} THB。`
      );
    } else {
      findings.push('整体销量：历史完整周不足3周，暂无法计算过去3周平均对比。');
    }

    // 2. channel with max abs WoW change (THB)
    let bestCh = null;
    data.channels.forEach((ch) => {
      const cm = computeWeekMetric(data.channel_weekly[ch], data, latest);
      if (cm.wowAbs === null) return;
      if (!bestCh || Math.abs(cm.wowAbs) > Math.abs(bestCh.wowAbs)) bestCh = { ch, ...cm };
    });
    if (bestCh) {
      findings.push(
        `${bestCh.ch} 本周销量较上周${bestCh.wowAbs >= 0 ? '增加' : '减少'} ${Math.abs(Math.round(bestCh.wowAbs)).toLocaleString('en-US')} THB，是渠道层面变化最大的来源。`
      );
    }

    // 3. store with max abs WoW change (THB; skip channels with no real store data)
    let bestStore = null;
    data.stores.forEach((s) => {
      const v = s.weekly[latest];
      const pv = s.weekly[prev];
      if (v === null || v === undefined || pv === null || pv === undefined) return;
      const d = v - pv;
      if (!bestStore || Math.abs(d) > Math.abs(bestStore.d)) bestStore = { store: s.store, channel: s.channel, d };
    });
    if (bestStore) {
      findings.push(
        `${bestStore.store}（${bestStore.channel}）门店较上周${bestStore.d >= 0 ? '增加' : '减少'} ${Math.abs(Math.round(bestStore.d)).toLocaleString('en-US')} THB，是门店层面变化最大的一家。`
      );
    } else {
      findings.push('门店层面：本周与上周均有可比数据的门店暂未发现，无法给出门店级结论。');
    }

    // 4. category with max abs WoW change (SKU basis) + share
    const catTotalLatest = Object.values(data.category_weekly).reduce((a, c) => a + (c[latest] || 0), 0);
    let bestCat = null;
    Object.entries(data.category_weekly).forEach(([cat, series]) => {
      const m = computeWeekMetric(series, data, latest);
      if (m.wowAbs === null) return;
      if (!bestCat || Math.abs(m.wowAbs) > Math.abs(bestCat.wowAbs)) bestCat = { cat, ...m };
    });
    if (bestCat) {
      const shr = share(bestCat.value, catTotalLatest);
      findings.push(
        `品类「${bestCat.cat}」本周销量为 ${fmtNum(bestCat.value)} PCS（SKU口径），占SKU口径整体销量的 ${shr === null ? 'N/A' : (shr * 100).toFixed(1) + '%'}，较上周${bestCat.wowAbs >= 0 ? '增加' : '减少'} ${Math.abs(Math.round(bestCat.wowAbs)).toLocaleString('en-US')} PCS，是品类层面变化最大的一个。`
      );
    }

    // 5. SKU with max abs WoW change + top channel contributor
    let bestSku = null;
    data.skus.forEach((sku) => {
      const wk = sku.weekly_by_channel;
      const vAll = wk[latest] ? Object.values(wk[latest]).reduce((a, b) => a + b, 0) : null;
      const pAll = wk[prev] ? Object.values(wk[prev]).reduce((a, b) => a + b, 0) : null;
      if (vAll === null || pAll === null) return;
      const d = vAll - pAll;
      if (!bestSku || Math.abs(d) > Math.abs(bestSku.d)) bestSku = { sku, d, wk };
    });
    if (bestSku) {
      // top contributing channel to this SKU's change
      let topCh = null;
      data.channels.forEach((ch) => {
        const v = (bestSku.wk[latest] || {})[ch] || 0;
        const p = (bestSku.wk[prev] || {})[ch] || 0;
        const d = v - p;
        if (!topCh || Math.abs(d) > Math.abs(topCh.d)) topCh = { ch, d };
      });
      let text = `SKU「${bestSku.sku.item}」本周较上周${bestSku.d >= 0 ? '增加' : '减少'} ${Math.abs(Math.round(bestSku.d)).toLocaleString('en-US')} PCS，是SKU层面变化最大的一个`;
      if (topCh && Math.abs(topCh.d) > 0) {
        text += `，其中 ${topCh.ch} 贡献 ${topCh.d >= 0 ? '+' : ''}${Math.round(topCh.d).toLocaleString('en-US')} PCS`;
      }
      text += '。';
      findings.push(text);
    }

    findings.slice(0, 5).forEach((f) => list.appendChild(el('li', { text: f })));
    if (!findings.length) list.appendChild(el('li', { text: '数据不足，暂无法生成本周结论。' }));
  }

  const dqCount = Object.values(data.data_quality).reduce((a, v) => a + v.length, 0);
  document.getElementById('footerNote').textContent =
    `Sheet 映射: ${data.meta.sheet_mapping.channel_sheets.join('/')} · ${data.meta.sheet_mapping.store_sheet} · ${data.meta.sheet_mapping.sku_total_sheet}　|　本次同步共记录 ${dqCount} 项数据质量提示，详见 Channel & Store / Category & SKU 页面底部。`;

  render();
})();
