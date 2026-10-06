/* RAT dashboard frontend — vanilla JS + ECharts. */

'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const basename = (p) => String(p).split('/').pop();
const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtNum = (n) => (n == null ? '—' : (Math.abs(n) >= 1000 ? fmtInt(Math.round(n)) : String(Math.round(n * 1000) / 1000)));
const fmtPct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const shortDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

const PALETTES = {
  light: {
    colors: ['#58a6f2', '#74dc92', '#14b8a6', '#f79009', '#ee46bc', '#8b5cf6', '#f97316', '#06b6d4', '#12b76a', '#f04438', '#7dd3fc', '#a3e635'],
    green: '#12b76a', red: '#f04438', accent: '#58a6f2',
    areaGreen: ['rgba(18,183,106,.32)', 'rgba(18,183,106,.03)'],
    areaRed: ['rgba(240,68,56,.28)', 'rgba(240,68,56,.03)'],
    commits: '#9a9ea3',
    axis: '#ececea', axisLabel: '#9a9ea3', split: '#f1f1ef',
    legend: '#62676d', barLabel: '#62676d', muted: '#4b5058',
    hotspot: ['#b9efcd', '#58a6f2'],
    tip: '#17181a', surface: '#ffffff', others: '#d0d5dd', treeLabel: '#ffffff',
  },
  dark: {
    colors: ['#e08a4a', '#8b8b86', '#c2542e', '#f5b26b', '#9d1309', '#d4a373', '#a33b1f', '#e6c79c', '#7a7266', '#f97316', '#b45309', '#fca5a5'],
    green: '#4ade80', red: '#f87171', accent: '#e08a4a',
    areaGreen: ['rgba(74,222,128,.28)', 'rgba(74,222,128,.04)'],
    areaRed: ['rgba(248,113,113,.26)', 'rgba(248,113,113,.04)'],
    commits: '#8b8b86',
    axis: '#2a2926', axisLabel: '#7a7772', split: '#211f1d',
    legend: '#a8a5a0', barLabel: '#a8a5a0', muted: '#a8a5a0',
    hotspot: ['#e08a4a', '#9d1309'],
    tip: '#1c1b19', surface: '#0c0b0b', others: '#5a5854', treeLabel: '#f4f3f1',
  },
};
const T = () => PALETTES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];

const state = {
  repos: [],
  rid: null,
  meta: null,
  selStatus: null,
  filters: { author: '', object: '', from: null, to: null, days: 0, commits: [] },
  tree: null,
  treeRid: null,
  groups: [],
  dash: null,
  charts: {},
  poll: null,
};

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6500 : 3500);
}

// ---- sidebar ---------------------------------------------------------------

function repoSub(r) {
  if (r.status === 'ready') {
    const s = r.stats || {};
    // totalCommits (merges included) is the count GitHub shows; the metric
    // basis per the brief is the non-merge history H̄.
    return `${fmtInt(s.totalCommits ?? s.commits)} commits · ${fmtInt(s.objects)} objects · ${fmtInt(s.authors)} authors`;
  }
  if (r.status === 'error') return r.error || 'error';
  if (r.status === 'cloning') return `cloning… ${r.progress?.pct ?? 0}%`;
  if (r.status === 'extracting') return 'extracting zip…';
  if (r.status === 'analyzing') {
    const p = r.progress || {};
    return p.total ? `analyzing… ${fmtInt(p.done)}/${fmtInt(p.total)}` : 'analyzing…';
  }
  return r.status;
}

function dotClass(r) {
  if (r.status === 'ready') return 'ready';
  if (r.status === 'error') return 'error';
  return 'busy';
}

