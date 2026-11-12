// Webhooks in, fully local (pips-22, Pips API 90): a Personal Pip's routine that runs when a service calls its own
// secret address. The screens (src/pipRoutines.js, src/pipWebhooks.js, src/pipsClient.js, src/pipsView.ts):
//   - a routine whose "when" is a webhook loads, and says "When a service calls its address"
//   - the routine form offers "A service calls its address" at API 90 and up, never below, never over a remote host
//   - the routine's panel: its address a row per way that reaches it, cut short until Show, Copy copying it whole;
//     Replace address behind a confirm; the signing secret; a test call; its latest calls in words
//   - Pips settings → Webhooks: this computer, the home network switch, Tailscale Funnel behind a dialog with
//     Tailscale's own words, an address of your own, refusals inline, calls to an address no routine has
//   - the host passes the six commands at API 90 and refuses them below it
// (Harness from pip-app-event-routines.)
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
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
const TOKEN='4ebed6'+'0123456789abcdef'.repeat(3).slice(0,42),TOKEN2='77aa10'+'fedcba9876543210'.repeat(3).slice(0,42);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pipRow={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Look after the shop.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const earlier=new Date(Date.now()-3600e3).toISOString();
const WHEN={kind:'webhook'};
const routine=(extra={})=>({id:R1,pip_id:PIP,workspace_id:PW,title:'New payments',prompt:'Say who paid and how much.',trigger:WHEN,label:'when a service calls its webhook address',status:'on',created_by:'user',run_id:null,next_due_at:null,last_run_at:null,last_error:null,created_at:earlier,updated_at:earlier,...extra});
const call=(extra={})=>({at:earlier,via:'internet',service:'Stripe',event:'payment_intent.succeeded',outcome:'queued',reason:null,times:1,bytes:812,ran:true,run_id:null,...extra});
const hook=(extra={},token=TOKEN)=>({pip_id:PIP,routine_id:R1,path:'/hooks/'+token,addresses:{computer:`http://127.0.0.1:47615/hooks/${token}`,network:null,internet:null},signing:false,listening:true,listen_error:null,calls:[],...extra});
const OPENS="Turning it on makes only DGC's webhook path reachable from the internet, at this computer's Tailscale name followed by /dgc-hooks/, and only a routine's secret address gets an answer. Nothing else on this computer, and nothing else you serve with Tailscale, is opened. You can turn it off here at any time.";
const tailscale=(extra={})=>({installed:true,running:true,funnel_allowed:true,operator:true,ready:true,on:false,public_base:null,port:null,opens:OPENS,words:'',...extra});
const reach=(extra={},ts={})=>({listening:true,port:47615,bind:'127.0.0.1',listen_error:null,local_network:false,network_address:null,tunnel:{kind:null,on:false,public_base:null,tailscale:tailscale(ts),cloudflared:false},refused:[],...extra});
const BASE='https://studio.tail1234.ts.net/dgc-hooks';
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const clean=v=>JSON.parse(JSON.stringify(v));

function setup({apiVersion=90,list=[],webhook=hook(),reached=reach(),host}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const state={list,webhook,reach:reached,hold:new Set()};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[pipRow]}),get_pip:()=>({pip:pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  get_pip_computers:()=>({available:true,setup:{state:"ready"},computers:[]}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins:[],installed:[]}),list_apps:()=>({apps:[]}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:state.list}),list_pip_shared:()=>({pip_id:PIP,workspace_id:PW,kind:r.kind,items:[]}),
  list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),
  get_pip_webhook:()=>state.webhook,get_webhook_reach:()=>state.reach}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id)&&!state.hold.has(m.request.type))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true,...(host?{host}:{})});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const submit=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
 const text=s=>(w.document.querySelector(s)?.textContent||'').replace(/\s+/g,' ').trim();
 return {w,d:w.document,sent,answer,requests,drain,click,type,submit,text,state};
}
async function openPage(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();x.click('[data-tab="job"]');await x.drain();}
async function openPanel(x){await openPage(x);x.click(`[data-routine-edit="${R1}"]`);await x.drain();assert.ok(x.d.querySelector(`[data-webhook-panel="${R1}"]`),'its panel, under its card');}
async function openReach(x){await x.drain();x.click('#pips-settings-open');await x.drain();x.click('[data-pips-settings="webhooks"]');await x.drain();assert.ok(x.d.querySelector('.webhook-reach'),'the Webhooks section');}
const hooksModule=async()=>{assert.ok(existsSync(new URL('pipWebhooks.js',base)),'src/pipWebhooks.js');return load(await bundle('pipWebhooks.js'));};

