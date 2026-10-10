'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-test-'));
process.env.CODEX_HOME = path.join(root, 'home');
process.env.CODEX_TOKEN_MONITOR_DATA_DIR = path.join(root, 'data');
const {estimateCost, parseSessionFile, ingestChangedSessionFiles, refreshStoredPricing,
  buildData, db} = require('../server');
test.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}); });

const usage = {input_tokens: 100_000, cached_input_tokens: 50_000,
  cache_write_input_tokens: 10_000, output_tokens: 10_000};
const closeTo = (actual, expected) => assert.ok(typeof actual === 'number'
  && Math.abs(actual - expected) < 1e-12, `expected ${expected}, received ${actual}`);

// Independent totals from the official 2026-10-10 pricing snapshot; includes
// regular input, cache reads, cache writes and output in a single request.
for (const [model, short, long] of [
  ['gpt-6.1-sol', 0.21, 1.17],
  ['gpt-6-sol', 0.215, 1.18],
  ['gpt-6-luna', 0.01075, 0.059]
]) {
  test(`${model} prices Standard, Fast and Flex at both context lengths`, () => {
    for (const [tier, factor] of [['default', 1], ['fast', 2], ['priority', 2], ['flex', 0.5]]) {
      for (const [input, expected] of [[100_000, short], [300_000, long]]) {
        const cost = estimateCost({...usage, input_tokens: input}, model, tier);
        assert.equal(cost.known, true);
        assert.equal(cost.complete, true);
        assert.equal(cost.model_key, model);
        closeTo(cost.amount_usd, expected * factor);
      }
    }
  });
}

test('Ultrafast uses 6x Standard for GPT-6.1 Sol and Astra, including long context', () => {
  for (const [model, short, long] of [['gpt-6.1-sol', 1.26, 7.02], ['gpt-6-astra', 6.45, 35.4]]) {
    for (const [input, expected, tier] of [[100_000, short, 'ultrafast'], [300_000, long, 'ultrafast_long_context']]) {
      const cost = estimateCost({...usage, input_tokens: input}, model, 'ultrafast');
      assert.equal(cost.complete, true);
      assert.equal(cost.tier, tier);
      closeTo(cost.amount_usd, expected);
    }
  }
});

test('GPT-6.1 Sol has its own cache rate and uses the strict 272K input threshold', () => {
  for (const [input, tier, cachedRate] of [[272_000, 'ultrafast', 0.6], [272_001, 'ultrafast_long_context', 1.2]]) {
    const cost = estimateCost({...usage, input_tokens: input, output_tokens: 128_000}, 'gpt-6.1-sol', 'ultrafast');
    assert.equal(cost.tier, tier);
    assert.equal(cost.rates_per_1m.cached_input, cachedRate);
  }
  assert.equal(estimateCost(usage, 'gpt-6.1-sol', 'default').rates_per_1m.cached_input, 0.1);
  assert.equal(estimateCost(usage, 'gpt-6-sol', 'default').rates_per_1m.cached_input, 0.2);
});

test('new models preserve uncertainty for missing cache writes and unknown service tiers', () => {
  const withoutWrites = {...usage};
  delete withoutWrites.cache_write_input_tokens;
  const lowerBound = estimateCost(withoutWrites, 'gpt-6.1-sol', 'ultrafast');
  assert.equal(lowerBound.complete, false);
  assert.equal(lowerBound.is_lower_bound, true);
  assert.equal(lowerBound.components_usd.cache_write_input, null);
  closeTo(lowerBound.amount_usd, 1.23);
  assert.equal(estimateCost({...withoutWrites, cache_write_input_tokens: 0}, 'gpt-6.1-sol', 'ultrafast').complete, true);
  const assumed = estimateCost(usage, 'gpt-6.1-sol', 'auto');
  assert.equal(assumed.complete, false);
  assert.equal(assumed.service_tier_assumed, true);
  closeTo(assumed.amount_usd, 0.21);
});

test('new model IDs accept known effort suffixes without guessing variants or tiers', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
    for (const id of [model, ` ${model.toUpperCase()} `, `${model}-max`, `${model}(ultra)`]) {
      assert.equal(estimateCost(usage, id, 'default').model_key, model);
    }
  }
  for (const model of ['gpt-6.1', 'gpt-6.1-astra', 'gpt-6.1-sol-pro']) {
    assert.equal(estimateCost(usage, model, 'default').reason, 'missing_model_pricing');
  }
  for (const [model, tier] of [['gpt-6-sol', 'ultrafast'], ['gpt-6-luna', 'ultrafast'],
    ['gpt-6.1-sol', 'input_per_1m'], ['gpt-6.1-sol', 'long_context']]) {
    const cost = estimateCost(usage, model, tier);
    assert.equal(cost.known, false);
    assert.equal(cost.amount_usd, null);
    assert.equal(cost.reason, `missing_${tier}_pricing`);
  }
});

function modelSwitchRows() {
  const rows = [
    {type: 'session_meta', payload: {id: 'october-models'}},
    {type: 'turn_context', payload: {model: 'gpt-6-sol', service_tier: 'default'}},
    {type: 'token_usage_record', payload: {response_id: 'sol', usage}},
    {type: 'turn_context', payload: {model: 'gpt-6.1-sol'}},
    {type: 'event_msg', payload: {type: 'thread_settings_applied', thread_settings: {serviceTier: 'ultrafast'}}},
    {type: 'token_usage_record', payload: {response_id: 'sol-61', usage}},
    {type: 'turn_context', payload: {model: 'gpt-6-luna', service_tier: 'fast'}},
    {type: 'event_msg', payload: {type: 'token_count', info: {last_token_usage: {...usage, output_tokens: 20_000}}}}
  ];
  return rows.map((row, i) => ({timestamp: new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString(), ...row}));
}

test('model switches and Ultrafast settings survive ingestion and stored-price refresh', () => {
  const dir = path.join(process.env.CODEX_HOME, 'sessions');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'rollout-october-models.jsonl');
  fs.writeFileSync(file, modelSwitchRows().map(row => JSON.stringify(row)).join('\n') + '\n');
  const {records} = parseSessionFile(file, fs.statSync(file));
  assert.deepEqual(records.map(r => [r.model, r.service_tier]), [
    ['gpt-6-sol', 'default'], ['gpt-6.1-sol', 'ultrafast'], ['gpt-6-luna', 'fast']
  ]);
  assert.equal(ingestChangedSessionFiles().local_db_parse_errors, 0);
  db.exec("UPDATE token_records SET pricing_version='previous-snapshot',cost_known=0,cost_amount_usd=NULL");
  fs.unlinkSync(file); // Repricing must also work when the original log is unavailable.
  refreshStoredPricing();
  const start = Date.UTC(2026, 9, 10);
  const data = buildData(start, start + 60_000, 'hour', {page: 1, pageSize: 100});
  assert.equal(data.summary.request_records, 3);
  assert.equal(data.summary.estimated_cost.unpriced_records, 0);
  closeTo(data.summary.estimated_cost.amount_usd, 1.5065);
  closeTo(data.requests.find(r => r.model === 'gpt-6.1-sol').cost_estimate.amount_usd, 1.26);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM token_records WHERE pricing_version='previous-snapshot'").get().n, 0);
});
