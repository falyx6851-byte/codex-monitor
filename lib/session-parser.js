'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {StringDecoder} = require('node:string_decoder');
const SESSION_PARSER_VERSION = 4;
const MAX_DURATION_MS = 10 * 60 * 1000;

function walkFiles(dir, predicate, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, predicate, out);
    else if (entry.isFile() && predicate(file)) out.push(file);
  }
  return out;
}
function* sessionLines(file) {
  const fd = fs.openSync(file, 'r'), decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  let pending = '';
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, size));
      let start = 0, end;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        yield pending.slice(start, end).replace(/\r$/, '');
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.end();
    if (pending) yield pending.replace(/\r$/, '');
  } finally { fs.closeSync(fd); }
}
function finiteOrZero(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function optionalFinite(value) { return value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
function normalizeUsage(u = {}) {
  const input = finiteOrZero(u.input_tokens), output = finiteOrZero(u.output_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: finiteOrZero(u.cached_input_tokens ?? u.input_tokens_details?.cached_tokens),
    cache_write_input_tokens: optionalFinite(u.cache_write_input_tokens ?? u.cache_write_tokens ?? u.input_tokens_details?.cache_write_tokens),
    output_tokens: output,
    reasoning_output_tokens: finiteOrZero(u.reasoning_output_tokens ?? u.output_tokens_details?.reasoning_tokens),
    total_tokens: u.total_tokens == null ? input + output : finiteOrZero(u.total_tokens)
  };
}
function emptyUsage() { return {...normalizeUsage(), cache_write_input_tokens: 0}; }
function addUsage(a, b) {
  const result = {};
  for (const key of Object.keys(emptyUsage())) {
    result[key] = key === 'cache_write_input_tokens' && (a[key] == null || b[key] == null)
      ? null : finiteOrZero(a[key]) + finiteOrZero(b[key]);
  }
  return result;
}
function usageTuple(u) { return Object.keys(emptyUsage()).map(k => u?.[k] == null ? '?' : u[k]).join('/'); }
function isPartialUsageWithoutBreakdown(u) { return u.total_tokens > 0 && !u.input_tokens && !u.cached_input_tokens && !u.output_tokens; }
function normalizeServiceTier(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function extractServiceTier(p) {
  if (!p || typeof p !== 'object') return null;
  for (const [key, obj] of [['thread_settings',p.thread_settings],['',p],['info',p.info],['request',p.request],['response',p.response]]) {
    for (const field of ['service_tier', 'serviceTier']) {
      const tier = normalizeServiceTier(obj?.[field]);
      if (tier) return {tier, source: `payload.${key ? key + '.' : ''}${field}`};
    }
  }
  return null;
}
function normalizeRecordStatus(status, reason) { return reason || ['error','failed'].includes(String(status).toLowerCase()) ? 'failed' : 'success'; }
function timestampMs(value) { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSessionId(file) { return path.basename(file).match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i)?.[1] || path.basename(file, '.jsonl'); }

function parseSessionFile(file, stat) {
  const session = {id:fileSessionId(file),file,cwd:'',source:'',thread_source:'',originator:'',model_provider:'',cli_version:'',model:'',start_ms:null,end_ms:null};
  const diagnostics = {scanned_lines:0,malformed_lines:0,token_events:0,parsed_records:0,excluded_system_events:0,inherited_records:0};
  const records = [], seen = new Set();
  let header = null, createdMs = null, boundary = 0, model = '', effort = '', tier = '', tierSource = '';
  let turn = null, turnSequence = 0, active = null, pendingMs = null, pendingBasis = null, latestLedger = null;
  const pending = (ms, basis) => { if (ms != null) { pendingMs = ms; pendingBasis = basis; } };
  const finalize = (row, usage, snapshot, responseId, terminal, reason) => {
    const eventMs = timestampMs(row.timestamp);
    if (eventMs == null) return null;
    const endMs = terminal === 'session.token_count' ? active?.last_output_ms ?? eventMs : eventMs;
    const startMs = active?.start_ms ?? pendingMs;
    const firstMs = active?.first_output_ms ?? null;
    const duration = startMs != null && active ? Math.max(0, endMs - startMs) : null;
    const validDuration = duration != null && duration <= MAX_DURATION_MS;
    const basis = validDuration ? `${active.basis}_to_${terminal === 'session.token_count' ? 'last_model_output' : terminal.split('.').at(-1)}`
      : duration != null ? 'stale_local_boundary_excluded' : 'model_output_boundary_unavailable';
    const dedupeKey = responseId ? `response:${responseId}` : reason ? `${session.id}|error=${eventMs}|${hash(reason)}`
      : `${session.id}|last=${usageTuple(usage)}|${snapshot ? 'total=' + usageTuple(snapshot) : 'event=' + eventMs}`;
    // Replayed counters and inherited archive copies must not become requests.
    if (seen.has(dedupeKey)) return null;
    seen.add(dedupeKey);
    const r = {
      record_id:`session-token-${hash(dedupeKey)}`,dedupe_key:dedupeKey,terminal_event_type:terminal,
      ms:endMs,timestamp:new Date(endMs).toISOString(),session_id:session.id,session_file:file,
      cwd:session.cwd,source:session.source,thread_source:session.thread_source,originator:session.originator,
      model_provider:session.model_provider,cli_version:session.cli_version,model:model || session.model,effort,
      service_tier:tier,service_tier_source:tierSource,status:reason ? 'failed' : 'success',error_reason:reason || null,
      ...usage,
      total_input_tokens_snapshot:snapshot?.input_tokens ?? null,
      total_cached_input_tokens_snapshot:snapshot?.cached_input_tokens ?? null,
      total_cache_write_input_tokens_snapshot:snapshot?.cache_write_input_tokens ?? null,
      total_output_tokens_snapshot:snapshot?.output_tokens ?? null,
      total_reasoning_output_tokens_snapshot:snapshot?.reasoning_output_tokens ?? null,
      total_tokens_snapshot:snapshot?.total_tokens ?? null,
      model_context_window:row.payload?.info?.model_context_window ?? turn?.contextWindow ?? null,
      turn_id:turn?.id ?? null,turn_sequence:turn?.sequence ?? null,turn_started_ms:turn?.started_ms ?? null,
      turn_elapsed_ms_estimate:turn ? Math.max(0,endMs-turn.started_ms) : null,
      request_started_ms_estimate:startMs,request_duration_ms_estimate:validDuration ? duration : null,
      request_duration_basis:basis,first_output_ms_estimate:validDuration && firstMs != null ? Math.max(0,firstMs-startMs) : null,
      first_output_event_ms:firstMs,first_output_event_type:active?.first_output_type ?? null,
      first_output_basis:validDuration && firstMs != null ? `${active.basis}_to_first_model_output` : null,
      turn_completed_ms:null,turn_duration_ms_estimate:null,response_item_count:active?.count ?? 0,
      stream_observed:active ? Number(active.count>1) : null,stream_observed_basis:'local_model_output_items',inserted_at_ms:Date.now()
    };
    records.push(r); if (turn) turn.records.push(r);
    const nextPending = pendingMs != null && active && pendingMs > active.last_output_ms;
    active = null;
    if (!nextPending) pending(endMs, 'previous_model_response');
    return r;
  };
  for (const line of sessionLines(file)) {
    if (!line) continue;
    diagnostics.scanned_lines++;
    let row;
    try { row = JSON.parse(line); } catch { diagnostics.malformed_lines++; continue; }
    const p = row.payload || {}, ms = timestampMs(row.timestamp);
    if (row.type === 'session_meta') {
      if (!header) {
        header = p; createdMs = ms;
        boundary = Number.isInteger(p.subagent_history_start_ordinal) ? p.subagent_history_start_ordinal : 0;
        Object.assign(session, {id:p.id || p.thread_id || session.id,cwd:p.cwd || '',
          source:typeof p.source === 'string' ? p.source : JSON.stringify(p.source || ''),thread_source:p.thread_source || '',
          originator:p.originator || '',model_provider:p.model_provider || '',cli_version:p.cli_version || ''});
      }
      continue; // The first header identifies this file; later headers are inherited history.
    }
    const parent = header?.forked_from_id || header?.parent_thread_id || header?.source?.subagent?.thread_spawn?.parent_thread_id;
    const inherited = diagnostics.scanned_lines <= boundary || (parent && !boundary && ms != null && createdMs != null && ms < createdMs)
      || (p.thread_id && p.thread_id !== session.id);
    if (inherited) {
      if (p.type === 'token_count' || row.type === 'token_usage_record') diagnostics.inherited_records++;
      continue;
    }
    if (ms != null) { session.start_ms = session.start_ms == null ? ms : Math.min(ms,session.start_ms); session.end_ms = Math.max(ms,session.end_ms ?? ms); }
    const tierEvidence = extractServiceTier(p);
    if (tierEvidence) { tier = tierEvidence.tier; tierSource = `${row.type}.${tierEvidence.source}`; }
    if (row.type === 'turn_context') {
      model = p.model || model; effort = p.effort || effort; session.model = model;
      if (turn) turn.contextWindow = p.model_context_window ?? null;
    } else if (row.type === 'event_msg' && p.type === 'task_started') {
      turn = {id:p.turn_id || `${session.id}:turn:${++turnSequence}`,sequence:turnSequence,started_ms:ms,records:[]};
      if (p.turn_id) turn.sequence = ++turnSequence;
      active = null; latestLedger = null; pending(ms,'task_started');
    } else if (row.type === 'event_msg' && ['task_complete','turn_aborted'].includes(p.type)) {
      if (turn && ms != null) for (const r of turn.records) { r.turn_completed_ms=ms; r.turn_duration_ms_estimate=Math.max(0,ms-turn.started_ms); }
      turn=null; active=null;
    } else if (row.type === 'event_msg' && p.type === 'user_message') {
      pending(ms,'user_message');
    } else if ((row.type === 'response_item' && ['function_call_output','custom_tool_call_output'].includes(p.type))
      || (row.type === 'event_msg' && /(_tool_call_end|_command_end|_apply_end)$/.test(p.type || ''))) {
      pending(ms,'tool_output');
    } else if (row.type === 'response_item' && ms != null && p.type !== 'agent_message' && !(p.type === 'message' && p.role && p.role !== 'assistant')) {
      if (!active) active={start_ms:pendingMs, basis:pendingBasis || 'unknown',first_output_ms:ms,first_output_type:p.type,count:0};
      active.last_output_ms=ms; active.count++;
    } else if (row.type === 'token_usage_record') {
      const usage=normalizeUsage(p.usage), total=normalizeUsage(p.thread_token_usage || p.total_token_usage);
      if (usage.total_tokens<=0 || isPartialUsageWithoutBreakdown(usage)) { diagnostics.excluded_system_events++; continue; }
      finalize(row,usage,total.total_tokens>0 ? total : null,p.response_id,'session.token_usage_record');
      latestLedger=usage;
    } else if (row.type === 'event_msg' && p.type === 'token_count') {
      diagnostics.token_events++;
      const usage=normalizeUsage(p.info?.last_token_usage), total=normalizeUsage(p.info?.total_token_usage);
      if (usage.total_tokens<=0 || isPartialUsageWithoutBreakdown(usage)) { diagnostics.excluded_system_events++; continue; }
      const mirrorsLedger = latestLedger && !active && ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
        .every(key=>latestLedger[key]===usage[key]) && (latestLedger.cache_write_input_tokens==null || usage.cache_write_input_tokens==null || latestLedger.cache_write_input_tokens===usage.cache_write_input_tokens);
      if (mirrorsLedger) continue; // UI counters may omit cache-write detail present in response usage.
      finalize(row,usage,total.total_tokens>0 ? total : null,null,'session.token_count');
    } else if (row.type === 'event_msg' && p.type === 'error') {
      finalize(row,emptyUsage(),null,null,'session.error',p.message || JSON.stringify(p.codex_error_info || p));
    }
  }
  diagnostics.parsed_records=records.length;
  return {session,records,diagnostics};
}

module.exports={SESSION_PARSER_VERSION,parseSessionFile,walkFiles,sessionLines,normalizeUsage,addUsage,emptyUsage,
  finiteOrZero,optionalFinite,isPartialUsageWithoutBreakdown,normalizeServiceTier,extractServiceTier,normalizeRecordStatus,timestampMs};
