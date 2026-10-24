// A routine on your own app's event (Pips API 63): "When the shop app sends order.created". In a Personal Pip's
// Settings → Routines you choose When my app sends an event, choose the app and type the event or pick one it sent
// lately; the list says it in words. An older DGC (before API 63) is asked nothing new and offers no such choice.
// (Harness from pip-page.)
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
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32),R1='routine_'+'1'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pipRow={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Look after the shop.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const earlier=new Date(Date.now()-3600e3).toISOString();
const WHEN={kind:'app',app:'shop',event:'order.created'};
const routine=(extra={})=>({id:R1,pip_id:PIP,workspace_id:PW,title:'New orders',prompt:'Check the order and propose a dispatch.',trigger:WHEN,label:'when the shop app sends order.created',status:'on',created_by:'user',run_id:null,next_due_at:null,last_run_at:null,last_error:null,created_at:earlier,updated_at:earlier,...extra});
const tool=(name,kind)=>({name,kind,description:name.replace(/_/g,' '),input_schema:{type:'object'},moves_money:false,schema_digest:'b'.repeat(64)});
const shop={name:'shop',server:'app:shop',display_name:'Shop app',url:'http://127.0.0.1:5005/dgc/pips',connection_digest:'a'.repeat(64),summary:'1 read tool, 1 change tool',reads:1,changes:1,
 tools:[tool('get_order','read'),tool('create_dispatch','change')],created_at:earlier,updated_at:earlier,secret_rotated_at:earlier,pending:null};
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const clean=v=>JSON.parse(JSON.stringify(v));

function setup({apiVersion=63,list=[],apps=[shop],names=['order.created','order.paid']}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const state={list};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[pipRow]}),get_pip:()=>({pip:pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins:[],installed:[]}),list_apps:()=>({apps}),
  list_app_events:()=>({app:r.app,events:[],names}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:state.list}),list_pip_shared:()=>({pip_id:PIP,workspace_id:PW,kind:r.kind,items:[]}),
  list_pip_action_grants:()=>({pip_id:PIP,grants:[]})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 return {w,d:w.document,sent,answer,requests,drain,click,type,state};
}
async function openPage(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();x.click('[data-tab="job"]');await x.drain();}

test('its routines list asks for app-event routines and says one in words',async()=>{
 const x=setup({list:[routine()]});await openPage(x);
 const asked=x.requests('list_pip_routines');
 assert.ok(asked.length&&asked.every(m=>m.request.app_events===true),'API 63: routines on your app’s events too');
 assert.match(x.d.querySelector('.routine-row').textContent,/New orders.*When the shop app sends order\.created/);
 assert.doesNotMatch(x.d.querySelector('.routine-row').textContent,/next /,'no clock to show');
 x.click(`[data-routine-edit="${R1}"]`);await x.drain();
 assert.equal(x.d.querySelector('#routineKind').value,'app');
 assert.equal(x.d.querySelector('#routineApp').value,'shop');
 assert.equal(x.d.querySelector('#routineEvent').value,'order.created');
 const {type,app,limit}=x.requests('list_app_events')[0].request;
 assert.deepEqual([type,app,limit],['list_app_events','shop',20],'the names it sent lately, for picking one');
});

test('you add one: choose the app, then type the event or pick one it sent lately',async()=>{
 const x=setup();await openPage(x);
 x.click('[data-routine-new]');
 const kinds=[...x.d.querySelectorAll('#routineKind option')].map(o=>[o.value,o.textContent]);
 assert.deepEqual(kinds.find(k=>k[0]==='app'),['app','When my app sends an event']);
 x.type('#routineTitle','New orders');x.type('#routinePrompt','Check the order and propose a dispatch.');
 x.type('#routineKind','app');await x.drain();
 assert.equal(x.d.querySelector('#routineApp').value,'shop','your app, chosen already');
 assert.deepEqual([...x.d.querySelectorAll('#routineApp option')].map(o=>o.textContent),['Shop app']);
 assert.deepEqual([...x.d.querySelectorAll('#routineEvents option')].map(o=>o.value),['order.created','order.paid'],'the names it sent lately');
 assert.match(x.d.querySelector('#routine-form').textContent,/It runs once for each event your app sends, with what the app sent\./);
 x.type('#routineEvent','Order Created');
 x.d.querySelector('#routine-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 assert.match(x.d.querySelector('#routine-form .error').textContent,/lowercase letters, digits, dots, hyphens or underscores/);
 assert.equal(x.requests('add_pip_routine').length,0);
 x.type('#routineEvent','order.created');
 x.d.querySelector('#routine-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 const [added]=x.requests('add_pip_routine');
 assert.deepEqual(clean(added.request.trigger),WHEN);
 assert.equal(added.request.title,'New orders');
 x.state.list=[routine()];x.answer(added,{routine:routine()});await x.drain();
 assert.match(x.d.querySelector('.routine-row').textContent,/When the shop app sends order\.created/);
});

test('with no app of yours there is no such choice, and an older DGC is asked nothing new',async()=>{
 const none=setup({apps:[]});await openPage(none);
 none.click('[data-routine-new]');
 assert.ok(![...none.d.querySelectorAll('#routineKind option')].some(o=>o.value==='app'),'no app: not offered');
 const old=setup({apiVersion:62});await openPage(old);
 assert.ok(old.requests('list_pip_routines').every(m=>!('app_events' in m.request)),'API 62 takes no such field');
 old.click('[data-routine-new]');
 assert.ok(![...old.d.querySelectorAll('#routineKind option')].some(o=>o.value==='app'));
 assert.equal(old.requests('list_app_events').length,0);
});

test('a routine on an app event, checked and in words',()=>{
 assert.equal(routines.routineWhen(WHEN),'When the shop app sends order.created');
 assert.equal(routines.routineWhen({kind:'app',app:'my-shop',event:'order.paid'}),'When the my shop app sends order.paid');
 assert.equal(routines.routine(routine(),PIP).trigger.event,'order.created');
 for(const trigger of [{kind:'app',app:'Shop',event:'a'},{kind:'app',app:'shop',event:'Order Created'},{kind:'app',app:'shop'}])
  assert.throws(()=>routines.routine(routine({trigger}),PIP),/didn’t load/);
 assert.deepEqual(routines.routineDraft(routine(),'UTC'),{...routines.routineDraft(null,'UTC'),routineId:R1,routineTitle:'New orders',routinePrompt:'Check the order and propose a dispatch.',routineKind:'app',routineApp:'shop',routineEvent:'order.created'});
 const d={...routines.routineDraft(null,'UTC','shop'),routineTitle:'x',routinePrompt:'y',routineKind:'app'};
 assert.throws(()=>routines.routineFromDraft(d),/Say which event/);
 assert.throws(()=>routines.routineFromDraft({...d,routineApp:'',routineEvent:'a'}),/Choose the app/);
 assert.deepEqual(routines.routineFromDraft({...d,routineEvent:' order.created '}).trigger,WHEN);
 const card=routines.routineCardMarkup(routine({status:'suggested',created_by:'pip'}),{esc:s=>String(s)});
 assert.match(card,/Add this routine\? New orders.*When the shop app sends order\.created/s);
});
