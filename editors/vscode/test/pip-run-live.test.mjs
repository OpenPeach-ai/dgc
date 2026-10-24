// A running Pip is visible in its own chat while it runs (the founder, 24 Oct). He pressed ▶ Run now: the top bar said
// "Running…" and the chat said nothing until the run ended. Now, from the moment a run starts, its chat has ONE live
// post: the Pip's face at work, what it is doing now (from the run's activity), a clock, Stop, and how it started
// ("Started by you", "On schedule · 9:00 AM", "Asked by DGC", "First run"). When the run ends that same post becomes
// the run's report post in place: no second item, no jump. It is drawn from the run's state, so a reload while it runs
// draws it again. A routine's run in a Personal Pip's chat is one too, and its reply takes its place.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {markdownJs} from './support/webview-dom.mjs';
const require=createRequire(import.meta.url);
const src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const viewCode=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const view={exports:{}};new Function('module','exports','require',viewCode)(view,view.exports,name=>name==='vscode'?{}:require(name));
const windows=[];after(()=>windows.forEach(w=>w.close()));

const PIP='pip_'+'a'.repeat(32),R0='run_'+'0'.repeat(32),RUN='run_'+'7'.repeat(32),CHAT='run_'+'9'.repeat(32);
const NOW=(()=>{const d=new Date();d.setHours(12,0,0,0);return d.getTime();})(),HOUR=3600000;
const iso=ms=>new Date(ms).toISOString();
const ws={id:'ws',name:'billing-app'};
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>{const available=['scout','lens','rook','lock'].includes(id),name=id[0].toUpperCase()+id.slice(1);return{id,name,character_index,role:{core:'Main chat',scout:'Repository exploration',lens:'Repository research',patch:'Code changes',rook:'Code review',pulse:'Test execution',lock:'Security review',quill:'Documentation writing'}[id],description:available?'Inspect committed source with a focused read-only preset.':'This role is planned.',available,unavailable_reason:available?null:'This engine is not available yet.',default_name:name+' job',default_goal:available?'Inspect source for '+id+' findings.':'',engine:available?'source_audit':null};});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const pipOf=(extra={})=>({id:PIP,workspace_id:'ws',pip_type:'rook',name:'Billing audit',goal:'Look for bugs that lose money.',source_policy:{mode:'committed_only'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',proposals:[],report_chats:1,report_session:'chat-erp',latest_run:null,active_run:null,...extra});
const listed=(id,status,trigger,at,kind='audit')=>({id,pip_id:PIP,workspace_id:'ws',status,created_at:iso(at),started_at:status==='queued'?null:iso(at),finished_at:null,requested_by:'editor-user',manifest:{run_kind:kind,job_version:1,source_revision:'a'.repeat(40),trigger,pip_type:'rook'},result:null,error:null});
const event=(seq,type,payload={})=>({seq,run_id:RUN,pip_id:PIP,workspace_id:'ws',event_type:type,payload,created_at:iso(NOW)});
const post=(extra={})=>({run_id:RUN,pip_id:PIP,name:'Billing audit',pip_type:'rook',kind:'audit',trigger:'you',text:'x',outcome:'findings',posted_at:iso(NOW),finished_at:iso(NOW),total:2,
  counts:{critical:0,high:1,medium:1,low:0},findings:[{title:'Refunds are counted twice',severity:'high',path:'app/billing.py',line:88},{title:'Rounding drops paise',severity:'medium',path:'app/billing.py',line:12}],...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

// A Pips view over a backend the test drives: `state` is what DGC holds, the test changes it as the run goes on.
function setup({personal=false,messages=[],state:initial={}}={}){
  const dom=new JSDOM(view.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  w.Date.now=()=>NOW;
  // The view's timers are the test's: `advance(ms)` runs the ones due, so the 1.5 s activity look is asserted exactly.
  let clock=0,seq=0;const timers=new Map();
  w.setTimeout=(fn,ms=0)=>{const id=++seq;timers.set(id,{fn,at:clock+Number(ms||0)});return id;};
  w.clearTimeout=id=>timers.delete(id);
  const advance=async ms=>{const until=clock+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);clock=due[1].at;due[1].fn();await drain();}clock=until;};
  const sent=[],answered=new Set();
  const state={pip:pipOf(personal?{name:'Morning brief',pip_type:'scout',source_policy:{mode:'personal'},report_chats:0,report_session:null}:{}),runs:[],posts:[],events:[],detail:{},messages,active:null,cancelled:[],...initial};
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.eval(markdownJs+'\nglobalThis.DgcMarkdown=DgcMarkdown;');w.eval(client);
  const controller=w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{},
    onMessage:listener=>{const handle=e=>listener(e.data);w.addEventListener('message',handle);return()=>w.removeEventListener('message',handle);},onAskDgc:()=>true});
  const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
  const handlers={list_workspaces:()=>({workspaces:[personal?{...ws,name:'Personal',kind:'personal'}:ws],current_workspace_id:'ws'}),list_pip_types:()=>({types}),
    list_pips:()=>({pips:[{...state.pip,active_run:state.active}]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),
    get_pip:()=>({pip:{...state.pip,active_run:state.active}}),list_pip_runs:()=>({runs:state.runs}),
    get_pip_run:r=>({run:{...(state.runs.find(x=>x.id===r.run_id)||{}),...(state.detail[r.run_id]||{})}}),
    list_pip_run_activity:r=>{const events=state.events.filter(e=>e.run_id===r.run_id&&e.seq>r.after);return {run_id:r.run_id,pip_id:PIP,workspace_id:'ws',events,next_cursor:events.length?events.at(-1).seq:r.after,has_more:false,history_may_be_truncated:false,retention_limit:1000,retention_scope:'workspace'};},
    list_pip_messages:()=>({pip_id:PIP,workspace_id:'ws',messages:state.messages,next_before_id:null,active_run:state.chatActive||null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:PIP,workspace_id:'ws',posts:state.posts,next_before_id:null}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
    list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]}),list_pip_run_fixes:()=>({pip_id:PIP,workspace_id:'ws',fixes:[]}),
    cancel_pip_run:r=>{state.cancelled.push(r.run_id);return {run:{...state.runs.find(x=>x.id===r.run_id),status:'cancelling'}};},
    run_pip:()=>state.onRun?.()};
  const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
  // Timers already due (a 0 ms one) run as the view goes on; later ones wait for advance().
  const due=()=>{for(;;){const next=[...timers].filter(([,t])=>t.at<=clock).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)return;timers.delete(next[0]);next[1].fn();}};
  async function drain(){for(let n=0;n<15;n++){await flush();due();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const handler=handlers[m.request.type];const result=handler?.(m.request);if(result!==undefined){answered.add(m.id);send({type:'pipsReply',id:m.id,ok:true,result});}}}}
  send({type:'pipsConnection',apiVersion:65,generation:1,connected:true,supported:true,enabled:true});
  const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
  // The 4 s look the view takes while its chat is on screen.
  const look=async()=>{send({type:'pipsVisibility',visible:true});await drain();};
  return {w,d:w.document,controller,sent,state,requests,drain,click,advance,look,send};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim();
