// pips-10, slice 2a: a Personal Pip's own API key (Pips API 82: list_pip_keys, save_pip_key, decline_pip_key,
// remove_pip_key). The Pip asks for a web API's key on a card in its chat, in the look of a plugin's key card:
// "<Pip> needs the <name>", why, one masked box, "Only sent to <host>, by DGC. <Pip> never sees it.", Save (filled, off
// until something is typed) and Not now. Saved: "Saved · it never saw the key". Not now: one quiet line. A key its site
// turned away says so and asks for a new one. The key is read from its box when Save is pressed, sent once, and the
// box emptied: it is never in the page's markup, its kept state or any other message. On the Pip's page, Keys lists
// each with its site and where it stands, and Remove asks first. An older DGC (API 81) shows and is sent none.
// (Harness from pip-key-card.test.mjs. How it looks: pip-own-key-card-browser.test.mjs.)
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
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'9'.repeat(32),KEYID='pipkey_'+'a'.repeat(32),KEYID2='pipkey_'+'b'.repeat(32),KEYID3='pipkey_'+'c'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pipRow={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
// A stand-in, never a real key.
const KEY='inv_test_0123456789abcdefSECRET';
const key=(extra={})=>({id:KEYID,pip_id:PIP,workspace_id:PW,kind:'site',name:'Invoicely API key',why:'To read your unpaid invoices.',host:'api.invoicely.example',header:'Authorization: Bearer',status:'requested',saved:false,refused:false,created_at:'2026-11-11T09:00:00Z',saved_at:null,declined_at:null,...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));

function setup({keys=[key()],apiVersion=82}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[pipRow]}),get_pip:()=>({pip:pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins:[],key_requests:[],installed:[]}),
  list_pip_keys:()=>({pip_id:PIP,keys}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined,
  list_pip_apps:()=>({apps:[]}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,setKeys:v=>{keys=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
async function openPage(x){await openChat(x);x.click('[data-tab="job"]');await x.drain();}
const clean=v=>JSON.parse(JSON.stringify(v));
const cardOf=(x,id=KEYID)=>x.d.querySelector(`[data-pip-key-card="${id}"]`);
const box=(x,id=KEYID)=>x.d.querySelector(`[data-pip-key-card="${id}"] input`);
const type=(x,el,value)=>{el.value=value;el.dispatchEvent(new x.w.Event('input',{bubbles:true}));};
const saveButton=x=>cardOf(x).querySelector('button.primary');
const submit=x=>cardOf(x).querySelector('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));
// Everything the page holds or said, but the one request that carries the key to DGC.
const everywhere=x=>x.d.documentElement.outerHTML+JSON.stringify(x.sent.filter(m=>m.type!=='pipsRequest'||m.request.type!=='save_pip_key'));

test('a key the Pip asked for is a card in its chat: who needs what and why, where it goes, one masked box, Save off until something is typed',async()=>{
 const x=setup();await openChat(x);
 const el=cardOf(x);assert.ok(el,'the card is in the chat');
 assert.ok(el.classList.contains('dgc-card')&&el.classList.contains('key-card'),'the shared card, in the plugin key card\'s look');
 assert.equal(el.dataset.state,'requested');
 assert.equal(el.querySelector('strong').textContent,'Ava needs the Invoicely API key');
 assert.equal(el.getAttribute('aria-label'),'Ava needs the Invoicely API key');
 assert.equal(el.querySelector('.dgc-card-words small').textContent,'To read your unpaid invoices.');
 assert.match(el.textContent,/Only sent to api\.invoicely\.example, by DGC\. Ava never sees it\./);
 const inputs=[...el.querySelectorAll('input')];assert.equal(inputs.length,1,'one box');
 const input=inputs[0];
 assert.deepEqual([input.type,input.getAttribute('autocomplete'),input.getAttribute('spellcheck'),input.hasAttribute('value'),input.hasAttribute('data-draft')],['password','off','false',false,false],'masked, never offered back, no spellcheck, never a draft');
 assert.equal(x.d.querySelector(`label[for="${input.id}"]`).textContent,'Invoicely API key','its label is the key\'s name');
 assert.deepEqual([...el.querySelectorAll('.dgc-card-actions button')].map(b=>[b.textContent,b.classList.contains('primary'),b.disabled]),[['Save',true,true],['Not now',false,false]],'one filled answer, off until the box has text');
 assert.equal(el.querySelector('[data-pip-key-refused]'),null,'nothing about a refused key');
 type(x,input,'   ');assert.equal(saveButton(x).disabled,true,'spaces are not a key');
 type(x,input,KEY);assert.equal(saveButton(x).disabled,false,'with text, Save is on');
 type(x,input,'');assert.equal(saveButton(x).disabled,true,'emptied, off again');
});

test('Save sends exactly the Pip, the card and the key, once; the box is emptied; then "Saved · it never saw the key" and the key is nowhere',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);
 // A redraw while the key is in its box (the chat polls) leaves it there, and Save on.
 x.w.dispatchEvent(new x.w.MessageEvent('message',{data:{type:'pipsConnection',apiVersion:82,generation:1,connected:true,supported:true,enabled:true}}));await x.drain();
 assert.deepEqual([box(x).value,saveButton(x).disabled],[KEY,false],'a redraw keeps what was typed');
 assert.ok(!everywhere(x).includes(KEY),'the key is in its box and nowhere else: not the markup, not a message');
 const chats=x.requests('list_pip_messages').length;
 submit(x);await flush();
 const sent=x.requests('save_pip_key');assert.equal(sent.length,1);
 assert.deepEqual(clean(sent[0].request),{type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY});
 assert.equal(box(x).value,'','the box is emptied as it is sent');
 assert.deepEqual([saveButton(x).disabled,saveButton(x).textContent],[true,'Saving…']);
 submit(x);await flush();assert.equal(x.requests('save_pip_key').length,1,'never sent twice');
 x.setKeys([key({status:'saved',saved:true,saved_at:'2026-11-11T09:01:00Z'})]);x.answer(sent[0],{key:key({status:'saved',saved:true,saved_at:'2026-11-11T09:01:00Z'})});await x.drain();
 const done=cardOf(x);
 assert.equal(done.dataset.state,'saved');
 assert.match(done.textContent,/Ava has the Invoicely API key.*Saved · it never saw the key/);
 assert.equal(done.querySelector('input'),null,'no box any more');assert.equal(done.querySelector('button'),null,'and nothing to answer');
 assert.ok(!everywhere(x).includes(KEY),'the key is nowhere on the page after it was sent');
 assert.equal(x.d.querySelectorAll('input[type="password"]').length,0);
 assert.ok(x.requests('list_pip_messages').length>chats,'the chat reloads: the Pip carries on by itself');
});

test('a key DGC would not keep says why on the card, the box stays empty, and it can be pasted again',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);submit(x);await flush();
 x.answer(x.requests('save_pip_key')[0],'DGC couldn’t save the key on this computer.',false);await x.drain();
 const el=cardOf(x);
 assert.equal(el.dataset.state,'requested','it still waits');
 assert.match(el.querySelector('[role="alert"]').textContent,/couldn’t save the key/);
 assert.deepEqual([box(x).value,saveButton(x).disabled,saveButton(x).textContent],['',true,'Save']);
 assert.ok(!everywhere(x).includes(KEY));
 type(x,box(x),KEY);submit(x);await flush();
 assert.equal(x.requests('save_pip_key').length,2,'pasted again, sent again');
});

