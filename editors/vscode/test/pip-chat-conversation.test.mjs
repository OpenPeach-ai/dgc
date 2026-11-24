// A Pip's chat reads as a conversation, with its sub-agents (0.52; Pips API 97,
// dgc/pip_agents.py). The Pip's face and name once per run
// of its messages; what a check found is a list inside its message, each file a link, with a quiet "Open report"; it
// asks in its own words above the ordinary permission card (Not now · Allow); while its sub-agent works: its one line,
// the sub-agent's row with the Pip's face in black and white, what it is doing, how long, "try n of 3", Steps · Watch
// its computer · Stop (stop_pip_agent), and the chat stays free; when it ends: the Pip's words from its check, then the
// changed-files card (Review · Apply, Discard in its menu; or "Applied to your folder" with Review · Undo); after the
// last try: Try again · Leave it (retry_pip_fix). The composer has the sub-agents pill, which opens the agent map for
// this Pip. The stand-in DGC is test/support/one-pips-scene.mjs with `sub: true` (API 97's shapes).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setup as open} from './support/one-pips-node.mjs';
import {GST,CHECK,FIXRUN,FIX,CHANGE} from './support/one-pips-scene.mjs';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const AGENT='pipagent_'+'1'.repeat(32);
const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open(options);windows.push(x.w);return x;};
const chat=async(scene,api=97)=>{const x=setup({api,scene:{sub:true,waiting:false,...scene}});await x.drain();await x.openPip(GST);await x.drain();return x;};
const words=(x,s)=>x.$$(s).map(n=>x.squash(n.textContent).trim());

test('what a check found is a list inside the Pip\'s message: each file a link at its line, and a quiet Open report',async()=>{
 const x=await chat({fix:'ask'});
 const post=x.$(`[data-run-post="${CHECK}"]`);
 assert.ok(post);
 assert.equal(x.$('.pip-found-findings'),null,'no findings card');
 const rows=[...post.querySelectorAll('.pip-said-found > li')];
 assert.deepEqual(rows.map(li=>x.squash(li.querySelector('.pip-said-what').textContent)),['Order total ignores the discount','Tax is rounded to one decimal place','Adding the same tile twice makes two cart rows']);
 assert.deepEqual(rows.map(li=>li.querySelector('button.md-link[data-flow-file]').textContent),['totals.py:3','tax.py:4','cart.py:2']);
 assert.equal(rows[0].closest('.message-body')?.classList.contains('text'),true,'the list is in its message, as Work\'s prose');
 const report=post.querySelector('button.pip-quiet-link[data-post-open]');
 assert.equal(report.textContent,'Open report');assert.equal(report.dataset.postOpen,CHECK);
 rows[0].querySelector('[data-flow-file]').click();await x.drain();
 assert.deepEqual(x.posted('openFile').at(-1),{type:'openFile',path:'/home/me/code/lime_tiles/totals.py',line:3});
});

test('it asks in its own words above the ordinary permission card: Not now, then Allow',async()=>{
 const x=await chat({fix:'ask'});
 const card=x.$(`.pip-ask-card[data-flow-fix="${FIX}"]`);
 assert.ok(card);assert.equal(x.$('.pip-found-ask'),null,'the old Allow card is gone');
 assert.equal(card.querySelector('.pip-ask-title').textContent,'Fix 3 things in lime_tiles');
 assert.deepEqual([...card.querySelectorAll('button')].map(b=>b.textContent.trim()),['Not now','Allow'],'Work\'s order: the filled answer last');
 assert.ok(card.querySelector('[data-flow-allow]').classList.contains('primary'));
 assert.match(card.querySelector('.pip-ask-note').textContent,/It works in its own copy\. Nothing in your folder changes until you apply it\./);
 const asks=card.previousElementSibling;
 assert.ok(asks.matches('.pip-said'),'its question is its own message, right above the card');
 assert.equal(x.squash(asks.textContent),'Want me to fix these three?');
 card.querySelector('[data-flow-allow]').click();await x.drain();
 assert.equal(x.requests('decide_pip_fix').at(-1).allow,true);
 assert.equal(x.$('.pip-ask-card'),null);
 assert.equal(x.squash(x.$('.pip-answered > summary').textContent),'Fix 3 things in lime_tiles · Allowed','answered: one folded line');
 assert.match(x.text(),/I’ve handed these to a sub-agent\. I’ll check its work and tell you\./);
 assert.ok(x.$(`.pip-agent-row[data-agent="${AGENT}"]`),'and its sub-agent\'s row');
});