function renderRepoList() {
  const box = $('#repoList');
  if (!state.repos.length) {
    box.innerHTML = '<div class="list-empty">No repositories yet</div>';
    return;
  }
  box.innerHTML = state.repos.map((r) => `
    <div class="repo-item ${r.id === state.rid ? 'active' : ''}" data-id="${r.id}">
      <span class="dot ${dotClass(r)}"></span>
      <div class="repo-main" title="${esc(r.name)}">
        <div class="repo-name">${esc(r.name)}</div>
        <div class="repo-sub">${esc(repoSub(r))}</div>
      </div>
      <button class="del" data-del="${r.id}" title="Remove">×</button>
    </div>`).join('');
  box.querySelectorAll('.repo-item').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('[data-del]')) return;
      selectRepo(el.dataset.id);
    };
  });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const r = state.repos.find((x) => x.id === btn.dataset.del);
      if (!r || !confirm(`Remove "${r.name}" and its downloaded data?`)) return;
      try {
        await api('DELETE', `/api/repos/${r.id}`);
        if (state.rid === r.id) {
          state.rid = null;
          state.meta = null;
          state.dash = null;
          state.tree = null;
          state.treeRid = null;
          $('#dash').classList.add('hidden');
          $('#emptyState').classList.remove('hidden');
        }
        await refreshRepos();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

async function refreshRepos() {
  state.repos = await api('GET', '/api/repos');
  renderRepoList();
  const sel = state.repos.find((r) => r.id === state.rid);
  if (sel) {
    const was = state.selStatus;
    state.selStatus = sel.status;
    state.meta = sel;
    updateBusy(sel);
    if (was && was !== 'ready' && sel.status === 'ready') {
      toast(`${sel.name} is ready`, 'success');
      loadReady();
    }
  }
  const busy = state.repos.some((r) => r.status !== 'ready' && r.status !== 'error');
  if (busy) ensurePoll(); else stopPoll();
}

function ensurePoll() {
  if (state.poll) return;
  state.poll = setInterval(() => refreshRepos().catch(() => {}), 1200);
}

function stopPoll() {
  if (state.poll) {
    clearInterval(state.poll);
    state.poll = null;
  }
}

function updateBusy(sel) {
  const busy = $('#busyBar');
  if (!sel || sel.status === 'ready' || sel.status === 'error') {
    busy.classList.add('hidden');
    return;
  }
  busy.classList.remove('hidden');
  const p = sel.progress || {};
  let label = 'Working…';
  let pct = 0;
  if (sel.status === 'cloning') { label = `Cloning repository… ${p.pct ?? 0}%`; pct = p.pct ?? 0; }
  else if (sel.status === 'extracting') { label = 'Extracting zip…'; pct = 15; }
  else if (sel.status === 'analyzing') {
    label = p.total ? `Analyzing history… ${fmtInt(p.done)} / ${fmtInt(p.total)} commits` : 'Analyzing history…';
    pct = p.total ? Math.round((p.done / p.total) * 100) : 5;
  }
  $('#busyLabel').textContent = label;
  $('#busyProgress').style.width = `${pct}%`;
}

function showDash(on) {
  $('#emptyState').classList.toggle('hidden', on);
  $('#dash').classList.toggle('hidden', !on);
}

// ---- data loading ------------------------------------------------------------

function filterQS() {
  const p = new URLSearchParams();
  if (state.filters.author) p.set('author', state.filters.author);
  if (state.filters.object) p.set('object', state.filters.object);
  if (state.filters.commits.length) p.set('commits', state.filters.commits.join(','));
  else {
    if (state.filters.from) p.set('from', state.filters.from);
    if (state.filters.to) p.set('to', state.filters.to);
  }
  return p.toString();
}

async function selectRepo(id) {
  if (state.rid === id && state.dash) return;
  state.rid = id;
  state.selStatus = null;
  state.groups = [];
  const meta = state.repos.find((r) => r.id === id) || null;
  state.meta = meta;
  if (meta) state.selStatus = meta.status;
  state.filters = { author: '', object: '', from: null, to: null, days: 0, commits: [] };
  state.tree = null;
  state.treeRid = null;
  renderRepoList();
  showDash(true);
  updateBusy(meta);
  if (meta && meta.status === 'ready') await loadReady();
  else {
    $('#repoTitle').textContent = meta ? meta.name : '—';
    $('#repoMeta').textContent = 'waiting for analysis to finish…';
  }
}

async function loadReady() {
  const rid = state.rid;
  try {
    if (state.treeRid !== rid) {
      state.tree = await api('GET', `/api/repos/${rid}/tree`);
      state.treeRid = rid;
    }
    await loadDash();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadDash() {
  if (!state.rid) return;
  const rid = state.rid;
  try {
    const d = await api('GET', `/api/repos/${rid}/dashboard?${filterQS()}`);
    if (state.rid !== rid) return;
    state.dash = d;
    state.groups = d.groups || [];
    renderTitles(d);
    renderFilterUI();
    renderCards(d);
    renderCharts(d);
  } catch (e) { toast(e.message, 'error'); }
}

function renderTitles(d) {
  const s = d.stats || {};
  $('#repoTitle').textContent = d.repo.name;
  const span = s.firstTs && s.lastTs ? `${shortDate(s.firstTs)} → ${shortDate(s.lastTs)}` : '';
  const commits = s.totalCommits != null
    ? `${fmtInt(s.totalCommits)} commits total · ${fmtInt(s.commits)} analysed (non-merge)`
    : `${fmtInt(s.commits)} commits`;
  $('#repoMeta').textContent = `${commits} · ${fmtInt(s.objects)} objects · ${fmtInt(s.authors)} authors · ref ${d.repo.ref}${span ? ` · ${span}` : ''}`;
  $('#repoMeta').title = 'Metrics are computed over H̄, the non-merge commits reachable from the ref (per the test brief). The total includes merge commits and matches the count shown on GitHub.';
  const chip = $('#statusChip');
  chip.className = 'chip green';
  chip.textContent = `${fmtInt(d.range.size)} commits in set`;
}

// ---- filters UI ---------------------------------------------------------------

function renderFilterUI() {
  const sel = $('#authorSel');
  const cur = state.filters.author;
  sel.innerHTML = '<option value="">All authors</option>' + state.groups
    .slice()
    .sort((a, b) => b.commitCount - a.commitCount)
    .map((g) => `<option value="${g.id}">${esc(g.name)} · ${fmtInt(g.commitCount)} commits</option>`)
    .join('');
  sel.value = state.groups.some((g) => String(g.id) === String(cur)) ? String(cur) : '';
  state.filters.author = sel.value;

  $('#objectBtn').textContent = state.filters.object === '' ? '/ (root)' : state.filters.object;

  const badge = $('#commitBadge');
  if (state.filters.commits.length) {
    badge.classList.remove('hidden');
    badge.textContent = `${state.filters.commits.length} selected ✕`;
    badge.style.cursor = 'pointer';
    badge.onclick = () => {
      state.filters.commits = [];
      renderFilterUI();
      loadDash();
    };
  } else {
    badge.classList.add('hidden');
  }

  const manual = state.filters.commits.length > 0;
  document.querySelectorAll('.filter.grow, .range-inputs, .presets').forEach((el) => el.classList.toggle('disabled-block', manual));
}

// ---- metric cards ---------------------------------------------------------------

const CARD_TIP = {
  added: 'l⁺ — total added lines over the selected commit set (repository, directory or file)',
  removed: 'l⁻ — total removed lines over the selected commit set',
  growth: 'δ = added − removed',
  churn: 'λ = added + removed',
  modifications: 'n — number of commits in the set that modified this object',
  modFreq: 'η = n / |H| — modification frequency',
  churnRate: 'ρ = λ / |H| — churn per commit',
  size: '|H| — size of the selected commit set',
  ownership: 'ω = author churn / total churn on this object',
};

function renderCards(d) {
  const m = d.metrics;
  const cards = [
    { key: 'added', label: 'Lines added', value: fmtInt(m.added), tone: 'green' },
    { key: 'removed', label: 'Lines removed', value: fmtInt(m.removed), tone: 'red' },
    { key: 'growth', label: 'Growth', value: fmtInt(m.growth), tone: m.growth >= 0 ? 'green' : 'red' },
    { key: 'churn', label: 'Churn', value: fmtInt(m.churn), tone: 'amber', grad: true },
    { key: 'modifications', label: 'Modifications', value: fmtInt(m.modifications) },
    { key: 'modFreq', label: 'Modification freq.', value: fmtPct(m.modFreq) },
    { key: 'churnRate', label: 'Churn rate', value: fmtNum(m.churnRate) },
    { key: 'size', label: 'Commits |H|', value: fmtInt(m.size) },
  ];
  if (m.ownership != null) cards.push({ key: 'ownership', label: 'Ownership (author)', value: fmtPct(m.ownership), tone: 'violet' });
  $('#metricCards').innerHTML = cards.map((c) => `
    <div class="card metric ${c.tone || ''} ${c.grad ? 'grad' : ''}">
      <span data-tip="?" data-tip-content="${esc(CARD_TIP[c.key])}">?</span>
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
    </div>`).join('');
}

// ---- charts ---------------------------------------------------------------------

function chart(id) {
  if (!window.echarts) return null;
  if (!state.charts[id]) state.charts[id] = window.echarts.init(document.getElementById(id));
  return state.charts[id];
}

function renderCharts(d) {
  if (!window.echarts) {
    toast('ECharts CDN unavailable — charts disabled (offline?)', 'error');
    window.echarts = { __missing: true };
    return;
  }
  renderTimeline(d);
  renderHotspots(d);
  renderOwners(d);
  renderTreemap(d);
}

function gradient(x0, y0, x1, y1, from, to) {
  return new window.echarts.graphic.LinearGradient(x0, y0, x1, y1, [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ]);
}

function renderTimeline(d) {
  const c = chart('chartTimeline');
  if (!c) return;
  const P = T();
  const t = d.timeline || { labels: [], added: [], removed: [], churn: [], commits: [] };
  $('#timelineSub').textContent = t.labels.length ? `${fmtInt(d.range.size)} commits · unit ${t.unit}` : 'no commits in range';
  const removedNeg = t.removed.map((v) => -v);
  c.setOption({
    animationDuration: 300,
    grid: { left: 8, right: 14, top: 36, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 11, itemHeight: 11, textStyle: { color: P.legend, fontSize: 12 } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: P.tip,
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter: (ps) => {
        if (!ps.length) return '';
        const i = ps[0].dataIndex;
        return `<b>${t.labels[i]}</b><br>Added ${fmtInt(t.added[i])} · Removed ${fmtInt(t.removed[i])}<br>Churn ${fmtInt(t.churn[i])} · Commits ${fmtInt(t.commits[i])}`;
      },
    },
    xAxis: {
      type: 'category', data: t.labels, boundaryGap: false,
      axisLine: { lineStyle: { color: P.axis } }, axisTick: { show: false },
      axisLabel: { color: P.axisLabel, fontSize: 11, hideOverlap: true },
    },
    yAxis: [
      { type: 'value', splitLine: { lineStyle: { color: P.split } }, axisLabel: { color: P.axisLabel, fontSize: 11 } },
      { type: 'value', splitLine: { show: false }, axisLabel: { color: P.axisLabel, fontSize: 11 } },
    ],
    series: [
      {
        name: 'Added', type: 'line', data: t.added, symbol: 'none', lineStyle: { width: 0 },
        itemStyle: { color: P.green },
        areaStyle: { color: gradient(0, 0, 0, 1, P.areaGreen[0], P.areaGreen[1]) },
      },
      {
        name: 'Removed', type: 'line', data: removedNeg, symbol: 'none', lineStyle: { width: 0 },
        itemStyle: { color: P.red },
        areaStyle: { color: gradient(0, 1, 0, 0, P.areaRed[0], P.areaRed[1]) },
      },
      { name: 'Churn', type: 'line', data: t.churn, symbol: 'none', smooth: true, lineStyle: { width: 2, color: P.accent, type: 'dashed' }, itemStyle: { color: P.accent } },
      { name: 'Commits', type: 'line', yAxisIndex: 1, data: t.commits, symbol: 'none', smooth: true, lineStyle: { width: 2, color: P.commits }, itemStyle: { color: P.commits } },
    ],
  }, true);
}

function renderHotspots(d) {
  const c = chart('chartHotspots');
  if (!c) return;
  const P = T();
  const hs = (d.hotspots || []).slice().reverse();
  c.setOption({
    grid: { left: 4, right: 44, top: 6, bottom: 2, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: P.tip, borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
      formatter: (p) => {
        const x = hs[p.dataIndex];
        if (!x) return '';
        return `<b>${esc(x.path)}</b><br>churn ${fmtInt(x.churn)}<br>+${fmtInt(x.added)} / −${fmtInt(x.removed)}<br>${fmtInt(x.modifications)} modifications`;
      },
    },
    xAxis: { type: 'value', show: false },
    yAxis: {
      type: 'category', data: hs.map((x) => x.path), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: P.muted, fontSize: 11.5, width: 180, overflow: 'truncate', fontFamily: 'JetBrains Mono, monospace' },
    },
    series: [{
      type: 'bar', data: hs.map((x) => x.churn), barWidth: 13,
      itemStyle: { borderRadius: [0, 7, 7, 0], color: gradient(0, 0, 1, 0, P.hotspot[0], P.hotspot[1]) },
      label: { show: true, position: 'right', color: P.barLabel, fontSize: 11, formatter: (p) => fmtInt(p.value) },
    }],
  }, true);
  c.off('click');
  c.on('click', (p) => { const x = hs[p.dataIndex]; if (x) setObject(x.path); });
}

function renderOwners(d) {
  const c = chart('chartOwners');
  if (!c) return;
  const P = T();
  const rk = (d.ranking || []).filter((x) => x.churn > 0);
  const total = rk.reduce((s, x) => s + x.churn, 0);
  $('#ownSub').textContent = total ? `churn share · ${fmtInt(total)} total` : 'no churn in range';
  const data = rk.slice(0, 8).map((x, i) => ({ name: x.name, value: x.churn, itemStyle: { color: P.colors[i % P.colors.length] } }));
  const rest = rk.slice(8).reduce((s, x) => s + x.churn, 0);
  if (rest > 0) data.push({ name: 'others', value: rest, itemStyle: { color: P.others } });
  c.setOption({
    tooltip: {
      trigger: 'item', backgroundColor: P.tip, borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
      formatter: (p) => `<b>${esc(p.name)}</b><br>churn ${fmtInt(p.value)} · ${p.percent.toFixed(1)}%`,
    },
    legend: {
      orient: 'vertical', right: 4, top: 'middle', icon: 'circle', itemWidth: 9, itemHeight: 9,
      textStyle: { color: P.muted, fontSize: 11.5 }, type: 'scroll',
      formatter: (nm) => (nm.length > 20 ? `${nm.slice(0, 19)}…` : nm),
    },
    series: [{
      type: 'pie', radius: ['54%', '78%'], center: ['34%', '50%'], padAngle: 2,
      itemStyle: { borderRadius: 8, borderColor: P.surface, borderWidth: 2 },
      label: { show: false }, data,
    }],
  }, true);
}

function renderTreemap(d) {
  const c = chart('chartTreemap');
  if (!c) return;
  const P = T();
  const kids = d.children || [];
  const data = kids.map((k, i) => ({
    name: k.name + (k.type === 'dir' ? '/' : ''),
    value: Math.max(k.churn, 0.5),
    path: k.path,
    churn: k.churn,
    mods: k.modifications,
    itemStyle: { color: P.colors[i % P.colors.length] },
  }));
  c.setOption({
    tooltip: {
      backgroundColor: P.tip, borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
      formatter: (p) => (p.data && p.data.path
        ? `<b>${esc(p.data.path)}</b><br>churn ${fmtInt(p.data.churn)}<br>${fmtInt(p.data.mods)} modifications`
        : ''),
    },
    series: [{
      type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false },
      width: '100%', height: '100%',
      itemStyle: { borderColor: P.surface, borderWidth: 2, gapWidth: 2, borderRadius: 8 },
      label: { show: true, fontSize: 12, fontWeight: 600, color: P.treeLabel, formatter: (p) => p.name },
      emphasis: { itemStyle: { shadowBlur: 10 } },
      data,
    }],
  }, true);
  c.off('click');
  c.on('click', (p) => { if (p.data && p.data.path) setObject(p.data.path); });
}

function setObject(path) {
  state.filters.object = path;
  renderFilterUI();
  loadDash();
}

// ---- modals ---------------------------------------------------------------------

function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = '';
  $('#modal').classList.remove('hidden');
}

