import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
// Chromium the way the other layout tests start it: a machine without it skips (GitHub's release job installs
// none, and a launch here failed the 0.48.2 release), and DGC_REQUIRE_CHROMIUM=1 makes that a failure.
async function launchOrSkip(t){try{return await chromium.launch({args:['--headless=new','--no-sandbox']});}catch(error){if(process.env.DGC_REQUIRE_CHROMIUM==='1')throw error;t.skip('Chromium could not start: '+String(error?.message||error).split('\n')[0]);return null;}}
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const model=load(await bundle('pipsModel.js')),viewCode=await bundle('pipsView.ts');
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const workspace={id:'ws_'+ '1'.repeat(32),name:'Project'},pipId='pip_'+'2'.repeat(32),setupId='setup_'+'3'.repeat(32),runId='run_'+'4'.repeat(32);
const fixture=(extra={})=>({id:setupId,digest:'a'.repeat(64),workspace_id:workspace.id,project_root:'/review/project',pip_id:null,name:'Daily review',goal:'Review the committed code.',pip_type:'rook',work_kind:'source_review',source_ref:'HEAD',schedule:{type:'daily',time:'11:00',timezone:'Asia/Kolkata',missed_policy:'coalesce_latest',dst_policy:'skip_gap_first_fold'},run_now:true,next_run_at:'2099-10-03T05:30:00Z',status:'pending',created_at:'2099-10-02T04:00:00Z',expires_at:'2099-10-02T06:00:00Z',receipt:null,reason:'Review code daily.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'committed_only',runner_notice:'A schedule runs only while the local Pips runner is enabled and running. Saving setup does not start or resume the runner.',scope_notice:'This reviews source only. It does not test the running app.',run_now_policy:"The immediate run counts as today's occurrence; the next daily run is tomorrow.",...extra});
const accepted=s=>({...s,status:'accepted',receipt:{setup_id:s.id,pip_id:s.pip_id||pipId,job_version:1,run_id:s.run_now?runId:null,next_run_at:s.next_run_at,accepted:true,actor:'editor-user',resolved_at:'2099-10-02T04:01:00Z'}});
const rejected=s=>({...s,status:'rejected',receipt:{setup_id:s.id,pip_id:s.pip_id,job_version:s.expected_version,run_id:null,next_run_at:null,accepted:false,actor:'editor-user',resolved_at:'2099-10-02T04:01:00Z'}});
const job=()=>({id:pipId,workspace_id:workspace.id,pip_type:'rook',name:'Daily review',goal:'Review the committed code.',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:1,policy:'read_only',trigger:'manual',proposals:[]});
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id,role:id,description:'Read committed source',available:['rook','scout','lens','lock'].includes(id),unavailable_reason:['rook','scout','lens','lock'].includes(id)?null:'Not available',default_name:id,default_goal:'Read source',engine:['rook','scout','lens','lock'].includes(id)?'source_audit':null}));
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
function setup({api=23,proposal=fixture(),callback=()=>true,host='editor',jobs=[],personal=false}={}){
 const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let listener,interval;
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.setInterval=fn=>{interval=fn;return 1;};w.eval(client);
 const instance=w.DgcPips.mount({root:w.document,host,postMessage:m=>sent.push(m),onMessage:fn=>{listener=fn;},onSetupPrompt:callback});
 const answer=(m,result,ok=true)=>{answered.add(m.id);listener({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[personal?{...workspace,kind:'personal'}:workspace],current_workspace_id:workspace.id}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:proposal?[proposal]:[]}),get_pip_setup:()=>({setup:proposal}),list_pips:()=>({pips:jobs}),get_pip_runner:()=>({runner:{runner_id:'r',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}}}),get_workspace_context:()=>({context:{workspace_id:workspace.id,revision:0,entries:[]}}),get_pip:()=>({pip:jobs.find(p=>p.id===r.pip_id)}),list_pip_runs:()=>({runs:[]}),list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:workspace.id,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0}),list_pip_models:()=>({default_model:'local-model',models:[],connection:'configured'})}[r.type]?.());
 async function drain(overrides={}){for(let n=0;n<15;n++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answer(m,result);count++;}}if(!count)break;}await flush();}
 listener({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 return {w,d:w.document,instance,sent,answer,requests,drain,message:m=>listener(m),poll:()=>interval(),click:selector=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.click();},input:(selector,value)=>{const el=w.document.querySelector(selector);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));},submit:selector=>w.document.querySelector(selector).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}))};
}

