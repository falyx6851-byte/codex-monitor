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
  assert.ok(Math.abs(cost.amount_usd - 0.86) < 1e-12);
  assert.deepEqual(cost.rates_per_1m, {
    input: 8,
    cached_input: 0.8,
    cache_write_input: 10,
    output: 40
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

const astraUsage = {
  input_tokens: 100_000, cached_input_tokens: 50_000,
  cache_write_input_tokens: 10_000, output_tokens: 10_000
};

for (const [tier, amount, label] of [
  ['default', 1.075, 'standard'], ['fast', 2.15, 'priority'],
  ['priority', 2.15, 'priority'], ['flex', 0.5375, 'flex']
]) {
  test(`GPT-6 Astra ${tier} splits regular input, cache reads, cache writes and output`, () => {
    const cost = estimateCost(astraUsage, 'gpt-6-astra', tier);
    assert.equal(cost.model_key, 'gpt-6-astra');
    assert.equal(cost.tier, label);
    assert.equal(cost.complete, true);
    assert.ok(Math.abs(cost.amount_usd - amount) < 1e-12);
    assert.equal(cost.input_tokens_billed_at_input_rate, 40_000);
    assert.equal(cost.updated_at, '2026-09-07');
  });
}

for (const [tier, amount, label] of [
  ['default', 5.9, 'standard_long_context'],
  ['fast', 11.8, 'priority_long_context'],
  ['priority', 11.8, 'priority_long_context'],
  ['flex', 2.95, 'flex_long_context']
]) {
  test(`GPT-6 Astra ${tier} prices the entire long-context request`, () => {
    const cost = estimateCost({...astraUsage, input_tokens: 300_000}, 'gpt-6-astra', tier);
    assert.equal(cost.tier, label);
    assert.ok(Math.abs(cost.amount_usd - amount) < 1e-12);
  });
}

test('272K input boundary includes cache reads and writes, but excludes output', () => {
  for (const [input, label] of [[272_000, 'priority'], [272_001, 'priority_long_context']]) {
    const cost = estimateCost({input_tokens: input, cached_input_tokens: 200_000,
      cache_write_input_tokens: 50_000, output_tokens: 100_000}, 'gpt-6-astra', 'fast');
    assert.equal(cost.tier, label);
  }
});

test('GPT-6 missing cache writes stays a lower bound and explicit zero is complete', () => {
  const usage = {...astraUsage};
  delete usage.cache_write_input_tokens;
  const missing = estimateCost(usage, 'gpt-6-astra', 'default');
  assert.equal(missing.is_lower_bound, true);
  assert.equal(missing.complete, false);
  assert.equal(missing.components_usd.cache_write_input, null);
  assert.equal(missing.amount_usd, 1.05);
  assert.equal(estimateCost({...usage, cache_write_input_tokens: 0}, 'gpt-6-astra', 'default').complete, true);
});

test('known effort decorations and case resolve without guessing unknown GPT-6 variants', () => {
  for (const model of ['gpt-6-astra', ' GPT-6-ASTRA ', 'gpt-6-astra(max)', 'gpt-6-astra-xhigh', 'gpt-6-astra(ultra)']) {
    assert.equal(estimateCost(astraUsage, model, 'default').model_key, 'gpt-6-astra');
  }
  for (const model of ['gpt-6', 'gpt-6-astra-pro', 'gpt-6-mini', 'gpt-6-astra-unknown']) {
    assert.equal(estimateCost(astraUsage, model, 'default').known, false);
  }
  assert.equal(estimateCost(astraUsage, 'gpt-5.6', 'default').model_key, 'gpt-5.6-sol');
  assert.equal(estimateCost(astraUsage, 'gpt-5.4(xhigh)', 'default').model_key, 'gpt-5.4');
});

test('unsupported service tiers and legacy Fast long context remain unpriced', () => {
  for (const [model, tier, input, reason] of [
    ['gpt-6-astra', 'ultrafast', 100_000, 'missing_ultrafast_pricing'],
    ['gpt-6-astra', 'input_per_1m', 100_000, 'missing_input_per_1m_pricing'],
    ['gpt-5.3-codex', 'flex', 100_000, 'missing_flex_pricing'],
    ['gpt-5.5', 'fast', 300_000, 'priority_long_context_pricing_unavailable']
  ]) {
    const cost = estimateCost({...astraUsage, input_tokens: input}, model, tier);
    assert.equal(cost.amount_usd, null);
    assert.equal(cost.known, false);
    assert.equal(cost.reason, reason);
  }
});

for (const [model, amounts] of [
  ['gpt-5.6-sol', [0.43, 2.36]],
  ['gpt-5.6-terra', [0.235, 1.21]],
  ['gpt-5.6-luna', [0.0235, 0.121]]
]) {
  test(`${model} uses refreshed Standard, Fast and Flex prices`, () => {
    for (const [tier, factor] of [['default', 1], ['fast', 2], ['flex', 0.5]]) {
      for (const [input, expected] of [[100_000, amounts[0]], [300_000, amounts[1]]]) {
        const cost = estimateCost({...astraUsage, input_tokens: input}, model, tier);
        assert.ok(Math.abs(cost.amount_usd - expected * factor) < 1e-12);
      }
    }
  });
}

test('session parser preserves GPT-6 model switches and Fast tier for pricing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-test-'));
  const file = path.join(dir, 'rollout-gpt6.jsonl');
  const rows = [
    {type: 'session_meta', payload: {id: 'gpt6-test'}},
    {type: 'turn_context', payload: {model: 'gpt-5.6-sol', service_tier: 'default'}},
    {type: 'event_msg', payload: {type: 'token_count', info: {last_token_usage: {...astraUsage, total_tokens: 110_000}}}},
    {type: 'turn_context', payload: {model: 'gpt-6-astra', service_tier: 'fast'}},
    {type: 'event_msg', payload: {type: 'token_count', info: {last_token_usage: {...astraUsage, output_tokens: 20_000, total_tokens: 120_000}}}}
  ].map((row, i) => ({timestamp: new Date(Date.UTC(2026, 8, 7, 0, 0, i)).toISOString(), ...row}));
  try {
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const {records} = parseSessionFile(file, fs.statSync(file));
    assert.equal(records.length, 2);
    assert.equal(records[0].model, 'gpt-5.6-sol');
    assert.equal(records[1].model, 'gpt-6-astra');
    assert.equal(records[1].service_tier, 'fast');
    const record = records[1];
    const cost = estimateCost(record, record.model, record.service_tier);
    assert.ok(Math.abs(cost.amount_usd - 3.15) < 1e-12);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