function closeModal() { $('#modal').classList.add('hidden'); }

function openPathPicker() {
  const rows = [];
  const walk = (node, depth) => {
    for (const ch of node.children || []) {
      rows.push({ path: ch.path, type: ch.type, depth });
      if (ch.type === 'dir') walk(ch, depth + 1);
    }
  };
  if (state.tree) walk(state.tree, 0);

  openModal('Filter by file or directory', `
    <input class="search-input" id="pathSearch" placeholder="Search paths…">
    <div class="pick-row ${state.filters.object === '' ? 'selected' : ''}" data-path="">
      <span class="p-icon">/</span><span class="p-name">Repository root</span><span class="p-path">/</span>
    </div>
    <div id="pathList" style="max-height:46vh;overflow:auto"></div>`);

  const list = $('#pathList');
  const render = (q) => {
    const hit = q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows;
    const shown = hit.slice(0, 400);
    list.innerHTML = shown.map((r) => `
      <div class="pick-row ${r.path === state.filters.object ? 'selected' : ''}" data-path="${esc(r.path)}">
        <span class="p-icon">${r.type === 'dir' ? '▸' : ''}</span>
        <span class="p-name" style="padding-left:${Math.min(r.depth, 8) * 14}px">${esc(basename(r.path))}</span>
        <span class="p-path">${esc(r.path)}</span>
      </div>`).join('') || '<div class="muted" style="padding:12px">No match</div>';
    if (hit.length > shown.length) {
      list.insertAdjacentHTML('beforeend', `<div class="muted" style="padding:10px 12px;font-size:12px">${fmtInt(hit.length - shown.length)} more — refine the search to narrow down</div>`);
    }
    list.querySelectorAll('.pick-row[data-path]').forEach((el) => {
      el.onclick = () => { closeModal(); setObject(el.dataset.path); };
    });
  };
  render('');
  $('#pathSearch').oninput = (e) => render(e.target.value.trim().toLowerCase());
  $('#pathSearch').focus();
}

