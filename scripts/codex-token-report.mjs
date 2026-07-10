#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.3.0';
const MAX_REQUEST_DURATION_ESTIMATE_MS = 10 * 60 * 1000;

function usageText() {
  return `
Codex local token report ${VERSION}

Usage:
  node scripts/codex-token-report.mjs [options]

Options:
  --codex-home <dir>      Codex home directory. Default: CODEX_HOME or ~/.codex
  --start <time>          Start time. Accepts ms, ISO time, or YYYY-MM-DD
  --end <time>            End time. Accepts ms, ISO time, or YYYY-MM-DD
  --days <n>              Last n days. Default: 1
  --today                 From local midnight to now
  --all                   Include all session history
  --format <type>         json, csv, or table. Default: table
  --bucket <width>        none, hour, day, or week. Default: day
  --limit <n>             Max records in table/json records. Default: 50
  --page <n>              Page number for records. Default: 1
  --page-size <n>         Page size for records. Default: limit
  --no-dedupe             Keep duplicate token_count events
  --redact-paths          Redact local cwd/session file paths in output
  --out <file>            Write output to file instead of stdout
  --help                  Show help

Examples:
  node scripts/codex-token-report.mjs --today --format table
  node scripts/codex-token-report.mjs --days 7 --format json --out codex-usage.json
  node scripts/codex-token-report.mjs --start 2026-06-01 --end 2026-06-24 --format csv --out records.csv
`;
}

function parseArgs(argv) {
  const args = {
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    start: null,
    end: Date.now(),
    days: 1,
    all: false,
    today: false,
    format: 'table',
    bucket: 'day',
    limit: 50,
    page: 1,
    pageSize: null,
    dedupe: true,
    redactPaths: false,
    out: ''
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--codex-home') {
      args.codexHome = next();
    } else if (arg === '--start') {
      args.start = parseTime(next());
    } else if (arg === '--end') {
      args.end = parseTime(next());
    } else if (arg === '--days') {
      args.days = Number(next());
    } else if (arg === '--today') {
      args.today = true;
    } else if (arg === '--all') {
      args.all = true;
    } else if (arg === '--format') {
      args.format = next();
    } else if (arg === '--bucket') {
      args.bucket = next();
    } else if (arg === '--limit') {
      args.limit = Number(next());
    } else if (arg === '--page') {
      args.page = Number(next());
    } else if (arg === '--page-size') {
      args.pageSize = Number(next());
    } else if (arg === '--no-dedupe') {
      args.dedupe = false;
    } else if (arg === '--redact-paths') {
      args.redactPaths = true;
    } else if (arg === '--out') {
      args.out = next();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!['json', 'csv', 'table'].includes(args.format)) throw new Error('--format must be json, csv, or table');
  if (!['none', 'hour', 'day', 'week'].includes(args.bucket)) throw new Error('--bucket must be none, hour, day, or week');
  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = 50;
  if (!Number.isFinite(args.page) || args.page < 1) args.page = 1;
  if (!Number.isFinite(args.pageSize) || args.pageSize < 1) args.pageSize = args.limit;

  if (args.all) {
    args.start = 0;
  } else if (args.today) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    args.start = d.getTime();
  } else if (args.start == null) {
    args.start = args.end - Math.max(0, args.days) * 24 * 60 * 60 * 1000;
  }
  return args;
}

function parseTime(value) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00`);
    const ms = d.getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid time: ${value}`);
  return ms;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
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

function parseSessionIdFromPath(file) {
  const name = path.basename(file, '.jsonl');
  const m = name.match(/rollout-[^-]+-[^-]+-(.+)$/);
  return m ? m[1] : name;
}

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeUsage(usage) {
  const input = finiteOrZero(usage?.input_tokens);
  const cached = finiteOrZero(usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens);
  const output = finiteOrZero(usage?.output_tokens);
  const reasoning = finiteOrZero(usage?.reasoning_output_tokens ?? usage?.output_tokens_details?.reasoning_tokens);
  const total = usage?.total_tokens == null ? input + output : finiteOrZero(usage.total_tokens);
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

function isSystemUsageWithoutBreakdown(usage) {
  return (
    usage.total_tokens > 0 &&
    usage.input_tokens === 0 &&
    usage.cached_input_tokens === 0 &&
    usage.output_tokens === 0
  );
}

function usageTuple(usage) {
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  ].join('/');
}

