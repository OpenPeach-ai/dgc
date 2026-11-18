// A Pip's sub-agent with Work tools, in its chat (0.52; Pips API 109;
// dgc/pip_work_agents.py). For a fix its copy can't do (a file Git ignores,
// a service to run): the permission card's More (Work's three dots) has "Start a sub-agent with Work tools", which
// starts one on the real folder (the user's press is the yes at every level). Its row and the agent map say "Work
// tools" beside its name, with its model; when it ends, what it changed in the folder is Work's changed-files card with
// Undo, as a fix applied at Do it all is shown; Undo puts it back and names what it left. One the Pip started by itself
// at Do it all, for no fix, is at the chat's end. An older DGC is offered none of it. The stand-in DGC is
// test/support/one-pips-scene.mjs (`sub`, `work`, `solo`).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setup as open} from './support/one-pips-node.mjs';
import {GST,FIX} from './support/one-pips-scene.mjs';
import {agentView} from '../src/pipFlow.js';
import {workDoneMarkup,agentRowMarkup} from '../src/pipChat.js';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const AGENT='pipagent_'+'1'.repeat(32),SOLO='pipagent_'+'9'.repeat(32);
const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open(options);windows.push(x.w);return x;};
const chat=async(scene,api=109)=>{const x=setup({api,scene:{sub:true,waiting:false,...scene}});await x.drain();await x.openPip(GST);await x.drain();return x;};

test('the permission card\'s More has "Start a sub-agent with Work tools", and the press starts it on the real folder',async()=>{
 const x=await chat({fix:'ask'});
 const card=x.$(`.pip-ask-card[data-flow-fix="${FIX}"]`);
 const more=card.querySelector('button.pip-ask-more[data-flow-menu]');
 assert.ok(more,'More, before Not now · Allow');
 assert.equal(more.getAttribute('aria-label'),'More ways to fix this');
 assert.ok(more.querySelector('svg'),'Work\'s three dots: one action, one icon');
 assert.deepEqual([...card.querySelectorAll('.pip-ask-btns > button')].map(b=>b.textContent.trim()),['','Not now','Allow']);
 assert.equal(x.$('.pip-ask-menu'),null,'closed until asked for');
 more.click();await x.drain();
 const row=x.$('.pip-ask-menu [data-flow-helper]');
 assert.equal(row.querySelector('.dgc-menu-label').textContent,'Start a sub-agent with Work tools');
 assert.match(row.querySelector('.dgc-menu-sub').textContent,/your real files, not the copy/,'it says what really happens');
 assert.match(row.querySelector('.dgc-menu-sub').textContent,/Undo/);
 assert.doesNotMatch(x.text(),/helper/i,'the word is sub-agent');
 assert.equal(x.$('[data-flow-menu]').getAttribute('aria-expanded'),'true');
 row.click();await x.drain();
 assert.deepEqual(x.requests('start_pip_work_helper').at(-1),{type:'start_pip_work_helper',pip_id:GST,fix_id:FIX});
 assert.equal(x.$('.pip-ask-menu'),null);
 assert.equal(x.$('.pip-ask-card'),null,'the press answered the card');
 const agent=x.$(`.pip-agent-row[data-agent="${AGENT}"]`);
 assert.ok(agent,'its sub-agent\'s row');
 assert.equal(agent.querySelector('.pip-agent-tag').textContent,'Work tools','beside its name');
 assert.equal(agent.querySelector('.pip-agent-name').nextElementSibling,agent.querySelector('.pip-agent-tag'));
});

test('an older DGC (Pips API 108) is offered no More on the card',async()=>{
 const x=await chat({fix:'ask'},108);
 assert.ok(x.$('.pip-ask-card'));
 assert.equal(x.$('[data-flow-menu]'),null);
 assert.deepEqual([...x.$('.pip-ask-btns').querySelectorAll('button')].map(b=>b.textContent.trim()),['Not now','Allow']);
});

