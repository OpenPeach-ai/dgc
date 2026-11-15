// One New Pip (his "perfect", 13 Nov): the Personal form's character and name, plus one folder line pre-filled from
// where you are: the filter's folder, or the folder it was asked for from (a Work session's), else "+ Give it a
// folder", which is a Pip with no folder (Personal). One click changes it; it is decided at creation. No goal, no
// branch and no model fields: "we don't want user to define the goal while creating a Pip"; it sets itself up in its
// own chat. The separate Project form is gone; Describe the job to DGC and a shared Pip's file stay one click away.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {setup as open} from './support/one-pips-node.mjs';
import {P,SHOP,LIME,HERE,LIME_DIR,GARDEN_DIR} from './support/one-pips-scene.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open(options);windows.push(x.w);return x;};
const newPip=async x=>{x.$('#simple-new').click();await x.drain();return x.dialog();};

test('one New Pip: a character, a name and a folder line; no goal, branch or model',async()=>{
 const x=setup();await x.drain();
 const d=await newPip(x);
 assert.ok(d,'a dialog');assert.equal(d.querySelector('#review-title')?.textContent,'New Pip');
 assert.ok(d.querySelector('#new-pip-character'),'the character');assert.ok(d.querySelector('#newPipName'),'the name');
 assert.ok(d.querySelector('#new-pip-folder'),'the folder line');
 for(const gone of ['#goal','#source_ref','#createModel','#new-pip-model','#new-pip-kind','#name'])assert.equal(d.querySelector(gone),null,`${gone}: the Project form's field is gone`);
 assert.doesNotMatch(x.squash(d.textContent),/What it does|Branch or commit|What should it do|Model/);
 assert.match(x.squash(d.textContent),/It says hello and sets itself up in its chat\./);
});

test('on All Pips the folder line says "+ Give it a folder": a Pip with no folder is a Personal Pip',async()=>{
 const x=setup();await x.drain();
 const d=await newPip(x),line=d.querySelector('#new-pip-folder');
 assert.equal(line.querySelector('.dgc-folder-v').textContent,'+ Give it a folder');
 assert.match(x.squash(d.querySelector('.new-pip-folder').textContent),/No folder: it is listed under Personal\./);
 x.type(d.querySelector('#newPipName'),'Travel');
 d.querySelector('#review-confirm').click();await x.drain();
 const made=x.requests('create_pip').at(-1);
 assert.deepEqual(made,{type:'create_pip',workspace_id:P,pip_type:'scout',name:'Travel',goal:'',source_ref:'HEAD',model_choice:{mode:'default'}},'made in Personal, with no goal');
 assert.ok(x.requests('introduce_pip').length>=1,'it says hello');
 assert.ok(x.$('#chat-form'),'and its chat opens');
});

test('with a folder chosen on the filter line, New Pip opens on that folder, and the Pip is made there',async()=>{
 const x=setup();await x.drain();
 await x.choose(LIME_DIR);
 const d=await newPip(x);
 assert.equal(d.querySelector('#new-pip-folder .dgc-folder-v').textContent,'lime_tiles','pre-filled from the filter');
 assert.equal(d.querySelector('.new-pip-folder-path')?.title,LIME_DIR,'its path under it');
 x.type(d.querySelector('#newPipName'),'Invoice checker');
 d.querySelector('#review-confirm').click();await x.drain();
 const made=x.requests('create_pip').at(-1);
 assert.equal(made.workspace_id,LIME,'in that folder\'s project');assert.equal(made.goal,'','still no goal');assert.equal(made.name,'Invoice checker');
 assert.ok(x.$('#chat-form'),'its chat opens');
 assert.equal(x.$('.pip-topbar .pip-where')?.textContent,'lime_tiles');
});

test('asked for from a Work session, the folder line is that session\'s folder',async()=>{
 const x=setup();await x.drain();
 const going=x.app.navigate({create:'pip',folder:GARDEN_DIR});await x.drain();await going;await x.drain();
 const d=x.dialog();
 assert.ok(d,'New Pip is open');
 assert.equal(d.querySelector('#new-pip-folder .dgc-folder-v').textContent,'garden');
});

test('one click changes the folder: any folder, no folder, or Add a folder…',async()=>{
 const x=setup();await x.drain();
 await x.choose(LIME_DIR);
 let d=await newPip(x);
 d.querySelector('#new-pip-folder').click();await x.drain();
 const menu=[...x.d.querySelectorAll('.dgc-folder-menu .dgc-menu-row')];
 assert.equal(menu[0].querySelector('.dgc-menu-label').textContent,'No folder (Personal)');
 assert.ok(menu.some(r=>r.dataset.folderAdd),'Add a folder… is at its end');
 assert.equal(menu.find(r=>r.dataset.folder===LIME_DIR).getAttribute('aria-checked'),'true');
 assert.ok(menu.find(r=>/notes$/.test(r.dataset.folder||'')).disabled,'a folder that is gone can\'t be chosen');
 menu.find(r=>r.dataset.folder===HERE).click();await x.drain();
 d=x.dialog();
 assert.equal(d.querySelector('#new-pip-folder .dgc-folder-v').textContent,'shop');
 d.querySelector('#new-pip-folder').click();await x.drain();
 [...x.d.querySelectorAll('.dgc-folder-menu .dgc-menu-row')][0].click();await x.drain();
 d=x.dialog();
 assert.equal(d.querySelector('#new-pip-folder .dgc-folder-v').textContent,'+ Give it a folder','back to none');
 x.type(d.querySelector('#newPipName'),'Notes');d.querySelector('#review-confirm').click();await x.drain();
 assert.equal(x.requests('create_pip').at(-1).workspace_id,P,'the folder is decided here, at creation: none');
});

test('a name is needed; nothing is made without one',async()=>{
 const x=setup();await x.drain();
 const d=await newPip(x);
 d.querySelector('#review-confirm').click();await x.drain();
 assert.match(x.squash(x.dialog().textContent),/Give it a name\./);
 assert.equal(x.requests('create_pip').length,0);
});

test('Describe the job to DGC and a shared Pip\'s file stay reachable from New Pip, once it has a folder',async()=>{
 const x=setup();await x.drain();
 let d=await newPip(x);
 assert.equal(d.querySelector('#new-pip-describe'),null,'with no folder there is no job form: it is set up in its chat');
 x.dialog().querySelector('#review-cancel').click();await x.drain();
 await x.choose(HERE);
 d=await newPip(x);
 assert.equal(d.querySelector('#new-pip-describe')?.textContent,'Describe the job to DGC instead');
 assert.equal(d.querySelector('#import-pip-file')?.textContent,'Import a shared Pip…');
 d.querySelector('#new-pip-describe').click();await x.drain();
 assert.equal(x.dialog(),null,'the dialog closed');
 assert.ok(x.$('#setupTask'),'the describe page, in that folder\'s project');
 assert.ok(x.requests('list_pips').some(r=>r.workspace_id===SHOP),'whose project is what is loaded under it');
});

test('an older DGC keeps the two forms',async()=>{
 const x=setup({api:93});await x.drain();
 x.$('#simple-new').click();await x.drain();
 assert.equal(x.dialog().querySelector('#new-pip-folder'),null,'the Personal form has no folder line there');
});
