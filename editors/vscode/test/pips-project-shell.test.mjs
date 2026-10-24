// Project Pips get the Personal Pips page (the founder, 24 Oct: "yes, do it"). Before, a Project Pip had its own page:
// a side bar of Pips with "Back to Pips", a Chat / History / Settings / More tab row, a header with its status and Run
// now under History, the setup cards and the "waiting for you" section, and the old create form. Now a project's Pips
// are the simple page's: its paged list with New Pip, a Pip's top bar (back, its face and name, a "…" menu) and the
// character picker. Nothing a Project Pip could do is gone: every section is in its menu, Run now is in the top bar
// where a Personal Pip has its computer, a change waiting for you and new Pips waiting stay in sight, and a new Pip is
// the same Pip the old form made. A remote view and a DGC from before Pips API 51 keep the old page. Mounted as the
// side bar mounts it.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';

const src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
const PW='ws_'+hex('e'),W='ws_'+hex('d');
const PLANNER='pip_'+hex('f'),AUDIT='pip_'+hex('a'),DOCS='pip_'+hex('b'),PATCH='pip_'+hex('c'),TESTS='pip_'+hex('9'),LIVE='pip_'+hex('8'),NEW='pip_'+hex('7');
const RUN='run_'+hex('1'),GOING='run_'+hex('2'),CHAT='run_'+hex('5'),SETUP='setup_'+hex('3'),PROPOSAL='prop_'+hex('4');
const NOW=Date.now(),iso=ms=>new Date(ms).toISOString().replace(/\.\d+Z$/,'Z');
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),
  role:{core:'Main chat',scout:'Repository exploration',lens:'Repository research',patch:'Code changes',rook:'Code review',pulse:'Test execution',lock:'Security review',quill:'Documentation drafts'}[id],
  description:`${id} reads and reports`,available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id[0].toUpperCase()+id.slice(1),default_goal:'Review the committed code.',
  engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const schedule={type:'daily',time:'09:00',timezone:'Asia/Kolkata',missed_policy:'coalesce_latest',dst_policy:'skip_gap_first_fold'};
