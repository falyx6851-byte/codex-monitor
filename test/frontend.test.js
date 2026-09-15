'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const helpers=require('../public/query-state');
process.env.TZ='Asia/Shanghai';
test('yesterday is the previous local calendar day and shortcuts roll over at midnight',()=>{
  const before=Date.parse('2026-09-15T23:59:00+08:00'),after=Date.parse('2026-09-16T00:01:00+08:00');
  assert.deepEqual(helpers.presetRange('yesterday',before),{start:Date.parse('2026-09-14T00:00:00+08:00'),end:Date.parse('2026-09-15T00:00:00+08:00')});
  assert.equal(helpers.presetRange(1,after).start,Date.parse('2026-09-16T00:00:00+08:00'));
  assert.equal(helpers.presetRange(7,after).end-helpers.presetRange(7,after).start,7*86400000);
});
test('model chart preserves the total by grouping all remaining models',()=>{
  const rows=Array.from({length:8},(_,i)=>({key:'model-'+i,count:10})),out=helpers.modelChartRows(rows);
  assert.equal(out.length,6);assert.equal(out.at(-1).count,30);assert.equal(out.reduce((s,r)=>s+r.count,0),80);
});

const fixture={pagination:{page:1,total_pages:1},diagnostics:{indexing_in_progress:false},summary:{request_records:1}};
async function frontend() {
  const els=new Map();
  const element=id=>{if(!els.has(id))els.set(id,{value:id==='bucketInput'?'auto':id==='pageSizeInput'?'6':'',classList:{add(){},remove(){},toggle(){}},setAttribute(){},addEventListener(){}});return els.get(id);};
  const context=vm.createContext({MonitorQuery:helpers,AbortController,DOMException,URLSearchParams,Date,console,
    location:{hash:''},history:{replaceState(){}},requestAnimationFrame(){},setInterval(){},setTimeout,clearTimeout,
    document:{getElementById:element,querySelectorAll:()=>[],body:element('body')},window:{addEventListener(){}},
    fetch:async()=>({ok:true,json:async()=>structuredClone(fixture)})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
  vm.runInContext('render=()=>{};',context);
  await new Promise(setImmediate);
  return context;
}
test('an older response cannot replace the latest query even if fetch ignores abort',async()=>{
  const ctx=await frontend();let issued=0;
  ctx.fetch=()=>{const n=++issued;return new Promise(resolve=>setTimeout(()=>resolve({ok:true,json:async()=>({...fixture,sequence:n})}),n===1?40:1));};
  await vm.runInContext('Promise.all([loadData(),loadData()])',ctx);
  assert.equal(vm.runInContext('state.data.sequence',ctx),2);
});
test('index completion automatically fetches fresh data without restarting ingestion',async()=>{
  const ctx=await frontend();let dataCalls=0,healthCalls=0;const urls=[];
  ctx.setTimeout=(fn)=>setTimeout(fn,0);
  ctx.fetch=async url=>{urls.push(url);if(url==='/api/health'){healthCalls++;return {ok:true,json:async()=>({indexing_in_progress:false})};}
    dataCalls++;return {ok:true,json:async()=>({...fixture,summary:{request_records:dataCalls-1},diagnostics:{indexing_in_progress:dataCalls===1}})};};
  await vm.runInContext('loadData({refresh:true})',ctx);
  assert.equal(vm.runInContext('state.data.summary.request_records',ctx),1);assert.equal(dataCalls,2);assert.equal(healthCalls,1);
  assert.ok(urls[0].includes('refresh=1'));assert.ok(urls.at(-1).includes('refresh=0'));
});
test('excluded request duration never falls back to whole-turn elapsed time',async()=>{
  const ctx=await frontend();assert.equal(vm.runInContext('effectiveDurationMs({duration_ms:null,duration_ms_estimate:null,turn_elapsed_ms_estimate:602000})',ctx),null);
});
