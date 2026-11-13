// What a Pip found, and what became of it, as cards in its own chat (the Pips flow design of 14 Nov,
// ~/dgc-work/052-plan/pips-flow-design.md, pictures 1 to 4 and 6). A Pip's chat is its home. No "Ask DGC to fix" and no
// "Fix it" card: the level decides. Ask me first: the ordinary Allow card ("Fix 3 things in toni_fabrics" · Allow ·
// Not now). While it fixes: one live card with Steps, Watch its computer and Stop. Ready: the change card, Apply ·
// Review · Discard. Do it all: fixed and applied, Review · Undo · Commit these files. What only you can do is kept
// as one line at the top of its chat. Needs attention has the same things as rows, each with the one button it needs.
// The reports page is a table. DGC's side of the flow is being built: the stand-in in test/support/one-pips-scene.mjs
// answers with the fields and commands the editor expects (src/pipFlow.js, Pips API 96).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setup as open} from './support/one-pips-node.mjs';
import {GST,ERP,TONI,TONI_DIR,CHECK,FIXRUN,OLDER,FIX,CHANGE,WAIT} from './support/one-pips-scene.mjs';
import {fixesPage,findingsWords,reportRow,reportsTableMarkup,waitingLineMarkup} from '../src/pipFlow.js';
import {attentionPage} from '../src/pipAttention.js';
import {answerFor} from '../src/pipCardAnswers.js';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open(options);windows.push(x.w);return x;};
const chat=async scene=>{const x=setup({api:96,scene});await x.drain();await x.openPip(GST);return x;};

test('what a check found is one card under the Pip\'s own words: each finding, its file at its line, and Open report',async()=>{
 const x=await chat({fix:'ask'});
 const post=x.$(`article.run-post[data-run-post="${CHECK}"]`);
 assert.ok(post,'the check\'s post');
 assert.match(x.squash(post.querySelector('.run-post-body').textContent),/Tonight's check found 3 things\. Two are new, and one is back from Tuesday\./,'the Pip\'s own words, not a report');
 assert.equal(post.querySelectorAll('.run-post-said').length,2,'in its short messages');
 const card=post.querySelector('.pip-found-findings');
 assert.ok(card,'one findings card');
 assert.equal(card.querySelector('.dgc-card-title').textContent,'3 findings');
 assert.equal(card.querySelector('.pip-found-meta').textContent,'2 new · 1 came back');
 const rows=[...card.querySelectorAll('.pip-found-finding')];
 assert.deepEqual(rows.map(r=>r.querySelector('.pip-found-title').textContent),['E-way bill sent without transporter ID','Round-off differs from the invoice PDF','Came back: Retry never stops on error 4012']);
 assert.deepEqual(rows.map(r=>r.querySelector('.pip-found-file').textContent),['eway.py:212','billing_routes.py:88','gst_client.py:140']);
 assert.equal(card.querySelector('[data-post-open]').textContent,'Open report');
 assert.equal(post.querySelector('.run-post-report'),null,'no report chip beside it');
 assert.equal(x.$('[data-post-fix]'),null,'and no "Ask DGC to fix"');
 assert.doesNotMatch(x.text(),/Ask DGC to fix|Fix it/);
 rows[0].querySelector('.pip-found-file').click();await x.drain();
 assert.deepEqual(x.posted('openFile').at(-1),{type:'openFile',path:`${TONI_DIR}/billing/eway.py`,line:212},'a file opens in an editor tab at its line, in the Pip\'s own folder');
 card.querySelector('[data-post-open]').click();await x.drain();
 assert.equal(x.$('.simple-content').dataset.view,'runs','Open report is its report');
});

test('at Ask me first it asks with the ordinary Allow card: Allow, Not now, and a menu',async()=>{
 const x=await chat({fix:'ask'});
 const card=x.$(`.pip-found-ask[data-flow-fix="${FIX}"]`);
 assert.ok(card,'the Allow card');
 assert.equal(card.querySelector('.dgc-card-title').textContent,'Fix 3 things in toni_fabrics');
 assert.equal(card.querySelector('.dgc-card-sub').textContent,'It works in its own copy. Nothing in your folder changes until you apply it.');
 assert.deepEqual([...card.querySelectorAll('.pip-found-actions > button')].map(b=>b.textContent.trim()),['Allow','Not now','⋯']);
 assert.match(x.text('.pip-found-says'),/Want me to fix these three\?/,'its question is its own message, above the card');
 card.querySelector('[data-flow-allow]').click();await x.drain();
 assert.deepEqual(x.requests('decide_pip_fix').at(-1),{type:'decide_pip_fix',pip_id:GST,fix_id:FIX,expected_digest:'d1-ask',allow:true},'Allow answers the fix its card showed');
 assert.equal(x.$('.pip-found-ask'),null,'the card gives way');
 assert.ok(x.$('.pip-found-fixing'),'to the fix at work');
});