test('a key its site turned away says so and asks for a new one',async()=>{
 const x=setup({keys:[key({refused:true})]});await openChat(x);
 const el=cardOf(x);
 assert.equal(el.querySelector('[data-pip-key-refused]').textContent,'api.invoicely.example turned the saved key away. Paste a new one.');
 assert.deepEqual([box(x).type,box(x).value,saveButton(x).disabled],['password','',true]);
});

test('Not now declines the card and sends no key; the box is emptied and a quiet "Not now" line stays',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);
 x.click(`[data-pip-key-decline="${KEYID}"]`);await flush();
 assert.deepEqual(clean(x.requests('decline_pip_key')[0].request),{type:'decline_pip_key',pip_id:PIP,key_id:KEYID});
 assert.equal(x.requests('save_pip_key').length,0);
 const declined=key({status:'declined',declined_at:'2026-11-11T09:02:00Z'});
 x.setKeys([declined]);x.answer(x.requests('decline_pip_key')[0],{key:declined});await x.drain();
 const line=cardOf(x);
 assert.deepEqual([line.dataset.state,line.tagName,line.textContent],['declined','P','Not now · Invoicely API key']);
 assert.equal(line.classList.contains('dgc-card'),false,'a line, not a card');
 assert.equal(x.d.querySelector('[data-pip-key-card] input'),null);assert.equal(x.d.querySelector('[data-pip-key-card] button'),null);
 assert.ok(!(x.d.documentElement.outerHTML+JSON.stringify(x.sent)).includes(KEY),'what was typed went nowhere');
});

