// Give it a folder, and Remove its folder (Pips API 110, dgc/pip_folder.py; decided 14 Nov, for 0.52): a Pip for
// anything becomes a folder Pip for a folder you give it, and a folder Pip becomes a Pip for anything again, keeping its
// chat, notes, routines, computer, level and model. On its page the row that says where it works has the action at its
// end; its ⋯ menu has it too, with the action's own glyph. The folder comes from New Pip's own picker; DGC says what
// stays and what changes first (a dry run), in a confirmation; the Pip then opens again where it works now, its page
// and its header saying so. Core works on anything and is never offered it; an older DGC offers neither; the host lets
// a folder through only when its picker gave it, DGC listed it, or it is this window's.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setup as open} from './support/one-pips-node.mjs';
import {CORE,MORNINGS,ERP,P,SHOP,LIME,HERE,GARDEN_DIR,LIME_DIR} from './support/one-pips-scene.mjs';
import {offered,answerOf,confirmation,menuRowMarkup,pageButtonMarkup,GIVE_FOLDER_API} from '../src/pipGiveFolder.js';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open({api:110,...options});windows.push(x.w);return x;};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const page=async(x,id)=>{await x.drain();await x.openPip(id);await x.menu('job');};
const pick=async(x,folder)=>{[...x.d.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')].find(r=>r.dataset.folder===folder).click();await x.drain();};

test('which Pip is offered which: Give to a Pip for anything, Remove to a folder Pip, neither to Core or from an older DGC',()=>{
 const anything={id:'p',status:'active',pip_type:'quill',source_policy:{mode:'personal'}},folder={...anything,source_policy:{mode:'committed_only'}};
 assert.equal(offered(anything,{apiVersion:GIVE_FOLDER_API}),'give');
 assert.equal(offered(folder,{apiVersion:110}),'remove');
 assert.equal(offered({...anything,pip_type:'core'},{apiVersion:110}),'','Core works on anything');
 assert.equal(offered(anything,{apiVersion:109}),'','an older DGC can\'t');
 assert.equal(offered(anything,{apiVersion:110,remote:true}),'','on this computer only');
 assert.equal(offered({...anything,status:'archived'},{apiVersion:110}),'');
 assert.match(menuRowMarkup('give',{icon:a=>`<svg data-icon="${a}"></svg>`}),/data-give-folder="menu".*data-icon="give-folder".*Give it a folder…/);
 assert.match(pageButtonMarkup('remove'),/class="quiet pip-folder-move" id="pip-remove-folder"[^>]*>Remove its folder…</);
 assert.throws(()=>answerOf({pip:{id:'other',workspace_id:'w'},folder:{name:'shop'}},'p'),/another Pip/);
 const said=confirmation('give',answerOf({pip:{id:'p',workspace_id:'w'},folder:{name:'shop'},keeps:['It keeps <its> chat.'],changes:['It works on shop.']},'p'),{esc,name:'Mornings'});
 assert.equal(said.title,'Give Mornings the folder shop?');
 assert.match(said.body,/What stays.*It keeps &lt;its&gt; chat\..*What changes.*It works on shop\./s,'its own lines, escaped');
});

test('a Pip for anything: Give it a folder… at the end of "Works in" on its page, and in its ⋯ menu with the folder glyph',async()=>{
 const x=setup();await page(x,MORNINGS);
 const row=x.$('.pip-place-part .pip-page-row');
 assert.equal(x.squash(row.querySelector('.pip-folder-where').textContent),'No folder');
 assert.equal(row.lastElementChild.textContent,'Give it a folder…','at the row\'s end');
 assert.equal(row.querySelector('#pip-give-folder').className,'quiet pip-folder-move');
 const item=x.$('.pip-topbar .pip-menu [data-give-folder]');
 assert.ok(item,'in the page\'s ⋯ menu');assert.equal(item.querySelector('svg').dataset.icon,'give-folder');
 assert.equal(x.$('[data-remove-folder]'),null);
 x.$('#simple-to-chat').click();await x.drain();
 const chatItem=x.$('.pip-topbar .pip-menu [data-give-folder]');
 assert.ok(chatItem,'and in its chat\'s ⋯ menu');assert.equal(chatItem.querySelector('svg').dataset.icon,'give-folder','one action, one glyph');
});

test('Core is never offered a folder, and an older DGC offers neither row',async()=>{
 const x=setup();await page(x,CORE);
 assert.equal(x.$('[data-give-folder]'),null);
 const old=setup({api:109});await page(old,MORNINGS);
 assert.equal(old.$('[data-give-folder]'),null);
 const oldFolder=setup({api:109});await page(oldFolder,ERP);
 assert.equal(oldFolder.$('[data-remove-folder]'),null);
});

test('give it a folder: the picker, what stays and what changes, then it opens again in its folder, on its page',async()=>{
 const x=setup();await page(x,MORNINGS);
 x.$('#pip-give-folder').click();await x.drain();
 const rows=[...x.d.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')].map(r=>r.dataset.folder);
 assert.deepEqual(rows,[HERE,GARDEN_DIR,LIME_DIR],'New Pip\'s folders: this window\'s and DGC\'s, none that is gone');
 assert.ok(x.$('.dgc-folder-menu [data-folder-add]'),'Add a folder… at its end');
 await pick(x,GARDEN_DIR);
 const [asked]=x.requests('give_pip_folder');
 assert.deepEqual(asked,{type:'give_pip_folder',pip_id:MORNINGS,folder:GARDEN_DIR,dry_run:true},'DGC says first, and moves nothing');
 const dialog=x.dialog();
 assert.equal(x.squash(dialog.querySelector('h2').textContent),'Give Mornings the folder garden?');
 const heads=[...dialog.querySelectorAll('.pip-folder-move-head')].map(h=>h.textContent);
 assert.deepEqual(heads,['What stays','What changes']);
 assert.match(x.squash(dialog.textContent),/Its chat, notes and routines stay as they are\..*It works on garden/);
 assert.equal(x.squash(dialog.querySelector('#review-confirm').textContent),'Give it this folder');
 dialog.querySelector('#review-confirm').click();await x.drain();
 const sent=x.requests('give_pip_folder').at(-1);
 assert.deepEqual(sent,{type:'give_pip_folder',pip_id:MORNINGS,folder:GARDEN_DIR});
 assert.equal(x.dialog(),null,'the confirmation closed');
 const parts=x.$('.pip-folder-parts');
 assert.ok(parts,'its page now has its folder\'s rows');
 const where=parts.querySelector('.pip-page-row');
 assert.equal(where.querySelector('.pip-folder-where').title,GARDEN_DIR);
 assert.equal(where.lastElementChild.textContent,'Remove its folder…');
 assert.match(x.text(),/Mornings works in garden now\./);
 x.$('#simple-to-chat').click();await x.drain();
 assert.equal(x.$('.pip-topbar .pip-where')?.textContent,'garden','its header\'s folder line says where it works now');
 assert.ok(x.$('.pip-topbar .pip-menu [data-remove-folder]'),'and its ⋯ menu offers Remove');
});

test('remove its folder: what stays and what changes, then it is a Pip for anything again',async()=>{
 const x=setup();await page(x,ERP);
 const row=x.$('.pip-folder-parts .pip-page-row');
 assert.equal(row.querySelector('.pip-folder-where').title,LIME_DIR);
 assert.equal(row.lastElementChild.textContent,'Remove its folder…');
 row.querySelector('#pip-remove-folder').click();await x.drain();
 assert.deepEqual(x.requests('remove_pip_folder'),[{type:'remove_pip_folder',pip_id:ERP,dry_run:true}]);
 const dialog=x.dialog();
 assert.equal(x.squash(dialog.querySelector('h2').textContent),'Remove lime_tiles from ERP daily audit?');
 assert.match(x.squash(dialog.textContent),/with its copy of lime_tiles.*Name @lime_tiles in a message/);
 dialog.querySelector('#review-confirm').click();await x.drain();
 assert.deepEqual(x.requests('remove_pip_folder').at(-1),{type:'remove_pip_folder',pip_id:ERP});
 assert.equal(x.$('.pip-folder-parts'),null);
 assert.equal(x.squash(x.$('.pip-place-part .pip-folder-where').textContent),'No folder');
 assert.ok(x.$('.pip-place-part #pip-give-folder'),'Give it a folder… again');
 assert.match(x.text(),/ERP daily audit is a Pip for anything again\./);
});

test('from its chat\'s ⋯ menu: Remove asks the same way; Cancel sends nothing more than DGC\'s first word',async()=>{
 const x=setup();await x.drain();await x.openPip(ERP);
 x.$('.pip-topbar .pip-menu [data-remove-folder]').click();await x.drain();
 assert.ok(x.dialog(),'its confirmation');
 x.dialog().querySelector('#review-cancel').click();await x.drain();
 assert.deepEqual(x.requests('remove_pip_folder').map(r=>r.dry_run),[true]);
 assert.equal(x.backend.state.requests.filter(r=>r.type==='remove_pip_folder'&&!r.dry_run).length,0);
});

test('when DGC can\'t (it is working), its words say why, and nothing is offered to confirm',async()=>{
 const x=setup({scene:{moveError:'Mornings is working right now. Wait for it to finish, or stop it, then try again.'}});await page(x,MORNINGS);
 x.$('#pip-give-folder').click();await x.drain();await pick(x,LIME_DIR);
 const dialog=x.dialog();
 assert.match(x.squash(dialog.textContent),/Mornings is working right now\./);
 assert.equal(dialog.querySelector('#review-confirm'),null);
 assert.equal(x.squash(dialog.querySelector('#review-cancel').textContent),'Close');
});

test('the host sends a folder only when its picker gave it, DGC listed it, or it is this window\'s; never to an older DGC',async()=>{
 const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
 const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:'/w'}}]}}:require(name));
 const {projectFoldersRefusal}=out.exports,pip='pip_'+'b'.repeat(32),known=f=>f==='/home/me/code/garden';
 assert.equal(projectFoldersRefusal({type:'give_pip_folder',pip_id:pip,folder:'/home/me/code/garden',dry_run:true},110,known),'');
 assert.match(projectFoldersRefusal({type:'give_pip_folder',pip_id:pip,folder:'/etc'},110,known),/Choose the folder/);
 assert.match(projectFoldersRefusal({type:'give_pip_folder',pip_id:pip,folder:'relative'},110,()=>true),/Choose the folder/);
 assert.match(projectFoldersRefusal({type:'give_pip_folder',pip_id:pip,folder:'/home/me/code/garden'},109,known),/Update DGC/);
 assert.match(projectFoldersRefusal({type:'remove_pip_folder',pip_id:pip},109,known),/Update DGC/);
 assert.equal(projectFoldersRefusal({type:'remove_pip_folder',pip_id:pip},110,known),'');
 assert.match(projectFoldersRefusal({type:'remove_pip_folder',pip_id:'x'},110,known),/Choose a Pip/);
 assert.ok(P&&SHOP&&LIME);
});
