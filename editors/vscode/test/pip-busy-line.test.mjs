// "Too many pending Pip controls; wait and retry." is DGC saying its queue of Pip controls was full for a moment and
// nothing ran. Release check, 2026-11-03: after Start Pips, Create Core, one message and back, the line stayed on the
// Pips home and in Core's chat until a window reload. It goes as soon as a later control gets through.
// (Harness from pip-careful.test.mjs.)
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewModule=load(await bundle('pipsView.ts'),name=>name==='vscode'?{}:require(name));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32);
const BUSY='Too many pending Pip controls; wait and retry.';
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Look after my inbox and tell me what matters.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const now=new Date().toISOString();
async function flush(w){for(let i=0;i<15;i++)await Promise.resolve();await new Promise(r=>w.setTimeout(r,5));for(let i=0;i<15;i++)await Promise.resolve();}

function setup(){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const reply=(m,data)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,...data});};
 const busy=m=>reply(m,{ok:false,error:{code:'busy',message:BUSY}});
 const waiting=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type&&!answered.has(m.id));
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const results={list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[pip]}),get_pip:()=>({pip}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:[]}),list_pip_shared:r=>({pip_id:PIP,workspace_id:PW,kind:r.kind,items:[]}),
  get_pip_computers:()=>null,list_pip_apps:()=>({apps:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),list_pip_notes:()=>({pip_id:PIP,notes:[],max:60}),
  list_pip_sites:()=>({pip_id:PIP,careful:true,sites:[]}),
  list_pip_plugins:()=>({pip_id:PIP,plugins:[],installed:[]}),list_pip_attention:()=>({as_of:now,total:0,counts:{},by_pip:{},items:[],truncated:false})};
 // Answers everything still waiting, except what `hold` names.
 async function drain(hold=[]){for(let n=0;n<15;n++){await flush(w);for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id)&&!hold.includes(m.request.type))){const result=results[m.request.type]?.(m.request);if(result!==undefined)reply(m,{ok:true,result});}}}
 message({type:'pipsConnection',apiVersion:44,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 const alerts=()=>[...w.document.querySelectorAll('[role="alert"]')].map(n=>n.textContent);
 return {w,d:w.document,busy,reply,waiting,drain,click,alerts};
}

// The page's own refresh, every 4 s while a chat is open: its list of Pips and the runner.
async function nextRefresh(x){
 for(let i=0;i<60;i++){const [list]=x.waiting('list_pips'),[runner]=x.waiting('get_pip_runner');if(list&&runner)return [list,runner];await new Promise(r=>x.w.setTimeout(r,100));}
 assert.fail('the page never refreshed');
}
const RUNNER={runner:{runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}}};

test('the busy line goes as soon as a later Pip control gets through, in a Pip’s chat and on the Pips home', async()=>{
 const x=setup();await x.drain();
 x.click(`[data-job="${PIP}"]`);await x.drain();
 assert.ok(x.d.querySelector('#chat-form'),'Ava’s chat is open');
 // A refresh while DGC's queue is full: its reads are refused, and so are its reads of the open Pip.
 const [list,runner]=await nextRefresh(x);
 x.busy(list);x.busy(runner);await flush(x.w);
 const [get]=x.waiting('get_pip'),[runs]=x.waiting('list_pip_runs');
 x.busy(get);x.busy(runs);await flush(x.w);
 assert.deepEqual(x.alerts(),[BUSY],'DGC said to wait, and the chat shows it');
 // The rest of what the page asked gets through: there is room again, and the line goes.
 await x.drain();
 assert.deepEqual(x.alerts(),[],'the chat is clear');
 x.click(x.d.querySelector('#simple-back')?'#simple-back':'#back-pips');await x.drain();
 assert.ok(x.d.querySelector('[data-job]')&&!x.d.querySelector('#chat-form'),'back on the Pips home');
 assert.deepEqual(x.alerts(),[],'and so is the Pips home');
});

test('a refresh refused in part, then answered, says nothing; any other error stays until you act on it', async()=>{
 // Refused in part: the runner got through in the same refresh, so the queue had room again by then.
 const y=setup();await y.drain();
 y.click(`[data-job="${PIP}"]`);await y.drain();
 const [busyList,goodRunner]=await nextRefresh(y);
 y.busy(busyList);y.reply(goodRunner,{ok:true,result:RUNNER});await y.drain();
 assert.deepEqual(y.alerts(),[]);
 const x=setup();await x.drain();
 x.click(`[data-job="${PIP}"]`);await x.drain();
 const [list,runner]=await nextRefresh(x);
 x.reply(list,{ok:false,error:{code:'storage',message:'The Pips database could not be read.'}});x.reply(runner,{ok:true,result:RUNNER});
 await x.drain();
 assert.deepEqual(x.alerts(),['The Pips database could not be read.']);
});
