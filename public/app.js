'use strict';

const state = {
  data: null,
  activeDays: 1,
  page: 1,
  autoEnd: true
};

const els = {
  status: document.getElementById('statusLine'),
  start: document.getElementById('startInput'),
  end: document.getElementById('endInput'),
  pageSize: document.getElementById('pageSizeInput'),
  refresh: document.getElementById('refreshBtn'),
  export: document.getElementById('exportBtn'),
  metrics: document.getElementById('overview'),
  requestRows: document.getElementById('requestRows'),
  serviceTierHeader: document.getElementById('serviceTierHeader'),
  requestCount: document.getElementById('requestCount'),
  prevPage: document.getElementById('prevPageBtn'),
  nextPage: document.getElementById('nextPageBtn'),
  pageInfo: document.getElementById('pageInfo'),
  dialog: document.getElementById('detailDialog'),
  detail: document.getElementById('detailText')
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
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ms));
}

function fmtFullDate(ms) {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
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
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtCostEstimate(cost) {
  return fmtMoney(cost?.amount_usd);
}

function costEstimateTitle(cost) {
  if (!cost?.known) return cost?.reason || '';
  const parts = [`${cost.model_key} / ${cost.tier}`];
  if (cost.is_lower_bound) {
    parts.push('session 未提供 cache_write_tokens；金额不含未知的 GPT-5.6 缓存写入附加费');
  }
  return parts.join('；');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clampText(value, max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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

function queryUrl() {
  if (state.autoEnd) els.end.value = toLocalInput(Date.now());
  const params = new URLSearchParams();
  const start = fromLocalInput(els.start.value);
  const end = state.autoEnd ? Date.now() : fromLocalInput(els.end.value) || Date.now();
  if (start) params.set('start_ms', String(start));
  else params.set('days', '0');
  params.set('end_ms', String(end));
  params.set('bucket', 'day');
  params.set('page', String(state.page));
  params.set('page_size', els.pageSize.value || '7');
  return `/api/data?${params.toString()}`;
}

async function loadData() {
  els.status.textContent = '采集中…';
  const res = await fetch(queryUrl(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.data = await res.json();
  state.page = state.data.pagination?.page || state.page;
  render();
}

function metric(label, value, sub, accent) {
  return `<article class="metric ${accent}">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(value)}</div>
    <div class="sub">${escapeHtml(sub || '')}</div>
  </article>`;
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
    metric('请求记录', fmtNum(data.summary.request_records), `成功 ${fmtNum(success)} / 失败 ${fmtNum(failed)}`, 'accent-green'),
    metric('总 Token', fmtCompact(usage.total_tokens), 'input + output', 'accent-cyan'),
    metric('缓存命中率', fmtPercent(data.summary.cache_hit_rate), `${fmtCompact(usage.cached_input_tokens)} cached`, 'accent-violet'),
    metric('输出 Token', fmtCompact(usage.output_tokens), 'last output tokens', 'accent-amber'),
    metric('估算金额', fmtCostEstimate(cost), costSub, 'accent-amber'),
    metric(
      '平均响应耗时',
      fmtMs(data.summary.average_request_duration_ms_estimate ?? data.summary.average_turn_elapsed_ms_estimate),
      `首输出 ${fmtMs(data.summary.average_first_output_ms_estimate)}`,
      'accent-red'
    )
  ].join('');
}

function countValue(rows, key) {
  return rows?.find((row) => row.key === key)?.count || 0;
}

function formatCountKey(key, label) {
  const value = String(key || 'unknown');
  if (label === '状态' && value === 'success') return '成功';
  if (label === '状态' && value === 'failed') return '失败';
  if (label === '来源' && (value === 'codex-tui' || value === 'cli')) return 'Codex 本地';
  if (label === '来源' && value === 'Codex Desktop') return 'Codex App';
  return value;
}

function topCounts(rows, label) {
  if (!rows?.length) return `${label}：暂无`;
  return `${label}：${rows.slice(0, 4).map((row) => `${formatCountKey(row.key, label)} ${row.count}`).join(' / ')}`;
}

function filteredRequests() {
  return state.data?.requests || [];
}

function effectiveDurationMs(record) {
  return record.duration_ms ?? record.duration_ms_estimate ?? record.turn_elapsed_ms_estimate;
}

function durationTitle(record) {
  return record.duration_basis || 'local_session_task_started_to_token_count';
}

function statusPill(record) {
  const failed = String(record.status || 'success').toLowerCase() === 'failed';
  const label = failed ? '失败' : '成功';
  const title = failed ? record.error_reason || '没有记录明确错误原因' : 'session token_count recorded';
  return `<span class="pill ${failed ? 'bad' : 'ok'}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function serviceTierPill(record) {
  const tier = String(record.service_tier || '').trim().toLowerCase();
  if (!tier) return '<span class="muted">未知</span>';
  const labels = {
    fast: 'Fast',
    priority: 'Fast',
    default: '标准',
    standard: '标准',
    flex: 'Flex'
  };
  const label = labels[tier] || tier;
  const klass = tier === 'fast' || tier === 'priority' ? 'warn' : 'muted-pill';
  const titleParts = [`请求级 service_tier=${tier}`];
  if (tier === 'priority') titleParts.push('Codex Fast mode 使用 priority processing');
  if (record.service_tier_source) titleParts.push(`来源：${record.service_tier_source}`);
  return `<span class="pill ${klass}" title="${escapeHtml(titleParts.join('；'))}">${escapeHtml(label)}</span>`;
}

function displayRecordId(recordId) {
  return String(recordId || '').replace(/^session-token-/, '');
}

function sourceLabel(context = {}) {
  const client = context.originator || context.session_source;
  const clientLabel = client?.startsWith('codex') || client === 'cli' ? 'Codex 本地' : client || '本地 session';
  return [clientLabel, context.model_provider].filter(Boolean).join(' / ');
}

function renderRequests() {
  const rows = filteredRequests();
  const page = state.data?.pagination || { page: 1, total_pages: 1, total_records: rows.length, page_size: 7 };
  const showServiceTier = Number(state.data?.summary?.service_tier_known_records || 0) > 0;
  els.serviceTierHeader.hidden = !showServiceTier;
  els.requestCount.textContent = `${fmtNum(rows.length)} 当前页 / ${fmtNum(page.total_records)} 总记录`;
  els.pageInfo.textContent = `${fmtNum(page.page)} / ${fmtNum(page.total_pages)}`;
  els.prevPage.disabled = page.page <= 1;
  els.nextPage.disabled = page.page >= page.total_pages;

  els.requestRows.innerHTML = rows.map((r) => {
    const source = [
      sourceLabel(r.source_context)
    ]
      .filter(Boolean)
      .join(' / ') || '—';
    const displayId = displayRecordId(r.record_id || r.conversation_id || '');
    const detail = JSON.stringify({
      token_usage_normalized: r.usage,
      token_usage_source: r.usage_source,
      cost_estimate: r.cost_estimate,
      service_tier: r.service_tier,
      service_tier_source: r.service_tier_source,
      status: r.status,
      error_reason: r.error_reason,
      session_total_usage_snapshot: r.total_usage_snapshot,
      model_context_window: r.model_context_window,
      local_session_timing_estimate: {
        duration_ms_estimate: r.duration_ms_estimate,
        duration_basis: r.duration_basis,
        request_started_ms_estimate: r.request_started_ms_estimate,
        request_duration_ms_estimate: r.request_duration_ms_estimate,
        request_duration_basis: r.request_duration_basis,
        first_output_ms_estimate: r.first_output_ms_estimate,
        first_output_event_ms: r.first_output_event_ms,
        first_output_event_type: r.first_output_event_type,
        first_output_basis: r.first_output_basis,
        turn_id: r.turn_id,
        turn_sequence: r.turn_sequence,
        turn_started_ms: r.turn_started_ms,
        turn_completed_ms: r.turn_completed_ms,
        turn_elapsed_ms_estimate: r.turn_elapsed_ms_estimate,
        turn_duration_ms_estimate: r.turn_duration_ms_estimate
      },
      response_timestamps: {
        created_ms: r.created_ms,
        completed_ms: r.completed_ms,
        response_timestamp_ms: r.response_timestamp_ms,
        response_timestamp_source: r.response_timestamp_source
      },
      source_context: r.source_context
    }, null, 2);
    return `<tr>
      <td class="mono">${fmtDate(r.completed_ms)}</td>
      <td class="mono">${escapeHtml(clampText(displayId || '—', 24))}</td>
      <td><span class="pill">${escapeHtml(r.model || 'unknown')}</span></td>
      ${showServiceTier ? `<td>${serviceTierPill(r)}</td>` : ''}
      <td>${statusPill(r)}</td>
      <td class="num">${fmtCompact(r.usage.input_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.cached_input_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.output_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.total_tokens)}</td>
      <td class="num" title="${escapeHtml(costEstimateTitle(r.cost_estimate))}">${fmtCostEstimate(r.cost_estimate)}</td>
      <td class="num" title="${escapeHtml(r.first_output_basis || '')}">${fmtMs(r.first_output_ms_estimate)}</td>
      <td class="num" title="${escapeHtml(durationTitle(r))}">${fmtMs(effectiveDurationMs(r))}</td>
      <td class="preview"><span title="${escapeHtml(r.source_context?.cwd || '')}">${escapeHtml(clampText(source, 80))}</span></td>
      <td class="preview"><button type="button" data-detail="${escapeHtml(detail)}">查看</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="${showServiceTier ? 14 : 13}" class="muted">暂无请求记录。</td></tr>`;
}

function bindDetailButtons() {
  document.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.detail.textContent = btn.dataset.detail;
      els.dialog.showModal();
    });
  });
}

function render() {
  const data = state.data;
  if (!data) return;
  renderMetrics(data);
  renderRequests();
  bindDetailButtons();
  els.status.textContent = `更新 ${fmtFullDate(data.generated_at)} / session token_count 口径`;
}

function resetPageAndLoad() {
  state.page = 1;
  loadData().catch(showError);
}

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    state.activeDays = Number(btn.dataset.days);
    setDefaultRange(state.activeDays);
    resetPageAndLoad();
  });
});

els.refresh.addEventListener('click', () => loadData().catch(showError));
els.export.addEventListener('click', () => {
  if (!state.data) return;
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `codex-session-token-records-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
els.start.addEventListener('change', resetPageAndLoad);
els.end.addEventListener('change', () => {
  state.autoEnd = false;
  resetPageAndLoad();
});
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

function showError(error) {
  els.status.textContent = `错误：${error.message}`;
  console.error(error);
}

setDefaultRange(1);
loadData().catch(showError);
setInterval(() => loadData().catch(showError), 120_000);
