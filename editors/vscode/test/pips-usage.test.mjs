// A Pip's usage and daily limit in its Job tab (API 41): plain numbers, a 14-day chart, and a limit
// that is the user's own setting.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const base=new URL('../src/',import.meta.url);
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const workspace={id:'ws_'+'1'.repeat(32),name:'Project'},pipId='pip_'+'2'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id,role:id,description:'Read committed source',available:['rook','scout','lens','lock'].includes(id),unavailable_reason:['rook','scout','lens','lock'].includes(id)?null:'Planned',default_name:id,default_goal:'Review',engine:['rook','scout','lens','lock'].includes(id)?'source_audit':null}));
const pipB='pip_'+'5'.repeat(32);
const job={id:pipId,workspace_id:workspace.id,pip_type:'rook',name:'Daily review',goal:'Review the committed code.',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:1,policy:'read_only',trigger:'manual',proposals:[]};
const usage=(extra={})=>({pip_id:pipId,today:{day:'2026-10-05',tokens:12000,runs:2},last_30_days:{tokens:210000,runs:31},days:[{day:'2026-10-04',tokens:9000,runs:1},{day:'2026-10-05',tokens:12000,runs:2}],daily_cap:null,capped_today:false,...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
function setup(value=usage(),{second=false,hold=[]}={}){
 const held=new Set(hold);
 const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let listener;
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.setInterval=()=>1;w.eval(client);
 w.DgcPips.mount({root:w.document,host:'editor',postMessage:m=>sent.push(m),onMessage:fn=>{listener=fn;},onSetupPrompt:()=>true});
 const answer=(m,result)=>{answered.add(m.id);listener({type:'pipsReply',id:m.id,ok:true,result});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[workspace],current_workspace_id:workspace.id}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:second?[job,{...job,id:pipB,name:'Other review'}]:[job]}),get_pip:()=>({pip:r.pip_id===pipB?{...job,id:pipB,name:'Other review'}:job}),list_pip_runs:()=>({runs:[]}),get_pip_runner:()=>({runner:{runner_id:'r',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}}}),get_workspace_context:()=>({context:{workspace_id:workspace.id,revision:0,entries:[]}}),list_pip_starters:()=>({starters:[]}),get_pip_usage:()=>({usage:value}),get_pip_notify_settings:()=>({settings:{pip_id:pipId,min_severity:'medium',alert_severity:'high',revision:0,is_default:true}}),get_pip_outcomes:()=>({outcomes:{pip_id:pipId,name:'Daily review',pip_type:'rook',history_truncated:false,reported:0,accepted:0,dismissed:0,still_reported:0,gone_after_change:0,gone_without_change:0,checkpoints_examined:0}}),get_pips_keep_running:()=>undefined,get_pips_desktop_notifications:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id)&&!held.has(m.request.type))){const result=defaults(m.request);if(result!==undefined){answer(m,result);count++;}}if(!count)break;}await flush();}
 listener({type:'pipsConnection',apiVersion:41,generation:1,connected:true,supported:true,enabled:true});
 const input=(value)=>{const e=w.document.getElementById('usageLimit');e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const submit=()=>w.document.getElementById('usage-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 return {w,d:w.document,sent,answer,requests,drain,input,submit,release(){held.clear();},async open(){await drain();w.document.querySelector('[data-job]').click();await drain();w.document.querySelector('[data-tab=job]').click();await drain();}};
}

test('the Job tab says what the Pip cost today and this month, with a 14-day chart', async()=>{
 const x=setup();await x.open();
 const text=x.d.getElementById('usage-form').textContent;
 assert.match(text,/Today12,000 tokens · 2 runs/);assert.match(text,/Last 30 days210,000 tokens · 31 runs/);
 const bars=x.d.querySelectorAll('.usage-chart rect');assert.equal(bars.length,14);
 assert.equal(bars[13].querySelector('title').textContent,'2026-10-05: 12,000 tokens');
 assert.equal(bars[0].getAttribute('class'),'usage-bar empty');
});

test('a limit is saved as tokens, a wrong one is refused here, and it can be removed', async()=>{
 const x=setup();await x.open();
 x.input('lots');x.submit();await flush();
 assert.equal(x.requests('set_pip_daily_cap').length,0);assert.match(x.d.body.textContent,/Give a daily limit/);
 x.input('200k');x.submit();
 const saved=x.requests('set_pip_daily_cap')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(saved.request)),{type:'set_pip_daily_cap',pip_id:pipId,daily_tokens:200000});
 x.answer(saved,{usage:usage({daily_cap:200000})});await x.drain();
 assert.match(x.d.body.textContent,/Daily limit saved: 200,000 tokens for automatic runs/);
 x.d.getElementById('remove-usage-limit').click();
 assert.equal(x.requests('set_pip_daily_cap')[1].request.daily_tokens,null);
});

test('the chart is scaled to the days, so a limit far above them leaves the bars readable', async()=>{
 const x=setup(usage({daily_cap:200000}));await x.open();
 const tallest=Math.max(...[...x.d.querySelectorAll('.usage-chart rect')].map(r=>Number(r.getAttribute('height'))));
 assert.equal(tallest,40,'the busiest day fills the chart');
 assert.equal(x.d.querySelector('.usage-cap'),null,'a limit 16 times the busiest day is not drawn');
});

test('a Pip at its limit says its schedules wait until tomorrow', async()=>{
 const x=setup(usage({daily_cap:10000,capped_today:true}));await x.open();
 assert.match(x.d.body.textContent,/reached its daily limit: its schedules and triggers are skipped for the rest of the day/);
 assert.ok(x.d.querySelector('.usage-cap'),'the limit is drawn on the chart');
});

test('an answer that arrives after you moved between Pips is asked for again, never left loading', async()=>{
 const x=setup(usage(),{second:true,hold:['get_pip_usage']});await x.drain();
 const pick=async id=>{x.d.querySelector(`[data-job="${id}"]`).click();await x.drain();};
 await pick(pipId);x.d.querySelector('[data-tab=job]').click();await x.drain();
 const first=x.requests('get_pip_usage')[0];assert.ok(first,'the first Pip asked for its usage');
 await pick(pipB);await pick(pipId);x.d.querySelector('[data-tab=job]').click();await x.drain();
 x.release();x.answer(first,{usage:usage()});await x.drain();
 assert.match(x.d.getElementById('usage-form')?.textContent||'',/Today12,000 tokens/,'not "Loading…" for good');
});

test('the keep-running switch survives its answer arriving after you chose a Pip', async()=>{
 const x=setup(usage(),{second:true});await x.drain();
 const asked=x.requests('get_pips_keep_running');assert.equal(asked.length,1);
 x.d.querySelector(`[data-job="${pipId}"]`).click();await x.drain();
 x.answer(asked[0],{keep_running:{platform:'linux',supported:true,reason:'',on:true,starts_at_login:true,restarts_after_failure:true,while_logged_out:true}});await x.drain();
 x.d.getElementById('back-pips')?.click();await x.drain();
 assert.equal(x.d.getElementById('keep-running')?.checked,true,'the runner-wide answer is kept');
});