async function openCommitPicker() {
  const rid = state.rid;
  const selected = new Set(state.filters.commits);
  openModal('Manual commit selection', `
    <div class="modal-hint">Select specific commits (from anywhere in the analysed history) to form the commit set |H|. This replaces the period filter while active.</div>
    <input class="search-input" id="cSearch" placeholder="Search subject / author / hash…">
    <div id="cList" style="max-height:44vh;overflow:auto"></div>
    <button class="btn btn-ghost btn-sm load-more" id="cMore">Load more</button>`);

  let offset = 0;
  let all = [];
  let total = 0;

  const foot = () => {
    const f = $('#modalFoot');
    f.innerHTML = '';
    const info = document.createElement('span');
    info.className = 'muted';
    info.style.marginRight = 'auto';
    info.textContent = `${selected.size} of ${fmtInt(total)} selected`;
    const clear = document.createElement('button');
    clear.className = 'btn btn-ghost btn-sm';
    clear.textContent = 'Clear all';
    clear.onclick = () => { selected.clear(); renderList(); };
    const apply = document.createElement('button');
    apply.className = 'btn btn-primary btn-sm';
    apply.textContent = 'Apply selection';
    apply.onclick = () => {
      state.filters.commits = [...selected];
      closeModal();
      renderFilterUI();
      loadDash();
    };
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';
    cancel.onclick = closeModal;
    f.append(info, clear, cancel, apply);
  };

  const renderList = () => {
    const q = ($('#cSearch').value || '').trim().toLowerCase();
    const hit = q
      ? all.filter((x) => `${x.subject} ${x.author} ${x.hash}`.toLowerCase().includes(q))
      : all;
    $('#cList').innerHTML = hit.slice(0, 300).map((x) => `
      <label class="commit-row">
        <input type="checkbox" value="${x.hash}" ${selected.has(x.hash) ? 'checked' : ''}>
        <div class="c-main">
          <div class="c-subject">${esc(x.subject || '(no subject)')}</div>
          <div class="c-meta"><span class="hash">${x.hash.slice(0, 8)}</span><span>${shortDate(x.ts)}</span><span>${esc(x.author)}</span></div>
        </div>
        <span class="c-churn">λ ${fmtInt(x.churn)}</span>
      </label>`).join('') || '<div class="muted" style="padding:12px">Nothing here</div>';
    $('#cList').querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.onchange = () => { if (cb.checked) selected.add(cb.value); else selected.delete(cb.value); foot(); };
    });
    foot();
  };

  const loadPage = async () => {
    const page = await api('GET', `/api/repos/${rid}/commits?offset=${offset}&limit=200`);
    offset += page.items.length;
    total = page.total;
    all = all.concat(page.items);
    $('#cMore').style.display = page.items.length < 200 ? 'none' : '';
    renderList();
  };

  $('#cMore').onclick = () => loadPage().catch((e) => toast(e.message, 'error'));
  $('#cSearch').oninput = () => renderList();
  try { await loadPage(); } catch (e) { toast(e.message, 'error'); }
}

