// One Pips (0.52, his calls of 13 Nov; Pips API 94): one list for every Pip, where the Pips page had Personal | Project
// tabs. "Should we have made them like only one? ... Single Pips section becomes much cleaner"; "the new latest message
// pip should auto come on top, like it happens on messaging apps ... Except of Core Pip". From list_pips {scope: "all"}:
// Core first, then the latest activity; a Pip whose new message arrives moves to the top at once, but the list holds
// still while the pointer is over it or a row has the keyboard. Each row says where its Pip works. The filter line
// (All Pips · Personal · each folder) is at the left under the search, and Needs attention follows it. The search is
// always on top and looks across every Pip. An older DGC keeps today's two tabs. The side bar's view, as main.js mounts it.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setup as open} from './support/one-pips-node.mjs';
import {P,SHOP,GARDEN,RIVERSIDE,CORE,MORNINGS,GST,ERP,BEDS,HERE,GARDEN_DIR,RIVERSIDE_DIR,NOTES} from './support/one-pips-scene.mjs';
import {orderPips,heldOrder,placeOf,listRequest,attentionFor,newPipFolder,ALL,PERSONAL} from '../src/pipsOne.js';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open(options);windows.push(x.w);return x;};

test('one list, no Personal | Project tabs: every Pip from list_pips {scope: "all"}, Core first, then DGC\'s order',async()=>{
 const x=setup();await x.drain();
 assert.equal(x.$('[role="tablist"]'),null,'no tabs');assert.equal(x.$('#pips-tabpanel'),null);
 assert.ok(x.requests('list_pips').some(r=>r.scope==='all'),'the list is read with scope all');
 assert.deepEqual(x.rows(),[CORE,GST,ERP,MORNINGS,BEDS],'Core is pinned first; the rest are in the order DGC gave (the latest activity first)');
 assert.equal(x.$('.pips-one-home h2')?.textContent,'Your Pips');
});

test('Core stays first even when DGC lists it later, and a Core of a folder is an ordinary Pip',()=>{
 const p=(id,ws,type='scout')=>({id,workspace_id:ws,pip_type:type});
 const listed=[p('b',RIVERSIDE),p('core',P,'core'),p('c',P),p('x',RIVERSIDE,'core')];
 assert.deepEqual(orderPips(listed,{personalId:P}).map(v=>v.id),['core','b','c','x']);
 assert.deepEqual(orderPips(listed,{personalId:P,bumps:new Map([['c',2],['x',1]])}).map(v=>v.id),['core','c','x','b'],'what just arrived goes up, newest first, under Core');
 assert.deepEqual(heldOrder(orderPips(listed,{personalId:P,bumps:new Map([['c',2]])}),['core','b','c']).map(v=>v.id),['core','b','c','x'],'held still: the places drawn stay, a new Pip goes to the end');
});

test('each row says where its Pip works under its name: "Personal", or its folder with the home folder as ~',async()=>{
 const x=setup();await x.drain();
 const place=id=>x.$(`.pips-one-list [data-job="${id}"] .pip-row-place`);
 assert.equal(place(CORE)?.textContent.trim(),'Personal');assert.equal(place(MORNINGS).textContent.trim(),'Personal');
 assert.equal(place(GST).textContent.trim(),'~/code/riverside_shop');assert.equal(place(GST).title,RIVERSIDE_DIR,'the whole path is the tooltip');
 assert.equal(place(BEDS).textContent.trim(),'~/code/garden');
 const small=x.$(`.pips-one-list [data-job="${GST}"] small`);
 assert.ok(small.firstElementChild===place(GST),'the place comes first under the name');
 assert.match(small.textContent.replace(/\s+/g,' '),/^~\/code\/riverside_shop · \S/,'then its status, as before');
 assert.deepEqual(placeOf({workspace_id:RIVERSIDE},{personalId:P,folderOf:()=>({folder:'/x/y',shown:'/x/y',exists:false})}),{kind:'folder',shown:'/x/y',full:'/x/y',name:'',missing:true});
});

