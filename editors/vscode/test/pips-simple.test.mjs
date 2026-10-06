import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Simple Pips (Pips API 43): Personal Pips you meet rather than configure. Core is the Primary Pip,
// a new Pip is a character and a name, its chat opens on its own hello (DGC's hidden first turn is
// never shown as yours), and its computer is one button in the chat's header.
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule={exports:{}};new Function('module','exports','require',view)(viewModule,viewModule.exports,name=>name==='vscode'?{}:require(name));
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PROJECT='ws_'+'1'.repeat(32);
const workspaces=[{id:PW,name:'Personal',kind:'personal'},{id:PROJECT,name:'demo_project',kind:'project'}];
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,name,type,extra={})=>({id,workspace_id:PW,pip_type:type,name,goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const runId='run_'+'a'.repeat(32);
const message=(id,role,text,pipId,extra={})=>({id,pip_id:pipId,workspace_id:PW,role,text,run_id:runId,status:'succeeded',model:'m',created_at:'2026-10-06T09:47:00.000Z',...extra});
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

function setup({apiVersion=43,jobs=[],messages={},active=null,computer=null}={}){
 const dom=new JSDOM(viewModule.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set();let current=[...jobs];
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(code);
 const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(request,result,ok=true)=>{answered.add(request.id);send({type:'pipsReply',id:request.id,ok,...(ok?{result}:{error:result})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces,current_workspace_id:PROJECT}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:current.filter(p=>p.workspace_id===(r.workspace_id||PROJECT))}),
  get_pip:()=>({pip:current.find(p=>p.id===r.pip_id)}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:r.workspace_id||PW,revision:0,entries:[]}}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:messages[r.pip_id]||[],next_before_id:null,active_run:active&&active.pip===r.pip_id?{id:runId,status:'running',created_at:'2026-10-06T09:47:00.000Z',started_at:null,run_kind:'conversation'}:null,history_context_omitted_count:0,continuity:null,chat_controls:controls}),
  list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  get_pip_computer:()=>({computer:computer||{pip_id:r.pip_id,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(overrides={}){for(let round=0;round<14;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answer(m,result);count++;}}await flush();if(!count)break;}await flush();}
 send({type:'pipsConnection',apiVersion,connected:true,supported:true,enabled:true});
 return {w,d:w.document,sent,answer,requests,drain,addPip:p=>{current.push(p);},
  click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();},
  input:(s,value)=>{const e=w.document.querySelector(s);assert.ok(e,'Missing '+s);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));}};
}

test('on API 43 the view opens on your Pips, and with none it introduces Core',async()=>{
 const x=setup();await x.drain();
 assert.ok(x.requests('list_pips').some(r=>r.request.workspace_id===PW),'your Personal Pips, not the project');
 const meet=x.d.querySelector('[aria-label="Meet Core"]');assert.ok(meet);assert.match(meet.textContent,/Core is your Primary Pip/);
 assert.equal(x.d.querySelector('.tabs'),null,'no tabs, no job form');
});

test('Create Core makes Core with just its name, asks it to say hello, and opens its chat',async()=>{
 const x=setup();await x.drain();
 x.click('#create-core');
 const create=x.requests('create_pip')[0];assert.ok(create);
 assert.deepEqual(JSON.parse(JSON.stringify(create.request)),{type:'create_pip',workspace_id:PW,pip_type:'core',name:'Core',goal:'',source_ref:'HEAD',model_choice:{mode:'default'}});
 const core=pip('pip_'+'c'.repeat(32),'Core','core');x.addPip(core);x.answer(create,{pip:core});await flush();
 const hello=x.requests('introduce_pip')[0];assert.ok(hello,'it is asked to introduce itself');assert.deepEqual(JSON.parse(JSON.stringify(hello.request)),{type:'introduce_pip',pip_id:core.id});
 x.answer(hello,{});await x.drain();
 assert.ok(x.d.querySelector('.pip-topbar'),'its chat is open');assert.match(x.d.querySelector('.pip-pill').textContent,/Core/);
 assert.ok(x.requests('list_pip_messages').some(r=>r.request.pip_id===core.id));
});

test('New Pip is a character and a name: no name, no Pip; then it is made and says hello',async()=>{
 const core=pip('pip_'+'c'.repeat(32),'Core','core');
 const x=setup({jobs:[core]});await x.drain();
 assert.ok(x.d.querySelector(`[data-job="${core.id}"]`));assert.match(x.d.querySelector('.pip-rows').textContent,/Core/);
 x.click('#simple-new');
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog);assert.equal(dialog.querySelectorAll('[data-new-character]').length,7,'every character but Core');
 x.click('[data-new-character="quill"]');assert.equal(x.d.querySelector('[data-new-character="quill"]').getAttribute('aria-checked'),'true');
 x.click('#review-confirm');assert.equal(x.requests('create_pip').length,0);assert.match(x.d.querySelector('[role=dialog]').textContent,/Give it a name/);
 x.input('#newPipName','  Gmail ');x.click('#review-confirm');
 const create=x.requests('create_pip')[0];assert.equal(create.request.pip_type,'quill');assert.equal(create.request.name,'Gmail');assert.equal(create.request.goal,'');
 const gmail=pip('pip_'+'g'.repeat(32),'Gmail','quill');x.addPip(gmail);x.answer(create,{pip:gmail});await flush();
 assert.equal(x.requests('introduce_pip')[0].request.pip_id,gmail.id);x.answer(x.requests('introduce_pip')[0],{});await x.drain();
 assert.equal(x.d.querySelector('[role=dialog]'),null);assert.match(x.d.querySelector('.pip-pill').textContent,/Gmail/);
});

