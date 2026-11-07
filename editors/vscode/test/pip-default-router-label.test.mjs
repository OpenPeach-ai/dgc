// A Pip on Default when Settings -> Models -> Pips run on the Router (reported 2026-11-02: its menu and chip still said
// "Default (<main model>)"). Default names where it runs: "DGC Router · any Pip system" or the chosen system and model,
// and an open Pips page reads the model list again when Settings are saved or the Router's settings change.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const markdownCode=(await build({entryPoints:[new URL('markdown.ts',base).pathname],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const markdownModule={exports:{}};new Function('module','exports','require',markdownCode)(markdownModule,markdownModule.exports,require);
const bridge=(await build({entryPoints:[new URL('pipsView.ts',base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const model=await import(new URL('pipsModel.js',base).href);
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'t'.repeat(32);
const view=(()=>{const m={exports:{}};new Function('module','exports','require',bridge)(m,m.exports,name=>name==='vscode'?{}:require(name));return m.exports;})();
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(extra={})=>({id:PIP,workspace_id:PW,pip_type:'lens',name:'Tees',goal:'Help with what I ask.',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,model_choice:{mode:'default'},source_policy:{mode:'personal'},...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:65536,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const SUBS=[{engine:'claude',name:'Claude Code'},{engine:'codex',name:'Codex'}];
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function setup({api=55,job=pip(),kind='personal',messages=[],catalog={default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS}}={}){
 let cat=catalog;
 const dom=new JSDOM(view.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let current=job;
 w.TextEncoder=TextEncoder;w.DgcMarkdown=markdownModule.exports;w.HTMLCanvasElement.prototype.getContext=()=>null;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:[current]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),get_pip:()=>({pip:current}),list_pip_runs:()=>({runs:[]}),list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),list_pip_models:()=>cat,
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:[]}),
  propose_pip_update:()=>({proposal:{id:'proposal_'+'1'.repeat(32),pip_id:PIP,expected_version:current.current_version,definition:{...current,...r.changes}}}),accept_pip_update:()=>{current={...current,model_choice:requests('propose_pip_update').at(-1).request.changes.model_choice,current_version:current.current_version+1};return{pip:current};}}[r.type]?.());
 async function drain(){for(let i=0;i<18;i++){await flush();let n=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answer(m,result);n++;}}if(!n)break;}await flush();}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const click=selector=>{const e=w.document.querySelector(selector);assert.ok(e,selector);e.click();};
 return{w,d:w.document,requests,drain,click,message,setCatalog:value=>{cat=value;},select:async()=>{await drain();click(`[data-job="${PIP}"]`);await drain();}};
}
const openList=async x=>{x.click('#chat-model');await x.drain();};
const ROUTER={enabled:true,systems:[{id:'nas',name:'NAS',online:true,models:[{name:'qwen3.5:9b',context_window:16384}]}]};
const catalog=(extra={})=>({default_model:'deepseek-v4.1-flash:cloud',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS,router:ROUTER,...extra});

test('Default names the Router: any Pip system, or the chosen system and model, in the menu and on the chip',async()=>{
 for(const [pin,words] of [['router','DGC Router · any Pip system'],['router:nas/qwen3.5:9b','NAS · qwen3.5:9b']]){
  const x=setup({api:70,catalog:catalog({router:{...ROUTER,pips_default:pin}})});await x.select();await openList(x);
  assert.equal(x.d.querySelector('[data-chat-model="default"]').textContent,`Default (${words})`,pin);
  // The chip says Default as the menu row does (seen in testing: it read "NAS · qwen3.5:9b", the same as choosing it).
  assert.equal(x.d.querySelector('#chat-model .composer-model-name').textContent,`Default (${words})`,'the chip of a Pip on Default');
  assert.doesNotMatch(x.d.querySelector('#chat-model').textContent,/deepseek/);
 }
});