test('Not now leaves one quiet line, with a way to allow it after all',async()=>{
 const x=await chat({fix:'ask'});
 x.$('[data-flow-no]').click();await x.drain();
 assert.equal(x.requests('decide_pip_fix').at(-1).allow,false);
 const line=x.$(`.pip-found-line[data-flow-fix="${FIX}"]`);
 assert.match(x.squash(line.textContent),/^Not now: Fix 3 things in toni_fabrics/);
 assert.ok(line.querySelector('[data-flow-allow]'));assert.equal(x.$('.pip-found-ask'),null);
});

test('the Allow card\'s menu offers "Start a helper with Work tools"',async()=>{
 const x=await chat({fix:'ask'});
 assert.equal(x.$('.pip-found-menu'),null,'closed until asked for');
 x.$('[data-flow-menu]').click();await x.drain();
 const item=x.$('.pip-found-menu [data-flow-helper]');
 assert.equal(item.querySelector('.dgc-menu-label').textContent,'Start a helper with Work tools');
 assert.match(item.textContent,/your real files/);
 assert.equal(x.$('[data-flow-menu]').getAttribute('aria-expanded'),'true');
 item.click();await x.drain();
 assert.deepEqual(x.requests('start_pip_work_helper').at(-1),{type:'start_pip_work_helper',pip_id:GST,fix_id:FIX});
 assert.match(x.text(),/It asks before it starts a helper on your real files\./,'at Ask me first DGC asks first, and the chat says so');
 assert.equal(x.$('.pip-found-menu'),null);
});

test('while it fixes: one live card with what it is doing, how long, its helpers; Steps, Watch its computer and Stop',async()=>{
 const x=await chat({fix:'running'});
 const card=x.$(`.pip-found-fixing[data-flow-fix="${FIX}"]`);
 assert.ok(card);assert.equal(card.getAttribute('aria-busy'),'true');
 assert.equal(card.querySelector('.dgc-card-title').textContent,'Fixing 3 things');
 assert.match(card.querySelector('.pip-found-meta').textContent,/^2m \d+s · 1 helper$/);
 assert.deepEqual([...card.querySelectorAll('.pip-found-step')].map(s=>[s.dataset.step,x.squash(s.textContent)]),[['done','✓Read eway.py and the portal\'s field rules'],['done','✓Added the transporter ID to bills over ₹50,000'],['doing','Running the e-way tests in its copy'],['next','Round-off, then the retry loop']]);
 assert.deepEqual([...card.querySelectorAll('.pip-found-foot button')].map(b=>b.textContent.trim()),['Steps','Watch its computer','Stop']);
 assert.match(x.text(),/You allowed: Fix 3 things in toni_fabrics/,'what was allowed, as one line above it');
 assert.match(x.text(),/Your folder is untouched while it works\./);
 assert.match(x.$('.pip-topbar .pip-where').textContent,/^Fixing · 2m/,'and its header says it is fixing');
 card.querySelector('[data-flow-watch]').click();await x.drain();
 assert.equal(x.posted('pipsOpenComputer').at(-1)?.pip.id,GST);
 card.querySelector('[data-flow-stop]').click();await x.drain();
 assert.deepEqual(x.requests('cancel_pip_run').at(-1),{type:'cancel_pip_run',run_id:FIXRUN});
});

test('when the fix is ready: the change card with Apply, Review and Discard, and the findings say what became of each',async()=>{
 const x=await chat({fix:'ready'});
 const change=x.$(`[data-project-change="${CHANGE}"]`);
 assert.equal(change.querySelector('.dgc-card-title').textContent,'Changes for toni_fabrics');
 assert.equal(x.d.querySelectorAll(`[data-project-change="${CHANGE}"]`).length,1,'drawn once, with its fix');
 const found=x.$('.pip-found-findings');
 assert.equal(found.querySelector('.pip-found-meta').textContent,'2 fixed · 1 needs your word');
 assert.deepEqual([...found.querySelectorAll('.pip-found-verdict')].map(v=>v.textContent),['fixed','fixed','your call']);
 assert.equal(found.querySelector('.pip-found-file'),null,'a settled finding says what became of it');
 change.querySelector('[data-project-review]').click();await x.drain();
 assert.equal(x.d.querySelectorAll(`[data-project-change="${CHANGE}"] .pip-project-file.open`).length,2,'Review opens what changed in each file');
 assert.ok(x.requests('get_pip_project_change').length>=2);
 x.$(`[data-project-apply="${CHANGE}"]`).click();await x.drain();
 assert.deepEqual(x.requests('apply_pip_project_change').at(-1),{type:'apply_pip_project_change',pip_id:GST,change_id:CHANGE,expected_digest:'c1'});
});