test('a key answered before this chat was opened is no card: saved and Not now ones are on the Pip\'s page only',async()=>{
 const x=setup({keys:[key({status:'saved',saved:true}),key({id:KEYID2,host:'api.weather.example',name:'Weather key',status:'declined'})]});await openChat(x);
 assert.equal(x.d.querySelector('[data-pip-key-card]'),null);
});

test('the Pip\'s page lists its keys: name, site, Saved / Waiting for you / Not now; hidden when it has none',async()=>{
 const x=setup({keys:[key({status:'saved',saved:true}),key({id:KEYID2,name:'Weather key',host:'api.weather.example'}),key({id:KEYID3,name:'Flights key',host:'api.flights.example',status:'declined'})]});await openPage(x);
 const group=x.d.querySelector('section[aria-label="Keys"]');assert.ok(group,'a Keys group');
 assert.match(group.querySelector('h3').textContent,/^Keys/);
 const tip=group.querySelector('h3 [data-pip-tip]');assert.ok(tip,'with its "i"');
 assert.match(x.d.getElementById(tip.dataset.pipTip).textContent,/DGC keeps it on this computer and sends it only to that site\. Ava never sees it\./);
 assert.deepEqual([...group.querySelectorAll('[data-pip-key]')].map(r=>[r.querySelector('.row-words span').textContent,r.querySelector('small').textContent,r.querySelector('button').textContent]),
  [['Invoicely API key','api.invoicely.example · Saved','Remove'],['Weather key','api.weather.example · Waiting for you','Remove'],['Flights key','api.flights.example · Not now','Remove']]);
 assert.equal(group.querySelector('input'),null,'no box on the page: a key is pasted on its card');
 const none=setup({keys:[]});await openPage(none);
 assert.equal(none.d.querySelector('section[aria-label="Keys"]'),null,'no keys, no group');
});

test('Remove asks first, in the row: Keep it leaves it, Remove (the danger button) sends the Pip and the key and the row goes',async()=>{
 const x=setup({keys:[key({status:'saved',saved:true}),key({id:KEYID2,name:'Weather key',host:'api.weather.example',status:'saved',saved:true})]});await openPage(x);
 x.click(`[data-pip-key-ask-remove="${KEYID}"]`);await flush();
 const row=()=>x.d.querySelector(`[data-pip-key="${KEYID}"]`);
 assert.match(row().textContent,/Remove the Invoicely API key\? Ava can’t read api\.invoicely\.example until you save it again\./);
 assert.deepEqual([...row().querySelectorAll('button')].map(b=>[b.textContent,b.classList.contains('danger')]),[['Remove',true],['Keep it',false]]);
 assert.equal(x.requests('remove_pip_key').length,0,'nothing is removed by asking');
 assert.equal(x.d.querySelector(`[data-pip-key="${KEYID2}"] .pip-key-confirm`),null,'only that row asks');
 x.click('[data-pip-key-keep]');await flush();
 assert.equal(row().querySelector('.pip-key-confirm'),null);assert.equal(x.requests('remove_pip_key').length,0,'Keep it: nothing sent');
 x.click(`[data-pip-key-ask-remove="${KEYID}"]`);await flush();
 x.click(`[data-pip-key-remove="${KEYID}"]`);await flush();
 assert.deepEqual(x.requests('remove_pip_key').map(m=>clean(m.request)),[{type:'remove_pip_key',pip_id:PIP,key_id:KEYID}]);
 x.setKeys([key({id:KEYID2,name:'Weather key',host:'api.weather.example',status:'saved',saved:true})]);x.answer(x.requests('remove_pip_key')[0],{removed:true});await x.drain();
 assert.equal(row(),null,'the row is gone');
 assert.ok(x.d.querySelector(`[data-pip-key="${KEYID2}"]`),'the other key stays');
 assert.match(x.d.body.textContent,/Removed\. Ava can’t read api\.invoicely\.example until you save a key again\./);
});