function dedupeKey(sessionId, usage, totalUsageSnapshot) {
  const snapshot = totalUsageSnapshot || emptyUsage();
  return `${sessionId}|last=${usageTuple(usage)}|total=${usageTuple(snapshot)}`;
}

function redactLocalPath(value) {
  if (!value) return value;
  const text = String(value);
  if (!path.isAbsolute(text)) return text;
  return '[redacted-path]';
}

function scanSessions(options) {
  const sessionsDir = path.join(options.codexHome, 'sessions');
  const files = walkFiles(sessionsDir, (file) => file.endsWith('.jsonl'));
  const records = [];
  const seen = new Set();
  const sessions = new Map();
  let scannedFiles = 0;
  let scannedLines = 0;
  let malformedLines = 0;
  let tokenEvents = 0;
  let duplicateEvents = 0;
  let excludedSystemEvents = 0;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
      if (stat.mtimeMs < options.start && stat.birthtimeMs < options.start) continue;
    } catch {
      continue;
    }
    scannedFiles++;
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
      start_ms: stat.birthtimeMs || stat.mtimeMs,
      end_ms: stat.mtimeMs,
      token_events: 0,
      records: 0
    };

    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let currentModel = '';
    let currentEffort = '';
    let currentTurn = null;
    let turnSequence = 0;
    let pendingModelStartMs = null;
    let pendingModelStartBasis = null;
    let activeModelCall = null;
    const recordsByTurn = new Map();
    let ordinal = 0;
    const setPendingModelStart = (value, basis) => {
      if (Number.isFinite(value)) {
        pendingModelStartMs = value;
        pendingModelStartBasis = basis;
      }
    };

    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      scannedLines++;
      const row = parseJsonLine(line);
      if (!row) {
        malformedLines++;
        continue;
      }
      const ms = Date.parse(row.timestamp || '');
      if (Number.isFinite(ms)) {
        if (ms < session.start_ms) session.start_ms = ms;
        if (ms > session.end_ms) session.end_ms = ms;
      }
      const payload = row.payload || {};
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
        if (payload.effort) {
          currentEffort = payload.effort;
          session.effort = payload.effort;
        }
      } else if (row.type === 'event_msg' && payload.type === 'task_started' && Number.isFinite(ms)) {
        turnSequence++;
        currentTurn = {
          id: `${session.id}:turn:${turnSequence}`,
          sequence: turnSequence,
          started_ms: ms,
          started_at: row.timestamp || null
        };
        recordsByTurn.set(currentTurn.id, []);
        setPendingModelStart(ms, 'task_started');
      } else if (row.type === 'event_msg' && payload.type === 'task_complete' && Number.isFinite(ms)) {
        if (currentTurn) {
          const turnRecords = recordsByTurn.get(currentTurn.id) || [];
          for (const record of turnRecords) {
            record.turn_completed_at = row.timestamp || null;
            record.turn_completed_ms = ms;
            record.turn_duration_ms_estimate = Math.max(0, ms - currentTurn.started_ms);
          }
          currentTurn = null;
        }
      } else if (row.type === 'event_msg' && payload.type === 'user_message' && Number.isFinite(ms)) {
        setPendingModelStart(ms, 'user_message');
      } else if (
        row.type === 'event_msg' &&
        Number.isFinite(ms) &&
        (payload.type?.endsWith('_tool_call_end') ||
          payload.type?.endsWith('_command_end') ||
          payload.type?.endsWith('_apply_end') ||
          payload.type === 'function_call_output')
      ) {
        setPendingModelStart(ms, payload.type);
      } else if (row.type === 'response_item' && Number.isFinite(ms)) {
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
      } else if (row.type === 'event_msg' && payload.type === 'token_count') {
        tokenEvents++;
        session.token_events++;
        if (!Number.isFinite(ms)) continue;
        const resetModelCall = () => {
          const keepPendingForNext =
            pendingModelStartMs != null && activeModelCall?.first_output_ms != null && pendingModelStartMs > activeModelCall.first_output_ms;
          if (!keepPendingForNext) setPendingModelStart(ms, 'previous_token_count');
          activeModelCall = null;
        };
        if (ms < options.start || ms > options.end) {
          resetModelCall();
          continue;
        }
        const usage = normalizeUsage(payload.info?.last_token_usage || {});
        if (usage.total_tokens <= 0) {
          resetModelCall();
          continue;
        }
        if (isSystemUsageWithoutBreakdown(usage)) {
          excludedSystemEvents++;
          resetModelCall();
          continue;
        }
        const totalUsage = normalizeUsage(payload.info?.total_token_usage || {});
        const totalUsageSnapshot = totalUsage.total_tokens > 0 ? totalUsage : null;
        const key = dedupeKey(session.id, usage, totalUsageSnapshot);
        if (options.dedupe && seen.has(key)) {
          duplicateEvents++;
          continue;
        }
        seen.add(key);
        ordinal++;
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
          streamObserved = true;
          streamObservedBasis = 'multiple_response_items_before_token_count';
        } else if (responseItemCount === 1) {
          streamObserved = false;
          streamObservedBasis = 'single_response_item_before_token_count';
        }
        const record = {
          record_id: `session-token-${session.id}-${ms}-${ordinal}`,
          timestamp: row.timestamp || null,
          local_time: new Date(ms).toLocaleString(),
          ms,
          session_id: session.id,
          session_file: file,
          cwd: session.cwd,
          source: session.source,
          thread_source: session.thread_source,
          originator: session.originator,
          model_provider: session.model_provider,
          cli_version: session.cli_version,
          model: currentModel || session.model || '',
          effort: currentEffort || session.effort || '',
          status: 'recorded',
          usage,
          total_usage_snapshot: totalUsageSnapshot,
          model_context_window: payload.info?.model_context_window ?? null,
          turn_id: currentTurn?.id || null,
          turn_sequence: currentTurn?.sequence ?? null,
          turn_started_at: currentTurn?.started_at || null,
          turn_started_ms: currentTurn?.started_ms ?? null,
          turn_elapsed_ms_estimate: currentTurn ? Math.max(0, ms - currentTurn.started_ms) : null,
          request_started_ms_estimate: requestStartMs,
          request_duration_ms_estimate: requestDurationMs,
          request_duration_basis: requestDurationBasis,
          first_output_ms_estimate: firstOutputDurationMs,
          first_output_event_ms: firstOutputMs,
          first_output_event_type: activeModelCall?.first_output_type || null,
          first_output_basis: firstOutputBasis,
          response_item_count: responseItemCount,
          stream_observed: streamObserved,
          stream_observed_basis: streamObservedBasis,
          turn_completed_at: null,
          turn_completed_ms: null,
          turn_duration_ms_estimate: null,
          duration_basis: requestDurationBasis,
          duplicate_key: key
        };
        records.push(record);
        session.records++;
        if (currentTurn) {
          const turnRecords = recordsByTurn.get(currentTurn.id) || [];
          turnRecords.push(record);
          recordsByTurn.set(currentTurn.id, turnRecords);
        }
        resetModelCall();
      }
    }
    sessions.set(session.id, session);
  }

  records.sort((a, b) => b.ms - a.ms);
  return {
    records,
    sessions: [...sessions.values()].sort((a, b) => b.end_ms - a.end_ms),
    diagnostics: {
      codex_home: options.codexHome,
      sessions_dir: sessionsDir,
      session_files: files.length,
      scanned_files: scannedFiles,
      scanned_lines: scannedLines,
      malformed_lines: malformedLines,
      token_count_events: tokenEvents,
      excluded_system_token_count_events: excludedSystemEvents,
      duplicate_events: duplicateEvents,
      dedupe_strategy: options.dedupe
        ? 'session_id + last_token_usage_tuple + total_token_usage_snapshot_tuple'
        : 'disabled',
      dedupe: options.dedupe
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
  if (width === 'hour') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function summarize(scan, options) {
  const usage = scan.records.reduce((sum, record) => addUsage(sum, record.usage), emptyUsage());
  const elapsed = scan.records.map((r) => r.request_duration_ms_estimate).filter((n) => Number.isFinite(n) && n > 0);
  const firstOutput = scan.records.map((r) => r.first_output_ms_estimate).filter((n) => Number.isFinite(n) && n >= 0);
  const turnDuration = scan.records.map((r) => r.turn_duration_ms_estimate).filter((n) => Number.isFinite(n) && n > 0);
  const streamKnownRecords = scan.records.filter((r) => Number.isFinite(r.response_item_count) && r.response_item_count > 0).length;
  const streamObservedRecords = scan.records.filter((r) => r.stream_observed === true).length;
  const byModel = groupBy(scan.records, (r) => r.model || 'unknown');
  const byOriginator = groupBy(scan.records, (r) => r.originator || 'unknown');
  const buckets = summarizeBuckets(scan.records, options.bucket);
  const totalRecords = scan.records.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / options.pageSize));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const offset = (page - 1) * options.pageSize;
  const pageRecords = scan.records.slice(offset, offset + options.pageSize);

  const report = {
    generated_at: new Date().toISOString(),
    version: VERSION,
    range: {
      start_ms: options.start,
      end_ms: options.end,
      start: options.start ? new Date(options.start).toISOString() : null,
      end: new Date(options.end).toISOString()
    },
    data_quality: {
      primary_records: 'codex_session_token_count_events',
      token_usage: 'codex_session_last_token_usage',
      context_fields: 'codex_session_meta_and_turn_context',
      duration_ms_estimate: 'local_observed_model_request_start_to_token_count',
      first_output_ms_estimate: 'local_observed_model_request_start_to_first_response_item',
      stream_observed: 'local_response_item_count_before_token_count_not_official_stream_flag',
      turn_duration_ms_estimate: 'local_session_task_started_to_task_complete',
      excluded_system_records: 'breakdownless_token_count_events_from_compaction_abort_or_rollback',
      excluded_sources: ['logs_2.sqlite', 'raw_sse', 'codex_otel']
    },
    diagnostics: scan.diagnostics,
    summary: {
      records: scan.records.length,
      sessions: scan.sessions.length,
      usage,
      average_request_duration_ms_estimate: average(elapsed),
      average_turn_elapsed_ms_estimate: average(elapsed),
      average_first_output_ms_estimate: average(firstOutput),
      average_turn_duration_ms_estimate: average(turnDuration),
      stream_known_records: streamKnownRecords,
      stream_observed_records: streamObservedRecords,
      models: byModel,
      originators: byOriginator,
      workspaces: groupBy(scan.records, (r) => r.cwd || 'unknown')
    },
    buckets,
    pagination: {
      page,
      page_size: options.pageSize,
      total_records: totalRecords,
      total_pages: totalPages
    },
    records: pageRecords
  };

  if (options.redactPaths) redactReportPaths(report);
  return report;
}

