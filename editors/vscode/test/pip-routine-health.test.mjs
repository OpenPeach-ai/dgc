// Routines recover and tell you (Pips package 2). (Harness from pip-reply-status.)
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
const action=(server='airtable',status='pending')=>({id:ACTION,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status,digest:'d'.repeat(64),expires_at:'2099-10-05T06:00:00Z',payload:{schema_version:3,kind:'connector_call',source,server,connection_digest:'a'.repeat(64),account:'connection_managed',schema_digest:'b'.repeat(64),call},receipt:null});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));

function setup({plugins=[],drafts=[],apiVersion=44,messages=[],activeRun=null,activity=[],stats=[],page={},row={}}={}){
 const pip={...pipRow,...row};
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
  list_pips:()=>({pips:[pip]}),get_pip:()=>({pip}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages,next_before_id:null,active_run:activeRun,history_context_omitted_count:0,chat_controls:controls,...page}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins,installed}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:drafts.map(summary),next_cursor:null}),get_pip_connector_draft:()=>({draft:drafts.find(d=>d.id===r.draft_id)}),
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_run_activity:()=>({run_id:RUN,pip_id:PIP,workspace_id:PW,events:r.after?[]:activity,next_cursor:r.after||activity.length,has_more:false,history_may_be_truncated:false,retention_limit:500,retention_scope:'workspace'}),list_pip_reply_stats:()=>({pip_id:PIP,stats}),get_pip_chat_context:()=>({pip_id:PIP,context_size:r.context_size,used_tokens:10,brief_tokens:0,recent_messages:0,summarized_messages:0}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,setPlugins:v=>{plugins=v;},setDrafts:v=>{drafts=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const clean=v=>JSON.parse(JSON.stringify(v));



// Routines recover and tell you (Pips package 2): its failed runs keep their line, a routine with nothing to say is one
// faint line, one that never ran is a note by time, the same line again folds into a count, and its row and page say
// how its routines are going.
const turn=(id,run,title,at,status='succeeded',error)=>({id,pip_id:PIP,workspace_id:PW,role:'user',intro:true,run_id:run,status,model:'m',created_at:at,
 text:`This message is from DGC, not the user. Your routine "${title}" is due (every day at 08:00). Do it now: brief me`,...(error?{error}:{})});
const reply=(id,run,text,at,extra={})=>({id,pip_id:PIP,workspace_id:PW,role:'assistant',run_id:run,status:'succeeded',model:'m',created_at:at,text,...extra});
const mine=(id,run,text,at)=>({id,pip_id:PIP,workspace_id:PW,role:'user',run_id:run,status:'succeeded',model:'m',created_at:at,text});
const R=n=>'run_'+String(n).repeat(32).slice(0,32);
const lines=d=>[...d.querySelectorAll('[data-routine-line]')].map(n=>n.dataset.routineLine+': '+n.textContent.replace(/\s+/g,' ').trim());

test('a routine’s failed run keeps its line after you have chatted since, and the same failure folds into one line',async()=>{
 const down='HTTP 503 from https://api.example/v1: Service Unavailable';
 const x=setup({messages:[
  turn('u1',R(1),'Morning brief','2026-11-06T02:30:00.000Z','failed',down),
  turn('u2',R(2),'Morning brief','2026-11-07T02:30:00.000Z','failed',down),
  mine('u3',R(3),'Hi there','2026-11-07T05:00:00.000Z'),reply('a3',R(3),'Hello!','2026-11-07T05:00:05.000Z'),
 ]});await openChat(x);
 const shown=lines(x.d);
 assert.equal(shown.length,1,shown.join('\n'));
 assert.match(shown[0],/^failed: Morning brief · Failed · .* · 2 times since /,'one line, with its count, still there after a chat');
 assert.doesNotMatch(shown[0],/Try again/,'a routine had its second go already: no "Try again" on its line');
 assert.ok(x.d.querySelector('[data-message="a3"]'),'the chat after it as usual');
});

test('a routine that stays quiet is one faint line, folded the same way',async()=>{
 const x=setup({messages:[
  turn('u1',R(1),'Inbox check','2026-11-07T02:30:00.000Z'),reply('a1',R(1),'NOTHING_NEW','2026-11-07T02:30:09.000Z',{quiet:true}),
  turn('u2',R(2),'Inbox check','2026-11-07T03:00:00.000Z'),reply('a2',R(2),'NOTHING_NEW','2026-11-07T03:00:07.000Z',{quiet:true}),
  turn('u4',R(4),'Inbox check','2026-11-07T03:30:00.000Z'),reply('a4',R(4),'Your bank wrote: a card payment of ₹2,400.','2026-11-07T03:30:07.000Z'),
 ]});await openChat(x);
 assert.deepEqual(lines(x.d).map(l=>l.replace(/since .*/,'since …')),['quiet: Inbox check · nothing new · 2 checks since …']);
 assert.equal(x.d.querySelector('[data-message="a1"] .message-body'),null,'no bubble for NOTHING_NEW');
 assert.match(x.d.querySelector('[data-message="a4"]').textContent,/card payment/,'a reply with something to say is a message');
});

test('a routine that never ran is a line where it fell, by time',async()=>{
 const x=setup({messages:[mine('u1',R(1),'Hi','2026-11-06T05:00:00.000Z'),reply('a1',R(1),'Hello!','2026-11-06T05:00:05.000Z'),
   mine('u2',R(2),'Thanks','2026-11-08T05:00:00.000Z'),reply('a2',R(2),'Any time.','2026-11-08T05:00:05.000Z')],
  page:{routine_notes:[
   {id:'note_1',kind:'missed',routine_id:'routine_x',title:'Morning brief',due:'2026-11-07T02:30:00.000Z',at:'2026-11-07T15:00:00.000Z',text:'Missed 8:00; the computer was off',count:1},
   {id:'note_2',kind:'blocked',routine_id:'routine_y',title:'Bills',due:'2026-11-08T02:30:00.000Z',at:'2026-11-08T06:00:00.000Z',text:"Couldn't start: Claude Code isn't signed in on this computer.",count:2},
  ]}});await openChat(x);
 const log=x.d.querySelector('.conversation-log');
 const order=[...log.querySelectorAll('[data-message],[data-note]')].map(n=>n.dataset.message||n.dataset.note);
 assert.deepEqual(order.filter(id=>['a1','note_1','a2','note_2'].includes(id)),['a1','note_1','a2','note_2']);
 assert.match(x.d.querySelector('[data-note="note_1"]').textContent,/^Morning brief · Missed .*; the computer was off$/);
 assert.match(x.d.querySelector('[data-note="note_2"]').textContent,/Bills · Couldn't start: Claude Code isn't signed in on this computer\. · 2 times, last /);
 assert.equal(x.d.querySelector('[data-note="note_2"]').getAttribute('role'),'alert');
});

test('its row and its page say how its routines are going; Fix signs its CLI in',async()=>{
 const next=new Date(Date.now()+86400000).toISOString(),last=new Date(Date.now()-3600000).toISOString();
 const ok=setup({row:{routine_health:{last:{at:last,outcome:'worked'},next_at:next,blocked:null}}});await ok.drain();
 const row=ok.d.querySelector(`[data-job="${PIP}"] .job-health`);assert.ok(row,'the line on its row');
 assert.match(row.textContent,/^Last ran .* · worked · next .* tomorrow$/);
 assert.equal(row.dataset.health,'ok');
 const off=setup({row:{routine_health:{last:{at:last,outcome:'failed'},next_at:next,
  blocked:{cause:'signed_out',text:'Claude Code signed out',fix:{kind:'sign_in',engine:'claude',name:'Claude Code',command:'claude'}}}}});
 await off.drain();
 assert.equal(off.d.querySelector(`[data-job="${PIP}"] .job-health`).textContent,"Can't run: Claude Code signed out");
 await openChat(off);off.click('[data-tab="job"]');await off.drain();
 const line=off.d.querySelector('.pip-page .pip-health');assert.ok(line,'the line on its page');
 assert.equal(line.dataset.health,'blocked');
 assert.match(line.textContent,/^Can't run: Claude Code signed outFixFix opens a terminal to sign Claude Code in on the computer running DGC\.$/);
 off.click('[data-health-sign-in="claude"]');
 assert.deepEqual(clean(off.sent.filter(m=>m.type==='pipsSignIn')),[{type:'pipsSignIn',engine:'claude'}]);
 const both=setup({row:{pending_review_count:1,routine_health:{last:null,next_at:next,blocked:{cause:'signed_out',text:'Claude Code signed out',fix:{kind:'sign_in',engine:'claude'}}}}});
 await both.drain();
 assert.match(both.d.querySelector(`[data-job="${PIP}"] small`).textContent,/^Can't run: Claude Code signed out · 1 waiting for you$/,'it can\'t run: said first, with what waits');
 const plain=setup();await plain.drain();
 assert.equal(plain.d.querySelector('.job-health'),null,'a Pip with no routines: no line');
});