const pip=(id,type,name,extra={})=>({id,workspace_id:W,pip_type:type,name,goal:`${name} looks after billing.py.`,source_ref:'HEAD',source_policy:{mode:'committed_only'},status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
// The audit has run once (its post in the chat: Report · 2 findings) and has a change waiting for you: a schedule.
const auditPip=(extra={})=>pip(AUDIT,'rook','Billing audit',{report_session:'chat-shop',report_chats:1,latest_run:{id:RUN,status:'succeeded'},pending_review_count:1,
  proposals:[{id:PROPOSAL,approval_status:'pending',expected_version:1,reason:'Run it every morning.',actor:'local-console',expires_at:iso(NOW+86400000),definition:{name:'Billing audit',goal:'Billing audit looks after billing.py.',source_ref:'HEAD',pip_type:'rook',schedule}}],...extra});
const planner={...pip(PLANNER,'lens','Planner'),workspace_id:PW,source_policy:{mode:'personal'}};
const setupCard={id:SETUP,digest:'a'.repeat(64),workspace_id:W,project_root:'/home/me/shop',pip_id:null,name:'Nightly review',goal:'Review the day’s changes to billing.py.',pip_type:'lock',work_kind:'source_review',
  source_ref:'HEAD',schedule:{...schedule,time:'22:00'},run_now:false,next_run_at:iso(NOW+3600000),status:'pending',created_at:iso(NOW-60000),expires_at:iso(NOW+3600000),receipt:null,
  reason:'You asked the DGC chat for a nightly review.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'committed_only',
  runner_notice:'A schedule runs only while the local Pips runner is enabled and running.',scope_notice:'This reviews source only.',run_now_policy:null};
const FOUND={run_id:RUN,pip_id:AUDIT,name:'Billing audit',pip_type:'rook',kind:'audit',trigger:'you',text:'x',outcome:'findings',posted_at:iso(NOW-2*3600000),finished_at:iso(NOW-2*3600000),
  total:2,counts:{high:2},findings:[{title:'invoice_total overwrites the subtotal',severity:'high',path:'billing.py',line:12},{title:'apply_discount divides by 10',severity:'high',path:'billing.py',line:20}]};
const auditRun=(id=RUN,status='succeeded')=>({id,pip_id:AUDIT,workspace_id:W,status,created_at:iso(NOW-2*3600000-60000),manifest:{run_kind:'audit',job_version:1,source_revision:'a'.repeat(40),trigger:'manual'},result:null});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({api=65,host,online=true,audit=auditPip(),runs=[auditRun()],setups=[setupCard]}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  const sent=[],answered=new Set(),listeners=new Set(),asks=[];
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
  w.eval(client);
  const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
  w.DgcPips.mount({root:shadow,...(host?{host}:{}),postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>undefined,setState(){},
    onAskDgc:a=>{asks.push(a);return true;},onSetupPrompt:()=>true});
  const message=data=>listeners.forEach(l=>l(data));
  const runner={runner_id:'runner',status:online?'running':'stopped',online,paused:false,counts:{queued:0,running:0,cancelling:0}};
  const pips={[PW]:[planner],[W]:[audit,pip(DOCS,'quill','Docs writer'),pip(PATCH,'patch','Fixer'),pip(TESTS,'pulse','Test runner'),pip(LIVE,'pulse','Shop status',{live_plan:{schema_version:1}})]};
  const all=()=>[...pips[PW],...pips[W]],byId=id=>all().find(p=>p.id===id);
  const reply=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'shop',kind:'git'}],current_workspace_id:W}),
    list_pip_types:()=>({types}),list_pip_setups:()=>({setups:r.workspace_id===W?setups:[]}),get_pip_setup:()=>({setup:setupCard}),get_pip_runner:()=>({runner}),
    list_pip_starters:()=>({starters:[{id:'daily_review',title:'Daily code review',summary:'Reviews the committed code every day.',scope:'project',params:['time','timezone']}]}),
    list_pips:()=>{const list=pips[r.workspace_id]||[];return {pips:list,total:list.length,next_offset:null};},
    get_pip:()=>byId(r.pip_id)?{pip:byId(r.pip_id)}:{error:{code:'not_found',message:'gone'}},
    list_pip_runs:()=>({runs:r.pip_id===AUDIT?runs:[]}),get_pip_run:()=>({run:{...(runs.find(x=>x.id===r.run_id)||auditRun(r.run_id)),result:{summary:'Two high findings.',findings:[],limitations:[]}}}),
    get_workspace_context:()=>({context:{workspace_id:r.workspace_id,revision:0,entries:[]}}),
    list_pip_models:()=>({default_model:'m',models:[{id:'m',name:'m'},{id:'glm',name:'GLM'}],connection:'configured'}),
    list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:byId(r.pip_id).workspace_id,messages:r.pip_id===AUDIT?[
      {id:'u1',pip_id:AUDIT,workspace_id:W,role:'user',text:'Is the discount one serious?',run_id:CHAT,status:'succeeded',model:'m',created_at:iso(NOW-3600000)},
      {id:'a1',pip_id:AUDIT,workspace_id:W,role:'assistant',text:'Yes.\n\nIt costs money.',run_id:CHAT,status:'succeeded',model:'m',created_at:iso(NOW-3590000)}]:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:r.pip_id,workspace_id:byId(r.pip_id).workspace_id,posts:r.pip_id===AUDIT?[FOUND]:[],next_before_id:null}),
    list_pip_run_fixes:()=>({pip_id:r.pip_id,workspace_id:byId(r.pip_id).workspace_id,fixes:[]}),list_pip_reply_stats:()=>({pip_id:r.pip_id,stats:[]}),
    list_pip_handoffs:()=>({pip_id:r.pip_id,workspace_id:W,handoffs:[],has_more:false,next_before_id:null}),
    list_pip_attention:()=>({as_of:iso(NOW),total:0,counts:{},by_pip:{},items:[],truncated:false}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
    list_pip_approvals:()=>({approvals:[],next_cursor:null}),list_pip_checkpoints:()=>({checkpoints:[],next_cursor:null}),
    run_pip:()=>({run:{...auditRun('run_'+hex('6'),'queued'),pip_id:r.pip_id}}),
    create_pip:()=>{const made={...pip(NEW,r.pip_type,r.name),goal:r.goal,source_ref:r.source_ref,model_choice:r.model_choice};pips[W].push(made);return {pip:made};},
    get_pip_digest:()=>undefined}[r.type]?.());
  async function drain(){for(let n=0;n<25;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=reply(m.request);if(result===undefined)continue;answered.add(m.id);if(result.error)message({type:'pipsReply',id:m.id,ok:false,error:result.error});else message({type:'pipsReply',id:m.id,ok:true,result});}}await flush();}
  message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true,folder:true});
  const $=s=>shadow.querySelector(s),$$=s=>[...shadow.querySelectorAll(s)];
  const click=async s=>{const el=$(s);assert.ok(el,'Missing '+s);el.click();await drain();};
  const type=async(s,value)=>{const el=$(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));el.dispatchEvent(new w.Event('input',{bubbles:true}));await drain();};
  async function tab(scope){if(!$(`[data-pips-tab="${scope}"]`))$('#simple-back')?.click();await drain();$(`[data-pips-tab="${scope}"]`)?.click();await drain();}
  async function open(id){await tab('project');await click(`[data-job="${id}"]`);}
  // As plain objects: each page is its own window, and its objects are that window's.
  const requests=t=>JSON.parse(JSON.stringify(sent.filter(m=>m.type==='pipsRequest'&&m.request.type===t).map(m=>m.request)));
  return {w,d:shadow,$,$$,sent,asks,drain,click,type,tab,open,requests};
}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim()||'';
const menu=x=>x.$$('.pip-topbar .pip-menu [data-tab]').map(b=>[b.dataset.tab,text(b)]);
const pill=x=>text(x.$('.pip-topbar .pip-pill>span:not(.avatar)'));
const pillSmall=x=>text(x.$('.pip-topbar .pip-pill small'));