function redactReportPaths(report) {
  report.diagnostics.codex_home = '[redacted-path]';
  report.diagnostics.sessions_dir = '[redacted-path]';
  for (const session of report.summary.workspaces || []) {
    session.key = redactLocalPath(session.key);
  }
  for (const record of report.records || []) {
    record.cwd = redactLocalPath(record.cwd);
    record.session_file = redactLocalPath(record.session_file);
  }
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function groupBy(records, getKey) {
  const map = new Map();
  for (const record of records) {
    const key = getKey(record);
    const item = map.get(key) || { key, records: 0, usage: emptyUsage() };
    item.records++;
    item.usage = addUsage(item.usage, record.usage);
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.usage.total_tokens - a.usage.total_tokens);
}

function summarizeBuckets(records, width) {
  if (width === 'none') return [];
  const map = new Map();
  for (const record of records) {
    const key = bucketStart(record.ms, width);
    const item = map.get(key) || { ts: key, label: bucketLabel(key, width), records: 0, usage: emptyUsage() };
    item.records++;
    item.usage = addUsage(item.usage, record.usage);
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function formatCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return '-';
  const value = Number(n);
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '-';
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

function renderTable(report) {
  const lines = [];
  lines.push(`Codex token report ${report.range.start || 'beginning'} -> ${report.range.end}`);
  lines.push(`Records: ${report.summary.records} | Sessions: ${report.summary.sessions} | Total: ${formatCompact(report.summary.usage.total_tokens)} | Input: ${formatCompact(report.summary.usage.input_tokens)} | Cached: ${formatCompact(report.summary.usage.cached_input_tokens)} | Output: ${formatCompact(report.summary.usage.output_tokens)} | Reasoning: ${formatCompact(report.summary.usage.reasoning_output_tokens)}`);
  lines.push(`Avg response: ${formatMs(report.summary.average_request_duration_ms_estimate)} | Avg first output: ${formatMs(report.summary.average_first_output_ms_estimate)} | Scanned files: ${report.diagnostics.scanned_files}/${report.diagnostics.session_files} | Duplicates skipped: ${report.diagnostics.duplicate_events}`);
  lines.push(`Segmented output observed: ${report.summary.stream_observed_records}/${report.summary.stream_known_records} records | basis: response_item_count before token_count`);
  lines.push('');
  if (report.buckets.length) {
    lines.push('Buckets:');
    lines.push('label                 records  total     input     cached    output    reasoning');
    for (const b of report.buckets) {
      lines.push(`${padRight(b.label, 21)} ${padLeft(b.records, 7)} ${padLeft(formatCompact(b.usage.total_tokens), 8)} ${padLeft(formatCompact(b.usage.input_tokens), 9)} ${padLeft(formatCompact(b.usage.cached_input_tokens), 9)} ${padLeft(formatCompact(b.usage.output_tokens), 9)} ${padLeft(formatCompact(b.usage.reasoning_output_tokens), 10)}`);
    }
    lines.push('');
  }
  lines.push(`Records page ${report.pagination.page}/${report.pagination.total_pages}:`);
  lines.push('time                 total     input     cached    output    first    elapsed  stream  model       source/cwd');
  for (const r of report.records) {
    const source = [r.originator, r.model_provider, r.cwd].filter(Boolean).join(' / ');
    const stream = r.stream_observed === true ? 'seg' : r.response_item_count === 1 ? 'single' : '-';
    lines.push(`${padRight(r.local_time, 20)} ${padLeft(formatCompact(r.usage.total_tokens), 8)} ${padLeft(formatCompact(r.usage.input_tokens), 9)} ${padLeft(formatCompact(r.usage.cached_input_tokens), 9)} ${padLeft(formatCompact(r.usage.output_tokens), 9)} ${padLeft(formatMs(r.first_output_ms_estimate), 8)} ${padLeft(formatMs(r.request_duration_ms_estimate), 8)} ${padRight(stream, 7)} ${padRight(r.model || '-', 11)} ${source}`);
  }
  return lines.join('\n');
}

function padRight(value, width) {
  const text = String(value);
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value);
  return text.length >= width ? text.slice(0, width) : ' '.repeat(width - text.length) + text;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function renderCsv(report) {
  const headers = [
    'record_id',
    'timestamp',
    'local_time',
    'session_id',
    'cwd',
    'source',
    'thread_source',
    'originator',
    'model_provider',
    'cli_version',
    'model',
    'effort',
    'status',
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
    'total_tokens_snapshot',
    'model_context_window',
    'turn_sequence',
    'turn_started_at',
    'turn_completed_at',
    'turn_elapsed_ms_estimate',
    'request_started_ms_estimate',
    'request_duration_ms_estimate',
    'request_duration_basis',
    'first_output_ms_estimate',
    'first_output_event_ms',
    'first_output_event_type',
    'first_output_basis',
    'response_item_count',
    'stream_observed',
    'stream_observed_basis',
    'turn_duration_ms_estimate',
    'duration_basis',
    'session_file'
  ];
  const rows = [headers.join(',')];
  for (const r of report.records) {
    rows.push(headers.map((h) => csvEscape(csvValue(r, h))).join(','));
  }
  return rows.join('\n');
}

function csvValue(record, key) {
  if (key === 'input_tokens') return record.usage.input_tokens;
  if (key === 'cached_input_tokens') return record.usage.cached_input_tokens;
  if (key === 'output_tokens') return record.usage.output_tokens;
  if (key === 'reasoning_output_tokens') return record.usage.reasoning_output_tokens;
  if (key === 'total_tokens') return record.usage.total_tokens;
  if (key === 'total_tokens_snapshot') return record.total_usage_snapshot?.total_tokens ?? '';
  return record[key] ?? '';
}

function writeOutput(text, outFile) {
  if (outFile) fs.writeFileSync(outFile, text, 'utf8');
  else process.stdout.write(`${text}\n`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      writeOutput(usageText().trim(), options.out);
      return;
    }
    const scan = scanSessions(options);
    const report = summarize(scan, options);
    let text;
    if (options.format === 'json') text = JSON.stringify(report, null, 2);
    else if (options.format === 'csv') text = renderCsv(report);
    else text = renderTable(report);
    writeOutput(text, options.out);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n\n${usageText()}`);
    process.exitCode = 1;
  }
}

main();