async function openMergeModal() {
  const rid = state.rid;
  let groups = state.groups.slice();
  openModal('Merge author identities', `
    <div class="modal-hint">Select two or more identities that belong to the same person and merge them into one author (e.g. different names or emails of the same developer). This affects all metrics.</div>
    <div id="mergeList" style="max-height:44vh;overflow:auto"></div>`);

  const render = () => {
    $('#mergeList').innerHTML = groups
      .slice()
      .sort((a, b) => b.commitCount - a.commitCount)
      .map((g) => `
        <label class="commit-row">
          <input type="checkbox" value="${g.id}">
          <div class="c-main">
            <div class="c-subject">${esc(g.name)}</div>
            <div class="c-meta"><span>${esc(g.emails.join(', '))}</span><span>${fmtInt(g.commitCount)} commits</span></div>
          </div>
        </label>`).join('');
  };
  render();

  const f = $('#modalFoot');
  const reset = document.createElement('button');
  reset.className = 'btn btn-ghost btn-sm';
  reset.textContent = 'Reset all merges';
  reset.onclick = async () => {
    try {
      const r = await api('POST', `/api/repos/${rid}/merge`, { groups: [] });
      state.groups = r.groups;
      groups = r.groups;
      render();
      toast('Author merges reset');
      loadDash();
    } catch (e) { toast(e.message, 'error'); }
  };
  const cancel = document.createElement('button');
  cancel.className = 'btn btn-ghost btn-sm';
  cancel.textContent = 'Cancel';
  cancel.onclick = closeModal;
  const merge = document.createElement('button');
  merge.className = 'btn btn-primary btn-sm';
  merge.textContent = 'Merge selected';
  merge.onclick = async () => {
    const ids = [...$('#mergeList').querySelectorAll('input:checked')].map((cb) => Number(cb.value));
    if (ids.length < 2) return toast('Select at least two identities', 'error');
    try {
      const r = await api('POST', `/api/repos/${rid}/merge`, { groups: [ids] });
      state.groups = r.groups;
      groups = r.groups;
      render();
      toast(`Merged ${ids.length} identities`, 'success');
      loadDash();
    } catch (e) { toast(e.message, 'error'); }
  };
  f.append(reset, cancel, merge);
}

