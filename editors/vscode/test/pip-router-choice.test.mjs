// A Pip on DGC Router (Pips API 70): the Pips page's model menu and a Pip's own settings offer "DGC Router (any Pip
// system)" and each Pip system's models beside today's choices, while the Router is on; the choice is saved as the
// API takes it ({mode:'router'} or {mode:'router',system,model}); the chip names it; a Pip whose Default runs on the
// Router (Settings -> Models -> Pips) says so; and the host refuses a Router choice below API 70.
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
function setup({api=55,job=pip(),kind='personal',catalog={default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS}}={}){
 const dom=new JSDOM(view.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let current=job;
 w.TextEncoder=TextEncoder;w.DgcMarkdown=markdownModule.exports;w.HTMLCanvasElement.prototype.getContext=()=>null;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:[current]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),get_pip:()=>({pip:current}),list_pip_runs:()=>({runs:[]}),list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),list_pip_models:()=>catalog,
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:[]}),
  propose_pip_update:()=>({proposal:{id:'proposal_'+'1'.repeat(32),pip_id:PIP,expected_version:current.current_version,definition:{...current,...r.changes}}}),accept_pip_update:()=>{current={...current,model_choice:requests('propose_pip_update').at(-1).request.changes.model_choice,current_version:current.current_version+1};return{pip:current};}}[r.type]?.());
 async function drain(){for(let i=0;i<18;i++){await flush();let n=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answer(m,result);n++;}}if(!n)break;}await flush();}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const click=selector=>{const e=w.document.querySelector(selector);assert.ok(e,selector);e.click();};
 return{w,d:w.document,requests,drain,click,select:async()=>{await drain();click(`[data-job="${PIP}"]`);await drain();}};
}
const openList=async x=>{x.click('#chat-model');await x.drain();};
const chooseProvider=(x,key)=>{x.click('#chat-model-providers');x.click(`[data-chat-provider="${key}"]`);};

const ROUTER={enabled:true,systems:[{id:'nas',name:'NAS',online:true,models:[{name:'qwen3.5:9b',context_window:16384}]},
 {id:'gpu',name:'GPU box',online:false,models:[{name:'qwen3:8b',context_window:32768},{name:'hf.co/org/model:q4',context_window:8192}]}]};
const catalog=(extra={})=>({default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS,router:ROUTER,...extra});

test('the model menu offers DGC Router and each Pip system, and saves the choice as the API takes it',async()=>{
 const x=setup({api:70,catalog:catalog()});await x.select();await openList(x);
 chooseProvider(x,'router');
 const menu=x.d.querySelector('.composer-model-menu');
 assert.match(menu.textContent,/DGC Router/);
 assert.deepEqual([...x.d.querySelectorAll('[data-chat-model^="router"]')].map(b=>b.dataset.chatModel),['router','router:nas/qwen3.5:9b','router:gpu/qwen3:8b','router:gpu/hf.co/org/model:q4']);
 assert.match(x.d.querySelector('[data-chat-model="router:gpu/qwen3:8b"]').textContent,/GPU box · qwen3:8b \(offline\)/);
 x.click('[data-chat-model="router:gpu/hf.co/org/model:q4"]');await x.drain();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{model_choice:{mode:'router',system:'gpu',model:'hf.co/org/model:q4'}});
 assert.match(x.d.querySelector('#chat-model').textContent,/GPU box · hf\.co\/org\/model:q4/,'the chip names the system and model');
 await openList(x);
 chooseProvider(x,'router');
 x.click('[data-chat-model="router"]');await x.drain();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update').at(-1).request.changes)),{model_choice:{mode:'router'}});
 // Short enough for a side bar ("DGC Router (any Pip sy…" was cut there); the hover says the whole choice.
 assert.equal(x.d.querySelector('#chat-model .composer-model-name').textContent,'DGC Router');
 assert.match(x.d.querySelector('#chat-model').title,/DGC Router \(any Pip system\)/);
});

test('with the Router off, or a backend before API 70, no Router choice is offered; the host refuses one below 70',async()=>{
 for(const [api,list] of [[70,catalog({router:undefined})],[69,catalog()]]){
  const x=setup({api,catalog:list});await x.select();await openList(x);
  x.click('#chat-model-providers');
  assert.equal(x.d.querySelector('[data-chat-model^="router"]'),null,`api ${api}`);
  assert.equal(x.d.querySelector('[data-chat-provider="router"]'),null,`provider api ${api}`);
 }
 for(const api of [69,70]){
  const sent=[],posted=[];
  const editor=new view.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'p',request:{type:'propose_pip_update',pip_id:'pip_a',expected_version:1,changes:{model_choice:{mode:'router'}},reason:'Changed.'}});
  assert.equal(sent.length,api===70?1:0,`api ${api}`);
  if(api===69)assert.match(posted.at(-1).error.message,/Update DGC to run a Pip on DGC Router/);
 }
});

test('Default that runs on the Router says so',async()=>{
 const x=setup({api:70,catalog:catalog({router:{...ROUTER,pips_default:'router'}})});await x.select();await openList(x);
 assert.equal(x.d.querySelector('[data-chat-model="default"]').textContent,'Default (DGC Router · any Pip system)');
});

test('the Router choices are checked, labelled and read back',()=>{
 const router=model.pipRouter(ROUTER);
 assert.deepEqual(model.modelChoice('router',[],[],router),{mode:'router'});
 assert.deepEqual(model.modelChoice('router:nas/qwen3.5:9b',[],[],router),{mode:'router',system:'nas',model:'qwen3.5:9b'});
 assert.throws(()=>model.modelChoice('router:nas/other',[],[],router),/Choose Default or a model/);
 assert.throws(()=>model.modelChoice('router',[],[],null),/Choose Default or a model/,'the Router is off');
 assert.equal(model.modelValue({mode:'router',system:'gpu',model:'qwen3:8b'}),'router:gpu/qwen3:8b');
 assert.equal(model.modelLabel({mode:'router'}),'DGC Router (any Pip system)');
 assert.equal(model.modelLabel({mode:'router',system:'gpu',model:'qwen3:8b'}),'qwen3:8b on gpu (DGC Router)');
 assert.equal(model.pipRouter({enabled:false,systems:[]}),null);
 assert.equal(model.pipRouter({enabled:true,systems:[{id:'Bad Id',name:'x',models:[]}]}),null);
 for(const ok of [{mode:'router'},{mode:'router',system:'nas',model:'qwen3.5:9b'}])assert.equal(model.routerModelChoice(ok),true);
 for(const bad of [{mode:'router',system:'nas'},{mode:'router',system:'NAS',model:'m'},{mode:'router',base_url:'http://x'}])assert.equal(model.routerModelChoice(bad),false);
});