test('the agent map says Work tools beside its name, with its model, and its card says it works on the real folder',async()=>{
 const x=await chat({fix:'running',work:true});
 x.$('#chat-agents').click();await x.drain();
 const row=x.$(`.pip-agent-map .am-agent[data-agent="${AGENT}"]`);
 assert.equal(row.querySelector('.am-desc').textContent,'Fix 3 things in lime_tiles');
 assert.equal(row.querySelector('.am-tag').textContent,'Work tools');
 assert.match(x.squash(row.querySelector('.am-meta').textContent),/qwen3-coder:480b$/,'its model, as other rows have');
 assert.match(row.getAttribute('aria-label'),/Work tools/);
 row.click();await x.drain();
 const card=x.$('.pip-agent-card[role="dialog"]');
 assert.match(x.squash(card.querySelector('.am-card-line').textContent),/It works on your real folder, lime_tiles, with a Work session’s tools: what it changes is there at once, and Undo puts it back\./);
 const facts=[...card.querySelectorAll('.am-facts dt')].map(d=>[d.textContent,d.nextElementSibling.textContent]);
 assert.deepEqual(facts.find(([k])=>k==='Tools'),['Tools','Work tools']);
});

test('when it is done: the Pip\'s words, then what it changed in your folder with Undo; Undo names what it left',async()=>{
 const x=await chat({fix:'applied',work:true,level:'full'});
 const card=x.$(`.pip-change[data-work-done="${AGENT}"]`);
 assert.ok(card,'Work\'s changed-files card');
 assert.equal(card.querySelector('.pip-change-title').textContent,'Changed in your folder');
 assert.equal(x.squash(card.querySelector('.pip-change-totals').textContent),'+15 −5');
 assert.deepEqual([...card.querySelectorAll('.pip-project-file .f')].map(f=>f.title),['totals.py','config/.env.example','cart.py']);
 assert.match(x.squash(card.querySelector('.pip-project-file[data-work-path="config/.env.example"]').textContent),/new/);
 assert.equal(x.squash(card.querySelector('.pip-change-says').textContent),'3 files · by a sub-agent with Work tools · already in your folder');
 assert.equal(x.$('[data-project-apply]'),null,'no Apply: it is in the folder already');
 const undo=card.querySelector('[data-agent-undo]');
 assert.equal(undo.textContent,'Undo');assert.ok(undo.classList.contains('dgc-btn'));
 assert.equal(undo.title,'Put back what it changed, where you haven’t changed it since');
 undo.click();await x.drain();
 assert.deepEqual(x.requests('undo_pip_agent_job').at(-1),{type:'undo_pip_agent_job',pip_id:GST,job_id:AGENT});
 const done=x.$(`.pip-change[data-work-done="${AGENT}"]`);
 assert.equal(done.dataset.state,'undone');
 assert.equal(done.querySelector('.pip-change-title').textContent,'Undone');
 assert.match(x.squash(done.textContent),/2 files put back in lime_tiles/);
 assert.match(x.squash(done.textContent),/1 file was left as it is/);
 assert.deepEqual([...done.querySelectorAll('.pip-project-held li')].map(li=>x.squash(li.textContent)),['cart.pyyou changed it since']);
 assert.equal(done.querySelector('[data-agent-undo]'),null,'once is all');
});

test('stopped: what it changed stays, and Undo is still there',async()=>{
 const x=await chat({fix:'stopped',work:true});
 assert.ok(x.$(`.pip-change[data-work-done="${AGENT}"] [data-agent-undo]`));
});

test('one the Pip started by itself at Do it all, for no fix: its row, then its words and Undo',async()=>{
 const x=await chat({solo:'working',level:'full'});
 const solo=x.$(`[data-work-solo="${SOLO}"]`);
 assert.ok(solo);
 assert.equal(solo.querySelector('.pip-agent-tag').textContent,'Work tools');
 assert.equal(solo.querySelector('[data-agent-undo]'),null,'nothing to undo while it works');
 const y=await chat({solo:'merged',level:'full'});
 const ended=y.$(`[data-work-solo="${SOLO}"]`);
 assert.match(y.squash(ended.textContent),/Settings load from the real \.env now/,'the Pip\'s own words from its check');
 ended.querySelector('[data-agent-undo]').click();await y.drain();
 assert.deepEqual(y.requests('undo_pip_agent_job').at(-1),{type:'undo_pip_agent_job',pip_id:GST,job_id:SOLO});
});