test('setup validation refuses scope confusion, privilege widening, stale identities and malformed schedules',()=>{
 const s=fixture();assert.equal(model.pipSetup(s,workspace.id),s);assert.equal(model.pipSetups({setups:[s]},workspace.id).length,1);
 for(const change of [{workspace_id:'another'},{id:'bad'},{digest:'f'.repeat(63)},{source_policy:'current_tree'},{permissions:'write'},{pip_type:'patch'},{goal:7},{extra:'new authority'},{project_root:'relative/path'},{schedule:{...s.schedule,timezone:'No/SuchZone'}},{schedule:{...s.schedule,time:'25:00'}},{run_now:1},{next_run_at:null},{receipt:{}}])assert.throws(()=>model.pipSetup({...s,...change},workspace.id));
 assert.throws(()=>model.pipSetups({setups:[s,s]},workspace.id));assert.throws(()=>model.pipSetups({setups:[{...s,status:'expired'}]},workspace.id));
 assert.equal(model.pipSetup(accepted(s),workspace.id).receipt.run_id,runId);assert.equal(model.pipSetup(rejected(s),workspace.id).status,'rejected');
 for(const change of [{run_id:null},{setup_id:'wrong'},{accepted:false},{next_run_at:null},{pip_id:null}])assert.throws(()=>model.pipSetup({...accepted(s),receipt:{...accepted(s).receipt,...change}},workspace.id));
});

test('old backends retain Advanced creation and receive no setup commands',async()=>{const x=setup({api:22});await x.drain();assert.equal(x.requests('list_pip_setups').length,0);x.click('#new-pip');assert.ok(x.d.querySelector('.type-picker'));assert.equal(x.d.querySelector('#setup-prompt-form'),null);});

test('New starts conversationally and transfers only an unsent project-bound prompt',async()=>{const prompts=[],x=setup({callback:p=>{prompts.push(p);return true;}});await x.drain();x.click('#new-pip');assert.ok(x.d.querySelector('#setup-prompt-form'));x.input('#setupTask','Review each day at 11:00 Asia/Kolkata, including today.');x.submit('#setup-prompt-form');await flush();assert.equal(prompts.length,1);assert.match(prompts[0],/set up a Pip for \"Project\"/);assert.match(prompts[0],/do not activate or run it yet/);assert.doesNotMatch(prompts[0],/workspace_id|request_key|pips_setup/);assert.match(prompts[0],/Review each day at 11:00 Asia\/Kolkata, including today/);assert.equal(x.requests('create_pip').length,0);assert.equal(x.requests('accept_pip_setup').length,0);assert.equal(x.requests('send_pip_message').length,0);});

test('a populated main composer refusal preserves the setup task for retry',async()=>{const x=setup({callback:()=> 'The main chat already has a draft.'});await x.drain();x.click('#new-pip');x.input('#setupTask','Keep this request.');x.submit('#setup-prompt-form');assert.equal(x.d.querySelector('#setupTask').value,'Keep this request.');assert.match(x.d.body.textContent,/already has a draft/);assert.equal(x.requests('create_pip').length,0);x.click('#advanced-create');assert.ok(x.d.querySelector('.type-picker'));});

test('Remote and callbackless views explain local setup without dispatching plaintext or controls',async()=>{for(const options of [{host:'remote'},{callback:undefined}]){const x=setup(options.callback===undefined&&!options.host?{callback:null}:options);await x.drain();x.click('#new-pip');assert.match(x.d.body.textContent,/DGC chat on your computer/);assert.equal(x.d.querySelector('#setup-prompt-form button[type=submit]'),null);}});

test('one clear review reads a fresh immutable proposal and requires explicit confirmation',async()=>{const s=fixture({name:'<img src=x>',goal:'<script>alert(1)</script>'}),x=setup({proposal:s});await x.drain();assert.equal(x.d.querySelectorAll('img,script').length,0);x.click('[data-setup]');await x.drain();const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog);for(const value of ['/review/project','11:00','Asia/Kolkata','2099','Yes, once you accept','check the running app','today’s occurrence'.replace('’',"'")])assert.ok(dialog.textContent.includes(value),value);assert.equal(x.d.querySelector('#review-confirm').textContent,'Create and run once');assert.equal(x.requests('accept_pip_setup').length,0);x.click('#review-confirm');assert.deepEqual(JSON.parse(JSON.stringify(x.requests('accept_pip_setup')[0].request)),{type:'accept_pip_setup',setup_id:s.id,expected_digest:s.digest});});

test('scheduled-only setup has Create Pip and cancellation makes no mutation',async()=>{const s=fixture({run_now:false,run_now_policy:null}),x=setup({proposal:s});await x.drain();x.click('[data-setup]');await x.drain();assert.equal(x.d.querySelector('#review-confirm').textContent,'Create Pip');x.click('#review-cancel');assert.equal(x.requests('accept_pip_setup').length,0);assert.equal(x.d.querySelector('[role=dialog]'),null);});

test('changed or unrelated get response cannot open a review',async()=>{const x=setup();await x.drain();x.click('[data-setup]');await x.drain({get_pip_setup:()=>({setup:fixture({digest:'b'.repeat(64)})})});assert.equal(x.d.querySelector('[role=dialog]'),null);assert.match(x.d.body.textContent,/changed or answered somewhere else/);assert.equal(x.requests('accept_pip_setup').length,0);});

test('disconnect discards a late setup review and a late acceptance receipt',async()=>{const x=setup();await x.drain();x.click('[data-setup]');await x.drain();x.click('#review-confirm');const request=x.requests('accept_pip_setup')[0];x.message({type:'pipsConnection',generation:2,connected:false,supported:true,enabled:true,apiVersion:23});x.answer(request,{setup:accepted(fixture())});await flush();assert.equal(x.d.querySelector('[role=dialog]'),null);assert.doesNotMatch(x.d.body.textContent,/Daily review is on/);assert.equal(x.requests('get_pip').length,0);});

test('successful acceptance navigates to the receipt Pip and reports queued rather than completed',async()=>{const jobs=[],s=fixture(),x=setup({proposal:s,jobs});await x.drain();x.click('[data-setup]');await x.drain();x.click('#review-confirm');jobs.push(job());x.answer(x.requests('accept_pip_setup')[0],{setup:accepted(s)});await x.drain({list_pip_setups:()=>({setups:[]})});assert.ok(x.d.querySelector('[data-job][aria-current=true]'));assert.match(x.d.body.textContent,/starting its first run/);assert.match(x.d.body.textContent,/doesn’t test the running app/);assert.equal(x.requests('run_pip').length,0);});

test('false receipt cannot acknowledge success or select an unrelated Pip',async()=>{const s=fixture(),x=setup();await x.drain();x.click('[data-setup]');await x.drain();x.click('#review-confirm');x.answer(x.requests('accept_pip_setup')[0],{setup:{...accepted(s),goal:'Changed after approval'}});await flush();assert.match(x.d.querySelector('[role=dialog]').textContent,/differs from the proposal/);assert.equal(x.requests('get_pip').length,0);assert.doesNotMatch(x.d.body.textContent,/Daily review is on/);});

test('reject is reviewed and sends only the proposal identity and expected digest',async()=>{const s=fixture(),x=setup();await x.drain();x.click('[data-reject-setup]');await x.drain();assert.equal(x.requests('reject_pip_setup').length,0);x.click('#review-confirm');const request=x.requests('reject_pip_setup')[0];assert.deepEqual(JSON.parse(JSON.stringify(request.request)),{type:'reject_pip_setup',setup_id:s.id,expected_digest:s.digest});x.answer(request,{setup:rejected(s)});await x.drain({list_pip_setups:()=>({setups:[]})});assert.match(x.d.body.textContent,/Nothing was created or changed/);assert.equal(x.requests('get_pip').length,0);});

test('expired proposal renders a disabled confirm and cannot dispatch acceptance',async()=>{const x=setup({proposal:fixture({created_at:'2020-01-01T00:00:00Z',expires_at:'2020-01-02T00:00:00Z'})});await x.drain();x.click('[data-setup]');await x.drain();assert.equal(x.d.querySelector('#review-confirm').disabled,true);x.click('#review-confirm');assert.equal(x.requests('accept_pip_setup').length,0);});

test('extension host independently gates all setup controls at API23',()=>{for(const api of [22,23]){const posted=[],sent=[],vscode={};const {PipsEditor}=load(viewCode,name=>name==='vscode'?vscode:require(name));const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});for(const type of ['list_pip_setups','get_pip_setup','accept_pip_setup','reject_pip_setup'])bridge.receive({type:'pipsRequest',id:type,request:{type,setup_id:setupId,expected_digest:'a'.repeat(64)}});assert.equal(sent.length,api===23?4:0);if(api===22)assert.match(posted.at(-1).error.message,/new-Pip cards in the chat/);}});

