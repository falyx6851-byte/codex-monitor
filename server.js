'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {SESSION_PARSER_VERSION,parseSessionFile,walkFiles,normalizeUsage,addUsage,emptyUsage,finiteOrZero,optionalFinite,isPartialUsageWithoutBreakdown,normalizeServiceTier,extractServiceTier,normalizeRecordStatus,timestampMs} = require('./lib/session-parser');
const { spawn } = require('node:child_process');
const { URL } = require('url');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  throw new Error('Codex Token Monitor dashboard requires Node.js 24+ for node:sqlite. The standalone report script still supports Node.js 18+.');
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.CODEX_TOKEN_MONITOR_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'codex-token-monitor.sqlite');
const PRICING_FILE = path.join(ROOT, 'pricing.json');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME, 'archived_sessions');
const PORT = Number(process.env.CODEX_TOKEN_MONITOR_PORT || process.env.PORT || 4127);
const HOST = process.env.CODEX_TOKEN_MONITOR_HOST || '127.0.0.1';
const CACHE_TTL_MS = Number(process.env.CODEX_TOKEN_MONITOR_CACHE_MS || 8000);

const cache = new Map();

function loadPricing() {
  try {
    return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
  } catch {
    return {
      currency: 'USD',
      source: '',
      updated_at: '',
      long_context_threshold_tokens: 272000,
      models: {},
      aliases: {}
    };
  }
}

const pricingConfig = loadPricing();
const PRICING_VERSION = crypto.createHash('sha256').update(JSON.stringify(pricingConfig)).digest('hex');

function resolvePricing(model) {
  // Strip only known effort decorations; never guess an unknown model family.
  const raw = String(model || '').trim().toLowerCase()
    .replace(/(?:\((?:none|minimal|low|medium|high|xhigh|max|ultra)\)|-(?:none|minimal|low|medium|high|xhigh|max|ultra))$/, '');
  if (!raw) return null;
  const exact = pricingConfig.models?.[raw];
  if (exact) return { key: raw, pricing: exact };
  const alias = pricingConfig.aliases?.[raw] || pricingConfig.aliases?.[raw.toLowerCase()];
  if (alias && pricingConfig.models?.[alias]) return { key: alias, pricing: pricingConfig.models[alias] };
  return null;
}

function pricingServiceTier(value) {
  const tier = normalizeServiceTier(value);
  if (tier === 'priority' || tier === 'fast') return 'priority';
  if (!tier || ['auto', 'default', 'standard'].includes(tier)) return 'standard';
  return tier;
}

function estimateCost(usage, model, serviceTier) {
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
  const threshold = Number(pricingConfig.long_context_threshold_tokens || 272000);
  const selectedServiceTier = pricingServiceTier(serviceTier);
  const assumedServiceTier = !normalizeServiceTier(serviceTier) || normalizeServiceTier(serviceTier) === 'auto';
  const overLongContextThreshold = inputTokens > threshold;
  let rates = resolved.pricing;
  let rateTier = 'standard';
  if (selectedServiceTier !== 'standard') {
    const tierRates = ['priority', 'flex', 'ultrafast'].includes(selectedServiceTier)
      ? resolved.pricing[selectedServiceTier] : null;
    if (!tierRates || (overLongContextThreshold && !tierRates.long_context)) {
      return {
        currency: pricingConfig.currency || 'USD',
        amount_usd: null,
        known: false,
        model_key: resolved.key,
        tier: selectedServiceTier,
        service_tier: selectedServiceTier,
        reason: tierRates && overLongContextThreshold
          ? `${selectedServiceTier}_long_context_pricing_unavailable`
          : `missing_${selectedServiceTier}_pricing`
      };
    }
    rates = overLongContextThreshold ? tierRates.long_context : tierRates;
    rateTier = overLongContextThreshold ? `${selectedServiceTier}_long_context` : selectedServiceTier;
  } else if (overLongContextThreshold && resolved.pricing.long_context) {
    rates = resolved.pricing.long_context;
    rateTier = 'standard_long_context';
  }
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
    complete: !cacheWriteMissing && !assumedServiceTier,
    service_tier_assumed: assumedServiceTier,
    assumption: assumedServiceTier ? 'standard_rate_used_without_service_tier_evidence' : null,
    cache_write_tokens_missing: cacheWriteMissing,
    is_lower_bound: cacheWriteMissing && !assumedServiceTier,
    estimate_kind: assumedServiceTier ? 'assumed_standard_rate' : cacheWriteMissing ? 'lower_bound' : 'token_rate_estimate',
    reason: cacheWriteMissing ? 'cache_write_tokens_unavailable_in_codex_session' : null,
    model_key: resolved.key,
    tier: rateTier,
    service_tier: selectedServiceTier,
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
    assumed_service_tier_records: 0,
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
      if (req.cost_estimate.service_tier_assumed) item.assumed_service_tier_records++;
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
        assumed_service_tier_records: item.assumed_service_tier_records,
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
  'inserted_at_ms', 'cost_amount_usd', 'cost_known', 'cost_model_key',
  'cost_is_lower_bound', 'cost_service_tier_assumed', 'pricing_version'
];

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;

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
  ensureColumn(database, 'session_files', 'parser_version', 'INTEGER NOT NULL DEFAULT 1');
  for (const [column, definition] of Object.entries({cost_amount_usd:'REAL',cost_known:'INTEGER',cost_model_key:'TEXT',
    cost_is_lower_bound:'INTEGER',cost_service_tier_assumed:'INTEGER',pricing_version:'TEXT'})) {
    ensureColumn(database, 'token_records', column, definition);
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_token_records_page ON token_records(ms DESC, record_id DESC)');
  return database;
}