test('the chat never shows DGC\'s introduction turn as yours, and shows the Pip at work while it writes its hello',async()=>{
 const gmail=pip('pip_'+'g'.repeat(32),'Gmail','scout');
 const intro=message('message_1','user','This message is from DGC, not the user.',gmail.id,{intro:true,status:'running'});
 const x=setup({jobs:[gmail],messages:{[gmail.id]:[intro]},active:{pip:gmail.id}});await x.drain();
 x.click(`[data-job="${gmail.id}"]`);await x.drain();
 assert.doesNotMatch(x.d.querySelector('.conversation-log').textContent,/from DGC/);
 assert.match(x.d.querySelector('.pip-working')?.textContent||'',/Gmail is working/,'Gmail is writing its hello');
 const later=setup({jobs:[gmail],messages:{[gmail.id]:[{...intro,status:'succeeded'},message('message_2','assistant','Hi! I am Gmail.',gmail.id)]}});await later.drain();
 later.click(`[data-job="${gmail.id}"]`);await later.drain();
 assert.match(later.d.querySelector('.conversation-log').textContent,/Hi! I am Gmail/);assert.doesNotMatch(later.d.querySelector('.conversation-log').textContent,/from DGC/);
 assert.equal(later.d.querySelector('.pip-working'),null);
 assert.equal(later.d.querySelector('#chatText').getAttribute('placeholder'),'Ask Gmail');
});

test('while a Pip answers it is in the chat at work, with its name, and its reply shows as short bubbles',async()=>{
 const gmail=pip('pip_'+'g'.repeat(32),'Gmail','scout');
 const asked=message('message_1','user','Can you check my inbox?',gmail.id,{status:'running',created_at:'2026-10-06T10:00:00.000Z'});
 const x=setup({jobs:[gmail],messages:{[gmail.id]:[asked]},active:{pip:gmail.id}});await x.drain();
 x.click(`[data-job="${gmail.id}"]`);await x.drain();
 const working=x.d.querySelector('.pip-working');assert.ok(working,'not only for its hello');assert.match(working.textContent,/Gmail is working/);
 assert.equal(working.querySelector('.avatar').dataset.pose,'working');
 const done=setup({jobs:[gmail],messages:{[gmail.id]:[{...asked,status:'succeeded'},message('message_2','assistant','Hi!\n\nYour inbox has 3 new emails.\n\nWant a summary?',gmail.id,{created_at:'2026-10-06T10:00:05.000Z'})]}});await done.drain();
 done.click(`[data-job="${gmail.id}"]`);await done.drain();
 assert.equal(done.d.querySelectorAll('.reply-part').length,3);assert.equal(done.d.querySelector('.pip-working'),null);
 assert.equal(done.d.querySelectorAll('.chat-time').length,1,'one time mark for messages minutes apart');
});

test('the computer button gives a Pip a computer, or opens the one it has',async()=>{
 const gmail=pip('pip_'+'g'.repeat(32),'Gmail','scout');
 const x=setup({jobs:[gmail]});await x.drain();x.click(`[data-job="${gmail.id}"]`);await x.drain();
 x.click('#pip-computer-open');await x.drain();
 assert.match(x.d.querySelector('[role=dialog]').textContent,/Give Gmail a computer\?/);
 const y=setup({jobs:[gmail],computer:{pip_id:gmail.id,granted:true,available:true,reason:'',pending:0,actions:[]}});await y.drain();y.click(`[data-job="${gmail.id}"]`);await y.drain();
 y.click('#pip-computer-open');await y.drain();
 assert.equal(y.requests('open_pip_computer').length,1,'its screen opens');
});

test('back returns to your Pips, and the menu reaches Results and Settings',async()=>{
 const gmail=pip('pip_'+'g'.repeat(32),'Gmail','scout');
 const x=setup({jobs:[gmail]});await x.drain();x.click(`[data-job="${gmail.id}"]`);await x.drain();
 x.click('.pip-menu [data-tab="job"]');await x.drain();
 assert.match(x.d.body.textContent,/What it does/);assert.ok(x.d.querySelector('#simple-to-chat'));
 x.click('#simple-to-chat');await x.drain();assert.ok(x.d.querySelector('#chatText'));
 x.click('#simple-back');await x.drain();assert.ok(x.d.querySelector('.pip-rows'));
});

test('an older CLI keeps the full Pips view',async()=>{
 const x=setup({apiVersion:42});await x.drain();
 assert.equal(x.d.querySelector('[aria-label="Meet Core"]'),null);
 assert.ok(x.requests('list_pips').length>0);assert.ok(x.requests('list_pips').every(r=>r.request.workspace_id===PROJECT),'it stays on the project, as before');
});

test('the extension host sends introduce_pip only to an API 43 CLI',()=>{
 for(const api of [42,43]){
  const posted=[],sent=[];const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{}:require(name));
  const editor=new out.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'hello',request:{type:'introduce_pip',pip_id:'pip_'+'g'.repeat(32)}});
  assert.equal(sent.length,api>=43?1:0,`API ${api}`);
  if(api<43)assert.match(posted.at(-1).error.message,/API 43/);
 }
});