test('main-chat draft callback preserves populated drafts and does not autosend',()=>{const main=readFileSync(new URL('../media/main.js',import.meta.url),'utf8'),body=main.match(/onSetupPrompt:prompt => \{([\s\S]*?)\n        \},/)[1];const calls=[],input={value:'',pill:null,querySelector(){return this.pill;},focus(){calls.push('focus');}},attachments=[];let pendingImageFiles=0,pendingImageBytes=0;const callback=()=>new Function('prompt','input','attachments','pendingImageFiles','pendingImageBytes','setComposerText','onInput','persistDraft','closePips','composerText','setComposerRange',body)('Draft only',input,attachments,pendingImageFiles,pendingImageBytes,text=>{calls.push('text');input.value=text;},()=>calls.push('input'),()=>calls.push('persist'),()=>calls.push('close'),()=>input.value,()=>calls.push('caret'));
 input.value='Existing draft';assert.match(callback(),/already has a draft/);assert.equal(input.value,'Existing draft');assert.equal(calls.length,0);input.value='';attachments.push({path:'source'});assert.match(callback(),/already has a draft/);attachments.length=0;pendingImageFiles=1;assert.match(callback(),/already has a draft/);pendingImageFiles=0;input.pill={};assert.match(callback(),/already has a draft/);input.pill=null;assert.equal(callback(),true);assert.equal(input.value,'Draft only');assert.deepEqual(calls,['text','input','persist','close','caret','focus']);assert.doesNotMatch(body,/postMessage|sendPrompt|\.submit\(/);});


test('existing Pip setup starts with its scoped identity and accepts initial lifecycle revision zero',async()=>{
 const p=job(),s=fixture({pip_id:p.id,expected_version:1,expected_lifecycle_revision:0}),prompts=[];
 assert.equal(model.pipSetup(s,workspace.id).expected_lifecycle_revision,0);
 const resolved=accepted(s);resolved.receipt.job_version=2;assert.equal(model.pipSetupResolution(resolved,s,true).receipt.job_version,2);
 assert.throws(()=>model.pipSetup({...resolved,receipt:{...resolved.receipt,job_version:3}},workspace.id));
 const x=setup({proposal:null,jobs:[p],callback:prompt=>{prompts.push(prompt);return true;}});await x.drain();x.click('[data-job]');await x.drain();x.click('[data-tab=job]');await x.drain();x.click('#setup-in-chat');x.input('#setupTask','Move the review to noon.');x.submit('#setup-prompt-form');assert.equal(prompts.length,1);assert.match(prompts[0],new RegExp(p.id));assert.match(prompts[0],/change the setup for \"Daily review\" in \"Project\"/);assert.match(prompts[0],/job v1 · lifecycle v1/);assert.match(prompts[0],/do not activate or run it yet/);assert.equal(x.requests('propose_pip_update').length,0);
});

test('proposal receipt matching is independent of JSON key ordering and validates full scope',()=>{
 const s=fixture(),r=accepted(s),reordered=Object.fromEntries(Object.entries(r).reverse());reordered.schedule=Object.fromEntries(Object.entries(r.schedule).reverse());assert.equal(model.pipSetupResolution(reordered,s,true).status,'accepted');
 for(const changes of [{project_root:'/other/project'},{source_ref:'other-branch'},{run_now_policy:'Different immediate occurrence meaning.'}])assert.throws(()=>model.pipSetupResolution({...r,...changes},s,true));
 assert.equal(model.pipSetup(fixture({project_root:'C:\\work\\repo'}),workspace.id).source_ref,'HEAD');
 assert.equal(model.pipSetup(fixture({project_root:'\\\\server\\share'}),workspace.id).source_ref,'HEAD');
 assert.throws(()=>model.pipSetup(fixture({name:'invalid\ud800'}),workspace.id));
});

test('changing selected Pip while setup details load discards the obsolete response',async()=>{
 const x=setup({jobs:[job()]});await x.drain();x.click('[data-setup]');const pending=x.requests('get_pip_setup')[0];x.click('[data-job]');await x.drain({get_pip_setup:()=>undefined});x.answer(pending,{setup:fixture()});await flush();assert.equal(x.d.querySelector('[role=dialog]'),null);assert.equal(x.requests('accept_pip_setup').length,0);
});


test('setup inbox and New stay visible at 300px without showing the duplicate detail pane',async(t)=>{
 const browser=await launchOrSkip(t);if(!browser)return;
 try{
  const page=await browser.newPage({viewport:{width:300,height:900}});
  await page.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<div id="host" style="width:100%;height:900px"></div>'}):route.abort());
  await page.goto('https://pips-layout.invalid/'); // Entirely fulfilled above; no network or server.
  await page.addScriptTag({content:client});
  const css=['pips.css','pipsTranscript.css'].map(file=>readFileSync(new URL('../src/'+file,import.meta.url),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
  await page.evaluate(({css,workspace,types,proposal,pip})=>{
   // This layout fixture drives data explicitly rather than racing a wall clock.
   window.setInterval=()=>1;
   HTMLCanvasElement.prototype.getContext=()=>null;
   let receive;const root=document.querySelector('#host').attachShadow({mode:'open'});
   const respond=request=>({list_workspaces:{workspaces:[workspace],current_workspace_id:workspace.id},list_pip_types:{types},list_pip_setups:{setups:[proposal]},list_pips:{pips:[pip]},get_pip_runner:{runner:{runner_id:'r',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}}},get_workspace_context:{context:{workspace_id:workspace.id,revision:0,entries:[]}},list_pip_models:{default_model:'model',models:[],connection:'configured'}}[request.type]);
   window.DgcPips.mount({root,stylesheetText:css,onSetupPrompt:()=>true,onMessage:listener=>{receive=listener;},postMessage:message=>{queueMicrotask(()=>{if(message.type==='pipsReady')receive({type:'pipsConnection',apiVersion:23,generation:1,connected:true,supported:true,enabled:true});else if(message.type==='pipsRequest'){const result=respond(message.request);if(result!==undefined)receive({type:'pipsReply',id:message.id,ok:true,result});}});}});
  },{css,workspace,types,proposal:fixture(),pip:job()});
  const review=page.getByRole('button',{name:'Review…',exact:true}),create=page.getByRole('button',{name:'New Pip',exact:true});
  await page.locator('.setup-inbox-toggle').click();await review.waitFor({state:'visible'});assert.equal(await create.isVisible(),true);assert.equal(await page.locator('.layout.overview>.content').isVisible(),false);assert.equal(await page.locator('.setup-inbox').count(),1);
  const bounds=await review.boundingBox();assert.ok(bounds.width>0&&bounds.x>=0&&bounds.x+bounds.width<=300);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1000,height:900});assert.equal(await review.isVisible(),true);assert.equal(await page.locator('.setup-inbox').count(),1);assert.equal(await page.locator('.layout.overview>.content').isVisible(),false);
  await page.setViewportSize({width:300,height:900});await create.click();await page.getByRole('heading',{name:'What should your Pip look after?'}).waitFor({state:'visible'});assert.equal(await page.locator('#setupTask').isVisible(),true);assert.equal(await page.getByRole('button',{name:'Describe to DGC',exact:true}).isVisible(),true);assert.equal(await page.locator('.setup-inbox').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser.close();}
});

test('Pulse setup validates exact network scope and rejects a swapped HTTP plan',()=>{
 const plan={schema_version:1,action:{kind:'test',network:'loopback_http_v1',tests:[{argv:['dgc-http-check','http://127.0.0.1:3090/healthz','200'],cwd:'.'}],limits:{wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32}}};
 const s=fixture({pip_type:'pulse',work_kind:'app_smoke_test',permissions:'review_required',verification_plan:plan});
 assert.equal(model.pipSetup(s,workspace.id),s);
 for(const url of ['http://example.com:3090/','http://127.0.0.1:3090/?token=abc','http://127.0.0.1:80/']){
  const bad=structuredClone(s);bad.verification_plan.action.tests[0].argv[1]=url;assert.throws(()=>model.pipSetup(bad,workspace.id));
 }
 const changed=accepted(structuredClone(s));changed.verification_plan.action.tests[0].argv[1]='http://127.0.0.1:3090/login';assert.throws(()=>model.pipSetupResolution(changed,s,true));
 assert.throws(()=>model.pipSetup({...s,pip_type:'rook',work_kind:'source_review',permissions:'read_only'},workspace.id));
});

test('accepted Pulse creation review remains readable without permitting pending version-zero approval',()=>{
 const approval={id:'approval_x',proposal_id:'proposal_x',pip_id:pipId,expected_version:0,action_type:'job_update',action_summary:'Create Pulse',requested_by:'core_setup',status:'approved',created_at:'2099-01-01T00:00:00Z',expires_at:'2099-01-08T00:00:00Z',resolved_at:'2099-01-01T00:00:00Z',resolved_by:'local-user'};
 assert.equal(model.approvalsPage({approvals:[approval],next_before_id:null},pipId).approvals.length,1);
 assert.throws(()=>model.approvalsPage({approvals:[{...approval,status:'pending'}],next_before_id:null},pipId));
});


test('personal setup stays cross-project and describes no implicit project or app access',async()=>{
 const prompts=[],x=setup({api:28,personal:true,proposal:null,callback:p=>{prompts.push(p);return true;}});
 await x.drain();x.click('#new-pip');
 assert.match(x.d.body.textContent,/What would you like a hand with/);
 assert.doesNotMatch(x.d.querySelector('.setup-compose').textContent,/committed changes/);
 x.input('#setupTask','Help plan my week');x.submit('#setup-prompt-form');
 assert.match(prompts[0],/scope personal/);assert.match(prompts[0],/Do not grant project files/);
 assert.equal(x.requests('create_pip').length,0);
});

test('personal app permissions require a readable bounded grant on the review',()=>{
 const plan={schema_version:1,server:'composio',connection_digest:'a'.repeat(64),calls:[{tool:'GMAIL_FETCH_EMAILS',schema_digest:'b'.repeat(64),account:'ca_offline',arguments:{max_results:5}}]};
 const s=fixture({source_policy:'personal',work_kind:'personal_task',app_plan:plan});
 assert.equal(model.pipSetup(s,workspace.id),s);
 assert.equal(model.executionPip({pip_type:'pulse',source_policy:{mode:'personal'}}),false);
 assert.throws(()=>model.pipSetup({...s,source_policy:'committed_only',work_kind:'source_review'},workspace.id));
 assert.throws(()=>model.pipSetup({...s,app_plan:{...plan,calls:[{...plan.calls[0],tool:'GMAIL_SEND_EMAIL'}]}},workspace.id));
 assert.throws(()=>model.pipSetup({...s,app_plan:{...plan,calls:[{...plan.calls[0],account:'default'}]}},workspace.id));
});

// Starter Pips (Pips API 41): fixed jobs that become ordinary setup cards, plus the commit trigger they can carry.
const trigger={events:['commit_changed'],minimum_minutes:5,missed_policy:'coalesce_latest'};
const commitCard=(extra={})=>fixture({name:'Commit reviewer',source_ref:'main',schedule:null,next_run_at:null,run_now:false,run_now_policy:null,event_trigger:trigger,runner_notice:'DGC checks main for new local commits only while the local Pips runner is enabled and running, and reviews at most every 5 minutes. Saving setup does not start or resume the runner.',...extra});
const starterList=[{id:'commit_review',title:'Review each commit',summary:'Rook reviews the committed source after each new commit.',pip_type:'rook',scope:'project',name:'Commit reviewer',when:'commit',default_time:null,params:['branch']},{id:'nightly_security',title:'Nightly security review',summary:'Lock reviews every night.',pip_type:'lock',scope:'project',name:'Nightly security review',when:'daily',default_time:'02:00',params:['branch','time','timezone']},{id:'morning_brief',title:'Morning brief',summary:'A Personal Pip writes a brief.',pip_type:'lens',scope:'personal',name:'Morning brief',when:'weekdays',default_time:'07:30',params:['time','timezone','web_reads']}];

test('a commit trigger is a reviewed setup field only for a new project reviewer with no schedule',()=>{
 const s=commitCard();assert.equal(model.pipSetup(s,workspace.id),s);
 for(const change of [{schedule:fixture().schedule,next_run_at:'2099-10-03T05:30:00Z'},{event_trigger:{...trigger,events:['session_turn_completed']}},{event_trigger:{...trigger,minimum_minutes:1}},{event_trigger:{...trigger,commit_paths:['src/']}},{event_trigger:'commit'},{source_policy:'personal'},{pip_id:pipId,expected_version:1,expected_lifecycle_revision:1}])assert.throws(()=>model.pipSetup({...s,...change},workspace.id),JSON.stringify(change));
});

test('starters appear at API 41 only and a chosen starter becomes a setup card opened for review',async()=>{
 const old=setup({api:40,proposal:null});await old.drain();old.click('#new-pip');await old.drain();assert.equal(old.requests('list_pip_starters').length,0);assert.equal(old.d.querySelector('[data-starter]'),null);
 const x=setup({api:41,proposal:null});await x.drain({list_pip_starters:()=>({starters:starterList})});x.click('#new-pip');await x.drain({list_pip_starters:()=>({starters:starterList})});
 assert.deepEqual([...x.d.querySelectorAll('[data-starter]')].map(b=>b.dataset.starter),['commit_review','nightly_security'],'project starters only in a project');
 x.click('[data-starter=commit_review]');assert.ok(x.d.querySelector('#starter-branch'));assert.equal(x.d.querySelector('#starter-time'),null);
 x.input('#starter-branch','main');x.click('#review-confirm');
 const request=x.requests('propose_starter_pip')[0];assert.deepEqual(JSON.parse(JSON.stringify(request.request)),{type:'propose_starter_pip',starter:'commit_review',params:{branch:'main'}});
 assert.equal(x.requests('create_pip').length+x.requests('accept_pip_setup').length,0,'a starter creates nothing');
 const card=commitCard();x.answer(request,{setup:card});await x.drain({get_pip_setup:()=>({setup:card}),list_pip_setups:()=>({setups:[card]})});
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog,'the card opens straight into its review');assert.match(dialog.textContent,/After each new commit to main, at most every 5 minutes/);assert.equal(x.requests('accept_pip_setup').length,0);
});

test('extension host gates starter commands at API 41',()=>{for(const api of [40,41]){const posted=[],sent=[],vscode={};const {PipsEditor}=load(viewCode,name=>name==='vscode'?vscode:require(name));const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});bridge.receive({type:'pipsRequest',id:'l',request:{type:'list_pip_starters'}});bridge.receive({type:'pipsRequest',id:'p',request:{type:'propose_starter_pip',starter:'commit_review',params:{}}});assert.equal(sent.length,api===41?2:0);if(api===40)assert.match(posted.at(-1).error.message,/Update DGC for starter Pips/);}});