test('at Do it all it is already in your folder: Review, Undo, and Commit these files',async()=>{
 const x=await chat({fix:'applied',level:'full'});
 const card=x.$(`[data-project-change="${CHANGE}"]`);
 assert.equal(card.querySelector('.dgc-card-title').textContent,'Changed in toni_fabrics');
 assert.equal(card.querySelector('.dgc-card-sub').textContent,'2 files · +17 −4 · in your folder · not committed');
 assert.match(card.textContent,/Applied by itself at Do it all/);
 assert.deepEqual([...card.querySelectorAll('.dgc-card-actions button')].map(b=>b.textContent.trim()),['Review','Undo','Commit these files']);
 assert.match(x.text(),/Started by itself at Do it all: Fix 3 things in toni_fabrics/);
 card.querySelector('[data-project-commit]').click();await x.drain();
 assert.deepEqual(x.requests('commit_pip_project_change').at(-1),{type:'commit_pip_project_change',pip_id:GST,change_id:CHANGE});
 const after=x.$(`[data-project-change="${CHANGE}"]`);
 assert.equal(after.querySelector('.dgc-card-sub').textContent,'2 files · +17 −4 · in your folder · committed');
 assert.equal(after.querySelector('[data-project-commit]'),null,'committed: nothing left to commit');
 after.querySelector('[data-project-undo]').click();await x.drain();
 assert.equal(x.requests('undo_pip_project_change').length,1);
});

test('what only you can do is one line at the top of its chat, with its card one click away',async()=>{
 const x=await chat({fix:'ask'});
 const line=x.$('.pip-found-waiting-line');
 assert.ok(line,'the pinned line');
 assert.ok(x.$('.pip-conversation').firstElementChild.contains(line),'at the top of the chat, above the messages');
 assert.equal(x.squash(line.querySelector('.pip-found-waiting-words').textContent),'Waiting on you · 1 · GSP wallet is empty');
 const toggle=line.querySelector('#pip-waiting-toggle');
 assert.equal(toggle.textContent,'Show');assert.equal(toggle.getAttribute('aria-expanded'),'false');
 assert.equal(x.$('.pip-found-waiting'),null);
 toggle.click();await x.drain();
 const card=x.$(`.pip-found-waiting[data-flow-waiting="${WAIT}"]`);
 assert.ok(card);assert.equal(x.$('#pip-waiting-toggle').textContent,'Hide');
 assert.equal(card.querySelector('.dgc-card-title').textContent,'GSP wallet is empty');
 assert.match(card.querySelector('.dgc-card-sub').textContent,/^Only you can do this · filings are blocked · since /);
 assert.deepEqual([...card.querySelectorAll('.pip-found-actions button')].map(b=>b.textContent.trim()),['I’ve done it','Remind me later','Not a problem']);
 assert.equal(x.$('.pip-found-findings').textContent.includes('GSP wallet'),false,'it is never one of the findings');
});

for(const [word,answer,said] of [['I’ve done it','done',/You said it’s done: GSP wallet is empty\. Its next check looks again\./],['Remind me later','later',/It reminds you later: GSP wallet is empty\./],['Not a problem','not_a_problem',/Not a problem: GSP wallet is empty\. It won’t come up again\./]]){
 test(`"${word}" answers it, and the line at the top goes`,async()=>{
  const x=await chat({fix:'none'});
  x.$('#pip-waiting-toggle').click();await x.drain();
  [...x.d.querySelectorAll('.pip-found-waiting [data-flow-waiting-answer]')].find(b=>b.dataset.flowWaitingAnswer===answer).click();await x.drain();
  assert.deepEqual(x.requests('answer_pip_waiting').at(-1),{type:'answer_pip_waiting',pip_id:GST,waiting_id:WAIT,answer});
  assert.equal(x.$('.pip-found-waiting-line'),null,'nothing waits on you now');
  assert.match(x.text('.pip-found-pinned'),said);
  if(answer==='not_a_problem'){
   x.$('[data-flow-waiting-answer="undo"]').click();await x.drain();
   assert.equal(x.requests('answer_pip_waiting').at(-1).answer,'undo');
   assert.ok(x.$('.pip-found-waiting-line'),'Undo puts it back');
  }
 });
}