const db = initDb();

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function sqliteValue(value) {
  return value === undefined ? null : value;
}

function fileNeedsIngest(known, stat) {
  if (!known) return true;
  if (Number(known.parser_version || 1) !== SESSION_PARSER_VERSION) return true;
  if (Number(known.file_size) !== Number(stat.size)) return true;
  return Math.abs(Number(known.mtime_ms) - Number(stat.mtimeMs)) > 1;
}

function priceColumns(record) {
  const cost = estimateCost(record, record.model, record.service_tier);
  return {cost_amount_usd:cost.amount_usd, cost_known:Number(cost.known), cost_model_key:cost.model_key,
    cost_is_lower_bound:Number(Boolean(cost.is_lower_bound)), cost_service_tier_assumed:Number(Boolean(cost.service_tier_assumed)),
    pricing_version:PRICING_VERSION};
}

function refreshStoredPricing() {
  const columns = Object.keys(priceColumns({}));
  const update = db.prepare(`UPDATE token_records SET ${columns.map(k=>k+'=?').join(',')} WHERE record_id=?`);
  let rows;
  while ((rows=db.prepare('SELECT * FROM token_records WHERE pricing_version IS NULL OR pricing_version != ? LIMIT 1000').all(PRICING_VERSION)).length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) { const cost=priceColumns(row); update.run(...columns.map(k=>cost[k] ?? null),row.record_id); }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

function ingestChangedSessionFiles() {
  const startedAt = Date.now();
  const activeFiles = walkFiles(SESSIONS_DIR, (file) => file.endsWith('.jsonl'));
  const archivedFiles = walkFiles(ARCHIVED_SESSIONS_DIR, (file) => file.endsWith('.jsonl'));
  const files = [...activeFiles, ...archivedFiles];
  const knownStmt = db.prepare('SELECT * FROM session_files WHERE file_path = ?');
  const groups = new Map();
  let statErrors = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const known = knownStmt.get(file);
      const id = path.basename(file).match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i)?.[1] || known?.session_id || file;
      const group = groups.get(id) || { changed: false, files: [] };
      group.changed ||= fileNeedsIngest(known, stat) || Boolean(known?.last_error);
      group.files.push({ file, stat });
      groups.set(id, group);
    } catch { statErrors++; }
  }
  const insertRecord = db.prepare(
    'INSERT OR IGNORE INTO token_records (' + TOKEN_RECORD_COLUMNS.join(', ') + ') VALUES (' + TOKEN_RECORD_COLUMNS.map(() => '?').join(', ') + ')'
  );
  // Ownership comes from the physical source, never a possibly corrupt old session_id.
  const deleteSource = db.prepare('DELETE FROM token_records WHERE session_file = ?');
  const deleteMetadata = db.prepare('DELETE FROM session_files WHERE file_path = ?');
  const oldSources = new Map();
  for (const row of db.prepare('SELECT DISTINCT session_file FROM token_records').all()) {
    const id=path.basename(row.session_file).match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i)?.[1];
    if (id) { if (!oldSources.has(id)) oldSources.set(id,[]); oldSources.get(id).push(row.session_file); }
  }
  const insertMetadata = db.prepare(
    'INSERT OR REPLACE INTO session_files (file_path,file_size,mtime_ms,scanned_at_ms,session_id,last_error,scanned_lines,malformed_lines,token_events,parsed_records,parser_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  let scannedFiles = 0, insertedRecords = 0, deletedRecords = 0, parseErrors = 0;
  for (const group of groups.values()) {
    if (!group.changed) continue;
    // Rebuild one logical session atomically, including both active/archive copies.
    // Only sessions with readable originals are replaced; orphan history is retained.
    let inTransaction = false, sessionId = null, inserted = 0, deleted = 0;
    try {
      for (const item of group.files) {
        scannedFiles++;
        const parsed = parseSessionFile(item.file, item.stat);
        if (parsed.diagnostics.malformed_lines) throw new Error('Incomplete or malformed session JSONL');
        if (!sessionId) {
          sessionId = parsed.session.id;
          db.exec('BEGIN IMMEDIATE');
          inTransaction = true;
          for (const source of new Set([...group.files.map(f=>f.file),...(oldSources.get(sessionId) || [])])) {
            deleted += Number(deleteSource.run(source).changes);
            deleteMetadata.run(source);
          }
        } else if (sessionId !== parsed.session.id) {
          throw new Error('Session identity mismatch');
        }
        for (const record of parsed.records) {
          Object.assign(record, priceColumns(record));
          inserted += Number(insertRecord.run(...TOKEN_RECORD_COLUMNS.map((column) => sqliteValue(record[column]))).changes);
        }
        insertMetadata.run(item.file, item.stat.size, item.stat.mtimeMs, startedAt, sessionId, null,
          parsed.diagnostics.scanned_lines, parsed.diagnostics.malformed_lines,
          parsed.diagnostics.token_events, parsed.diagnostics.parsed_records, SESSION_PARSER_VERSION);
      }
      db.exec('COMMIT');
      inTransaction = false;
      insertedRecords += inserted;
      deletedRecords += deleted;
    } catch {
      if (inTransaction) db.exec('ROLLBACK');
      parseErrors++;
      // Do not advance the file fingerprint on failure: retry on the next refresh.
    }
  }
  refreshStoredPricing();
  if (insertedRecords || deletedRecords) { cache.clear(); if (typeof queries !== 'undefined') queries.clear(); }
  return {
    ...indexedDiagnostics(files.length),
    archived_sessions_dir: ARCHIVED_SESSIONS_DIR,
    active_session_files: activeFiles.length,
    archived_session_files: archivedFiles.length,
    session_scanned_files: scannedFiles,
    local_db_ingest_mode: 'on_demand_changed_session_files',
    local_db_last_ingest_ms: startedAt,
    local_db_changed_files: scannedFiles,
    local_db_unchanged_files: Math.max(0, files.length - scannedFiles - statErrors),
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
    session_token_count_dedupe_strategy: 'response_id_then_legacy_counter_or_event; inherited_history_excluded'
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
  const costEstimate = estimateCost(usage, row.model, row.service_tier);
  return {
    id: row.record_id,
    record_id: row.record_id,
    terminal_event_type: row.terminal_event_type || (status === 'failed' ? 'session.error' : 'session.token_count'),
    created_ms: null,
    completed_ms: row.ms,
    response_timestamp_ms: row.ms,
    response_timestamp_source: row.terminal_event_type === 'session.token_usage_record' ? 'codex_response_usage_timestamp' : 'local_model_output_timestamp',
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
    usage_source: row.terminal_event_type === 'session.token_usage_record' ? 'codex_response_token_usage_record' : 'codex_session_last_token_usage',
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
  let assumedTierRecords = 0;
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
      if (cost.service_tier_assumed) assumedTierRecords++;
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
    amount_usd: pricedRecords === 0 && unpricedRecords > 0 ? null : amountUsd,
    priced_records: pricedRecords,
    unpriced_records: unpricedRecords,
    lower_bound_records: lowerBoundRecords,
    assumed_service_tier_records: assumedTierRecords,
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

let ingestWorker = null;
let lastIngest = null;
let lastIngestCompletedAt = 0;
let lastIngestError = null;

function scheduleIngest(force = false) {
  if (ingestWorker || (!force && Date.now() - lastIngestCompletedAt < CACHE_TTL_MS)) return;
  const worker = spawn(process.execPath, ['--no-warnings', '--max-semi-space-size=8', '--max-old-space-size=512', __filename, '--ingest-only'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  ingestWorker = worker;
  cache.clear();
  let output = '';
  worker.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
  worker.stderr.resume();
  worker.on('error', () => { lastIngestError = 'ingest_worker_start_failed'; });
  worker.on('close', code => {
    try {
      if (code !== 0) throw new Error('worker_failed');
      lastIngest = JSON.parse(output);
      lastIngestError = lastIngest.local_db_parse_errors ? 'session_parse_failed_will_retry' : null;
    } catch { lastIngestError = 'ingest_failed_will_retry'; }
    ingestWorker = null;
    lastIngestCompletedAt = Date.now();
    cache.clear();
  });
}

process.on('exit', () => { if (ingestWorker) ingestWorker.kill(); });

const {createQueries} = require('./lib/query');
const queries = createQueries(db,{rowToRequest,pricingConfig,bucketStart,bucketLabel,nextBucketStart});
function buildData(startMs,endMs,bucket,pagination) {
  const data=queries.read(startMs,endMs,bucket,pagination);
  return {generated_at:Date.now(),range:{start_ms:startMs,end_ms:endMs,bucket,end_exclusive:true},codex_home:CODEX_HOME,
    diagnostics:{...(lastIngest || indexedDiagnostics(0)),indexing_in_progress:Boolean(ingestWorker),
      last_index_completed_at:lastIngestCompletedAt || null,indexing_error:lastIngestError,request_records:data.summary.request_records,
      query_duration_ms:data.query_duration_ms},
    data_quality:{primary_records:'response_id_usage_with_legacy_token_count_fallback',cost_estimate:'local_current_pricing_snapshot',
      duration_ms_estimate:'local_model_output_boundaries_excluding_tool_wait',excluded_sources:['logs_2.sqlite','raw_sse','codex_otel']},...data};
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
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > 8.64e15) throw new Error('invalid_time_range');
  return {
    startMs: start,
    endMs: end,
    bucket: ['hour', 'day', 'week'].includes(searchParams.get('bucket')) ? searchParams.get('bucket') : 'day',
    page: boundedInteger(searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: boundedInteger(searchParams.get('page_size'), 6, 5, 100)
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

async function exportData(res, range) {
  const snapshot = new DatabaseSync(DB_FILE, {readOnly:true});
  const reader = createQueries(snapshot,{rowToRequest,pricingConfig,bucketStart,bucketLabel,nextBucketStart});
  const waitDrain = () => new Promise((resolve,reject)=>{
    const done=()=>{cleanup();resolve();}, closed=()=>{cleanup();reject(new Error('export_closed'));};
    const cleanup=()=>{res.off('drain',done);res.off('close',closed);res.off('error',closed);};
    res.once('drain',done);res.once('close',closed);res.once('error',closed);
  });
  const write = async value => { if (res.destroyed) throw new Error('export_closed'); if (!res.write(value)) await waitDrain(); };
  try {
    snapshot.exec('BEGIN');
    const base=reader.aggregate(range.startMs,range.endMs,range.bucket);
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
      'content-disposition':`attachment; filename="codex-all-records-${Date.now()}.json"`});
    const head={generated_at:Date.now(),range:{start_ms:range.startMs,end_ms:range.endMs,bucket:range.bucket,end_exclusive:true},
      export_scope:'all_records_in_range',summary:base.summary,counts:base.counts,buckets:base.buckets};
    await write(JSON.stringify(head).slice(0,-1)+',"requests":[');
    let count=0;
    for (const row of reader.iterate(range.startMs,range.endMs)) {
      await write((count ? ',' : '')+JSON.stringify(rowToRequest(row)));
      if (++count%100===0) await new Promise(setImmediate);
    }
    await write(']}');snapshot.exec('COMMIT');res.end();
  } catch (error) {
    try { snapshot.exec('ROLLBACK'); } catch {}
    if (!res.headersSent) sendJson(res,500,{error:'export_failed'}); else res.destroy();
  } finally { snapshot.close(); }
}

const server = http.createServer((req, res) => {
  if (!isAllowedRequest(req)) {
    sendJson(res, 403, { error: 'forbidden_host' });
    return;
  }
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`); }
  catch { sendJson(res,400,{error:'invalid_url'});return; }
  if (url.pathname === '/api/data' || url.pathname === '/api/export') {
    let range;
    try { range = parseRange(url.searchParams); }
    catch { sendJson(res,400,{error:'invalid_time_range'});return; }
    if (url.pathname === '/api/export') { void exportData(res,range);return; }
    if (url.searchParams.get('refresh') !== '0') scheduleIngest(url.searchParams.get('refresh') === '1');
    try {
      const data = buildData(range.startMs, range.endMs, range.bucket, {
        page: range.page,
        pageSize: range.pageSize
      });
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
      version: require('./package.json').version,
      parser_version: SESSION_PARSER_VERSION,
      pricing_updated_at: pricingConfig.updated_at,
      session_sources: [SESSIONS_DIR, ARCHIVED_SESSIONS_DIR],
      indexing_in_progress: Boolean(ingestWorker),
      indexing_error: lastIngestError,
      last_index_completed_at: lastIngestCompletedAt || null,
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

if (require.main === module && process.argv.includes('--ingest-only')) {
  try {
    console.log(JSON.stringify(ingestChangedSessionFiles()));
  } finally { db.close(); }
} else if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Codex token monitor: http://${HOST}:${PORT}`);
    console.log(`CODEX_HOME: ${CODEX_HOME}`);
    scheduleIngest();
  });
}

module.exports = {
  estimateCost,
  ingestChangedSessionFiles,
  summarizeCost,
  db,
  extractServiceTier,
  parseSessionFile,
  pricingServiceTier,
  buildData, queries, refreshStoredPricing
};