// Notifications and finding outcomes (Pips API 41): the user's own setting, saved without a job review.
test('an audit Pip saves its notification threshold directly and shows what became of its findings',async()=>{
 const p=job(),settings={pip_id:p.id,min_severity:'medium',alert_severity:'high',revision:0,is_default:true};
 const outcomes={pip_id:p.id,name:p.name,pip_type:'rook',history_truncated:false,reported:4,accepted:2,dismissed:1,still_reported:1,gone_after_change:2,gone_without_change:1,checkpoints_examined:6};
 const reads={get_pip_notify_settings:()=>({settings}),get_pip_outcomes:()=>({outcomes})};
 const old=setup({api:40,proposal:null,jobs:[p]});await old.drain();old.click('[data-job]');await old.drain();old.click('[data-tab=job]');await old.drain();
 assert.equal(old.d.querySelector('#notify-form'),null);assert.equal(old.requests('get_pip_notify_settings').length,0);
 const x=setup({api:41,proposal:null,jobs:[p]});await x.drain(reads);x.click('[data-job]');await x.drain(reads);x.click('[data-tab=job]');await x.drain(reads);
 assert.equal(x.d.querySelector('#notifyMin').value,'medium');assert.equal(x.d.querySelector('#notifyAlert').value,'high');
 assert.match(x.d.querySelector('[aria-label="Finding outcomes"]').textContent,/Gone after their file changed2/);
 assert.match(x.d.querySelector('[aria-label="Finding outcomes"]').textContent,/does not prove one/);
 x.input('#notifyMin','high');x.input('#notifyAlert','low');x.submit('#notify-form');await flush();
 assert.equal(x.requests('set_pip_notify_settings').length,0,'alerts below the threshold are refused here');
 x.input('#notifyAlert','off');x.submit('#notify-form');
 const saved=x.requests('set_pip_notify_settings')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(saved.request)),{type:'set_pip_notify_settings',pip_id:p.id,min_severity:'high',alert_severity:null,expected_revision:0});
 assert.equal(x.requests('propose_pip_update').length,0,'no job review: the job does not change');
 x.answer(saved,{settings:{...settings,min_severity:'high',alert_severity:null,revision:1,is_default:false}});await x.drain(reads);
 assert.match(x.d.body.textContent,/Notifications saved. Nothing else changed./);
});

