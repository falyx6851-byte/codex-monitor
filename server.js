'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const LOG_DB = path.join(CODEX_HOME, 'logs_2.sqlite');
const PORT = Number(process.env.CODEX_TOKEN_MONITOR_PORT || process.env.PORT || 4127);
const HOST = process.env.CODEX_TOKEN_MONITOR_HOST || '127.0.0.1';
const CACHE_TTL_MS = Number(process.env.CODEX_TOKEN_MONITOR_CACHE_MS || 8000);
const MAX_TEXT = Number(process.env.CODEX_TOKEN_MONITOR_TEXT_CHARS || 1200);

const pricing = readJson(path.join(ROOT, 'pricing.json'), {
  currency: 'USD',
  unit: 'per_1m_tokens',
  models: {},
  notes: []
});

const cache = new Map();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function walkFiles(dir, predicate, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, predicate, out);
    else if (entry.isFile() && predicate(file)) out.push(file);
  }
  return out;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timestampMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function rowMs(row) {
  return Number(row.ts) * 1000 + Math.floor(Number(row.ts_nanos || 0) / 1_000_000);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clip(value, max = MAX_TEXT) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function normalizeUsage(usage) {
  const input = Number(usage?.input_tokens || 0);
  const cached = Number(usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens ?? 0);
  const output = Number(usage?.output_tokens || 0);
  const reasoning = Number(usage?.reasoning_output_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? 0);
  const total = Number(usage?.total_tokens || input + output);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total
  };
}

function addUsage(a, b) {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function estimateCost(model, usage, authMode) {
  const rates = pricing.models?.[model];
  if (!rates) {
    return {
      usd: null,
      currency: pricing.currency || 'USD',
      status: 'unpriced',
      label: '未配置官方单价'
    };
  }
  const cached = Math.min(usage.cached_input_tokens || 0, usage.input_tokens || 0);
  const uncached = Math.max((usage.input_tokens || 0) - cached, 0);
  const usd = (
    uncached * Number(rates.input || 0) +
    cached * Number(rates.cached_input || rates.input || 0) +
    (usage.output_tokens || 0) * Number(rates.output || 0)
  ) / 1_000_000;
  const chatgpt = String(authMode || '').toLowerCase().includes('chatgpt');
  return {
    usd,
    currency: pricing.currency || 'USD',
    status: chatgpt ? 'api_equivalent_not_bill' : 'api_estimate',
    label: chatgpt ? 'API 等价估算，非套餐账单' : 'API 估算'
  };
}

function parseKvLog(body) {
  const out = {};
  const re = /(\w+(?:\.\w+)*)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
  let m;
  while ((m = re.exec(body))) {
    let value = m[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    out[m[1]] = value;
  }
  return out;
}

function extractResponseOutput(response) {
  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type === 'message') {
      for (const content of item.content || []) {
        if (typeof content?.text === 'string') parts.push(content.text);
      }
    } else if (item?.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {});
      parts.push(`[tool] ${item.name || 'function_call'} ${clip(args, 240)}`);
    } else if (item?.type) {
      parts.push(`[${item.type}]`);
    }
  }
  return clip(parts.join('\n'), 1600);
}

function parseSessionIdFromPath(file) {
  const name = path.basename(file, '.jsonl');
  const m = name.match(/rollout-[^-]+-[^-]+-(.+)$/);
  return m ? m[1] : name;
}