test('a routine a service calls loads, and says when in words',()=>{
 assert.equal(routines.routine(routine(),PIP).trigger.kind,'webhook');
 assert.equal(routines.routineWhen(WHEN),'When a service calls its address');
 assert.equal(routines.routineDraft(routine(),'UTC').routineKind,'webhook');
 const d={...routines.routineDraft(null,'UTC'),routineTitle:'x',routinePrompt:'y',routineKind:'webhook'};
 assert.deepEqual(routines.routineFromDraft(d).trigger,WHEN,'nothing but its kind: DGC makes the address');
 assert.throws(()=>routines.routine(routine({trigger:{kind:'pigeon'}}),PIP),/didn’t load/,'a kind it doesn’t know is still refused');
 const esc=s=>String(s);
 const offered=routines.routineFormMarkup(d,{esc,webhooks:true}),older=routines.routineFormMarkup({...d,routineKind:'daily'},{esc});
 assert.match(offered,/<option value="webhook" selected>A service calls its address<\/option>/);
 assert.match(offered,/DGC makes a secret address for it\. Paste that address into the service \(Stripe, GitHub, a form\)\./);
 assert.doesNotMatch(older,/value="webhook"/,'not offered unless DGC takes it');
});

test('its routines list asks for webhook routines at API 90, and not below',async()=>{
 const x=setup({list:[routine()]});await openPage(x);
 const asked=x.requests('list_pip_routines');
 assert.ok(asked.length&&asked.every(m=>m.request.webhooks===true),'API 90: routines a service calls too');
 assert.match(x.text('.routine-row'),/New payments.*When a service calls its address/);
 const old=setup({apiVersion:89});await openPage(old);
 assert.ok(old.requests('list_pip_routines').length&&old.requests('list_pip_routines').every(m=>!('webhooks' in m.request)),'API 89 takes no such field');
 old.click('[data-routine-new]');
 assert.ok(![...old.d.querySelectorAll('#routineKind option')].some(o=>o.value==='webhook'),'and the form has no such choice');
 for(const type of ['get_pip_webhook','get_webhook_reach','set_webhook_reach'])assert.equal(old.requests(type).length,0,type);
});

test('you add one: the fourth choice, one line under it, and its panel opens with the address',async()=>{
 const x=setup();await openPage(x);
 x.click('[data-routine-new]');
 const kinds=[...x.d.querySelectorAll('#routineKind option')].map(o=>[o.value,o.textContent]);
 assert.deepEqual(kinds.find(k=>k[0]==='webhook'),['webhook','A service calls its address']);
 assert.deepEqual(kinds.map(k=>k[0]).filter(k=>['email','calendar','app','webhook'].includes(k)),['email','calendar','webhook'],'after an email and a calendar event');
 x.type('#routineTitle','New payments');x.type('#routinePrompt','Say who paid and how much.');x.type('#routineKind','webhook');await x.drain();
 assert.match(x.text('#routine-form'),/DGC makes a secret address for it\. Paste that address into the service \(Stripe, GitHub, a form\)\./);
 x.submit('#routine-form');await flush();
 const [added]=x.requests('add_pip_routine');
 assert.deepEqual(clean(added.request.trigger),WHEN);
 x.state.list=[routine()];x.answer(added,{routine:routine()});await x.drain();
 assert.match(x.text('.routine-row'),/When a service calls its address/);
 const asked=x.requests('get_pip_webhook');
 assert.deepEqual(clean(asked.map(m=>[m.request.pip_id,m.request.routine_id])),[[PIP,R1]],'right after you add one');
 assert.ok(x.d.querySelector(`[data-webhook-panel="${R1}"] [data-hook-copy="computer"]`),'its address is there to copy');
});

