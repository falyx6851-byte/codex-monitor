'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { estimateCost, extractServiceTier, parseSessionFile } = require('../server');

test('extracts the current thread_settings service tier path', () => {
  assert.deepEqual(
    extractServiceTier({ thread_settings: { service_tier: 'priority' } }),
    { tier: 'priority', source: 'payload.thread_settings.service_tier' }
  );
});

test('prices GPT-5.6 Sol priority requests with official rates', () => {
  const cost = estimateCost({
    input_tokens: 100_000,
    cached_input_tokens: 50_000,
    cache_write_input_tokens: 10_000,
    output_tokens: 10_000
  }, 'gpt-5.6-sol', 'priority');

  assert.equal(cost.tier, 'priority');
  assert.equal(cost.service_tier, 'priority');
  assert.ok(Math.abs(cost.amount_usd - 1.175) < 1e-12);
  assert.deepEqual(cost.rates_per_1m, {
    input: 10,
    cached_input: 1,
    cache_write_input: 12.5,
    output: 60
  });
});

test('carries thread settings to following token_count records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-test-'));
  const file = path.join(dir, 'rollout-test-session.jsonl');
  const rows = [
    { timestamp: '2026-07-12T00:00:00.000Z', type: 'session_meta', payload: { id: 'test-session' } },
    { timestamp: '2026-07-12T00:00:01.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } },
    { timestamp: '2026-07-12T00:00:02.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { timestamp: '2026-07-12T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, total_tokens: 1100 } } } }
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));

  try {
    const parsed = parseSessionFile(file, fs.statSync(file));
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].service_tier, 'priority');
    assert.equal(parsed.records[0].service_tier_source, 'event_msg.payload.thread_settings.service_tier');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
