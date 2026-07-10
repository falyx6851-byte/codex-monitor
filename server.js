'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  throw new Error('Codex Token Monitor dashboard requires Node.js 24+ for node:sqlite. The standalone report script still supports Node.js 18+.');
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'codex-token-monitor.sqlite');
const PRICING_FILE = path.join(ROOT, 'pricing.json');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const PORT = Number(process.env.CODEX_TOKEN_MONITOR_PORT || process.env.PORT || 4127);
const HOST = process.env.CODEX_TOKEN_MONITOR_HOST || '127.0.0.1';
const CACHE_TTL_MS = Number(process.env.CODEX_TOKEN_MONITOR_CACHE_MS || 8000);
const MAX_REQUEST_DURATION_ESTIMATE_MS = 10 * 60 * 1000;

const cache = new Map();

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

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalFinite(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeUsage(usage) {
  const input = finiteOrZero(usage?.input_tokens);
  const cached = finiteOrZero(usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens);
  const cacheWrite = optionalFinite(
    usage?.cache_write_input_tokens ??
    usage?.cache_write_tokens ??
    usage?.input_tokens_details?.cache_write_tokens
  );
  const output = finiteOrZero(usage?.output_tokens);
  const reasoning = finiteOrZero(usage?.reasoning_output_tokens ?? usage?.output_tokens_details?.reasoning_tokens);
  const hasOfficialTotal = usage?.total_tokens != null;
  const total = hasOfficialTotal ? finiteOrZero(usage.total_tokens) : input + output;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total
  };
}

function addUsage(a, b) {
  const aCacheWrite = optionalFinite(a.cache_write_input_tokens);
  const bCacheWrite = optionalFinite(b.cache_write_input_tokens);
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    cache_write_input_tokens:
      aCacheWrite == null || bCacheWrite == null ? null : aCacheWrite + bCacheWrite,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function usageTuple(usage) {
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.cache_write_input_tokens == null ? '?' : usage.cache_write_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  ].join('/');
}

function dedupeKey(sessionId, usage, totalUsageSnapshot) {
  const snapshot = totalUsageSnapshot || emptyUsage();
  return `${sessionId}|last=${usageTuple(usage)}|total=${usageTuple(snapshot)}`;
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function normalizeRecordStatus(status, errorReason) {
  const value = String(status || '').toLowerCase();
  if (value === 'failed' || value === 'error' || errorReason) return 'failed';
  return 'success';
}

function normalizeServiceTier(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function extractServiceTier(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    ['payload.service_tier', payload.service_tier],
    ['payload.serviceTier', payload.serviceTier],
    ['payload.info.service_tier', payload.info?.service_tier],
    ['payload.info.serviceTier', payload.info?.serviceTier],
    ['payload.request.service_tier', payload.request?.service_tier],
    ['payload.request.serviceTier', payload.request?.serviceTier],
    ['payload.response.service_tier', payload.response?.service_tier],
    ['payload.response.serviceTier', payload.response?.serviceTier]
  ];
  for (const [source, value] of candidates) {
    const tier = normalizeServiceTier(value);
    if (tier) return { tier, source };
  }
  return null;
}

function isPartialUsageWithoutBreakdown(usage) {
  return (
    usage.total_tokens > 0 &&
    usage.input_tokens === 0 &&
    usage.cached_input_tokens === 0 &&
    usage.output_tokens === 0
  );
}

function loadPricing() {
  try {
    return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
  } catch {
    return {
      currency: 'USD',
      source: '',
      updated_at: '',
      long_context_threshold_tokens: 270000,
      models: {},
      aliases: {}
    };
  }
}

const pricingConfig = loadPricing();

function resolvePricing(model) {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const exact = pricingConfig.models?.[raw];
  if (exact) return { key: raw, pricing: exact };
  const alias = pricingConfig.aliases?.[raw] || pricingConfig.aliases?.[raw.toLowerCase()];
  if (alias && pricingConfig.models?.[alias]) return { key: alias, pricing: pricingConfig.models[alias] };
  return null;
}

function estimateCost(usage, model) {
  const resolved = resolvePricing(model);
  if (!resolved) {
    return {
      currency: pricingConfig.currency || 'USD',
      amount_usd: null,
      known: false,
      model_key: null,
      tier: null,
      reason: 'missing_model_pricing'
    };
  }
  const inputTokens = Math.max(0, finiteOrZero(usage?.input_tokens));
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, finiteOrZero(usage?.cached_input_tokens)));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = Math.max(0, finiteOrZero(usage?.output_tokens));
  const threshold = Number(pricingConfig.long_context_threshold_tokens || 270000);
  const useLongContext = resolved.pricing.long_context && inputTokens > threshold;
  const rates = useLongContext ? resolved.pricing.long_context : resolved.pricing;
  const cacheWriteRate = optionalFinite(rates.cache_write_input_per_1m);
  const reportedCacheWriteTokens = optionalFinite(usage?.cache_write_input_tokens);
  const cacheWriteTokens = cacheWriteRate == null || reportedCacheWriteTokens == null
    ? 0
    : Math.min(uncachedInputTokens, Math.max(0, reportedCacheWriteTokens));
  const regularInputTokens = Math.max(0, uncachedInputTokens - cacheWriteTokens);
  const cacheWriteMissing =
    cacheWriteRate != null && reportedCacheWriteTokens == null && uncachedInputTokens > 0;
  const inputUsd = (regularInputTokens / 1_000_000) * finiteOrZero(rates.input_per_1m);
  const cachedUsd = (cachedInputTokens / 1_000_000) * finiteOrZero(rates.cached_input_per_1m);
  const cacheWriteUsd = cacheWriteRate == null
    ? 0
    : (cacheWriteTokens / 1_000_000) * cacheWriteRate;
  const outputUsd = (outputTokens / 1_000_000) * finiteOrZero(rates.output_per_1m);
  const amountUsd = inputUsd + cachedUsd + cacheWriteUsd + outputUsd;
  return {
    currency: pricingConfig.currency || 'USD',
    amount_usd: amountUsd,
    known: true,
    complete: !cacheWriteMissing,
    is_lower_bound: cacheWriteMissing,
    estimate_kind: cacheWriteMissing ? 'lower_bound' : 'token_rate_estimate',
    reason: cacheWriteMissing ? 'cache_write_tokens_unavailable_in_codex_session' : null,
    model_key: resolved.key,
    tier: useLongContext ? 'long_context' : 'standard',
    source: pricingConfig.source || '',
    updated_at: pricingConfig.updated_at || '',
    input_tokens_billed_at_input_rate: regularInputTokens,
    cached_input_tokens_billed_at_cached_rate: cachedInputTokens,
    cache_write_input_tokens_billed_at_cache_write_rate:
      cacheWriteRate == null || reportedCacheWriteTokens != null ? cacheWriteTokens : null,
    output_tokens_billed_at_output_rate: outputTokens,
    rates_per_1m: {
      input: finiteOrZero(rates.input_per_1m),
      cached_input: finiteOrZero(rates.cached_input_per_1m),
      cache_write_input: cacheWriteRate,
      output: finiteOrZero(rates.output_per_1m)
    },
    components_usd: {
      input: inputUsd,
      cached_input: cachedUsd,
      cache_write_input: cacheWriteMissing ? null : cacheWriteUsd,
      output: outputUsd
    }
  };
}

