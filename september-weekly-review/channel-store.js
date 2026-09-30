(async function () {
  renderTopNav('nav', 'channel-store');
  let data;
  try {
    data = await loadSeptemberData();
  } catch (e) {
    document.getElementById('channelTable').replaceWith(emptyState('Unable to load September review data: ' + e.message));
    return;
  }
  renderScopeBanner('scopeBanner');
  initDataQualityDrawer(data.dataQuality);

  const cv = data.channelValue;
  const sv = data.storeValue;
  const ov = cv.overall;
  const overallWowAbs = absChange(ov.w3, ov.w2);
  const storelessChannels = new Set(sv.storeless_channels || []);

  // ---------------- 渠道表现 ----------------
  const channels = Object.keys(cv.channels);
  const chanRows = channels.map((ch) => {
    const c = cv.channels[ch];
    const avg12 = avg2(c.w1, c.w2);
    const wowAbs = absChange(c.w3, c.w2);
    return {
      ch, w1: c.w1, w2: c.w2, w3: c.w3, cum: c.cum,
      wowAbs, wowPct: pctChange(c.w3, c.w2),
      vsAvgPct: pctChange(c.w3, avg12),
      w3Share: share(c.w3, ov.w3),
      contrib: contribution(wowAbs, overallWowAbs),
    };
  }).sort((a, b) => (b.w3 || 0) - (a.w3 || 0));

  const thead = document.querySelector('#channelTable thead');
  const tbody = document.querySelector('#channelTable tbody');
  thead.innerHTML =
    '<tr><th>渠道</th><th>W1 THB</th><th>W2 THB</th><th>W3 THB</th><th>W1–W3 累计</th><th>W3 vs W2</th><th>W3 vs (W1–W2平均)</th><th>W3 销量占比</th><th>对整体变化的贡献</th></tr>';
  chanRows.forEach((r) => {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: r.ch + (storelessChannels.has(r.ch) ? ' *' : '') }),
      el('td', { text: fmtTHB(r.w1) }),
      el('td', { text: fmtTHB(r.w2) }),
      el('td', { text: fmtTHB(r.w3) }),
      el('td', { text: fmtTHB(r.cum) }),
      el('td', { class: 'chg ' + changeClass(r.wowPct), text: `${fmtPct(r.wowPct)} (${fmtSignedTHB(r.wowAbs)})` }),
      el('td', { class: 'chg ' + changeClass(r.vsAvgPct), text: fmtPct(r.vsAvgPct) }),
      el('td', { text: r.w3Share === null ? 'N/A' : (r.w3Share * 100).toFixed(1) + '%' }),
      el('td', { class: 'chg ' + changeClass(r.contrib), text: r.contrib === null ? 'N/A' : fmtPct(r.contrib) }),
    ]));
  });
  const note = document.createElement('p');
  note.className = 'footer-note';
  note.textContent = '* 该渠道在「店铺销量」中没有门店级明细，全部门店行长期为空；渠道数值取自渠道 Total 行。';
  document.getElementById('channelTable').parentElement.after(note);

  // change-rate chart with explicit 0% reference line
  const rateCtx = document.getElementById('changeRateChart').getContext('2d');
  const rateSorted = chanRows.slice().sort((a, b) => (b.wowPct || 0) - (a.wowPct || 0));
  new Chart(rateCtx, {
    type: 'bar',
    data: {
      labels: rateSorted.map((r) => r.ch),
      datasets: [{
        label: 'W3 vs W2 (%)',
        data: rateSorted.map((r) => (r.wowPct === null ? null : +(r.wowPct * 100).toFixed(1))),
        backgroundColor: rateSorted.map((r) => (r.wowPct >= 0 ? '#2a78d6' : '#c0392b')),
        valueLabelFormatter: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%',
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 50, right: 50 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.parsed.x > 0 ? '+' : '') + c.parsed.x.toFixed(1) + '%' } } },
      scales: {
        x: {
          ticks: { callback: (v) => (v > 0 ? '+' : '') + v + '%' },
          grid: { color: (c) => (c.tick.value === 0 ? '#26251f' : '#e1e0d9') },
        },
      },
    },
  });

  // ---------------- 门店表现 ----------------
  const channelSel = document.getElementById('channelSel');
  const storeSearch = document.getElementById('storeSearch');
  const sortToggle = document.getElementById('sortToggle');
  channels.forEach((ch) => channelSel.appendChild(el('option', { value: ch, text: ch })));
  channelSel.value = channels.find((c) => !storelessChannels.has(c)) || channels[0];

  let currentSort = 'sales';
  sortToggle.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      sortToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      currentSort = b.dataset.sort;
      renderStores();
    })
  );
  channelSel.addEventListener('change', renderStores);
  storeSearch.addEventListener('input', renderStores);

  function statusBadge(status) {
    if (status === 'complete') return '<span class="badge status-complete">Complete</span>';
    if (status === 'no_store_breakdown') return '<span class="badge severity-medium">无门店明细</span>';
    if (status === 'no_data') return '<span class="badge severity-medium">本周期均无数据</span>';
    if (status && status.startsWith('partial_missing')) return `<span class="badge severity-low">${status.replace('partial_missing_', '缺 ').replace('_', '/').toUpperCase()}</span>`;
    return '<span class="badge severity-low">' + status + '</span>';
  }

  function renderStores() {
    const channel = channelSel.value;
    const q = storeSearch.value.trim().toLowerCase();
    const thead = document.querySelector('#storeTable thead');
    const tbody = document.querySelector('#storeTable tbody');
    thead.innerHTML =
      '<tr><th>Channel</th><th>Store</th><th>W1 THB</th><th>W2 THB</th><th>W3 THB</th><th>W3 vs W2</th><th>绝对变化 THB</th><th>W1–W3 累计</th><th>数据状态</th></tr>';
    tbody.innerHTML = '';

    if (storelessChannels.has(channel)) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.innerHTML = `<div class="empty-state">${channel} 渠道在「店铺销量」中没有门店级数据（所有门店行在 Sep W1–W3 均为空），因此没有门店可供下钻。渠道本周期销量取自 Total 行，见上方渠道表现表格。</div>`;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    let rows = sv.stores
      .filter((s) => s.channel === channel)
      .filter((s) => !q || s.store.toLowerCase().includes(q))
      .map((s) => ({
        s,
        wowAbs: absChange(s.w3, s.w2),
        wowPct: pctChange(s.w3, s.w2),
      }));

    if (currentSort === 'sales') rows.sort((a, b) => (b.s.w3 || 0) - (a.s.w3 || 0));
    else if (currentSort === 'growth') rows = rows.filter((r) => r.wowAbs !== null && r.wowAbs > 0).sort((a, b) => b.wowAbs - a.wowAbs);
    else if (currentSort === 'decline') rows = rows.filter((r) => r.wowAbs !== null && r.wowAbs < 0).sort((a, b) => a.wowAbs - b.wowAbs);

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.innerHTML = '<div class="empty-state">没有匹配的门店，或该排序条件下没有符合的门店（例如某周数据缺失的门店不计入正式增长/下降排名）。</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    rows.forEach((r) => {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: r.s.channel }),
        el('td', { text: r.s.store }),
        el('td', { text: fmtTHB(r.s.w1) }),
        el('td', { text: fmtTHB(r.s.w2) }),
        el('td', { text: fmtTHB(r.s.w3) }),
        el('td', { class: 'chg ' + changeClass(r.wowPct), text: fmtPct(r.wowPct) }),
        el('td', { class: 'chg ' + changeClass(r.wowAbs), text: fmtSignedTHB(r.wowAbs) }),
        el('td', { text: fmtTHB(r.s.cum) }),
        (() => { const td = document.createElement('td'); td.innerHTML = statusBadge(r.s.status); return td; })(),
      ]));
    });
  }
  renderStores();

  // ---------------- 门店数据限制 ----------------
  const dqBox = document.getElementById('storeDqPanel');
  const storeDq = (data.dataQuality.items || []).filter((it) => it.category === 'store');
  if (!storeDq.length) dqBox.appendChild(emptyState('本次同步未发现门店层面的数据质量问题。'));
  storeDq
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
    .forEach((it) => dqBox.appendChild(dqItemEl(it)));

  document.getElementById('footerNote').textContent =
    `数据来源: 店铺销量（渠道 Total 行 = 渠道/整体；门店行，剔除 Total = 门店明细）· 单位 THB · ETL 运行时间: ${new Date(cv.meta.generated_at).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })}`;
})();
