// pips-10: a Personal Pip's plugin that needs a key it doesn't have asks for it on a card in its chat (Pips API 81:
// list_pip_plugins answers `key_requests`, allow_pip_plugin takes `keys`). The card, in the cards' own look: "<Plugin>
// needs its <label>", the Pip's reason, one masked box a key, Allow (filled, off until every box has text) and Not now;
// once saved, "Saved · it never saw the key". The key is read from its box when Allow is pressed, sent once, and the box
// is emptied: it is never in the page's markup, its kept state or its drafts. An older DGC (API 80) shows and sends none.
// (Harness from pip-plugins.test.mjs. How it looks: pip-key-card-browser.test.mjs.)
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
const action=(server='airtable',status='pending',c=call)=>({id:ACTION,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status,digest:'d'.repeat(64),expires_at:'2099-10-05T06:00:00Z',payload:{schema_version:3,kind:'connector_call',source,server,connection_digest:'a'.repeat(64),account:'connection_managed',schema_digest:'b'.repeat(64),call:c},receipt:null});
const KEY='pat_test_0123456789abcdefSECRET',KEY2='base_app0123456789SECRET';
const keyCard=(extra={})=>card({reason:'To read your Plans table.',needs_key:[{name:'AIRTABLE_TOKEN',label:'Airtable token',server:'airtable'}],...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));

function setup({plugins=[],keyRequests=[keyCard()],drafts=[],apiVersion=81,messages=[],uses={plugins:[],installed}}={}){
 let listed=installed;
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
  list_pips:()=>({pips:[pipRow]}),get_pip:()=>({pip:pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins,key_requests:keyRequests,installed:listed}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:drafts.map(summary),next_cursor:null}),get_pip_connector_draft:()=>({draft:drafts.find(d=>d.id===r.draft_id)}),
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined,
  list_pip_plugin_uses:()=>uses,list_pip_apps:()=>({apps:[]}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
  get_pip_computers:()=>({available:true,reason:'',platform:'linux',setup:{state:'ready',step:'',done:0,total:0,error:'',chrome:'',checked_at:null},computers:[],programs_bytes:0,free_bytes:0})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,setPlugins:v=>{plugins=v;},setKeyRequests:v=>{keyRequests=v;},setDrafts:v=>{drafts=v;},setInstalled:v=>{listed=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const clean=v=>JSON.parse(JSON.stringify(v));


const box=(x,name='AIRTABLE_TOKEN')=>x.d.querySelector(`[data-key-card="${CARD}"] input[data-key-name="${name}"]`);
const type=(x,el,value)=>{el.value=value;el.dispatchEvent(new x.w.Event('input',{bubbles:true}));};
const allowButton=x=>x.d.querySelector(`[data-key-card="${CARD}"] button.primary`);
const submit=x=>x.d.querySelector(`[data-key-card="${CARD}"] form`).dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));
const everywhere=x=>x.d.documentElement.outerHTML+JSON.stringify(x.sent.filter(m=>m.type!=='pipsRequest'||m.request.type!=='allow_pip_plugin'));

test('a key request is a card in the chat: what needs which key and why, one masked box, Allow off until it has text',async()=>{
 const x=setup();await openChat(x);
 const el=x.d.querySelector(`[data-key-card="${CARD}"]`);assert.ok(el,'the card is in the chat');
 assert.ok(el.classList.contains('dgc-card'),'the shared card');
 assert.match(el.textContent,/Airtable needs its Airtable token.*To read your Plans table\./);
 assert.equal(el.getAttribute('aria-label'),'Airtable needs its Airtable token');
 const input=box(x);assert.ok(input,'a box for the key');
 assert.deepEqual([input.type,input.getAttribute('autocomplete'),input.getAttribute('spellcheck'),input.hasAttribute('value'),input.hasAttribute('data-draft')],['password','off','false',false,false],'masked, never offered back, never a draft');
 assert.equal(x.d.querySelector(`label[for="${input.id}"]`).textContent,'Airtable token','its label is the key\'s name');
 assert.deepEqual([...el.querySelectorAll('.dgc-card-actions button')].map(b=>[b.textContent,b.classList.contains('primary'),b.disabled]),[['Allow',true,true],['Not now',false,false]],'one filled answer, off until the box has text');
 assert.match(el.textContent,/Ava never sees it/,'and it says who sees the key');
 type(x,input,'   ');assert.equal(allowButton(x).disabled,true,'spaces are not a key');
 type(x,input,KEY);assert.equal(allowButton(x).disabled,false,'with text, Allow is on');
 type(x,input,'');assert.equal(allowButton(x).disabled,true,'emptied, off again');
});

test('Allow sends exactly the Pip, the card and the key, once; the box is emptied; then "Saved · it never saw the key"',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);
 // A redraw while the key is in its box (the chat polls) leaves it there, and Allow on.
 x.w.dispatchEvent(new x.w.MessageEvent('message',{data:{type:'pipsConnection',apiVersion:81,generation:1,connected:true,supported:true,enabled:true}}));await x.drain();
 assert.deepEqual([box(x).value,allowButton(x).disabled],[KEY,false],'a redraw keeps what was typed');
 assert.ok(!everywhere(x).includes(KEY),'the key is in its box and nowhere else: not the markup, not a message');
 submit(x);await flush();
 const sent=x.requests('allow_pip_plugin');assert.equal(sent.length,1);
 assert.deepEqual(clean(sent[0].request),{type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD,keys:{AIRTABLE_TOKEN:KEY}});
 assert.equal(box(x).value,'','the box is emptied as it is sent');
 assert.deepEqual([allowButton(x).disabled,allowButton(x).textContent],[true,'Saving…']);
 submit(x);await flush();assert.equal(x.requests('allow_pip_plugin').length,1,'never sent twice');
 x.setKeyRequests([]);x.answer(sent[0],{plugin:keyCard({status:'allowed',needs_key:[]})});await x.drain();
 const done=x.d.querySelector(`[data-key-card="${CARD}"]`);
 assert.equal(done.dataset.state,'saved');
 assert.match(done.textContent,/Ava can use Airtable.*Saved · it never saw the key/);
 assert.equal(done.querySelector('input'),null,'no box any more');assert.equal(done.querySelector('button'),null,'and nothing to answer');
 assert.ok(!everywhere(x).includes(KEY),'the key is nowhere on the page after it was sent');
 assert.ok(x.requests('list_pip_messages').length>=2,'the chat reloads: the Pip carries on');
});