test('an older DGC (Pips API 81) shows no card and no Keys, and is asked for none',async()=>{
 const x=setup({apiVersion:81});await openPage(x);
 assert.equal(x.requests('list_pip_keys').length,0);
 assert.equal(x.d.querySelector('section[aria-label="Keys"]'),null);
 const chat=setup({apiVersion:81});await openChat(chat);
 assert.equal(chat.d.querySelector('[data-pip-key-card]'),null);assert.equal(chat.d.querySelector('input[type="password"]'),null);
});

test('the editor passes the four key commands from API 82 only, and what it says of a refused one never holds the key',async()=>{
 const body=type=>({type,pip_id:PIP,...(type==='list_pip_keys'?{}:{key_id:KEYID}),...(type==='save_pip_key'?{value:KEY}:{})});
 for(const api of [81,82]){
  const posted=[],sent=[];
  const editor=new viewModule.PipsEditor({},m=>{sent.push(m);return true;},()=>{});
  editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  for(const type of ['list_pip_keys','save_pip_key','decline_pip_key','remove_pip_key'])editor.receive({type:'pipsRequest',id:type,request:body(type)});
  if(api<82){
   assert.equal(sent.length,0,'an older DGC is sent none');
   for(const type of ['list_pip_keys','save_pip_key','decline_pip_key','remove_pip_key'])assert.equal(posted.find(m=>m.id===type).error.message,'Update DGC to give a Pip its own keys.');
  }else{
   assert.deepEqual(sent.map(m=>[m.type,m.request.type]),[['pips_control','list_pip_keys'],['pips_control','save_pip_key'],['pips_control','decline_pip_key'],['pips_control','remove_pip_key']]);
   assert.equal(sent[1].request.value,KEY,'the key goes to DGC as pasted');
   assert.equal(posted.filter(m=>m.type==='pipsReply').length,0,'nothing is said back until DGC answers');
  }
  assert.ok(!JSON.stringify(posted).includes(KEY),'the key is never echoed to the page');
 }
 const guard=viewModule.pipKeyRefusal;assert.equal(typeof guard,'function');
 assert.equal(guard({type:'list_pips'},10),'','other commands are not its business');
 assert.equal(guard(body('save_pip_key'),82),'');
 for(const bad of [{...body('save_pip_key'),value:''},{...body('save_pip_key'),value:'   '},{...body('save_pip_key'),value:7},{...body('save_pip_key'),value:'two\nlines'},{...body('save_pip_key'),value:'x'.repeat(16385)},
  {...body('save_pip_key'),key_id:'pipkey_1'},{...body('save_pip_key'),pip_id:'../x'},{...body('save_pip_key'),header:'cookie'},{...body('decline_pip_key'),value:KEY},{...body('list_pip_keys'),value:KEY},{type:'remove_pip_key',pip_id:PIP}]){
  const said=guard(bad,82);assert.notEqual(said,'',JSON.stringify(Object.keys(bad)));assert.ok(!said.includes(KEY),'and never repeats the key');
 }
 // A key as long as DGC keeps (16,384 characters) fits the request.
 const posted=[],sent=[],editor=new viewModule.PipsEditor({},m=>{sent.push(m);return true;},()=>{});
 editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:82},{});
 editor.receive({type:'pipsRequest',id:'long',request:{...body('save_pip_key'),value:'k'.repeat(16384)}});
 assert.equal(sent.length,1,JSON.stringify(posted).slice(0,200));
});

test('a list that is not well formed is refused whole, and said',async()=>{
 const x=setup({keys:[key({host:'localhost'})]});await openChat(x);
 assert.equal(x.d.querySelector('[data-pip-key-card]'),null);
 assert.match(x.d.body.textContent,/This Pip’s keys didn’t load\. Refresh to try again\./);
 const y=setup({keys:[key({value:KEY})]});await openChat(y);
 assert.ok(cardOf(y),'a well-formed card still shows');
 assert.ok(!y.d.documentElement.outerHTML.includes(KEY),'and anything else an answer carried is never drawn');
});