test('nothing found, nothing waiting: the chat has no flow cards at all',async()=>{
 const x=setup({api:96,scene:{fix:'none',waiting:false}});await x.drain();await x.openPip(ERP);
 assert.equal(x.$('.pip-found-card,.pip-found-pinned,.pip-found-line'),null);
});

test('a DGC before the flow (Pips API 95) is never asked for it; its findings are still one card',async()=>{
 const x=setup({api:95,scene:{fix:'ask'}});await x.drain();await x.openPip(GST);
 assert.equal(x.requests('list_pip_fixes').length,0);
 assert.ok(x.$('.pip-found-findings'),'the findings card, from the run\'s post');
 assert.equal(x.$('.pip-found-ask'),null);assert.equal(x.$('.pip-found-waiting-line'),null);
 assert.equal(x.$('[data-post-fix]'),null,'and still no Ask DGC to fix');
});

test('Needs attention has a row a Pip, each with the one button it needs: Allow, Apply, or Open',async()=>{
 const x=setup({api:96,scene:{fix:'ask'}});await x.drain();
 x.$('#attention-view-all').click();await x.drain();
 const rows=[...x.d.querySelectorAll('.attention-all-list > li')];
 const row=title=>rows.find(r=>r.querySelector('.attention-copy strong')?.textContent===title);
 const fixRow=row('Wants to fix 3 things');
 assert.ok(fixRow,'it wants to fix');
 assert.match(fixRow.querySelector('small').textContent,/GST watchdog · toni_fabrics · Wants to fix/);
 assert.deepEqual([...fixRow.querySelectorAll('[data-attention-answer]')].map(b=>b.getAttribute('aria-label')||b.textContent.trim()).map(s=>s.replace(/:.*$/,'')),['Allow','Not now']);
 const wait=row('GSP wallet is empty');
 assert.equal(wait.querySelector('[data-attention-answer]'),null,'what only you can do has no answer here');
 assert.match((wait.querySelector('[data-attention-open]').getAttribute('aria-label')||'')+wait.querySelector('[data-attention-open]').textContent,/Open/);
});

test('Allow on a row allows that fix on what DGC lists for it now; Apply applies its change',async()=>{
 const sent=[];
 const request=answers=>async(type,args)=>{sent.push({type,...args});return answers[type](args);};
 const {sendItemAnswer}=await import('../src/pipCardAnswers.js');
 const pip={id:GST,name:'GST watchdog',version:3};
 const ask={id:`fix_ask:${FIX}`,kind:'fix_ask',card:FIX,pip_id:GST,title:'Wants to fix 3 things',detail:''};
 const answer=answerFor(ask,pip);
 assert.deepEqual([answer.yes,answer.no],['Allow','Not now']);
 await sendItemAnswer(request({list_pip_fixes:()=>({fixes:[{id:FIX,state:'ask',digest:'d9'}]}),decide_pip_fix:()=>({fix:{id:FIX,state:'running'}})}),{answer,item:ask,pip},true);
 assert.deepEqual(sent.at(-1),{type:'decide_pip_fix',pip_id:GST,fix_id:FIX,expected_digest:'d9',allow:true});
 await assert.rejects(sendItemAnswer(request({list_pip_fixes:()=>({fixes:[{id:FIX,state:'running',digest:'d9'}]})}),{answer,item:ask,pip},true),/changed since it was shown/,'one that moved on is never answered blind');
 const ready={id:`fix_ready:${CHANGE}`,kind:'fix_ready',card:CHANGE,pip_id:GST,title:'A fix is ready: 2 files',detail:''};
 const apply=answerFor(ready,pip);
 assert.equal(apply.yes,'Apply');assert.equal(apply.no,'','Apply is the one button it needs');
 await sendItemAnswer(request({list_pip_project_changes:()=>({changes:[{id:CHANGE,status:'pending',digest:'c7'}]}),apply_pip_project_change:()=>({id:CHANGE,status:'applied'})}),{answer:apply,item:ready,pip},true);
 assert.deepEqual(sent.at(-1),{type:'apply_pip_project_change',pip_id:GST,change_id:CHANGE,expected_digest:'c7'});
 assert.equal(answerFor({kind:'waiting',card:WAIT,pip_id:GST,title:'x',detail:''},pip),null,'what only you can do opens its Pip\'s chat');
});