test('a Project Pip gets the Personal Pips page: the paged list, then its top bar and menu; Personal’s own parts stay Personal’s',async()=>{
  const x=setup();await x.drain();const attention=x.requests('list_pip_attention').length;await x.tab('project');
  assert.ok(x.$('.pip-app-root').classList.contains('simple-pips'),'the simple page');
  assert.ok(x.$('.simple-home'),'the list');
  assert.deepEqual(x.$$('.pip-row').map(r=>r.dataset.job),[AUDIT,DOCS,PATCH,TESTS,LIVE]);
  assert.equal(text(x.$(`.pip-row[data-job="${AUDIT}"] small`)),'1 waiting for you');
  assert.ok(x.$('#simple-new'),'New Pip');
  assert.ok(x.$('#pip-search'),'the search over its Pips');
  assert.equal(x.requests('list_pips').at(-1).limit,100,'read a page at a time, as the Personal list is');
  assert.deepEqual(x.$$('.simple-home-head .pip-menu .tabs-menu button').map(text),['Workspace context','Notifications'],'the project’s own pages, in its menu');
  for(const old of ['aside','.layout','#new-pip','#back-pips','nav.tabs','.hero'])assert.equal(x.$(old),null,`no ${old}`);
  for(const personal of ['#pips-settings-open','.core-offer','.meet-core','.attention'])assert.equal(x.$(personal),null,`not the Personal ${personal}`);
  assert.equal(x.requests('list_pip_attention').length,attention,'its home doesn’t read the Personal Pips’ cards');
  await x.click(`[data-job="${AUDIT}"]`);
  assert.ok(x.$('.pip-topbar #simple-back'),'back to the list');
  assert.equal(pill(x),'Billing audit');
  assert.ok(x.$('.pip-topbar #pip-run-now'),'Run now');
  assert.ok(x.$('.pip-topbar .pip-menu'),'its menu');
  assert.equal(x.$('#pip-computer-open'),null,'a computer is a Personal Pip’s');
  assert.ok(x.$('.simple-content.chat .pip-conversation.chat-style'),'its chat');
  for(const old of ['nav.tabs','.hero','#back-pips','aside'])assert.equal(x.$(old),null,`no ${old}`);
  await x.click('#simple-back');
  assert.ok(x.$(`[data-job="${AUDIT}"]`),'back on the list');
});

