'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test, after} = require('node:test');
const {execFileSync} = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-ingest-'));
process.env.CODEX_HOME = path.join(temp, 'home');
process.env.CODEX_TOKEN_MONITOR_DATA_DIR = path.join(temp, 'data');
const {db, ingestChangedSessionFiles, estimateCost, summarizeCost} = require('../server');
after(() => { db.close(); fs.rmSync(temp, {recursive:true,force:true}); });
const active = path.join(process.env.CODEX_HOME,'sessions');
const archive = path.join(process.env.CODEX_HOME,'archived_sessions');
fs.mkdirSync(active,{recursive:true});fs.mkdirSync(archive,{recursive:true});
function fixture(id, count) {
  const rows = [{timestamp:'2026-09-01T00:00:00Z',type:'session_meta',payload:{id}},
    {timestamp:'2026-09-01T00:00:00Z',type:'turn_context',payload:{model:'gpt-6-astra'}}];
  for(let i=1;i<=count;i++) rows.push({timestamp:`2026-09-01T00:00:0${i}Z`,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:1000,cached_input_tokens:500,output_tokens:i,total_tokens:1000+i},total_token_usage:{input_tokens:i*1000,output_tokens:i*(i+1)/2,total_tokens:i*1000+i*(i+1)/2}}}});
  return rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
}
const id='11111111-1111-1111-1111-111111111111';
const filename=`rollout-${id}.jsonl`;
const count=()=>db.prepare('SELECT COUNT(*) n FROM token_records WHERE session_id=?').get(id).n;

test('ingests archive-only sessions and repeated refresh is idempotent',()=>{
 fs.writeFileSync(path.join(archive,filename),fixture(id,2));
 const first=ingestChangedSessionFiles();assert.equal(first.archived_session_files,1);assert.equal(count(),2);
 assert.equal(ingestChangedSessionFiles().local_db_inserted_records,0);assert.equal(count(),2);
});
test('merges active/archive copies and moves without duplicating requests',()=>{
 fs.writeFileSync(path.join(active,filename),fixture(id,3));
 ingestChangedSessionFiles();assert.equal(count(),3);
 fs.unlinkSync(path.join(archive,filename));
 fs.renameSync(path.join(active,filename),path.join(archive,filename));
 ingestChangedSessionFiles();assert.equal(count(),3);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM session_files WHERE session_id=?').get(id).n,1);
});
test('migrates old keys atomically and preserves history without original files',()=>{
 const old=db.prepare('SELECT * FROM token_records LIMIT 1').get();
 db.prepare("UPDATE token_records SET dedupe_key='legacy-' || record_id WHERE session_id=?").run(id);
 db.prepare('UPDATE session_files SET parser_version=1 WHERE session_id=?').run(id);
 // A separate missing-source session must survive migration.
 const columns=Object.keys(old);const orphan={...old,record_id:'orphan',dedupe_key:'orphan',session_id:'missing-source',session_file:path.join(temp,'missing.jsonl')};
 db.prepare(`INSERT INTO token_records (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>orphan[k]));
 ingestChangedSessionFiles();assert.equal(count(),3);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM token_records WHERE record_id='orphan'").get().n,1);
 assert.equal(db.prepare('SELECT parser_version FROM session_files WHERE session_id=?').get(id).parser_version,3);
});
test('malformed replacements preserve existing data and retry after repair',()=>{
 const file=path.join(archive,filename),before=db.prepare('SELECT file_size FROM session_files WHERE file_path=?').get(file).file_size;
 fs.writeFileSync(file,fixture(id,1)+'{incomplete');
 assert.equal(ingestChangedSessionFiles().local_db_parse_errors,1);assert.equal(count(),3);
 assert.equal(db.prepare('SELECT file_size FROM session_files WHERE file_path=?').get(file).file_size,before);
 fs.writeFileSync(file,fixture(id,4));assert.equal(ingestChangedSessionFiles().local_db_parse_errors,0);assert.equal(count(),4);
});
test('unknown and auto tiers are explicitly assumed, not presented as complete costs',()=>{
 const usage={input_tokens:1000,output_tokens:100,cache_write_input_tokens:0,total_tokens:1100};
 for(const tier of ['',undefined,'auto']){
  const cost=estimateCost(usage,'gpt-6-astra',tier);
  assert.equal(cost.service_tier_assumed,true);assert.equal(cost.complete,false);
  assert.equal(cost.estimate_kind,'assumed_standard_rate');
  // Standard may overestimate Flex or underestimate Fast: it is not a lower bound.
  assert.equal(cost.is_lower_bound,false);
  assert.equal(summarizeCost([{usage,cost_estimate:cost}]).assumed_service_tier_records,1);
 }
 assert.equal(estimateCost(usage,'gpt-6-astra','default').service_tier_assumed,false);
 const missing=estimateCost({...usage,cache_write_input_tokens:null},'gpt-6-astra','');
 assert.equal(missing.cache_write_tokens_missing,true);
 assert.equal(missing.is_lower_bound,false);
});

test('standalone report includes archives and deduplicates duplicate copies',()=>{
 const copy=path.join(active,filename);
 fs.copyFileSync(path.join(archive,filename),copy);
 try {
  const report=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../scripts/codex-token-report.mjs'),
   '--codex-home',process.env.CODEX_HOME,'--all','--format','json','--redact-paths'],{encoding:'utf8'}));
  assert.equal(report.summary.records,4);
  assert.equal(report.diagnostics.archived_sessions_dir,'[redacted-path]');
 } finally {fs.unlinkSync(copy);}
});