test('extension host gates the digest and notification controls at API 41',()=>{for(const api of [40,41]){const posted=[],sent=[],vscode={};const {PipsEditor}=load(viewCode,name=>name==='vscode'?vscode:require(name));const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});for(const [type,extra] of [['get_pip_digest',{}],['mark_pip_digest_seen',{until:'2026-10-04T09:00:00.000Z'}],['get_pip_notify_settings',{pip_id:pipId}],['set_pip_notify_settings',{pip_id:pipId,min_severity:'high',alert_severity:null,expected_revision:0}],['get_pip_outcomes',{pip_id:pipId}]])bridge.receive({type:'pipsRequest',id:type,request:{type,...extra}});assert.equal(sent.length,api===41?5:0);if(api===40)assert.match(posted.at(-1).error.message,/Pips digest and notification settings/);}});
// The Sessions home's dismiss (2026-10-18): an older DGC is never asked to keep what it cannot.
test('extension host sends mark_pip_news_seen at API 48 only',()=>{for(const api of [47,48]){const posted=[],sent=[],vscode={};const {PipsEditor}=load(viewCode,name=>name==='vscode'?vscode:require(name));const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});bridge.receive({type:'pipsRequest',id:'x',request:{type:'mark_pip_news_seen',pip_ids:[pipId],until:'2026-10-18T09:00:00.000Z'}});assert.equal(sent.length,api===48?1:0);if(api===48)assert.deepEqual(JSON.parse(JSON.stringify(sent[0].request)),{type:'mark_pip_news_seen',pip_ids:[pipId],until:'2026-10-18T09:00:00.000Z',request_id:sent[0].request.request_id});else assert.match(posted.at(-1).error.message,/Update DGC to dismiss/);}});