test('a Pip whose new message arrives moves to the top at once, under Core',async()=>{
 const x=setup();await x.drain();
 assert.deepEqual(x.rows().slice(0,3),[CORE,GST,ERP]);
 x.state.unread[BEDS]={id:'msg_'+'5'.repeat(32),latest:'The beds are planned.'};
 x.message({type:'pipsUnreadChanged'});await x.drain();
 assert.deepEqual(x.rows(),[CORE,BEDS,GST,ERP,MORNINGS],'Bed planner is on top (never above Core), from the event alone');
 assert.match(x.$(`.pips-one-list [data-job="${BEDS}"] small`).textContent,/The beds are planned\./,'and its row says the new message');
 x.state.unread[MORNINGS]={id:'msg_'+'6'.repeat(32),latest:'Good morning.'};
 x.message({type:'pipsUnreadChanged'});await x.drain();
 assert.deepEqual(x.rows().slice(0,3),[CORE,MORNINGS,BEDS],'the newest arrival is first');
});

test('the list holds still while the pointer is over it, and reorders when the pointer leaves',async()=>{
 const x=setup();await x.drain();
 const before=x.rows();
 x.over(x.$(`.pips-one-list [data-job="${ERP}"]`),'mouseover');
 x.state.unread[BEDS]={id:'msg_'+'5'.repeat(32),latest:'The beds are planned.'};
 x.message({type:'pipsUnreadChanged'});await x.drain();
 assert.deepEqual(x.rows(),before,'nothing moved under the pointer');
 assert.match(x.$(`.pips-one-list [data-job="${BEDS}"] small`).textContent,/The beds are planned\./,'the row still says its news, in place');
 // To another row of the list: still over it.
 x.over(x.$(`.pips-one-list [data-job="${ERP}"]`),'mouseout',x.$(`.pips-one-list [data-job="${GST}"]`));await x.wait(160);await x.drain();
 assert.deepEqual(x.rows(),before,'moving between rows is not leaving');
 x.over(x.$(`.pips-one-list [data-job="${GST}"]`),'mouseout',x.$('#pip-search'));await x.wait(160);await x.drain();
 assert.deepEqual(x.rows(),[CORE,BEDS,GST,ERP,MORNINGS],'the pointer left: the list takes the latest order');
});

test('the list holds still while one of its rows has the keyboard',async()=>{
 const x=setup();await x.drain();
 const before=x.rows();
 x.$(`.pips-one-list [data-job="${GST}"]`).focus();
 x.state.unread[BEDS]={id:'msg_'+'5'.repeat(32),latest:'The beds are planned.'};
 x.message({type:'pipsUnreadChanged'});await x.drain();
 assert.deepEqual(x.rows(),before,'nothing moved under the keyboard');
 assert.equal(x.d.activeElement?.dataset.job,GST,'and the focus is where it was');
 x.$('#pip-search').focus();await x.wait(20);await x.drain();
 assert.deepEqual(x.rows(),[CORE,BEDS,GST,ERP,MORNINGS],'the keyboard left the list: it reorders');
});

