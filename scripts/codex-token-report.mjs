#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import parser from '../lib/session-parser.js';

const VERSION = '0.5.0';

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

const {parseSessionFile,walkFiles,normalizeUsage,addUsage,emptyUsage} = parser;
function redactLocalPath(value) { return value ? '[redacted-path]' : value; }
function scanSessions(options) {
  const dirs=['sessions','archived_sessions'].map(dir=>path.join(options.codexHome,dir));
  const files=dirs.flatMap(dir=>walkFiles(dir,f=>f.endsWith('.jsonl'))), records=[],seen=new Set(),sessions=new Map();
  let scannedFiles=0,scannedLines=0,malformedLines=0,tokenEvents=0,duplicateEvents=0,excludedSystemEvents=0;
  for (const file of files) {
    let parsed;
    try { parsed=parseSessionFile(file,fs.statSync(file)); } catch { continue; }
    scannedFiles++;scannedLines+=parsed.diagnostics.scanned_lines;malformedLines+=parsed.diagnostics.malformed_lines;
    tokenEvents+=parsed.diagnostics.token_events;excludedSystemEvents+=parsed.diagnostics.excluded_system_events;
    // Match dashboard atomic ingestion: a corrupt source does not publish partial records.
    if (parsed.diagnostics.malformed_lines) continue;
    for (const row of parsed.records) {
      if (row.ms<options.start || row.ms>=options.end) continue;
      if (options.dedupe && seen.has(row.dedupe_key)) {duplicateEvents++;continue;}
      seen.add(row.dedupe_key);
      const usage=normalizeUsage(row);
      const record={...row,usage,local_time:new Date(row.ms).toLocaleString(),
        total_usage_snapshot:row.total_tokens_snapshot == null ? null : {
          input_tokens:row.total_input_tokens_snapshot,cached_input_tokens:row.total_cached_input_tokens_snapshot,
          cache_write_input_tokens:row.total_cache_write_input_tokens_snapshot,output_tokens:row.total_output_tokens_snapshot,
          reasoning_output_tokens:row.total_reasoning_output_tokens_snapshot,total_tokens:row.total_tokens_snapshot},
        stream_observed:row.stream_observed == null ? null : Boolean(row.stream_observed)};
      records.push(record);sessions.set(row.session_id,parsed.session);
    }
  }
  records.sort((a,b)=>b.ms-a.ms || b.record_id.localeCompare(a.record_id));
  return {records,sessions:[...sessions.values()],diagnostics:{codex_home:options.codexHome,sessions_dir:dirs[0],archived_sessions_dir:dirs[1],
    session_files:files.length,scanned_files:scannedFiles,scanned_lines:scannedLines,malformed_lines:malformedLines,token_count_events:tokenEvents,
    excluded_system_token_count_events:excludedSystemEvents,duplicate_events:duplicateEvents,dedupe_strategy:'response_id_then_legacy_counter_or_event',dedupe:options.dedupe}};
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
      primary_records: 'response_usage_with_legacy_fallback',
      token_usage: 'codex_session_last_token_usage',
      context_fields: 'codex_session_meta_and_turn_context',
      duration_ms_estimate: 'local_model_output_boundaries_excluding_tool_wait',
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
  report.diagnostics.archived_sessions_dir = '[redacted-path]';
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