test('the address is a secret: cut short until Show, Copy copies it whole, and it is in no tooltip',async()=>{
 const whole=`${BASE}/${TOKEN}`,near=`http://192.0.2.20:47615/hooks/${TOKEN}`;
 const x=setup({list:[routine()],webhook:hook({addresses:{computer:`http://127.0.0.1:47615/hooks/${TOKEN}`,network:near,internet:whole}})});await openPanel(x);
 const panel=()=>x.d.querySelector('[data-webhook-panel]');
 assert.deepEqual([...panel().querySelectorAll('.webhook-address')].map(r=>[r.dataset.hookWay,r.querySelector('.webhook-way').textContent]),
  [['computer','From this computer'],['network','From your home network'],['internet','From the internet']]);
 assert.deepEqual([...panel().querySelectorAll('.webhook-url')].map(n=>n.textContent),['…/hooks/4ebed6…','…/hooks/4ebed6…','…/dgc-hooks/4ebed6…']);
 assert.ok(!x.d.documentElement.outerHTML.includes(TOKEN),'cut short: the whole address is nowhere on the page');
 assert.equal(panel().querySelector('[data-hook-show]').textContent,'Show');
 x.click('[data-hook-copy="internet"]');
 assert.deepEqual(clean(x.sent.filter(m=>m.type==='copy')),[{type:'copy',text:whole}],'Copy copies it whole, cut short or not');
 assert.ok(!x.d.documentElement.outerHTML.includes(TOKEN),'and saying so does not show it');
 x.click('[data-hook-show]');
 assert.deepEqual([...panel().querySelectorAll('.webhook-url')].map(n=>n.textContent),[`http://127.0.0.1:47615/hooks/${TOKEN}`,near,whole]);
 assert.equal(panel().querySelector('[data-hook-show]').textContent,'Hide');
 for(const n of panel().querySelectorAll('*'))for(const a of n.attributes)assert.ok(!a.value.includes(TOKEN),`not in an attribute (${n.tagName} ${a.name})`);
 x.click('[data-hook-show]');
 assert.ok(!x.d.documentElement.outerHTML.includes(TOKEN),'Hide cuts it short again');
 // Leaving the page and coming back: cut short again, never left showing.
 x.click('[data-hook-show]');x.click('[data-routine-cancel]');await x.drain();x.click(`[data-routine-edit="${R1}"]`);await x.drain();
 assert.equal(panel().querySelector('[data-hook-show]').textContent,'Show');
 assert.ok(!x.d.documentElement.outerHTML.includes(TOKEN));
});

test('only the ways that reach it are listed, and with none from the internet a link goes to the reach settings',async()=>{
 const x=setup({list:[routine()]});await openPanel(x);
 assert.deepEqual([...x.d.querySelectorAll('.webhook-address')].map(r=>r.dataset.hookWay),['computer']);
 assert.match(x.text('.webhook-unreached'),/^Services on the internet can’t reach it yet\. Set up how calls reach this computer\.$/);
 x.click('[data-hook-reach]');await x.drain();
 assert.ok(x.d.querySelector('.webhook-reach'),'Pips settings, at Webhooks');
 assert.equal(x.d.querySelector('[data-pips-settings="webhooks"]').getAttribute('aria-pressed'),'true');
 assert.equal(x.requests('get_webhook_reach').length,1);
 const on=setup({list:[routine()],webhook:hook({addresses:{computer:`http://127.0.0.1:47615/hooks/${TOKEN}`,network:null,internet:`${BASE}/${TOKEN}`}})});await openPanel(on);
 assert.equal(on.d.querySelector('.webhook-unreached'),null,'reached from the internet: nothing to set up');
});

