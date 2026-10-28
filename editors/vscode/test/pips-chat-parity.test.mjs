// A Project Pip's chat looks and works like a Personal Pip's (reported 24 Oct): "Why is how chat works for Project
// Pip and for Personal Pip different? It should look and feel the same. The one we have for Personal Pip is better.
// Project Pip should also chat and respond the same way." Before, simpleMode() gave the newer chat to Personal Pips
// only; a Project Pip had typing dots, a "Still writing…" block, one long reply, no time marks and its own box. Now
// both draw the same chat: the Pip at work with its face and name, its reply written into short bubbles as it comes,
// time marks, actions under the pointer, the same box. A Project Pip keeps its page (list, History, Settings) and what
// only it has: its runs with Ask DGC to fix. A remote view keeps the chat it had. Mounted as the side bar mounts it.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';

const src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
const PW='ws_'+hex('e'),W='ws_'+hex('d'),PLANNER='pip_'+hex('c'),AUDIT='pip_'+hex('a');
const RUNS={[PLANNER]:['run_'+hex('1'),'run_'+hex('2'),'run_'+hex('3')],[AUDIT]:['run_'+hex('4'),'run_'+hex('5'),'run_'+hex('6')]};
const POST='run_'+hex('7');
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,workspace,name,type,extra={})=>({id,workspace_id:workspace,pip_type:type,name,goal:'Help.',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const planner=pip(PLANNER,PW,'Planner','lens',{source_policy:{mode:'personal'}});
const audit=pip(AUDIT,W,'Billing audit','rook',{source_policy:{mode:'committed_only'},report_session:'chat-shop'});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const NOW=Date.now(),HOUR=3600000,iso=ms=>new Date(ms).toISOString();
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
// Two exchanges, yesterday and this morning, and a message being answered now: what the Pip is doing, and the first
// two paragraphs of its reply.
function chat(p){
  const [a,b,now]=RUNS[p.id],m=(id,role,run,text,at,status='succeeded')=>({id,pip_id:p.id,workspace_id:p.workspace_id,role,text,run_id:run,model:'m',created_at:iso(at),status});
  return {messages:[m(p.id+'1','user',a,'What do you look at?',NOW-26*HOUR),m(p.id+'2','assistant',a,'I read what you share.\n\nI never change it.',NOW-26*HOUR+14000),
    m(p.id+'3','user',b,'Is it serious?',NOW-3*HOUR),m(p.id+'4','assistant',b,'Yes.\n\nIt costs money.',NOW-3*HOUR+14000),m(p.id+'5','user',now,'Explain it in two paragraphs.',NOW-12000,'running')],
    active:{id:now,status:'running',created_at:iso(NOW-12000),started_at:iso(NOW-12000)},
    events:[{seq:1,run_id:now,pip_id:p.id,workspace_id:p.workspace_id,event_type:'pip_run_progress',payload:{kind:'progress',state:'thinking',message:'Thinking'},created_at:iso(NOW-11000)},
      {seq:2,run_id:now,pip_id:p.id,workspace_id:p.workspace_id,event_type:'pip_run_progress',payload:{kind:'text_delta',text:'The loop overwrites the subtotal.\n\nSo only the last line counts.'},created_at:iso(NOW-9000)}]};
}
const FOUND={run_id:POST,pip_id:AUDIT,name:'Billing audit',pip_type:'rook',kind:'audit',trigger:'you',text:'x',outcome:'findings',posted_at:iso(NOW-2*HOUR),finished_at:iso(NOW-2*HOUR),
  total:1,counts:{high:1},findings:[{title:'apply_discount divides by 10',severity:'high',path:'billing.py',line:20}]};

function setup({api=65,host,online=true,answering=true}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  const sent=[],answered=new Set(),listeners=new Set();
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
  w.eval(client);
  const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
  w.DgcPips.mount({root:shadow,...(host?{host}:{}),postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>undefined,setState(){},onAskDgc:()=>true});
  const message=data=>listeners.forEach(l=>l(data));
  const runner={runner_id:'runner',status:online?'running':'stopped',online,paused:false,counts:{queued:0,running:0,cancelling:0}};
  const byId={[PLANNER]:planner,[AUDIT]:audit},chats={[PLANNER]:chat(planner),[AUDIT]:chat(audit)};
  const reply=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'shop',kind:'git'}],current_workspace_id:W}),
    list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
    list_pips:()=>{const list=r.workspace_id===PW?[planner]:[audit];return {pips:list,total:list.length,next_offset:null};},
    get_pip:()=>({pip:byId[r.pip_id]}),list_pip_runs:()=>({runs:[]}),get_workspace_context:()=>({context:{workspace_id:r.workspace_id,revision:0,entries:[]}}),
    list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
    list_pip_messages:()=>{const c=chats[r.pip_id];return {pip_id:r.pip_id,workspace_id:byId[r.pip_id].workspace_id,messages:answering?c.messages:c.messages.slice(0,4),next_before_id:null,active_run:answering?c.active:null,history_context_omitted_count:0,chat_controls:controls};},
    list_pip_run_activity:()=>{const c=chats[r.pip_id===undefined?(r.run_id===RUNS[PLANNER][2]?PLANNER:AUDIT):r.pip_id];return {run_id:r.run_id,pip_id:c.active.id===RUNS[PLANNER][2]?PLANNER:AUDIT,workspace_id:c.active.id===RUNS[PLANNER][2]?PW:W,events:r.after?[]:c.events,next_cursor:2,has_more:false,history_may_be_truncated:false,retention_limit:500,retention_scope:'workspace'};},
    list_pip_run_posts:()=>({pip_id:r.pip_id,workspace_id:byId[r.pip_id].workspace_id,posts:r.pip_id===AUDIT?[FOUND]:[],next_before_id:null}),
    list_pip_run_fixes:()=>({pip_id:r.pip_id,workspace_id:byId[r.pip_id].workspace_id,fixes:[]}),
    list_pip_reply_stats:()=>({pip_id:r.pip_id,stats:[]}),
    get_pip_chat_context:()=>r.pip_id===PLANNER?{pip_id:PLANNER,context_size:r.context_size,used_tokens:2000,brief_tokens:0,recent_messages:4,summarized_messages:0}:{error:{code:'invalid_request',message:'Context use is shown for Personal Pips.'}},
    list_pip_attention:()=>({as_of:iso(NOW),total:0,counts:{},by_pip:{},items:[],truncated:false}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
    list_pip_approvals:()=>({approvals:[],next_cursor:null}),list_pip_checkpoints:()=>({checkpoints:[],next_cursor:null}),get_pip_digest:()=>undefined}[r.type]?.());
  async function drain(){for(let n=0;n<25;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=reply(m.request);if(result===undefined)continue;answered.add(m.id);if(result.error)message({type:'pipsReply',id:m.id,ok:false,error:result.error});else message({type:'pipsReply',id:m.id,ok:true,result});}}await flush();}
  message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true,folder:true});
  const $=s=>shadow.querySelector(s);
  async function open(scope,id){
    if(!$(`[data-pips-tab="${scope}"]`))$('#simple-back')?.click();
    await drain();$(`[data-pips-tab="${scope}"]`)?.click();await drain();
    $(`[data-job="${id}"]`).click();await drain();
    await new Promise(r=>setTimeout(r,450));await drain();             // the reply's stream is read every 400 ms
  }
  return {w,d:shadow,$,sent,drain,open,requests:t=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===t)};
}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim()||'';
// What a chat draws, by its pieces, with the Pip's name taken out: the same for both kinds means the same chat.
function shape(x,name){
  const c=x.$('.pip-conversation'),log=x.$('.conversation-log'),live=c.querySelector('.provisional');
  const replies=[...log.querySelectorAll('.pip-message.assistant[data-message]')];
  return {chatStyle:c.classList.contains('chat-style'),
    working:text(c.querySelector('.pip-working')).replace(name,'NAME').replace(/\d+/g,'N'),workingFace:!!c.querySelector('.pip-working .avatar'),
    typingDots:!!c.querySelector('.typing-dots'),stillWriting:/Still writing/.test(c.textContent),
    liveParts:live?live.querySelectorAll('.answer.split .reply-part').length:0,
    workingBelowLive:!!live&&!!c.querySelector('.pip-working')&&!!(live.compareDocumentPosition(c.querySelector('.pip-working'))&x.w.Node.DOCUMENT_POSITION_FOLLOWING),
    timeMarks:[...log.querySelectorAll('.chat-time')].length,
    replyParts:replies.map(r=>r.querySelectorAll('.answer.split .reply-part').length),
    actions:replies.map(r=>[...r.querySelectorAll('.response-actions button, .response-actions summary')].map(b=>b.getAttribute('aria-label'))),
    times:[...log.querySelectorAll('[data-message] time.msg-time')].length,
    placeholder:x.$('#chatText').getAttribute('placeholder').replace(name,'NAME'),
    // A Personal Pip's box also adds photos and files, and measures its context: a Project Pip's DGC does neither yet.
    controls:[...x.$('.pip-composer .composer-controls').querySelectorAll('button')].map(b=>b.getAttribute('aria-label').replace(/^Context window:.*/,'Context window')).filter(l=>l!=='Add images and files')};
}

