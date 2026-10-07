// Thousands of Pips: the home pages, searches and keeps the open Pip; Pips settings sets how many. (Harness from pip-plugins.)
// A Pip asks before it uses one of your plugins, as Grok asks before a bot uses a connector (Pips API 44).
// The Pip calls use_plugin; this card is the user's side (Allow, no second sign-in, or Not now). What the
// Pip would then do in the plugin is an Allow card: Allow, Always allow, Don't. A plugin that can move
// money asks every time: its card has no Always allow.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewCode=await bundle('pipsView.ts');
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32),CARD='pipplugin_'+'a'.repeat(32),MONEY='pipplugin_'+'b'.repeat(32);
const RUN='run_'+'5'.repeat(32),DRAFT='conndraft_'+'3'.repeat(32),ACTION='appaction_'+'2'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pipRow={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const card=(extra={})=>({id:CARD,pip_id:PIP,workspace_id:PW,plugin:'airtable',name:'Airtable',reason:'To keep your weekend plan in a table.',status:'requested',installed:true,money:false,servers:['airtable'],created_at:'2026-10-07T09:00:00.000Z',updated_at:new Date().toISOString(),...extra});
const aave=(extra={})=>card({id:MONEY,plugin:'aave',name:'Aave',reason:'To check rates.',money:true,servers:['aave'],...extra});
const installed=[{plugin:'aave',name:'Aave',money:true},{plugin:'airtable',name:'Airtable',money:false}];
const source={run_id:RUN,pip_id:PIP,workspace_id:PW,job_version:1,lifecycle_revision:0,result_digest:'e'.repeat(64)};
const call={tool:'create_record',arguments:{table:'Plans',fields:{Name:'Run <b>5k</b>'}}};
const draft=(server='airtable',extra={})=>({id:DRAFT,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status:'pending',digest:'c'.repeat(64),expired:false,expires_at:'2099-10-05T06:00:00Z',action_id:null,created_at:'2026-10-07T09:00:00.000Z',actor:'pip-connector:'+RUN,request_key:'f'.repeat(64),payload:{schema_version:1,source,action:{server,connection_digest:'a'.repeat(64),schema_digest:'b'.repeat(64),call}},...extra});
const action=(server='airtable',status='pending')=>({id:ACTION,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status,digest:'d'.repeat(64),expires_at:'2099-10-05T06:00:00Z',payload:{schema_version:3,kind:'connector_call',source,server,connection_digest:'a'.repeat(64),account:'connection_managed',schema_digest:'b'.repeat(64),call},receipt:null});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));