test('a project reviewer reviews exact GitHub reads; the model never picks them',async()=>{
 const p=job(),reads={get_pip_notify_settings:()=>({settings:{pip_id:p.id,min_severity:'medium',alert_severity:'high',revision:0,is_default:true}}),get_pip_outcomes:()=>({outcomes:{pip_id:p.id,name:p.name,pip_type:'rook',history_truncated:false,reported:0,accepted:0,dismissed:0,still_reported:0,gone_after_change:0,gone_without_change:0,checkpoints_examined:0}})};
 const old=setup({api:40,proposal:null,jobs:[p]});await old.drain();old.click('[data-job]');await old.drain();old.click('[data-tab=job]');await old.drain();assert.equal(old.d.querySelector('#github-form'),null);
 const x=setup({api:41,proposal:null,jobs:[p]});await x.drain(reads);x.click('[data-job]');await x.drain(reads);x.click('[data-tab=job]');await x.drain(reads);
 assert.match(x.d.querySelector('#github-form').textContent,/No GitHub reads approved/);
 x.input('#githubRepo','not a repository');x.d.querySelector('#githubIssues').checked=true;x.d.querySelector('#githubIssues').dispatchEvent(new x.w.Event('input',{bubbles:true}));x.d.querySelector('#githubIssues').dispatchEvent(new x.w.Event('change',{bubbles:true}));x.submit('#github-form');await flush();
 assert.equal(x.requests('propose_pip_update').length,0,'an invalid repository is refused here');
 x.input('#githubRepo','OpenPeach-ai/dgc');x.input('#githubLabels','bug, security');for(const id of ['githubChecks']){const box=x.d.querySelector('#'+id);box.checked=true;box.dispatchEvent(new x.w.Event('input',{bubbles:true}));box.dispatchEvent(new x.w.Event('change',{bubbles:true}));}
 x.submit('#github-form');
 const sent=x.requests('propose_pip_update')[0];assert.ok(sent,'proposed');
 const plan={schema_version:1,repository:'OpenPeach-ai/dgc',reads:[{kind:'open_issues',limit:20,labels:['bug','security']},{kind:'commit_checks'}]};
 assert.deepEqual(JSON.parse(JSON.stringify(sent.request.changes)),{github_plan:plan});
 const proposal={id:'proposal_'+'5'.repeat(32),pip_id:p.id,expected_version:1,definition:{...p,github_plan:plan},actor:'editor-user',reason:'Review these exact GitHub reads for this Pip.',status:'proposed',approval_status:'pending',expires_at:'2099-10-09T00:00:00Z'};
 x.answer(sent,{proposal});await x.drain(reads);
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog,'the proposal opens for review');
 assert.match(dialog.textContent,/GitHub reads/);assert.match(dialog.textContent,/OpenPeach-ai\/dgc/);assert.match(dialog.textContent,/labelled bug, security/);assert.match(dialog.textContent,/CI checks for the commit the run reviews/);
 assert.equal(x.requests('accept_pip_update').length,0,'nothing is accepted without the review');
});