test('a Project Pip’s chat draws the Personal Pip’s pieces: the Pip at work, its reply in bubbles as it comes, time marks, the same box',async()=>{
  const x=setup();await x.drain();
  await x.open('personal',PLANNER);
  const personal=shape(x,'Planner');
  assert.ok(x.$('.pip-app-root').classList.contains('simple-pips'),'a Personal Pip opens in its own page, as before');
  await x.open('project',AUDIT);
  // From 24 Oct a Project Pip has the Personal Pips page too: its top bar, and History, Settings and the rest in its menu.
  assert.ok(x.$('.pip-app-root').classList.contains('simple-pips'),'a Project Pip opens in the same page');
  assert.ok(x.$('.pip-topbar .pip-menu [data-tab=runs]'),'History is still there, in its menu');
  const project=shape(x,'Billing audit');
  assert.deepEqual(project,personal,'the same chat');
  // And what that chat is, spelled out.
  assert.equal(project.chatStyle,true);
  assert.equal(project.working,'NAME · Thinking(Ns · ↓ N tok)','the working row: who, what, its clock and tokens');
  assert.equal(project.workingFace,true,'with the Pip’s face');
  assert.equal(project.typingDots,false,'no typing dots');
  assert.equal(project.stillWriting,false,'no “Still writing…” block');
  assert.equal(project.liveParts,2,'the reply written into short bubbles as it comes');
  assert.equal(project.workingBelowLive,true,'the Pip at work under what it has written so far');
  assert.equal(project.timeMarks,3,'a time mark wherever half an hour passed: yesterday, this morning, now');
  assert.deepEqual(project.replyParts,[2,2],'a finished reply is short bubbles, one a paragraph');
  assert.equal(project.placeholder,'Ask NAME');
  assert.ok(x.$('.pip-conversation.chat-style .composer-hint'),'the source line is kept for a screen reader, hidden as the Personal box hides it');
});