test('one the Pip started by itself sits under the reply that started it, among the messages; at the chat\'s end only when that reply is not drawn',async()=>{
 // (Live, 19 Nov: drawn at the chat's end, it floated below every newer message, a later question card's answer included.)
 const R=c=>'run_'+c.repeat(32),M=c=>'msg_'+c.repeat(32);
 const msgs=[{id:M('a'),role:'user',text:'List the env names into a file',run_id:R('a'),status:'succeeded'},
  {id:M('b'),role:'assistant',text:'I started a sub-agent with Work tools for it.',run_id:R('a'),status:'succeeded'},
  {id:M('c'),role:'user',text:'Now plan the settings sync',run_id:R('c'),status:'succeeded'},
  {id:M('d'),role:'assistant',text:'Here are three ways to store them.',run_id:R('c'),status:'succeeded'}];
 const x=await chat({solo:'merged',level:'full',soloFrom:R('a'),chat:{[GST]:{messages:msgs}}});
 const order=x.$$('.conversation-log .pip-message, .conversation-log [data-work-solo]').map(n=>n.matches('[data-work-solo]')?'SOLO':x.squash(n.textContent).slice(0,200));
 const at=order.indexOf('SOLO'),said=order.findIndex(s=>/started a sub-agent with Work tools/.test(s)),later=order.findIndex(s=>/plan the settings sync/.test(s));
 assert.ok(said>=0&&later>said,`the chat has the starting reply and a later message: ${JSON.stringify(order)}`);
 assert.ok(at>said&&at<later,`under the reply that started it, before the later message: ${JSON.stringify(order)}`);
 assert.equal(x.$$('[data-work-solo]').length,1,'drawn once');
 const y=await chat({solo:'merged',level:'full',soloFrom:R('9'),chat:{[GST]:{messages:msgs}}});
 const tail=y.$$('.conversation-log .pip-message, .conversation-log [data-work-solo]').map(n=>n.matches('[data-work-solo]')?'SOLO':'msg');
 assert.equal(tail.at(-1),'SOLO','a reply not drawn here: at the chat\'s end, as before');
 assert.equal(y.$$('[data-work-solo]').length,1);
});

test('what DGC sends about a work sub-agent is checked',()=>{
 const base={id:AGENT,pip_id:GST,kind:'work',fix_id:FIX,title:'Fix it',state:'merged',try:1,tries:3};
 const a=agentView({...base,changed:[{path:'a.py',status:'modified',additions:2,deletions:1,counted:true},{path:'',status:'x'},{path:'b.py',status:'weird'}],can_undo:true,
  undo:{restored:['a.py'],merged:[],left:[{path:'c.py',why:'you changed it since'},{nope:1}],at:'2026-11-18T10:00:00.000Z'}},GST);
 assert.deepEqual(a.changed,[{path:'a.py',status:'modified',additions:2,deletions:1,counted:true,command:false}]);
 assert.equal(a.can_undo,true);
 assert.deepEqual(a.undo.left,[{path:'c.py',why:'you changed it since'}]);
 assert.equal(agentView({...base,kind:'fix'}).changed,undefined,'only a work job carries them');
 assert.equal(workDoneMarkup({...a,changed:[],undo:null}),'','nothing changed: no card');
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const shown=workDoneMarkup({...a,undo:null,changed:[{path:'<b>.py',status:'new',additions:0,deletions:0,counted:false}]},{esc});
 assert.doesNotMatch(shown,/<b>\.py/,'a path is text');
 assert.match(agentRowMarkup({...a,state:'working'},{esc}),/Work tools/);
});

test('the host passes undo_pip_agent_job only to a DGC that has it, and only well-formed',()=>{
 const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:'/w'}}]}}:require(name));
 const {pipAgentsRefusal}=out.exports;
 assert.match(pipAgentsRefusal({type:'undo_pip_agent_job',pip_id:GST,job_id:AGENT},108),/Update DGC/);
 assert.equal(pipAgentsRefusal({type:'undo_pip_agent_job',pip_id:GST,job_id:AGENT},109),'');
 assert.match(pipAgentsRefusal({type:'undo_pip_agent_job',pip_id:GST,job_id:'../x'},109),/Choose the sub-agent/);
});