test('Not now leaves one quiet line with a way to allow it after all',async()=>{
 const x=await chat({fix:'ask'});
 x.$('.pip-ask-card [data-flow-no]').click();await x.drain();
 const line=x.$('.pip-answered-line[data-state="declined"]');
 assert.match(x.squash(line.textContent),/^Fix 3 things in lime_tiles · Not now/);
 assert.equal(line.querySelector('[data-flow-allow]').textContent,'Allow it after all');
});

test('while its sub-agent works: the Pip\'s one line, and the row with its face in black and white, what it is doing, how long, Steps · Watch its computer · Stop',async()=>{
 const x=await chat({fix:'running'});
 assert.equal(x.$('.pip-found-fixing'),null,'no live card');
 const row=x.$(`.pip-agent-row[data-agent="${AGENT}"]`);
 assert.equal(row.dataset.state,'working');
 assert.equal(row.querySelector('.pip-agent-name').textContent,'Fix 3 things in lime_tiles');
 assert.equal(x.squash(row.querySelector('.pip-agent-text').textContent),'Fixing · Running the tests','what it is doing, from its run\'s activity');
 assert.match(row.querySelector('.pip-agent-time').textContent,/^4\ds$/);
 const face=row.querySelector('.pip-agent-face');
 assert.ok(face.classList.contains('is-bw'),'its Pip\'s face, in black and white');assert.ok(face.classList.contains('is-live'),'with the live ring while it works');
 assert.ok(face.querySelector('.avatar,.dgc-plush,svg,canvas'),'the face itself');
 assert.deepEqual([...row.querySelectorAll('.pip-agent-actions button')].map(b=>b.textContent.trim()),['Steps','Watch its computer','Stop']);
 assert.equal(x.$('#chatText').disabled,false,'the chat stays free: you can write to the Pip meanwhile');
 row.querySelector('[data-flow-watch]').click();await x.drain();
 assert.equal(x.posted('pipsOpenComputer').at(-1)?.pip.id,GST);
 row.querySelector('[data-agent-steps]').click();await x.drain();
 assert.deepEqual(words(x,`.pip-agent-steps[data-steps-of="${AGENT}"] li`),['Getting started','Editing totals.py','Running the tests']);
 x.$(`.pip-agent-row[data-agent="${AGENT}"] [data-agent-stop]`).click();await x.drain();
 assert.deepEqual(x.requests('stop_pip_agent').at(-1),{type:'stop_pip_agent',pip_id:GST,agent_id:AGENT});
 assert.equal(x.requests('cancel_pip_run').length,0);
 assert.equal(x.$(`.pip-agent-row[data-agent="${AGENT}"]`).dataset.state,'stopped');
 assert.match(x.text(),/Its sub-agent was stopped\. Nothing reached your copy\./);
});

test('a retry says so in the Pip\'s one line, and the row says which try it is',async()=>{
 const x=await chat({fix:'retry'});
 assert.match(x.text(),/The first try wasn’t right yet\. I’ve sent it back: an empty cart still breaks the total/);
 assert.match(x.squash(x.$('.pip-agent-text').textContent),/^Fixing · .* · try 2 of 3$/);
 const first=await chat({fix:'running'});
 assert.doesNotMatch(first.$('.pip-agent-text').textContent,/try 1/,'the first try says nothing of tries');
});

test('while the Pip checks its sub-agent\'s work the row says so',async()=>{
 const x=await chat({fix:'checking'});
 const row=x.$('.pip-agent-row');
 assert.equal(row.dataset.state,'checking');
 assert.equal(x.squash(row.querySelector('.pip-agent-text').textContent),'Tile checker is checking its work');
});