test('a GitHub plan this view cannot read blocks acceptance instead of hiding it',()=>{
 assert.throws(()=>model.githubReadPlan({schema_version:1,repository:'a/b',reads:[{kind:'write_comment'}]}));
 assert.throws(()=>model.githubReadPlan({schema_version:1,repository:'a/b',reads:[{kind:'open_issues',limit:21}]}));
 assert.throws(()=>model.githubReadPlan({schema_version:1,repository:'a/b',reads:[{kind:'commit_checks'}],token:'x'}));
 assert.equal(model.githubReadPlan({schema_version:1,repository:'a/b',reads:[{kind:'failed_runs',limit:10}]}).repository,'a/b');
});

test('a starter shows its own example of what to read, and its schedule in words', async()=>{
 const personal=[{id:'market_brief',title:'Market brief',summary:'Before the market opens.',pip_type:'lens',scope:'personal',name:'Market brief',when:'weekdays',default_time:'08:30',params:['time','timezone','web_reads'],web_example:'search: Infosys results\nsearch: <b>x</b>'}];
 const x=setup({api:41,personal:true,proposal:null});await x.drain({list_pip_starters:()=>({starters:personal})});x.click('#new-pip');await x.drain({list_pip_starters:()=>({starters:personal})});
 x.click('[data-starter=market_brief]');
 const box=x.d.querySelector('#starter-web');assert.ok(box);
 assert.equal(box.getAttribute('placeholder'),'search: Infosys results\nsearch: <b>x</b>','the example, as text');
 assert.equal(model.scheduleLabel({type:'cron',cron:'30 8 * * 1-5',timezone:'Asia/Kolkata'}),'Weekdays at 08:30 · Asia/Kolkata');
 assert.equal(model.scheduleLabel({type:'cron',cron:'0 9 * * 1',timezone:'UTC'}),'Mondays at 09:00 · UTC');
 assert.equal(model.scheduleLabel({type:'cron',cron:'0 9 1 * *',timezone:'UTC'}),'Cron 0 9 1 * * · UTC','anything else stays exact');
});

