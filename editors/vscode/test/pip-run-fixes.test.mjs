// A Pip's own chat says what Ask DGC to fix did for each run (Pips API 65). Reported 24 Oct: "when in chat we do
// Ask DGC to fix for a Pip card, and it gets fixed, the Pips page, for that Pip under chat, its card still gives an
// option 'Ask DGC to fix'. Should its status also get updated as fixed?" Yes. The fix runs in a Work chat and keeps its
// record (dgc/pip_fix.py); the run's post reads it with list_pip_run_fixes and says fixing, Fixed, failed or undone, as
// the Work chat's card does, and a click goes to that card, where Review and Undo are. The state comes from DGC, not
// from the view: a reload draws the same.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {makeDom,markdownJs} from './support/webview-dom.mjs';
const require=createRequire(import.meta.url);
const src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const viewCode=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const view={exports:{}};new Function('module','exports','require',viewCode)(view,view.exports,name=>name==='vscode'?{}:require(name));
const posts=await import(new URL('../src/pipRunPosts.js',import.meta.url).href);
const windows=[];after(()=>windows.forEach(w=>w.close()));

const PIP='pip_'+'a'.repeat(32),R1='run_'+'1'.repeat(32),R2='run_'+'2'.repeat(32),F1='fix_'+'c'.repeat(32),F2='fix_'+'d'.repeat(32);
const NOW=(()=>{const d=new Date();d.setHours(12,0,0,0);return d.getTime();})(),HOUR=3600000;
const iso=ms=>new Date(ms).toISOString();
const ws={id:'ws',name:'shop'};
const pip=(extra={})=>({id:PIP,workspace_id:'ws',pip_type:'rook',name:'Billing audit',goal:'Look for bugs.',source_policy:{mode:'committed_only'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',proposals:[],report_chats:1,report_session:'chat-shop',latest_run:{id:R1,status:'succeeded'},...extra});
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>{const available=['scout','lens','rook','lock'].includes(id),name=id[0].toUpperCase()+id.slice(1);return{id,name,character_index,role:'Code review',description:'Inspect committed source.',available,unavailable_reason:available?null:'Not yet.',default_name:name,default_goal:'Inspect source',engine:available?'source_audit':null};});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const FOUND={pip_id:PIP,name:'Billing audit',pip_type:'rook',kind:'audit',trigger:'you',text:'x',run_id:R1,outcome:'findings',posted_at:iso(NOW-HOUR),finished_at:iso(NOW-HOUR),total:2,counts:{high:2},findings:[
  {title:'invoice_total overwrites the subtotal on every line',severity:'high',path:'billing.py',line:12},
  {title:'apply_discount divides by 10 instead of 100',severity:'high',path:'billing.py',line:20}]};
const CLEAR={...FOUND,run_id:R2,outcome:'clear',total:0,counts:{},findings:[],posted_at:iso(NOW-2*HOUR)};
const fix=(extra={})=>({fix_id:F1,run_id:R1,state:'running',created_at:(NOW+3*HOUR)/1000+1,started_at:(NOW+3*HOUR)/1000+2,session_id:'chat-shop',...extra});
const files=n=>Array.from({length:n},(_,i)=>({path:`billing${i}.py`,kind:'edited',additions:2,deletions:1,counted:true}));
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({apiVersion=65,fixes=[],state,onOpenFix=true}={}){
  const dom=new JSDOM(view.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  w.Date.now=()=>NOW+3*HOUR;
  const sent=[],answered=new Set(),asks=[],opens=[];let persisted=state;
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.eval(markdownJs+'\nglobalThis.DgcMarkdown=DgcMarkdown;');w.eval(client);
  w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),getState:()=>persisted,setState:v=>{persisted=v;},
    onMessage:listener=>{const handle=e=>listener(e.data);w.addEventListener('message',handle);return()=>w.removeEventListener('message',handle);},
    onAskDgc:ask=>{asks.push(JSON.parse(JSON.stringify(ask)));return true;},
    ...(onOpenFix?{onOpenFix:open=>{opens.push(JSON.parse(JSON.stringify(open)));return true;}}:{})});
  const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
  const held={fixes};
  const defaults=r=>({list_workspaces:()=>({workspaces:[ws],current_workspace_id:'ws'}),list_pip_types:()=>({types}),list_pips:()=>({pips:[pip()]}),
    get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),get_pip:()=>({pip:pip()}),
    list_pip_runs:()=>({runs:[]}),
    list_pip_messages:()=>({pip_id:PIP,workspace_id:'ws',messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:PIP,workspace_id:'ws',posts:[CLEAR,FOUND],next_before_id:null}),
    list_pip_run_fixes:()=>({pip_id:PIP,workspace_id:'ws',fixes:held.fixes}),
    list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]})}[r.type]?.());
  const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
  async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answered.add(m.id);send({type:'pipsReply',id:m.id,ok:true,result});}}}}
  // The Work chat moved the fix on: the page's next look (it polls while the chat is on screen; here, it comes back
  // into view) reads it from DGC.
  async function later(next){held.fixes=next;send({type:'pipsVisibility',visible:true});await drain();}
  send({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
  const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
  return {w,d:w.document,sent,asks,opens,requests,drain,click,later,persisted:()=>persisted};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim();
const chips=x=>[...x.d.querySelector(`[data-run-post="${R1}"] .run-post-attach`).children].map(e=>e.matches('details')?text(e.querySelector('summary')):text(e));
const fixChip=x=>x.d.querySelector(`[data-run-post="${R1}"] .run-post-fix`);

test('the post follows the fix: Ask DGC to fix, then DGC is fixing this, then Fixed · 3 files, opening the Work chat',async()=>{
  const x=setup();await openChat(x);
  assert.deepEqual(x.requests('list_pip_run_fixes').map(m=>JSON.parse(JSON.stringify(m.request))).at(-1),{type:'list_pip_run_fixes',pip_id:PIP});
  assert.deepEqual(chips(x),['Report · 2 findings','Ask DGC to fix']);
  assert.equal(fixChip(x).dataset.state,'ask');
  x.click(`[data-post-fix="${R1}"]`);
  assert.equal(x.asks.length,1);assert.equal(x.asks[0].session,'chat-shop');
  assert.equal(text(fixChip(x)),'Asking DGC…');assert.equal(fixChip(x).disabled,true,'never asked twice');
  assert.ok(!(x.persisted()?.asked||[]).includes(R1),'nothing kept with the view: what DGC says is what the post says');
  await x.later([fix({state:'queued'})]);
  assert.equal(fixChip(x).dataset.state,'fixing');
  assert.deepEqual(chips(x),['Report · 2 findings','DGC is fixing this']);
  assert.equal(x.d.querySelector(`[data-post-fix="${R1}"]`),null,'no second Ask while it fixes');
  await x.later([fix({state:'applied',ended_at:NOW/1000+200,files:files(3),undo:{state:'available'},tests:{state:'passed'}})]);
  assert.equal(fixChip(x).dataset.state,'fixed');
  assert.deepEqual(chips(x),['Report · 2 findings','Fixed · 3 files']);
  assert.match(fixChip(x).title,/review or undo it/);
  x.click(`[data-post-fix-open="${R1}"]`);
  assert.deepEqual(x.opens,[{session:'chat-shop',run_id:R1}],'to the chat it ran in, where Undo is');
  await x.later([fix({state:'undone',files:files(3),undo:{state:'done',restored:['billing0.py'],kept:[]}})]);
  assert.deepEqual(chips(x),['Report · 2 findings','Ask DGC to fix'],'undone: back to Ask DGC to fix');
  assert.equal(fixChip(x).disabled,false);
});

test('a fix that didn’t finish says so and offers Ask DGC to fix again; held back and nothing to change say so too',async()=>{
  const x=setup({fixes:[fix({state:'failed',created_at:(NOW+2*HOUR)/1000,ended_at:(NOW+2*HOUR)/1000+90,message:'The fix didn’t finish: the model stopped. Nothing in your project was changed.'})]});
  await openChat(x);
  assert.deepEqual(chips(x),['Report · 2 findings','The fix didn’t finish','Ask DGC to fix again']);
  assert.equal(fixChip(x).dataset.state,'failed');
  assert.match(fixChip(x).title,/the model stopped/);
  x.click(`[data-post-fix="${R1}"]`);
  assert.equal(x.asks.length,1);
  assert.equal(text(x.d.querySelector(`[data-post-fix="${R1}"]`)),'Asking DGC…');
  await x.later([fix({fix_id:F2,state:'running',created_at:(NOW+3*HOUR)/1000})]);
  assert.deepEqual(chips(x),['Report · 2 findings','DGC is fixing this'],'the new fix, not the failed one');
  await x.later([fix({fix_id:F2,state:'partial',files:files(2),held:[{path:'billing.py',n:0,why:'you changed the same lines while it worked'}]})]);
  assert.deepEqual(chips(x),['Report · 2 findings','Fixed 2 files · 1 held back']);
  await x.later([fix({fix_id:F2,state:'unchanged'})]);
  assert.deepEqual(chips(x),['Report · 2 findings','Nothing to change']);
  for(const [state,said] of [['stopped','The fix was stopped'],['interrupted','The fix was interrupted'],['not_applied','The fix wasn’t applied']]){
    await x.later([fix({fix_id:F2,state})]);
    assert.deepEqual(chips(x),['Report · 2 findings',said,'Ask DGC to fix again'],state);
  }
});

test('a reloaded page draws Fixed from DGC alone; a page with no way to the Work chat says it without a link',async()=>{
  const done=fix({state:'applied',files:files(1),undo:{state:'available'}});
  const x=setup({fixes:[done],state:undefined});await openChat(x);
  assert.deepEqual(chips(x),['Report · 2 findings','Fixed · 1 file']);
  const plain=setup({fixes:[done],onOpenFix:false});await openChat(plain);
  assert.equal(fixChip(plain).tagName,'SPAN','said, not a button that goes nowhere');
  assert.equal(text(fixChip(plain)),'Fixed · 1 file');
  assert.equal(plain.d.querySelector(`[data-post-fix-open="${R1}"]`),null);
});

test('only runs with something to fix are asked about, and a fix this editor can’t read is left out',async()=>{
  const fixes=posts.runFixesPage({pip_id:PIP,workspace_id:'ws',fixes:[fix(),fix({run_id:R2,state:'applied'}),{...fix(),fix_id:'nope'},{...fix(),run_id:R2,state:'exploded'},fix({run_id:R1,state:'failed'})]},PIP,'ws');
  assert.deepEqual([...fixes.keys()],[R1,R2]);
  assert.equal(fixes.get(R1).state,'running','the first per run is the newest');
  assert.throws(()=>posts.runFixesPage({pip_id:'pip_other',workspace_id:'ws',fixes:[]},PIP,'ws'));
  assert.deepEqual(posts.fixWords(fix({state:'applied',files:files(3)})),{state:'fixed',text:'Fixed · 3 files',title:'DGC fixed this. Open the Work chat it ran in to review or undo it.'});
  const x=setup();await openChat(x);
  assert.equal(x.d.querySelector(`[data-run-post="${R2}"] .run-post-fix`),null,'an all-clear run has nothing to fix');
});

test('before Pips API 65 nothing is asked: Asked DGC, kept with the view, as before',async()=>{
  const x=setup({apiVersion:64});await openChat(x);
  assert.equal(x.requests('list_pip_run_fixes').length,0);
  x.click(`[data-post-fix="${R1}"]`);
  assert.equal(text(fixChip(x)),'Asked DGC');assert.equal(fixChip(x).disabled,true);
  assert.ok(x.persisted().asked.includes(R1));
});

test('the host refuses list_pip_run_fixes from a CLI older than API 65',()=>{
  for(const api of [64,65]){const sent=[],posted=[];const editor=new view.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
    editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
    editor.receive({type:'pipsRequest',id:'p',request:{type:'list_pip_run_fixes',pip_id:PIP}});
    assert.equal(sent.length,api===65?1:0);if(api===64)assert.match(posted.at(-1).error.message,/what it fixed/);}
});

// The Work chat a post's Fixed opens shows the fix's card, once its transcript and cards are in.
test('a Work chat opened from a post shows the fix’s card',()=>{
  const s=makeDom();
  const event=e=>s.send({type:'event',event:e});
  event({type:'ready',capabilities:{pip_reports:1,pip_fix:1},model:'m',mode:'default',think:'off',session_id:'chat-shop'});
  s.send({type:'session_ready',sessionId:'chat-shop'});
  s.send({type:'pipShowFix',run_id:R1});
  event({type:'pip_report',report:{...FOUND,earlier:0,fix:{...fix({state:'applied',files:files(1),undo:{state:'available'}}),pip_id:PIP,name:'Billing audit',pip_type:'rook'}}});
  return new Promise(resolve=>setTimeout(()=>{
    const card=s.doc.querySelector(`#log .pip-report[data-run="${R1}"]`);
    assert.ok(card,'the card');
    assert.ok(card.classList.contains('prompt-flash'),'shown');
    assert.deepEqual(s.errors,[]);
    resolve();
  },500));
});
