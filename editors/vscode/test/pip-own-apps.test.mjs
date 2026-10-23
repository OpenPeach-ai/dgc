// Your own apps' tools for Personal Pips (Pips API 61). An app your code registered with DGC's SDK reads like the other
// connections on Pips settings → Apps ("Shop app · 2 read tools, 1 change tool", with its address, and an update that
// waits with Accept); a change a Pip proposes in it is the Allow card, naming the app and the tool ("Run create_dispatch
// in Shop app?"), with no Always allow for a tool that moves money; and no secret is ever shown. (Harness from
// pip-plugins.)
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewModule=load(await bundle('pipsView.ts'),name=>name==='vscode'?{}:require(name));
const own=load(await bundle('pipOwnApps.js')),model=load(await bundle('pipsModel.js')),reviews=load(await bundle('pipsMessageReviews.js')),picker=load(await bundle('pipsAppPicker.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32),RUN='run_'+'5'.repeat(32),DRAFT='conndraft_'+'3'.repeat(32),ACTION='appaction_'+'2'.repeat(32);
const SECRET='dgcapp_'+'9'.repeat(64);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pipRow={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Chase unpaid orders.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const tool=(name,kind,money=false)=>({name,kind,description:name.replace(/_/g,' '),input_schema:{type:'object'},moves_money:money,schema_digest:'b'.repeat(64)});
const shop=(extra={})=>({name:'shop',server:'app:shop',display_name:'Shop app',url:'http://127.0.0.1:5005/dgc/pips',connection_digest:'a'.repeat(64),
 summary:'2 read tools, 1 change tool',reads:2,changes:1,tools:[tool('find_unpaid_orders','read'),tool('get_order','read'),tool('create_dispatch','change'),tool('refund_order','change',true)],
 created_at:'2026-10-24T09:00:00.000Z',updated_at:'2026-10-24T09:00:00.000Z',secret_rotated_at:'2026-10-24T09:00:00.000Z',pending:null,...extra});
const source={run_id:RUN,pip_id:PIP,workspace_id:PW,job_version:1,lifecycle_revision:0,result_digest:'e'.repeat(64)};
const call={tool:'create_dispatch',arguments:{order_id:'ord_17'}};
const draft=(c=call,extra={})=>({id:DRAFT,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status:'pending',digest:'c'.repeat(64),expired:false,expires_at:'2099-10-05T06:00:00Z',action_id:null,created_at:'2026-10-24T09:00:00.000Z',actor:'pip-connector:'+RUN,request_key:'f'.repeat(64),payload:{schema_version:1,source,action:{server:'app:shop',connection_digest:'a'.repeat(64),schema_digest:'b'.repeat(64),call:c}},...extra});
const action=(status='pending',c=call,extra={})=>({id:ACTION,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status,digest:'d'.repeat(64),expires_at:'2099-10-05T06:00:00Z',...extra,payload:{schema_version:3,kind:'connector_call',source,server:'app:shop',connection_digest:'a'.repeat(64),account:'connection_managed',schema_digest:'b'.repeat(64),call:c},
 receipt:status==='succeeded'?{provider:'app:shop',tool:c.tool,response_digest:'f'.repeat(64),response_preview:'{"dispatch":"dsp_1"}',meaning:'The app answered that it did this.'}:null});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const clean=v=>JSON.parse(JSON.stringify(v));

function setup({apps=[shop()],drafts=[draft()],apiVersion=61,actions={}}={}){
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
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins:[],installed:[]}),
  list_apps:()=>({apps}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:drafts.map(summary),next_cursor:null}),get_pip_connector_draft:()=>({draft:drafts.find(d=>d.id===r.draft_id)}),
  get_pip_app_action:()=>actions[r.action_id]?{action:actions[r.action_id]}:undefined,
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined,
  list_pip_plugin_uses:()=>({plugins:[],installed:[]}),list_pip_apps:()=>({apps:[]}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
  get_pip_computers:()=>({available:true,reason:'',platform:'linux',setup:{state:'ready',step:'',done:0,total:0,error:'',chrome:'',checked_at:null},computers:[],programs_bytes:0,free_bytes:0})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,message,setDrafts:v=>{drafts=v;},setApps:v=>{apps=v;},setActions:v=>{actions=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}

test('a change a Pip proposes in your own app is the Allow card, naming the app and the tool; Allow runs that exact call once',async()=>{
 const x=setup();await openChat(x);
 const el=x.d.querySelector(`[data-plugin-action="${DRAFT}"]`);assert.ok(el,'inline in the chat, not a Review row');
 assert.match(el.textContent,/Run create_dispatch in Shop app\?Ava wants to do this in Shop app\..*order_id.*ord_17/);
 assert.deepEqual([...el.querySelectorAll('button')].map(b=>b.textContent),['Allow','Always allow','Edit','Don’t']);
 assert.equal(x.d.querySelector('.chat-setup-review'),null);
 x.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 const prep=x.requests('prepare_pip_connector_draft').at(-1);
 assert.deepEqual(clean(prep.request),{type:'prepare_pip_connector_draft',draft_id:DRAFT,expected_digest:'c'.repeat(64),call});
 x.answer(prep,{action:action()});await flush();
 const ok=x.requests('accept_pip_app_action').at(-1);
 assert.deepEqual(clean(ok.request),{type:'accept_pip_app_action',action_id:ACTION,expected_digest:'d'.repeat(64)});
 x.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);x.answer(ok,{action:action('succeeded')});await x.drain();
 assert.match(x.d.body.textContent,/Done: create_dispatch ran in Shop app\./);
 assert.equal(x.d.querySelector(`[data-plugin-action="${DRAFT}"]`),null,'settled');
});

test('a tool of yours that moves money asks every time: no Always allow on its card',async()=>{
 const x=setup({drafts:[draft({tool:'refund_order',arguments:{order_id:'ord_17'}})]});await openChat(x);
 const el=x.d.querySelector(`[data-plugin-action="${DRAFT}"]`);
 assert.match(el.textContent,/Run refund_order in Shop app\?Shop app can move money, so Ava asks you every time\./);
 assert.deepEqual([...el.querySelectorAll('button')].map(b=>b.textContent),['Allow','Edit','Don’t']);
});

test('Pips settings → Apps: your own app reads like a connection, an update waits with Accept, and no secret is shown',async()=>{
 const waiting={digest:'7'.repeat(64),url:'http://127.0.0.1:5005/dgc/pips',url_changed:false,adds:['refund_order'],changes:[],removes:[],
  summary:'2 read tools, 2 change tools',tools:[],created_at:'2026-10-24T10:00:00.000Z'};
 const x=setup({apps:[shop({pending:waiting})]});await x.drain();
 x.click('#pips-settings-open');await x.drain();
 x.click('[data-pips-settings="apps"]');await x.drain();
 const row=x.d.querySelector('[data-own-app="shop"]');assert.ok(row,'listed');
 assert.equal(row.textContent,'SShop app2 read tools, 1 change tool · http://127.0.0.1:5005/dgc/pips');
 assert.match(x.d.body.textContent,/Your own apps.*Apps your code connected with DGC’s SDK/);
 assert.match(x.d.body.textContent,/An update waits for you: adds refund_order2 read tools, 2 change tools/);
 assert.ok(!x.d.body.innerHTML.includes('dgcapp_'),'never a secret');
 assert.match(x.d.body.textContent,/No connected accounts yet\. When a Pip needs one/,'never "No apps yet" under your own apps');
 assert.doesNotMatch(x.d.body.textContent,/No apps yet/);
 x.click('[data-own-app-accept="shop"]');await flush();
 const accept=x.requests('accept_app_update').at(-1);
 assert.deepEqual(clean(accept.request),{type:'accept_app_update',name:'shop',expected_digest:'7'.repeat(64)});
 x.setApps([shop()]);x.answer(accept,{app:shop({summary:'2 read tools, 2 change tools'}),applied:true});await x.drain();
 assert.match(x.d.body.textContent,/Shop app is up to date: 2 read tools, 2 change tools\./);
 assert.equal(x.d.querySelector('[data-own-app-accept]'),null);
 const none=setup({apps:[]});await none.drain();none.click('#pips-settings-open');await none.drain();none.click('[data-pips-settings="apps"]');await none.drain();
 assert.equal(none.d.querySelector('[aria-label="Your own apps"]'),null,'nothing when you have none');
 assert.match(none.d.body.textContent,/No apps yet\./,'as before');
 assert.throws(()=>own.ownAppsPage({apps:[{...shop(),secret:SECRET}]}),/didn’t load/,'a listing with a secret is refused');
});

test('an older DGC is asked for no apps, and its connector drafts stay as they were',async()=>{
 const x=setup({apiVersion:60});await openChat(x);
 assert.equal(x.requests('list_apps').length,0);
 assert.equal(x.d.querySelector('[data-plugin-action]'),null);
});

test('reviews and plans on your own app read as such',()=>{
 const plan={schema_version:1,server:'app:shop',connection_digest:'a'.repeat(64),calls:[{tool:'find_unpaid_orders',schema_digest:'b'.repeat(64),arguments:{days:7}}]};
 assert.equal(model.appReadPlan(plan),plan);
 assert.throws(()=>model.appReadPlan({...plan,schema_version:2}));
 assert.throws(()=>model.appReadPlan({...plan,calls:[{...plan.calls[0],account:'ca_x'}]}));
 assert.deepEqual(picker.appReadWords(plan),['Shop app: find_unpaid_orders (days 7)']);
 assert.equal(reviews.messageReview(action('succeeded'),PIP,PW).id,ACTION);
 assert.throws(()=>reviews.messageReview({...action('succeeded'),receipt:{...action('succeeded').receipt,meaning:'The connector returned a response. This does not confirm downstream completion.'}},PIP,PW));
 assert.equal(reviews.connectorDraft(draft(),PIP,PW).id,DRAFT);
 assert.deepEqual(own.ownAppForServer([own.ownAppsPage({apps:[shop()]})[0]],'app:shop','create_dispatch'),{name:'Shop app',money:false});
 assert.deepEqual(own.ownAppForServer([],'app:my-shop','x'),{name:'My shop app',money:true},'not known: asks every time');
 assert.equal(own.ownAppForServer([],'zapier','x'),null);
});

// Approvals in your app (Pips API 62): your app can decide the change too. When it decides first, the card settles with
// one quiet line saying what the app decided, and an Allow pressed a moment late says so instead of running anything.
const byApp=(status='succeeded')=>action(status,call,{resolved_by:'app:shop',resolved_at:'2026-10-24T09:05:00.000Z'});
test('a change your app accepted first settles its card with one line saying so',async()=>{
 const x=setup({apiVersion:62});await openChat(x);
 assert.ok(x.d.querySelector(`[data-plugin-action="${DRAFT}"]`),'the card, while it waits');
 x.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);x.setActions({[ACTION]:byApp()});
 x.message({type:'pipsVisibility',visible:true});await x.drain();
 assert.equal(x.d.querySelector(`[data-plugin-action="${DRAFT}"]`),null,'settled');
 const line=x.d.querySelector(`[data-own-app-decided="${DRAFT}"]`);assert.ok(line,'what the app decided');
 assert.equal(line.textContent,'SShop app accepted create_dispatchDecided in Shop app. It ran once.');
 assert.equal(line.querySelectorAll('button').length,0,'nothing to press');
 assert.equal(x.requests('get_pip_app_action').length,1,'read once');
 x.message({type:'pipsVisibility',visible:true});await x.drain();
 assert.equal(x.requests('get_pip_app_action').length,1,'and not again');
 const declined=setup({apiVersion:62,drafts:[draft()]});await openChat(declined);
 declined.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);declined.setActions({[ACTION]:byApp('rejected')});
 declined.message({type:'pipsVisibility',visible:true});await declined.drain();
 assert.equal(declined.d.querySelector(`[data-own-app-decided="${DRAFT}"]`).textContent,'SShop app declined create_dispatchDecided in Shop app. Nothing ran.');
 const mine=setup({apiVersion:62});await openChat(mine);
 mine.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);mine.setActions({[ACTION]:action('succeeded',call,{resolved_by:'editor-user',resolved_at:'2026-10-24T09:05:00.000Z'})});
 mine.message({type:'pipsVisibility',visible:true});await mine.drain();
 assert.equal(mine.d.querySelector('[data-own-app-decided]'),null,'your own Allow needs no such line');
 const old=setup({apiVersion:61});await openChat(old);
 old.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);old.setActions({[ACTION]:byApp()});
 old.message({type:'pipsVisibility',visible:true});await old.drain();
 assert.equal(old.requests('get_pip_app_action').length,0,'an older DGC is asked nothing new');
});

test('Allow pressed after your app decided says what the app decided, and runs nothing',async()=>{
 const x=setup({apiVersion:62});await openChat(x);
 x.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 const prep=x.requests('prepare_pip_connector_draft').at(-1);
 x.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);x.answer(prep,{action:byApp()});await x.drain();
 assert.equal(x.requests('accept_pip_app_action').length,0,'nothing more runs');
 assert.match(x.d.body.textContent,/Shop app had already accepted create_dispatch\. It ran once\./);
 // The app decides in the moment between Allow's prepare and its accept: the accept observes it, and says so.
 const y=setup({apiVersion:62});await openChat(y);
 y.click(`[data-plugin-run="${DRAFT}"]`);await flush();
 y.answer(y.requests('prepare_pip_connector_draft').at(-1),{action:action()});await flush();
 const ok=y.requests('accept_pip_app_action').at(-1);
 y.setDrafts([draft(call,{status:'prepared',action_id:ACTION})]);y.answer(ok,{action:byApp()});await y.drain();
 assert.match(y.d.body.textContent,/Shop app had already accepted create_dispatch\. It ran once\./);
 assert.doesNotMatch(y.d.body.textContent,/Done: create_dispatch ran/);
});
