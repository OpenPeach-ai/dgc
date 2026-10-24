// A live-data Pip (Pips API 60): a project Pulse whose job is a fixed list of read-only commands. DGC runs only those
// exact lines in a read-only box and its model sums up what they print (dgc/pip_live_data.py). Here: the setup card
// shows the exact commands, the Pips view offers live data beside tests and saves the commands as a reviewed change,
// Run now runs it with no test-plan pins, a run's page shows its summary and each command's output, its chat posts
// the summary (all-clear runs fold), and the Work chat card says "needs you" with Ask DGC to fix, or "all clear".
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build,buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {makeDom,markdownJs} from './support/webview-dom.mjs';
const require=createRequire(import.meta.url);
const src=fileURLToPath(new URL('../src/',import.meta.url));
const model=await import(new URL('../src/pipsModel.js',import.meta.url).href);
const posts=await import(new URL('../src/pipRunPosts.js',import.meta.url).href);
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const viewCode=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const view={exports:{}};new Function('module','exports','require',viewCode)(view,view.exports,name=>name==='vscode'?{}:require(name));
const cardsBundle=buildSync({entryPoints:[src+'pipSetupCards.js'],bundle:true,write:false,format:'iife',globalName:'Cards'}).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));

const PIP='pip_'+'a'.repeat(32),WS='ws_'+'1'.repeat(32);
const PLAN={schema_version:1,commands:['sqlite3 -readonly data/app.db "SELECT status, count(*) FROM orders GROUP BY status"','df -h .','curl -s http://127.0.0.1:8765/health']};
const NOW=(()=>{const d=new Date();d.setHours(12,0,0,0);return d.getTime();})(),HOUR=3600000;
const iso=ms=>new Date(ms).toISOString();
const runId=n=>'run_'+(0x10+n).toString(16).padStart(32,'d');
const base={pip_id:PIP,name:'ERP live check',pip_type:'pulse',kind:'live',trigger:'schedule',text:'x',summary_by:'model',failed_commands:[]};
const clear=(n,at,summary=`Orders: 2 paid, 1 unpaid. Disk 62% used. Health ok, queue ${n}.`)=>({...base,run_id:runId(n),outcome:'live_clear',posted_at:iso(at),finished_at:iso(at),summary,commands:{ok:3,failed:0,total:3}});
const attention=(n,at)=>({...base,run_id:runId(n),outcome:'live_attention',posted_at:iso(at),finished_at:iso(at),summary:'The health check failed: curl printed nothing. Orders: 1 unpaid.',commands:{ok:2,failed:1,total:3},failed_commands:['curl -s http://127.0.0.1:8765/health']});

test('the model checks a live plan’s shape and reads the commands one a line',()=>{
  assert.deepEqual(model.livePlan(PLAN),PLAN);
  assert.equal(model.livePlan(null),null);
  for(const bad of [{schema_version:1,commands:[]},{schema_version:2,commands:['df']},{schema_version:1,commands:['df','df']},
    {schema_version:1,commands:['df\nrm -rf /']},{schema_version:1,commands:Array.from({length:7},(_,i)=>'echo '+i)},{schema_version:1,commands:['df'],ports:[80]}])
    assert.throws(()=>model.livePlan(bad),/invalid/);
  assert.deepEqual(model.livePlanFromText('  df -h .\n\nuptime  \n'),{schema_version:1,commands:['df -h .','uptime']});
  assert.throws(()=>model.livePlanFromText('\n \n'),/at least one command/);
  assert.throws(()=>model.livePlanFromText('df\ndf'),/listed once/);
  assert.ok(model.livePip({pip_type:'pulse',live_plan:PLAN}));
  assert.ok(!model.livePip({pip_type:'pulse',live_plan:null}));
});

