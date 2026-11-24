// A Pip's runs in its own chat (Pips API 51), as the Pip speaking: each run is a reply from the Pip in its own short
// words, grounded in the run's report (reported 21 Oct, "The Pip speaks"). Since 24 Nov it is a reply like any other
// ("just chat with responses"): what a check found is a list inside it, and under it the row every reply ends with (its
// time, Copy, Read aloud, Trace), no chips (no Report ›, Ask DGC to fix, See what happened, Run again now, Open run).
// All-clear runs in a row are ONE reply that updates itself ("Both checks passed again", "Passed 12 times since
// Monday: …"), and a failure or findings breaks it. Replay draws the same.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
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
const ws={id:'ws',name:'shop-api'};
const iso=ms=>new Date(ms).toISOString();
// Noon today, and the page's clock with it (setup), so the posts 1 to 5 hours "ago" stay on today's date and
// the next run stays ahead at any hour: from Date.now() they read "Yesterday's audit" between midnight and 5 AM,
// and with noon alone the 1 PM next run had passed by the afternoon.
const NOW=(()=>{const d=new Date();d.setHours(12,0,0,0);return d.getTime();})(),HOUR=3600000,DAY=24*HOUR;
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
// A Pulse Pip's checks: a run id per hour, and two checks each time.
const runId=n=>'run_'+(0x10+n).toString(16).padStart(32,'c');
const checks=(n,at,outcome='checks_passed')=>({...base,name:'ERP heartbeat',pip_type:'pulse',kind:'checks',run_id:runId(n),outcome,posted_at:iso(at),finished_at:iso(at),
  checks:outcome==='checks_passed'?{passed:2,failed:0,total:2}:{passed:1,failed:1,total:2},failed_checks:outcome==='checks_passed'?[]:['GET http://127.0.0.1:8000/api/invoices → 200']});
