// A Personal Pip's page, as on Grok's bots (Pips API 43): Info (Instructions, Routines, Notifications,
// Share as template), Links, Media and Files; its face and colour; routines the Pip suggests in its chat;
// and Pips settings for every computer and app. The founder: "Bots main settings are just Instructions
// and Routines... Very very easy. Pips should work this same way."
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
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32),R1='routine_'+'1'.repeat(32),R2='routine_'+'2'.repeat(32),RUN='run_'+'a'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(extra={})=>({id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Look after my inbox and tell me what matters.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true},...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const now=new Date().toISOString(),earlier=new Date(Date.now()-3600e3).toISOString();
const DAILY={kind:'schedule',schedule:{type:'daily',time:'08:00',timezone:'Asia/Kolkata',missed_policy:'coalesce_latest',dst_policy:'skip_gap_first_fold'}};
const routine=(extra={})=>({id:R1,pip_id:PIP,workspace_id:PW,title:'Morning brief',prompt:'Tell me what today looks like.',trigger:DAILY,label:'every day at 08:00',status:'on',created_by:'user',run_id:null,next_due_at:'2026-10-08T02:30:00Z',last_run_at:null,last_error:null,created_at:earlier,updated_at:earlier,...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({row=pip(),list=[],shared={},computers=null,apps=[]}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const state={row,list};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[state.row]}),get_pip:()=>({pip:state.row}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:state.list}),
  list_pip_shared:()=>({pip_id:PIP,workspace_id:PW,kind:r.kind,items:shared[r.kind]||[]}),
  get_pip_computers:()=>computers,list_pip_apps:()=>({apps})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion:43,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 return {w,d:w.document,sent,answer,requests,drain,click,type,state};
}
async function openPage(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();x.click('[data-tab="job"]');await x.drain();}

test('its page is Info, Links, Media and Files: Instructions, Routines, Notifications and Share, nothing else',async()=>{
 const x=setup();await openPage(x);
 assert.deepEqual([...x.d.querySelectorAll('.pip-page-tabs button')].map(b=>b.textContent),['Info','Links','Media','Files']);
 const body=x.d.querySelector('.pip-page-body').textContent;
 assert.match(body,/Instructions.*Look after my inbox/);
 assert.match(body,/Routines.*No routines yet/);
 assert.match(body,/Notifications.*Get notified when Ava finishes something on its own or needs you\./);
 assert.match(body,/Share as template/);
 assert.ok(x.d.querySelector('[data-routine-new]'),'+ Add routine');
 for(const gone of ['Model this Pip uses','When it runs','Usage','Allowed without asking','Advanced'])assert.doesNotMatch(x.d.body.textContent,new RegExp(gone),gone+' is not on its page');
 assert.equal(x.d.querySelector('#pipPageName').value,'Ava');
 assert.equal(x.d.querySelector('#pipPageTitle').placeholder,'Title (optional)');
 const menu=[...x.d.querySelectorAll('.pip-menu .tabs-menu button')].map(b=>b.textContent);
 assert.deepEqual(menu,['Results','Memory','Copy ID','Pause','Archive…']);
});

test('you add a routine in a few words; its switch turns it off; editing saves only what changed',async()=>{
 const x=setup();await openPage(x);
 x.click('[data-routine-new]');
 x.type('#routineTitle','Morning brief');x.type('#routinePrompt','Tell me what today looks like.');
 x.type('#routineKind','weekdays');x.type('#routineTime','07:30');
 x.d.querySelector('#routine-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 const [added]=x.requests('add_pip_routine');
 assert.equal(added.request.title,'Morning brief');
 assert.deepEqual(JSON.parse(JSON.stringify(added.request.trigger)).schedule.cron,'30 7 * * 1-5');
 x.state.list=[routine()];x.answer(added,{routine:routine()});await x.drain();
 assert.match(x.d.querySelector('.routine-row').textContent,/Morning brief.*Every day at 08:00/);
 const toggle=x.d.querySelector(`[data-routine-toggle="${R1}"]`);toggle.checked=false;toggle.dispatchEvent(new x.w.Event('change',{bubbles:true}));await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('update_pip_routine')[0].request.changes)),{status:'off'});
 x.answer(x.requests('update_pip_routine')[0],{routine:routine({status:'off'})});await x.drain();
 x.click(`[data-routine-edit="${R1}"]`);x.type('#routineTitle','Daily brief');
 x.d.querySelector('#routine-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 const edit=x.requests('update_pip_routine')[1];
 assert.deepEqual(Object.keys(edit.request.changes).sort(),['prompt','title'],'the same "when" is not sent: its schedule is not restarted');
});