test('when it ends: the Pip\'s words from its check, the finished row, then the changed-files card with Review · Apply and Discard in its menu',async()=>{
 const x=await chat({fix:'ready'});
 assert.match(x.squash(x.$(`.pip-said[data-said-of="${FIX}"]`).textContent),/^Done\. I checked the sub-agent’s change|^Done\. I checked the sub-agent's change/);
 const row=x.$('.pip-agent-row');
 assert.equal(row.dataset.state,'merged');
 assert.equal(x.squash(row.querySelector('.pip-agent-text').textContent),'Finished');
 assert.equal(row.querySelector('.pip-agent-time').textContent,'2m 12s');
 assert.equal(row.querySelector('.pip-agent-face').classList.contains('is-live'),false,'no ring when done');
 assert.deepEqual([...row.querySelectorAll('button')].map(b=>b.textContent.trim()),['Steps']);
 const card=x.$(`.pip-change[data-project-change="${CHANGE}"]`);
 assert.ok(card,'Work\'s changed-files card');
 assert.equal(card.querySelector('.pip-change-title').textContent,'Edited 2 files');
 assert.equal(x.squash(card.querySelector('.pip-change-totals').textContent),'+15 −5');
 assert.deepEqual([...card.querySelectorAll('.pip-change-actions > button')].map(b=>b.getAttribute('aria-label')||b.textContent.trim()),['More','Show the files','Review','Apply']);
 assert.ok(card.querySelector('[data-project-apply]').classList.contains('primary'));
 // Its files start folded, as Work's Edited card's do (asked 24 Nov); its chevron opens them.
 assert.equal(card.querySelector('.pip-project-files').hidden,true,'folded to start');
 card.querySelector('[data-change-fold]').click();await x.drain();
 assert.equal(x.$('.pip-change .pip-project-files').hidden,false);
 assert.equal(x.$$('.pip-change .pip-project-file').length,2,'its files, each opening its diff');
 assert.equal(x.$('.pip-change [data-change-fold]').getAttribute('aria-label'),'Hide the files');
 card.querySelector('[data-change-menu]').click();await x.drain();
 const menu=x.$('.pip-change .pip-change-menu [role="menuitem"]');
 assert.equal(x.squash(menu.textContent),'Discard');
 x.$('.pip-change [data-project-apply]').click();await x.drain();
 assert.equal(x.requests('apply_pip_project_change').length,1);
 // after its row: the order of the conversation
 const post=x.$(`[data-run-post="${CHECK}"]`),order=[...post.querySelectorAll('.pip-agent-row,.pip-said[data-said-of],.pip-change,.pip-answered')].map(n=>n.className.split(' ')[0]==='message-body'?'said':n.className.split(' ')[0]);
 assert.deepEqual(order.slice(0,2),['pip-answered','pip-agent-row']);
});

test('at Do it all nothing asks: handed over by itself, then "Applied to your folder" with Review · Undo',async()=>{
 const x=await chat({fix:'applied',level:'full'});
 assert.equal(x.$('.pip-answered'),null,'no answered line: nothing was asked');
 assert.match(x.text(),/I’ve handed these to a sub-agent/);
 const card=x.$('.pip-change');
 assert.equal(card.querySelector('.pip-change-title').textContent,'Applied to your folder');
 const acts=[...card.querySelectorAll('.pip-change-actions > button')].map(b=>b.textContent.trim()).filter(Boolean);
 assert.deepEqual(acts.slice(0,2),['Review','Undo']);
 card.querySelector('[data-project-undo]').click();await x.drain();
 assert.equal(x.requests('undo_pip_project_change').length,1);
});

test('held: the Pip says which files your copy changed meanwhile',async()=>{
 const x=await chat({fix:'held'});
 assert.match(x.squash(x.$(`.pip-said[data-said-of="${FIX}"]`).textContent),/cart\.py changed while its sub-agent worked/);
 assert.equal(x.$('.pip-agent-row').dataset.state,'held');
});

test('after the last try: its message, then Try again · Leave it',async()=>{
 const x=await chat({fix:'asked'});
 assert.match(x.squash(x.$(`.pip-said[data-said-of="${FIX}"]`).textContent),/It tried 3 times and it isn’t right yet|It tried 3 times and it isn't right yet/);
 assert.match(x.squash(x.$('.pip-agent-text').textContent),/try 3 of 3$/);
 const row=x.$(`.pip-retry[data-retry-of="${FIX}"]`);
 assert.deepEqual([...row.querySelectorAll('button')].map(b=>b.textContent.trim()),['Leave it','Try again']);
 row.querySelector('[data-retry-again]').click();await x.drain();
 assert.deepEqual(x.requests('retry_pip_fix').at(-1),{type:'retry_pip_fix',pip_id:GST,fix_id:FIX,again:true});
 assert.equal(x.$('.pip-agent-row').dataset.state,'working','a fresh sub-agent job');
 const y=await chat({fix:'asked'});
 y.$('.pip-retry [data-retry-leave]').click();await y.drain();
 assert.deepEqual(y.requests('retry_pip_fix').at(-1),{type:'retry_pip_fix',pip_id:GST,fix_id:FIX,again:false});
 assert.equal(y.$('.pip-retry'),null,'never asked again');
});

test('a failed sub-agent is said in one line',async()=>{
 const x=await chat({fix:'failed'});
 assert.match(x.squash(x.$(`.pip-said[data-said-of="${FIX}"]`).textContent),/^Its sub-agent stopped with an error: the model stopped answering/);
 assert.equal(x.$('.pip-agent-row').dataset.state,'failed');
 assert.equal(x.squash(x.$('.pip-agent-text').textContent),'Failed');
});

test('the Pip\'s face and name stand once per run of its messages; its check\'s own reply is not said twice',async()=>{
 const x=await chat({fix:'running',talk:true,checkTurn:true});
 const log=x.$('.conversation-log');
 // (yesterday's all-clear check is a run of its own; then tonight's check with all that came of it; then its answer to you)
 assert.equal(log.querySelectorAll('.run-post-head').length,3,'one head for each run of its messages');
 assert.equal(x.$(`[data-run-post="${CHECK}"]`).querySelectorAll('.run-post-head').length,1,'the check, its question, its sub-agent: one head');
 const reply=x.$('[data-message="msg_'+'4'.repeat(32)+'"]');
 assert.ok(reply.querySelector('.run-post-head .run-post-name'),'its answer after your message has its face and name');
 assert.equal(reply.querySelector('.run-post-name').textContent,'Tile checker');
 assert.equal(reply.classList.contains('pip-plain'),true,'unboxed, as Work\'s replies');
 assert.equal(x.$('[data-message="msg_'+'6'.repeat(32)+'"]'),null,'the check\'s raw reply is not a second message');
 assert.doesNotMatch(x.text(),/RESULT: PASS|FINDING 1/);
 assert.ok(x.$('[data-message="msg_'+'3'.repeat(32)+'"] .bubble'),'your message keeps its bubble');
});

test('the composer has the sub-agents pill, counting its sub-agents, and it opens the agent map for this Pip',async()=>{
 const x=await chat({fix:'running',earlier:2});
 const pill=x.$('#chat-agents');
 assert.ok(pill,'in the prompt box');assert.equal(pill.dataset.state,'running');
 assert.equal(pill.querySelector('.agents-text').textContent,'1 sub-agent');assert.equal(pill.querySelector('.agents-short').textContent,'1');
 assert.equal(pill.nextElementSibling?.querySelector('#chat-model')?.id,'chat-model','where Work has it: before the model (in the slot that measures its room)');
 assert.deepEqual(x.requests('list_pip_agents').at(-1),{type:'list_pip_agents',pip_id:GST});
 pill.click();await x.drain();
 const map=x.$('.pip-agent-map[role="dialog"]');
 assert.ok(map);assert.equal(map.querySelector('h2').textContent,'Agent map');
 assert.equal(x.squash(map.querySelector('.agent-map-subtitle').textContent),'1 working · 2 earlier');
 const root=map.querySelector('.am-root');
 assert.equal(root.querySelector('.am-desc').textContent,'Tile checker');
 assert.match(root.querySelector('.am-meta').textContent,/^lime_tiles/);
 assert.ok(root.querySelector('.am-pip-face:not(.is-bw)'),'the Pip at the root, in colour');
 const agent=map.querySelector(`.am-agent[data-agent="${AGENT}"]`);
 assert.equal(agent.querySelector('.am-desc').textContent,'Fix 3 things in lime_tiles');
 assert.match(x.squash(agent.querySelector('.am-meta').textContent),/^Running the tests · 4\ds · qwen3-coder:480b$/,'what it is doing, how long, its model');
 assert.ok(agent.querySelector('.am-pip-face.is-bw'),'its sub-agents under it in black and white');
 assert.equal(map.querySelectorAll('.am-agent').length,1,'earlier ones are folded');
 const fold=map.querySelector('.am-earlier');
 assert.equal(x.squash(fold.textContent),'Earlier in this chat · 2 sub-agents');
 fold.click();await x.drain();
 assert.equal(x.$$('.pip-agent-map .am-agent').length,3);
 assert.equal(x.$('.pip-agent-map .am-tasks'),null,'background commands come later: nothing is faked');
 x.$(`.pip-agent-map .am-agent[data-agent="${AGENT}"]`).click();await x.drain();
 const card=x.$('.pip-agent-card[role="dialog"]');
 assert.equal(card.querySelector('h2').textContent,'Fix 3 things in lime_tiles');
 assert.match(x.squash(card.textContent),/Started by Tile checker/,'the card names the Pip, not "the main agent"');
 assert.deepEqual([...card.querySelectorAll('.am-actions button')].map(b=>b.textContent.trim()),['Stop']);
 assert.deepEqual(words(x,'.pip-agent-card .am-calls li'),['Getting started','Editing totals.py','Running the tests'],'its steps');
 card.querySelector('[data-agent-stop]').click();await x.drain();
 assert.deepEqual(x.requests('stop_pip_agent').at(-1),{type:'stop_pip_agent',pip_id:GST,agent_id:AGENT});
});

test('the pill stays once the Pip has had a sub-agent ("Agent map"), and a Pip that never had one has none',async()=>{
 const x=await chat({fix:'ready'});
 assert.equal(x.$('#chat-agents').dataset.state,'idle');
 assert.equal(x.$('#chat-agents .agents-text').textContent,'Agent map');
 const none=await chat({fix:'ask'});
 assert.equal(none.$('#chat-agents'),null);
});

test('Escape closes the card, then the map, and focus goes back to the pill',async()=>{
 const x=await chat({fix:'running'});
 x.$('#chat-agents').click();await x.drain();
 x.$('.pip-agent-map .am-agent').click();await x.drain();
 const esc=()=>x.d.activeElement?.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true}))??x.$('.pip-app-root').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true}));
 esc();await x.drain();
 assert.equal(x.$('.pip-agent-card'),null);assert.ok(x.$('.pip-agent-map'));
 esc();await x.drain();
 assert.equal(x.$('.pip-agent-map'),null);
 assert.equal(x.d.activeElement?.id,'chat-agents');
});

