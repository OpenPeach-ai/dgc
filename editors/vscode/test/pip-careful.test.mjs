// Careful mode on a Personal Pip's page (harness from pip-page.test.mjs). A Personal Pip's page, as on Grok's bots (Pips API 43): Info (Instructions, Routines, Notifications,
// Share as template), Links, Media and Files; its face and colour; routines the Pip suggests in its chat;
// and Pips settings for every computer and app. The founder: "Bots main settings are just Instructions
// and Routines... Very very easy. Pips should work this same way."
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewModule=load(await bundle('pipsView.ts'),name=>name==='vscode'?{}:require(name));
const routines=load(await bundle('pipRoutines.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32),R1='routine_'+'1'.repeat(32),R2='routine_'+'2'.repeat(32),RUN='run_'+'a'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(extra={})=>({id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Look after my inbox and tell me what matters.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true},...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const now=new Date().toISOString(),earlier=new Date(Date.now()-3600e3).toISOString();
const DAILY={kind:'schedule',schedule:{type:'daily',time:'08:00',timezone:'Asia/Kolkata',missed_policy:'coalesce_latest',dst_policy:'skip_gap_first_fold'}};
const routine=(extra={})=>({id:R1,pip_id:PIP,workspace_id:PW,title:'Morning brief',prompt:'Tell me what today looks like.',trigger:DAILY,label:'every day at 08:00',status:'on',created_by:'user',run_id:null,next_due_at:'2026-10-08T02:30:00Z',last_run_at:null,last_error:null,created_at:earlier,updated_at:earlier,...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({row=pip(),list=[],shared={},computers=null,apps=[],grants=[],notes=[],messages=[],apiVersion=44,careful={careful:true,sites:[]}}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const state={row,list,notes,careful};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[state.row]}),get_pip:()=>({pip:state.row}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:state.list}),
  list_pip_shared:()=>({pip_id:PIP,workspace_id:PW,kind:r.kind,items:shared[r.kind]||[]}),
  get_pip_computers:()=>computers,list_pip_apps:()=>({apps}),list_pip_action_grants:()=>({pip_id:PIP,grants}),
  list_pip_plugins:()=>({pip_id:PIP,plugins:[],installed:[]}),list_pip_notes:()=>({pip_id:PIP,notes:state.notes,max:60}),list_pip_sites:()=>({pip_id:PIP,...state.careful}),list_pip_attention:()=>({as_of:now,total:0,counts:{},by_pip:{},items:[],truncated:false})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 return {w,d:w.document,sent,answer,requests,drain,click,type,state};
}
async function openPage(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();x.click('[data-tab="job"]');await x.drain();}
const computerPip=()=>pip({computer_plan:{schema_version:1}});
const sites=n=>Array.from({length:n},(_,i)=>({site:`shop${i}.example`,at:now,by:'you'}));

test('a Pip with a computer shows Careful mode, on, with the sites it may visit; Remove and Show all',async()=>{
 const x=setup({row:computerPip(),careful:{careful:true,sites:sites(10)}});await openPage(x);
 const group=x.d.querySelector('[aria-label="Careful mode"]');assert.ok(group,'on its page');
 assert.match(group.textContent,/Careful mode.*asks before it opens a site for the first time, and before anything it read from your apps goes onto a website/);
 assert.equal(x.d.querySelector('#pipCareful').checked,true,'on by default');
 assert.equal(group.querySelectorAll('[data-site-forget]').length,8);
 x.click('[data-sites-all]');assert.equal(x.d.querySelectorAll('[data-site-forget]').length,10);
 x.click('[data-site-forget="shop3.example"]');await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('forget_pip_site').at(-1).request)),{type:'forget_pip_site',pip_id:PIP,site:'shop3.example'});
});

test('turning Careful mode off is yours alone, says what changes, and an older CLI or a Pip without a computer shows nothing',async()=>{
 const x=setup({row:computerPip()});await openPage(x);
 assert.match(x.d.querySelector('[aria-label="Careful mode"]').textContent,/None yet\. Sites you name in your chat, and ones you allow on its cards, show here\./);
 const box=x.d.querySelector('#pipCareful');box.checked=false;box.dispatchEvent(new x.w.Event('change',{bubbles:true}));await flush();
 const set=x.requests('set_pip_careful').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(set.request)),{type:'set_pip_careful',pip_id:PIP,on:false});
 x.answer(set,{pip_id:PIP,careful:false,sites:[]});await x.drain();
 assert.match(x.d.body.textContent,/Careful mode is off\. Its submits still wait for you\./);
 assert.match(x.d.querySelector('[aria-label="Careful mode"]').textContent,/Off: Ava opens any site/);
 const none=setup();await openPage(none);
 assert.equal(none.d.querySelector('[aria-label="Careful mode"]'),null,'no computer, no careful mode');
 assert.equal(none.requests('list_pip_sites').length,0);
 const old=setup({row:computerPip(),apiVersion:43});await openPage(old);
 assert.equal(old.requests('list_pip_sites').length,0);
});
