'use strict';

const state = {
  data: null,
  activeDays: 1,
  page: 1,
  periodPage: 1,
  autoEnd: true,
  view: location.hash === '#analytics' ? 'analytics' : 'requests',
  visibleRecords: []
};

const els = {
  status: document.getElementById('statusLine'),
  start: document.getElementById('startInput'),
  end: document.getElementById('endInput'),
  bucket: document.getElementById('bucketInput'),
  pageSize: document.getElementById('pageSizeInput'),
  pageSizeControl: document.getElementById('pageSizeControl'),
  refresh: document.getElementById('refreshBtn'),
  export: document.getElementById('exportBtn'),
  metrics: document.getElementById('overview'),
  requestView: document.getElementById('requestView'),
  analyticsView: document.getElementById('analyticsView'),
  requestRows: document.getElementById('requestRows'),
  serviceTierHeader: document.getElementById('serviceTierHeader'),
  requestCount: document.getElementById('requestCount'),
  prevPage: document.getElementById('prevPageBtn'),
  nextPage: document.getElementById('nextPageBtn'),
  pageInfo: document.getElementById('pageInfo'),
  periodRows: document.getElementById('periodRows'),
  periodCount: document.getElementById('periodCount'),
  periodPrev: document.getElementById('periodPrevBtn'),
  periodNext: document.getElementById('periodNextBtn'),
  periodPages: document.getElementById('periodPages'),
  tokenTrendTotal: document.getElementById('tokenTrendTotal'),
  successRateValue: document.getElementById('successRateValue'),
  modelShare: document.getElementById('modelShare'),
  errorBanner: document.getElementById('errorBanner'),
  dialog: document.getElementById('detailDialog'),
  detail: document.getElementById('detailContent')
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(ms));
}

function fmtFullDate(ms) {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(ms));
}

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(Number(n)));
}

function fmtCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const value = Number(n);
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return fmtNum(value);
}

function fmtMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

function fmtPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return `$${Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function clampText(value, max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function setDefaultRange(days = 1) {
  const end = Date.now();
  let start;
  if (days === 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    start = d.getTime();
  } else if (days <= 0) {
    start = 0;
  } else {
    start = end - days * 24 * 60 * 60 * 1000;
  }
  els.start.value = start ? toLocalInput(start) : '';
  els.end.value = toLocalInput(end);
  state.autoEnd = true;
}

function selectedBucket(start, end) {
  if (els.bucket.value !== 'auto') return els.bucket.value;
  const span = Math.max(0, end - (start || 0));
  if (span <= 2 * 24 * 60 * 60 * 1000) return 'hour';
  if (span <= 120 * 24 * 60 * 60 * 1000) return 'day';
  return 'week';
}

function queryUrl() {
  if (state.autoEnd) els.end.value = toLocalInput(Date.now());
  const params = new URLSearchParams();
  const start = fromLocalInput(els.start.value);
  const end = state.autoEnd ? Date.now() : fromLocalInput(els.end.value) || Date.now();
  if (start) params.set('start_ms', String(start));
  else params.set('days', '0');
  params.set('end_ms', String(end));
  params.set('bucket', selectedBucket(start, end));
  params.set('page', String(state.page));
  params.set('page_size', els.pageSize.value || '6');
  return `/api/data?${params.toString()}`;
}

async function loadData() {
  document.body.classList.add('is-loading');
  els.refresh.disabled = true;
  els.status.textContent = '正在同步本地 session 数据';
  els.errorBanner.hidden = true;
  try {
    const res = await fetch(queryUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    state.page = state.data.pagination?.page || state.page;
    render();
  } finally {
    document.body.classList.remove('is-loading');
    els.refresh.disabled = false;
  }
}

function metric(label, value, sub, accent, index, icon) {
  return `<article class="metric ${accent}">
    <span class="metric-icon" aria-hidden="true">${icon}</span>
    <div class="metric-copy">
      <div class="metric-head"><span class="label">${escapeHtml(label)}</span><span class="index">0${index}</span></div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="sub">${escapeHtml(sub || '')}</div>
    </div>
  </article>`;
}

function countValue(rows, key) {
  return rows?.find((row) => row.key === key)?.count || 0;
}

function renderMetrics(data) {
  const usage = data.summary.request_usage;
  const cost = data.summary.estimated_cost || {};
  const success = countValue(data.counts.status, 'success');
  const failed = countValue(data.counts.status, 'failed');
  const costSub = cost.lower_bound_records
    ? `${fmtNum(cost.lower_bound_records)} 条缺缓存写入量`
    : `${fmtNum(cost.priced_records)} 条已计价`;
  els.metrics.innerHTML = [
    metric('请求记录', fmtNum(data.summary.request_records), `成功 ${fmtNum(success)} · 失败 ${fmtNum(failed)}`, 'accent-green', 1, '∿'),
    metric('总 Token', fmtCompact(usage.total_tokens), '输入 + 输出合计', 'accent-blue', 2, '▤'),
    metric('缓存命中率', fmtPercent(data.summary.cache_hit_rate), `${fmtCompact(usage.cached_input_tokens)} 缓存 Token`, 'accent-green', 3, '◕'),
    metric('输出 Token', fmtCompact(usage.output_tokens), '请求输出合计', 'accent-cyan', 4, '↑'),
    metric('估算金额', fmtMoney(cost.amount_usd), costSub, 'accent-amber', 5, '$'),
    metric('平均响应耗时', fmtMs(data.summary.average_request_duration_ms_estimate),
      `首输出 ${fmtMs(data.summary.average_first_output_ms_estimate)}`, 'accent-red', 6, '◷')
  ].join('');
}

function effectiveDurationMs(record) {
  return record.duration_ms ?? record.duration_ms_estimate ?? record.turn_elapsed_ms_estimate;
}

function statusPill(record) {
  const failed = String(record.status || 'success').toLowerCase() === 'failed';
  const title = failed ? record.error_reason || 'session 未记录明确错误原因' : '已记录请求级 token_count';
  return `<span class="pill ${failed ? 'bad' : 'ok'}" title="${escapeHtml(title)}">${failed ? '失败' : '成功'}</span>`;
}

function serviceTierPill(record) {
  const tier = String(record.service_tier || '').trim().toLowerCase();
  if (!tier) return '<span class="muted">未知</span>';
  const label = { fast: 'Fast', priority: 'Fast', default: '标准', standard: '标准', flex: 'Flex' }[tier] || tier;
  const klass = tier === 'fast' || tier === 'priority' ? 'warn' : 'muted-pill';
  return `<span class="pill ${klass}" title="请求级 service_tier=${escapeHtml(tier)}">${escapeHtml(label)}</span>`;
}

function serviceTierLabel(value) {
  const tier = String(value || '').trim().toLowerCase();
  return { fast: 'Fast', priority: 'Fast', default: '标准', standard: '标准', flex: 'Flex' }[tier] || tier || '未知';
}

function displayRecordId(recordId) {
  return String(recordId || '').replace(/^session-token-/, '');
}

function sourceLabel(context = {}) {
  const provider = context.model_provider ? ` / ${context.model_provider}` : '';
  return `Codex session${provider}`;
}

function costTitle(cost) {
  if (!cost?.known) return cost?.reason || '模型费率未知';
  const parts = [`${cost.model_key} / ${cost.tier}`];
  if (cost.is_lower_bound) parts.push('缺少缓存写入 Token，金额未包含未知写入附加费');
  return parts.join('；');
}

function renderRequests() {
  const rows = state.data?.requests || [];
  const page = state.data?.pagination || { page: 1, total_pages: 1, total_records: rows.length };
  const showServiceTier = Number(state.data?.summary?.service_tier_known_records || 0) > 0;
  state.visibleRecords = rows;
  els.serviceTierHeader.hidden = !showServiceTier;
  els.requestCount.textContent = `${fmtNum(rows.length)} 条当前页 · ${fmtNum(page.total_records)} 条总记录`;
  els.pageInfo.textContent = `${fmtNum(page.page)} / ${fmtNum(page.total_pages)}`;
  els.prevPage.disabled = page.page <= 1;
  els.nextPage.disabled = page.page >= page.total_pages;

  els.requestRows.innerHTML = rows.map((r, index) => {
    const displayId = displayRecordId(r.record_id || r.conversation_id || '');
    const failed = String(r.status || 'success').toLowerCase() === 'failed';
    return `<tr class="${failed ? 'failed-row' : ''}">
      <td class="mono" title="${escapeHtml(fmtFullDate(r.completed_ms))}">${fmtDate(r.completed_ms)}</td>
      <td class="mono" title="${escapeHtml(displayId)}">${escapeHtml(clampText(displayId || '—', 24))}</td>
      <td><span class="pill">${escapeHtml(r.model || 'unknown')}</span></td>
      ${showServiceTier ? `<td>${serviceTierPill(r)}</td>` : ''}
      <td>${statusPill(r)}</td>
      <td class="num">${fmtCompact(r.usage.input_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.cached_input_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.output_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.total_tokens)}</td>
      <td class="num" title="${escapeHtml(costTitle(r.cost_estimate))}">${fmtMoney(r.cost_estimate?.amount_usd)}</td>
      <td class="num" title="${escapeHtml(r.first_output_basis || '')}">${fmtMs(r.first_output_ms_estimate)}</td>
      <td class="num" title="${escapeHtml(r.duration_basis || '')}">${fmtMs(effectiveDurationMs(r))}</td>
      <td class="preview"><span title="${escapeHtml(r.source_context?.cwd || '')}">${escapeHtml(sourceLabel(r.source_context))}</span></td>
      <td class="preview action-column"><button type="button" data-record-index="${index}">打开</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="${showServiceTier ? 14 : 13}" class="empty-row">当前时间范围内没有请求记录</td></tr>`;
}

function detailList(entries) {
  return `<dl class="detail-list">${entries.map(([key, value]) =>
    `<div><dt>${escapeHtml(key)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}

function renderDetail(record) {
  const failed = record.status === 'failed';
  const raw = {
    token_usage_normalized: record.usage,
    token_usage_source: record.usage_source,
    cost_estimate: record.cost_estimate,
    service_tier: record.service_tier,
    status: record.status,
    error_reason: record.error_reason,
    session_total_usage_snapshot: record.total_usage_snapshot,
    model_context_window: record.model_context_window,
    timing_estimate: {
      request_duration_ms_estimate: record.request_duration_ms_estimate,
      request_duration_basis: record.request_duration_basis,
      first_output_ms_estimate: record.first_output_ms_estimate,
      first_output_basis: record.first_output_basis,
      turn_id: record.turn_id,
      turn_sequence: record.turn_sequence
    },
    source_context: record.source_context
  };
  els.detail.innerHTML = `
    <section class="detail-hero">
      <div><h3>${escapeHtml(record.model || 'unknown')}</h3><p>${escapeHtml(displayRecordId(record.record_id))}</p></div>
      <span class="pill ${failed ? 'bad' : 'ok'}">${failed ? '失败' : '成功'}</span>
    </section>
    ${record.error_reason ? `<section class="detail-section error-detail"><h3>错误原因</h3><p>${escapeHtml(record.error_reason)}</p></section>` : ''}
    <div class="detail-grid">
      <section class="detail-section"><h3>Token 用量</h3>${detailList([
        ['输入', fmtNum(record.usage.input_tokens)], ['缓存', fmtNum(record.usage.cached_input_tokens)],
        ['输出', fmtNum(record.usage.output_tokens)], ['总计', fmtNum(record.usage.total_tokens)]
      ])}</section>
      <section class="detail-section"><h3>本地时间估算</h3>${detailList([
        ['记录时间', fmtFullDate(record.completed_ms)], ['首输出', fmtMs(record.first_output_ms_estimate)],
        ['响应耗时', fmtMs(effectiveDurationMs(record))], ['估算费用', fmtMoney(record.cost_estimate?.amount_usd)]
      ])}</section>
      <section class="detail-section"><h3>来源上下文</h3>${detailList([
        ['会话来源', sourceLabel(record.source_context)], ['服务档位', serviceTierLabel(record.service_tier)],
        ['上下文窗口', fmtNum(record.model_context_window)], ['Turn', String(record.turn_sequence ?? '—')]
      ])}</section>
    </div>
    <details class="raw-details"><summary>查看规范化原始字段</summary><pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre></details>`;
  els.dialog.showModal();
}

function bindDetailButtons() {
  document.querySelectorAll('[data-record-index]').forEach((button) => {
    button.addEventListener('click', () => renderDetail(state.visibleRecords[Number(button.dataset.recordIndex)]));
  });
}

function chartContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px "Cascadia Code", Consolas, monospace';
  return { ctx, width, height };
}

function shortBucketLabel(label) {
  const value = String(label || '');
  return value.includes(' ') ? value.slice(11) : value.slice(5);
}

function drawAxes(ctx, width, height, min, max, formatter) {
  const box = { left: 44, right: width - 10, top: 10, bottom: height - 24 };
  ctx.strokeStyle = '#e3e6e9';
  ctx.fillStyle = '#737e89';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = box.top + (box.bottom - box.top) * i / 3;
    ctx.beginPath(); ctx.moveTo(box.left, y); ctx.lineTo(box.right, y); ctx.stroke();
    const value = max - (max - min) * i / 3;
    ctx.fillText(formatter(value), 2, y + 3);
  }
  return box;
}

function drawLineChart(canvas, labels, series, options = {}) {
  const { ctx, width, height } = chartContext(canvas);
  const values = series.flatMap((item) => item.values).filter(Number.isFinite);
  if (!values.length) return;
  const min = options.min ?? 0;
  const rawMax = options.max ?? Math.max(...values, 1);
  const max = rawMax === min ? min + 1 : rawMax;
  const formatter = options.axisFormatter || fmtCompact;
  const box = drawAxes(ctx, width, height, min, max, formatter);
  const xAt = (index) => box.left + (box.right - box.left) * (labels.length <= 1 ? .5 : index / (labels.length - 1));
  const yAt = (value) => box.bottom - (box.bottom - box.top) * (value - min) / (max - min);

  series.forEach((item, seriesIndex) => {
    const points = item.values.map((value, index) => Number.isFinite(value)
      ? { x: xAt(index), y: yAt(value) }
      : null);
    const finitePoints = points.filter(Boolean);
    if (item.fill && finitePoints.length > 1 && finitePoints.length === points.length) {
      ctx.save(); ctx.globalAlpha = .15; ctx.fillStyle = item.color;
      ctx.beginPath(); ctx.moveTo(points[0].x, box.bottom);
      points.forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.lineTo(points.at(-1).x, box.bottom); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.strokeStyle = item.color; ctx.lineWidth = seriesIndex === 0 ? 2.2 : 1.8;
    let drawing = false;
    ctx.beginPath();
    points.forEach((point) => {
      if (!point) { drawing = false; return; }
      if (drawing) ctx.lineTo(point.x, point.y);
      else { ctx.moveTo(point.x, point.y); drawing = true; }
    });
    ctx.stroke();
    ctx.fillStyle = item.color;
    finitePoints.forEach((point) => { ctx.beginPath(); ctx.arc(point.x, point.y, 2.4, 0, Math.PI * 2); ctx.fill(); });
  });

  ctx.fillStyle = '#737e89';
  const indexes = [...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])];
  indexes.forEach((index) => {
    const text = shortBucketLabel(labels[index]);
    ctx.fillText(text, Math.max(box.left, Math.min(xAt(index) - 15, box.right - 34)), height - 6);
  });
}

function drawGroupedBars(canvas, labels, series) {
  const { ctx, width, height } = chartContext(canvas);
  const max = Math.max(1, ...series.flatMap((item) => item.values).filter(Number.isFinite));
  const box = drawAxes(ctx, width, height, 0, max, fmtCompact);
  const groupWidth = (box.right - box.left) / Math.max(labels.length, 1);
  const barWidth = Math.max(2, Math.min(10, groupWidth / (series.length + 1)));
  series.forEach((item, seriesIndex) => {
    ctx.fillStyle = item.color;
    item.values.forEach((value, index) => {
      const barHeight = (box.bottom - box.top) * value / max;
      const x = box.left + groupWidth * index + (groupWidth - barWidth * series.length) / 2 + barWidth * seriesIndex;
      ctx.fillRect(x, box.bottom - barHeight, Math.max(1, barWidth - 1), barHeight);
    });
  });
  ctx.fillStyle = '#737e89';
  [0, Math.floor((labels.length - 1) / 2), labels.length - 1].forEach((index) => {
    if (index < 0) return;
    ctx.fillText(shortBucketLabel(labels[index]), box.left + groupWidth * index, height - 6);
  });
}

function drawDonutChart(canvas, rows, colors) {
  const { ctx, width, height } = chartContext(canvas);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * .4;
  const innerRadius = radius * .58;
  let angle = -Math.PI / 2;
  rows.forEach((row, index) => {
    const nextAngle = angle + Math.PI * 2 * row.count / total;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle, nextAngle);
    ctx.arc(cx, cy, innerRadius, nextAngle, angle, true);
    ctx.closePath();
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    angle = nextAngle;
  });
  ctx.beginPath();
  ctx.arc(cx, cy, innerRadius - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.fillStyle = '#121923';
  ctx.font = '700 15px "Cascadia Code", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(fmtNum(total), cx, cy + 5);
  ctx.textAlign = 'left';
}

function renderModelShare(rows) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const visibleRows = rows.slice(0, 5);
  const colors = ['#2078ff', '#08a060', '#20c0e8', '#fc9408', '#7153a6'];
  els.modelShare.innerHTML = visibleRows.map((row, index) => {
    const share = total ? row.count / total : 0;
    return `<div class="model-row">
      <span class="model-swatch" style="background:${colors[index]}"></span>
      <span class="model-name" title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</span>
      <span class="model-value">${fmtPercent(share)} (${fmtNum(row.count)})</span>
    </div>`;
  }).join('') || '<div class="muted">暂无模型数据</div>';
  drawDonutChart(document.getElementById('modelShareChart'), visibleRows, colors);
}

function renderAnalytics() {
  const data = state.data;
  const buckets = data?.buckets || [];
  const labels = buckets.map((bucket) => bucket.label);
  const usage = data?.summary?.request_usage || {};
  const success = countValue(data?.counts?.status, 'success');
  const total = data?.summary?.request_records || 0;
  els.tokenTrendTotal.textContent = fmtCompact(usage.total_tokens);
  els.successRateValue.textContent = fmtPercent(total ? success / total : null);
  document.getElementById('costTrendTotal').textContent = fmtMoney(data?.summary?.estimated_cost?.amount_usd);
  document.getElementById('latencyTrendTotal').textContent = fmtMs(data?.summary?.average_request_duration_ms_estimate);
  document.getElementById('firstOutputTotal').textContent = fmtMs(data?.summary?.average_first_output_ms_estimate);
  const bucketLabels = { hour: '小时', day: '天', week: '周' };
  els.periodCount.textContent = `${fmtNum(buckets.length)} 个周期 · ${bucketLabels[data?.range?.bucket] || '天'}粒度`;

  drawLineChart(document.getElementById('tokenTrendChart'), labels, [
    { values: buckets.map((b) => b.usage.total_tokens), color: '#08a060', fill: true }
  ]);
  drawLineChart(document.getElementById('successTrendChart'), labels, [
    { values: buckets.map((b) => b.success_rate), color: '#08a060' },
    { values: buckets.map((b) => Number.isFinite(b.success_rate) ? 1 - b.success_rate : null), color: '#f83438' }
  ], { min: 0, max: 1, axisFormatter: (value) => `${Math.round(value * 100)}%` });
  drawGroupedBars(document.getElementById('tokenMixChart'), labels, [
    { values: buckets.map((b) => b.usage.input_tokens), color: '#2078ff' },
    { values: buckets.map((b) => b.usage.cached_input_tokens), color: '#08a060' },
    { values: buckets.map((b) => b.usage.output_tokens), color: '#20c0e8' }
  ]);
  drawLineChart(document.getElementById('costTrendChart'), labels, [
    { values: buckets.map((b) => b.estimated_cost?.amount_usd || 0), color: '#fc9408', fill: true }
  ], { axisFormatter: (value) => {
    const amount = Math.max(0, value);
    return `$${amount.toFixed(amount < 10 ? 1 : 0)}`;
  } });
  drawLineChart(document.getElementById('latencyTrendChart'), labels, [
    { values: buckets.map((b) => Number.isFinite(b.average_request_duration_ms_estimate) ? b.average_request_duration_ms_estimate / 1000 : null), color: '#2078ff', fill: true }
  ], { axisFormatter: (value) => `${Math.round(value)}s` });
  renderModelShare(data?.counts?.model || []);

  const periodPageSize = 5;
  const periodPageCount = Math.max(1, Math.ceil(buckets.length / periodPageSize));
  state.periodPage = Math.min(Math.max(1, state.periodPage), periodPageCount);
  const periodRows = [...buckets].reverse().slice((state.periodPage - 1) * periodPageSize, state.periodPage * periodPageSize);
  els.periodRows.innerHTML = periodRows.map((bucket) => `<tr>
    <td class="mono">${escapeHtml(bucket.label)}</td>
    <td class="num">${fmtNum(bucket.records)}</td>
    <td class="num"><span class="success-text">${fmtNum(bucket.success_records)}</span> / ${fmtNum(bucket.failed_records)}</td>
    <td class="num">${fmtCompact(bucket.usage.total_tokens)}</td>
    <td class="num">${fmtCompact(bucket.usage.cached_input_tokens)}</td>
    <td class="num">${fmtPercent(bucket.cache_hit_rate)}</td>
    <td class="num">${fmtCompact(bucket.usage.output_tokens)}</td>
    <td class="num">${fmtMoney(bucket.estimated_cost?.amount_usd)}</td>
    <td class="num">${fmtMs(bucket.average_request_duration_ms_estimate)}</td>
    <td class="num">${fmtMs(bucket.average_first_output_ms_estimate)}</td>
  </tr>`).join('') || '<tr><td colspan="10" class="empty-row">当前范围没有可汇总的数据</td></tr>';
  const pageItems = Array.from({ length: Math.min(periodPageCount, 5) }, (_, index) => index + 1);
  els.periodPages.innerHTML = pageItems.map((page) => `<button type="button" data-period-page="${page}" class="${page === state.periodPage ? 'active' : ''}">${page}</button>`).join('')
    + (periodPageCount > 5 ? `<span>…</span><button type="button" data-period-page="${periodPageCount}" class="${periodPageCount === state.periodPage ? 'active' : ''}">${periodPageCount}</button>` : '');
  els.periodPrev.disabled = state.periodPage <= 1;
  els.periodNext.disabled = state.periodPage >= periodPageCount;
}

function setView(view, updateHash = true) {
  state.view = view === 'analytics' ? 'analytics' : 'requests';
  document.querySelectorAll('.nav-tab').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const showAnalytics = state.view === 'analytics';
  els.requestView.hidden = showAnalytics;
  els.requestView.classList.toggle('active', !showAnalytics);
  els.analyticsView.hidden = !showAnalytics;
  els.analyticsView.classList.toggle('active', showAnalytics);
  els.pageSizeControl.hidden = showAnalytics;
  if (updateHash) history.replaceState(null, '', showAnalytics ? '#analytics' : '#requests');
  if (showAnalytics && state.data) requestAnimationFrame(renderAnalytics);
}

function render() {
  if (!state.data) return;
  renderMetrics(state.data);
  renderRequests();
  bindDetailButtons();
  setView(state.view, false);
  const excluded = state.data.diagnostics?.excluded_system_token_count_records || 0;
  const excludedText = excluded ? ` · 已排除 ${fmtNum(excluded)} 条系统维护事件` : '';
  els.status.textContent = `更新于 ${fmtFullDate(state.data.generated_at)}${excludedText}`;
}

function resetPageAndLoad() {
  state.page = 1;
  state.periodPage = 1;
  loadData().catch(showError);
}

function clearQuickRange() {
  state.activeDays = null;
  document.querySelectorAll('.chip').forEach((button) => button.classList.remove('active'));
}

document.querySelectorAll('.nav-tab').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

document.querySelectorAll('.chip').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    if (button.dataset.days === 'custom') {
      state.activeDays = null;
      els.start.focus();
      return;
    }
    state.activeDays = Number(button.dataset.days);
    setDefaultRange(state.activeDays);
    resetPageAndLoad();
  });
});

els.refresh.addEventListener('click', () => loadData().catch(showError));
els.export.addEventListener('click', () => {
  if (!state.data) return;
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `codex-session-token-records-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
els.start.addEventListener('change', () => { clearQuickRange(); resetPageAndLoad(); });
els.end.addEventListener('change', () => { clearQuickRange(); state.autoEnd = false; resetPageAndLoad(); });
els.bucket.addEventListener('change', resetPageAndLoad);
els.pageSize.addEventListener('change', resetPageAndLoad);
els.prevPage.addEventListener('click', () => {
  state.page = Math.max(1, state.page - 1);
  loadData().catch(showError);
});
els.nextPage.addEventListener('click', () => {
  const totalPages = state.data?.pagination?.total_pages || state.page + 1;
  state.page = Math.min(totalPages, state.page + 1);
  loadData().catch(showError);
});
els.periodPrev.addEventListener('click', () => {
  state.periodPage = Math.max(1, state.periodPage - 1);
  renderAnalytics();
});
els.periodNext.addEventListener('click', () => {
  state.periodPage += 1;
  renderAnalytics();
});
els.periodPages.addEventListener('click', (event) => {
  const button = event.target.closest('[data-period-page]');
  if (!button) return;
  state.periodPage = Number(button.dataset.periodPage);
  renderAnalytics();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === 'analytics' && state.data) renderAnalytics();
  }, 120);
});

function showError(error) {
  document.body.classList.remove('is-loading');
  els.refresh.disabled = false;
  els.status.textContent = `同步失败 · ${error.message}`;
  els.errorBanner.textContent = `数据同步失败：${error.message}。现有页面数据已保留。`;
  els.errorBanner.hidden = false;
  console.error(error);
}

setDefaultRange(1);
setView(state.view, false);
loadData().catch(showError);
setInterval(() => loadData().catch(showError), 120_000);