test('the filter line is at the left under the search: All Pips by default, then Personal and each folder',async()=>{
 const x=setup();await x.drain();
 const home=x.$('.pips-one'),kids=[...home.children],search=x.$('.pips-one-search'),line=x.$('.pips-one-filter'),list=x.$('.pips-one-home');
 assert.ok(search&&line&&list,'the search, the filter line and the list');
 assert.ok(kids.indexOf(search)===0,'the search is on top');
 assert.ok(kids.indexOf(line)===1,'the filter line is next');
 assert.ok(kids.indexOf(line)<kids.indexOf(x.$('.attention'))&&kids.indexOf(x.$('.attention'))<kids.indexOf(list),'Needs attention is between the filter line and the list');
 const button=x.$('#pips-filter');
 assert.equal(button.querySelector('.dgc-folder-v').textContent,'All Pips');assert.equal(button.getAttribute('aria-haspopup'),'menu');
 button.click();await x.drain();
 const menu=[...x.d.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')];
 assert.deepEqual(menu.map(r=>r.querySelector('.dgc-menu-label').textContent),['All Pips','Personal','shop','garden','riverside_shop','notes']);
 assert.equal(menu[0].getAttribute('aria-checked'),'true');
 menu.find(r=>r.dataset.folder===RIVERSIDE_DIR).click();await x.drain();
 assert.equal(x.$('#pips-filter .dgc-folder-v').textContent,'riverside_shop');
 assert.deepEqual(x.rows(),[GST,ERP],'only that folder\'s Pips');
 assert.deepEqual(x.requests('list_pips').at(-1),{type:'list_pips',workspace_id:RIVERSIDE,order:'recent',limit:100},'read from that folder\'s project, latest first');
 assert.equal(x.states.at(-1)?.pips_filter,RIVERSIDE_DIR,'and the choice is kept with the view');
});

test('Personal shows the Pips with no folder; a folder with no Pips says so; a folder DGC has no project for reads nothing',async()=>{
 const x=setup();await x.drain();
 const choose=async value=>{x.$('#pips-filter').click();await x.drain();[...x.d.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')].find(r=>r.dataset.folder===value).click();await x.drain();};
 await choose(PERSONAL);
 assert.equal(x.$('#pips-filter .dgc-folder-v').textContent,'Personal');
 assert.deepEqual(x.rows(),[CORE,MORNINGS]);
 await choose(HERE);
 assert.deepEqual(x.rows(),[]);assert.match(x.text(),/No Pips in shop yet\./);
 const before=x.requests('list_pips').length;
 await choose(NOTES);
 assert.match(x.text(),/No Pips in notes yet\./);
 assert.equal(x.requests('list_pips').length,before,'nothing is asked of DGC for a folder with no project');
 assert.equal(listRequest(NOTES,{personalId:P,folders:[{folder:NOTES,workspace_id:null}]}),null);
 await choose(ALL);
 assert.deepEqual(x.rows(),[CORE,GST,ERP,MORNINGS,BEDS],'All Pips again');
});

test('Needs attention, its count and its cards follow the filter line',async()=>{
 const x=setup({api:96,scene:{fix:'ask'}});await x.drain();
 const count=()=>x.$('.attention-count')?.textContent||'0';
 assert.equal(count(),'3','All Pips: every Pip\'s cards (a fix to allow, what only you can do, an email)');
 assert.deepEqual(x.requests('list_pip_attention').at(-1).projects,'all');
 const choose=async value=>{x.$('#pips-filter').click();await x.drain();[...x.d.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')].find(r=>r.dataset.folder===value).click();await x.drain();};
 await choose(RIVERSIDE_DIR);
 assert.equal(count(),'2','riverside_shop: its two');
 assert.equal(x.requests('list_pip_attention').at(-1).projects,RIVERSIDE);
 await choose(PERSONAL);
 assert.equal(count(),'1','Personal: the email');
 assert.ok(!('projects' in x.requests('list_pip_attention').at(-1)));
 await choose(GARDEN_DIR);
 assert.equal(x.$('.attention'),null,'garden: nothing waits, no section');
 // The page decides it too: a list read for another choice shows none of that choice's cards.
 const page={total:3,items:[{workspace_id:P},{workspace_id:RIVERSIDE},{workspace_id:RIVERSIDE}]};
 assert.equal(attentionFor(page,GARDEN_DIR,{personalId:P,folders:[{folder:GARDEN_DIR,workspace_id:GARDEN}]}).items.length,0);
 assert.equal(attentionFor(page,RIVERSIDE_DIR,{personalId:P,folders:[{folder:RIVERSIDE_DIR,workspace_id:RIVERSIDE}]}).total,2);
 assert.equal(attentionFor(page,ALL).total,3);
});

test('Needs attention says Hide or Show as a word, with no chevron (folded in from the folder-line work)',async()=>{
 const x=setup({api:96,scene:{fix:'ask'}});await x.drain();
 const toggle=x.$('#attention-toggle');
 assert.equal(toggle.textContent.trim(),'Hide');assert.equal(toggle.querySelector('svg,.codicon'),null,'no mark beside it');
 toggle.click();await x.drain();
 assert.equal(x.$('#attention-toggle').textContent.trim(),'Show');
});

test('the search is always on top and looks across every Pip',async()=>{
 const x=setup();await x.drain();
 const box=x.$('#pip-search');
 assert.ok(box,'there with five Pips (it used to wait for a paged list)');assert.equal(box.placeholder,'Search your Pips');assert.equal(box.type,'search');
 box.value='audit';box.dispatchEvent(new x.w.Event('input',{bubbles:true,composed:true}));await x.wait(300);await x.drain();
 assert.deepEqual(x.requests('list_pips').at(-1),{type:'list_pips',scope:'all',limit:100,query:'audit'},'one search over all of them');
 assert.deepEqual(x.rows(),[ERP]);
 assert.ok(x.$('#pip-search'),'still on top while it searches');assert.equal(x.$('.attention'),null,'Needs attention steps aside for what was found');
 box.value='zzz';x.$('#pip-search').value='zzz';x.$('#pip-search').dispatchEvent(new x.w.Event('input',{bubbles:true,composed:true}));await x.wait(300);await x.drain();
 assert.match(x.text(),/No Pip matches “zzz”/);
});

test('a row opens its Pip in the one page and chat, whichever folder it works in; back is the one list',async()=>{
 const x=setup();await x.drain();
 x.$(`.pips-one-list [data-job="${GST}"]`).click();await x.drain();
 assert.equal(x.$('.pip-topbar .pip-pill .pip-conv-name, .pip-topbar .pip-pill>span:not(.avatar)')?.textContent.trim(),'GST watchdog');
 assert.ok(x.$('#chat-form'),'its chat');
 assert.equal(x.$('.pip-topbar .pip-where')?.textContent,'riverside_shop','its folder beside its name');
 x.$('#simple-back').click();await x.drain();
 assert.deepEqual(x.rows(),[CORE,GST,ERP,MORNINGS,BEDS],'back at the one list, all of it');
 x.$(`.pips-one-list [data-job="${MORNINGS}"]`).click();await x.drain();
 assert.ok(x.$('#chat-form'));assert.equal(x.$('.pip-topbar .pip-where'),null,'a Personal Pip says no folder');
});

test('an older DGC keeps today\'s two tabs',async()=>{
 const x=setup({api:93});await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('[role="tab"]')].map(t=>t.textContent.trim().replace(/[0-9]+$/,'')),['Personal','Project']);
 assert.equal(x.$('.pips-one-list'),null);assert.equal(x.$('#pips-filter'),null);
 assert.ok(!x.requests('list_pips').some(r=>r.scope==='all'),'and is never asked for scope all');
});

test('with no Pips at all, Core is met first, under the search and the filter line',async()=>{
 const x=setup({scene:{empty:true}});await x.drain();
 assert.ok(x.$('.meet-core'));assert.ok(x.$('#pip-search'));assert.ok(x.$('#pips-filter'));
});

test('the host lets scope "all" through to a DGC that has it, and never to an older one',()=>{
 const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:'/w'}}]}}:require(name));
 const {projectFoldersRefusal}=out.exports;
 assert.equal(projectFoldersRefusal({type:'list_pips',scope:'all',limit:100},94,()=>false),'');
 assert.match(projectFoldersRefusal({type:'list_pips',scope:'all',limit:100},93,()=>false),/Update DGC/);
 assert.equal(projectFoldersRefusal({type:'list_pips',scope:'projects'},93,()=>false),'');
 assert.match(projectFoldersRefusal({type:'list_pips',scope:'everything'},96,()=>false),/List one project/);
});

test('New Pip\'s folder is pre-filled from where you are: the filter\'s folder, else the folder it was asked from, else none',()=>{
 const rows=[{folder:HERE,exists:true},{folder:RIVERSIDE_DIR,exists:true},{folder:NOTES,exists:false}];
 assert.equal(newPipFolder(RIVERSIDE_DIR,rows),RIVERSIDE_DIR);
 assert.equal(newPipFolder(ALL,rows,HERE),HERE,'from a Work session: its folder');
 assert.equal(newPipFolder(ALL,rows),'','else none: a Personal Pip');
 assert.equal(newPipFolder(PERSONAL,rows,HERE),'','Personal chosen: none, whatever asked');
 assert.equal(newPipFolder(NOTES,rows),'','a folder that is gone is not offered');
});
