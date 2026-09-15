(function(root) {
  'use strict';
  function presetRange(preset, now = Date.now()) {
    const midnight = new Date(now); midnight.setHours(0,0,0,0);
    if (preset === 'yesterday') {
      const start = new Date(midnight); start.setDate(start.getDate()-1);
      return {start:start.getTime(),end:midnight.getTime()};
    }
    return {start:Number(preset)===1 ? midnight.getTime() : Number(preset)<=0 ? 0 : now-Number(preset)*86400000,end:now};
  }
  function modelChartRows(rows) {
    if (rows.length<=5) return rows;
    return [...rows.slice(0,5),{key:'其他',count:rows.slice(5).reduce((sum,row)=>sum+row.count,0)}];
  }
  const api={presetRange,modelChartRows};
  if (typeof module==='object' && module.exports) module.exports=api;
  else root.MonitorQuery=api;
})(typeof globalThis==='object' ? globalThis : this);