const live=d=>d.querySelector('article.run-post-live');
const items=d=>[...d.querySelector('.conversation-log').children].filter(e=>e.matches('[data-run-post],[data-message]'));
// A run that started 42 seconds ago, as get_pip and list_pip_runs show it.
function running(x,{trigger='manual',status='running',kind='audit'}={}){
  x.state.active={id:RUN,status,created_at:iso(NOW-42000),started_at:status==='queued'?null:iso(NOW-42000),run_kind:kind};
  x.state.runs=[listed(RUN,status,trigger,NOW-42000,kind),...x.state.runs.filter(r=>r.id!==RUN)];
}
function finished(x,p=post()){
  x.state.active=null;x.state.runs=x.state.runs.map(r=>r.id===RUN?{...r,status:'succeeded',finished_at:iso(NOW)}:r);x.state.posts=[...x.state.posts,p];
  x.state.events.push(event(x.state.events.length+1,'pip_run_succeeded'));
}

test('▶ Run now: one live post from the start, with what it is doing, then the same post is its report, in place',async()=>{
  const x=setup({state:{runs:[listed(R0,'succeeded','manual',NOW-5*HOUR)]}});
  x.state.posts=[post({run_id:R0,outcome:'clear',total:0,counts:{},findings:[],posted_at:iso(NOW-5*HOUR),finished_at:iso(NOW-5*HOUR)})];
  x.state.onRun=()=>{running(x);return {run:x.state.runs[0]};};
  await openChat(x);
  assert.equal(live(x.d),null,'nothing runs: no live post');
  x.click('#pip-run-now');await x.drain();
  assert.equal(x.requests('run_pip').length,1);
  const card=live(x.d);
  assert.ok(card,'the run is in its chat from the start');
  assert.equal(card.dataset.runPost,RUN,'drawn where the run’s own post will stand');
  assert.equal(items(x.d).at(-1),card,'at the end of the chat');
  assert.ok(card.matches('.pip-message.assistant.run-post'),'a message from the Pip, like its posts');
  assert.equal(card.querySelector('.run-post-face .avatar').dataset.pose,'working','its face, at work');
  assert.equal(text(card.querySelector('.run-post-name')),'Billing audit');
  assert.equal(text(card.querySelector('.run-post-clock')),'0:42','a clock from the run’s start');
  assert.equal(text(card.querySelector('.run-post-doing')),'Getting started');
  assert.equal(text(card.querySelector('.run-post-started')),'Started by you');
  assert.equal(text(card.querySelector('[data-live-stop]')),'Stop');
  // What it does next comes from the run's activity, read every 1.5 s while the chat is on screen.
  x.state.events.push(event(1,'pip_run_started'),event(2,'pip_run_progress',{kind:'tool_call',tool:'read_file',path:'app/billing.py'}));
  await x.advance(1500);
  assert.equal(text(live(x.d).querySelector('.run-post-doing')),'Reading billing.py');
  assert.equal(live(x.d).querySelector('.run-post-doing code').textContent,'billing.py');
  assert.match(live(x.d).getAttribute('aria-label'),/^Billing audit: Reading billing\.py\. Running 0:42\. Started by you$/);
  const after=x.requests('list_pip_run_activity').at(-1).request.after;
  x.state.events.push(event(3,'pip_run_progress',{kind:'progress',state:'waiting',message:'Waiting for the model'}));
  await x.advance(1500);
  assert.equal(text(live(x.d).querySelector('.run-post-doing')),'Waiting for the model');
  assert.equal(x.requests('list_pip_run_activity').at(-1).request.after,2,'each look reads on from the last');
  assert.ok(after<=2);
  // It ends: the same place now holds its report post.
  finished(x);
  await x.advance(1500);
  assert.equal(live(x.d),null,'no live post left');
  const posts=x.d.querySelectorAll(`[data-run-post="${RUN}"]`);
  assert.equal(posts.length,1,'one item for the run, never two');
  assert.equal(items(x.d).at(-1),posts[0],'in the same place, at the end');
  assert.match(text(posts[0].querySelector('.run-post-body')),/2 issues|two issues|issues/);
  assert.ok(posts[0].querySelector('.run-post-head time.msg-time'),'its time where the clock was');
});

