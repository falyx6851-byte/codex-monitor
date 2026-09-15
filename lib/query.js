'use strict';

// Aggregate narrow numeric columns in SQLite; only hydrate the requested detail page.
const VISIBLE = 'NOT (input_tokens=0 AND cached_input_tokens=0 AND output_tokens=0 AND total_tokens>0)';
const WHERE = `ms>=? AND ms<? AND ${VISIBLE}`;
const BILLABLE = '(input_tokens>0 OR cached_input_tokens>0 OR output_tokens>0)';
const PRICED = `(cost_known=1 AND ${BILLABLE})`;
const AGGREGATE = `COUNT(*) records,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_records,
  SUM(input_tokens) input_tokens,SUM(cached_input_tokens) cached_input_tokens,
  CASE WHEN COUNT(cache_write_input_tokens)=COUNT(*) THEN SUM(cache_write_input_tokens) ELSE NULL END cache_write_input_tokens,
  SUM(output_tokens) output_tokens,SUM(reasoning_output_tokens) reasoning_output_tokens,SUM(total_tokens) total_tokens,
  SUM(CASE WHEN ${PRICED} THEN cost_amount_usd ELSE 0 END) amount_usd,
  SUM(CASE WHEN ${PRICED} THEN 1 ELSE 0 END) priced_records,
  SUM(CASE WHEN NOT COALESCE(${PRICED},0) AND (total_tokens>0 OR input_tokens>0 OR output_tokens>0) THEN 1 ELSE 0 END) unpriced_records,
  SUM(CASE WHEN ${PRICED} AND cost_is_lower_bound=1 THEN 1 ELSE 0 END) lower_bound_records,
  SUM(CASE WHEN ${PRICED} AND cost_service_tier_assumed=1 THEN 1 ELSE 0 END) assumed_service_tier_records,
  AVG(CASE WHEN request_duration_ms_estimate>0 THEN request_duration_ms_estimate END) duration,
  AVG(CASE WHEN first_output_ms_estimate>=0 THEN first_output_ms_estimate END) first_output,
  AVG(CASE WHEN turn_duration_ms_estimate>0 THEN turn_duration_ms_estimate END) turn_duration,
  SUM(CASE WHEN response_item_count>0 THEN 1 ELSE 0 END) stream_known_records,
  SUM(CASE WHEN stream_observed=1 THEN 1 ELSE 0 END) stream_observed_records,
  SUM(CASE WHEN service_tier!='' THEN 1 ELSE 0 END) service_tier_known_records`;