test('a plugin that needs two keys has a box for each, Allow waits for both, and both are sent',async()=>{
 const two=keyCard({needs_key:[{name:'AIRTABLE_TOKEN',label:'Airtable token',server:'airtable'},{name:'AIRTABLE_BASE',label:'Base ID',server:'airtable'}]});
 const x=setup({keyRequests:[two]});await openChat(x);
 const el=x.d.querySelector(`[data-key-card="${CARD}"]`);
 assert.match(el.textContent,/Airtable needs its Airtable token and Base ID/);
 assert.deepEqual([...el.querySelectorAll('input')].map(i=>[i.type,i.dataset.keyName,x.d.querySelector(`label[for="${i.id}"]`).textContent]),[['password','AIRTABLE_TOKEN','Airtable token'],['password','AIRTABLE_BASE','Base ID']]);
 type(x,box(x),KEY);assert.equal(allowButton(x).disabled,true,'one of two: still off');
 type(x,box(x,'AIRTABLE_BASE'),KEY2);assert.equal(allowButton(x).disabled,false);
 submit(x);await flush();
 assert.deepEqual(clean(x.requests('allow_pip_plugin')[0].request),{type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD,keys:{AIRTABLE_TOKEN:KEY,AIRTABLE_BASE:KEY2}});
 assert.deepEqual([box(x).value,box(x,'AIRTABLE_BASE').value],['','']);
});

test('a refused key says why on the card, the box stays empty, and it can be pasted again',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);submit(x);await flush();
 x.answer(x.requests('allow_pip_plugin')[0],'Paste its Airtable token first; it is saved securely, and the Pip never sees it.',false);await x.drain();
 const el=x.d.querySelector(`[data-key-card="${CARD}"]`);
 assert.equal(el.dataset.state,'requested','it still waits');
 assert.match(el.querySelector('[role="alert"]').textContent,/Paste its Airtable token first/);
 assert.deepEqual([box(x).value,allowButton(x).disabled,allowButton(x).textContent],['',true,'Allow']);
 assert.ok(!everywhere(x).includes(KEY));
 type(x,box(x),KEY);submit(x);await flush();
 assert.equal(x.requests('allow_pip_plugin').length,2,'pasted again, sent again');
});

test('Not now declines the card and sends no key; the box is emptied and the card goes',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);
 x.click(`[data-key-card="${CARD}"] [data-plugin-decline="${CARD}"]`);await flush();
 assert.deepEqual(clean(x.requests('decline_pip_plugin')[0].request),{type:'decline_pip_plugin',pip_id:PIP,grant_id:CARD});
 assert.equal(x.requests('allow_pip_plugin').length,0);
 x.setKeyRequests([]);x.answer(x.requests('decline_pip_plugin')[0],{plugin:keyCard({status:'declined'})});await x.drain();
 assert.equal(x.d.querySelector(`[data-key-card="${CARD}"]`),null);
 assert.ok(!everywhere(x).includes(KEY));
});

test('an older DGC (Pips API 80) shows no key card and is never sent a key, whatever it answers',async()=>{
 const x=setup({apiVersion:80});await openChat(x);
 assert.equal(x.d.querySelector('[data-key-card]'),null,'no card');
 assert.equal(x.d.querySelector('input[type="password"]'),null);
 assert.equal(x.requests('allow_pip_plugin').length,0);
});

test('the editor refuses to pass a key to a DGC older than API 81, or a key that is not text',async()=>{
 const posted=[],sentToCli=[];
 const fake={apiVersion:80,post:(c,type,value)=>posted.push({type,...value})};
 const guard=viewModule.keysRefusal;
 assert.equal(typeof guard,'function','the host checks allow_pip_plugin\'s keys');
 assert.match(guard({type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD,keys:{AIRTABLE_TOKEN:KEY}},80),/Update DGC/);
 assert.equal(guard({type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD,keys:{AIRTABLE_TOKEN:KEY}},81),'');
 assert.equal(guard({type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD},80),'','no key: as before');
 for(const bad of [[],'x',{A:1},{'bad name':'x'},{A:''},Object.fromEntries(Array.from({length:9},(_,i)=>['K'+i,'x']))])assert.notEqual(guard({type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD,keys:bad},81),'',JSON.stringify(bad));
 void fake;void sentToCli;
});

test('a key request that is not well formed is refused whole, and said',async()=>{
 const x=setup({keyRequests:[keyCard({needs_key:[{name:'AIRTABLE TOKEN',label:'x',server:'airtable'}]})]});await openChat(x);
 assert.equal(x.d.querySelector('[data-key-card]'),null);
 assert.match(x.d.body.textContent,/These cards didn’t load\. Refresh to try again\./);
});