// ---- add repositories -------------------------------------------------------------

async function addFromUrl(url) {
  if (!url) return;
  try {
    const meta = await api('POST', '/api/repos', { url, ref: $('#repoRef').value.trim() || 'HEAD' });
    $('#repoUrl').value = '';
    toast(`Cloning ${meta.name}…`);
    await refreshRepos();
    selectRepo(meta.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function addFromZip(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  if ($('#repoRef').value.trim()) fd.append('ref', $('#repoRef').value.trim());
  try {
    const meta = await api('POST', '/api/repos/upload', fd);
    toast(`Extracting ${file.name}…`);
    await refreshRepos();
    selectRepo(meta.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ---- wire up -------------------------------------------------------------------------

function wire() {
  $('#cloneBtn').onclick = () => addFromUrl($('#repoUrl').value.trim());
  $('#repoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromUrl($('#repoUrl').value.trim()); });
  $('#zipBtn').onclick = () => $('#zipInput').click();
  $('#zipInput').onchange = (e) => { addFromZip(e.target.files[0]); e.target.value = ''; };

  document.querySelectorAll('.quick .chip-btn').forEach((btn) => {
    btn.onclick = () => addFromUrl(btn.dataset.url);
  });

  $('#refreshBtn').onclick = async () => {
    try {
      await refreshRepos();
      const meta = state.repos.find((r) => r.id === state.rid);
      if (meta && meta.status === 'ready') await loadReady();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#mergeBtn').onclick = () => openMergeModal().catch((e) => toast(e.message, 'error'));
  $('#objectBtn').onclick = openPathPicker;
  $('#commitsBtn').onclick = () => openCommitPicker().catch((e) => toast(e.message, 'error'));

  $('#authorSel').onchange = (e) => {
    state.filters.author = e.target.value;
    loadDash();
  };

  $('#fromDate').onchange = () => {
    const v = $('#fromDate').value;
    state.filters.from = v ? Date.parse(`${v}T00:00:00`) / 1000 : null;
    state.filters.days = null;
    document.querySelectorAll('.presets .chip-btn').forEach((b) => b.classList.remove('active'));
    loadDash();
  };
  $('#toDate').onchange = () => {
    const v = $('#toDate').value;
    state.filters.to = v ? Date.parse(`${v}T00:00:00`) / 1000 + 86399 : null;
    state.filters.days = null;
    document.querySelectorAll('.presets .chip-btn').forEach((b) => b.classList.remove('active'));
    loadDash();
  };

  document.querySelectorAll('.presets .chip-btn').forEach((btn) => {
    btn.onclick = () => {
      const days = Number(btn.dataset.days);
      state.filters.days = days;
      if (!days) {
        state.filters.from = null;
        state.filters.to = null;
        $('#fromDate').value = '';
        $('#toDate').value = '';
      } else {
        const to = Math.floor(Date.now() / 1000);
        const from = to - days * 86400;
        state.filters.from = from;
        state.filters.to = to;
        $('#fromDate').value = shortDate(from);
        $('#toDate').value = shortDate(to);
      }
      document.querySelectorAll('.presets .chip-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadDash();
    };
  });

  $('#resetBtn').onclick = () => {
    state.filters = { author: '', object: '', from: null, to: null, days: 0, commits: [] };
    $('#fromDate').value = '';
    $('#toDate').value = '';
    document.querySelectorAll('.presets .chip-btn').forEach((b) => b.classList.toggle('active', b.dataset.days === '0'));
    renderFilterUI();
    loadDash();
  };

  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  document.querySelectorAll('#themeToggle .seg-btn').forEach((btn) => {
    btn.onclick = () => {
      applyTheme(btn.dataset.mode);
      if (state.dash) renderCharts(state.dash); // chart palettes live in chart options
    };
  });
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

  window.addEventListener('resize', () => {
    Object.values(state.charts).forEach((c) => { try { c.resize(); } catch { /* noop */ } });
  });
}

async function boot() {
  wire();
  try {
    await refreshRepos();
    const first = state.repos.find((r) => r.status === 'ready');
    if (first) selectRepo(first.id);
  } catch (e) {
    toast(`Cannot reach the server: ${e.message}`, 'error');
  }
}

// ---- theme (light | dark, default light) --------------------------------------

function applyTheme(mode) {
  const dark = mode === 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('rat-theme', dark ? 'dark' : 'light'); } catch (e) { /* storage unavailable */ }
  document.querySelectorAll('#themeToggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === (dark ? 'dark' : 'light')));
}

boot();
