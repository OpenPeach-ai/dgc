// A Pip's runs in its own chat (Pips API 51). The founder (19 Oct) picked "Yes, post in its chat": each finished
// run is a short message from the Pip in its conversation, as Grok Bots and OpenAI Dots post a scheduled run, and the
// Runs tab became History. Findings: "Today's audit found 5 things, 2 of them high", the top three, Open full report
// and Ask DGC to fix. A failure in plain words. A clean run as one quiet line. Replay draws the same.
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

const PIP='pip_'+'a'.repeat(32),R1='run_'+'1'.repeat(32),R2='run_'+'2'.repeat(32),R3='run_'+'3'.repeat(32),CHAT='run_'+'9'.repeat(32);
const ws={id:'ws',name:'toni-erp'};
const iso=ms=>new Date(ms).toISOString();
// Noon today, so the posts 1 to 5 hours "ago" stay on today's date at any hour the suite runs: from
// Date.now() they fell on yesterday between midnight and 5 AM and read "Yesterday's audit".
const NOW=(()=>{const d=new Date();d.setHours(12,0,0,0);return d.getTime();})(),HOUR=3600000;
const pip=(extra={})=>({id:PIP,workspace_id:'ws',pip_type:'rook',name:'ERP daily audit',goal:'Look for bugs that lose data.',source_policy:{mode:'committed_only'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',proposals:[],report_chats:1,report_session:'chat-erp',latest_run:{id:R1,status:'succeeded'},...extra});
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>{const available=['scout','lens','rook','lock'].includes(id),name=id[0].toUpperCase()+id.slice(1);return{id,name,character_index,role:{core:'Main chat',scout:'Repository exploration',lens:'Repository research',patch:'Code changes',rook:'Code review',pulse:'Test execution',lock:'Security review',quill:'Documentation writing'}[id],description:available?'Inspect committed source with a focused read-only preset.':'This role is planned.',available,unavailable_reason:available?null:'This engine is not available yet.',default_name:name+' job',default_goal:available?'Inspect source for '+id+' findings.':'',engine:available?'source_audit':null};});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const base={pip_id:PIP,name:'ERP daily audit',pip_type:'rook',kind:'audit',trigger:'schedule',text:'x'};
const FOUND={...base,run_id:R1,outcome:'findings',posted_at:iso(NOW-HOUR),finished_at:iso(NOW-HOUR),total:5,counts:{critical:0,high:2,medium:2,low:1},findings:[
  {title:'E-way bill number is never written back to Tally',severity:'high',path:'erp/tally/push.py',line:214},
  {title:'GST total skips cess on mixed-rate invoices',severity:'high',path:'erp/gst/totals.py',line:88},
  {title:'Rounding drops paise on credit notes',severity:'medium',path:'erp/billing/notes.py',line:41}]};
const FAILED={...base,run_id:R2,outcome:'failed',posted_at:iso(NOW-3*HOUR),finished_at:iso(NOW-3*HOUR),reason:'A finding quoted code that does not match the file, so Pips refused the report.',detail:'Finding 2 quotes lines that are not in erp/tally/push.py.',next_run_at:iso(NOW+HOUR)};
const CLEAR={...base,run_id:R3,outcome:'clear',posted_at:iso(NOW-5*HOUR),finished_at:iso(NOW-5*HOUR),total:0,counts:{},findings:[]};
const run=(id,at,status='succeeded')=>({id,pip_id:PIP,status,created_at:at,manifest:{run_kind:'audit',job_version:1,source_revision:'a'.repeat(40),trigger:'schedule'},result:null});
const message=(id,role,text,at)=>({id,pip_id:PIP,workspace_id:'ws',role,text,run_id:CHAT,model:'m',created_at:at,status:'succeeded'});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({apiVersion=51,postsValue=[FOUND,FAILED,CLEAR],messages=[],state,pipValue=pip(),workspace=ws}={}){
  const dom=new JSDOM(view.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  const sent=[],answered=new Set(),asks=[];let persisted=state;
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.eval(markdownJs+'\nglobalThis.DgcMarkdown=DgcMarkdown;');w.eval(client);
  const controller=w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),getState:()=>persisted,setState:v=>{persisted=v;},
    onMessage:listener=>{const handle=e=>listener(e.data);w.addEventListener('message',handle);return()=>w.removeEventListener('message',handle);},
    onAskDgc:ask=>{asks.push(JSON.parse(JSON.stringify(ask)));return true;}});
  const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
  const runs=[run(R1,FOUND.posted_at),run(R2,FAILED.posted_at,'failed'),run(R3,CLEAR.posted_at)];
  const defaults=r=>({list_workspaces:()=>({workspaces:[workspace],current_workspace_id:'ws'}),list_pip_types:()=>({types}),list_pips:()=>({pips:[pipValue]}),
    get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),get_pip:()=>({pip:pipValue}),
    list_pip_runs:()=>({runs}),get_pip_run:()=>({run:{...runs.find(x=>x.id===r.run_id),result:{summary:'Two high findings.',findings:[],limitations:[]}}}),
    list_pip_messages:()=>({pip_id:PIP,workspace_id:'ws',messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:PIP,workspace_id:'ws',posts:postsValue,next_before_id:null}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
    list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]})}[r.type]?.());
  const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
  async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answered.add(m.id);send({type:'pipsReply',id:m.id,ok:true,result});}}}}
  send({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
  const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
  return {w,d:w.document,controller,sent,asks,requests,drain,click,persisted:()=>persisted};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim();

test('a run with findings is a message from the Pip: its face and name, what it found, the top three, two buttons',async()=>{
  const x=setup();await openChat(x);
  const post=x.d.querySelector(`article.run-post[data-run-post="${R1}"]`);
  assert.ok(post,'the run is in the chat');
  assert.ok(post.closest('.conversation-log'),'inside the conversation, not above it');
  assert.ok(post.querySelector('.run-post-face .avatar'),'the Pip’s face');
  assert.equal(text(post.querySelector('.run-post-name')),'ERP daily audit');
  assert.equal(text(post.querySelector('.run-post-what')),'Audit · on its schedule');
  assert.equal(text(post.querySelector('.run-post-body p')),'Today’s audit found 5 things, 2 of them high.');
  assert.deepEqual([...post.querySelectorAll('.run-post-findings li')].map(li=>[...li.children].map(text).join(' ')),[
    'high E-way bill number is never written back to Tally erp/tally/push.py:214',
    'high GST total skips cess on mixed-rate invoices erp/gst/totals.py:88',
    'medium Rounding drops paise on credit notes erp/billing/notes.py:41']);
  assert.equal(text(post.querySelector('.run-post-more')),'2 more in the full report');
  assert.deepEqual([...post.querySelectorAll('.run-post-actions button')].map(text),['Open full report','Ask DGC to fix']);
  assert.match(post.getAttribute('aria-label'),/ERP daily audit: Today’s audit: 5 findings/);
});

test('a failed run says what stopped it in plain words, that nothing changed, and when it runs next',async()=>{
  const x=setup();await openChat(x);
  const post=x.d.querySelector(`article.run-post[data-run-post="${R2}"]`);
  assert.equal(text(post.querySelector('.run-post-what')),'Audit · didn’t finish');
  const [said,next]=[...post.querySelectorAll('.run-post-body p')].map(text);
  assert.equal(said,'Today’s audit didn’t finish. A finding quoted code that does not match the file, so Pips refused the report. Nothing in your project was changed.');
  assert.match(next,/^I’ll run again (today|tomorrow) at /);
  assert.deepEqual([...post.querySelectorAll('.run-post-actions button')].map(text),['See what happened','Run again now','Ask DGC to fix']);
  assert.doesNotMatch(post.textContent,/erp\/tally\/push\.py/,'the saved error detail is in the report, not the chat');
});

test('a clean run is one quiet line between messages, not a message',async()=>{
  const x=setup();await openChat(x);
  const line=x.d.querySelector(`[data-run-post="${R3}"]`);
  assert.equal(line.tagName,'DIV');assert.ok(line.classList.contains('run-post-quiet'));
  assert.equal(line.querySelector('article'),null);
  assert.match(text(line),/^✓.+ · Audit: nothing found\s*Open$/);
  assert.ok(line.querySelector(`[data-post-open="${R3}"]`),'Open goes to its report');
});

test('posts sit among the messages in time order, and a reload draws exactly the same',async()=>{
  const messages=[message('msg_1','user','Also watch the e-way bill write-back.',iso(NOW-4*HOUR)),message('msg_2','assistant','Got it.',iso(NOW-4*HOUR+60000)),
    message('msg_3','user','Is the e-way one the same failure as last week?',iso(NOW-30*60000))];
  const order=d=>[...d.querySelectorAll('.conversation-log [data-run-post], .conversation-log [data-message]')].map(e=>e.dataset.runPost||e.dataset.message);
  const x=setup({messages});await openChat(x);
  assert.deepEqual(order(x.d),[R3,'msg_1','msg_2',R2,R1,'msg_3']);
  const y=setup({messages});await openChat(y);
  const log=d=>[...d.querySelectorAll('.conversation-log [data-run-post]')].map(e=>e.outerHTML.replace(/editor-pip-\d+/g,'pip'));
  assert.deepEqual(log(y.d),log(x.d),'replay draws the same posts');
  assert.equal(x.requests('send_pip_message').length,0,'a post never starts a turn');
});

test('Open full report opens the run under History; Ask DGC to fix asks once, in the chat the Pip reports to',async()=>{
  const x=setup();await openChat(x);
  x.click(`[data-post-fix="${R1}"]`);
  assert.equal(x.asks.length,1);
  assert.equal(x.asks[0].session,'chat-erp');
  assert.equal(x.asks[0].report.run_id,R1);assert.equal(x.asks[0].report.outcome,'findings');
  const fix=x.d.querySelector(`[data-post-fix="${R1}"]`);
  assert.equal(text(fix),'Asked DGC');assert.equal(fix.disabled,true);
  fix.disabled=false;fix.click();assert.equal(x.asks.length,1,'never twice');
  assert.ok(x.persisted().asked.includes(R1),'kept with the view, so a reload says Asked DGC too');
  x.click(`[data-post-open="${R1}"]`);await x.drain();
  assert.equal(x.d.querySelector('[data-tab=runs][aria-pressed=true]')?.textContent,'History');
  assert.equal(x.requests('get_pip_run').at(-1).request.run_id,R1);
  assert.ok(x.d.querySelector(`[data-run="${R1}"][aria-current=true]`),'that run is the one open');
});

test('History says what each run found, and the status under its name goes to the post',async()=>{
  const x=setup();await openChat(x);
  const status=x.d.querySelector('.hero button.last-run');
  assert.equal(text(status),'Today’s audit: 5 findings');
  x.click('[data-tab=runs]');await x.drain();
  assert.equal(x.d.querySelector('.section h2').textContent,'History');
  assert.doesNotMatch(x.d.body.textContent,/Chat replies stay in Chat/);
  assert.deepEqual([...x.d.querySelectorAll('.run-row .hist-row-out')].map(text),
    ['5 findings · 2 high','Didn’t finish · a finding quoted code that does not match the file, so Pips refused the report','Nothing found']);
  x.d.querySelector('.hero button.last-run').click();await x.drain();
  assert.equal(x.d.querySelector('[data-tab=chat][aria-pressed=true]')?.textContent,'Chat');
  const post=x.d.querySelector(`[data-run-post="${R1}"]`);
  assert.equal(x.d.activeElement,post,'the post it found is where focus lands');
});

test('older unanswered runs fold into one line; the newest of the stretch stays',async()=>{
  const old=[2,3,4,5].map(d=>({...CLEAR,run_id:'run_'+String(d).repeat(32).slice(0,32),posted_at:iso(NOW-d*24*HOUR)}));
  const x=setup({postsValue:[...old,FOUND]});await openChat(x);
  const fold=x.d.querySelector('details.run-posts-fold');
  assert.ok(fold);assert.equal(text(fold.querySelector('summary')),'4 earlier runs');
  assert.equal(fold.querySelectorAll('[data-run-post]').length,4);
  assert.ok(!x.d.querySelector(`details [data-run-post="${R1}"]`),'today’s run is not folded');
});

test('a Personal Pip’s scheduled result is its message in its chat, with the rest under Open full result',async()=>{
  const RESULT={...base,run_id:R1,kind:'result',outcome:'result',pip_type:'scout',name:'Morning brief',posted_at:iso(NOW-HOUR),
    preview:'Good morning. **Three things** today.\n\nThe GST filing is due Friday.',truncated:true};
  const x=setup({workspace:{id:'ws',name:'Personal',kind:'personal'},postsValue:[RESULT],
    pipValue:pip({pip_type:'scout',name:'Morning brief',source_policy:{mode:'personal'},report_chats:0,report_session:null})});
  await openChat(x);
  const post=x.d.querySelector(`article.run-post[data-run-post="${R1}"]`);
  assert.ok(post,'its result is in its chat');
  assert.match(text(post.querySelector('.run-post-body')),/Good morning\. Three things today\. ?The GST filing is due Friday\. ?The rest is in the full result\./);
  assert.ok(post.querySelector('.run-post-body strong'),'its words, as Markdown');
  assert.deepEqual([...post.querySelectorAll('.run-post-actions button')].map(text),['Open full result'],'no Ask DGC to fix for a Personal Pip');
  assert.equal(x.d.querySelector('[data-tab=runs]').textContent,'History','Results became History');
  x.click('[data-tab=runs]');await x.drain();
  assert.match(x.d.body.textContent,/Each result is also in its chat, where you can ask about it\./);
});

test('before Pips API 51 nothing changes: no posts are asked for, Runs and Report ready stay',async()=>{
  const x=setup({apiVersion:50});await openChat(x);
  assert.equal(x.requests('list_pip_run_posts').length,0);
  assert.equal(x.d.querySelector('[data-tab=runs]').textContent,'Runs');
  assert.equal(text(x.d.querySelector('.hero button.last-run')),'Report ready');
  assert.equal(x.d.querySelector('[data-run-post]'),null);
});

test('the host refuses list_pip_run_posts from a CLI older than API 51',()=>{
  for(const api of [50,51]){const sent=[],posted=[];const editor=new view.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
    editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
    editor.receive({type:'pipsRequest',id:'p',request:{type:'list_pip_run_posts',pip_id:PIP}});
    assert.equal(sent.length,api===51?1:0);if(api===50)assert.match(posted.at(-1).error.message,/runs in its chat/);}
});

test('a post the editor can’t read is left out; a page from another Pip is refused',()=>{
  const page=posts.runPostsPage({pip_id:PIP,workspace_id:'ws',posts:[FOUND,{...FOUND,run_id:'nope'},{...FOUND,outcome:'other'}],next_before_id:null},PIP,'ws');
  assert.deepEqual(page.posts.map(p=>p.run_id),[R1]);
  assert.throws(()=>posts.runPostsPage({pip_id:'pip_other',workspace_id:'ws',posts:[],next_before_id:null},PIP,'ws'));
  assert.deepEqual(posts.postShort({...FOUND,counts:{medium:2}}),{text:'5 findings',tone:''});
  assert.equal(posts.postStatus({...CLEAR,kind:'checks',outcome:'checks_failed',checks:{failed:2,total:5}},NOW),'Today’s checks: 2 of 5 failed');
});

// The chat Ask DGC to fix opens (a session's tab) sends the Work chat card's prompt once, after its transcript is in.
test('a Work chat asked from a Pip sends the card’s prompt once',()=>{
  const s=makeDom();
  s.send({type:'event',event:{type:'ready',capabilities:{pip_reports:1},model:'m',mode:'default',think:'off'}});
  const before=s.posted.length;
  s.send({type:'pipAskDgc',report:FOUND});
  s.send({type:'pipAskDgc',report:FOUND});
  const prompts=s.posted.slice(before).filter(m=>m.type==='prompt');
  assert.equal(prompts.length,1,'one message');
  assert.match(prompts[0].text,new RegExp(`^Pip “ERP daily audit” reported 5 findings \\(2 high, 2 medium, 1 low\\) in run ${R1}\\.`));
  assert.match(prompts[0].text,/pips_context \(action "report", run_id "run_1+"\)/);
  assert.match(prompts[0].text,/Ask me before you change any live data or services\./);
  assert.deepEqual(s.errors,[]);
});