test('every page a Project Pip had is in its menu: History, Settings, Schedule, Handoffs, Changes, Memory, Context, Notifications',async()=>{
  const x=setup();await x.drain();await x.open(AUDIT);
  assert.deepEqual(menu(x),[['runs','History'],['job','Settings'],['schedule','Schedule'],['handoffs','Handoffs'],['revisions','Changes'],['memory','Memory'],['context','Context'],['notifications','Notifications']]);
  const pages={runs:/History/,job:/What it does.*When it runs.*Model.*Pause or archive.*Advanced/,schedule:/Current schedule|Runs when you ask/,handoffs:/Handoffs/,revisions:/Change what it does.*Version history/,memory:/Pip memory/,context:/Workspace context/,notifications:/Notifications/};
  for(const [key,label] of menu(x)){
    await x.click(`.pip-topbar .pip-menu [data-tab="${key}"]`);
    assert.equal(x.$('.simple-content').dataset.view,key);
    assert.equal(pillSmall(x),label,'its name beside the Pip’s');
    assert.match(text(x.$('.simple-content')),pages[key],key);
    assert.deepEqual(menu(x).map(([k])=>k),['chat',...Object.keys(pages).filter(k=>k!==key)],'and the rest from there, with its chat');
  }
  await x.click('.pip-topbar .pip-menu [data-tab="job"]');
  for(const id of ['#setup-in-chat','#edit-goal','#toggle-pip','#archive-pip','#export-pip-file','#model-form'])assert.ok(x.$(id),`Settings keeps ${id}`);
  await x.click('#setup-in-chat');
  assert.equal(x.$('.simple-content').dataset.view,'create','Change in chat: the describe page');
  assert.match(x.$('#setupTask').value,/^Change the setup for Billing audit: /);
  await x.click('#create-back');
  assert.equal(x.$('.simple-content').dataset.view,'job','and back to its Settings');
  // The run's report, from its post in the chat and from History.
  await x.click('#simple-to-chat');
  x.$(`[data-run-post="${RUN}"] .run-post-report summary`).click();
  assert.equal(text(x.$(`[data-run-post="${RUN}"] .run-post-report summary`)),'Report · 2 findings');
  await x.click(`[data-run-post="${RUN}"] [data-post-open="${RUN}"]`);
  assert.equal(x.$('.simple-content').dataset.view,'runs');
  assert.equal(x.requests('get_pip_run').at(-1).run_id,RUN);
  assert.ok(x.$('section[aria-label="Run report"]'),'its report');
  const before=x.requests('get_pip_run').length;
  await x.click(`[data-run="${RUN}"]`);
  assert.equal(x.requests('get_pip_run').length,before+1,'from History’s row too');
  // Ask DGC to fix, from its post, as before.
  await x.click('#simple-to-chat');
  await x.click(`[data-post-fix="${RUN}"]`);
  assert.equal(x.asks.length,1);assert.equal(x.asks[0].session,'chat-shop');assert.equal(x.asks[0].report.run_id,RUN);
  // Each kind's menu is its old tabs: Quill takes no handoffs, Patch has no schedule, Pulse's is its plan.
  await x.open(DOCS);assert.ok(!menu(x).some(([k])=>k==='handoffs'));
  await x.open(PATCH);assert.ok(!menu(x).some(([k])=>k==='schedule'));assert.ok(menu(x).some(([k])=>k==='handoffs'));
  await x.open(TESTS);assert.deepEqual(menu(x).find(([k])=>k==='schedule'),['schedule','Plan & schedule']);
  // The project's own pages, from its home's menu.
  await x.click('#simple-back');
  for(const [id,view,title] of [['workspace-context','context',/Workspace context/],['workspace-notifications','notifications',/Notifications/]]){
    await x.click(`.simple-home-head .pip-menu #${id}`);
    assert.equal(x.$('.simple-content').dataset.view,view);
    assert.match(text(x.$('.simple-content')),title);
    assert.equal(x.$('.pip-topbar .pip-menu'),null,'no Pip is open under it');
    await x.click('#workspace-back');
    assert.ok(x.$('.simple-home'),'back to the list');
  }
  assert.equal(x.requests('list_pip_notifications').at(-1).workspace_id,W);
});

