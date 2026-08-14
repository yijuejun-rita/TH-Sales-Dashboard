(async function () {
  renderTopNav('nav', 'channel-store');
  let data;
  try {
    data = await loadWeeklyData();
  } catch (e) {
    document.getElementById('channelTable').replaceWith(emptyState('Unable to load weekly data: ' + e.message));
    return;
  }
  renderSyncStatus('syncStatus', data);

  const cw = completeWeeks(data);
  const weekSel = document.getElementById('weekSel');
  const drillChannelSel = document.getElementById('drillChannelSel');
  const storeSearch = document.getElementById('storeSearch');
  const sortToggle = document.getElementById('sortToggle');

  if (!cw.length) {
    document.getElementById('channelTable').replaceWith(emptyState('No complete week is available yet.'));
    return;
  }
  cw.slice().reverse().forEach((w) => weekSel.appendChild(el('option', { value: w.week_key, text: weekLabel(w) })));
  weekSel.value = data.meta.latest_complete_week;

  const structurallyStorelessChannels = new Set(
    (data.data_quality.sheet_issues || []).filter((i) => i.type === 'channel_no_store_breakdown_ever').map((i) => i.channel)
  );

  data.channels.forEach((ch) => drillChannelSel.appendChild(el('option', { value: ch, text: ch })));

  let currentSort = 'sales';
  sortToggle.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      sortToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      currentSort = b.dataset.sort;
      renderStores();
    })
  );
  weekSel.addEventListener('change', renderAll);
  drillChannelSel.addEventListener('change', renderStores);
  storeSearch.addEventListener('input', renderStores);

  let barChart = null;

  function statusBadge(status) {
    return `<span class="badge status-${status === 'complete' ? 'complete' : 'pending'}">${status === 'complete' ? 'Complete' : 'Pending Validation'}</span>`;
  }

  function renderChannelTable() {
    const weekKey = weekSel.value;
    const wkMeta = data.weeks.find((w) => w.week_key === weekKey);
    const overallM = computeWeekMetric(data.overall_weekly, data, weekKey);
    const rows = data.channels.map((ch) => {
      const m = computeWeekMetric(data.channel_weekly[ch], data, weekKey);
      const storeCount = data.stores.filter((s) => s.channel === ch && s.weekly[weekKey] > 0).length;
      const shr = share(m.value, overallM.value);
      const isReporting = (wkMeta.channels_reporting || []).includes(ch);
      const src = (data.channel_weekly[ch][weekKey] || {}).source;
      return { ch, m, storeCount, shr, isReporting, src };
    });

    const thead = document.querySelector('#channelTable thead');
    const tbody = document.querySelector('#channelTable tbody');
    thead.innerHTML =
      '<tr><th>渠道名称</th><th>本周销量THB</th><th>上周销量THB</th><th>过去3周平均THB</th><th>WoW</th><th>vs过去3周平均</th><th>绝对变化THB</th><th>本周销量占比</th><th>有销量门店数</th><th>数据更新时间</th><th>数据状态</th></tr>';
    tbody.innerHTML = '';
    rows
      .slice()
      .sort((a, b) => (b.m.value || 0) - (a.m.value || 0))
      .forEach((r) => {
        const tr = el('tr', {}, [
          el('td', { text: r.ch + (r.src === 'total_row_fallback' ? ' *' : '') }),
          el('td', { text: fmtTHB(r.m.value) }),
          el('td', { text: fmtTHB(r.m.prevValue) }),
          el('td', { text: fmtTHB(r.m.avg3) }),
          el('td', { class: 'chg ' + changeClass(r.m.wowPct), text: fmtPct(r.m.wowPct) }),
          el('td', { class: 'chg ' + changeClass(r.m.vsAvg3Pct), text: fmtPct(r.m.vsAvg3Pct) }),
          el('td', { class: 'chg ' + changeClass(r.m.wowAbs), text: fmtSignedTHB(r.m.wowAbs) }),
          el('td', { text: r.shr === null ? 'N/A' : (r.shr * 100).toFixed(1) + '%' }),
          el('td', { text: fmtNum(r.storeCount) + (structurallyStorelessChannels.has(r.ch) ? ' (无门店明细)' : '') }),
          el('td', { text: new Date(data.meta.generated_at).toLocaleDateString('en-US') }),
        ]);
        const statusTd = document.createElement('td');
        statusTd.innerHTML = statusBadge(r.isReporting ? 'complete' : 'pending');
        tr.appendChild(statusTd);
        tbody.appendChild(tr);
      });

    const noteRow = data.channels.some((ch) => (data.channel_weekly[ch][weekKey] || {}).source === 'total_row_fallback');
    document.querySelector('#channelTable').nextElementSibling;
    if (noteRow) {
      const note = document.createElement('p');
      note.className = 'footer-note';
      note.textContent = '* 该渠道本周无门店级明细，销量取自表内已录入的渠道 Total 行。';
      document.getElementById('channelTable').parentElement.after(note);
    }

    const sorted = rows.slice().sort((a, b) => (b.m.value || 0) - (a.m.value || 0));
    const ctx = document.getElementById('channelBarChart').getContext('2d');
    if (barChart) barChart.destroy();
    barChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sorted.map((r) => r.ch),
        datasets: [{ label: 'Sales Value (THB)', data: sorted.map((r) => Math.round(r.m.value || 0)), backgroundColor: '#2a78d6' }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtTHB(c.parsed.x) } } },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => v.toLocaleString('en-US') } } },
      },
    });

    return sorted;
  }

  function sparkline(values) {
    const w = 90, h = 26, pad = 3;
    const usable = values.map((v) => (v === null || v === undefined ? null : v));
    const nums = usable.filter((v) => v !== null);
    if (!nums.length) return '<span class="empty-state" style="padding:2px 6px;">N/A</span>';
    const min = Math.min(...nums), max = Math.max(...nums);
    const range = max - min || 1;
    const stepX = (w - pad * 2) / Math.max(1, usable.length - 1);
    let lastX = null, lastY = null;
    const points = [];
    usable.forEach((v, i) => {
      const x = pad + i * stepX;
      if (v === null) return;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${points.join(' ')}" fill="none" stroke="#2a78d6" stroke-width="1.6"/></svg>`;
  }

  function renderStores() {
    const weekKey = weekSel.value;
    const channel = drillChannelSel.value;
    const q = storeSearch.value.trim().toLowerCase();
    const channelTotal = computeWeekMetric(data.channel_weekly[channel], data, weekKey).value;

    let rows = data.stores
      .filter((s) => s.channel === channel)
      .filter((s) => !q || s.store.toLowerCase().includes(q))
      .map((s) => {
        const m = computeWeekMetric(s.weekly, data, weekKey);
        const shr = share(m.value, channelTotal);
        const idx = weekIndexMap(data).sorted.filter((w) => w.status === 'complete').findIndex((w) => w.week_key === weekKey);
        const last4 = cw.slice(Math.max(0, cw.findIndex((w) => w.week_key === weekKey) - 3), cw.findIndex((w) => w.week_key === weekKey) + 1).map((w) => s.weekly[w.week_key]);
        return { s, m, shr, last4 };
      });

    if (currentSort === 'sales') rows.sort((a, b) => (b.m.value || 0) - (a.m.value || 0));
    else if (currentSort === 'growth') rows = rows.filter((r) => r.m.wowAbs !== null && r.m.wowAbs > 0).sort((a, b) => b.m.wowAbs - a.m.wowAbs);
    else if (currentSort === 'decline') rows = rows.filter((r) => r.m.wowAbs !== null && r.m.wowAbs < 0).sort((a, b) => a.m.wowAbs - b.m.wowAbs);

    const thead = document.querySelector('#storeTable thead');
    const tbody = document.querySelector('#storeTable tbody');
    thead.innerHTML =
      '<tr><th>门店名称</th><th>所属渠道</th><th>本周销量THB</th><th>上周销量THB</th><th>过去3周平均THB</th><th>WoW</th><th>vs过去3周平均</th><th>绝对变化THB</th><th>渠道内占比</th><th>近4周趋势</th><th>数据更新时间</th><th>状态</th></tr>';
    tbody.innerHTML = '';

    if (structurallyStorelessChannels.has(channel)) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 12;
      td.innerHTML = `<div class="empty-state">${channel} 渠道在「${data.meta.sheet_mapping.store_sheet}」中从未提供门店级别数据（所有门店行长期为空），因此没有门店可供下钻。渠道本周销量取自表内的 Total 行，见渠道表现表格。</div>`;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 12;
      td.innerHTML = '<div class="empty-state">没有匹配的门店。</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    rows.forEach((r) => {
      const sparkTd = document.createElement('td');
      sparkTd.innerHTML = sparkline(r.last4);
      const tr = el('tr', {}, [
        el('td', { text: r.s.store }),
        el('td', { text: r.s.channel }),
        el('td', { text: fmtTHB(r.m.value) }),
        el('td', { text: fmtTHB(r.m.prevValue) }),
        el('td', { text: fmtTHB(r.m.avg3) }),
        el('td', { class: 'chg ' + changeClass(r.m.wowPct), text: fmtPct(r.m.wowPct) }),
        el('td', { class: 'chg ' + changeClass(r.m.vsAvg3Pct), text: fmtPct(r.m.vsAvg3Pct) }),
        el('td', { class: 'chg ' + changeClass(r.m.wowAbs), text: fmtSignedTHB(r.m.wowAbs) }),
        el('td', { text: r.shr === null ? 'N/A' : (r.shr * 100).toFixed(1) + '%' }),
      ]);
      tr.appendChild(sparkTd);
      tr.appendChild(el('td', { text: new Date(data.meta.generated_at).toLocaleDateString('en-US') }));
      const statusTd = document.createElement('td');
      const isMissing = r.m.value === null;
      statusTd.innerHTML = isMissing ? '<span class="badge severity-medium">未更新</span>' : '<span class="badge status-complete">正常</span>';
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    });
  }

  function renderStoreAlerts() {
    const weekKey = weekSel.value;
    const box = document.getElementById('storeAlerts');
    box.innerHTML = '';
    const alerts = [];

    data.stores.forEach((s) => {
      if (structurallyStorelessChannels.has(s.channel)) return; // already flagged structurally
      const m = computeWeekMetric(s.weekly, data, weekKey);
      const history = cw.map((w) => s.weekly[w.week_key]).filter((v) => v !== null && v !== undefined);
      // Store-basis figures are Thai Baht sales VALUE, not PCS piece counts (the
      // store-sales sheet has no PCS column -- see common.js fmtTHB comment).
      // Individual store weekly values in this workbook typically run from a
      // few hundred to tens of thousands of THB, so a "low base" cutoff needs
      // to sit well below a normal week's sales, not near zero. 1,000 THB is
      // used as a practical low-base threshold at this data's actual scale.
      const lowBase = m.avg3 !== null && m.avg3 < 1000;

      if (m.value === null) {
        const everHadData = history.length > 0;
        if (everHadData) {
          alerts.push({ sev: 'medium', store: s, text: `${s.store}（${s.channel}）本周数据未更新（历史曾有销量记录）。` });
        }
        return;
      }
      const firstDataIdx = cw.findIndex((w) => s.weekly[w.week_key] !== null && s.weekly[w.week_key] !== undefined);
      const thisIdx = cw.findIndex((w) => w.week_key === weekKey);
      if (firstDataIdx >= 0 && thisIdx - firstDataIdx <= 1 && thisIdx === cw.length - 1 && firstDataIdx >= cw.length - 2) {
        alerts.push({ sev: 'low', store: s, text: `${s.store}（${s.channel}）为近期新增数据的门店（历史记录不足2周），暂列为新开门店观察。` });
      }
      if (m.avg3N < 3) {
        alerts.push({ sev: 'low', store: s, text: `${s.store}（${s.channel}）历史完整周不足3周（仅${m.avg3N}周），过去3周平均/环比参考性有限。` });
      }
      if (m.value === 0 && m.avg3 !== null && m.avg3 > 0) {
        alerts.push({ sev: 'high', store: s, text: `${s.store}（${s.channel}）本周销量为 0 THB，但过去3周平均为 ${fmtTHB(m.avg3)}，需关注是否停业或漏报。` });
      }
      if (m.wowPct !== null && m.wowPct < -0.3) {
        alerts.push({
          sev: 'high', store: s,
          text: `${s.store}（${s.channel}）WoW ${fmtPct(m.wowPct)}${lowBase ? `（基数较低，历史3周均值仅 ${fmtTHB(m.avg3)}，绝对变化 ${fmtSignedTHB(m.wowAbs)}）` : `，绝对变化 ${fmtSignedTHB(m.wowAbs)}`}。`,
        });
      }
      if (m.vsAvg3Pct !== null && m.vsAvg3Pct < -0.3) {
        alerts.push({
          sev: 'medium', store: s,
          text: `${s.store}（${s.channel}）vs过去3周平均 ${fmtPct(m.vsAvg3Pct)}${lowBase ? `（基数较低: ${fmtTHB(m.avg3)}）` : ''}，绝对变化 ${fmtSignedTHB(m.vsAvg3Abs)}。`,
        });
      }
    });

    // absolute decline top 10 (global, across all channels with real store data)
    const declineRanked = data.stores
      .filter((s) => !structurallyStorelessChannels.has(s.channel))
      .map((s) => ({ s, m: computeWeekMetric(s.weekly, data, weekKey) }))
      .filter((r) => r.m.wowAbs !== null && r.m.wowAbs < 0)
      .sort((a, b) => a.m.wowAbs - b.m.wowAbs)
      .slice(0, 10);
    if (declineRanked.length) {
      alerts.push({
        sev: 'medium',
        text: `绝对销量下降 Top ${declineRanked.length}：` + declineRanked.map((r) => `${r.s.store}(${fmtSignedTHB(r.m.wowAbs)})`).join('、') + '。',
      });
    }

    if (!alerts.length) {
      box.appendChild(emptyState('本周没有触发门店预警条件。'));
      return;
    }
    alerts.forEach((a) => {
      box.appendChild(
        el('div', { class: 'dq-item' }, [
          el('span', { class: 'badge severity-' + a.sev, text: a.sev.toUpperCase() }),
          el('span', { class: 'dq-detail', text: a.text }),
        ])
      );
    });
  }

  function renderDQ() {
    const box = document.getElementById('dqPanel');
    box.innerHTML = '';
    const dq = data.data_quality;
    const all = [];
    Object.entries(dq).forEach(([cat, items]) => {
      items.forEach((it) => all.push({ cat, ...it }));
    });
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
            el('span', { class: 'dq-detail', text: `[${it.cat}${it.week ? ' · ' + it.week : ''}${it.channel ? ' · ' + it.channel : ''}] ${it.detail || JSON.stringify(it)}` }),
          ])
        );
      });
  }
  function sevRank(s) {
    return { high: 3, medium: 2, low: 1, info: 0 }[s] || 0;
  }

  function renderAll() {
    renderChannelTable();
    if (!drillChannelSel.value) drillChannelSel.value = data.channels[0];
    renderStores();
    renderStoreAlerts();
  }

  renderAll();
  renderDQ();
  document.getElementById('footerNote').textContent = `数据来源: ${data.meta.sheet_mapping.store_sheet} (店铺销量口径) · 最后同步: ${new Date(data.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })}`;
})();