test('an open Pips page reads the list again when Settings or the Router change',async()=>{
 const x=setup({api:70,catalog:catalog()});await x.select();await openList(x);
 assert.equal(x.d.querySelector('#chat-model .composer-model-name').textContent,'Default (deepseek-v4.1-flash:cloud)');
 const before=x.requests('list_pip_models').length;
 x.setCatalog(catalog({router:{...ROUTER,pips_default:'router'}}));     // Settings -> Pips run on: any Pip system
 x.message({type:'pipsModelsChanged'});await x.drain();
 assert.equal(x.requests('list_pip_models').length,before+1);
 assert.equal(x.d.querySelector('#chat-model .composer-model-name').textContent,'Default (DGC Router · any Pip system)');
});

// Seen in testing: in the side bar the chip was cut to "DGC Router (any Pip sy…", and nothing said which computer
// answered. It reads "DGC Router", then the system the last reply came from (the reply keeps it); the hover says it all.
test('a Pip on DGC Router (any system): a short chip that names the computer that answered last',async()=>{
 const reply=(id,model)=>({id,pip_id:PIP,workspace_id:PW,role:'assistant',text:'Blue.',run_id:'run_'+id.padEnd(32,'0'),status:'succeeded',model,created_at:'2026-11-02T10:00:00.000Z'});
 const fresh=setup({api:70,job:pip({model_choice:{mode:'router'}}),catalog:catalog()});await fresh.select();
 const chip=fresh.d.querySelector('#chat-model');
 assert.equal(chip.querySelector('.composer-model-name').textContent,'DGC Router');
 assert.match(chip.title,/^DGC Router \(any Pip system\)/);
 const x=setup({api:70,job:pip({model_choice:{mode:'router'}}),catalog:catalog(),messages:[reply('m1','qwen3.5:9b on NAS (DGC Router)'),reply('m2','glm-5.3:cloud on Workstation (DGC Router)')]});await x.select();
 const named=x.d.querySelector('#chat-model');
 assert.equal(named.querySelector('.composer-model-name').textContent,'DGC Router · Workstation','the newest reply\'s computer');
 assert.match(named.title,/DGC Router \(any Pip system\) · the last reply came from Workstation · glm-5\.3:cloud/);
 const pinned=setup({api:70,job:pip({model_choice:{mode:'router',system:'nas',model:'qwen3.5:9b'}}),catalog:catalog()});await pinned.select();
 assert.equal(pinned.d.querySelector('#chat-model .composer-model-name').textContent,'NAS · qwen3.5:9b');
});

test('the host tells every Pips page when Settings or the Router change',()=>{
 const posted=[];const editor=new view.PipsEditor({},()=>true,()=>{});editor.attach(m=>posted.push(m));
 editor.modelsChanged();
 assert.deepEqual(posted.at(-1),{type:'pipsModelsChanged'});
});

test('what Default runs on, in words',()=>{
 const {defaultRunsOn}=model;
 assert.equal(defaultRunsOn(catalog({router:{...ROUTER,pips_default:'router'}})),'DGC Router · any Pip system');
 assert.equal(defaultRunsOn(catalog({router:{...ROUTER,pips_default:'router:nas/qwen3.5:9b'}})),'NAS · qwen3.5:9b');
 assert.equal(defaultRunsOn(catalog({router:{...ROUTER,pips_default:'router:gone/m1'}})),'DGC Router · gone · m1','a choice no longer offered still says the Router');
 assert.equal(defaultRunsOn(catalog()),'deepseek-v4.1-flash:cloud','not on the Router: the model');
 assert.equal(defaultRunsOn({default_model:'',default_engine:{engine:'codex',name:'Codex',available:true}}),'Codex');
});

test('in the sidebar too: the main panel hands the Pips page the news',async()=>{
 const {makeDom}=await import('./support/webview-dom.mjs');
 const x=makeDom();const received=[];
 try{
  x.dom.window.DgcPips={mount:options=>{options.onMessage(m=>received.push(m));return{setVisible(){}};}};
  x.send({type:'pipsOpen'});
  x.send({type:'pipsModelsChanged'});
  assert.deepEqual(received.map(m=>m.type),['pipsModelsChanged']);
  assert.deepEqual(x.errors,[]);
 }finally{x.dom.window.close();}
});
