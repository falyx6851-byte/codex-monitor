'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),http=require('node:http'),net=require('node:net');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-fixes-'));
process.env.CODEX_HOME=path.join(temp,'home');process.env.CODEX_TOKEN_MONITOR_DATA_DIR=path.join(temp,'data');
const {db,parseSessionFile,ingestChangedSessionFiles,buildData,summarizeCost,estimateCost,queries}=require('../server');
const dir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(dir,{recursive:true});
const epoch=Date.parse('2026-09-15T00:00:00Z');
const row=(s,type,payload)=>({timestamp:new Date(epoch+s*1000).toISOString(),type,payload});
const u=n=>({input_tokens:1000,cached_input_tokens:500,cache_write_input_tokens:0,output_tokens:n,total_tokens:1000+n});
const meta=(id,extra={},s=0)=>row(s,'session_meta',{id,...extra});
const context=(model='gpt-6-astra')=>row(0,'turn_context',{model,service_tier:'default'});
const token=(s,n,total=true)=>row(s,'event_msg',{type:'token_count',info:{last_token_usage:u(n),...(total?{total_token_usage:{input_tokens:n*1000,output_tokens:n*10,total_tokens:n*1010}}:{})}});
const ledger=(s,id,n,thread)=>row(s,'token_usage_record',{response_id:id,thread_id:thread,usage:u(n),thread_token_usage:{input_tokens:n*1000,output_tokens:n*10,total_tokens:n*1010}});
const file=(id,rows)=>{const f=path.join(dir,`rollout-${id}.jsonl`);fs.writeFileSync(f,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return f;};
const parse=f=>parseSessionFile(f,fs.statSync(f));
test.beforeEach(()=>{db.exec('DELETE FROM token_records;DELETE FROM session_files');queries.clear();for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));});
test.after(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});

