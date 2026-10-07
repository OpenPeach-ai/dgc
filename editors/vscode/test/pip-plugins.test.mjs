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
const action=(server='airtable',status='pending',c=call)=>({id:ACTION,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status,digest:'d'.repeat(64),expires_at:'2099-10-05T06:00:00Z',payload:{schema_version:3,kind:'connector_call',source,server,connection_digest:'a'.repeat(64),account:'connection_managed',schema_digest:'b'.repeat(64),call:c},receipt:null});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));

function setup({plugins=[card()],drafts=[],apiVersion=44,messages=[],uses={plugins:[],installed}}={}){
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
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins,installed}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:drafts.map(summary),next_cursor:null}),get_pip_connector_draft:()=>({draft:drafts.find(d=>d.id===r.draft_id)}),
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined,
  list_pip_plugin_uses:()=>uses,list_pip_apps:()=>({apps:[]}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
  get_pip_computers:()=>({available:true,reason:'',platform:'linux',setup:{state:'ready',step:'',done:0,total:0,error:'',chrome:'',checked_at:null},computers:[],programs_bytes:0,free_bytes:0})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,setPlugins:v=>{plugins=v;},setDrafts:v=>{drafts=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const clean=v=>JSON.parse(JSON.stringify(v));

test('the Pip asks: "Let Ava use Airtable?" with what for, and Allow goes to DGC by card',async()=>{
 const x=setup();await openChat(x);
 const el=x.d.querySelector(`[data-plugin-card="${CARD}"]`);assert.ok(el,'the card is in the chat');
 assert.match(el.textContent,/Let Ava use Airtable\?.*To keep your weekend plan in a table\./);
 assert.deepEqual([...el.querySelectorAll('button')].map(b=>b.textContent),['Allow','Not now']);
 x.click(`[data-plugin-allow="${CARD}"]`);
 const allow=x.requests('allow_pip_plugin')[0];assert.deepEqual(clean(allow.request),{type:'allow_pip_plugin',pip_id:PIP,grant_id:CARD});
 assert.match(x.d.querySelector(`[data-plugin-card="${CARD}"]`).textContent,/Allowing…/);
 x.setPlugins([card({status:'allowed'})]);x.answer(allow,{plugin:card({status:'allowed'})});await x.drain();
 const done=x.d.querySelector(`[data-plugin-card="${CARD}"]`);
 assert.match(done.textContent,/Ava can use Airtable.*What its maker marks read-only runs at once\. Anything else waits for your Allow\./);
 assert.equal(done.querySelectorAll('button').length,0);
 assert.match(x.d.body.textContent,/Ava can use Airtable now\./);
 assert.ok(x.requests('list_pip_messages').length>=2,'the chat reloads: the Pip carries on');
});

test('Not now declines; a plugin not added in DGC opens Settings; a card for another Pip is refused',async()=>{
 const x=setup();await openChat(x);
 x.click(`[data-plugin-decline="${CARD}"]`);
 const no=x.requests('decline_pip_plugin')[0];assert.equal(no.request.grant_id,CARD);
 x.answer(no,{plugin:card({status:'declined'})});await flush();
 assert.equal(x.d.querySelector(`[data-plugin-card="${CARD}"]`),null,'gone after Not now');
 const y=setup({plugins:[card({installed:false,servers:[]})]});await openChat(y);
 assert.match(y.d.querySelector(`[data-plugin-card="${CARD}"]`).textContent,/Airtable isn’t added in DGC.*Add it in Settings → Plugins/);
 y.click(`[data-plugin-settings="${CARD}"]`);assert.deepEqual(clean(y.sent.at(-1)),{type:'openSettings',section:'plugins'});
 const z=setup({plugins:[card({pip_id:'pip_'+'h'.repeat(32)})]});await openChat(z);
 assert.equal(z.d.querySelector('[data-plugin-card]'),null);assert.match(z.d.body.textContent,/card didn’t load|cards didn’t load/);
 const old=setup({apiVersion:43});await openChat(old);
 assert.equal(old.requests('list_pip_plugins').length,0,'an older DGC CLI is not asked');
});

test('what the Pip would do in a plugin is an Allow card; Allow prepares that exact call and runs it once',async()=>{
 const x=setup({plugins:[card({status:'allowed',updated_at:'2026-10-01T09:00:00.000Z'})],drafts:[draft()]});await openChat(x);
 const el=x.d.querySelector(`[data-plugin-action="${DRAFT}"]`);assert.ok(el,'inline in the chat');
 assert.match(el.textContent,/Run create_record in Airtable\?Ava wants to do this in Airtable\..*table.*Plans.*fields.*Run <b>5k<\/b>/);
 assert.equal(el.querySelector('b'),null,'inputs are text');
 assert.deepEqual([...el.querySelectorAll('button')].map(b=>b.textContent),['Allow','Always allow','Edit','Don’t']);
 assert.equal(x.d.querySelector('.chat-setup-review'),null,'not also a Review row');
 x.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 const prep=x.requests('prepare_pip_connector_draft').at(-1);
 assert.deepEqual(clean(prep.request),{type:'prepare_pip_connector_draft',draft_id:DRAFT,expected_digest:'c'.repeat(64),call});
 x.answer(prep,{action:action()});await flush();
 const ok=x.requests('accept_pip_app_action').at(-1);assert.deepEqual(clean(ok.request),{type:'accept_pip_app_action',action_id:ACTION,expected_digest:'d'.repeat(64)});
 assert.equal(x.requests('always_allow_pip_app_action').length,0);
 x.setDrafts([draft('airtable',{status:'prepared',action_id:ACTION})]);x.answer(ok,{action:action('airtable','succeeded')});await x.drain();
 assert.match(x.d.body.textContent,/Done: create_record ran in Airtable\./);
 assert.ok(x.requests('list_pip_messages').length>=2,'the chat reloads: the Pip reads the answer and carries on');
 assert.equal(x.d.querySelector(`[data-plugin-action="${DRAFT}"]`),null,'settled');
});

test('Always allow runs it and saves the grant; Don’t dismisses it',async()=>{
 const x=setup({plugins:[card({status:'allowed'})],drafts:[draft()]});await openChat(x);
 x.click(`[data-plugin-always="${DRAFT}"]`);await flush();
 x.answer(x.requests('prepare_pip_connector_draft').at(-1),{action:action()});await flush();
 assert.equal(x.requests('accept_pip_app_action').length,0);
 const always=x.requests('always_allow_pip_app_action').at(-1);assert.equal(always.request.action_id,ACTION);
 x.answer(always,{action:action('airtable','succeeded'),grant:{id:'grant_'+'1'.repeat(32)}});await x.drain();
 assert.match(x.d.body.textContent,/Ava may run it without asking now; take it back on its page\./);
 const y=setup({plugins:[card({status:'allowed'})],drafts:[draft()]});await openChat(y);
 y.click(`[data-plugin-skip="${DRAFT}"]`);
 const no=y.requests('dismiss_pip_connector_draft').at(-1);assert.deepEqual(clean(no.request),{type:'dismiss_pip_connector_draft',draft_id:DRAFT,expected_digest:'c'.repeat(64)});
});

test('a plugin that can move money asks every time: no Always allow on its card',async()=>{
 const x=setup({plugins:[aave({status:'allowed'})],drafts:[draft('aave')]});await openChat(x);
 const el=x.d.querySelector(`[data-plugin-action="${DRAFT}"]`);
 assert.match(el.textContent,/Run create_record in Aave\?Aave can move money, so Ava asks you every time\./);
 assert.deepEqual([...el.querySelectorAll('button')].map(b=>b.textContent),['Allow','Edit','Don’t']);
});

test('the allowed card goes once the Pip has replied after it',async()=>{
 const reply={id:'a9',pip_id:PIP,workspace_id:PW,role:'assistant',text:'The rate is 4.13%.',run_id:'run_'+'9'.repeat(32),status:'succeeded',model:'m',created_at:new Date(Date.now()+60000).toISOString()};
 const x=setup({plugins:[card({status:'allowed'})]});await openChat(x);
 assert.ok(x.d.querySelector(`[data-plugin-card="${CARD}"]`),'just allowed: shown');
 const y=setup({plugins:[card({status:'allowed'})],messages:[reply]});await openChat(y);
 assert.match(y.d.body.textContent,/The rate is 4\.13%\./);
 assert.equal(y.d.querySelector(`[data-plugin-card="${CARD}"]`),null,'its reply follows; the card is gone');
 const z=setup({plugins:[aave({status:'allowed'})]});await openChat(z);
 assert.match(z.d.querySelector(`[data-plugin-card="${MONEY}"]`).textContent,/Aave can move money, so Ava asks you before every action\./);
});

test('a connector draft for a server no allowed plugin owns stays a Review row',async()=>{
 const x=setup({plugins:[card({status:'allowed'})],drafts:[draft('make')]});await openChat(x);
 assert.equal(x.d.querySelector('[data-plugin-action]'),null);
 assert.match(x.d.querySelector('.chat-setup-review').textContent,/App action for you to check/);
});

test('the Pip’s page lists the plugins it may use, each taken back there',async()=>{
 const x=setup({plugins:[card({status:'allowed',updated_at:'2026-10-01T09:00:00.000Z'}),aave({status:'allowed',updated_at:'2026-10-01T09:00:00.000Z'})]});await openChat(x);
 x.click('[data-tab="job"]');await x.drain();
 const group=x.d.querySelector('[aria-label="Plugins"]');assert.ok(group,'on its page');
 assert.match(group.textContent,/Airtable.*Asks before anything its maker doesn’t mark read-only.*Aave.*Asks you before every action/);
 x.click(`[data-plugin-remove="${CARD}"]`);
 const back=x.requests('decline_pip_plugin').at(-1);assert.deepEqual(clean(back.request),{type:'decline_pip_plugin',pip_id:PIP,grant_id:CARD});
 x.answer(back,{plugin:card({status:'declined'})});await flush();
 assert.match(x.d.body.textContent,/Ava no longer uses Airtable\. It stays in DGC\./);
});

test('Pips settings → Plugins: which Pips use each plugin, Remove for one, and what a Pip could ask for',async()=>{
 const many=Array.from({length:50},(_,i)=>({pip_id:'pip_'+String(i).padStart(32,'0'),name:'Helper '+(i+1),grant_id:'pipplugin_'+String(i).padStart(32,'0')}));
 const uses={plugins:[{plugin:'aave',name:'Aave',money:true,installed:true,count:1,pips:[{pip_id:PIP,name:'Ava',grant_id:MONEY}]},
  {plugin:'airtable',name:'Airtable',money:false,installed:true,count:1234,pips:many}],installed:[...installed,{plugin:'granola',name:'Granola',money:false}]};
 const x=setup({uses});await x.drain();
 x.click('#pips-settings-open');await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('[data-pips-settings]')].map(b=>b.textContent),['Computer','Apps','Plugins']);
 x.click('[data-pips-settings="plugins"]');await x.drain();
 const text=x.d.body.textContent;
 assert.match(text,/Aave.*Asks before every action: it can move money · 1 Pip.*Ava can use it/);
 assert.match(text,/Airtable.*1,234 Pips.*Helper 1 can use it/);
 assert.match(text,/And 1,184 more\. Search your Pips to find one\./,'a plugin thousands of Pips use lists 50 and counts the rest');
 assert.match(text,/Added, not used by a Pip.*Granola/);
 assert.equal(x.d.querySelector(`[data-plugin-use-remove="${MONEY}"]`).getAttribute('aria-label'),'Stop Ava using Aave');
 x.click(`[data-plugin-use-remove="${MONEY}"]`);await flush();
 assert.deepEqual(clean(x.requests('decline_pip_plugin')[0].request),{type:'decline_pip_plugin',pip_id:PIP,grant_id:MONEY});
 x.answer(x.requests('decline_pip_plugin')[0],{plugin:aave({status:'declined'})});await x.drain();
 assert.match(x.d.body.textContent,/Removed\. That Pip no longer uses the plugin\./);
 assert.ok(x.requests('list_pip_plugin_uses').length>=2,'the list is read again after Remove');
 x.click('[data-open-plugins]');
 assert.ok(x.sent.some(m=>m.type==='openSettings'&&m.section==='plugins'));
});

