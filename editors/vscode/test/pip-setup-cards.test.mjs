import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';
const bundle=buildSync({entryPoints:[new URL('../src/pipSetupCards.js',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'Cards'}).outputFiles[0].text;
const id='setup_'+'3'.repeat(32),ws='ws_'+'1'.repeat(32),pip='pip_'+'2'.repeat(32);
const setup=()=>({id,digest:'a'.repeat(64),workspace_id:ws,project_root:'/review/project',pip_id:null,name:'Daily review',goal:'Review committed source.',pip_type:'rook',work_kind:'source_review',source_ref:'HEAD',schedule:null,run_now:false,next_run_at:null,status:'pending',created_at:'2099-10-02T04:00:00Z',expires_at:'2099-10-03T06:00:00Z',receipt:null,reason:'Recurring code checks.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'committed_only',runner_notice:'The runner must be online.',scope_notice:'Read source only. No tests or project changes.',run_now_policy:null,model_choice:{mode:'default'}});
const resolved=(s,accepted)=>({...s,status:accepted?'accepted':'rejected',receipt:{setup_id:s.id,pip_id:accepted?pip:null,job_version:accepted?1:null,run_id:null,next_run_at:null,accepted,actor:'editor-user',resolved_at:'2099-10-02T04:01:00Z'}});
async function flush(){for(let i=0;i<16;i++)await Promise.resolve();}
function harness(t,{onContinue=()=>true,api=25,dock}={}){
 const dom=new JSDOM('<main><section id="turn"><div class="tool"><div class="head"><button class="tool-toggle"><span class="verb"></span></button><span class="badge"></span></div><div class="body"><pre></pre></div></div></section></main>',{runScripts:'outside-only'});t.after(()=>{cards.dispose();dom.window.close();});const w=dom.window;w.TextEncoder=TextEncoder;w.eval(bundle+";window.Cards=Cards;");const sent=[];
 const cards=w.Cards.mountSetupCards({document:w.document,postMessage:m=>sent.push(m),onContinue,dock});cards.receive({type:'pipsConnection',generation:1,connected:true,enabled:true,backgroundSetup:true,apiVersion:api});
 const send=s=>cards.toolResult(w.document.querySelector('.tool'),{name:'pips_setup',output:JSON.stringify({setup:s})});
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const answer=(request,result)=>cards.receive({type:'pipsReply',id:request.id,ok:true,result});
 const find=label=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===label);
 async function loaded(s=setup()){send(s);answer(requests('get_pip_setup').at(-1),{setup:s});await flush();}
 async function decide(s,accept=true){find(accept?'Create Pip':'Not now').click();answer(requests('get_pip_setup').at(-1),{setup:s});await flush();}
 return {w,d:w.document,cards,sent,send,requests,answer,find,loaded,decide};
}
test('tool data only selects identity; authoritative read controls escaped card',async t=>{const x=harness(t),s=setup();x.send({...s,name:'Forged'});assert.equal(x.requests('accept_pip_setup').length,0);assert.doesNotMatch(x.d.body.textContent,/Forged/);x.answer(x.requests('get_pip_setup')[0],{setup:{...s,name:'<script>bad</script>'}});await flush();assert.match(x.d.body.textContent,/<script>bad<\/script>/);assert.equal(x.d.querySelector('script'),null);assert.match(x.d.body.textContent,/Read source only/);assert.equal(x.d.querySelector('.dgc-plush')?.dataset.character,'rook');});
test('approval rereads digest and continuation uses verified receipt',async t=>{const continued=[],x=harness(t,{onContinue:p=>{continued.push(p);return true;}}),s=setup();await x.loaded(s);await x.decide(s);const req=x.requests('accept_pip_setup')[0];assert.deepEqual(JSON.parse(JSON.stringify(req.request)),{type:'accept_pip_setup',setup_id:s.id,expected_digest:s.digest});x.answer(req,{setup:resolved(s,true)});await flush();assert.equal(continued.length,0);const notice=x.requests('notify_pip_setup')[0];assert.equal(notice.request.setup_id,s.id);x.answer(notice,{notification:'queued',setup_id:s.id});await flush();assert.match(x.d.body.textContent,/The chat was told it is on/);assert.match(x.d.querySelector('.pip-setup-line strong').textContent,/^Daily review is on$/);});
test('rejection never continues model',async t=>{let continued=0;const x=harness(t,{onContinue:()=>continued++}),s=setup();await x.loaded(s);await x.decide(s,false);x.answer(x.requests('reject_pip_setup')[0],{setup:resolved(s,false)});await flush();assert.equal(continued,0);assert.match(x.d.querySelector('.pip-setup-line').textContent,/Not created/);assert.equal(x.find('Create Pip'),undefined,'nothing left to create');});
test('final response keeps pending card after tool groups collapse',async t=>{const x=harness(t);await x.loaded();x.cards.finish(x.d.querySelector('#turn'));assert.equal(x.d.querySelectorAll('.pip-setup-card').length,1);assert.equal(x.d.querySelector('.pip-setup-pending .pip-setup-details').hidden,true,'details stay folded');x.cards.finish(x.d.querySelector('#turn'));assert.equal(x.d.querySelectorAll('.pip-setup-card').length,1);});
test('changed digest cannot be accepted',async t=>{const x=harness(t),s=setup();await x.loaded(s);await x.decide({...s,digest:'b'.repeat(64)});assert.equal(x.requests('accept_pip_setup').length,0);assert.match(x.d.body.textContent,/changed or answered somewhere else/);});
test('tampered receipt cannot report success or continue',async t=>{let continued=0;const x=harness(t,{onContinue:()=>continued++}),s=setup();await x.loaded(s);await x.decide(s);x.answer(x.requests('accept_pip_setup')[0],{setup:{...resolved(s,true),goal:'Changed'}});await flush();assert.equal(continued,0);assert.match(x.d.body.textContent,/differs from the proposal/);});
test('chat switch discards late approval reply',async t=>{let continued=0;const x=harness(t,{onContinue:()=>continued++}),s=setup();await x.loaded(s);await x.decide(s);const req=x.requests('accept_pip_setup')[0];x.cards.reset();x.answer(req,{setup:resolved(s,true)});await flush();assert.equal(continued,0);assert.equal(x.d.querySelector('.pip-setup-card'),null);});
test('notification failure keeps approval receipt and offers retry',async t=>{const x=harness(t,{onContinue:()=> 'Save your existing draft first.'}),s=setup();await x.loaded(s);await x.decide(s);x.answer(x.requests('accept_pip_setup')[0],{setup:resolved(s,true)});await flush();assert.match(x.d.querySelector('.pip-setup-line strong').textContent,/Daily review is on/);const n=x.requests('notify_pip_setup')[0];x.cards.receive({type:'pipsReply',id:n.id,ok:false,error:{message:'Notification temporarily unavailable'}});await flush();assert.match(x.d.body.textContent,/temporarily unavailable/);assert.ok(x.find('Let the chat know'));});
test('model change creates new review; no silent acceptance',async t=>{const x=harness(t),s=setup();await x.loaded(s);x.find('Choose model').click();x.answer(x.requests('list_pip_models')[0],{default_model:'base',models:[{id:'local-large',name:'Local large'}]});await flush();const select=x.d.querySelector('select');select.value='local-large';select.dispatchEvent(new x.w.Event('change'));assert.equal(x.find('Create Pip').disabled,true);x.find('Use this model').click();const req=x.requests('revise_pip_setup')[0];assert.equal(req.request.model_choice.model,'local-large');const next={...s,id:'setup_'+'4'.repeat(32),digest:'b'.repeat(64),model_choice:{mode:'model',model:'local-large'}};x.answer(req,{setup:next});await flush();assert.equal(x.requests('accept_pip_setup').length,0);assert.equal(x.find('Create Pip').disabled,false);assert.match(x.d.body.textContent,/local-large/);x.cards.finish(x.d.querySelector('#turn'));assert.equal(x.d.querySelectorAll('.pip-setup-card').length,1);});
test('older API does not offer model revision',async t=>{const x=harness(t,{api:24});await x.loaded();assert.equal(x.find('Choose model'),undefined);assert.ok(x.find('Create Pip'));});
test('expired and disconnected cards cannot approve',async t=>{const x=harness(t),s={...setup(),created_at:'2020-01-01T00:00:00Z',expires_at:'2020-01-02T00:00:00Z'};await x.loaded(s);assert.equal(x.find('Create Pip').disabled,true);x.cards.receive({type:'pipsConnection',generation:2,connected:false,enabled:true,backgroundSetup:true,apiVersion:25});assert.equal(x.find('Create Pip').disabled,true);assert.equal(x.requests('accept_pip_setup').length,0);});

test('replayed original tool result follows its saved model revision',async t=>{const x=harness(t),s=setup(),next={...s,id:'setup_'+'4'.repeat(32),model_choice:{mode:'model',model:'large'}};x.send(s);const old=resolved(s,false);old.receipt.replacement_setup_id=next.id;x.answer(x.requests('get_pip_setup')[0],{setup:old});await flush();assert.equal(x.requests('get_pip_setup').at(-1).request.setup_id,next.id);x.answer(x.requests('get_pip_setup').at(-1),{setup:next});await flush();assert.ok(x.find('Create Pip'));assert.match(x.d.body.textContent,/large/);assert.equal(x.d.querySelector('.tool').dataset.pipSetup,next.id);});

import {makeDom,mainJs} from './support/webview-dom.mjs';
test('real main renderer connects tool review, final card and queued continuation without opening Pips',async()=>{
 const p=makeDom({scope:'review-scope',script:bundle+';window.DgcPips={mountSetupCards:Cards.mountSetupCards};document.documentElement.dataset.pipsDocumentId="test-document";\n'+mainJs});
 const s=setup(),event=e=>p.send({type:'event',event:e});
 p.send({type:'session_ready',sessionId:'review-session'});event({type:'ready',session_id:'review-session',capabilities:{pips_supported:true,pips_enabled:true,pips_api_version:25}});
 event({type:'turn_start'});event({type:'tool_call',name:'pips_setup',call_id:'setup-tool',args:{},summary:'Daily review'});event({type:'tool_result',name:'pips_setup',call_id:'setup-tool',output:JSON.stringify({setup:s}),is_error:false});
 assert.ok(p.posted.some(m=>m.type==='pipsReady'));p.send({type:'pipsConnection',generation:1,connected:true,enabled:true,backgroundSetup:true,apiVersion:25});
 const req=type=>p.posted.filter(m=>m.type==='pipsRequest'&&m.request.type===type).at(-1),answer=(r,result)=>p.send({type:'pipsReply',id:r.id,ok:true,result});
 answer(req('get_pip_setup'),{setup:s});await flush();event({type:'text_delta',text:'Review the proposed Pip.'});event({type:'turn_end',reason:'completed'});
 assert.equal(p.doc.querySelectorAll('.pip-setup-card').length,1);assert.equal(p.doc.body.classList.contains('pips-active'),false);
 const dock=p.doc.querySelector('#cbox > .pip-dock');assert.ok(dock,'docked in the chat box, where questions dock');assert.equal(p.doc.querySelector('#cbox .cinput').hidden,true);
 dock.querySelector('.pip-dock-create').click();answer(req('get_pip_setup'),{setup:s});await flush();answer(req('accept_pip_setup'),{setup:resolved(s,true)});await flush();
 assert.equal(p.posted.filter(m=>m.type==='prompt').length,0);assert.equal(req('notify_pip_setup').request.setup_id,s.id);assert.equal(p.doc.querySelector('#input').textContent,'');assert.deepEqual(p.errors,[]);
});

test('without a dock the line itself offers Create Pip, Not now and Details, and no continuation checkbox',async t=>{
 const x=harness(t),s=setup();await x.loaded(s);x.cards.finish(x.d.querySelector('#turn'));
 const line=x.d.querySelector('.pip-setup-pending .pip-setup-line'),details=line.querySelector('.pip-setup-details');assert.equal(details.hidden,true);
 const buttons=[...line.querySelector('.pip-setup-summary').querySelectorAll('button')];assert.deepEqual(buttons.map(b=>b.textContent),['Create Pip','Not now','Details']);
 assert.equal(line.querySelector('input[type=checkbox]'),null);
 assert.match(line.querySelector('.pip-setup-title').textContent,/^New Pip: Daily reviewWaiting for you$/);
 buttons[2].click();assert.equal(line.querySelector('.pip-setup-details').hidden,false);
 const hide=line.querySelector('.pip-setup-review');assert.equal(hide.textContent,'Hide details');assert.equal(hide.getAttribute('aria-expanded'),'true');
 hide.click();assert.equal(line.querySelector('.pip-setup-details').hidden,true);assert.equal(line.querySelector('.pip-setup-review').textContent,'Details');
 line.querySelector('.pip-setup-primary').click();
 x.answer(x.requests('get_pip_setup').at(-1),{setup:s});await flush();assert.equal(x.requests('accept_pip_setup').length,1);
});

// The maintainers' design D: with the panel's dock, a waiting Pip docks above the chat box (one at a
// time); Later keeps it waiting in the reply, Review docks it again; deciding undocks it.
test('with a dock a waiting Pip docks above the chat box; Later and Review move it; deciding undocks it',async t=>{
 const docked=[];const dock={show:el=>{docked.push(el);x.d.body.append(el);return true;},hide:el=>{el.remove();docked.splice(docked.indexOf(el),1);}};
 const x=harness(t,{dock}),s=setup();await x.loaded(s);
 assert.equal(docked.length,1);const card=docked[0];assert.ok(card.classList.contains('pip-dock'));
 assert.equal(card.querySelector('.pip-dock-title').textContent,'New Pip: Daily review');
 assert.deepEqual([...card.querySelectorAll('.pip-dock-chip')].map(c=>c.textContent),['When you ask','Reads committed code','Default model']);
 assert.deepEqual([...card.querySelectorAll('.pip-dock-foot button')].map(b=>b.textContent),['Not now','Details','Create Pip']);
 assert.match(x.d.querySelector('.pip-setup-line').textContent,/Waiting for you above the chat box/);
 assert.equal(x.d.querySelector('.pip-setup-line .pip-setup-primary'),null,'decided on the card, not twice');
 card.querySelector('.ask-x').click();assert.equal(docked.length,0,'Later undocks');assert.equal(x.requests('reject_pip_setup').length,0,'Later is not Not now');
 const review=x.d.querySelector('.pip-setup-line .pip-setup-primary');assert.equal(review.textContent,'Review');review.click();
 assert.equal(docked.length,1,'Review docks it again');
 docked[0].querySelector('.pip-dock-more').click();assert.match(docked[0].querySelector('.pip-dock-details').textContent,/Read source only/);
 docked[0].querySelector('.pip-dock-create').click();x.answer(x.requests('get_pip_setup').at(-1),{setup:s});await flush();
 const accept=x.requests('accept_pip_setup')[0];assert.ok(accept);x.answer(accept,{setup:resolved(s,true)});await flush();
 assert.equal(docked.length,0,'created: the card goes');assert.match(x.d.querySelector('.pip-setup-line strong').textContent,/Daily review is on/);
 x.cards.yieldDock();x.cards.dockFree();assert.equal(docked.length,0,'nothing left waiting');
});

test('approval during a live main turn automatically queues receipt and preserves the draft',async()=>{
 const p=makeDom({scope:'approval-live',script:bundle+';window.DgcPips={mountSetupCards:Cards.mountSetupCards};document.documentElement.dataset.pipsDocumentId="test-document";\n'+mainJs});
 const s=setup(),event=e=>p.send({type:'event',event:e});
 p.send({type:'session_ready',sessionId:'review-session'});event({type:'ready',session_id:'review-session',capabilities:{pips_supported:true,pips_enabled:true,pips_api_version:26}});
 event({type:'turn_start'});event({type:'tool_call',name:'pips_setup',call_id:'proposal',args:{},summary:'Daily review'});event({type:'tool_result',name:'pips_setup',call_id:'proposal',output:JSON.stringify({setup:s}),is_error:false});
 p.send({type:'pipsConnection',generation:1,connected:true,enabled:true,backgroundSetup:true,apiVersion:26});
 const req=type=>p.posted.filter(m=>m.type==='pipsRequest'&&m.request.type===type).at(-1),answer=(r,result)=>p.send({type:'pipsReply',id:r.id,ok:true,result});
 answer(req('get_pip_setup'),{setup:s});await flush();
 const input=p.doc.querySelector('#input');input.textContent='My separate unsent draft';input.dispatchEvent(new input.ownerDocument.defaultView.Event('input',{bubbles:true}));
 p.doc.querySelector('#cbox > .pip-dock .pip-dock-create').click();answer(req('get_pip_setup'),{setup:s});await flush();answer(req('accept_pip_setup'),{setup:resolved(s,true)});await flush();
 assert.equal(p.doc.querySelector('.pip-dock'),null,'undocked once created');assert.equal(p.doc.querySelector('#cbox .cinput').hidden,false,'the chat box is back');
 assert.equal(input.textContent,'My separate unsent draft');assert.equal(p.posted.filter(m=>m.type==='prompt').length,0);
 assert.equal(req('notify_pip_setup').request.setup_id,s.id);assert.equal(p.posted.filter(m=>m.type==='cancel'||m.type==='stop').length,0);
 event({type:'text_delta',text:'The main turn continues while the review resolves.'});assert.match(p.doc.body.textContent,/main turn continues/);
 assert.deepEqual(p.errors,[]);
});

test('Pulse card exposes exact HTTP checks and no execution model selector',async t=>{
 const x=harness(t,{api:27}),s={...setup(),pip_type:'pulse',work_kind:'app_smoke_test',permissions:'review_required',verification_plan:{schema_version:1,action:{kind:'test',network:'loopback_http_v1',tests:[{argv:['dgc-http-check','http://127.0.0.1:3090/login','200'],cwd:'.'}],limits:{wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32}}},scope_notice:'Local HTTP GET only. No redirects or credentials. Status does not verify rendering.'};
 await x.loaded(s);
 assert.match(x.d.querySelector('.pip-setup-details').textContent,/GET http:\/\/127.0.0.1:3090\/login → status 200/);
 assert.match(x.d.body.textContent,/http:\/\/127.0.0.1:3090\/login/);
 assert.match(x.d.body.textContent,/No redirects/);
 assert.equal(x.find('Choose model'),undefined);
 assert.ok(x.find('Create Pip'));
 x.find('Create Pip').click();x.answer(x.requests('get_pip_setup').at(-1),{setup:s});await flush();
 assert.equal(x.requests('accept_pip_setup').length,1);
});

test('restored detached history moves one compact proposal out of collapsed tools',async t=>{
 const x=harness(t),s=setup();await x.loaded(s);
 const block=x.d.querySelector('#turn');block.remove();
 x.cards.finish(block);x.cards.finish(block);
 assert.equal(block.querySelectorAll('.pip-setup-card').length,1);
 assert.equal(block.querySelectorAll(':scope > .pip-setup-pending > .pip-setup-card').length,1);
 assert.equal(block.querySelector('.pip-setup-card .pip-setup-details').hidden,true);
 assert.ok(block.querySelector('.tool').classList.contains('pip-setup-moved'));
 x.d.body.append(block);
 assert.deepEqual([...block.querySelectorAll('.pip-setup-summary button')].map(x=>x.textContent),['Create Pip','Not now','Details']);
});

test('repeated tool receipts for one saved proposal reuse its existing row',async t=>{
 const x=harness(t),s=setup();await x.loaded(s);
 const tool=x.d.querySelector('.tool'),next=tool.cloneNode(false);next.innerHTML='<span class="verb"></span><span class="badge"></span><div class="body"></div>';tool.after(next);
 x.cards.toolResult(next,{name:'pips_setup',output:JSON.stringify({setup:s})});
 assert.equal(x.d.querySelectorAll('.pip-setup-card').length,1);
 assert.ok(tool.classList.contains('pip-setup-moved'));
 x.cards.finish(x.d.querySelector('#turn'));
 assert.equal(x.d.querySelectorAll('.pip-setup-pending > .pip-setup-card').length,1);
});
test('a Pip the chat created on its permission reads as created, with nothing left to approve',async t=>{
 const x=harness(t),s=setup();
 const created={...s,status:'accepted',receipt:{setup_id:s.id,pip_id:pip,job_version:1,run_id:null,next_run_at:null,accepted:true,actor:'chat-permission:auto',resolved_at:'2099-10-02T04:01:00Z'}};
 x.send(created);x.answer(x.requests('get_pip_setup').at(-1),{setup:created});await flush();
 assert.match(x.d.body.textContent,/Created in auto mode\. Pause, change or delete it in Pips\./);
 assert.equal(x.d.querySelector('.pip-setup-line strong').textContent,'Daily review is on');
 assert.equal(x.find('Create Pip'),undefined);
 assert.equal(x.find('Let the chat know'),undefined,'the chat already knows: nothing to notify');
 assert.equal(x.requests('notify_pip_setup').length,0);
});
test('a personal card offers the user\'s own subscriptions from API 55, and says once what they use',async t=>{const personal={...setup(),source_policy:'personal',work_kind:'personal_task',pip_type:'lens'};const catalog={default_model:'base',models:[{id:'local-large',name:'Local large'}],subscriptions:[{engine:'codex',name:'Codex'}]};
 for(const api of [54,55]){const x=harness(t,{api});await x.loaded(personal);x.find('Choose model').click();x.answer(x.requests('list_pip_models')[0],catalog);await flush();const options=[...x.d.querySelectorAll('select option')].map(o=>o.textContent);assert.equal(options.includes('Codex · your subscription'),api===55,`api ${api}`);if(api===54)continue;
  const select=x.d.querySelector('select');select.value='subscription|codex';select.dispatchEvent(new x.w.Event('change'));assert.match(x.d.body.textContent,/Its replies and routines use your Codex plan’s usage\./);x.find('Use this model').click();assert.deepEqual(JSON.parse(JSON.stringify(x.requests('revise_pip_setup')[0].request.model_choice)),{mode:'subscription',engine:'codex'});}
 const project=harness(t,{api:55});await project.loaded(setup());project.find('Choose model').click();project.answer(project.requests('list_pip_models')[0],catalog);await flush();assert.equal([...project.d.querySelectorAll('select option')].some(o=>/subscription/.test(o.textContent)),false,'a project card offers none');});

// Reported 2026-10-23: the Pip's card showed its face twice, the card's own and a second run card's under it. Its first
// run is the card's own status line now: one face, and the line follows the run ("First run: report ready").
test('an accepted Pip with a first run shows one face; the run is its status line', async t => {
 const x=harness(t),s={...setup(),run_now:true,run_now_policy:'It runs once, right after you create it.'},run='run_'+'5'.repeat(32);
 // run once now: the receipt names the run
 const accepted={...resolved(s,true),receipt:{...resolved(s,true).receipt,run_id:run}};
 x.send(accepted);x.answer(x.requests('get_pip_setup').at(-1),{setup:accepted});await flush();
 const line=x.d.querySelector('.pip-setup-line')||x.d.querySelector('.pip-setup-card');
 const runReq=x.requests('get_pip_run').at(-1);assert.ok(runReq,'the first run is looked up');
 x.answer(runReq,{run:{id:run,pip_id:pip,workspace_id:ws,status:'succeeded',manifest:{run_kind:'source_review'}}});await flush();
 x.answer(x.requests('get_pip').at(-1),{pip:{id:pip,workspace_id:ws,pip_type:'rook',name:'Daily review'}});
 x.answer(x.requests('get_pip_runner').at(-1),{runner:{online:true}});await flush();
 assert.equal(x.d.querySelectorAll('.pip-run-line').length,0,'no second card inside the first');
 assert.equal(x.d.querySelectorAll('.pip-run-avatar').length,0,'no second face');
 assert.match(line.querySelector('.pip-setup-title').textContent,/^Daily review is onFirst run: report ready$/);
});