test('Replace address asks first, then the old one is gone',async()=>{
 const x=setup({list:[routine()]});await openPanel(x);
 x.click('[data-hook-replace]');
 assert.equal(x.requests('replace_pip_webhook_address').length,0,'nothing is sent before you confirm');
 assert.match(x.text('#review-root .dialog'),/The old address stops working at once\. Services that use it need the new one\./);
 x.click('#review-cancel');
 assert.equal(x.requests('replace_pip_webhook_address').length,0);
 x.click('[data-hook-replace]');x.click('#review-confirm');await flush();
 const [sent]=x.requests('replace_pip_webhook_address');
 assert.deepEqual(clean(sent.request),{type:'replace_pip_webhook_address',pip_id:PIP,routine_id:R1});
 x.state.webhook=hook({},TOKEN2);x.answer(sent,x.state.webhook);await x.drain();
 assert.equal(x.d.querySelector('#review-root .dialog'),null);
 assert.equal(x.text('.webhook-url'),'…/hooks/77aa10…','the new address, cut short');
 x.click('[data-hook-copy="computer"]');
 assert.equal(x.sent.filter(m=>m.type==='copy').at(-1).text,`http://127.0.0.1:47615/hooks/${TOKEN2}`);
});

test('the signing secret: saved from a password field, never shown again, and removed',async()=>{
 const x=setup({list:[routine()]});await openPanel(x);
 assert.match(x.text('.webhook-signing'),/Paste the secret the service shows \(GitHub’s webhook secret, Stripe’s whsec_…\)\. DGC then refuses calls it didn’t sign\./);
 assert.equal(x.d.querySelector('#hookSecret').type,'password');
 assert.equal(x.d.querySelector('[data-hook-signing-remove]'),null,'none set: nothing to remove');
 x.type('#hookSecret','whsec_abcdefgh12345678');x.submit('[data-hook-signing-form]');await flush();
 const [saved]=x.requests('set_pip_webhook_signing');
 assert.deepEqual(clean(saved.request),{type:'set_pip_webhook_signing',pip_id:PIP,routine_id:R1,secret:'whsec_abcdefgh12345678'});
 x.state.webhook=hook({signing:true});x.answer(saved,x.state.webhook);await x.drain();
 assert.equal(x.d.querySelector('#hookSecret').value,'','the field is emptied');
 assert.ok(!x.d.documentElement.outerHTML.includes('whsec_abcdefgh'),'and the secret is nowhere on the page');
 assert.match(x.text('.webhook-signing'),/Calls must be signed/);
 x.click('[data-hook-signing-remove]');await flush();
 assert.deepEqual(clean(x.requests('set_pip_webhook_signing')[1].request),{type:'set_pip_webhook_signing',pip_id:PIP,routine_id:R1,secret:null});
 // DGC's own words when it refuses one.
 const y=setup({list:[routine()]});await openPanel(y);
 y.type('#hookSecret','short');y.submit('[data-hook-signing-form]');await flush();
 y.answer(y.requests('set_pip_webhook_signing')[0],'Paste the signing secret as the service shows it: 8 to 256 characters, no spaces.',false);await y.drain();
 assert.match(y.text('.webhook-signing [role=alert]'),/8 to 256 characters, no spaces/);
});

test('Send a test call says what happened in one line',async()=>{
 const x=setup({list:[routine()]});await openPanel(x);
 x.click('[data-hook-test]');await flush();
 const [sent]=x.requests('send_pip_webhook_test');
 assert.deepEqual(clean(sent.request),{type:'send_pip_webhook_test',pip_id:PIP,routine_id:R1});
 x.state.webhook=hook({calls:[call({via:'computer',service:'DGC',event:null,ran:false})]});
 x.answer(sent,{...x.state.webhook,test:{status:202,outcome:'queued'}});await x.drain();
 assert.equal(x.text('.webhook-test-result'),'Received. It runs once now.');
 assert.match(x.text('.webhook-call'),/DGC.*This computer.*Waiting to run/);
 x.click('[data-hook-test]');await flush();
 x.answer(x.requests('send_pip_webhook_test')[1],'Nothing is listening for calls: the Pips runner isn’t running on this computer. Turn Pips on, then send the test again.',false);await x.drain();
 assert.match(x.text('.webhook-test-result'),/the Pips runner isn’t running on this computer/,'or DGC’s words');
});

