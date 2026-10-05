// Token usage → Pips: each Pip's share of the same range, a breakdown of Everything, never added to it.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
const src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'settingsClient.js'],bundle:true,write:false,loader:{'.css':'empty','.ico':'dataurl','.png':'dataurl','.svg':'dataurl'},format:'iife'})).outputFiles[0].text;
const view=await build({entryPoints:[src+'settingsView.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const module={exports:{}};new Function('module','exports',view.outputFiles[0].text)(module,module.exports);
const windows=[];after(()=>windows.forEach(w=>w.close()));
function setup(){
 const dom=new JSDOM(module.exports.settingsDocument(),{runScripts:'outside-only'}),w=dom.window;windows.push(w);const sent=[];
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m)});w.eval(code);
 const message=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m}));
 message({type:'event',event:{type:'config',base_url:'https://model.example/v1',model:'m',mode:'default',think:'high',context_size:65536}});
 return {w,d:w.document,sent,message,click:s=>w.document.querySelector(s).click()};
}
const report=(request,extra={})=>({type:'pip_usage_report',request_id:request.requestId,range:request.range,generated_at:'2026-10-05T04:00:00Z',timezone:'IST, UTC+05:30',
 all_tokens:400000,totals:{input_tokens:90000,output_tokens:10000,runs:12},omitted:0,
 by_pip:[{pip_id:'pip_'+'1'.repeat(32),name:'Market brief',pip_type:'lens',scope:'personal',project:'',status:'active',input_tokens:70000,output_tokens:5000,runs:9,daily_cap:200000},
         {pip_id:'pip_'+'2'.repeat(32),name:'Nightly review',pip_type:'rook',scope:'project',project:'demo_project',status:'paused',input_tokens:20000,output_tokens:5000,runs:3,daily_cap:null}],...extra});

test('the Pips view shows each Pip and its share of everything in the same range',()=>{
 const x=setup();x.click('[data-nav=usage]');
 assert.equal(x.sent.at(-1).type,'getUsage','Everything first, as before');
 x.click('[data-usage-view=pips]');
 const asked=x.sent.at(-1);
 assert.deepEqual({type:asked.type,range:asked.range},{type:'getPipUsage',range:'7d'});
 assert.equal(x.d.querySelector('[data-usage-view=pips]').getAttribute('aria-pressed'),'true');
 x.message({type:'event',event:report({...asked,requestId:'stale'})});
 assert.equal(x.d.querySelector('#pip-usage-content').hidden,true,'a late answer to an older request is ignored');
 x.message({type:'event',event:report(asked)});
 const text=x.d.querySelector('.pip-usage-section').textContent;
 assert.match(text,/Pips used 25% of the 400,000 tokens counted in this range/);
 assert.match(text,/part of the Everything total, not added to it/);
 const rows=[...x.d.querySelectorAll('#pip-usage-rows tr')];
 assert.equal(rows.length,2);
 assert.match(rows[0].textContent,/Market brief/);assert.match(rows[0].textContent,/lens · Personal · limit 200K\/day/);
 assert.match(rows[0].textContent,/75%/,'share of the Pips’ tokens');
 assert.match(rows[1].textContent,/rook · demo_project · paused/);
});

test('the range is shared, and switching back asks for Everything again',()=>{
 const x=setup();x.click('[data-nav=usage]');x.click('[data-usage-view=pips]');
 const select=x.d.querySelector('#usage-range');select.value='30d';select.dispatchEvent(new x.w.Event('change',{bubbles:true}));
 assert.deepEqual([x.sent.at(-1).type,x.sent.at(-1).range],['getPipUsage','30d']);
 x.click('[data-usage-view=all]');
 assert.deepEqual([x.sent.at(-1).type,x.sent.at(-1).range],['getUsage','30d']);
});

test('no Pip runs, an older CLI and an unreadable registry each say so',()=>{
 const x=setup();x.click('[data-nav=usage]');x.click('[data-usage-view=pips]');
 x.message({type:'event',event:report(x.sent.at(-1),{by_pip:[],totals:{input_tokens:0,output_tokens:0,runs:0}})});
 assert.equal(x.d.querySelector('#pip-usage-empty').hidden,false);
 x.click('#pip-usage-refresh');
 x.message({type:'pip_usage_unavailable',requestId:x.sent.at(-1).requestId,message:'Update the DGC CLI to see token usage by Pip.'});
 assert.match(x.d.querySelector('#pip-usage-status').textContent,/Update the DGC CLI/);
 x.click('#pip-usage-refresh');
 x.message({type:'event',event:report(x.sent.at(-1),{by_pip:[],error:'database is locked'})});
 assert.match(x.d.querySelector('#pip-usage-status').textContent,/could not be read: database is locked/);
 x.click('#pip-usage-refresh');
 x.message({type:'event',event:{type:'command_rejected',command:'get_pip_usage_report',request_id:x.sent.at(-1).requestId,message:'Unknown command'}});
 assert.match(x.d.querySelector('#pip-usage-status').textContent,/Unknown command/);
});