test('a routine the Pip suggests is a card under its message: Add routine or Not now',async()=>{
 const x=setup({list:[routine({id:R2,status:'suggested',created_by:'pip',run_id:RUN,next_due_at:null,title:'Bank alerts',prompt:'Tell me what the bank email says.',trigger:{kind:'email',query:'from:alerts@bank.example',every_minutes:10}})]});
 await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();
 const card=x.d.querySelector(`[data-routine-card="${R2}"]`);assert.ok(card,'the card is in the chat');
 assert.match(card.textContent,/Add this routine\? Bank alerts.*When an email matching “from:alerts@bank.example” arrives.*Tell me what the bank email says\./);
 x.click(`[data-routine-add="${R2}"]`);await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('decide_pip_routine')[0].request)),{type:'decide_pip_routine',pip_id:PIP,routine_id:R2,add:true});
});

test('its face and colour: choose, Save, and Reset to default',async()=>{
 const x=setup();await openPage(x);
 x.click('[data-pip-page="character"]');await flush();
 assert.equal(x.d.querySelectorAll('[data-pip-body]').length,8,'the eight Pip faces');
 assert.ok(x.d.querySelector('[data-pip-character-save]').disabled,'nothing to save yet');
 x.click('[data-pip-body="lens"]');x.click('[data-pip-color="mint"]');
 assert.equal(x.d.querySelector('.pip-character-preview .avatar').dataset.tint,'mint');
 assert.equal(x.d.querySelector('.pip-character-preview .avatar').dataset.character,'lens');
 x.click('[data-pip-character-save]');await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('set_pip_profile')[0].request.changes)),{body:'lens',color:'mint'});
 x.state.row=pip({profile:{title:'',body:'lens',color:'mint',notify:true}});
 x.answer(x.requests('set_pip_profile')[0],{pip_id:PIP,profile:{title:'',body:'lens',color:'mint',notify:true}});await x.drain();
 assert.equal(x.d.querySelector('.pip-pill .avatar').dataset.tint,'mint','its face changes everywhere');
 x.click('[data-pip-page="character"]');x.click('[data-pip-character-reset]');x.click('[data-pip-character-save]');await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('set_pip_profile')[1].request.changes)),{body:null,color:null});
});

test('notifications, name and title are saved from its page',async()=>{
 const x=setup();await openPage(x);
 const sw=x.d.querySelector('#pipNotify');sw.checked=false;sw.dispatchEvent(new x.w.Event('change',{bubbles:true}));await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('set_pip_profile')[0].request.changes)),{notify:false});
 x.answer(x.requests('set_pip_profile')[0],{pip_id:PIP,profile:{title:'',body:null,color:null,notify:false}});await x.drain();
 x.type('#pipPageTitle','Inbox helper');x.type('#pipPageName','Avery');
 x.d.querySelector('#pip-name-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('set_pip_profile')[1].request.changes)),{title:'Inbox helper'});
 x.answer(x.requests('set_pip_profile')[1],{pip_id:PIP,profile:{title:'Inbox helper',body:null,color:null,notify:false}});await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{name:'Avery'});
});