test('Stop stops the run; a run you stop posts nothing, and the chat says so',async()=>{
  const x=setup();running(x);await openChat(x);
  x.click(`[data-live-stop="${RUN}"]`);await x.drain();
  assert.deepEqual(x.state.cancelled,[RUN],'cancel_pip_run, as History’s Cancel run');
  assert.equal(text(live(x.d).querySelector('[data-live-stop]')),'Stopping…');
  assert.equal(live(x.d).querySelector('[data-live-stop]').disabled,true);
  assert.equal(text(live(x.d).querySelector('.run-post-doing')),'Stopping…');
  x.state.active=null;x.state.runs=x.state.runs.map(r=>({...r,status:'cancelled'}));x.state.events.push(event(1,'pip_run_cancelled'));
  await x.advance(1500);await x.look();
  assert.equal(live(x.d),null,'gone');
  assert.equal(x.d.querySelectorAll(`[data-run-post="${RUN}"]`).length,0,'and nothing posted');
  assert.match(text(x.d.querySelector('.conversation-log .notice')),/^Stopped\. Billing audit posts nothing for a run you stop\.$/);
});

test('a scheduled run says it started on schedule, at the time it was due, and ends as its post',async()=>{
  const x=setup();
  running(x,{trigger:'schedule'});
  const due=new Date(NOW);due.setHours(9,0,0,0);
  x.state.detail[RUN]={manifest:{run_kind:'audit',trigger:'schedule',scheduled_at:due.toISOString()}};
  await openChat(x);
  assert.equal(text(live(x.d).querySelector('.run-post-started')),`On schedule · ${due.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`);
  finished(x,post({trigger:'schedule',outcome:'clear',total:0,counts:{},findings:[]}));
  await x.look();
  assert.equal(live(x.d),null);
  assert.equal(x.d.querySelectorAll(`[data-run-post="${RUN}"]`).length,1,'its report post in its place');
  assert.equal(items(x.d).at(-1).dataset.runPost,RUN);
});