const setup=(extra={})=>({id:'setup_'+'3'.repeat(32),digest:'a'.repeat(64),workspace_id:WS,project_root:'/srv/erp',pip_id:null,name:'ERP live check',goal:'Tell me when orders go unpaid or the app is down.',pip_type:'pulse',work_kind:'live_data',source_ref:'HEAD',schedule:{type:'interval',minutes:60,missed_policy:'coalesce_latest'},run_now:true,next_run_at:'2099-10-02T05:00:00Z',status:'pending',created_at:'2099-10-02T04:00:00Z',expires_at:'2099-10-03T06:00:00Z',receipt:null,reason:'The user asked to watch the ERP.',expected_version:null,expected_lifecycle_revision:null,permissions:'review_required',source_policy:'committed_only',runner_notice:'Its schedule runs only while Pips are running.',scope_notice:'Runs only these exact read-only commands, in your project folder as it is now, in a read-only box.',run_now_policy:'It also runs once right after you accept.',model_choice:{mode:'default'},live_plan:PLAN,...extra});

test('a live-data setup card is valid only as a Pulse with its exact commands',()=>{
  assert.equal(model.pipSetup(setup(),WS).live_plan,PLAN);
  const plan={schema_version:1,action:{kind:'test',network:false,tests:[{argv:['true'],cwd:'.'}],limits:{wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32}}};
  for(const bad of [setup({work_kind:'command_verification'}),setup({verification_plan:plan}),setup({pip_type:'rook',work_kind:'source_review'}),setup({live_plan:{schema_version:1,commands:[]}})])
    assert.throws(()=>model.pipSetup(bad,WS));
});

test('the docked card says how many read-only commands and that it changes nothing; Details lists each one',async t=>{
  const dom=new JSDOM('<main><section id="turn"><div class="tool"><div class="head"><button class="tool-toggle"><span class="verb"></span></button><span class="badge"></span></div><div class="body"><pre></pre></div></div></section></main>',{runScripts:'outside-only'});const w=dom.window;w.TextEncoder=TextEncoder;w.eval(cardsBundle+';window.Cards=Cards;');
  const docked=[],sent=[];const dock={show:el=>{docked.push(el);w.document.body.append(el);return true;},hide:el=>el.remove()};
  const cards=w.Cards.mountSetupCards({document:w.document,postMessage:m=>sent.push(m),onContinue:()=>true,dock});t.after(()=>{cards.dispose();w.close();});
  cards.receive({type:'pipsConnection',generation:1,connected:true,enabled:true,backgroundSetup:true,apiVersion:60});
  cards.toolResult(w.document.querySelector('.tool'),{name:'pips_setup',output:JSON.stringify({setup:setup()})});
  cards.receive({type:'pipsReply',id:sent.find(m=>m.request?.type==='get_pip_setup').id,ok:true,result:{setup:setup()}});
  for(let i=0;i<16;i++)await Promise.resolve();
  const card=docked[0];assert.ok(card,'it docks above the chat box like any Pulse');
  assert.deepEqual([...card.querySelectorAll('.pip-dock-chip')].map(c=>c.textContent),['Every 60 minutes','Runs once now','3 read-only commands','Changes nothing','Default model']);
  const facts=[...w.document.querySelectorAll('.pip-setup-fact')].map(f=>[f.querySelector('dt').textContent,f.querySelector('dd').textContent]);
  assert.deepEqual(facts.filter(([k])=>k==='Command').map(([,v])=>v),PLAN.commands);
  assert.ok(facts.some(([k,v])=>k==='Runs'&&/its model summarizes/.test(v)));
  assert.ok(facts.some(([k])=>k==='Model'),'its model writes the summary, so it is the model, not only the chat model');
});