test('its latest calls, in words',async()=>{
 const m=await hooksModule();
 const says=c=>m.callOutcome(call(c));
 assert.deepEqual([says({}),says({ran:false}),says({outcome:'repeat',reason:'repeat'}),says({outcome:'test',reason:'ping',service:'GitHub'}),
  says({outcome:'paused',reason:'routine_off'}),says({outcome:'paused',reason:'pip_off'}),says({outcome:'paused',reason:'pips_stopped'}),
  says({outcome:'refused',reason:'signature'}),says({outcome:'refused',reason:'rate_limited',times:3})],
  ['Ran','Waiting to run','Already had it','Test (GitHub ping)','Not run: the routine is off','Not run: the Pip is off','Not run: Pips are stopped',
   'Refused: the signature didn’t match','Refused: too many calls ×3']);
 const x=setup({list:[routine()],webhook:hook({calls:[call(),call({service:null,event:null,via:'network',outcome:'refused',reason:'rate_limited',times:3,ran:false}),
  call({service:'GitHub',event:'ping',via:'computer',outcome:'test',reason:'ping',ran:false})]})});await openPanel(x);
 const rows=[...x.d.querySelectorAll('.webhook-call')].map(r=>r.textContent.replace(/\s+/g,' ').trim());
 assert.equal(rows.length,3);
 assert.match(rows[0],/Stripe.*payment_intent\.succeeded.*Internet.*Ran/);
 assert.match(rows[1],/A service.*Home network.*Refused: too many calls ×3/);
 assert.match(rows[2],/GitHub.*ping.*This computer.*Test \(GitHub ping\)/);
 assert.ok(x.d.querySelector('.webhook-call time')?.getAttribute('datetime'),'each with its time');
 const none=setup({list:[routine()]});await openPanel(none);
 assert.equal(none.text('.webhook-empty'),'No calls yet.');
});

test('when nothing is listening it says so, or says DGC’s reason',async()=>{
 const x=setup({list:[routine()],webhook:hook({listening:false})});await openPanel(x);
 assert.equal(x.text('.webhook-listening'),'Not listening yet. With Pips on, DGC starts listening within a few seconds of a routine like this being on.');
 const y=setup({list:[routine()],webhook:hook({listening:false,listen_error:'Port 47615 is in use by another program.'})});await openPanel(y);
 assert.equal(y.text('.webhook-listening'),'Port 47615 is in use by another program.');
 const z=setup({list:[routine()]});await openPanel(z);
 assert.equal(z.d.querySelector('.webhook-listening'),null);
});

test('Pips settings → Webhooks: this computer, and the home network switch',async()=>{
 const x=setup();await openReach(x);
 assert.equal(x.requests('get_webhook_reach').length,1);
 assert.match(x.text('.webhook-reach'),/This computer.*Always on.*port 47615/i);
 const box=x.d.querySelector('#hook-network');
 assert.equal(box.checked,false);assert.ok(box.closest('label.switch'),'the shared switch');
 assert.match(x.text('.webhook-reach'),/Your home network.*Devices on your network can call your routines’ addresses\./);
 box.checked=true;box.dispatchEvent(new x.w.Event('change',{bubbles:true}));await flush();
 const [sent]=x.requests('set_webhook_reach');
 assert.deepEqual(clean(sent.request),{type:'set_webhook_reach',local_network:true});
 x.state.reach=reach({local_network:true,network_address:'192.0.2.20'});x.answer(sent,x.state.reach);await x.drain();
 assert.equal(x.d.querySelector('#hook-network').checked,true);
 // Below API 90 there is no such tab, and nothing is asked.
 const old=setup({apiVersion:89});await old.drain();old.click('#pips-settings-open');await old.drain();
 assert.equal(old.d.querySelector('[data-pips-settings="webhooks"]'),null);
 assert.equal(old.requests('get_webhook_reach').length,0);
});