function bucketStart(ms, width) {
  const d = new Date(ms);
  if (width === 'hour') {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  if (width === 'week') {
    const day = d.getDay() || 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day + 1);
    return d.getTime();
  }
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketLabel(ms, width) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return width === 'hour' ? `${date} ${pad(d.getHours())}:00` : date;
}

function createBucketAccumulator(ts, width) {
  return {
    ts,
    label: bucketLabel(ts, width),
    records: 0,
    success_records: 0,
    failed_records: 0,
    usage: emptyUsage(),
    amount_usd: 0,
    priced_records: 0,
    lower_bound_records: 0,
    duration_sum: 0,
    duration_records: 0,
    first_output_sum: 0,
    first_output_records: 0
  };
}

function nextBucketStart(ts, width) {
  const d = new Date(ts);
  if (width === 'hour') d.setHours(d.getHours() + 1);
  else if (width === 'week') d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 1);
  return d.getTime();
}

function summarizeBuckets(requests, width, startMs, endMs) {
  const map = new Map();
  for (const req of requests) {
    const ts = bucketStart(req.completed_ms || req.response_timestamp_ms || 0, width);
    const item = map.get(ts) || createBucketAccumulator(ts, width);
    item.records++;
    if (req.status === 'failed') item.failed_records++;
    else item.success_records++;
    item.usage = addUsage(item.usage, req.usage);
    const hasBillableBreakdown =
      req.usage.input_tokens > 0 || req.usage.cached_input_tokens > 0 || req.usage.output_tokens > 0;
    if (req.cost_estimate?.known && hasBillableBreakdown && Number.isFinite(req.cost_estimate.amount_usd)) {
      item.amount_usd += req.cost_estimate.amount_usd;
      item.priced_records++;
      if (req.cost_estimate.is_lower_bound) item.lower_bound_records++;
    }
    if (Number.isFinite(req.duration_ms_estimate) && req.duration_ms_estimate > 0) {
      item.duration_sum += req.duration_ms_estimate;
      item.duration_records++;
    }
    if (Number.isFinite(req.first_output_ms_estimate) && req.first_output_ms_estimate >= 0) {
      item.first_output_sum += req.first_output_ms_estimate;
      item.first_output_records++;
    }
    map.set(ts, item);
  }
  const firstRequestMs = requests.length
    ? requests.reduce(
      (min, req) => Math.min(min, req.completed_ms || req.response_timestamp_ms || endMs),
      endMs
    )
    : startMs;
  const fillStart = bucketStart(Math.max(startMs, firstRequestMs), width);
  const fillEnd = bucketStart(endMs, width);
  const expected = [];
  for (let ts = fillStart; ts <= fillEnd && expected.length <= 500; ts = nextBucketStart(ts, width)) {
    expected.push(ts);
  }
  if (expected.length <= 500 && expected.at(-1) === fillEnd) {
    expected.forEach((ts) => {
      if (!map.has(ts)) map.set(ts, createBucketAccumulator(ts, width));
    });
  }
  return [...map.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((item) => ({
      ts: item.ts,
      label: item.label,
      records: item.records,
      success_records: item.success_records,
      failed_records: item.failed_records,
      success_rate: item.records ? item.success_records / item.records : null,
      usage: item.usage,
      cache_hit_rate: cacheHitRate(item.usage),
      estimated_cost: {
        currency: pricingConfig.currency || 'USD',
        amount_usd: item.amount_usd,
        priced_records: item.priced_records,
        lower_bound_records: item.lower_bound_records,
        is_lower_bound: item.lower_bound_records > 0
      },
      average_request_duration_ms_estimate: item.duration_records
        ? item.duration_sum / item.duration_records
        : null,
      average_first_output_ms_estimate: item.first_output_records
        ? item.first_output_sum / item.first_output_records
        : null
    }));
}

function parseSessionIdFromPath(file) {
  const name = path.basename(file, '.jsonl');
  const m = name.match(/rollout-[^-]+-[^-]+-(.+)$/);
  return m ? m[1] : name;
}

const TOKEN_RECORD_COLUMNS = [
  'record_id',
  'dedupe_key',
  'terminal_event_type',
  'ms',
  'timestamp',
  'session_id',
  'session_file',
  'cwd',
  'source',
  'thread_source',
  'originator',
  'model_provider',
  'cli_version',
  'model',
  'effort',
  'service_tier',
  'service_tier_source',
  'status',
  'error_reason',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'total_input_tokens_snapshot',
  'total_cached_input_tokens_snapshot',
  'total_cache_write_input_tokens_snapshot',
  'total_output_tokens_snapshot',
  'total_reasoning_output_tokens_snapshot',
  'total_tokens_snapshot',
  'model_context_window',
  'turn_id',
  'turn_sequence',
  'request_started_ms_estimate',
  'request_duration_ms_estimate',
  'request_duration_basis',
  'first_output_ms_estimate',
  'first_output_event_ms',
  'first_output_event_type',
  'first_output_basis',
  'turn_started_ms',
  'turn_elapsed_ms_estimate',
  'turn_completed_ms',
  'turn_duration_ms_estimate',
  'response_item_count',
  'stream_observed',
  'stream_observed_basis',
  'inserted_at_ms'
];

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA busy_timeout = 3000;

    CREATE TABLE IF NOT EXISTS session_files (
      file_path TEXT PRIMARY KEY,
      file_size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      scanned_at_ms INTEGER NOT NULL,
      session_id TEXT,
      last_error TEXT,
      scanned_lines INTEGER NOT NULL DEFAULT 0,
      malformed_lines INTEGER NOT NULL DEFAULT 0,
      token_events INTEGER NOT NULL DEFAULT 0,
      parsed_records INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS token_records (
      record_id TEXT PRIMARY KEY,
      dedupe_key TEXT UNIQUE NOT NULL,
      terminal_event_type TEXT NOT NULL DEFAULT 'session.token_count',
      ms INTEGER NOT NULL,
      timestamp TEXT,
      session_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      cwd TEXT,
      source TEXT,
      thread_source TEXT,
      originator TEXT,
      model_provider TEXT,
      cli_version TEXT,
      model TEXT,
      effort TEXT,
      service_tier TEXT,
      service_tier_source TEXT,
      status TEXT,
      error_reason TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_input_tokens INTEGER,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_input_tokens_snapshot INTEGER,
      total_cached_input_tokens_snapshot INTEGER,
      total_cache_write_input_tokens_snapshot INTEGER,
      total_output_tokens_snapshot INTEGER,
      total_reasoning_output_tokens_snapshot INTEGER,
      total_tokens_snapshot INTEGER,
      model_context_window INTEGER,
      turn_id TEXT,
      turn_sequence INTEGER,
      request_started_ms_estimate INTEGER,
      request_duration_ms_estimate INTEGER,
      request_duration_basis TEXT,
      first_output_ms_estimate INTEGER,
      first_output_event_ms INTEGER,
      first_output_event_type TEXT,
      first_output_basis TEXT,
      turn_started_ms INTEGER,
      turn_elapsed_ms_estimate INTEGER,
      turn_completed_ms INTEGER,
      turn_duration_ms_estimate INTEGER,
      response_item_count INTEGER,
      stream_observed INTEGER,
      stream_observed_basis TEXT,
      inserted_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_records_ms ON token_records(ms);
    CREATE INDEX IF NOT EXISTS idx_token_records_model ON token_records(model);
    CREATE INDEX IF NOT EXISTS idx_token_records_session ON token_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_token_records_session_file ON token_records(session_file);
  `);
  ensureColumn(database, 'token_records', 'terminal_event_type', "TEXT NOT NULL DEFAULT 'session.token_count'");
  ensureColumn(database, 'token_records', 'error_reason', 'TEXT');
  ensureColumn(database, 'token_records', 'service_tier', 'TEXT');
  ensureColumn(database, 'token_records', 'service_tier_source', 'TEXT');
  ensureColumn(database, 'token_records', 'cache_write_input_tokens', 'INTEGER');
  ensureColumn(database, 'token_records', 'total_cache_write_input_tokens_snapshot', 'INTEGER');
  return database;
}

const db = initDb();

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function parseSessionFile(file, stat) {
  const text = fs.readFileSync(file, 'utf8');
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
    start_ms: stat?.birthtimeMs || stat?.mtimeMs || null,
    end_ms: stat?.mtimeMs || null
  };
  const diagnostics = {
    scanned_lines: 0,
    malformed_lines: 0,
    token_events: 0,
    parsed_records: 0
  };

  let currentModel = '';
  let currentEffort = '';
  let currentServiceTier = '';
  let currentServiceTierSource = '';
  let currentTurn = null;
  let turnSequence = 0;
  let pendingModelStartMs = null;
  let pendingModelStartBasis = null;
  let activeModelCall = null;
  let pendingContextCompactionTokenCount = false;
  const recordsByTurn = new Map();
  const fileRecords = [];
  const setPendingModelStart = (value, basis) => {
    if (Number.isFinite(value)) {
      pendingModelStartMs = value;
      pendingModelStartBasis = basis;
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    diagnostics.scanned_lines++;
    const row = parseJsonLine(line);
    if (!row) {
      diagnostics.malformed_lines++;
      continue;
    }
    const ms = timestampMs(row.timestamp);
    if (row.type === 'compacted') {
      pendingContextCompactionTokenCount = true;
    }
    if (ms != null) {
      if (session.start_ms == null || ms < session.start_ms) session.start_ms = ms;
      if (session.end_ms == null || ms > session.end_ms) session.end_ms = ms;
    }
    const payload = row.payload || {};
    const serviceTierEvidence = extractServiceTier(payload);
    if (serviceTierEvidence) {
      currentServiceTier = serviceTierEvidence.tier;
      currentServiceTierSource = `${row.type}.${serviceTierEvidence.source}`;
    }
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
    } else if (row.type === 'turn_context') {
      if (payload.model) {
        currentModel = payload.model;
        session.model = payload.model;
      }
      if (payload.effort) currentEffort = payload.effort;
    } else if (row.type === 'event_msg' && payload.type === 'task_started' && ms != null) {
      turnSequence++;
      currentTurn = {
        id: `${session.id}:turn:${turnSequence}`,
        sequence: turnSequence,
        started_ms: ms,
        started_at: row.timestamp || null
      };
      recordsByTurn.set(currentTurn.id, []);
      setPendingModelStart(ms, 'task_started');
    } else if (row.type === 'event_msg' && payload.type === 'task_complete' && ms != null) {
      if (currentTurn) {
        const records = recordsByTurn.get(currentTurn.id) || [];
        for (const record of records) {
          record.turn_completed_ms = ms;
          record.turn_duration_ms_estimate = Math.max(0, ms - currentTurn.started_ms);
        }
        currentTurn = null;
      }
    } else if (row.type === 'event_msg' && payload.type === 'user_message' && ms != null) {
      setPendingModelStart(ms, 'user_message');
    } else if (
      row.type === 'event_msg' &&
      ms != null &&
      (payload.type?.endsWith('_tool_call_end') ||
        payload.type?.endsWith('_command_end') ||
        payload.type?.endsWith('_apply_end') ||
        payload.type === 'function_call_output')
    ) {
      setPendingModelStart(ms, payload.type);
    } else if (row.type === 'response_item' && ms != null) {
      if (payload.type === 'function_call_output') {
        setPendingModelStart(ms, 'function_call_output');
      } else if (!(payload.type === 'message' && payload.role === 'user')) {
        if (!activeModelCall) {
          const requestStartMs = pendingModelStartMs ?? currentTurn?.started_ms ?? ms;
          activeModelCall = {
            request_start_ms: requestStartMs,
            request_start_basis: pendingModelStartBasis || (currentTurn ? 'task_started' : 'first_response_item'),
            first_output_ms: ms,
            first_output_type: payload.type || row.type,
            response_item_count: 0
          };
        }
        activeModelCall.response_item_count++;
      }
    } else if (row.type === 'event_msg' && payload.type === 'error') {
      if (ms == null) continue;
      const requestStartMs = activeModelCall?.request_start_ms ?? pendingModelStartMs ?? currentTurn?.started_ms ?? null;
      let requestDurationMs = requestStartMs == null ? null : Math.max(0, ms - requestStartMs);
      let requestDurationBasis =
        requestStartMs == null ? null : `${activeModelCall?.request_start_basis || pendingModelStartBasis || 'unknown'}_to_error`;
      if (requestDurationMs != null && requestDurationMs > MAX_REQUEST_DURATION_ESTIMATE_MS) {
        requestDurationMs = null;
        requestDurationBasis = 'stale_local_boundary_excluded';
      }
      const responseItemCount = activeModelCall?.response_item_count ?? 0;
      const errorReason = payload.message || JSON.stringify(payload.codex_error_info || payload);
      fileRecords.push({
        ms,
        timestamp: row.timestamp || null,
        terminal_event_type: 'session.error',
        status: 'failed',
        error_reason: errorReason,
        usage: emptyUsage(),
        total_usage_snapshot: null,
        model: currentModel || session.model || '',
        effort: currentEffort || '',
        service_tier: currentServiceTier || '',
        service_tier_source: currentServiceTierSource || '',
        model_context_window: null,
        turn_id: currentTurn?.id || null,
        turn_sequence: currentTurn?.sequence ?? null,
        turn_started_ms: currentTurn?.started_ms ?? null,
        turn_elapsed_ms_estimate: currentTurn ? Math.max(0, ms - currentTurn.started_ms) : null,
        request_started_ms_estimate: requestStartMs,
        request_duration_ms_estimate: requestDurationMs,
        request_duration_basis: requestDurationBasis,
        first_output_ms_estimate: null,
        first_output_event_ms: activeModelCall?.first_output_ms ?? null,
        first_output_event_type: activeModelCall?.first_output_type || null,
        first_output_basis: null,
        turn_duration_ms_estimate: null,
        turn_completed_ms: null,
        response_item_count: responseItemCount,
        stream_observed: responseItemCount > 1 ? 1 : 0,
        stream_observed_basis:
          responseItemCount > 1
            ? 'multiple_response_items_before_error'
            : 'no_or_single_response_item_before_error',
        dedupe_key: `${session.id}|error=${ms}|message=${shortHash(errorReason)}`
      });
      setPendingModelStart(ms, 'previous_error');
      activeModelCall = null;
    } else if (row.type === 'event_msg' && payload.type === 'token_count') {
      diagnostics.token_events++;
      if (ms == null) continue;
      const resetModelCall = () => {
        const keepPendingForNext =
          pendingModelStartMs != null && activeModelCall?.first_output_ms != null && pendingModelStartMs > activeModelCall.first_output_ms;
        if (!keepPendingForNext) setPendingModelStart(ms, 'previous_token_count');
        activeModelCall = null;
      };
      const usage = normalizeUsage(payload.info?.last_token_usage || {});
      if (usage.total_tokens <= 0) {
        resetModelCall();
        continue;
      }
      const totalUsage = normalizeUsage(payload.info?.total_token_usage || {});
      const partialUsage = isPartialUsageWithoutBreakdown(usage);
      if (partialUsage) {
        pendingContextCompactionTokenCount = false;
        resetModelCall();
        continue;
      }
      const requestStartMs = activeModelCall?.request_start_ms ?? pendingModelStartMs ?? currentTurn?.started_ms ?? null;
      const firstOutputMs = activeModelCall?.first_output_ms ?? null;
      const responseItemCount = activeModelCall?.response_item_count ?? 0;
      let requestDurationMs = requestStartMs == null ? null : Math.max(0, ms - requestStartMs);
      let firstOutputDurationMs =
        requestStartMs == null || firstOutputMs == null ? null : Math.max(0, firstOutputMs - requestStartMs);
      let requestDurationBasis =
        requestStartMs == null ? null : `${activeModelCall?.request_start_basis || pendingModelStartBasis || 'unknown'}_to_token_count`;
      let firstOutputBasis =
        firstOutputDurationMs == null
          ? null
          : `${activeModelCall?.request_start_basis || pendingModelStartBasis || 'unknown'}_to_first_response_item`;
      if (requestDurationMs != null && requestDurationMs > MAX_REQUEST_DURATION_ESTIMATE_MS) {
        requestDurationMs = null;
        firstOutputDurationMs = null;
        requestDurationBasis = 'stale_local_boundary_excluded';
        firstOutputBasis = null;
      }
      let streamObserved = null;
      let streamObservedBasis = 'no_response_item_before_token_count';
      if (responseItemCount > 1) {
        streamObserved = 1;
        streamObservedBasis = 'multiple_response_items_before_token_count';
      } else if (responseItemCount === 1) {
        streamObserved = 0;
        streamObservedBasis = 'single_response_item_before_token_count';
      }
      const record = {
        ms,
        timestamp: row.timestamp || null,
        terminal_event_type: 'session.token_count',
        status: 'success',
        error_reason: null,
        usage,
        total_usage_snapshot: totalUsage.total_tokens > 0 ? totalUsage : null,
        model: currentModel || session.model || '',
        effort: currentEffort || '',
        service_tier: currentServiceTier || '',
        service_tier_source: currentServiceTierSource || '',
        model_context_window: payload.info?.model_context_window ?? null,
        turn_id: currentTurn?.id || null,
        turn_sequence: currentTurn?.sequence ?? null,
        turn_started_ms: currentTurn?.started_ms ?? null,
        turn_elapsed_ms_estimate: currentTurn ? Math.max(0, ms - currentTurn.started_ms) : null,
        request_started_ms_estimate: requestStartMs,
        request_duration_ms_estimate: requestDurationMs,
        request_duration_basis: requestDurationBasis,
        first_output_ms_estimate: firstOutputDurationMs,
        first_output_event_ms: firstOutputMs,
        first_output_event_type: activeModelCall?.first_output_type || null,
        first_output_basis: firstOutputBasis,
        turn_duration_ms_estimate: null,
        turn_completed_ms: null,
        response_item_count: responseItemCount,
        stream_observed: streamObserved,
        stream_observed_basis: streamObservedBasis
      };
      fileRecords.push(record);
      if (currentTurn) {
        const records = recordsByTurn.get(currentTurn.id) || [];
        records.push(record);
        recordsByTurn.set(currentTurn.id, records);
      }
      pendingContextCompactionTokenCount = false;
      resetModelCall();
    }
  }

  let ordinal = 0;
  const records = fileRecords.map((item) => {
    ordinal++;
    const totalUsage = item.total_usage_snapshot;
    const recordId = `session-token-${session.id}-${item.ms}-${ordinal}`;
    return {
      record_id: recordId,
      dedupe_key: item.dedupe_key || dedupeKey(session.id, item.usage, totalUsage),
      terminal_event_type: item.terminal_event_type || 'session.token_count',
      ms: item.ms,
      timestamp: item.timestamp,
      session_id: session.id,
      session_file: file,
      cwd: session.cwd || '',
      source: session.source || '',
      thread_source: session.thread_source || '',
      originator: session.originator || '',
      model_provider: session.model_provider || '',
      cli_version: session.cli_version || '',
      model: item.model || session.model || '',
      effort: item.effort || '',
      service_tier: item.service_tier || '',
      service_tier_source: item.service_tier_source || '',
      status: normalizeRecordStatus(item.status, item.error_reason),
      error_reason: item.error_reason || null,
      input_tokens: item.usage.input_tokens,
      cached_input_tokens: item.usage.cached_input_tokens,
      cache_write_input_tokens: item.usage.cache_write_input_tokens,
      output_tokens: item.usage.output_tokens,
      reasoning_output_tokens: item.usage.reasoning_output_tokens,
      total_tokens: item.usage.total_tokens,
      total_input_tokens_snapshot: totalUsage?.input_tokens ?? null,
      total_cached_input_tokens_snapshot: totalUsage?.cached_input_tokens ?? null,
      total_cache_write_input_tokens_snapshot: totalUsage?.cache_write_input_tokens ?? null,
      total_output_tokens_snapshot: totalUsage?.output_tokens ?? null,
      total_reasoning_output_tokens_snapshot: totalUsage?.reasoning_output_tokens ?? null,
      total_tokens_snapshot: totalUsage?.total_tokens ?? null,
      model_context_window: item.model_context_window,
      turn_id: item.turn_id,
      turn_sequence: item.turn_sequence,
      request_started_ms_estimate: item.request_started_ms_estimate,
      request_duration_ms_estimate: item.request_duration_ms_estimate,
      request_duration_basis: item.request_duration_basis,
      first_output_ms_estimate: item.first_output_ms_estimate,
      first_output_event_ms: item.first_output_event_ms,
      first_output_event_type: item.first_output_event_type,
      first_output_basis: item.first_output_basis,
      turn_started_ms: item.turn_started_ms,
      turn_elapsed_ms_estimate: item.turn_elapsed_ms_estimate,
      turn_completed_ms: item.turn_completed_ms,
      turn_duration_ms_estimate: item.turn_duration_ms_estimate,
      response_item_count: item.response_item_count,
      stream_observed: item.stream_observed,
      stream_observed_basis: item.stream_observed_basis,
      inserted_at_ms: Date.now()
    };
  });

  diagnostics.parsed_records = records.length;
  return { session, records, diagnostics };
}

function sqliteValue(value) {
  return value === undefined ? null : value;
}

function fileNeedsIngest(known, stat) {
  if (!known) return true;
  if (Number(known.file_size) !== Number(stat.size)) return true;
  return Math.abs(Number(known.mtime_ms) - Number(stat.mtimeMs)) > 1;
}

function ingestChangedSessionFiles() {
  const startedAt = Date.now();
  const files = walkFiles(SESSIONS_DIR, (file) => file.endsWith('.jsonl'));
  const knownStmt = db.prepare('SELECT file_size, mtime_ms FROM session_files WHERE file_path = ?');
  const changed = [];
  let statErrors = 0;

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const known = knownStmt.get(file);
      if (fileNeedsIngest(known, stat)) changed.push({ file, stat, known });
    } catch {
      statErrors++;
    }
  }

  const parsed = [];
  let parseErrors = 0;
  for (const item of changed) {
    try {
      parsed.push({ ...item, parsed: parseSessionFile(item.file, item.stat), error: null });
    } catch (error) {
      parseErrors++;
      parsed.push({ ...item, parsed: null, error });
    }
  }

  let insertedRecords = 0;
  let deletedRecords = 0;
  if (parsed.length) {
    const insertRecordSql = `
      INSERT OR IGNORE INTO token_records (${TOKEN_RECORD_COLUMNS.join(', ')})
      VALUES (${TOKEN_RECORD_COLUMNS.map(() => '?').join(', ')})
    `;
    const insertRecordStmt = db.prepare(insertRecordSql);
    const deleteFileRecordsStmt = db.prepare('DELETE FROM token_records WHERE session_file = ?');
    const upsertFileStmt = db.prepare(`
      INSERT INTO session_files (
        file_path,
        file_size,
        mtime_ms,
        scanned_at_ms,
        session_id,
        last_error,
        scanned_lines,
        malformed_lines,
        token_events,
        parsed_records
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size = excluded.file_size,
        mtime_ms = excluded.mtime_ms,
        scanned_at_ms = excluded.scanned_at_ms,
        session_id = excluded.session_id,
        last_error = excluded.last_error,
        scanned_lines = excluded.scanned_lines,
        malformed_lines = excluded.malformed_lines,
        token_events = excluded.token_events,
        parsed_records = excluded.parsed_records
    `);

    let inTransaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      for (const item of parsed) {
        if (item.known && Number(item.stat.size) < Number(item.known.file_size)) {
          const result = deleteFileRecordsStmt.run(item.file);
          deletedRecords += Number(result?.changes || 0);
        }
        if (item.error) {
          upsertFileStmt.run(
            item.file,
            item.stat.size,
            item.stat.mtimeMs,
            startedAt,
            null,
            item.error?.message || String(item.error),
            0,
            0,
            0,
            0
          );
          continue;
        }
        for (const record of item.parsed.records) {
          const result = insertRecordStmt.run(...TOKEN_RECORD_COLUMNS.map((column) => sqliteValue(record[column])));
          insertedRecords += Number(result?.changes || 0);
        }
        upsertFileStmt.run(
          item.file,
          item.stat.size,
          item.stat.mtimeMs,
          startedAt,
          item.parsed.session.id,
          null,
          item.parsed.diagnostics.scanned_lines,
          item.parsed.diagnostics.malformed_lines,
          item.parsed.diagnostics.token_events,
          item.parsed.diagnostics.parsed_records
        );
      }
      db.exec('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  if (insertedRecords || deletedRecords) cache.clear();
  return {
    ...indexedDiagnostics(files.length),
    session_scanned_files: changed.length,
    local_db_ingest_mode: 'on_demand_changed_session_files',
    local_db_last_ingest_ms: startedAt,
    local_db_changed_files: changed.length,
    local_db_unchanged_files: Math.max(0, files.length - changed.length - statErrors),
    local_db_inserted_records: insertedRecords,
    local_db_deleted_records: deletedRecords,
    local_db_parse_errors: parseErrors,
    local_db_stat_errors: statErrors
  };
}

function indexedDiagnostics(sessionFilesSeen) {
  const fileStats = db.prepare(`
    SELECT
      COUNT(*) AS indexed_files,
      COALESCE(SUM(scanned_lines), 0) AS scanned_lines,
      COALESCE(SUM(malformed_lines), 0) AS malformed_lines,
      COALESCE(SUM(token_events), 0) AS token_events,
      COALESCE(SUM(parsed_records), 0) AS parsed_records
    FROM session_files
  `).get() || {};
  const recordStats = db.prepare('SELECT COUNT(*) AS records FROM token_records').get() || {};
  const indexedRecords = Number(recordStats.records || 0);
  const parsedRecords = Number(fileStats.parsed_records || 0);
  return {
    sessions_dir: SESSIONS_DIR,
    local_db_file: DB_FILE,
    local_db_indexed_files: Number(fileStats.indexed_files || 0),
    local_db_records: indexedRecords,
    session_files: Number(sessionFilesSeen || 0),
    session_scanned_files: 0,
    session_metadata_scanned_lines: Number(fileStats.scanned_lines || 0),
    malformed_session_lines: Number(fileStats.malformed_lines || 0),
    session_token_count_events: Number(fileStats.token_events || 0),
    session_token_count_duplicate_events: Math.max(0, parsedRecords - indexedRecords),
    session_token_count_dedupe_strategy: 'session_id + last_token_usage_tuple + total_token_usage_snapshot_tuple'
  };
}

function totalUsageSnapshotFromRow(row) {
  if (row.total_tokens_snapshot == null) return null;
  return {
    input_tokens: row.total_input_tokens_snapshot ?? 0,
    cached_input_tokens: row.total_cached_input_tokens_snapshot ?? 0,
    cache_write_input_tokens: row.total_cache_write_input_tokens_snapshot ?? null,
    output_tokens: row.total_output_tokens_snapshot ?? 0,
    reasoning_output_tokens: row.total_reasoning_output_tokens_snapshot ?? 0,
    total_tokens: row.total_tokens_snapshot ?? 0
  };
}

function rowToRequest(row) {
  const usage = {
    input_tokens: row.input_tokens ?? 0,
    cached_input_tokens: row.cached_input_tokens ?? 0,
    cache_write_input_tokens: row.cache_write_input_tokens ?? null,
    output_tokens: row.output_tokens ?? 0,
    reasoning_output_tokens: row.reasoning_output_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0
  };
  const status = normalizeRecordStatus(row.status, row.error_reason);
  const costEstimate = estimateCost(usage, row.model);
  return {
    id: row.record_id,
    record_id: row.record_id,
    terminal_event_type: row.terminal_event_type || (status === 'failed' ? 'session.error' : 'session.token_count'),
    created_ms: null,
    completed_ms: row.ms,
    response_timestamp_ms: row.ms,
    response_timestamp_source: 'codex_session_token_count_event_timestamp',
    duration_ms: null,
    duration_ms_estimate: row.request_duration_ms_estimate,
    duration_basis: row.request_duration_ms_estimate == null ? null : row.request_duration_basis,
    request_started_ms_estimate: row.request_started_ms_estimate,
    request_duration_ms_estimate: row.request_duration_ms_estimate,
    request_duration_basis: row.request_duration_basis,
    first_output_ms_estimate: row.first_output_ms_estimate,
    first_output_event_ms: row.first_output_event_ms,
    first_output_event_type: row.first_output_event_type,
    first_output_basis: row.first_output_basis,
    turn_id: row.turn_id,
    turn_sequence: row.turn_sequence,
    turn_started_ms: row.turn_started_ms,
    turn_completed_ms: row.turn_completed_ms,
    turn_elapsed_ms_estimate: row.turn_elapsed_ms_estimate,
    turn_duration_ms_estimate: row.turn_duration_ms_estimate,
    response_item_count: row.response_item_count,
    stream_observed: row.stream_observed == null ? null : Boolean(row.stream_observed),
    stream_observed_basis: row.stream_observed_basis,
    model: row.model || '',
    effort: row.effort || '',
    service_tier: row.service_tier || '',
    service_tier_source: row.service_tier_source || '',
    status,
    error_reason: row.error_reason || null,
    usage,
    usage_source: 'codex_session_last_token_usage',
    cost_estimate: costEstimate,
    total_usage_snapshot: totalUsageSnapshotFromRow(row),
    model_context_window: row.model_context_window,
    conversation_id: row.session_id,
    originator: row.originator || null,
    source_quality: 'codex_session_token_count',
    source_context: {
      data_source: 'codex_session_token_count',
      conversation_id: row.session_id,
      originator: row.originator || '',
      cwd: row.cwd || '',
      session_source: row.source || '',
      thread_source: row.thread_source || '',
      model_provider: row.model_provider || '',
      session_file: row.session_file || '',
      source_quality: 'codex_session_token_count'
    }
  };
}

function queryTokenRecords(startMs, endMs) {
  return db
    .prepare(`
      SELECT *
      FROM token_records
      WHERE ms >= ? AND ms <= ?
        AND NOT (
          input_tokens = 0
          AND cached_input_tokens = 0
          AND output_tokens = 0
          AND total_tokens > 0
        )
      ORDER BY ms DESC
    `)
    .all(startMs, endMs)
    .map(rowToRequest);
}

function countExcludedSystemRecords(startMs, endMs) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM token_records
    WHERE ms >= ? AND ms <= ?
      AND input_tokens = 0
      AND cached_input_tokens = 0
      AND output_tokens = 0
      AND total_tokens > 0
  `).get(startMs, endMs);
  return Number(row?.count || 0);
}

function summarizeCost(requests) {
  let amountUsd = 0;
  let pricedRecords = 0;
  let unpricedRecords = 0;
  let lowerBoundRecords = 0;
  const byModel = new Map();
  for (const request of requests) {
    const cost = request.cost_estimate;
    const hasTokens = request.usage.total_tokens > 0 || request.usage.input_tokens > 0 || request.usage.output_tokens > 0;
    const hasBillableBreakdown =
      request.usage.input_tokens > 0 || request.usage.cached_input_tokens > 0 || request.usage.output_tokens > 0;
    if (cost?.known && Number.isFinite(cost.amount_usd) && hasBillableBreakdown) {
      amountUsd += cost.amount_usd;
      pricedRecords++;
      if (cost.is_lower_bound) lowerBoundRecords++;
      const key = cost.model_key || request.model || 'unknown';
      const item = byModel.get(key) || { model: key, records: 0, lower_bound_records: 0, amount_usd: 0 };
      item.records++;
      if (cost.is_lower_bound) item.lower_bound_records++;
      item.amount_usd += cost.amount_usd;
      byModel.set(key, item);
    } else if (hasTokens) {
      unpricedRecords++;
    }
  }
  return {
    currency: pricingConfig.currency || 'USD',
    amount_usd: amountUsd,
    priced_records: pricedRecords,
    unpriced_records: unpricedRecords,
    lower_bound_records: lowerBoundRecords,
    is_lower_bound: lowerBoundRecords > 0,
    source: pricingConfig.source || '',
    updated_at: pricingConfig.updated_at || '',
    by_model: [...byModel.values()].sort((a, b) => b.amount_usd - a.amount_usd)
  };
}

function cacheHitRate(usage) {
  if (!usage.input_tokens) return null;
  return usage.cached_input_tokens / usage.input_tokens;
}

function countBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item) || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function buildData(startMs, endMs, bucket, pagination) {
  const diagnostics = ingestChangedSessionFiles();
  const requests = queryTokenRecords(startMs, endMs);
  const excludedSystemRecords = countExcludedSystemRecords(startMs, endMs);

  const requestUsage = requests.reduce((sum, req) => addUsage(sum, req.usage), emptyUsage());
  const costSummary = summarizeCost(requests);
  const durationEstimates = requests.map((r) => r.duration_ms_estimate).filter((v) => Number.isFinite(v) && v > 0);
  const firstOutputEstimates = requests.map((r) => r.first_output_ms_estimate).filter((v) => Number.isFinite(v) && v >= 0);
  const turnDurations = requests.map((r) => r.turn_duration_ms_estimate).filter((v) => Number.isFinite(v) && v > 0);
  const streamKnownRecords = requests.filter((r) => Number.isFinite(r.response_item_count) && r.response_item_count > 0).length;
  const streamObservedRecords = requests.filter((r) => r.stream_observed === true).length;
  const serviceTierKnownRecords = requests.filter((r) => r.service_tier).length;
  const totalRecords = requests.length;
  const pageSize = pagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const page = Math.min(Math.max(1, pagination.page), totalPages);
  const offset = (page - 1) * pageSize;
  const pageRequests = requests.slice(offset, offset + pageSize);

  return {
    generated_at: Date.now(),
    range: { start_ms: startMs, end_ms: endMs, bucket },
    codex_home: CODEX_HOME,
    diagnostics: {
      ...diagnostics,
      request_records: requests.length,
      session_token_count_records: requests.length,
      excluded_system_token_count_records: excludedSystemRecords
    },
    summary: {
      request_records: requests.length,
      session_token_count_records: requests.length,
      request_usage: requestUsage,
      cache_hit_rate: cacheHitRate(requestUsage),
      estimated_cost: costSummary,
      average_request_duration_ms_estimate: durationEstimates.length
        ? durationEstimates.reduce((a, b) => a + b, 0) / durationEstimates.length
        : null,
      average_turn_elapsed_ms_estimate: durationEstimates.length
        ? durationEstimates.reduce((a, b) => a + b, 0) / durationEstimates.length
        : null,
      average_first_output_ms_estimate: firstOutputEstimates.length
        ? firstOutputEstimates.reduce((a, b) => a + b, 0) / firstOutputEstimates.length
        : null,
      average_turn_duration_ms_estimate: turnDurations.length
        ? turnDurations.reduce((a, b) => a + b, 0) / turnDurations.length
        : null,
      stream_known_records: streamKnownRecords,
      stream_observed_records: streamObservedRecords,
      service_tier_known_records: serviceTierKnownRecords
    },
    buckets: summarizeBuckets(requests, bucket, startMs, endMs),
    data_quality: {
      primary_records: 'codex_session_token_count_events',
      token_usage: 'codex_session_last_token_usage',
      source_context: 'codex_session_metadata_and_turn_context',
      duration_ms_estimate: 'local_observed_model_request_start_to_token_count',
      first_output_ms_estimate: 'local_observed_model_request_start_to_first_response_item',
      stream_observed: 'local_response_item_count_before_token_count_not_official_stream_flag',
      service_tier: 'codex_session_request_service_tier_when_present_no_current_config_backfill',
      cost_estimate: 'local_token_rate_estimate_cache_write_lower_bound_when_usage_missing',
      turn_duration_ms_estimate: 'local_session_task_started_to_task_complete',
      excluded_system_records: 'breakdownless_token_count_events_from_compaction_abort_or_rollback',
      excluded_sources: ['logs_2.sqlite', 'raw_sse', 'codex_otel']
    },
    counts: {
      status: countBy(requests, (req) => req.status),
      model: countBy(requests, (req) => req.model),
      service_tier: countBy(requests, (req) => req.service_tier),
      originator: countBy(requests, (req) => req.originator)
    },
    pagination: {
      page,
      page_size: pageSize,
      total_records: totalRecords,
      total_pages: totalPages
    },
    requests: pageRequests
  };
}

function boundedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseRange(searchParams) {
  const now = Date.now();
  const endMsParam = searchParams.get('end_ms');
  const startMsParam = searchParams.get('start_ms');
  let end = endMsParam != null ? Number(endMsParam) : (timestampMs(searchParams.get('end')) || now);
  let start = startMsParam != null ? Number(startMsParam) : timestampMs(searchParams.get('start'));
  if (!Number.isFinite(end)) end = now;
  if (start == null || !Number.isFinite(start)) {
    const days = Number(searchParams.get('days') || 7);
    start = days <= 0 ? 0 : end - days * 24 * 60 * 60 * 1000;
  }
  return {
    startMs: Math.max(0, start),
    endMs: Math.max(start, end),
    bucket: ['hour', 'day', 'week'].includes(searchParams.get('bucket')) ? searchParams.get('bucket') : 'day',
    page: boundedInteger(searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: boundedInteger(searchParams.get('page_size'), 7, 5, 100)
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
    const cacheKey = `${range.startMs}:${range.endMs}:${range.bucket}:${range.page}:${range.pageSize}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      sendJson(res, 200, cached.data);
      return;
    }
    try {
      const data = buildData(range.startMs, range.endMs, range.bucket, {
        page: range.page,
        pageSize: range.pageSize
      });
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
      data_source: 'codex_session_jsonl_to_local_sqlite',
      local_db_file: DB_FILE,
      local_db_ingest_mode: 'on_demand_changed_session_files'
    });
    return;
  }
  sendStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Codex token monitor: http://${HOST}:${PORT}`);
  console.log(`CODEX_HOME: ${CODEX_HOME}`);
});