const pulse=(extra={})=>({id:PIP,workspace_id:'ws',pip_type:'pulse',name:'ERP live check',goal:'Tell me when orders go unpaid or the app is down.',source_policy:{mode:'committed_only'},source_ref:'HEAD',status:'active',current_version:2,lifecycle_revision:0,policy:'review_required',trigger:'schedule',schedule:{type:'interval',minutes:60,missed_policy:'coalesce_latest'},proposals:[],report_chats:1,report_session:'chat-erp',latest_run:null,verification_plan:null,live_plan:PLAN,...extra});
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>{const available=['scout','lens','rook','lock'].includes(id),name=id[0].toUpperCase()+id.slice(1);return{id,name,character_index,role:{core:'Main chat',scout:'Repository exploration',lens:'Repository research',patch:'Code changes',rook:'Code review',pulse:'Test execution',lock:'Security review',quill:'Documentation writing'}[id],description:available?'Inspect committed source with a focused read-only preset.':'This role is planned.',available,unavailable_reason:available?null:'This engine is not available yet.',default_name:name+' job',default_goal:available?'Inspect source for '+id+' findings.':'',engine:available?'source_audit':null};});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const LIVE_RUN={id:runId(1),pip_id:PIP,status:'succeeded',created_at:iso(NOW-HOUR),manifest:{run_kind:'live',job_version:2,source_revision:'a'.repeat(40),trigger:'schedule',scheduled_at:iso(NOW-HOUR),model:'deepseek-v4.1-flash:cloud'},
  result:{live:{schema_version:1,summary:'The health check failed: curl printed nothing. Orders: 1 unpaid.',summary_by:'model',attention:true,notes:[],verification:'v',commands:[
    {index:0,command:PLAN.commands[0],status:'ok',exit_code:0,output:'paid|2\nunpaid|1\n',output_truncated:false,seconds:0.02},
    {index:1,command:'df -h .',status:'ok',exit_code:0,output:'Filesystem Size Used Avail Use% Mounted on\n/dev/nvme0n1p2 3.7T 2.2T 1.4T 62% /mnt\n',output_truncated:false,seconds:0.02},
    {index:2,command:PLAN.commands[2],status:'failed',exit_code:7,output:'',output_truncated:false,seconds:0.03}]}}};
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function pips({apiVersion=60,pipValue=pulse(),postsValue=[],runs=[LIVE_RUN],reply={}}={}){
  const dom=new JSDOM(view.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  w.Date.now=()=>NOW;
  const sent=[],answered=new Set(),asks=[];let persisted;
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.eval(markdownJs+'\nglobalThis.DgcMarkdown=DgcMarkdown;');w.eval(client);
  w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),getState:()=>persisted,setState:v=>{persisted=v;},
    onMessage:listener=>{const handle=e=>listener(e.data);w.addEventListener('message',handle);return()=>w.removeEventListener('message',handle);},
    onAskDgc:ask=>{asks.push(JSON.parse(JSON.stringify(ask)));return true;}});
  const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
  const defaults=r=>({list_workspaces:()=>({workspaces:[{id:'ws',name:'toni-erp'}],current_workspace_id:'ws'}),list_pip_types:()=>({types}),list_pips:()=>({pips:[pipValue]}),
    get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),get_pip:()=>({pip:pipValue}),
    list_pip_runs:()=>({runs}),get_pip_run:()=>({run:runs.find(x=>x.id===r.run_id)}),get_pip_execution:()=>({execution:{available:true,platform:'linux',backend:'bwrap',limits:{}}}),
    list_pip_messages:()=>({pip_id:PIP,workspace_id:'ws',messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:PIP,workspace_id:'ws',posts:postsValue,next_before_id:null}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
    list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]}),...reply}[r.type]?.(r));
  const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
  async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answered.add(m.id);send(result instanceof Error?{type:'pipsReply',id:m.id,ok:false,error:{code:result.code,message:result.message}}:{type:'pipsReply',id:m.id,ok:true,result});}}}}
  send({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
  const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s+' in '+w.document.body.textContent.slice(0,600));el.click();};
  return {w,d:w.document,sent,asks,requests,drain,click,send};
}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim();
const said=el=>text(el.querySelector('.run-post-body'));
const attachments=el=>[...el.querySelector('.run-post-attach').children].map(e=>e.matches('details')?text(e.querySelector('summary')):text(e));