function setup({plugins=[],drafts=[],apiVersion=44,messages=[],activeRun=null,activity=[],stats=[],many=250,limitState={max_pips:100,default:100,maximum:100000}}={}){
 const crowd=[pipRow,...Array.from({length:many},(_,i)=>({...pipRow,id:'pip_'+String(i).padStart(32,'0'),name:'Helper '+String(i).padStart(4,'0'),pip_type:'scout'}))];
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const summary=d=>({id:d.id,pip_id:d.pip_id,workspace_id:d.workspace_id,status:d.status,expired:d.expired,subject:d.payload.action.call.tool,digest:d.digest,source_run_id:d.source_run_id,expires_at:d.expires_at,action_id:d.action_id});
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>{const q=(r.query||'').toLowerCase(),all=crowd.filter(p=>!q||p.name.toLowerCase().includes(q)),o=r.offset||0,l=r.limit||100,page=all.slice(o,o+l);return {pips:page,total:all.length,next_offset:o+page.length<all.length?o+page.length:null};},get_pips_limit:()=>limitState,set_pips_limit:()=>({...limitState,max_pips:r.max_pips}),list_pip_apps:()=>({apps:[]}),get_pip:()=>({pip:crowd.find(p=>p.id===r.pip_id)||pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages,next_before_id:null,active_run:activeRun,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins,installed}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:drafts.map(summary),next_cursor:null}),get_pip_connector_draft:()=>({draft:drafts.find(d=>d.id===r.draft_id)}),
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_run_activity:()=>({run_id:RUN,pip_id:PIP,workspace_id:PW,events:r.after?[]:activity,next_cursor:r.after||activity.length,has_more:false,history_may_be_truncated:false,retention_limit:500,retention_scope:'workspace'}),list_pip_reply_stats:()=>({pip_id:PIP,stats}),get_pip_chat_context:()=>({pip_id:PIP,context_size:r.context_size,used_tokens:10,brief_tokens:0,recent_messages:0,summarized_messages:0}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,setPlugins:v=>{plugins=v;},setDrafts:v=>{drafts=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const clean=v=>JSON.parse(JSON.stringify(v));



test('a thousand Pips: the most recent hundred, how many there are, Load more and a search',async()=>{
 const x=setup();await x.drain();
 const first=x.requests('list_pips')[0];assert.deepEqual(clean(first.request),{type:'list_pips',workspace_id:PW,order:'recent',limit:100});
 assert.equal(x.d.querySelectorAll('.pip-row').length,100);
 assert.match(x.d.querySelector('.pip-search-count').textContent,/Showing 100 of 251/);
 x.click('#pips-more');await x.drain();
 assert.equal(x.requests('list_pips').at(-1).request.offset,100);
 assert.equal(x.d.querySelectorAll('.pip-row').length,200);
 const box=x.d.getElementById('pip-search');box.value='helper 012';box.dispatchEvent(new x.w.Event('input',{bubbles:true}));
 await new Promise(r=>setTimeout(r,300));await x.drain();
 const searched=x.requests('list_pips').at(-1);assert.equal(searched.request.query,'helper 012');assert.equal(searched.request.offset,undefined);
 assert.equal(x.d.querySelectorAll('.pip-row').length,10);assert.match(x.d.querySelector('.pip-search-count').textContent,/10 found/);
 assert.equal(x.d.querySelector('.core-offer'),null,'no "Meet Core" while searching');
 const again=x.d.getElementById('pip-search');again.value='nobody';again.dispatchEvent(new x.w.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,300));await x.drain();
 assert.match(x.d.body.textContent,/No Pip is named “nobody”/);
});
test('the open Pip stays open when a refresh brings only the first page',async()=>{
 const x=setup();await x.drain();
 const id='pip_'+'150'.padStart(32,'0');
 x.click('#pips-more');await x.drain();x.click(`[data-job="${id}"]`);await x.drain();
 assert.match(x.d.querySelector('.pip-topbar')?.textContent||'',/Helper 0150/,'Helper 0150 is open');
 const before=x.requests('list_pips').length;await new Promise(r=>setTimeout(r,4300));await x.drain();
 assert.ok(x.requests('list_pips').length>before,'the chat’s 4 s refresh ran');
 assert.equal(x.requests('list_pips').at(-1).request.offset,undefined,'the refresh read the first page');
 assert.match(x.d.querySelector('.pip-topbar')?.textContent||'',/Helper 0150/,'and it is still open');
});
// Opened from elsewhere (the Sessions home, a notification): the embedded mount's navigate.
function mountSetup(){
 const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();let receive;
 w.TextEncoder=TextEncoder;w.HTMLCanvasElement.prototype.getContext=()=>null;w.eval(client);
 const instance=w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),onMessage:fn=>{receive=fn;}});
 const crowd=[pipRow,...Array.from({length:250},(_,i)=>({...pipRow,id:'pip_'+String(i).padStart(32,'0'),name:'Helper '+String(i).padStart(4,'0'),pip_type:'scout'}))];
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const reply=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>{const o=r.offset||0,l=r.limit||100,page=crowd.slice(o,o+l);return {pips:page,total:crowd.length,next_offset:o+page.length<crowd.length?o+page.length:null};},
  get_pip:()=>({pip:crowd.find(p=>p.id===r.pip_id)}),list_pip_runs:()=>({runs:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),
  list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:r.pip_id,granted:false,available:true,reason:'',pending:0,actions:[]}}),list_pip_app_links:()=>({pip_id:r.pip_id,links:[],composio:true}),list_pip_plugins:()=>({pip_id:r.pip_id,plugins:[],installed:[]}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),list_pip_routines:()=>({pip_id:r.pip_id,routines:[]}),
  get_pip_chat_context:()=>({pip_id:r.pip_id,context_size:r.context_size,used_tokens:0,brief_tokens:0,recent_messages:0,summarized_messages:0}),get_pip_digest:()=>undefined}[r.type]?.());
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 async function drain(){for(let n=0;n<18;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=reply(m.request);if(result!==undefined){answered.add(m.id);receive({type:'pipsReply',id:m.id,ok:true,result});}}}}
 receive({type:'pipsConnection',apiVersion:44,generation:1,connected:true,supported:true,enabled:true});receive({type:'pipsVisibility',visible:true});
 return {w,d:w.document,instance,requests,drain};
}
test('a Pip opened from elsewhere, past the first hundred, opens and stays open through a refresh',async()=>{
 const x=mountSetup();await x.drain();
 const id='pip_'+'230'.padStart(32,'0');
 const opening=x.instance.navigate({pip:id,workspace:PW});await x.drain();await opening;await x.drain();
 assert.match(x.d.querySelector('.pip-topbar')?.textContent||'',/Helper 0230/,'it opens, not “This Pip is not available”');
 const before=x.requests('list_pips').length;await new Promise(r=>setTimeout(r,4300));await x.drain();
 assert.ok(x.requests('list_pips').length>before,'the chat’s 4 s refresh ran');
 assert.match(x.d.querySelector('.pip-topbar')?.textContent||'',/Helper 0230/,'and it is still open');
});
test('Pips settings: how many Pips you can have',async()=>{
 const x=setup({many:3});await x.drain();
 x.click('#pips-settings-open');await x.drain();x.click('[data-pips-settings="apps"]');await x.drain();
 const input=x.d.getElementById('pipsMax');assert.ok(input,'the field');assert.equal(input.value,'100');
 assert.match(x.d.querySelector('#pips-limit-form').textContent,/How many Pips you can have.*100 unless you choose another number, up to 100,000\. Archived Pips don’t count\./);
 input.value='5000';input.dispatchEvent(new x.w.Event('input',{bubbles:true}));
 x.d.getElementById('pips-limit-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await x.drain();
 assert.deepEqual(clean(x.requests('set_pips_limit')[0].request),{type:'set_pips_limit',max_pips:5000});
 assert.match(x.d.body.textContent,/You can have up to 5,000 Pips\./);
});