function parseSessionLogs() {
  const files = walkFiles(SESSIONS_DIR, (file) => file.endsWith('.jsonl'));
  const sessions = [];
  const allMessages = new Map();
  let latestRateLimit = null;
  let malformedLines = 0;
  let tokenEventCount = 0;

  for (const file of files) {
    let text = '';
    let stat = null;
    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const session = {
      id: parseSessionIdFromPath(file),
      file,
      cwd: '',
      source: '',
      thread_source: '',
      originator: '',
      model_provider: '',
      cli_version: '',
      model: '',
      effort: '',
      start_ms: null,
      end_ms: stat.mtimeMs,
      token_events: 0,
      turns_started: 0,
      turns_completed: 0,
      tool_calls: 0,
      web_searches: 0,
      messages: [],
      usage: emptyUsage(),
      last_rate_limits: null
    };

    let lastTotal = null;
    let lastUsage = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const row = parseJsonLine(line);
      if (!row) {
        malformedLines++;
        continue;
      }
      const ms = timestampMs(row.timestamp);
      if (ms != null) {
        if (session.start_ms == null || ms < session.start_ms) session.start_ms = ms;
        if (ms > session.end_ms) session.end_ms = ms;
      }
      const payload = row.payload || {};
      const eventTs = ms ?? session.end_ms ?? stat.mtimeMs;
      if (row.type === 'session_meta') {
        Object.assign(session, {
          id: payload.id || session.id,
          cwd: payload.cwd || session.cwd,
          source: typeof payload.source === 'string' ? payload.source : JSON.stringify(payload.source || ''),
          thread_source: payload.thread_source || '',
          originator: payload.originator || '',
          model_provider: payload.model_provider || '',
          cli_version: payload.cli_version || ''
        });
        if (payload.timestamp && session.start_ms == null) session.start_ms = timestampMs(payload.timestamp);
      } else if (row.type === 'turn_context') {
        if (payload.model) session.model = payload.model;
        if (payload.effort) session.effort = payload.effort;
      } else if (row.type === 'response_item') {
        if (payload.type === 'function_call') session.tool_calls++;
      } else if (row.type === 'event_msg') {
        if (payload.type === 'task_started') session.turns_started++;
        if (payload.type === 'task_complete') session.turns_completed++;
        if (payload.type === 'web_search_call') session.web_searches++;
        if (payload.type === 'token_count') {
          tokenEventCount++;
          session.token_events++;
          lastTotal = normalizeUsage(payload.info?.total_token_usage);
          lastUsage = normalizeUsage(payload.info?.last_token_usage);
          if (payload.rate_limits) {
            session.last_rate_limits = payload.rate_limits;
            if (!latestRateLimit || eventTs > latestRateLimit.ts) {
              latestRateLimit = {
                ts: eventTs,
                session_id: session.id,
                rate_limits: payload.rate_limits
              };
            }
          }
        }
        if (payload.type === 'user_message' || payload.type === 'agent_message') {
          const role = payload.type === 'user_message' ? 'user' : 'assistant';
          session.messages.push({
            role,
            ts: ms,
            text: clip(payload.message || '', 1600),
            chars: String(payload.message || '').length
          });
        }
      }
    }

    if (lastTotal && lastTotal.total_tokens > 0) session.usage = lastTotal;
    else if (lastUsage && lastUsage.total_tokens > 0) session.usage = lastUsage;
    session.start_ms = session.start_ms || stat.birthtimeMs || stat.mtimeMs;
    allMessages.set(session.id, session.messages);
    session.messages = session.messages.slice(-8);
    sessions.push(session);
  }

  return {
    sessions,
    allMessages,
    diagnostics: {
      sessions_dir: SESSIONS_DIR,
      log_db: LOG_DB,
      session_files: files.length,
      malformed_lines: malformedLines,
      token_events: tokenEventCount
    },
    latestRateLimit
  };
}