test('a reload while it runs draws the live post again, from the run itself',async()=>{
  const x=setup();running(x,{trigger:'main_chat'});
  x.state.events.push(event(1,'pip_run_started'),event(2,'pip_run_progress',{kind:'tool_call',tool:'grep',path:''}));
  await openChat(x);
  const card=live(x.d);
  assert.ok(card,'a fresh view, mid-run: there it is');
  assert.equal(text(card.querySelector('.run-post-doing')),'Searching the code','what it is doing, from its saved activity');
  assert.equal(text(card.querySelector('.run-post-clock')),'0:42','its clock from when it started, not from the reload');
  assert.equal(text(card.querySelector('.run-post-started')),'Asked by DGC','a DGC chat ran it (run_pip_now)');
});

test('how it started: first run, waiting to start, and a run of a kind that never posts shows nothing',async()=>{
  const first=setup();running(first,{status:'queued'});await openChat(first);
  assert.equal(text(live(first.d).querySelector('.run-post-started')),'First run','its only run, started on its setup card');
  assert.equal(text(live(first.d).querySelector('.run-post-doing')),'Waiting to start');
  assert.equal(live(first.d).querySelector('.run-post-clock'),null,'no clock before it starts');
  const handoff=setup();running(handoff,{kind:'patch',trigger:'handoff'});await openChat(handoff);
  assert.equal(live(handoff.d),null,'Patch work is reviewed where it was handed off');
});

test('the Work chat’s chip opens the Pip’s chat at the live post',async()=>{
  const x=setup();running(x,{trigger:'schedule'});await x.drain();
  const going=x.controller.navigate({pip:PIP,section:'chat',run:RUN});await x.drain();await going;await x.drain();
  const card=live(x.d);
  assert.ok(card);
  assert.ok(card.classList.contains('run-post-flash'),'shown, as the chat’s other jumps to a post are');
});

// The routine's turn, exactly as dgc/pip_routines.py writes it (ROUTINE_TURN).
const routineSource=readFileSync(new URL('../../../dgc/pip_routines.py',import.meta.url),'utf8');
const ROUTINE_TURN=/ROUTINE_TURN = \(((?:\s*"(?:[^"\\]|\\.)*")+)\)/.exec(routineSource)[1].match(/"(?:[^"\\]|\\.)*"/g).map(s=>JSON.parse(s)).join('');
test('a Personal Pip’s routine runs as a live post, not the working row, and its reply takes its place',async()=>{
  const turn=ROUTINE_TURN.replace('{title}','New orders').replace('{when}','when the shop app sends order.created').replace('{prompt}','Tell me about the order.');
  const hidden={id:'msg_r',pip_id:PIP,workspace_id:'ws',role:'user',text:turn,run_id:CHAT,model:'m',created_at:iso(NOW-30000),status:'succeeded',intro:true};
  const x=setup({personal:true,messages:[hidden],state:{chatActive:{id:CHAT,status:'running',created_at:iso(NOW-30000),started_at:iso(NOW-30000)}}});
  await openChat(x);
  const card=live(x.d);
  assert.ok(card,'the routine’s run is a live post');
  assert.equal(card.dataset.runPost,CHAT);
  assert.equal(text(card.querySelector('.run-post-routine')),'New orders');
  assert.equal(text(card.querySelector('.run-post-started')),'From Shop event');
  assert.equal(text(card.querySelector('.run-post-clock')),'0:30');
  assert.equal(x.d.querySelector('.pip-working'),null,'no working row beside it');
  x.click(`[data-live-stop="${CHAT}"]`);await x.drain();
  assert.deepEqual(x.state.cancelled,[CHAT],'Stop stops the routine’s run');
  x.state.chatActive=null;x.state.messages=[hidden,{...hidden,id:'msg_a',role:'assistant',intro:undefined,text:'One new order: #1042, ₹2,400.',created_at:iso(NOW)}];
  await x.look();
  assert.equal(live(x.d),null);
  const reply=x.d.querySelector('[data-message="msg_a"]');
  assert.ok(reply,'its reply, in its place');
  assert.equal(items(x.d).at(-1),reply);
  assert.equal(text(reply.querySelector('.run-post-routine')),'New orders');
});
