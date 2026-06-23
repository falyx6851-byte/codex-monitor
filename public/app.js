'use strict';

const state = {
  data: null,
  lastUrl: '',
  activeDays: 1
};

const els = {
  status: document.getElementById('statusLine'),
  start: document.getElementById('startInput'),
  end: document.getElementById('endInput'),
  bucket: document.getElementById('bucketInput'),
  search: document.getElementById('searchInput'),
  refresh: document.getElementById('refreshBtn'),
  export: document.getElementById('exportBtn'),
  metrics: document.getElementById('metricGrid'),
  quotaStamp: document.getElementById('quotaStamp'),
  quotaBars: document.getElementById('quotaBars'),
  trustList: document.getElementById('trustList'),
  chart: document.getElementById('tokenChart'),
  modelList: document.getElementById('modelList'),
  requestRows: document.getElementById('requestRows'),
  requestCount: document.getElementById('requestCount'),
  sessionRows: document.getElementById('sessionRows'),
  sessionCount: document.getElementById('sessionCount'),
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

function fmtUsd(cost) {
  if (!cost || cost.usd == null) return cost?.label || '—';
  if (cost.usd < 0.01) return `$${cost.usd.toFixed(4)}`;
  return `$${cost.usd.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clampText(value, max = 180) {
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
}

function queryUrl() {
  const params = new URLSearchParams();
  const start = fromLocalInput(els.start.value);
  const end = fromLocalInput(els.end.value) || Date.now();
  if (start) params.set('start_ms', String(start));
  else params.set('days', '0');
  params.set('end_ms', String(end));
  params.set('bucket', els.bucket.value);
  params.set('limit', '700');
  return `/api/data?${params.toString()}`;
}

async function loadData() {
  const url = queryUrl();
  state.lastUrl = url;
  els.status.textContent = '采集中…';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.data = await res.json();
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
  const s = data.summary;
  const usage = s.request_usage;
  const sessionUsage = s.session_cumulative_usage || s.session_usage;
  const quality = data.data_quality?.request_usage_sources || {};
  const rawCount = Number(quality.raw_sse_plus_otel || 0) + Number(quality.raw_sse || 0);
  els.metrics.innerHTML = [
    metric('窗口请求 Token', fmtCompact(usage.total_tokens), `${fmtNum(s.requests)} completed 请求`, 'accent-green'),
    metric('输入 Token', fmtCompact(usage.input_tokens), `缓存 ${fmtCompact(usage.cached_input_tokens)}`, 'accent-cyan'),
    metric('输出 Token', fmtCompact(usage.output_tokens), `Reasoning ${fmtCompact(usage.reasoning_output_tokens)}`, 'accent-violet'),
    metric('请求来源', fmtNum(s.requests), `raw ${fmtNum(rawCount)} / otel ${fmtNum(quality.otel_only || 0)}`, 'accent-amber'),
    metric('平均耗时', fmtMs(s.average_latency_ms), `首 token ${fmtMs(s.average_first_token_ms_estimate)} 估`, 'accent-red'),
    metric('估算花费', s.known_cost_requests ? `$${s.known_cost_usd.toFixed(2)}` : '未配置', `${s.known_cost_requests}/${s.requests} 请求有单价 / 会话累计 ${fmtCompact(sessionUsage.total_tokens)}`, 'accent-green')
  ].join('');
}

function renderQuota(data) {
  const latest = data.latest_rate_limit;
  if (!latest?.rate_limits) {
    els.quotaStamp.textContent = '暂无 rate_limits';
    els.quotaBars.innerHTML = '<div class="muted">本时间段内没有可用额度事件。</div>';
    return;
  }
  els.quotaStamp.textContent = `${fmtFullDate(latest.ts)} / ${latest.session_id}`;
  const rows = [];
  for (const key of ['primary', 'secondary']) {
    const item = latest.rate_limits[key];
    if (!item) continue;
    const used = Number(item.used_percent || 0);
    const remain = Math.max(0, 100 - used);
    rows.push(`<div class="quota-row">
      <div class="quota-meta">
        <strong>${key === 'primary' ? '短窗口' : '长窗口'}</strong>
        <span>已用 ${used.toFixed(1)}% / 剩余 ${remain.toFixed(1)}% / ${item.window_minutes || '—'} min</span>
      </div>
      <div class="bar"><span style="width:${Math.min(100, Math.max(0, used))}%"></span></div>
    </div>`);
  }
  els.quotaBars.innerHTML = rows.join('') || '<div class="muted">rate_limits 存在，但窗口为空。</div>';
}

function renderTrust(data) {
  const d = data.diagnostics;
  const notes = [
    `JSONL：${fmtNum(d.session_files)} 个 session 文件，${fmtNum(d.token_events)} 个 token_count 事件。`,
    `SQLite：${d.sqlite_exists ? '可读' : '不存在'}，请求记录 ${fmtNum(d.request_records)} 条。`,
    '主指标：按窗口内 completed 请求聚合；会话 token 是累计诊断，不作为窗口消耗。',
    '费用：API key 可按配置单价估算；ChatGPT OAuth 显示 API 等价估算，不等于账单。',
    'IP：本地 session/SSE 日志未记录上游出口 IP，本页不做抓包、反代或 OAuth token 读取。'
  ];
  els.trustList.innerHTML = notes.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
}

function drawTokenChart(data) {
  const canvas = els.chart;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(600, Math.floor(rect.width * ratio));
  canvas.height = Math.floor(260 * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const w = canvas.width / ratio;
  const h = canvas.height / ratio;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fffef8';
  ctx.fillRect(0, 0, w, h);

  const rows = data.buckets.requests || [];
  const padL = 48;
  const padR = 18;
  const padT = 20;
  const padB = 42;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const max = Math.max(1, ...rows.map((r) => r.usage.total_tokens));

  ctx.strokeStyle = '#d9d8ce';
  ctx.lineWidth = 1;
  ctx.font = '11px Cascadia Code, Consolas, monospace';
  ctx.fillStyle = '#64645d';
  for (let i = 0; i <= 4; i++) {
    const y = padT + chartH * (i / 4);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    const value = max * (1 - i / 4);
    ctx.fillText(fmtCompact(value), 6, y + 4);
  }

  if (!rows.length) {
    ctx.fillStyle = '#64645d';
    ctx.fillText('暂无数据', padL, padT + 36);
    return;
  }

  const gap = 5;
  const bw = Math.max(4, (chartW - gap * (rows.length - 1)) / rows.length);
  rows.forEach((row, i) => {
    const x = padL + i * (bw + gap);
    const total = Math.max(1, row.usage.total_tokens);
    const cachedH = chartH * (row.usage.cached_input_tokens / max);
    const inputH = chartH * (Math.max(0, row.usage.input_tokens - row.usage.cached_input_tokens) / max);
    const outputH = chartH * (row.usage.output_tokens / max);
    let y = padT + chartH;
    ctx.fillStyle = '#128d92';
    y -= cachedH;
    ctx.fillRect(x, y, bw, cachedH);
    ctx.fillStyle = '#18a058';
    y -= inputH;
    ctx.fillRect(x, y, bw, inputH);
    ctx.fillStyle = '#7057c7';
    y -= outputH;
    ctx.fillRect(x, y, bw, outputH);
    if (i % Math.ceil(rows.length / 8) === 0 || rows.length <= 8) {
      ctx.save();
      ctx.translate(x, h - 14);
      ctx.rotate(-0.4);
      ctx.fillStyle = '#64645d';
      ctx.fillText(row.label, 0, 0);
      ctx.restore();
    }
  });
}

function renderModels(data) {
  const max = Math.max(1, ...data.models.map((m) => m.usage.total_tokens));
  els.modelList.innerHTML = data.models.slice(0, 9).map((m) => {
    const width = Math.max(2, (m.usage.total_tokens / max) * 100);
    return `<div class="model-item">
      <div class="model-top"><span>${escapeHtml(m.model)}</span><span>${fmtCompact(m.usage.total_tokens)}</span></div>
      <div class="bar"><span style="width:${width}%"></span></div>
      <div class="muted">${fmtNum(m.requests)} requests / ${m.cost_known ? `$${m.cost_usd.toFixed(2)}` : '未配置单价'}</div>
    </div>`;
  }).join('') || '<div class="muted">暂无请求模型数据。</div>';
}

function filteredRequests() {
  const q = els.search.value.trim().toLowerCase();
  const list = state.data?.requests || [];
  if (!q) return list;
  return list.filter((r) => [
    r.model,
    r.source_label,
    r.cwd,
    r.input_preview,
    r.output_preview,
    r.conversation_id
  ].join(' ').toLowerCase().includes(q));
}

function renderRequests() {
  const rows = filteredRequests();
  els.requestCount.textContent = `${fmtNum(rows.length)} / ${fmtNum(state.data?.requests?.length || 0)}`;
  els.requestRows.innerHTML = rows.map((r) => {
    const detail = JSON.stringify({
      time: fmtFullDate(r.completed_ms),
      response_id: r.response_id,
      conversation_id: r.conversation_id,
      model: r.model,
      source: r.source_label,
      cwd: r.cwd,
      usage: r.usage,
      first_token_ms_estimate: r.first_token_ms_estimate,
      duration_ms: r.duration_ms,
      cost: r.cost,
      input_preview: r.input_preview,
      output_preview: r.output_preview,
      merge_quality: r.merge_quality,
      terminal_type: r.terminal_type,
      source_ip: r.source_ip
    }, null, 2);
    const summary = clampText(r.input_preview || r.output_preview || r.response_id || '', 150);
    return `<tr>
      <td class="mono">${fmtDate(r.completed_ms)}</td>
      <td><span class="pill">${escapeHtml(r.model || 'unknown')}</span></td>
      <td>${escapeHtml(r.source_label || 'unknown')}</td>
      <td class="num">${fmtCompact(r.usage.input_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.cached_input_tokens)}</td>
      <td class="num">${fmtCompact(r.usage.output_tokens)}</td>
      <td class="num">${fmtMs(r.first_token_ms_estimate)}</td>
      <td class="num">${fmtMs(r.duration_ms)}</td>
      <td class="num" title="${escapeHtml(r.cost?.label || '')}">${escapeHtml(fmtUsd(r.cost))}</td>
      <td>${r.source_ip ? escapeHtml(r.source_ip) : '<span class="muted">未记录</span>'}</td>
      <td class="preview"><button type="button" data-detail="${escapeHtml(detail)}">${escapeHtml(summary || '查看')}</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" class="muted">暂无请求记录。</td></tr>';
}

function renderSessions(data) {
  els.sessionCount.textContent = fmtNum(data.sessions.length);
  els.sessionRows.innerHTML = data.sessions.map((s) => {
    const lastUser = [...(s.messages || [])].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...(s.messages || [])].reverse().find((m) => m.role === 'assistant');
    const preview = [
      lastUser ? `Q: ${clampText(lastUser.text, 130)}` : '',
      lastAssistant ? `A: ${clampText(lastAssistant.text, 130)}` : ''
    ].filter(Boolean).join('\n');
    return `<tr>
      <td class="mono">${fmtDate(s.end_ms)}</td>
      <td class="mono">${escapeHtml(s.id)}</td>
      <td>${escapeHtml([s.model_provider, s.originator, s.source].filter(Boolean).join(' / ') || 'unknown')}</td>
      <td><span class="pill">${escapeHtml(s.model || 'unknown')}</span></td>
      <td class="num">${fmtCompact(s.usage.total_tokens)}</td>
      <td>${escapeHtml(clampText(s.cwd || s.file, 180))}</td>
      <td class="preview">${escapeHtml(preview || '—')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">暂无会话。</td></tr>';
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
  renderQuota(data);
  renderTrust(data);
  drawTokenChart(data);
  renderModels(data);
  renderRequests();
  renderSessions(data);
  bindDetailButtons();
  const generated = fmtFullDate(data.generated_at);
  els.status.textContent = `更新 ${generated} / ${data.diagnostics.sessions_dir}`;
}

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    state.activeDays = Number(btn.dataset.days);
    setDefaultRange(state.activeDays);
    await loadData().catch(showError);
  });
});

els.refresh.addEventListener('click', () => loadData().catch(showError));
els.export.addEventListener('click', () => {
  if (!state.data) return;
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `codex-token-monitor-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
els.bucket.addEventListener('change', () => loadData().catch(showError));
els.start.addEventListener('change', () => loadData().catch(showError));
els.end.addEventListener('change', () => loadData().catch(showError));
els.search.addEventListener('input', () => {
  renderRequests();
  bindDetailButtons();
});
window.addEventListener('resize', () => {
  if (state.data) drawTokenChart(state.data);
});

function showError(error) {
  els.status.textContent = `错误：${error.message}`;
  console.error(error);
}

setDefaultRange(1);
loadData().catch(showError);
setInterval(() => loadData().catch(showError), 120_000);