function queryDb(sql, params = []) {
  if (!DatabaseSync || !fs.existsSync(LOG_DB)) return [];
  let db = null;
  try {
    db = new DatabaseSync(LOG_DB, { readOnly: true });
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function parseRawSseRequests(startMs, endMs) {
  if (!DatabaseSync || !fs.existsSync(LOG_DB)) return [];
  const startSec = Math.floor(startMs / 1000) - 60;
  const endSec = Math.ceil(endMs / 1000) + 60;
  const rows = queryDb(
    `select id, ts, ts_nanos, feedback_log_body as body
     from logs
     where target = 'codex_api::sse::responses'
       and ts between ? and ?
       and feedback_log_body like 'SSE event:%response.%'
     order by id asc`,
    [startSec, endSec]
  );

  const active = new Map();
  const requests = [];

  for (const row of rows) {
    let event = null;
    try {
      event = JSON.parse(String(row.body || '').replace(/^SSE event:\s*/, ''));
    } catch {
      continue;
    }
    const nowMs = rowMs(row);
    if (event.type === 'response.created') {
      const id = event.response?.id;
      if (!id) continue;
      const createdMs = Number(event.response.created_at || 0) > 0 ? Number(event.response.created_at) * 1000 : nowMs;
      active.set(id, {
        response_id: id,
        created_ms: createdMs,
        created_log_ms: nowMs,
        first_signal_ms: null,
        first_token_ms: null,
        model: event.response?.model || '',
        sequence_start: event.sequence_number ?? null
      });
      continue;
    }

    if (
      event.type === 'response.output_text.delta' ||
      event.type === 'response.function_call_arguments.delta' ||
      event.type === 'response.content_part.added' ||
      event.type === 'response.output_item.added'
    ) {
      const record = active.size === 1 ? active.values().next().value : null;
      if (record) {
        if (record.first_signal_ms == null) record.first_signal_ms = Math.max(0, nowMs - record.created_log_ms);
        if (
          record.first_token_ms == null &&
          (event.type === 'response.output_text.delta' || event.type === 'response.function_call_arguments.delta')
        ) {
          record.first_token_ms = Math.max(0, nowMs - record.created_log_ms);
        }
      }
      continue;
    }

    if (event.type === 'response.completed') {
      const response = event.response || {};
      const id = response.id || `completed-${row.id}`;
      const soleActive = active.size === 1 ? active.values().next().value : null;
      const matchedActiveId = active.has(id) ? id : soleActive?.response_id;
      const record = active.get(id) || soleActive || {};
      const usage = normalizeUsage(response.usage || {});
      const createdMs = Number(response.created_at || 0) > 0 ? Number(response.created_at) * 1000 : record.created_ms || nowMs;
      const completedMs = Number(response.completed_at || 0) > 0 ? Number(response.completed_at) * 1000 : nowMs;
      if (completedMs >= startMs && completedMs <= endMs) {
        requests.push({
          id,
          response_id: id,
          created_ms: createdMs,
          completed_ms: completedMs,
          duration_ms: Math.max(0, completedMs - createdMs),
          first_token_ms_estimate: record.first_token_ms,
          first_signal_ms_estimate: record.first_signal_ms,
          model: response.model || record.model || '',
          status: response.status || '',
          usage,
          output_preview: extractResponseOutput(response),
          conversation_id: null,
          auth_mode: null,
          originator: null,
          app_version: null,
          source_ip: null,
          merge_quality: 'raw_sse'
        });
      }
      if (matchedActiveId) active.delete(matchedActiveId);
    }
  }
  return requests;
}

function parseOtelCompletions(startMs, endMs) {
  if (!DatabaseSync || !fs.existsSync(LOG_DB)) return [];
  const startSec = Math.floor(startMs / 1000) - 60;
  const endSec = Math.ceil(endMs / 1000) + 60;
  const rows = queryDb(
    `select id, ts, ts_nanos, target, feedback_log_body as body
     from logs
     where target in ('codex_otel.trace_safe','codex_otel.log_only')
       and ts between ? and ?
       and feedback_log_body like 'event.name="codex.sse_event" event.kind=response.completed%'
     order by id asc`,
    [startSec, endSec]
  );
  const byKey = new Map();
  const durationByBaseKey = new Map();
  for (const row of rows) {
    const item = parseKvLog(row.body || '');
    const ms = timestampMs(item['event.timestamp']) || rowMs(row);
    if (ms < startMs || ms > endMs) continue;
    const baseKey = [
      item['conversation.id'] || '',
      item['event.timestamp'] || '',
      item.model || ''
    ].join('|');
    const durationMs = finiteNumber(item.duration_ms);
    if (durationMs != null) durationByBaseKey.set(baseKey, durationMs);
    if (!item.input_token_count) continue;
    const usage = normalizeUsage({
      input_tokens: item.input_token_count,
      cached_input_tokens: item.cached_token_count,
      output_tokens: item.output_token_count,
      reasoning_output_tokens: item.reasoning_token_count,
      total_tokens: item.tool_token_count
    });
    const key = [
      baseKey,
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens
    ].join('|');
    const existing = byKey.get(key);
    if (!existing || row.target === 'codex_otel.trace_safe') {
      byKey.set(key, {
        id: `otel-${row.id}`,
        completed_ms: ms,
        base_key: baseKey,
        duration_ms: durationMs,
        model: item.model || '',
        slug: item.slug || '',
        usage,
        conversation_id: item['conversation.id'] || null,
        auth_mode: item.auth_mode || null,
        originator: item.originator || null,
        app_version: item['app.version'] || null,
        terminal_type: item['terminal.type'] || null,
        source_ip: null,
        merge_quality: 'otel'
      });
    }
  }
  for (const item of byKey.values()) {
    if (item.duration_ms == null) item.duration_ms = durationByBaseKey.get(item.base_key) ?? null;
    delete item.base_key;
  }
  return [...byKey.values()];
}

function mergeRequestMetadata(rawRequests, otelRequests) {
  const used = new Set();
  const merged = rawRequests.map((req) => {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < otelRequests.length; i++) {
      if (used.has(i)) continue;
      const o = otelRequests[i];
      const timeDelta = Math.abs((o.completed_ms || 0) - (req.completed_ms || 0));
      const usageMatch =
        o.usage.input_tokens === req.usage.input_tokens &&
        o.usage.cached_input_tokens === req.usage.cached_input_tokens &&
        o.usage.output_tokens === req.usage.output_tokens;
      const modelMatch = !o.model || !req.model || o.model === req.model;
      if (timeDelta <= 5000 && modelMatch && (usageMatch || timeDelta <= 1000)) {
        const score = timeDelta + (usageMatch ? 0 : 2000);
        if (score < bestScore) {
          best = { index: i, data: o };
          bestScore = score;
        }
      }
    }
    if (best) {
      used.add(best.index);
      return {
        ...req,
        duration_ms: best.data.duration_ms ?? req.duration_ms,
        conversation_id: best.data.conversation_id,
        auth_mode: best.data.auth_mode,
        originator: best.data.originator,
        app_version: best.data.app_version,
        terminal_type: best.data.terminal_type,
        merge_quality: 'raw_sse+otel'
      };
    }
    return req;
  });

  for (let i = 0; i < otelRequests.length; i++) {
    if (used.has(i)) continue;
    const o = otelRequests[i];
    merged.push({
      id: o.id,
      response_id: null,
      created_ms: null,
      completed_ms: o.completed_ms,
      duration_ms: o.duration_ms ?? null,
      first_token_ms_estimate: null,
      first_signal_ms_estimate: null,
      model: o.model,
      status: 'completed',
      usage: o.usage,
      output_preview: '',
      conversation_id: o.conversation_id,
      auth_mode: o.auth_mode,
      originator: o.originator,
      app_version: o.app_version,
      terminal_type: o.terminal_type,
      source_ip: null,
      merge_quality: 'otel_only'
    });
  }
  return merged.sort((a, b) => b.completed_ms - a.completed_ms);
}

function findNearestMessages(sessionMessages, sessionId, createdMs, completedMs) {
  const messages = sessionMessages.get(sessionId) || [];
  let input = null;
  let output = null;
  for (const msg of messages) {
    if (msg.role === 'user' && msg.ts != null && (createdMs == null || msg.ts <= createdMs + 60_000)) input = msg;
    if (
      msg.role === 'assistant' &&
      msg.ts != null &&
      (createdMs == null || msg.ts >= createdMs - 60_000) &&
      (completedMs == null || msg.ts <= completedMs + 120_000)
    ) {
      output = msg;
    }
  }
  return {
    input_preview: input?.text || '',
    output_preview_from_session: output?.text || ''
  };
}

function bucketStart(ms, bucket) {
  const d = new Date(ms);
  if (bucket === 'hour') {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  if (bucket === 'week') {
    const day = d.getDay() || 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day + 1);
    return d.getTime();
  }
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketLabel(ms, bucket) {
  const d = new Date(ms);
  if (bucket === 'hour') return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
  if (bucket === 'week') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function summarizeByBuckets(items, bucket) {
  const map = new Map();
  for (const item of items) {
    const ms = item.completed_ms || item.end_ms || item.start_ms;
    if (!ms) continue;
    const key = bucketStart(ms, bucket);
    if (!map.has(key)) {
      map.set(key, {
        ts: key,
        label: bucketLabel(key, bucket),
        requests: 0,
        sessions: 0,
        cost_usd: 0,
        cost_known: 0,
        usage: emptyUsage()
      });
    }
    const row = map.get(key);
    if (item.response_id || item.merge_quality?.startsWith('otel')) row.requests++;
    else row.sessions++;
    row.usage = addUsage(row.usage, item.usage || emptyUsage());
    if (item.cost?.usd != null) {
      row.cost_usd += item.cost.usd;
      row.cost_known++;
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function buildData(startMs, endMs, bucket, limit) {
  const sessionData = parseSessionLogs();
  const filteredSessions = sessionData.sessions
    .filter((s) => (s.end_ms || s.start_ms) >= startMs && (s.start_ms || s.end_ms) <= endMs)
    .sort((a, b) => b.end_ms - a.end_ms);

  const rawRequests = parseRawSseRequests(startMs, endMs);
  const otelRequests = parseOtelCompletions(startMs, endMs);
  const requests = mergeRequestMetadata(rawRequests, otelRequests);

  const sessionsById = new Map(sessionData.sessions.map((s) => [s.id, s]));
  for (const req of requests) {
    const session = req.conversation_id ? sessionsById.get(req.conversation_id) : null;
    if (session) {
      req.cwd = session.cwd;
      req.session_source = session.source;
      req.thread_source = session.thread_source;
      req.model_provider = session.model_provider;
    } else {
      req.cwd = '';
      req.session_source = '';
      req.thread_source = '';
      req.model_provider = '';
    }
    Object.assign(req, findNearestMessages(sessionData.allMessages, req.conversation_id, req.created_ms, req.completed_ms));
    if (!req.output_preview) req.output_preview = req.output_preview_from_session || '';
    req.source_label = [req.auth_mode, req.originator, req.terminal_type, req.session_source].filter(Boolean).join(' / ') || 'unknown';
    req.cost = estimateCost(req.model, req.usage, req.auth_mode);
  }

  for (const session of filteredSessions) {
    session.cost = estimateCost(session.model, session.usage, null);
  }

  const sessionUsage = filteredSessions.reduce((sum, session) => addUsage(sum, session.usage), emptyUsage());
  const requestUsage = requests.reduce((sum, req) => addUsage(sum, req.usage), emptyUsage());
  const knownCosts = requests.filter((r) => r.cost?.usd != null);
  const totalCost = knownCosts.reduce((sum, r) => sum + r.cost.usd, 0);
  const durations = requests.map((r) => r.duration_ms).filter((v) => Number.isFinite(v) && v > 0);
  const firstTokens = requests.map((r) => r.first_token_ms_estimate).filter((v) => Number.isFinite(v) && v >= 0);

  const modelMap = new Map();
  for (const req of requests) {
    const key = req.model || 'unknown';
    const row = modelMap.get(key) || { model: key, requests: 0, usage: emptyUsage(), cost_usd: 0, cost_known: 0 };
    row.requests++;
    row.usage = addUsage(row.usage, req.usage);
    if (req.cost?.usd != null) {
      row.cost_usd += req.cost.usd;
      row.cost_known++;
    }
    modelMap.set(key, row);
  }

  return {
    generated_at: Date.now(),
    range: { start_ms: startMs, end_ms: endMs, bucket },
    codex_home: CODEX_HOME,
    pricing: {
      currency: pricing.currency || 'USD',
      unit: pricing.unit,
      source: pricing.source,
      source_checked_at: pricing.source_checked_at,
      notes: pricing.notes || [],
      configured_models: Object.keys(pricing.models || {})
    },
    diagnostics: {
      ...sessionData.diagnostics,
      sqlite_available: Boolean(DatabaseSync),
      sqlite_exists: fs.existsSync(LOG_DB),
      raw_sse_requests: rawRequests.length,
      otel_completions: otelRequests.length,
      request_records: requests.length
    },
    latest_rate_limit: sessionData.latestRateLimit,
    summary: {
      sessions: filteredSessions.length,
      sessions_without_token: filteredSessions.filter((s) => s.token_events === 0).length,
      requests: requests.length,
      session_cumulative_usage: sessionUsage,
      session_usage: sessionUsage,
      request_usage: requestUsage,
      known_cost_usd: totalCost,
      known_cost_requests: knownCosts.length,
      average_latency_ms: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      average_first_token_ms_estimate: firstTokens.length ? firstTokens.reduce((a, b) => a + b, 0) / firstTokens.length : null,
      source_ip_available: false
    },
    data_quality: {
      primary_usage: 'request_completed_window',
      request_usage_sources: {
        raw_sse: requests.filter((r) => r.merge_quality === 'raw_sse').length,
        raw_sse_plus_otel: requests.filter((r) => r.merge_quality === 'raw_sse+otel').length,
        otel_only: requests.filter((r) => r.merge_quality === 'otel_only').length
      },
      session_usage: 'session_cumulative_diagnostic_only',
      first_token_ms: 'raw_sse_log_estimate_when_single_active_response',
      source_ip: 'unavailable'
    },
    buckets: {
      sessions: summarizeByBuckets(filteredSessions, bucket),
      requests: summarizeByBuckets(requests, bucket)
    },
    models: [...modelMap.values()].sort((a, b) => b.usage.total_tokens - a.usage.total_tokens),
    sessions: filteredSessions.slice(0, Math.min(limit, 1000)),
    requests: requests.slice(0, Math.min(limit, 1000))
  };
}

function parseRange(searchParams) {
  const now = Date.now();
  const end = Number(searchParams.get('end_ms')) || timestampMs(searchParams.get('end')) || now;
  let start = Number(searchParams.get('start_ms')) || timestampMs(searchParams.get('start'));
  if (!start) {
    const days = Number(searchParams.get('days') || 7);
    start = days <= 0 ? 0 : end - days * 24 * 60 * 60 * 1000;
  }
  return {
    startMs: Math.max(0, start),
    endMs: Math.max(start, end),
    bucket: ['hour', 'day', 'week'].includes(searchParams.get('bucket')) ? searchParams.get('bucket') : 'day',
    limit: Number(searchParams.get('limit') || 500)
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

function sendStatic(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC_DIR, '.' + safePath);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': contentType(file),
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
}

function isAllowedLocalHost(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || String(PORT);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host) && port === String(PORT);
  } catch {
    return false;
  }
}

function isAllowedRequest(req) {
  if (!isAllowedLocalHost(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !isAllowedLocalHost(origin)) return false;
  return true;
}

const server = http.createServer((req, res) => {
  if (!isAllowedRequest(req)) {
    sendJson(res, 403, { error: 'forbidden_host' });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname === '/api/data') {
    const range = parseRange(url.searchParams);
    const cacheKey = `${range.startMs}:${range.endMs}:${range.bucket}:${range.limit}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      sendJson(res, 200, cached.data);
      return;
    }
    try {
      const data = buildData(range.startMs, range.endMs, range.bucket, range.limit);
      cache.set(cacheKey, { ts: Date.now(), data });
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 500, {
        error: 'failed_to_build_data',
        message: error?.message || String(error)
      });
    }
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      codex_home: CODEX_HOME,
      sessions_dir_exists: fs.existsSync(SESSIONS_DIR),
      log_db_exists: fs.existsSync(LOG_DB),
      sqlite_available: Boolean(DatabaseSync)
    });
    return;
  }
  sendStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Codex token monitor: http://${HOST}:${PORT}`);
  console.log(`CODEX_HOME: ${CODEX_HOME}`);
});