test('Run now is one click from a Project Pip’s page, and runs what History’s button runs',async()=>{
  const x=setup();await x.drain();await x.open(AUDIT);
  const run=x.$('.pip-topbar #pip-run-now');
  assert.equal(run.getAttribute('aria-label'),'Run audit');assert.equal(run.disabled,false);
  await x.click('#pip-run-now');
  assert.equal(x.$('.dialog'),null,'nothing to confirm: one click');
  const asked=x.requests('run_pip');
  assert.equal(asked.length,1);assert.equal(asked[0].pip_id,AUDIT);assert.match(asked[0].idempotency_key,/^editor-/);
  assert.equal(x.$('.simple-content').dataset.view,'chat','it stays in its chat');
  const labels=async id=>{await x.open(id);return x.$('#pip-run-now')?.getAttribute('aria-label')||null;};
  assert.equal(await labels(DOCS),'Create draft');
  assert.equal(await labels(LIVE),'Run now');
  assert.equal(await labels(PATCH),null,'Patch runs on a handoff you approve');
  assert.equal(await labels(TESTS),null,'a Pulse with no command plan has nothing to run');
  await x.open(LIVE);await x.click('#pip-run-now');
  assert.equal(x.requests('run_pip').at(-1).pip_id,LIVE);
  // Pips off: it says why instead of doing nothing.
  const off=setup({online:false});await off.drain();await off.open(AUDIT);
  assert.equal(off.$('#pip-run-now').disabled,true);assert.match(off.$('#pip-run-now').title,/Start Pips/);
  // A run going: Running…, which opens it in History.
  const going=setup({audit:auditPip({active_run:{id:GOING,status:'running',run_kind:'audit',created_at:iso(NOW)}}),runs:[auditRun(GOING,'running'),auditRun()]});await going.drain();await going.open(AUDIT);
  assert.equal(going.$('#pip-run-now'),null);
  assert.equal(text(going.$('.pip-topbar #pip-run-open')),'Running…');
  await going.click('#pip-run-open');
  assert.equal(going.$('.simple-content').dataset.view,'runs');
  assert.equal(going.requests('get_pip_run').at(-1).run_id,GOING);
});

test('a change waiting for you and new Pips waiting stay in sight on a Project Pip’s page and its list',async()=>{
  const x=setup();await x.drain();await x.tab('project');
  assert.match(text(x.$('.setup-inbox-toggle')),/1 new Pip waiting for you/,'the setup card on the list');
  await x.click(`[data-job="${AUDIT}"]`);
  const card=x.$('.conversation-log .chat-setup-review');
  assert.match(text(card),/When it runs: Daily at 09:00 · Asia\/Kolkata/,'the change, in its chat');
  assert.ok(card.querySelector(`[data-proposal="${PROPOSAL}"]`)&&card.querySelector(`[data-reject="${PROPOSAL}"]`),'with Review and Reject');
  assert.equal(text(x.$('.pip-setup-strip')),'1 new Pip waiting for you','new Pips waiting, under its top bar');
  await x.click('.pip-topbar .pip-menu [data-tab="runs"]');
  assert.equal(text(x.$('.waiting h3')),'A change is waiting for you','above its other pages too');
  assert.ok(x.$('.pip-setup-strip'),'and the strip stays');
  await x.click(`.waiting [data-proposal="${PROPOSAL}"]`);
  assert.ok(x.$('.dialog'),'Review opens it');
  await x.click('#review-cancel');
  await x.click('#chat-review-setups');
  assert.ok(x.$('.simple-home'),'the strip goes to the list');
  assert.equal(x.$('[data-details="setup-inbox"]').open,true,'with the setup cards open');
  await x.click(`[data-setup="${SETUP}"]`);
  assert.equal(x.requests('get_pip_setup').at(-1).setup_id,SETUP);
  assert.match(text(x.$('.dialog h2')),/Create Nightly review\?/);
});