const pulse=(extra={})=>pip({pip_type:'pulse',name:'ERP heartbeat',latest_run:null,...extra});
const run=(id,at,status='succeeded')=>({id,pip_id:PIP,status,created_at:at,manifest:{run_kind:'audit',job_version:1,source_revision:'a'.repeat(40),trigger:'schedule'},result:null});
const message=(id,role,text,at,extra={})=>({id,pip_id:PIP,workspace_id:'ws',role,text,run_id:CHAT,model:'m',created_at:at,status:'succeeded',...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({apiVersion=51,postsValue=[FOUND,FAILED,CLEAR],messages=[],state,pipValue=pip(),workspace=ws,runs:runsValue}={}){
  const dom=new JSDOM(view.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  // The page's clock is the test's: "Today's" and "I'll run again at 1 PM" hold at any hour the suite runs.
  w.Date.now=()=>NOW;
  const sent=[],answered=new Set(),asks=[];let persisted=state;
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.eval(markdownJs+'\nglobalThis.DgcMarkdown=DgcMarkdown;');w.eval(client);
  const controller=w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),getState:()=>persisted,setState:v=>{persisted=v;},
    onMessage:listener=>{const handle=e=>listener(e.data);w.addEventListener('message',handle);return()=>w.removeEventListener('message',handle);},
    onAskDgc:ask=>{asks.push(JSON.parse(JSON.stringify(ask)));return true;}});
  const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
  const runs=runsValue||[run(R1,FOUND.posted_at),run(R2,FAILED.posted_at,'failed'),run(R3,CLEAR.posted_at)];
  const held={posts:postsValue};
  const defaults=r=>({list_workspaces:()=>({workspaces:[workspace],current_workspace_id:'ws'}),list_pip_types:()=>({types}),list_pips:()=>({pips:[pipValue]}),
    get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),get_pip:()=>({pip:pipValue}),
    list_pip_runs:()=>({runs}),get_pip_run:()=>{const found=runs.find(x=>x.id===r.run_id);return {run:{...found,result:found?.result||{summary:'Two high findings.',findings:[],limitations:[]}}};},
    list_pip_messages:()=>({pip_id:PIP,workspace_id:'ws',messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:PIP,workspace_id:'ws',posts:held.posts,next_before_id:null}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
    list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]})}[r.type]?.());
  const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
  async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answered.add(m.id);send({type:'pipsReply',id:m.id,ok:true,result});}}}}
  // A run finished while the chat is open: the next look (the view polls; here, it comes back into view) reads it.
  async function arrive(...more){held.posts=[...held.posts,...more];send({type:'pipsVisibility',visible:true});await drain();}
  send({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
  const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
  return {w,d:w.document,controller,sent,asks,requests,drain,click,arrive,persisted:()=>persisted};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim();
// The Pip's words, without the list of what it found or the times of a run of passes.
const said=el=>{const b=el.querySelector('.run-post-body').cloneNode(true);b.querySelectorAll('.run-post-findings,.run-post-more,.run-post-times-line').forEach(n=>n.remove());return text(b);};
// What a reply has under it: the words of its row's buttons. No chips are left anywhere on it.
const NO_CHIPS='.run-post-attach,.run-post-chip,.run-post-report,.run-post-fix,[data-post-run],[data-post-fix],[data-post-more],details';
const attachments=el=>{assert.deepEqual([...el.querySelectorAll(NO_CHIPS)].map(n=>n.className||n.tagName),[],'no chips');return [...el.querySelectorAll(':scope > .response-actions > button')].map(b=>b.getAttribute('aria-label')||text(b));};
const ROW=['Copy response','Read aloud'];   // a reply's row: Copy, Read aloud (Trace too, for a run that kept its steps)
const listed=el=>[...el.querySelectorAll('.run-post-body .run-post-findings li')].map(li=>[...li.children].map(text).join(' '));
const log=d=>[...d.querySelectorAll('.conversation-log [data-run-post],.conversation-log [data-message]')];

test('a run with findings is the Pip saying what it found, with what it found listed in the message',async()=>{
  const x=setup();await openChat(x);
  const post=x.d.querySelector(`article.run-post[data-run-post="${R1}"]`);
  assert.ok(post,'the run is in the chat');
  assert.ok(post.closest('.conversation-log'),'inside the conversation, not above it');
  assert.ok(post.matches('.pip-message.assistant'),'drawn as the Pip’s own message');
  assert.ok(post.querySelector('.run-post-head .run-post-face .avatar'),'the Pip’s face: it says this without being asked');
  assert.equal(text(post.querySelector('.run-post-name')),'ERP daily audit');
  assert.equal(post.querySelector('.run-post-head time'),null,'no time beside its name');
  assert.ok(post.querySelector(':scope > .response-actions time.msg-time'),'its time, in the row a reply ends with');
  assert.match(said(post),/^(I found 5 issues|5 issues this run|This run turned up 5 issues), 2 of them serious\. The (worst|top one) is in push\.py: E-way bill number is never written back to Tally\.$/);
  assert.doesNotMatch(post.textContent,/Today’s audit found/,'not DGC’s report line any more');
  assert.deepEqual(attachments(post),ROW,'no Ask DGC to fix: you ask the Pip');
  assert.deepEqual(listed(post),[
    'high E-way bill number is never written back to Tally erp/tally/push.py:214',
    'high GST total skips cess on mixed-rate invoices erp/gst/totals.py:88',
    'medium Rounding drops paise on credit notes erp/billing/notes.py:41'],'what it found, in the message');
  assert.equal(text(post.querySelector('.run-post-body .run-post-more')),'2 more findings: ask ERP daily audit for them.');
  assert.equal(post.querySelector('[data-post-open]'),null,'no Open full report');
  assert.match(post.getAttribute('aria-label'),/^ERP daily audit: (I found 5 issues|5 issues this run|This run turned up 5 issues)/);
});

test('every number and file name the Pip says is in the run’s report, for every kind of run',()=>{
  // The figures guard, over every outcome and many reports: the Pip may word it a few ways, never invent.
  const files=['erp/gst/totals.py','billing.py','a/b/c.py','src/app.ts'];
  const made=[];
  for(let k=0;k<160;k++){
    const id='run_'+(k*2654435761>>>0).toString(16).padStart(32,'0').slice(-32);
    const total=k%7,sev=['critical','high','medium','low'];
    const findings=Array.from({length:Math.min(3,total)},(_,i)=>({title:`Problem ${String.fromCharCode(65+i)} in the totals`,severity:sev[(k+i)%4],path:files[(k+i)%(k%3?4:1)],line:10+i}));
    const counts={critical:0,high:0,medium:0,low:0};for(let i=0;i<total;i++)counts[i<findings.length?findings[i].severity:sev[(k+i)%4]]++;
    const t=k%5,n=1+k%4,f=k%n;
    made.push(total?{...base,run_id:id,outcome:'findings',total,counts,findings,posted_at:iso(NOW)}:{...base,run_id:id,outcome:'clear',total:0,counts,findings:[],posted_at:iso(NOW)});
    made.push({...base,kind:'checks',run_id:id,outcome:f?'checks_failed':'checks_passed',checks:{passed:n-f,failed:f,total:n},failed_checks:f?[`npm test -- --shard=${t}`,`pytest -q tests/test_${t}.py`].slice(0,f):[],posted_at:iso(NOW)});
    made.push({...base,run_id:id,outcome:'failed',reason:['It ran out of time.','Its model is not available.','It stopped: exit 3 from the worker','Pips stopped before the run finished.'][t%4],next_run_at:t%2?iso(NOW+(t+1)*HOUR):null,posted_at:iso(NOW)});
  }
  let previous=null;
  for(const p of made){
    const words=posts.wordsText(posts.pipWords(p,{previous,now:NOW}));previous=p;
    const report=JSON.stringify(p),next=Date.parse(p.next_run_at||'');
    const clockWords=Number.isFinite(next)?new Date(next).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'';
    for(const number of words.replace(clockWords,'').match(/\d+/g)||[])
      assert.ok(report.includes(number),`“${number}” in “${words}” is not in the report ${report}`);
    for(const file of words.match(/[\w./-]+\.(py|ts)\b/g)||[])
      assert.ok(p.outcome==='findings'?p.findings.some(f=>f.path===file||f.path.endsWith('/'+file)):report.includes(file),`${file} in “${words}” is not in its report`);
    if(p.outcome==='findings'){
      const serious=p.counts.critical+p.counts.high,m=/(\d+) of them (serious|critical)/.exec(words);
      if(m)assert.equal(Number(m[1]),m[2]==='critical'?p.counts.critical:p.counts.high,words);
      if(/both serious|all serious/.test(words))assert.equal(p.counts.high,p.total,words);
      if(!serious)assert.doesNotMatch(words,/serious|critical/,words);
      assert.ok(words.toLowerCase().includes(p.total===1?'one':String(p.total)),`the count is said: ${words}`);
    }
    if(p.outcome==='checks_failed')assert.ok(p.failed_checks.every(l=>words.includes(l)),`it names what failed: ${words}`);
    assert.doesNotMatch(words,/\bAI\b/);
  }
});

test('a week of runs doesn’t drumbeat, and the same run always reads the same',()=>{
  const week=Array.from({length:7},(_,k)=>({...FOUND,run_id:'run_'+(k*40503+7).toString(16).padStart(32,'e'),posted_at:iso(NOW-k*DAY)}));
  const lines=week.map((p,i)=>posts.wordsText(posts.pipWords(p,{previous:week[i-1]||null,now:NOW})));
  assert.ok(new Set(lines.map(l=>l.split(',')[0])).size>=2,`varied openings: ${lines.join(' | ')}`);
  assert.deepEqual(week.map((p,i)=>posts.wordsText(posts.pipWords(p,{previous:week[i-1]||null,now:NOW}))),lines,'deterministic');
});

test('a failed run says what stopped it in the Pip’s voice, that nothing changed, and when it tries again',async()=>{
  const x=setup();await openChat(x);
  const post=x.d.querySelector(`article.run-post[data-run-post="${R2}"]`);
  assert.match(said(post),/^(I couldn’t finish this run\.|This run stopped before it finished\.|I didn’t get to the end of this run\.) A finding quoted code that does not match the file, so Pips refused the report\. Nothing in your project was changed\. I’ll try again (today|tomorrow) at /);
  assert.deepEqual(attachments(post),ROW,'no See what happened, Run again now or Ask DGC to fix');
  assert.doesNotMatch(post.textContent,/erp\/tally\/push\.py/,'the saved error detail is in the report, not the chat');
  const y=setup({postsValue:[{...FAILED,reason:'It ran out of time.'}]});await openChat(y);
  assert.match(said(y.d.querySelector('article.run-post')),/ I ran out of time\. /,'“It ran out of time” in its own voice');
});

test('all-clear runs in a row are one message that says it again, with how many times since when, and each time as words',async()=>{
  const passes=[0,1,2,3,4].map(k=>checks(k,NOW-DAY-(10-k)*HOUR)),more=[5,6,7].map(k=>checks(k,NOW-(9-k)*HOUR));
  const x=setup({pipValue:pulse(),postsValue:[...passes,...more]});await openChat(x);
  const [fold,...others]=x.d.querySelectorAll('article.run-post');
  assert.equal(others.length,0,'eight passes, one message');
  assert.ok(fold.matches('.run-post-streak'));
  assert.equal(fold.dataset.runPost,runId(7),'it stands for the newest run');
  assert.equal(said(fold),'Both checks passed again. Nothing for you to do.');
  const clock=ms=>new Date(ms).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  assert.equal(text(fold.querySelector(':scope > .response-actions time')),clock(NOW-2*HOUR),'the newest run’s time, in its row');
  const line=text(fold.querySelector('.run-post-times-line'));
  assert.equal(line,`Passed 8 times since yesterday: Yesterday ${passes.map(p=>clock(Date.parse(p.posted_at))).join(', ')} · Today ${more.map(p=>clock(Date.parse(p.posted_at))).join(', ')}`,'each time, as words');
  assert.deepEqual(attachments(fold),ROW,'nothing to open on the fold');
  assert.equal(x.d.querySelectorAll('.run-post-quiet, details.run-posts-fold').length,0,'no log lines left');
});

test('a new all-clear run updates the fold in place; a failure breaks it and is its own message',async()=>{
  const x=setup({pipValue:pulse(),postsValue:[0,1,2].map(k=>checks(k,NOW-(6-k)*HOUR))});await openChat(x);
  const before=x.d.querySelector('article.run-post-streak');
  assert.match(text(before.querySelector('.run-post-times-line')),new RegExp(`^Passed 3 times since ${new Date(NOW-6*HOUR).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}: Today `));
  await x.arrive(checks(3,NOW-2*HOUR));
  const now=x.d.querySelectorAll('article.run-post');
  assert.equal(now.length,1,'still one message');
  assert.equal(now[0].dataset.runPost,runId(3));assert.equal(now[0].dataset.runs,'4');
  assert.match(text(now[0].querySelector('.run-post-times-line')),/^Passed 4 times since /);
  await x.arrive(checks(4,NOW-HOUR,'checks_failed'));
  const [fold,failure]=x.d.querySelectorAll('article.run-post');
  assert.equal(fold.dataset.runs,'4','the fold keeps its runs');
  assert.equal(failure.dataset.outcome,'checks_failed');
  assert.match(said(failure),/GET http:\/\/127\.0\.0\.1:8000\/api\/invoices → 200/);
  assert.deepEqual(listed(failure),['failed GET http://127.0.0.1:8000/api/invoices → 200'],'the check that failed, in the message');
  assert.deepEqual(attachments(failure),ROW);
  await x.arrive(checks(5,NOW-HOUR/2));
  const last=[...x.d.querySelectorAll('article.run-post')].at(-1);
  assert.equal(last.dataset.runPost,runId(5));assert.ok(!last.matches('.run-post-streak'),'one pass after a failure is one message');
  assert.equal(said(last),'Both checks passed this time. Nothing for you to do.');
  assert.deepEqual(attachments(last),ROW,'no Open run');
});

test('a message from you ends the fold: the next pass is a new message, which says again',async()=>{
  const messages=[message('msg_1','user','Thanks, tell me if invoices break.',iso(NOW-4*HOUR)),message('msg_2','assistant','Will do.',iso(NOW-4*HOUR+60000))];
  const x=setup({pipValue:pulse(),messages,postsValue:[checks(0,NOW-6*HOUR),checks(1,NOW-5*HOUR),checks(2,NOW-3*HOUR)]});await openChat(x);
  assert.deepEqual(log(x.d).map(e=>e.dataset.runPost||e.dataset.message),[runId(1),'msg_1','msg_2',runId(2)]);
  const [fold,single]=x.d.querySelectorAll('article.run-post');
  assert.equal(fold.dataset.runs,'2');
  assert.equal(said(single),'Both checks passed again. Nothing for you to do.');
  assert.equal(x.requests('send_pip_message').length,0,'a post never starts a turn');
});

test('runs sit among the messages in time order, and a reload draws exactly the same',async()=>{
  const messages=[message('msg_1','user','Also watch the e-way bill write-back.',iso(NOW-4*HOUR)),message('msg_2','assistant','Got it.',iso(NOW-4*HOUR+60000)),
    message('msg_3','user','Is the e-way one the same failure as last week?',iso(NOW-30*60000))];
  const x=setup({messages});await openChat(x);
  assert.deepEqual(log(x.d).map(e=>e.dataset.runPost||e.dataset.message),[R3,'msg_1','msg_2',R2,R1,'msg_3']);
  const y=setup({messages});await openChat(y);
  const html=d=>[...d.querySelectorAll('.conversation-log [data-run-post]')].map(e=>e.outerHTML.replace(/editor-pip-\d+/g,'pip'));
  assert.deepEqual(html(y.d),html(x.d),'replay draws the same');
  const passes=[0,1,2,3].map(k=>checks(k,NOW-(8-k)*HOUR));
  const a=setup({pipValue:pulse(),postsValue:passes});await openChat(a);
  const b=setup({pipValue:pulse(),postsValue:[...passes].reverse()});await openChat(b);
  assert.deepEqual(html(b.d),html(a.d),'the fold too, whatever order the posts came in');
});

// No Open full report and no Ask DGC to fix on a run's post (24 Nov: "if anything needs fixing, user could just ask the
// Pip"): History still opens each run.
test('a run’s post opens nothing and asks nothing; History still opens each run',async()=>{
  const x=setup();await openChat(x);
  const post=x.d.querySelector(`[data-run-post="${R1}"]`);
  assert.equal(post.querySelector('[data-post-fix],[data-post-open]'),null);
  assert.equal(x.asks.length,0);
  x.click('[data-tab=runs]');await x.drain();
  x.click(`[data-run="${R1}"]`);await x.drain();
  assert.equal(x.d.querySelector('.simple-content')?.dataset.view,'runs');
  assert.equal(x.requests('get_pip_run').at(-1).request.run_id,R1);
  assert.ok(x.d.querySelector(`[data-run="${R1}"][aria-current=true]`),'that run is the one open');
});

// On the Personal Pips page a Project Pip has from 24 Oct, its status sits beside its name in the top bar, on its chat.
test('History says what each run found, and the status under its name goes to the run, in a fold too',async()=>{
  const x=setup();await openChat(x);
  const status=x.d.querySelector('.pip-topbar button.last-run');
  assert.equal(text(status),'Today’s audit: 5 findings');
  x.click('[data-tab=runs]');await x.drain();
  assert.equal(x.d.querySelector('.section h2').textContent,'History');
  assert.deepEqual([...x.d.querySelectorAll('.run-row .hist-row-out')].map(text),
    ['5 findings · 2 high','Didn’t finish · a finding quoted code that does not match the file, so Pips refused the report','Nothing found']);
  x.click('#simple-to-chat');await x.drain();
  x.d.querySelector('.pip-topbar button.last-run').click();await x.drain();
  assert.equal(x.d.querySelector('.simple-content')?.dataset.view,'chat');
  assert.equal(x.d.activeElement,x.d.querySelector(`[data-run-post="${R1}"]`),'the message it found is where focus lands');
  // The latest run inside a fold: the fold opens at its time.
  const passes=[0,1,2].map(k=>checks(k,NOW-(5-k)*HOUR));
  const y=setup({pipValue:pulse({latest_run:{id:runId(1),status:'succeeded'}}),postsValue:passes,runs:passes.map(p=>run(p.run_id,p.posted_at))});await openChat(y);
  y.click('.pip-topbar button.last-run');await y.drain();
  assert.equal(y.d.activeElement?.dataset.runPost,runId(2),'the reply that holds it, the newest of the passes');
  assert.match(y.d.activeElement.dataset.streakIds,new RegExp(runId(1)));
});

test('a Personal Pip’s scheduled result is its own reply, whole: a result the post cut is fetched and drawn whole',async()=>{
  const long='Good morning. Weather first: Mumbai is 30° and clearing.\n\n**Today**\n- 10:00 standup\n- 2:00 PM review of the billing fixes\n\n**GST**\n'+'GSTR-1 for September is due in 3 days. Two invoices from the 18th are not uploaded yet. '.repeat(3)+'\n\n**Also**\nYour car insurance renews on the 30th.';
  const RESULT={...base,run_id:R1,kind:'result',outcome:'result',pip_type:'scout',name:'Morning brief',posted_at:iso(NOW-HOUR),preview:long.slice(0,120),truncated:true};
  const x=setup({workspace:{id:'ws',name:'Personal',kind:'personal'},postsValue:[RESULT],runs:[{...run(R1,RESULT.posted_at),manifest:{run_kind:'personal_task',job_version:1,trigger:'schedule'},result:{text:long}}],
    pipValue:pip({pip_type:'scout',name:'Morning brief',source_policy:{mode:'personal'},report_chats:0,report_session:null})});
  await openChat(x);
  assert.equal(x.requests('get_pip_run').filter(r=>r.request.run_id===R1).length,1,'the whole result is asked for, once');
  const post=x.d.querySelector(`article.run-post[data-run-post="${R1}"]`);
  assert.ok(post,'its result is in its chat');
  assert.match(said(post),/^Good morning\. Weather first: Mumbai is 30° and clearing\. Today 10:00 standup 2:00 PM review of the billing fixes GST GSTR-1 .* Your car insurance renews on the 30th\.$/,'all of it');
  assert.ok(post.querySelector('.run-post-body strong'),'its words, as Markdown');
  assert.deepEqual(attachments(post),ROW,'no Show all, no Open result');
  x.d.querySelector(`[data-post-copy="${R1}"]`).click();
  assert.equal(x.sent.filter(m=>m.type==='copy').at(-1).text,long,'Copy has the whole result');
  assert.equal(x.d.querySelector('[data-tab=runs]').textContent,'History','Results became History');
});

// The routine's turn, exactly as dgc/pip_routines.py writes it (ROUTINE_TURN): the editor finds the routine by it.
const routineSource=readFileSync(new URL('../../../dgc/pip_routines.py',import.meta.url),'utf8');
const ROUTINE_TURN=/ROUTINE_TURN = \(((?:\s*"(?:[^"\\]|\\.)*")+)\)/.exec(routineSource)[1].match(/"(?:[^"\\]|\\.)*"/g).map(s=>JSON.parse(s)).join('');
test('a routine’s reply is the Pip’s own message with its face, name and routine, whole, its time in its row',async()=>{
  const turn=ROUTINE_TURN.replace('{title}','Unpaid invoices').replace('{when}','every weekday at 9:30 AM').replace('{prompt}','List unpaid invoices.');
  assert.equal(posts.routineTitle(turn),'Unpaid invoices','the editor reads the routine from DGC’s own turn');
  const reply='Three invoices are still unpaid:\n\n'+Array.from({length:9},(_,i)=>`- Invoice ${i+1}, ₹${(i+1)*1000}, due on the ${i+20}th`).join('\n')+'\n\nWant me to draft a reminder?';
  const messages=[message('msg_r','user',turn,iso(NOW-2*HOUR),{intro:true,run_id:R1}),message('msg_a','assistant',reply,iso(NOW-2*HOUR+60000),{run_id:R1}),
    message('msg_u','user','Thanks',iso(NOW-HOUR)),message('msg_b','assistant','You’re welcome.',iso(NOW-HOUR+60000))];
  const x=setup({workspace:{id:'ws',name:'Personal',kind:'personal'},postsValue:[],messages,
    pipValue:pip({pip_type:'scout',name:'Morning brief',source_policy:{mode:'personal'},report_chats:0,report_session:null})});
  await openChat(x);
  const reply1=x.d.querySelector('[data-message="msg_a"]');
  assert.ok(reply1.matches('.routine-reply'));
  assert.equal(text(reply1.querySelector('.run-post-name')),'Morning brief');
  assert.equal(text(reply1.querySelector('.run-post-routine')),'Unpaid invoices');
  assert.ok(reply1.querySelector('.run-post-face .avatar'));
  assert.match(reply1.textContent,/Want me to draft a reminder\?/,'all of it, no Show all');
  assert.equal(reply1.querySelector('[data-post-more]'),null);
  assert.ok(reply1.querySelector(':scope > .response-actions time.msg-time'),'its time in the row a reply ends with');
  assert.equal(reply1.querySelector('.run-post-head time'),null);
  assert.equal(x.d.querySelector('[data-message="msg_r"]'),null,'DGC’s turn stays hidden');
  assert.equal(x.d.querySelector('[data-message="msg_b"] .run-post-head'),null,'a reply you asked for is as it was');
});

test('a Pulse’s own runs speak in its chat: no Test results card beside each',async()=>{
  const passes=[0,1].map(k=>checks(k,NOW-(3-k)*HOUR));
  const runs=passes.map(p=>({...run(p.run_id,p.posted_at),execution_mode:'standalone_plan',manifest:{run_kind:'test',job_version:1,source_revision:'a'.repeat(40),trigger:'schedule'}}));
  const x=setup({pipValue:pulse(),postsValue:passes,runs});await openChat(x);
  assert.equal(x.d.querySelectorAll('.chat-result-card').length,0);
  assert.equal(x.d.querySelectorAll('article.run-post').length,1);
  const old=setup({apiVersion:50,pipValue:pulse(),postsValue:passes,runs});await openChat(old);
  assert.equal(old.d.querySelectorAll('.chat-result-card').length,2,'before posts (API 51) the cards are how a run is seen');
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

// ---- The document a run kept, as its card (Pips API 78, ui-04-pip-doc-card, asked 10 Nov) ----
const DOC={id:'ar_'+'d'.repeat(16),type:'doc',title:'ERP daily audit: findings',version:3};
test('a review kept as its document shows the card Work draws on its post, and the whole card opens it',async()=>{
  const x=setup({apiVersion:78,postsValue:[{...FOUND,artifact:DOC},{...CLEAR,artifact:{...DOC,type:'sheet',id:'ar_'+'e'.repeat(16),title:'',version:1}}]});
  await openChat(x);
  const card=x.d.querySelector(`[data-run-post="${R1}"] .dgc-doc-card`);
  assert.ok(card,'the card is on the post');
  assert.equal(card.dataset.tone,'doc');
  assert.equal(text(card.querySelector('.dgc-doc-name')),'ERP daily audit: findings');
  assert.equal(text(card.querySelector('.dgc-doc-meta')),'Document · version 3');
  assert.ok(card.compareDocumentPosition(x.d.querySelector(`[data-run-post="${R1}"] > .response-actions`))&x.w.Node.DOCUMENT_POSITION_FOLLOWING,
    'after the words, before the row the reply ends with');
  const sheet=x.d.querySelector(`[data-run-post="${R3}"] .dgc-doc-card`);
  assert.equal(text(sheet.querySelector('.dgc-doc-name')),'Sheet','a sheet with no name says what it is');
  assert.equal(sheet.dataset.tone,'sheet');
  card.querySelector('.dgc-doc-open').click();
  assert.deepEqual(x.sent.filter(m=>m.type==='pipsOpenArtifact').map(m=>[m.id,m.artifactType]),[[DOC.id,'doc']]);
});
test('no card from a DGC before API 78, for a link that is not a document, or in a fold of all-clear runs',async()=>{
  for(const [apiVersion,artifact] of [[77,DOC],[78,{...DOC,type:'dashboard'}],[78,{...DOC,id:'../../etc'}],[78,{...DOC,version:0}]]){
    const x=setup({apiVersion,postsValue:[{...FOUND,artifact}]});
    await openChat(x);
    assert.equal(x.d.querySelectorAll('.run-post .dgc-doc-card').length,0,`${apiVersion} ${JSON.stringify(artifact)}`);
  }
  const html=posts.postMarkup({...CLEAR,artifact:DOC},{name:'ERP daily audit',now:NOW,docs:true,streak:[CLEAR,{...CLEAR,run_id:R2}]});
  assert.doesNotMatch(html,/dgc-doc-card/,'a fold of all-clear runs is one line, not a card a run');
});