test('a DGC before sub-agents (Pips API 96) keeps the cards it had and is never asked for sub-agents',async()=>{
 const x=setup({api:96,scene:{fix:'ask'}});await x.drain();await x.openPip(GST);await x.drain();
 assert.ok(x.$('.pip-found-findings'));assert.ok(x.$('.pip-found-ask'));
 assert.equal(x.$('.pip-ask-card'),null);assert.equal(x.$('#chat-agents'),null);
 assert.equal(x.requests('list_pip_agents').length,0);
});

test('what DGC sends about a sub-agent is checked: one this editor cannot read is left out',async()=>{
 const {agentsPage}=await import('../src/pipChat.js');
 const ok={id:AGENT,pip_id:GST,kind:'fix',fix_id:FIX,title:'Fix 1 thing',state:'working',try:1,tries:3,run_id:FIXRUN,run_status:'running',started_at:new Date().toISOString(),model:'m',held:[],notes:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 const page=agentsPage({agents:[ok,{...ok,id:'x'},{...ok,id:'pipagent_'+'2'.repeat(32),state:'dancing'},{...ok,id:'pipagent_'+'3'.repeat(32),pip_id:'pip_'+'f'.repeat(32)}],slots:1},GST);
 assert.deepEqual(page.agents.map(a=>a.id),[AGENT]);assert.equal(page.slots,1);
 assert.throws(()=>agentsPage({agents:'no'},GST));
});

test('the host passes the sub-agent commands only to a DGC that has them, and only well-formed',async()=>{
 const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
 const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:'/w'}}]}}:require(name));
 const {pipAgentsRefusal}=out.exports;
 assert.equal(pipAgentsRefusal({type:'list_pips'},40),'','not its business');
 for(const type of ['list_pip_agents','stop_pip_agent','retry_pip_fix'])assert.match(pipAgentsRefusal({type,pip_id:GST},96),/Update DGC/,type);
 assert.equal(pipAgentsRefusal({type:'list_pip_agents',pip_id:GST},97),'');
 assert.match(pipAgentsRefusal({type:'list_pip_agents',pip_id:'x'},97),/Choose a Pip/);
 assert.equal(pipAgentsRefusal({type:'stop_pip_agent',pip_id:GST,agent_id:AGENT},97),'');
 assert.match(pipAgentsRefusal({type:'stop_pip_agent',pip_id:GST,agent_id:'../x'},97),/sub-agent/);
 assert.equal(pipAgentsRefusal({type:'retry_pip_fix',pip_id:GST,fix_id:FIX,again:false},97),'');
 assert.match(pipAgentsRefusal({type:'retry_pip_fix',pip_id:GST,fix_id:FIX},97),/Try again, or Leave it/);
});