test('what only a Project Pip has sits in the same chat: its run with Ask DGC to fix',async()=>{
  const x=setup();await x.drain();await x.open('project',AUDIT);
  const post=x.$(`.chat-style .conversation-log [data-run-post="${POST}"]`);
  assert.ok(post,'the run is a message in the same chat');
  assert.ok(post.querySelector('.run-post-head .avatar'),'from the Pip, with its face');
  assert.equal(text(post.querySelector(`[data-post-fix="${POST}"]`)),'Ask DGC to fix');
  x.$('#chat-permissions').click();await x.drain();
  assert.match(text(x.d.querySelector('[role=dialog], .review, #review-root')),/reads the committed code of this project, and only reads/,'which code it reads is one click away');
});

test('a Project Pip’s box says when Pips aren’t running, as a Personal Pip’s does; the context meter is only its own',async()=>{
  const x=setup({online:false,answering:false});await x.drain();
  await x.open('personal',PLANNER);
  assert.match(text(x.$('.runner-off')),/Planner can't answer yet/);
  await x.open('project',AUDIT);
  assert.match(text(x.$('.runner-off')),/Billing audit can't answer yet/);
  assert.equal(x.$('.composer-ctx-pct'),null,'not the Personal Pip’s context meter (it has none of its own yet)');
  assert.ok(x.requests('list_pip_reply_stats').some(m=>m.request.pip_id===AUDIT),'what each reply took, as under a Personal Pip’s');
});

test('a remote view keeps the chat it had, and so does a DGC from before simple Pips',async()=>{
  for(const options of [{host:'remote'},{api:42}]){
    const x=setup(options);await x.drain();
    if(options.host){x.$(`[data-job="${AUDIT}"]`).click();await x.drain();await new Promise(r=>setTimeout(r,450));await x.drain();}
    else await x.open('project',AUDIT);
    const c=x.$('.pip-conversation');
    assert.equal(c.classList.contains('chat-style'),false,JSON.stringify(options));
    assert.equal(c.querySelector('.pip-working'),null,JSON.stringify(options));
    assert.match(text(c.querySelector('.provisional')),/Still writing…/,JSON.stringify(options));
    assert.match(x.$('#chatText').getAttribute('placeholder'),/^Message Rook…$/,JSON.stringify(options));
  }
});
