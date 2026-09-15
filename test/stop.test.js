'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('Windows stop script rejects unrelated listeners and accepts the monitor identity',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-stop-test-'));
  try{const output=execFileSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'stop-mock.ps1'),'-StopScript',path.join(__dirname,'../scripts/stop.ps1'),'-Sandbox',root],{encoding:'utf8'});assert.match(output,/Both process identity checks passed/);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});