test('Pips settings → Plugins with none in use says how a Pip asks; an older CLI has no Plugins tab',async()=>{
 const x=setup();await x.drain();
 x.click('#pips-settings-open');await x.drain();x.click('[data-pips-settings="plugins"]');await x.drain();
 assert.match(x.d.body.textContent,/No Pip uses a plugin yet\. When one needs a plugin you added, it asks in its chat/);
 const old=setup({apiVersion:43});await old.drain();
 old.click('#pips-settings-open');await old.drain();
 assert.deepEqual([...old.d.querySelectorAll('[data-pips-settings]')].map(b=>b.textContent),['Computer','Apps']);
});

test('Edit changes the plugin call on its card: each input in its own field, JSON for objects, and Allow runs the edited call',async()=>{
 const x=setup({plugins:[card({status:'allowed'})],drafts:[draft()]});await openChat(x);
 x.click(`[data-card-edit-start="${DRAFT}"]`);
 const el=()=>x.d.querySelector(`[data-plugin-action="${DRAFT}"]`);
 assert.ok(el().hasAttribute('data-editing'));
 const table=x.d.getElementById(`card-${DRAFT}-arg0`),fields=x.d.getElementById(`card-${DRAFT}-arg1`);
 assert.equal(table.value,'Plans');assert.equal(fields.tagName,'TEXTAREA');
 assert.deepEqual(JSON.parse(fields.value),{Name:'Run <b>5k</b>'});
 assert.equal(x.d.activeElement,table,'the first field takes focus');
 const type=(el,v)=>{el.value=v;el.dispatchEvent(new x.w.Event('input',{bubbles:true}));};
 type(fields,'{"Name": "Run 10k"');
 x.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 assert.equal(x.requests('prepare_pip_connector_draft').length,0,'a field that will not read runs nothing');
 assert.match(el().querySelector('[role=alert]').textContent,/fields aren’t valid JSON/);
 type(x.d.getElementById(`card-${DRAFT}-arg1`),'{"Name": "Run 10k", "Day": "Sunday"}');
 type(x.d.getElementById(`card-${DRAFT}-arg0`),'Weekend plans');
 x.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 const prep=x.requests('prepare_pip_connector_draft').at(-1);
 assert.deepEqual(clean(prep.request.call),{tool:'create_record',arguments:{table:'Weekend plans',fields:{Name:'Run 10k',Day:'Sunday'}}});
 x.answer(prep,{action:action('airtable','pending',{tool:'create_record',arguments:{table:'Weekend plans',fields:{Name:'Run 10k',Day:'Sunday'}}})});await flush();
 const ok=x.requests('accept_pip_app_action').at(-1);assert.ok(ok,'the edited call is the one accepted');
 x.setDrafts([draft('airtable',{status:'prepared',action_id:ACTION})]);x.answer(ok,{action:action('airtable','succeeded')});await x.drain();
 assert.match(x.d.body.textContent,/Done: create_record ran in Airtable with your changes\./);
});

test('Undo changes puts the card back as the Pip wrote it, and Allow then runs the original call',async()=>{
 const x=setup({plugins:[card({status:'allowed'})],drafts:[draft()]});await openChat(x);
 x.click(`[data-card-edit-start="${DRAFT}"]`);
 const t=x.d.getElementById(`card-${DRAFT}-arg0`);t.value='Other';t.dispatchEvent(new x.w.Event('input',{bubbles:true}));
 x.click(`[data-card-edit-undo="${DRAFT}"]`);
 assert.equal(x.d.getElementById(`card-${DRAFT}-arg0`),null);
 assert.match(x.d.querySelector(`[data-plugin-action="${DRAFT}"]`).textContent,/table.*Plans/);
 x.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 assert.deepEqual(clean(x.requests('prepare_pip_connector_draft').at(-1).request.call),call);
});