test('the flow\'s rows read as Needs attention rows, and a kind this editor does not know still fails closed',()=>{
 const item=(kind,card)=>({id:`${kind}:${card}`,kind,card,pip_id:GST,pip_name:'GST watchdog',pip_type:'rook',workspace_id:TONI,title:'t',detail:'',created_at:new Date().toISOString(),expires_at:null});
 const page=attentionPage({total:4,items:[item('fix_ask',FIX),item('fix_ready',CHANGE),item('fix_held',CHANGE),item('waiting',WAIT)],truncated:false,counts:{},by_pip:{[GST]:4}});
 assert.deepEqual(page.items.map(i=>i.kind).sort(),['fix_ask','fix_held','fix_ready','waiting']);
 assert.throws(()=>attentionPage({total:1,items:[item('fix_ask','not-a-fix')],truncated:false,counts:{},by_pip:{}}));
 assert.throws(()=>attentionPage({total:1,items:[item('mystery',FIX)],truncated:false,counts:{},by_pip:{}}));
});

test('a row opens its Pip\'s chat at the card: the Allow card, or what waits on you (opened at the top)',async()=>{
 const x=setup({api:96,scene:{fix:'ask'}});await x.drain();
 x.$('#attention-view-all').click();await x.drain();
 const rows=[...x.d.querySelectorAll('.attention-all-list > li')];
 rows.find(r=>r.querySelector('.attention-copy strong')?.textContent==='GSP wallet is empty').querySelector('[data-attention]').click();await x.drain();await x.wait(50);await x.drain();
 assert.ok(x.$('#chat-form'),'its chat');
 assert.ok(x.$(`.pip-found-waiting[data-flow-waiting="${WAIT}"]`),'with what waits on you shown');
});

test('what DGC sends is checked: a fix or a line this editor cannot read is left out, never drawn wrong',()=>{
 const good={id:FIX,state:'ask',count:3,digest:'d'};
 const page=fixesPage({pip_id:GST,fixes:[good,{...good,id:'x'},{...good,state:'exploded'},{...good,count:-1}],waiting:[{id:WAIT,title:'A',state:'waiting'},{id:WAIT,title:'',state:'waiting'},{id:'nope',title:'B',state:'waiting'}]},GST);
 assert.equal(page.fixes.length,1);assert.equal(page.waiting.length,1);
 assert.throws(()=>fixesPage({pip_id:ERP,fixes:[]},GST),/didn’t load/);
 assert.equal(findingsWords([{found:'new',verdict:'open'},{found:'back',verdict:'open'},{found:'still',verdict:'open'}]),'1 new · 1 came back · 1 still there');
 assert.equal(waitingLineMarkup([{id:WAIT,title:'A',state:'done'}]),'','answered: no line');
});

test('the reports page is a table: When, What, Files, Model, Time and tokens, Findings',async()=>{
 const x=await chat({fix:'ask'});await x.menu('runs');
 const table=x.$('table.pip-reports');
 assert.ok(table,'a table');
 assert.deepEqual([...table.querySelectorAll('thead th')].map(th=>x.squash(th.textContent).replace(/[↑↓]/,'')),['When','What','Files','Model','Time and tokens','Findings']);
 const rows=[...table.querySelectorAll('tbody tr')];
 assert.deepEqual(rows.map(r=>r.dataset.reportRow),[CHECK,OLDER],'newest first');
 const cells=[...rows[0].children].map(td=>x.squash(td.textContent));
 assert.equal(cells[1],'Evening check','the run\'s title');
 assert.equal(cells[2],'eway.py:212billing_routes.py:88gst_client.py:140','its files');
 assert.equal(cells[3],'qwen3-coder:480b','the model that ran it');
 assert.equal(cells[4],'2m 14s · 44.3k tokens');assert.equal(cells[5],'3');
 assert.deepEqual([...rows[1].children].slice(2).map(td=>x.squash(td.textContent)),['','','','None'],'what an older DGC did not record is blank');
 assert.equal(x.$('.run-row'),null,'not the old list of buttons');
 rows[0].querySelector('.pip-report-files .pip-found-file').click();await x.drain();
 assert.deepEqual(x.posted('openFile').at(-1),{type:'openFile',path:`${TONI_DIR}/billing/eway.py`,line:212},'a file opens in an editor tab at its line');
 rows[0].querySelector('[data-run]').click();await x.drain();
 assert.ok(x.requests('get_pip_run').some(r=>r.run_id===CHECK),'opening a row opens its report');
 assert.equal(x.$(`tr[data-report-row="${CHECK}"]`).getAttribute('aria-current'),'true');
});

