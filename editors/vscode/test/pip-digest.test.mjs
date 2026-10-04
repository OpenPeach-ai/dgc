import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';

// The main chat's Pips bar and the digest/settings/outcomes validators (Pips API 41).
const build=(file,name)=>buildSync({entryPoints:[new URL(file,import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:name,loader:{'.css':'empty'}}).outputFiles[0].text;
const barBundle=build('../src/pipDigestBar.js','Bar'),modelBundle=build('../src/pipsModel.js','Model');
const Model=new Function(modelBundle+';return Model;')();
const panel=readFileSync(new URL('../src/panel.ts',import.meta.url),'utf8');
const markup=panel.match(/<section id="pipsbar"[\s\S]*?<\/section>/)[0];
const pip='pip_'+'a'.repeat(32),run='run_'+'b'.repeat(32),workspace='ws_'+'c'.repeat(32);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const finding=(extra={})=>({severity:'high',title:'Unchecked user id',path:'api/users.py',line:42,run_id:run,finding_index:0,...extra});
const entry=(extra={})=>({pip_id:pip,workspace_id:workspace,name:'Commit reviewer',pip_type:'rook',scope:'project',status:'active',min_severity:'medium',alert_severity:'high',runs:{succeeded:2,failed:0,cancelled:0},skipped_unchanged:1,new_total:1,below_threshold:0,new_findings:[finding()],gone_after_change:0,alert:true,latest_run_id:run,...extra});
const digest=(extra={})=>({schema_version:1,since:'2026-10-03T09:00:00.000Z',until:'2026-10-04T09:00:00.000Z',first:false,due:true,reason:'alert',headline:'1 new finding from Commit reviewer (worst: high)',pips:[entry()],omitted_pips:0,failed_runs:0,pending_reviews:2,pending_setups:0,truncated:false,...extra});

function harness(t){
 const dom=new JSDOM(`<main>${markup}</main>`,{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.eval(barBundle+';window.Bar=Bar;');
 const sent=[],opened=[],timers=[];let changes=0;
 const bar=w.Bar.mountDigestBar({document:w.document,postMessage:m=>sent.push(m),onOpen:v=>opened.push(v),onChange:()=>changes++,setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval:()=>{}});
 t.after(()=>{bar.dispose();w.close();});
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const answer=(m,result,ok=true)=>bar.receive({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});
 const connect=(api=41,extra={})=>bar.receive({type:'pipsConnection',generation:1,connected:true,supported:true,enabled:true,apiVersion:api,...extra});
 return {w,d:w.document,bar,sent,opened,timers,requests,answer,connect,changes:()=>changes};
}

test('the bar asks for the digest at API 41 only and stays hidden until one is due',async t=>{
 const old=harness(t);old.connect(40);assert.equal(old.requests('get_pip_digest').length,0);assert.equal(old.d.getElementById('pipsbar').hidden,true);
 const x=harness(t);assert.equal(x.sent[0].type,'pipsReady');x.connect();
 x.answer(x.requests('get_pip_digest')[0],{digest:digest({due:false,reason:null})});await flush();
 assert.equal(x.d.getElementById('pipsbar').hidden,true);
 x.timers[0]();x.answer(x.requests('get_pip_digest')[1],{digest:null});await flush();
 assert.equal(x.d.getElementById('pipsbar').hidden,true,'a profile without Pips shows nothing');
});

test('a due digest shows its headline, opens findings in Pips and never renders model text as markup',async t=>{
 const x=harness(t);x.connect();
 const hostile=digest({pips:[entry({name:'<b>Reviewer</b>',new_findings:[finding({title:'<img src=x onerror=alert(1)>'})]})]});
 x.answer(x.requests('get_pip_digest')[0],{digest:hostile});await flush();
 const bar=x.d.getElementById('pipsbar');assert.equal(bar.hidden,false);assert.equal(bar.dataset.reason,'alert');
 assert.equal(x.d.getElementById('pips-digest-text').textContent,hostile.headline);
 x.d.getElementById('pips-digest-main').click();
 assert.equal(x.d.querySelectorAll('#pipsbar img,#pipsbar b').length,0);
 assert.match(x.d.getElementById('pips-digest-panel').textContent,/<img src=x onerror=alert\(1\)>/);
 assert.match(x.d.getElementById('pips-digest-panel').textContent,/2 runs · 1 new at medium or worse · 1 skipped, nothing changed/);
 assert.match(x.d.getElementById('pips-digest-panel').textContent,/2 reviews waiting/);
 x.d.querySelector('.pips-digest-finding').click();
 assert.deepEqual(JSON.parse(JSON.stringify(x.opened.at(-1))),{pip,section:'runs',run});
 x.d.getElementById('pips-digest-open').click();assert.equal(x.opened.at(-1),null);
 assert.ok(x.changes()>0,'the composer rail is told to resize');
});

test('dismiss marks exactly this digest seen; a failed or invalid digest is hidden, never half-shown',async t=>{
 const x=harness(t);x.connect();
 x.answer(x.requests('get_pip_digest')[0],{digest:digest()});await flush();
 x.d.getElementById('pips-digest-dismiss').click();await flush();
 const mark=x.requests('mark_pip_digest_seen')[0];assert.deepEqual(JSON.parse(JSON.stringify(mark.request)),{type:'mark_pip_digest_seen',until:'2026-10-04T09:00:00.000Z'});
 assert.equal(x.d.getElementById('pipsbar').hidden,false,'still shown until the backend confirms');
 x.answer(mark,{seen_until:'2026-10-04T09:00:00.000Z',seen_day:'2026-10-04'});await flush();
 assert.equal(x.d.getElementById('pipsbar').hidden,true);
 for(const bad of [digest({extra:true}),digest({pips:[entry({new_findings:[finding({severity:'low'})]})]}),digest({due:true,reason:null})]){
  x.timers[0]();const m=x.requests('get_pip_digest').at(-1);x.answer(m,{digest:bad});await flush();
  assert.equal(x.d.getElementById('pipsbar').hidden,true,JSON.stringify(bad).slice(0,80));
 }
});

test('validators accept the backend shapes and refuse anything else',()=>{
 assert.equal(Model.pipDigest(digest()).pips.length,1);assert.equal(Model.pipDigest(null),null);
 const settings={pip_id:pip,min_severity:'medium',alert_severity:'high',revision:0,is_default:true};
 assert.equal(Model.pipNotifySettings(settings,pip),settings);
 for(const bad of [{...settings,pip_id:'pip_'+'f'.repeat(32)},{...settings,alert_severity:'low'},{...settings,revision:1},{...settings,min_severity:'urgent'},{...settings,extra:1}])
  assert.throws(()=>Model.pipNotifySettings(bad,pip));
 const outcomes={pip_id:pip,name:'Reviewer',pip_type:'rook',history_truncated:false,reported:3,accepted:1,dismissed:0,still_reported:1,gone_after_change:1,gone_without_change:1,checkpoints_examined:4};
 assert.equal(Model.pipOutcomes(outcomes,pip),outcomes);
 assert.throws(()=>Model.pipOutcomes({...outcomes,still_reported:2},pip),/invalid/,'the outcomes must add up');
});