test('Tailscale Funnel: its own words, a dialog with the same words, Turning on…, then On with Turn off',async()=>{
 const x=setup();await openReach(x);
 assert.ok(x.text('.webhook-internet').includes(OPENS),'what it opens, before anything is turned on');
 x.click('[data-reach-tailscale]');
 assert.equal(x.requests('set_webhook_reach').length,0,'it asks first');
 assert.ok(x.text('#review-root .dialog').includes(OPENS),'the dialog says the same words');
 assert.deepEqual([x.text('#review-confirm'),x.text('#review-cancel')],['Turn on','Cancel']);
 x.click('#review-cancel');assert.equal(x.requests('set_webhook_reach').length,0);
 x.click('[data-reach-tailscale]');x.state.hold.add('set_webhook_reach');x.click('#review-confirm');await flush();
 const [sent]=x.requests('set_webhook_reach');
 assert.deepEqual(clean(sent.request),{type:'set_webhook_reach',tunnel:'tailscale'});
 assert.match(x.text('#review-root .dialog')+x.text('.webhook-internet'),/Turning on…/);
 x.state.reach=reach({tunnel:{kind:'tailscale',on:true,public_base:BASE,tailscale:tailscale({on:true,public_base:BASE,port:443}),cloudflared:false}});
 x.answer(sent,x.state.reach);await x.drain();
 assert.equal(x.d.querySelector('#review-root .dialog'),null);
 assert.match(x.text('.webhook-internet'),new RegExp('On: '+BASE.replace(/[.]/g,'\\.')));
 assert.match(x.text('.webhook-internet'),/The first call can take a few minutes to get through after you turn it on\./);
 assert.equal(x.d.querySelector('[data-reach-tailscale]'),null);
 x.click('[data-reach-off]');await flush();
 assert.deepEqual(clean(x.requests('set_webhook_reach')[1].request),{type:'set_webhook_reach',tunnel:null});
});

test('a refusal is said inline in DGC’s words, and Tailscale’s link opens in the browser',async()=>{
 const x=setup({reached:reach({},{funnel_allowed:false,ready:false,words:'Tailscale Funnel isn’t allowed for this computer in your Tailscale account yet. Turn it on and Tailscale shows a link to allow Funnel and HTTPS; or allow them in its admin console.'})});await openReach(x);
 assert.match(x.text('.webhook-internet'),/isn’t allowed for this computer in your Tailscale account yet/);
 x.click('[data-reach-tailscale]');x.click('#review-confirm');await flush();
 const LINK='https://login.tailscale.com/f/funnel?node=abc123';
 x.answer(x.requests('set_webhook_reach')[0],`Tailscale asks you to allow Funnel first: open ${LINK} and allow it, then turn it on here again.`,false);await x.drain();
 assert.equal(x.d.querySelector('#review-root .dialog'),null,'said in the section, not left in a dialog');
 assert.match(x.text('.webhook-refusal'),/Tailscale asks you to allow Funnel first: open .* and allow it, then turn it on here again\./);
 assert.equal(x.d.querySelector('.webhook-refusal').getAttribute('role'),'alert');
 x.click('.webhook-refusal [data-open-link]');
 assert.deepEqual(clean(x.sent.filter(m=>m.type==='openExternal')),[{type:'openExternal',url:LINK}]);
 // Not installed: its words, and tailscale.com opens in the browser. Nothing to turn on.
 const none=setup({reached:reach({},{installed:false,running:false,funnel_allowed:false,ready:false,words:'Install Tailscale from tailscale.com and sign in with your own account. Then DGC can turn on Tailscale Funnel for your routines’ addresses with one click.'})});await openReach(none);
 assert.match(none.text('.webhook-internet'),/Install Tailscale from tailscale\.com and sign in with your own account\./);
 assert.equal(none.d.querySelector('[data-reach-tailscale]'),null);
 none.click('.webhook-internet [data-open-link]');
 assert.deepEqual(clean(none.sent.filter(m=>m.type==='openExternal')),[{type:'openExternal',url:'https://tailscale.com/download'}]);
});