test('import a shared Pip from New: it opens as a setup card to review and says what it left out', async()=>{
 const card=fixture({name:'Imported reviewer'});
 const x=setup({api:41,proposal:null});
 await x.drain({list_pip_starters:()=>({starters:[]})});x.click('#new-pip');await x.drain({list_pip_starters:()=>({starters:[]})});
 x.click('#import-pip-file');
 const request=x.requests('import_pip_file')[0];assert.ok(request,'the host is asked to pick a file');
 x.answer(request,{setup:card,left_out:['Reads from connected apps: they name your accounts.']});
 await x.drain({get_pip_setup:()=>({setup:card}),list_pip_setups:()=>({setups:[card]})});
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog,'the card opens straight into its review');
 assert.match(dialog.textContent,/Imported reviewer/);
 assert.equal(x.requests('accept_pip_setup').length,0,'nothing is approved by importing');
 assert.match(x.d.body.textContent,/Not included: Reads from connected apps/);
});

test('a Pip exports from its Job tab and the editor says what stayed behind', async()=>{
 const p=job(),reads={get_pip_notify_settings:()=>({settings:{pip_id:p.id,min_severity:'medium',alert_severity:'high',revision:0,is_default:true}}),get_pip_outcomes:()=>({outcomes:{pip_id:p.id,name:p.name,pip_type:'rook',history_truncated:false,reported:0,accepted:0,dismissed:0,still_reported:0,gone_after_change:0,gone_without_change:0,checkpoints_examined:0}})};
 const x=setup({api:41,proposal:null,jobs:[p]});await x.drain(reads);x.click('[data-job]');await x.drain(reads);x.click('[data-tab=job]');await x.drain(reads);
 x.click('#export-pip-file');
 const request=x.requests('export_pip_file')[0];assert.deepEqual(JSON.parse(JSON.stringify(request.request)),{type:'export_pip_file',pip_id:p.id});
 x.answer(request,{opened:true,left_out:['Memory, history, findings and results stay with the original Pip.']});await x.drain(reads);
 assert.match(x.d.body.textContent,/The shared Pip file is open\. Save it where you like\. Not included: Memory/);
});