test('Links lists what was shared in its chat and opens through the host; Media and Files too',async()=>{
 const x=setup({shared:{links:[{url:'https://example.com/a',host:'example.com',message_id:'m1',from:'pip',at:now}],
  media:[{message_id:'m2',index:0,mime:'image/png',bytes:68,from:'you',at:now}],files:[{message_id:'m3',index:0,name:'notes.txt',bytes:10,from:'you',at:now}]}});
 await openPage(x);
 x.click('[data-pip-page-tab="links"]');await x.drain();
 assert.match(x.d.querySelector('.pip-shared').textContent,/example\.com.*https:\/\/example\.com\/a/);
 x.click('[data-open-link="https://example.com/a"]');
 assert.deepEqual(JSON.parse(JSON.stringify(x.sent.at(-1))),{type:'openExternal',url:'https://example.com/a'});
 x.click('[data-pip-page-tab="media"]');await x.drain();
 assert.equal(x.d.querySelector('.pip-media img').dataset.messageImage,'m2:0','loaded like the chat\'s own images');
 x.click('[data-pip-page-tab="files"]');await x.drain();
 assert.match(x.d.querySelector('.pip-page-body').textContent,/notes\.txt.*You sent · 10 B/);
});

test('Pips settings: update the computers, reset one (asking first), see the disk; and one list of apps',async()=>{
 const computers={available:true,reason:'',platform:'linux',setup:{state:'ready',step:'',done:0,total:0,error:'',chrome:'141.0.7390.54',checked_at:earlier},
  computers:[{pip_id:PIP,name:'Ava',bytes:52428800,complete:true,files_bytes:1048576,using:false,resetting:false}],programs_bytes:314572800,free_bytes:107374182400};
 const x=setup({computers,apps:[{toolkit:'gmail',app:'Gmail',label:'me@example.com',account:'ca_x',pips:[{pip_id:PIP,name:'Ava',link_id:'applink_'+'a'.repeat(32)}]}]});
 await x.drain();x.click('#pips-settings-open');await x.drain();
 const text=x.d.body.textContent;
 assert.match(text,/Update computer.*Up to date · Chrome 141\.0\.7390\.54/);
 assert.match(text,/Disk space.*Pip computers use 350 MB.*100 GB free on this disk/);
 x.click(`[data-computer-reset-ask="${PIP}"]`);
 assert.equal(x.requests('reset_pip_computer').length,0,'it asks first');
 x.click(`[data-computer-reset="${PIP}"]`);await flush();
 assert.equal(x.requests('reset_pip_computer')[0].request.pip_id,PIP);
 x.answer(x.requests('reset_pip_computer')[0],{pip_id:PIP,resetting:false,reset:true});await x.drain();
 assert.match(x.d.body.textContent,/Its computer is fresh/);
 x.click('[data-pips-settings="apps"]');await x.drain();
 assert.match(x.d.body.textContent,/Gmail.*me@example\.com.*Ava can use it/);
 x.click('[data-app-remove]');await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('disconnect_pip_app_link')[0].request)),{type:'disconnect_pip_app_link',pip_id:PIP,link_id:'applink_'+'a'.repeat(32)});
});

test('a routine in words, and the form says what to fix',()=>{
 assert.equal(routines.routineWhen({kind:'schedule',schedule:{type:'cron',cron:'0 9 * * 1',timezone:'UTC'}}),'Mondays at 09:00');
 assert.equal(routines.routineWhen({kind:'schedule',schedule:{type:'interval',minutes:180}}),'Every 3 hours');
 assert.equal(routines.routineWhen({kind:'calendar',lead_minutes:15,every_minutes:10}),'15 minutes before each calendar event');
 const d={...routines.routineDraft(null,'Asia/Kolkata'),routineTitle:'x',routinePrompt:'y'};
 assert.throws(()=>routines.routineFromDraft({...d,routineTitle:''}),/Give the routine a name/);
 assert.throws(()=>routines.routineFromDraft({...d,routineKind:'once',routineAt:'2000-01-01T09:00'}),/future/);
 assert.throws(()=>routines.routineFromDraft({...d,routineKind:'email',routineQuery:''}),/Gmail search/);
 assert.deepEqual(routines.routineFromDraft({...d,routineKind:'hours',routineHours:'2'}).trigger,{kind:'schedule',schedule:{type:'interval',minutes:120,missed_policy:'coalesce_latest'}});
 const back=routines.routineDraft(routine({trigger:{kind:'schedule',schedule:{type:'cron',cron:'15 6 * * 3',timezone:'UTC'}}}));
 assert.deepEqual([back.routineKind,back.routineDay,back.routineTime],['weekly','3','06:15']);
});