test('its chat says the summary; a run that needs you has its output and Ask DGC to fix one click away',async()=>{
  const x=pips({postsValue:[attention(1,NOW-HOUR)]});await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();
  const post=x.d.querySelector('article.run-post');
  assert.equal(post.dataset.outcome,'live_attention');
  assert.equal(said(post),'The health check failed: curl printed nothing. Orders: 1 unpaid.','the summary is the Pip’s words');
  assert.deepEqual(attachments(post),['Output · 3 commands','Ask DGC to fix']);
  const report=post.querySelector('details.run-post-report');report.querySelector('summary').click();
  assert.deepEqual([...report.querySelectorAll('.run-post-findings li')].map(li=>[...li.children].map(text).join(' ')),['didn’t run curl -s http://127.0.0.1:8765/health']);
  assert.equal(text(report.querySelector('button[data-post-open]')),'Open the full output');
  post.querySelector('[data-post-fix]').click();await x.drain();
  assert.equal(x.asks.length,1);assert.equal(x.asks[0].report.kind,'live');assert.equal(x.asks[0].report.outcome,'live_attention');
});

test('all-clear runs fold into one message that shows the newest summary',async()=>{
  const x=pips({postsValue:[0,1,2].map(k=>clear(k,NOW-(4-k)*HOUR))});await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();
  const all=x.d.querySelectorAll('article.run-post');
  assert.equal(all.length,1,'three all-clear runs, one message');
  assert.equal(said(all[0]),'Orders: 2 paid, 1 unpaid. Disk 62% used. Health ok, queue 2.');
  assert.match(text(all[0].querySelector('details.run-post-times summary')),/^✓ All clear 3 times since /);
  assert.deepEqual(posts.postShort(clear(0,NOW)),{text:'All clear',tone:'clear'});
  assert.deepEqual(posts.postShort(attention(0,NOW)),{text:'Needs you · 1 of 3 commands didn’t run',tone:'bad'});
  assert.equal(posts.postStatus(attention(0,NOW),NOW),'Today’s check: needs you');
});

test('History has Run now, which runs it with no test-plan pins, and a run’s page shows the summary and each output',async()=>{
  const x=pips({reply:{run_pip:()=>({run:LIVE_RUN})}});await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();
  x.click('[data-tab="runs"]');await x.drain();
  const run=[...x.d.querySelectorAll('button')].find(b=>b.textContent==='Run now');assert.ok(run,'Run now');assert.equal(run.disabled,false);
  run.click();await x.drain();
  const request=x.requests('run_pip').at(-1).request;
  assert.deepEqual(Object.keys(request).sort(),['idempotency_key','pip_id','type'],'no Pulse test-plan pins');
  const page=x.d.querySelector('[aria-label="Live data run"]');assert.ok(page,'its run page');
  assert.equal(text(page.querySelector('h2')),'Needs you');
  assert.equal(text(page.querySelector('.live-summary')),'The health check failed: curl printed nothing. Orders: 1 unpaid.');
  assert.deepEqual([...page.querySelectorAll('.live-command')].map(a=>text(a.querySelector('h3'))),['Ran','Ran','Failed · exit code 7']);
  assert.deepEqual([...page.querySelectorAll('.live-command-line')].map(text),PLAN.commands.map(c=>'$ '+c));
  assert.match(text(page),/paid\|2 unpaid\|1/);
  assert.match(text(page),/Nothing was changed/);
});