function createQueries(db, {rowToRequest, pricingConfig, bucketStart, bucketLabel, nextBucketStart}) {
  const statements = new Map(), cache = new Map();
  const stmt = sql => { if (!statements.has(sql)) statements.set(sql,db.prepare(sql)); return statements.get(sql); };
  let version = null;
  function cost(row) {
    const priced=row.priced_records || 0,unpriced=row.unpriced_records || 0,assumed=row.assumed_service_tier_records || 0,lower=row.lower_bound_records || 0;
    return {currency:pricingConfig.currency || 'USD',amount_usd:!priced && unpriced ? null : row.amount_usd || 0,
      priced_records:priced,unpriced_records:unpriced,lower_bound_records:lower,assumed_service_tier_records:assumed,
      is_lower_bound:lower>0 && !assumed,complete:!unpriced && !lower && !assumed,source:pricingConfig.source,updated_at:pricingConfig.updated_at};
  }
  function usage(row) {
    return {input_tokens:row.input_tokens || 0,cached_input_tokens:row.cached_input_tokens || 0,
      cache_write_input_tokens:row.records ? row.cache_write_input_tokens : 0,output_tokens:row.output_tokens || 0,
      reasoning_output_tokens:row.reasoning_output_tokens || 0,total_tokens:row.total_tokens || 0};
  }
  function bucket(row) {
    const u=usage(row),records=row.records || 0;
    return {ts:row.ts,label:row.label,records,success_records:records-(row.failed_records || 0),failed_records:row.failed_records || 0,
      success_rate:records ? (records-(row.failed_records || 0))/records : null,usage:u,
      cache_hit_rate:u.input_tokens ? u.cached_input_tokens/u.input_tokens : null,estimated_cost:cost(row),
      average_request_duration_ms_estimate:row.duration ?? null,average_first_output_ms_estimate:row.first_output ?? null};
  }
  function aggregate(start,end,width) {
    const dataVersion=stmt('PRAGMA data_version').get().data_version;
    if (dataVersion!==version) { cache.clear(); version=dataVersion; }
    const latest=stmt('SELECT MAX(ms) ms FROM token_records').get().ms;
    const cappedEnd=latest == null ? end : Math.min(end,latest+1);
    // Buckets include empty time, so only the numeric aggregates reuse the capped range.
    const key=`${start}:${cappedEnd}:${width}`;
    let base=cache.get(key);
    if (!base) {
      const row=stmt(`SELECT ${AGGREGATE} FROM token_records WHERE ${WHERE}`).get(start,end),u=usage(row);
      const groups=stmt(`SELECT status,model,service_tier,originator,cost_model_key,${AGGREGATE} FROM token_records WHERE ${WHERE} GROUP BY status,model,service_tier,originator,cost_model_key`).all(start,end);
      const countMaps=Object.fromEntries(['status','model','service_tier','originator'].map(key=>[key,new Map()])),modelCosts=new Map();
      for (const group of groups) {
        for (const [field,map] of Object.entries(countMaps)) { const key=group[field] || 'unknown';map.set(key,(map.get(key) || 0)+group.records); }
        if (group.priced_records) {
          const key=group.cost_model_key,item=modelCosts.get(key) || {model:key,records:0,lower_bound_records:0,amount_usd:0};
          item.records+=group.priced_records;item.lower_bound_records+=group.lower_bound_records || 0;item.amount_usd+=group.amount_usd || 0;modelCosts.set(key,item);
        }
      }
      const counts=Object.fromEntries(Object.entries(countMaps).map(([field,map])=>[field,[...map].map(([key,count])=>({key,count})).sort((a,b)=>b.count-a.count || a.key.localeCompare(b.key))]));
      const byModel=[...modelCosts.values()].sort((a,b)=>b.amount_usd-a.amount_usd);
      const format=width==='hour' ? "strftime('%Y-%m-%d %H:00',ms/1000,'unixepoch','localtime')"
        : width==='week' ? "date(ms/1000,'unixepoch','localtime','weekday 0','-6 days')" : "date(ms/1000,'unixepoch','localtime')";
      const buckets=stmt(`SELECT ${format} label,${AGGREGATE} FROM token_records WHERE ${WHERE} GROUP BY label ORDER BY label`).all(start,end)
        .map(row=>bucket({...row,ts:new Date(row.label.replace(' ','T')+(row.label.length===10 ? 'T00:00:00' : ':00')).getTime()}));
      base={summary:{request_records:row.records,session_token_count_records:row.records,request_usage:u,
        cache_hit_rate:u.input_tokens ? u.cached_input_tokens/u.input_tokens : null,
        estimated_cost:{...cost(row),by_model:byModel},average_request_duration_ms_estimate:row.duration ?? null,
        average_turn_elapsed_ms_estimate:row.duration ?? null,average_first_output_ms_estimate:row.first_output ?? null,
        average_turn_duration_ms_estimate:row.turn_duration ?? null,stream_known_records:row.stream_known_records || 0,
        stream_observed_records:row.stream_observed_records || 0,service_tier_known_records:row.service_tier_known_records || 0},
        counts,buckets};
      if (cache.size>=32) cache.delete(cache.keys().next().value);
      cache.set(key,base);
    }
    const buckets=new Map(base.buckets.map(row=>[row.ts,row]));
    const first=start || base.buckets[0]?.ts || end;
    const fillStart=bucketStart(first,width),fillEnd=bucketStart(Math.max(start,end-1),width),expected=[];
    for (let ts=fillStart;ts<=fillEnd && expected.length<=500;ts=nextBucketStart(ts,width)) expected.push(ts);
    if (expected.length<=500) for (const ts of expected) if (!buckets.has(ts)) buckets.set(ts,bucket({ts,label:bucketLabel(ts,width)}));
    return {...base,buckets:[...buckets.values()].sort((a,b)=>a.ts-b.ts)};
  }
  function read(start,end,width,{page=1,pageSize=6}={}) {
    const started=performance.now();
    db.exec('BEGIN');
    try {
      const base=aggregate(start,end,width),total=base.summary.request_records,totalPages=Math.max(1,Math.ceil(total/pageSize));
      page=Math.min(Math.max(1,page),totalPages);
      const rows=stmt(`SELECT * FROM token_records WHERE ${WHERE} ORDER BY ms DESC,record_id DESC LIMIT ? OFFSET ?`).all(start,end,pageSize,(page-1)*pageSize);
      db.exec('COMMIT');
      return {...base,pagination:{page,page_size:pageSize,total_records:total,total_pages:totalPages},requests:rows.map(rowToRequest),query_duration_ms:performance.now()-started};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {read,aggregate,clear:()=>cache.clear(),iterate:(start,end)=>stmt(`SELECT * FROM token_records WHERE ${WHERE} ORDER BY ms DESC,record_id DESC`).iterate(start,end)};
}
module.exports={createQueries};