test('fork ownership survives inherited headers and repeated ingestion without parent loss',()=>{
  const p='11111111-1111-1111-1111-111111111111',c='22222222-2222-2222-2222-222222222222';
  file(p,[meta(p),context(),ledger(1,'parent-a',1,p),token(2,1),ledger(3,'parent-b',2,p),token(4,2)]);
  file(c,[meta(c,{forked_from_id:p,subagent_history_start_ordinal:4}),meta(p),context(),token(2,1),context(),
    row(5,'event_msg',{type:'task_started',turn_id:'child-turn'}),{...ledger(6,'child-c',3,c),payload:{...ledger(6,'child-c',3,c).payload,session_id:p}},token(7,3)]);
  for(let i=0;i<3;i++){
    assert.equal(ingestChangedSessionFiles().local_db_parse_errors,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM token_records WHERE session_id=?').get(p).n,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM token_records WHERE session_id=?').get(c).n,1);
  }
});
test('old corrupted owner metadata is migrated by physical source, not parent id',()=>{
  const p='11111111-1111-1111-1111-111111111111',c='22222222-2222-2222-2222-222222222222';
  const pf=file(p,[meta(p),context(),token(1,1),token(2,2)]),cf=file(c,[meta(c),context(),token(3,3)]);ingestChangedSessionFiles();
  db.prepare('UPDATE token_records SET session_id=?,dedupe_key=? || record_id WHERE session_file=?').run(p,'old-',cf);
  db.prepare('UPDATE session_files SET session_id=?,parser_version=3 WHERE file_path=?').run(p,cf);
  ingestChangedSessionFiles();assert.equal(db.prepare('SELECT COUNT(*) n FROM token_records WHERE session_file=?').get(pf).n,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM token_records WHERE session_id=?').get(c).n,1);
});
test('equal usage without cumulative snapshot preserves distinct events, dedupes copies',()=>{
  const f=file('no-snapshot',[meta('no-snapshot'),context(),token(1,1,false),token(90,1,false),token(90,1,false)]);
  assert.equal(parse(f).records.length,2);
});
test('usage ledger is counted before tools return; matching UI counter adds no request',()=>{
  const f=file('timing',[meta('timing'),context(),row(0,'event_msg',{type:'task_started'}),row(1,'response_item',{type:'custom_tool_call'}),
    ledger(2,'r1',1,'timing'),row(62,'response_item',{type:'custom_tool_call_output'}),token(62,1),
    row(63,'response_item',{type:'message',role:'assistant'}),ledger(64,'r2',2,'timing'),token(64,2)]);
  const r=parse(f).records;assert.equal(r.length,2);assert.equal(r[0].ms,epoch+2000);assert.equal(r[0].request_duration_ms_estimate,2000);
  assert.equal(r[1].request_duration_ms_estimate,2000);assert.equal(r[0].response_item_count,1);
});
test('legacy timing ends at model output and custom tool outputs do not count as model output',()=>{
  const f=file('legacy',[meta('legacy'),context(),row(0,'event_msg',{type:'task_started'}),row(1,'response_item',{type:'custom_tool_call'}),
    row(62,'response_item',{type:'custom_tool_call_output'}),token(62,1),row(63,'response_item',{type:'message',role:'assistant'}),token(64,2)]);
  const r=parse(f).records;assert.equal(r[0].request_duration_ms_estimate,1000);assert.equal(r[1].request_duration_ms_estimate,1000);
});

test('UI mirrors may omit cache-write usage without duplicating the response ledger',()=>{
  const response=ledger(2,'cache-write-r1',1,'cache-write');
  response.payload.usage.cache_write_input_tokens=25;
  const mirror=token(3,1);
  delete mirror.payload.info.last_token_usage.cache_write_input_tokens;
  const f=file('cache-write',[meta('cache-write'),context(),response,mirror,
    row(4,'response_item',{type:'message',role:'assistant'}),ledger(5,'cache-write-r2',1,'cache-write')]);
  const records=parse(f).records;
  assert.equal(records.length,2);
  assert.equal(records[0].cache_write_input_tokens,25);
});
test('SQL aggregates agree with detail calculations across priced, unknown and failed records',()=>{
  file('aggregate',[meta('aggregate'),context(),token(1,1),context('unknown-model'),token(2,2),row(3,'event_msg',{type:'error',message:'explicit error'})]);
  ingestChangedSessionFiles();const d=buildData(epoch,epoch+4000,'hour',{page:1,pageSize:100});
  assert.equal(d.summary.request_records,3);assert.equal(d.summary.request_usage.total_tokens,2003);
  assert.deepEqual(d.summary.estimated_cost.by_model.map(r=>({...r})),summarizeCost(d.requests).by_model);
  assert.equal(d.summary.estimated_cost.unpriced_records,1);assert.equal(d.counts.status.find(r=>r.key==='failed').count,1);
  assert.equal(d.summary.estimated_cost.amount_usd,estimateCost(u(1),'gpt-6-astra','default').amount_usd);
  assert.equal(d.buckets.reduce((s,b)=>s+b.records,0),3);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT * FROM token_records WHERE ms>=? AND ms<? ORDER BY ms DESC,record_id DESC LIMIT 6').all(epoch,epoch+4000);
  assert.ok(plan.some(r=>r.detail.includes('idx_token_records_page')));
});
test('unknown prices stay null, empty ranges remain zero, end boundary is exclusive',()=>{
  file('unknown',[meta('unknown'),context('unknown-model'),token(1,1),token(2,2)]);ingestChangedSessionFiles();
  const data=buildData(epoch,epoch+2000,'hour',{page:1,pageSize:6});assert.equal(data.summary.request_records,1);
  assert.equal(data.summary.estimated_cost.amount_usd,null);assert.equal(data.buckets[0].estimated_cost.amount_usd,null);
  assert.equal(summarizeCost(data.requests).amount_usd,null);
  assert.equal(buildData(0,1,'hour',{page:1,pageSize:6}).summary.estimated_cost.amount_usd,0);
});
test('standalone report uses the same request ownership and usage records',()=>{
  file('report',[meta('report'),context(),ledger(1,'report-r',1,'report'),token(2,1)]);ingestChangedSessionFiles();
  const report=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../scripts/codex-token-report.mjs'),'--codex-home',process.env.CODEX_HOME,'--all','--format','json'],{encoding:'utf8'}));
  assert.equal(report.summary.records,1);assert.equal(report.summary.usage.total_tokens,1001);
});

test('HTTP keeps serving after invalid URL and exports a complete consistent snapshot',async()=>{
  file('api',[meta('api'),context(),...Array.from({length:20},(_,i)=>token(i+1,i+1))]);ingestChangedSessionFiles();
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const child=spawn(process.execPath,['--no-warnings',path.join(__dirname,'../server.js')],{env:{...process.env,CODEX_TOKEN_MONITOR_PORT:String(port)},windowsHide:true,stdio:'ignore'});
  const exit=new Promise(r=>child.once('exit',r));
  const request=p=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:p},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy());});
  try {
    let ready=false;for(let i=0;i<100;i++){try{const h=await request('/api/health');if(!h.data.indexing_in_progress){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
    assert.equal((await request('//[')).status,400);assert.equal((await request('/api/health')).status,200);
    const query=`start_ms=${epoch}&end_ms=${epoch+30000}&refresh=0`;
    const d=(await request('/api/data?'+query)).data;assert.equal(d.requests.length,6);assert.equal(d.summary.request_records,20);
    const out=(await request('/api/export?'+query)).data;assert.equal(out.requests.length,20);assert.equal(out.summary.request_records,20);
    assert.equal(out.summary.request_usage.total_tokens,out.requests.reduce((s,r)=>s+r.usage.total_tokens,0));
  } finally {child.kill();await exit;}
});