test('Plan & schedule offers live data beside tests and saves the commands as a reviewed change; a write is refused',async()=>{
  const plain=pulse({live_plan:null,schedule:null,current_version:1});
  let proposed=null;
  const x=pips({pipValue:plain,runs:[],reply:{propose_pip_update:r=>{proposed=r;if(r.changes.live_plan?.commands.some(c=>c.startsWith('rm ')))return Object.assign(Error("DGC won't run `rm data/app.db` for a live-data Pip: rm deletes files."),{code:'write_command'});
    return {proposal:{id:'proposal_'+'1'.repeat(32),pip_id:PIP,expected_version:1,status:'proposed',reason:r.reason,actor:'editor-user',created_at:iso(NOW),definition:{...plain,live_plan:r.changes.live_plan,schedule:r.changes.schedule,verification_plan:null}}};}}});
  await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();x.click('[data-tab="schedule"]');await x.drain();
  const choice=x.d.querySelector('input[name="pulseMode"][value="live"]');assert.ok(choice,'what it runs: tests or live data');
  choice.checked=true;choice.dispatchEvent(new x.w.Event('change',{bubbles:true}));await x.drain();
  const box=x.d.getElementById('liveCommands');assert.ok(box,'one command a line');
  assert.match(text(x.d.querySelector('.live-reach summary')),/What these commands can reach/);
  box.value='rm data/app.db';box.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  x.d.getElementById('schedule-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await x.drain();
  assert.match(text(x.d.body),/rm deletes files/,'the backend’s refusal is said plainly');
  const again=x.d.getElementById('liveCommands');assert.equal(again.value,'rm data/app.db','what was typed is kept after the refusal');
  again.value=PLAN.commands.join('\n');again.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  x.d.getElementById('schedule-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await x.drain();
  assert.deepEqual(JSON.parse(JSON.stringify(proposed.changes.live_plan)),PLAN);
  assert.equal(Object.hasOwn(proposed.changes,'verification_plan'),false,'it had no test plan to take away');
  assert.equal(proposed.changes.event_trigger,null);
  const dialog=x.d.querySelector('.dialog');assert.ok(dialog,'the change opens for review; nothing changes until accepted');
  assert.deepEqual([...dialog.querySelectorAll('.live-command-list pre')].map(text),PLAN.commands);
});

test('before Pips API 60 a Pulse shows no live-data choice',async()=>{
  const x=pips({apiVersion:59,pipValue:pulse({live_plan:null,schedule:null})});await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();x.click('[data-tab="schedule"]');await x.drain();
  assert.equal(x.d.querySelector('input[name="pulseMode"]'),null);
  assert.ok(x.d.getElementById('verificationEnabled'),'the test plan editor as before');
});

const R='run_'+'e'.repeat(32);
const CARD={run_id:R,pip_id:PIP,name:'ERP live check',pip_type:'pulse',kind:'live',outcome:'live_attention',finished_at:'2026-10-22T09:00:00.000Z',earlier:0,
  summary:'The health check failed: curl printed nothing. Orders: 1 unpaid.',summary_by:'model',commands:{ok:2,failed:1,total:3},failed_commands:['curl -s http://127.0.0.1:8765/health']};
function panel(caps={pip_reports:1}){const s=makeDom();s.event=e=>s.send({type:'event',event:e});s.event({type:'ready',capabilities:caps,model:'m',mode:'default',think:'off'});return s;}

test('the Work chat card says needs you with the summary and the command that didn’t run, and asks DGC to fix it',()=>{
  const s=panel();s.event({type:'pip_report',report:CARD});
  const card=s.doc.querySelector('#log .pip-report');assert.ok(card);
  assert.equal(card.querySelector('.pip-report-state').textContent,'needs you · 1 of 3 commands didn’t run');
  assert.equal(card.querySelector('.pip-report-summary').textContent,CARD.summary);
  assert.deepEqual([...card.querySelectorAll('.pip-report-findings li')].map(li=>li.textContent),['failedcurl -s http://127.0.0.1:8765/health']);
  assert.equal(card.querySelector('.pip-report-line-what').textContent,CARD.summary);
  const before=s.posted.length;card.querySelector('.pip-report-fix').click();
  const [sent]=s.posted.slice(before).filter(m=>m.type==='prompt');
  assert.match(sent.text,/^Pip “ERP live check” read live data and reported \(run run_e{32}\): The health check failed/);
  assert.match(sent.text,/Don't change live data, a database or a service/);
  assert.deepEqual(s.errors,[]);
});

test('an all-clear live run is a quiet card with no Fix',()=>{
  const s=panel();s.event({type:'pip_report',report:{...CARD,outcome:'live_clear',summary:'Orders: 2 paid. Disk 62% used.',commands:{ok:3,failed:0,total:3},failed_commands:[]}});
  const card=s.doc.querySelector('#log .pip-report');
  assert.ok(card.classList.contains('quiet'));
  assert.equal(card.querySelector('.pip-report-state').textContent,'finished · all clear');
  assert.equal(card.querySelector('.pip-report-fix, .pip-report-fix-slim'),null);
});