// The old form, on the old page (a DGC from before Pips API 51), and the character picker: the same create_pip.
async function oldForm(kind,{name,goal,ref,model}){
  const x=setup({api:50});await x.drain();await x.tab('project');
  await x.click('#new-pip');await x.click('#advanced-create');await x.click(`[data-pip-type="${kind}"]`);
  await x.type('#name',name);await x.type('#goal',goal);await x.type('#source_ref',ref);await x.type('#createModel',model);
  x.$('#create-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await x.drain();
  return x;
}
async function newFlow(kind,{name,goal,ref,model}){
  const x=setup();await x.drain();await x.tab('project');
  await x.click('#simple-new');
  assert.ok(x.$('.dialog .character-grid'),'the character picker');
  await x.click(`.dialog [data-new-character="${kind}"]`);
  assert.equal(x.$(`.dialog [data-new-character="${kind}"]`).getAttribute('aria-checked'),'true');
  await x.type('#name',name);await x.type('#goal',goal);await x.type('#source_ref',ref);await x.type('#createModel',model);
  await x.click('#review-confirm');
  return x;
}
test('a new Project Pip made with the character picker is the Pip the old form made',async()=>{
  const choices={name:'GST audit',goal:'Find where GST is added twice.',ref:'main',model:'model:glm'};
  const old=await oldForm('rook',choices),made=await newFlow('rook',choices);
  const a=old.requests('create_pip'),b=made.requests('create_pip');
  assert.equal(a.length,1);assert.equal(b.length,1);
  assert.deepEqual(b[0],a[0],'the same request');
  assert.deepEqual(b[0],{type:'create_pip',workspace_id:W,pip_type:'rook',model_choice:{mode:'model',model:'glm'},name:'GST audit',goal:'Find where GST is added twice.',source_ref:'main'});
  assert.equal(made.requests('introduce_pip').length,0,'no hello: the old form sent none');
  assert.equal(pill(made),'GST audit','and its page opens');
  // Patch and Pulse say what they can do first, word for word as before, then make the same Pip.
  for(const kind of ['patch','pulse']){
    const o=await oldForm(kind,{...choices,model:'default'}),n=await newFlow(kind,{...choices,model:'default'});
    const words=x=>[text(x.$('.dialog h2')),...[...x.$('.dialog').querySelectorAll('h3, p, dl')].map(text)];
    assert.deepEqual(words(n),words(o),`${kind}: the same review`);
    assert.ok(n.$('.dialog #new-pip-back'),'with Back to the picker');
    await o.click('#review-confirm');await n.click('#review-confirm');
    assert.deepEqual(n.requests('create_pip'),o.requests('create_pip'),`${kind}: the same Pip`);
  }
  // A blank job is refused in words, as the old form refused it.
  const blank=await newFlow('lens',{name:'Docs check',goal:' ',ref:'HEAD',model:'default'});
  assert.equal(blank.requests('create_pip').length,0);
  assert.match(text(blank.$('.dialog [role=alert], .dialog .error')),/Give it a name, say what it does, and choose a branch or commit\./);
});

test('describing the job to DGC, a common job and a shared Pip’s file stay one click from New Pip',async()=>{
  const x=setup();await x.drain();await x.tab('project');
  await x.click('#simple-new');
  assert.ok(x.$('.dialog #import-pip-file'),'Import a shared Pip…');
  await x.click('#new-pip-describe');
  assert.equal(x.$('.dialog'),null);
  assert.equal(x.$('.simple-content').dataset.view,'create');
  assert.equal(text(x.$('.pip-topbar .pip-pill')),'New Pip');
  assert.ok(x.$('#setup-prompt-form #setupTask'),'describe the job to DGC');
  assert.ok(x.$('[data-starter="daily_review"]'),'a common job');
  assert.ok(x.$('#import-pip-file'),'a shared Pip’s file');
  await x.click('#advanced-create');
  assert.ok(x.$('.dialog .character-grid'),'Choose a Pip myself: the picker again');
  await x.click('#review-cancel');
  await x.click('#simple-new');await x.click('#new-pip-describe');await x.click('#create-back');
  assert.ok(x.$('.simple-home'),'back goes to the list');
});

test('a remote view and a DGC from before Pips API 51 keep the old Project page; from 51 a project has the simple one',async()=>{
  const now=setup({api:51});await now.drain();await now.tab('project');
  assert.ok(now.$('.pip-app-root').classList.contains('simple-pips'),'API 51: the simple page');
  const older=setup({api:50});await older.drain();
  assert.ok(older.$('.pip-app-root').classList.contains('simple-pips'),'the Personal tab is simple from API 43, as before');
  await older.tab('project');
  assert.ok(!older.$('.pip-app-root').classList.contains('simple-pips'),'API 50: the old Project page');
  assert.ok(older.$('aside #new-pip'));
  await older.click(`[data-job="${AUDIT}"]`);
  assert.deepEqual(older.$$('nav.tabs [data-tab]').map(b=>b.dataset.tab).slice(0,3),['chat','runs','job']);
  assert.ok(older.$('.hero')&&older.$('#back-pips'));
  const remote=setup({host:'remote'});await remote.drain();
  assert.ok(!remote.$('.pip-app-root').classList.contains('simple-pips'),'a remote view: the old page');
  await remote.click(`[data-job="${AUDIT}"]`);
  assert.ok(remote.$('nav.tabs [data-tab="runs"]')&&remote.$('.hero'));
  assert.equal(remote.$('#pip-run-now'),null);
});