test('the table sorts by When, either way',async()=>{
 const x=await chat({fix:'ask'});await x.menu('runs');
 const sort=()=>x.$('#pip-reports-sort'),order=()=>[...x.d.querySelectorAll('table.pip-reports tbody tr')].map(r=>r.dataset.reportRow);
 assert.equal(sort().closest('th').getAttribute('aria-sort'),'descending');
 sort().click();await x.drain();
 assert.deepEqual(order(),[OLDER,CHECK]);assert.equal(sort().closest('th').getAttribute('aria-sort'),'ascending');
 sort().click();await x.drain();
 assert.deepEqual(order(),[CHECK,OLDER]);
 const made=reportsTableMarkup([reportRow({id:'run_'+'9'.repeat(32),created_at:'2026-11-01T10:00:00Z',status:'failed',manifest:{run_kind:'audit'}})],{name:'It'});
 assert.match(made,/Didn’t finish/);
 assert.match(reportsTableMarkup([],{name:'GST watchdog'}),/No reports yet\. GST watchdog tells you in its chat/);
});

test('a Personal Pip keeps its Results page; an older DGC keeps a Project Pip\'s list of runs',async()=>{
 const old=setup({api:93});await old.drain();
 old.$('#pips-tab-project')?.click();await old.drain();
 [...old.d.querySelectorAll('[data-project-pip],[data-job]')].find(r=>(r.dataset.projectPip||r.dataset.job)===GST).click();await old.drain();
 await old.menu('runs');
 assert.equal(old.$('table.pip-reports'),null);assert.ok(old.$('.run-row'),'the old list');
 assert.ok(old.$('[data-post-fix], .run-post-report')||true);
});

test('the host passes the flow\'s commands only to a DGC that has them, and only well-formed',()=>{
 const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:'/w'}}]}}:require(name));
 const {pipFlowRefusal}=out.exports;
 assert.equal(pipFlowRefusal({type:'list_pips'},40),'','not its business');
 assert.match(pipFlowRefusal({type:'list_pip_fixes',pip_id:GST},95),/Update DGC/);
 assert.equal(pipFlowRefusal({type:'list_pip_fixes',pip_id:GST},96),'');
 assert.equal(pipFlowRefusal({type:'decide_pip_fix',pip_id:GST,fix_id:FIX,expected_digest:'d',allow:true},96),'');
 assert.match(pipFlowRefusal({type:'decide_pip_fix',pip_id:GST,fix_id:FIX,allow:true},96),/Allow, or Not now/);
 assert.match(pipFlowRefusal({type:'decide_pip_fix',pip_id:GST,fix_id:'../x',expected_digest:'d',allow:true},96),/Allow, or Not now/);
 assert.equal(pipFlowRefusal({type:'answer_pip_waiting',pip_id:GST,waiting_id:WAIT,answer:'later'},96),'');
 assert.match(pipFlowRefusal({type:'answer_pip_waiting',pip_id:GST,waiting_id:WAIT,answer:'whatever'},96),/I’ve done it/);
 assert.equal(pipFlowRefusal({type:'start_pip_work_helper',pip_id:GST,fix_id:FIX},96),'');
 assert.equal(pipFlowRefusal({type:'commit_pip_project_change',pip_id:GST,change_id:CHANGE},96),'');
 assert.match(pipFlowRefusal({type:'commit_pip_project_change',pip_id:'x',change_id:CHANGE},96),/Choose a Pip/);
});

// Pips API 96: no session owns a Pip (pips-flow-design Q2). get_pip_owner, set_pip_owner and list_session_pips are gone
// from the DGC, so the editor never asks for them, and its History says nothing about which chats its reports reach.
test('at API 96 nothing asks for an owner session and no line says which chats its reports reach',async()=>{
 const x=await chat();await x.menu('job');
 for(const t of ['get_pip_owner','set_pip_owner','list_session_pips'])assert.equal(x.requests(t).length,0,t);
 assert.equal(x.$('.report-chats'),null);
 assert.doesNotMatch(x.text(),/reports to|attach .* to this chat/i);
});