test('an address of your own: folded, an https field and Save',async()=>{
 const x=setup({reached:reach({tunnel:{kind:null,on:false,public_base:null,tailscale:tailscale(),cloudflared:true}})});await openReach(x);
 const own=x.d.querySelector('details.webhook-own');
 assert.equal(own.open,false,'folded');
 assert.equal(own.querySelector('summary').textContent.trim(),'Use an address of your own');
 assert.match(x.text('details.webhook-own'),/For Cloudflare Tunnel or a server of yours: the address that reaches this computer’s port 47615 at \/hooks\. DGC puts each routine’s secret after it\./);
 assert.match(x.text('details.webhook-own'),/Cloudflare’s cloudflared is installed on this computer\./);
 x.type('#hookOwnBase','https://hooks.example.com/dgc');x.submit('[data-reach-own-form]');await flush();
 const [sent]=x.requests('set_webhook_reach');
 assert.deepEqual(clean(sent.request),{type:'set_webhook_reach',tunnel:'own',own_base:'https://hooks.example.com/dgc'});
 x.answer(sent,'An address of your own starts with https:// and has no ? or #: the service calls it with the routine’s secret after it.',false);await x.drain();
 assert.match(x.text('.webhook-refusal'),/starts with https:\/\//);
 const plain=setup();await openReach(plain);
 assert.doesNotMatch(plain.text('details.webhook-own'),/cloudflared/,'said only when it is installed');
});

test('calls to an address no routine has are listed quietly, when there are any',async()=>{
 const x=setup({reached:reach({refused:[{at:earlier,via:'internet',reason:'unknown_address',times:4},{at:earlier,via:'network',reason:'unknown_address',times:1}]})});await openReach(x);
 assert.match(x.text('.webhook-refused'),/Calls to an address no routine has/);
 const rows=[...x.d.querySelectorAll('.webhook-refused li')].map(r=>r.textContent.replace(/\s+/g,' ').trim());
 assert.equal(rows.length,2);assert.match(rows[0],/Internet.*×4/);assert.match(rows[1],/Home network/);assert.doesNotMatch(rows[1],/×/);
 const none=setup();await openReach(none);
 assert.equal(none.d.querySelector('.webhook-refused'),null);
});

test('offered at API 90 and up on this computer, never over a remote host',async()=>{
 const m=await hooksModule();
 assert.equal(m.webhooksOffered(90,false),true);assert.equal(m.webhooksOffered(91,false),true);
 assert.equal(m.webhooksOffered(90,true),false,'not over a remote host');assert.equal(m.webhooksOffered(89,false),false);
});

test('the host passes the six commands at API 90 and refuses them below it',()=>{
 const six=[{type:'get_pip_webhook',pip_id:PIP,routine_id:R1},{type:'replace_pip_webhook_address',pip_id:PIP,routine_id:R1},{type:'set_pip_webhook_signing',pip_id:PIP,routine_id:R1,secret:null},
  {type:'send_pip_webhook_test',pip_id:PIP,routine_id:R1},{type:'get_webhook_reach'},{type:'set_webhook_reach',local_network:true}];
 for(const api of [89,90])for(const request of six){
  const posted=[],forwarded=[];const editor=new viewModule.PipsEditor({},m=>{forwarded.push(m);return true;},()=>{});
  editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'s',request});
  if(api<90){assert.equal(forwarded.length,0,request.type);assert.equal(posted.find(m=>m.id==='s').error.message,'Update DGC for routines a service calls.');}
  else{assert.equal(forwarded.length,1,request.type);assert.ok(JSON.stringify(forwarded[0]).includes(`"type":"${request.type}"`),'the command itself');}
 }
});

test('the host refuses a routines list that asks for webhook routines below API 90',()=>{
 for(const api of [89,90]){const posted=[],forwarded=[];const editor=new viewModule.PipsEditor({},m=>{forwarded.push(m);return true;},()=>{});
  editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'s',request:{type:'list_pip_routines',pip_id:PIP,webhooks:true}});
  assert.equal(forwarded.length,api<90?0:1);if(api<90)assert.equal(posted.find(m=>m.id==='s').error.message,'Update DGC for routines a service calls.');}
});

test('a Pip tab’s Copy reaches the host, as the side bar’s does',()=>{
 const acted=[];const editor=new viewModule.PipsEditor({},()=>true,()=>{});
 editor.usePageActions(m=>acted.push(m));editor.attach(()=>{});
 editor.receive({type:'copy',text:'http://127.0.0.1:47615/hooks/'+TOKEN});
 assert.deepEqual(acted.map(m=>m.type),['copy']);
});

test('plain words: the banned word is nowhere in these screens, and an address is never logged',()=>{
 const sources=['pipWebhooks.js','pipRoutines.js'].map(f=>existsSync(new URL(f,base))?readFileSync(new URL(f,base),'utf8'):'');
 assert.ok(sources[0],'src/pipWebhooks.js');
 for(const s of sources){assert.doesNotMatch(s,/\bAI\b/);assert.doesNotMatch(s,/console\.|title="\$\{[^}]*(address|url|path)/i);}
});
