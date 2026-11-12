// The Project Folder dropdown in the Pips view (0.52, 12 Nov; Pips API 93): the Project tab has the same dropdown as the
// Work sessions, on the same kept choice. All projects (the default) lists every project's Pips, each with its folder; a
// folder shows that folder's Pips ("No Project Pips in <name> yet." where it has none). This reverses the 21 Oct
// "Project = this window's folder only": a Project Pip from another folder opens here. Needs attention asks for the
// Project Pips' cards of the choice, and each names its project. Create a Project Pip has a folder field: this window's
// folder first, no All projects, "Add a folder…" (the editor's own folder picker, then add_project_folder). An older DGC
// has none of it (test/pips-scope-tabs.test.mjs holds that). The side bar's Pips view, mounted as main.js mounts it.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const strip=(await build({entryPoints:[src+'pipHomeStrip.js'],bundle:true,write:false,format:'esm'})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
// Personal, this window's project, another project, and a project made when a folder is added.
const PW='ws_'+hex('e'),W='ws_'+hex('d'),X='ws_'+hex('9'),N='ws_'+hex('7');
const CORE='pip_'+hex('c'),AUDIT='pip_'+hex('a'),OTHER='pip_'+hex('b'),MADE='pip_'+hex('f');
const HERE='/home/me/code/erp-tools',BILLING='/home/me/code/billing-app',NOTES='/home/me/code/notes',OLD='/home/me/code/old-site',PICKED='/home/me/code/picked-shop';
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,workspace,name,type,extra={})=>({id,workspace_id:workspace,pip_type:type,name,goal:'Review the exports',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,created_at:'2026-11-01T09:00:00Z',updated_at:'2026-11-01T09:00:00Z',...extra});
const core=pip(CORE,PW,'Core','core',{source_policy:{mode:'personal'}}),audit=pip(AUDIT,W,'ERP daily audit','rook'),other=pip(OTHER,X,'Billing app watcher','scout');
const folders=()=>[
 {folder:BILLING,name:'billing-app',here:false,exists:true,sessions:0,pips:1,workspace_id:X,updated_at:'2026-11-12T03:30:00.000Z'},
 {folder:HERE,name:'erp-tools',here:true,exists:true,sessions:2,pips:1,workspace_id:W,updated_at:'2026-11-10T04:45:00.000Z'},
 {folder:NOTES,name:'notes',here:false,exists:true,sessions:3,pips:0,workspace_id:null,updated_at:'2026-11-05T02:30:00.000Z'},
 {folder:OLD,name:'old-site',here:false,exists:false,sessions:1,pips:0,workspace_id:null,updated_at:'2026-10-01T02:30:00.000Z'}];
const card=(n,pipRow,title)=>({id:`email:maildraft_${hex(String(n))}`,kind:'email',card:`maildraft_${hex(String(n))}`,pip_id:pipRow.id,pip_name:pipRow.name,pip_type:pipRow.pip_type,workspace_id:pipRow.workspace_id,title,detail:'Ready to send',created_at:`2026-11-12T0${n}:00:00Z`,expires_at:null});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

/** `choice`: what the host says is chosen ("" All projects). `api`: the DGC's Pips API. `refuse`: add_project_folder's refusal. */
function setup({choice='',api=93,saved,refuse='',attention=[]}={}){
 const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),listeners=new Set(),states=[];
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
 w.eval(client);
 const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
 const app=w.DgcPips.mount({root:shadow,postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>saved,setState(s){states.push(s);}});
 const message=data=>listeners.forEach(l=>l(data));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:result})});};
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const pips={[PW]:[core],[W]:[audit],[X]:[other],[N]:[]},made=[];
 const spaces=[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'erp-tools',kind:'git'},{id:X,name:'billing-app',kind:'git'}];
 const every=()=>[core,audit,other,...made];
 const reply=r=>({list_workspaces:()=>({workspaces:spaces,current_workspace_id:W}),
  list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  list_project_folders:()=>({folders:folders()}),
  add_project_folder:()=>{if(refuse)return {error:{code:'invalid_request',message:refuse}};if(!spaces.some(s=>s.id===N))spaces.push({id:N,name:r.folder.split('/').pop(),kind:'git'});return {workspace:{id:N,name:r.folder.split('/').pop(),kind:'git'}};},
  list_pips:()=>r.scope==='projects'?{pips:[other,audit,...made],total:2+made.length,next_offset:null}:{pips:pips[r.workspace_id]||[],total:(pips[r.workspace_id]||[]).length,next_offset:null},
  create_pip:()=>{const p=pip(MADE,r.workspace_id,r.name,r.pip_type);made.push(p);(pips[r.workspace_id]||=[]).push(p);return {pip:p};},
  get_pip:()=>{const p=every().find(p=>p.id===r.pip_id);return p?{pip:p}:{error:{code:'not_found',message:'That Pip isn’t on this computer. It may have been deleted.'}};},
  list_pip_runs:()=>({runs:[]}),get_workspace_context:()=>({context:{workspace_id:r.workspace_id,revision:0,entries:[]}}),
  list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:every().find(p=>p.id===r.pip_id)?.workspace_id||PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0}),
  // Project Pips' cards come only for the projects asked for.
  list_pip_attention:()=>{const items=attention.filter(i=>i.workspace_id===PW||r.projects==='all'||r.projects===i.workspace_id);
   return {as_of:new Date().toISOString(),total:items.length,counts:{email:items.length},by_pip:Object.fromEntries(items.map(i=>[i.pip_id,1])),items,truncated:false,reviews:[],projects:{},in_projects:0};},
  get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),list_pip_unread:()=>({workspace_id:r.workspace_id,pips:[],total:0}),
  list_pip_approvals:()=>({approvals:[],next_cursor:null}),list_pip_checkpoints:()=>({checkpoints:[],next_cursor:null}),get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<24;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=reply(m.request);if(result===undefined)continue;if(result.error)answer(m,result.error,false);else answer(m,result);}}await flush();}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true,folder:true,projectFolder:choice,home:'/home/me',windowFolder:{folder:HERE,name:'erp-tools'}});
 const $=s=>shadow.querySelector(s),text=()=>(shadow.querySelector('.pip-app-root')?.textContent||'').replace(/\s+/g,' ');
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type).map(m=>m.request);
 const click=async s=>{const e=typeof s==='string'?$(s):s;assert.ok(e,`${s} is on the page`);e.click();await drain();};
 const tab=async name=>click(`#pips-tab-${name}`);
 const posted=type=>sent.filter(m=>m.type===type).map(({documentId,...m})=>m);
 const rows=()=>[...shadow.querySelectorAll('[data-project-pip]')].map(r=>[r.dataset.projectPip,r.querySelector('.pip-row-name')?.textContent,(r.querySelector('.dgc-path-head')?.textContent||'')+(r.querySelector('.dgc-path-tail')?.textContent||''),r.querySelector('.dgc-path')?.title]);
 const menu=()=>[...shadow.querySelectorAll('.dgc-folder-menu [data-folder], .dgc-folder-menu [data-folder-add]')].map(r=>[r.dataset.folder??'add',r.querySelector('.dgc-menu-label').textContent,r.getAttribute('aria-checked'),r.disabled]);
 return {w,d:shadow,$,app,sent,message,drain,text,states,requests,click,tab,posted,rows,menu,made,chosen:()=>shadow.querySelector('[role="tab"][aria-selected="true"]')?.id||null};
}

test('the Project tab has the Project Folder dropdown; All projects, the default, lists every project\'s Pips, each with its folder',async()=>{
 const x=setup();await x.drain();
 assert.equal(x.requests('list_project_folders').length>0,true,'the folders are read from DGC');
 assert.equal(x.$('#pips-folder-pick'),null,'Personal Pips are not filtered: no dropdown on the Personal tab');
 await x.tab('project');
 assert.equal(x.chosen(),'pips-tab-project');
 const pick=x.$('#pips-folder-pick');
 assert.ok(pick,'the dropdown, above the Project tab\'s list');
 assert.equal(pick.textContent.replace(/\s+/g,' ').trim(),'Project Folder All projects');
 assert.equal(pick.closest('#pips-tabpanel')?.getAttribute('aria-labelledby'),'pips-tab-project','inside the tab\'s panel');
 assert.deepEqual(x.requests('list_pips').filter(r=>r.scope==='projects').map(({type,...r})=>r).at(-1),{scope:'projects',order:'recent',limit:100},'every project\'s Pips, in one request');
 assert.deepEqual(x.rows(),[[OTHER,'Billing app watcher','~/code/billing-app',BILLING],[AUDIT,'ERP daily audit','~/code/erp-tools',HERE]],'each Pip says its folder under its name, the home folder as ~, the whole path in its tooltip');
 assert.equal(x.$(`[data-job="${CORE}"]`),null,'none of your Personal Pips');
 // The menu: All projects, then the folders, this window's and a gone one marked.
 await x.click('#pips-folder-pick');
 assert.deepEqual(x.menu(),[['','All projects','true',false],[BILLING,'billing-app','false',false],[HERE,'erp-tools','false',false],[NOTES,'notes','false',false],[OLD,'old-site','false',false]]);
 assert.deepEqual([...x.d.querySelectorAll('.dgc-folder-menu .dgc-folder-note')].map(n=>n.textContent),['This window','Not found']);
 // A choice goes to the extension, which keeps it for every window and says it back.
 await x.click(`.dgc-folder-menu [data-folder="${BILLING}"]`);
 assert.deepEqual(x.posted('pipsProjectFolderChoose'),[{type:'pipsProjectFolderChoose',folder:BILLING}]);
 assert.equal(x.d.querySelector('.dgc-folder-menu'),null,'the menu closes');
});

test('a folder chosen shows that folder\'s Pips, its path in the dropdown\'s tooltip (no line of its own); a folder with none says so',async()=>{
 const x=setup({choice:BILLING});await x.drain();await x.tab('project');
 assert.equal(x.$('#pips-folder-pick').textContent.replace(/\s+/g,' ').trim(),'Project Folder billing-app');
 assert.ok(x.$(`#pips-tabpanel [data-job="${OTHER}"]`),'the chosen folder\'s Pips, though it is not this window\'s');
 assert.equal(x.$(`[data-job="${AUDIT}"]`),null,'and no other folder\'s');
 assert.equal(x.requests('list_pips').some(r=>r.workspace_id===X),true,'read from that folder\'s workspace');
 // (Asked 12 Nov night: the dropdown is on the Needs attention line, or on a line as tall when nothing waits, and no line names the path.)
 assert.equal(x.$('.pips-folder-once, .pips-folder-bar'),null,'no line of its own for the path');
 assert.equal(x.$('#pips-folder-pick').title,`Project Folder: billing-app\n${BILLING}`,'its path, in the tooltip');
 assert.equal(x.$('#pips-folder-pick').getAttribute('aria-label'),'Project Folder: billing-app');
 assert.ok(x.$('#pips-folder-pick').closest('dgc-folder-fit')?.closest('.attention-head'),'on the heading\'s line');
 // The host says another choice (made here, or over the Work sessions): the tab follows it.
 x.message({type:'pipsProjectFolder',folder:NOTES});await x.drain();
 assert.equal(x.chosen(),'pips-tab-project','the tab stays');
 assert.equal(x.$('#pips-folder-pick').textContent.replace(/\s+/g,' ').trim(),'Project Folder notes');
 assert.match(x.$('#pips-tabpanel').textContent,/No Project Pips in notes yet\./);
 assert.equal(x.$('#pips-tabpanel [data-job]'),null);
 x.message({type:'pipsProjectFolder',folder:''});await x.drain();
 assert.equal(x.$('#pips-folder-pick').textContent.replace(/\s+/g,' ').trim(),'Project Folder All projects');
 assert.equal(x.rows().length,2,'All projects again');
 x.message({type:'pipsProjectFolder',folder:HERE});await x.drain();
 assert.ok(x.$(`#pips-tabpanel [data-job="${AUDIT}"]`),'this window\'s folder, as one of the folders');
 assert.equal(x.$(`[data-job="${OTHER}"]`),null);
});

test('a Project Pip from another folder opens here: from the list, and from a link (no "another project\'s Pip" refusal)',async()=>{
 const x=setup();await x.drain();await x.tab('project');
 await x.click(`[data-project-pip="${OTHER}"]`);
 assert.equal(x.requests('list_pip_messages').some(r=>r.pip_id===OTHER),true,'its chat is read: it is open');
 assert.match(x.text(),/Billing app watcher/);
 assert.doesNotMatch(x.text(),/another project’s Pip|Open that project’s folder/);
 assert.equal(x.chosen(),null,'its own page (no tab bar inside a Pip), as this window\'s Pips open');
 // Back to the list: every project's Pips again, not only that folder's.
 const back=x.app.navigate({overview:true});await x.drain();await back;await x.drain();
 assert.equal(x.chosen(),'pips-tab-project');
 assert.equal(x.rows().length,2);
 // From a link while Personal shows (a Work chat's card, a notification).
 const y=setup();await y.drain();
 const going=y.app.navigate({pip:OTHER,section:'chat'});await y.drain();await going;await y.drain();
 assert.doesNotMatch(y.text(),/another project’s Pip|Open that project’s folder/);
 assert.equal(y.requests('list_pip_messages').some(r=>r.pip_id===OTHER),true,'it opens');
});

test('Needs attention asks for the Project Pips of the choice, and a Project Pip\'s card names its project',async()=>{
 const mine=card(1,core,'Send the weekly summary?'),theirs=card(2,other,'Email the billing report?');
 const x=setup({attention:[mine,theirs]});await x.drain();
 assert.equal(x.requests('list_pip_attention').every(r=>r.projects==='all'),true,'All projects: every Project Pip\'s cards too');
 x.message({type:'pipsProjectFolder',folder:BILLING});await x.drain();
 assert.equal(x.requests('list_pip_attention').at(-1).projects,X,'one folder: its workspace');
 x.message({type:'pipsProjectFolder',folder:NOTES});await x.drain();
 assert.equal('projects' in x.requests('list_pip_attention').at(-1),false,'a folder with no workspace adds nothing');
 x.message({type:'pipsProjectFolder',folder:''});await x.drain();
 // On the Project tab: the Project Pips' cards, each naming its project. Personal Pips' cards stay on Personal.
 await x.tab('project');
 const cards=()=>[...x.d.querySelectorAll('.attention-row, [data-attention], [data-attention-open]')].map(n=>n.closest('.attention-row, li, article, section')||n);
 assert.match(x.text(),/Email the billing report\?/);
 assert.match(x.text(),/Billing app watcher · billing-app · Email/,'the card says whose it is and in which project');
 assert.doesNotMatch(x.text(),/Send the weekly summary\?/,'a Personal Pip\'s card is on the Personal tab');
 await x.tab('personal');
 assert.match(x.text(),/Send the weekly summary\?/,'Personal Pips\' cards always show');
 assert.doesNotMatch(x.text(),/Core · [a-z-]+ · Email/,'and name no project');
 assert.ok(cards);
});

test('Create a Project Pip has the folder field: this window\'s folder first, no All projects, a gone folder can\'t be chosen, Add a folder… last',async()=>{
 const x=setup({choice:HERE});await x.drain();await x.tab('project');
 await x.click('#simple-new');
 const pick=x.$('#new-pip-folder');
 assert.ok(pick,'the folder field in the form');
 assert.equal(pick.textContent.replace(/\s+/g,' ').trim(),'Project Folder erp-tools','this window\'s folder by default');
 await x.click('#new-pip-folder');
 assert.deepEqual(x.menu(),[[BILLING,'billing-app','false',false],[HERE,'erp-tools','true',false],[NOTES,'notes','false',false],[OLD,'old-site','false',true],['add','Add a folder…',null,false]]);
 // Another folder that is a project already: the Pip is made in its workspace, and opens here.
 await x.click(`.dgc-folder-menu [data-folder="${BILLING}"]`);
 assert.equal(x.$('#new-pip-folder').textContent.replace(/\s+/g,' ').trim(),'Project Folder billing-app');
 assert.deepEqual(x.posted('pipsProjectFolderChoose'),[],'the form\'s folder is its own: the list\'s choice stays');
 x.$('#name').value='Invoice checker';x.$('#name').dispatchEvent(new x.w.Event('input',{bubbles:true}));
 x.$('#goal').value='Check the invoices';x.$('#goal').dispatchEvent(new x.w.Event('input',{bubbles:true}));
 await x.click('#review-confirm');
 assert.equal(x.requests('add_project_folder').length,0,'a folder that is a project already is not added again');
 assert.deepEqual(x.requests('create_pip').map(r=>[r.workspace_id,r.name]),[[X,'Invoice checker']],'made in the chosen folder\'s workspace');
 assert.equal(x.requests('list_pip_messages').some(r=>r.pip_id===MADE),true,'and it opens here');
});

test('Create a Project Pip: Add a folder… asks the editor for a folder, adds it as a project, and makes the Pip there; DGC\'s refusal shows in the form',async()=>{
 const x=setup({choice:HERE});await x.drain();await x.tab('project');
 await x.click('#simple-new');await x.click('#new-pip-folder');
 await x.click('.dgc-folder-menu [data-folder-add]');
 const asked=x.posted('pipsPickFolder');
 assert.equal(asked.length,1,'the extension is asked for the editor\'s own folder picker');
 assert.equal(x.requests('add_project_folder').length,0,'nothing is added until a folder is picked');
 // Closed without a folder: nothing changes.
 x.message({type:'pipsFolderPicked',id:asked[0].id,folder:null});await x.drain();
 assert.equal(x.$('#new-pip-folder').textContent.replace(/\s+/g,' ').trim(),'Project Folder erp-tools');
 await x.click('#new-pip-folder');await x.click('.dgc-folder-menu [data-folder-add]');
 x.message({type:'pipsFolderPicked',id:x.posted('pipsPickFolder').at(-1).id,folder:PICKED});await x.drain();
 assert.deepEqual(x.requests('add_project_folder').map(({type,...r})=>r),[{folder:PICKED}],'the folder picked becomes a project');
 assert.equal(x.$('#new-pip-folder').textContent.replace(/\s+/g,' ').trim(),'Project Folder picked-shop','and is the form\'s folder');
 x.$('#name').value='Shop watcher';x.$('#name').dispatchEvent(new x.w.Event('input',{bubbles:true}));
 x.$('#goal').value='Watch the shop';x.$('#goal').dispatchEvent(new x.w.Event('input',{bubbles:true}));
 await x.click('#review-confirm');
 assert.deepEqual(x.requests('create_pip').map(r=>[r.workspace_id,r.name]),[[N,'Shop watcher']],'create_pip with the added folder\'s workspace');
 // DGC refuses a folder (the home folder, DGC's own, one that is gone): its own words, in the form.
 const y=setup({choice:HERE,refuse:'Choose a project\'s own folder, not the whole computer or your home folder.'});await y.drain();await y.tab('project');
 await y.click('#simple-new');await y.click('#new-pip-folder');await y.click('.dgc-folder-menu [data-folder-add]');
 y.message({type:'pipsFolderPicked',id:y.posted('pipsPickFolder').at(-1).id,folder:'/home/me'});await y.drain();
 assert.match(y.d.querySelector('#review-root').textContent,/Choose a project's own folder, not the whole computer or your home folder\./,'said in the form');
 assert.equal(y.$('#new-pip-folder').textContent.replace(/\s+/g,' ').trim(),'Project Folder erp-tools','the folder chosen before stays');
 assert.equal(y.requests('create_pip').length,0);
});

test('an older DGC (Pips API 92) has no dropdown, lists this window\'s project, and asks Needs attention as before',async()=>{
 const x=setup({api:92,choice:BILLING});await x.drain();await x.tab('project');
 assert.equal(x.$('#pips-folder-pick'),null);
 assert.ok(x.$(`#pips-tabpanel [data-job="${AUDIT}"]`),'this window\'s project');
 assert.equal(x.requests('list_project_folders').length,0,'never asked for folders');
 assert.equal(x.requests('list_pips').some(r=>'scope' in r),false);
 assert.equal(x.requests('list_pip_attention').some(r=>'projects' in r),false);
 await x.click('#simple-new');
 assert.equal(x.$('#new-pip-folder'),null,'no folder field in its form');
 const going=x.app.navigate({pip:OTHER,section:'chat'});await x.drain();await going;await x.drain();
 assert.match(x.text(),/Billing app watcher is another project’s Pip\. Open that project’s folder to see it\./,'another project\'s Pip stays out, as before');
});

// ---- the extension's side (src/pipsView.ts) ----------------------------------------------------------------------------
function host({picked,api=93}={}){
 const pickers=[],vscode={workspace:{workspaceFolders:[{uri:{fsPath:HERE}}]},window:{showOpenDialog:async o=>{pickers.push(o);return picked?[{fsPath:picked}]:undefined;}},Uri:{file:p=>({fsPath:p})}};
 const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?vscode:require(name));
 const posted=[],sentToDgc=[],editor=new out.exports.PipsEditor({},m=>{sentToDgc.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
 const kept={folder:''},chosen=[];
 editor.useProjectFolder?.({choice:()=>kept.folder,choose:f=>{chosen.push(f);kept.folder=f;}});
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api,session_scopes:true},{});
 const generation=posted.filter(m=>m.type==='pipsConnection').at(-1).generation;
 const ask=(request,id='r1')=>editor.receive({type:'pipsRequest',id,generation,request});
 return {editor,posted,sentToDgc,pickers,chosen,kept,generation,ask,connection:()=>posted.filter(m=>m.type==='pipsConnection').at(-1)};
}
const settle=()=>new Promise(done=>setTimeout(done,0));

test('the extension tells the Pips view the choice kept, and keeps the one made there',async()=>{
 const h=host();
 assert.equal(h.connection().projectFolder,'','All projects until something is chosen');
 assert.deepEqual(h.connection().windowFolder,{folder:HERE,name:'erp-tools'},'this window\'s folder, for Create a Project Pip');
 // The folders DGC lists are the ones that can be chosen.
 h.ask({type:'list_project_folders'});
 const asked=h.sentToDgc.at(-1).request;
 assert.equal(asked.type,'list_project_folders');
 h.editor.event({type:'pips_result',ok:true,command:'list_project_folders',request_id:asked.request_id,result:{folders:folders()}});
 h.editor.receive({type:'pipsProjectFolderChoose',folder:BILLING});
 assert.deepEqual(h.chosen,[BILLING]);
 h.editor.receive({type:'pipsProjectFolderChoose',folder:'/somewhere/never/listed'});
 h.editor.receive({type:'pipsProjectFolderChoose',folder:'relative'});
 assert.deepEqual(h.chosen,[BILLING],'only All projects or a folder DGC listed');
 h.editor.receive({type:'pipsProjectFolderChoose',folder:''});
 assert.deepEqual(h.chosen,[BILLING,'']);
 // A choice made over the Work sessions reaches an open Pips view.
 h.kept.folder=NOTES;h.editor.projectFolderChanged();
 assert.deepEqual(h.posted.filter(m=>m.type==='pipsProjectFolder').at(-1),{type:'pipsProjectFolder',folder:NOTES});
 // A Pip's "Reports to" picker says which Pip, so a Pip of another folder gets its own folder's sessions.
 const titled=[];h.editor.useWorkSessions(async id=>{titled.push(id);return [];});
 h.ask({type:'list_work_session_titles',pip_id:OTHER},'w1');h.ask({type:'list_work_session_titles'},'w2');h.ask({type:'list_work_session_titles',pip_id:'../x'},'w3');await settle();
 assert.deepEqual(titled,[OTHER,undefined,undefined]);
 // An older DGC: nothing about folders is said or asked.
 const old=host({api:92});
 assert.equal('projectFolder' in old.connection(),false);
 old.ask({type:'list_project_folders'});
 assert.equal(old.sentToDgc.some(m=>m.request?.type==='list_project_folders'),false,'never sent to a DGC that doesn\'t know it');
 assert.match(old.posted.filter(m=>m.type==='pipsReply').at(-1)?.error?.message||'',/Update DGC/);
});

test('Add a folder… is the editor\'s own folder picker, and only a folder it gave (or one DGC listed) can be added as a project',async()=>{
 const h=host({picked:PICKED});
 h.ask({type:'add_project_folder',folder:PICKED},'a1');
 assert.equal(h.sentToDgc.some(m=>m.request?.type==='add_project_folder'),false,'a folder the page names by itself is not added');
 assert.match(h.posted.filter(m=>m.type==='pipsReply').at(-1)?.error?.message||'',/Choose the folder with Add a folder/);
 h.editor.receive({type:'pipsPickFolder',id:'p1'});await settle();
 assert.deepEqual([h.pickers.length,h.pickers[0].canSelectFolders,h.pickers[0].canSelectFiles,h.pickers[0].canSelectMany],[1,true,false,false],'folders only, one');
 assert.deepEqual(h.posted.filter(m=>m.type==='pipsFolderPicked').at(-1),{type:'pipsFolderPicked',id:'p1',folder:PICKED});
 h.ask({type:'add_project_folder',folder:PICKED},'a2');
 assert.deepEqual(h.sentToDgc.filter(m=>m.request?.type==='add_project_folder').map(m=>m.request.folder),[PICKED],'the folder picked goes to DGC');
 // Closed without a folder.
 const none=host();
 none.editor.receive({type:'pipsPickFolder',id:'p2'});await settle();
 assert.deepEqual(none.posted.filter(m=>m.type==='pipsFolderPicked').at(-1),{type:'pipsFolderPicked',id:'p2',folder:null});
});

// ---- Home's cards (src/pipHomeStrip.js) --------------------------------------------------------------------------------
test('Home\'s Pip cards follow the choice: the Project Pips of All projects or of one folder, each card naming its project',async()=>{
 const mod=await import('data:text/javascript;base64,'+Buffer.from(strip).toString('base64'));
 const theirs=card(2,other,'Email the billing report?');
 const run=async folder=>{
  const asked=[];let model=null,home=null;
  const reply=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'erp-tools',kind:'git'},{id:X,name:'billing-app',kind:'git'}],current_workspace_id:W}),
   list_project_folders:()=>({folders:folders()}),
   list_pips:()=>({pips:r.workspace_id===PW?[core]:r.workspace_id===W?[audit]:r.workspace_id===X?[other]:[],next_offset:null}),
   get_pip_digest:()=>({digest:{schema_version:1,since:'2026-11-03T00:00:00.000Z',until:'2026-11-03T12:00:00.000Z',first:false,due:false,reason:null,headline:'Your Pips',pips:[],omitted_pips:0,failed_runs:0,pending_reviews:0,pending_setups:0,truncated:false}}),
   list_pip_attention:()=>{const items=r.projects==='all'||r.projects===X?[theirs]:[];return {as_of:'2026-11-12T12:00:00.000Z',total:items.length,counts:{},by_pip:Object.fromEntries(items.map(i=>[i.pip_id,1])),items,truncated:false,reviews:[],projects:{[X]:{total:1,by_pip:{[OTHER]:1}}},in_projects:0};},
   list_pip_unread:()=>({workspace_id:r.workspace_id,pips:[],total:0})}[r.type]?.());
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true});windows.push(dom.window);
  home=mod.mountHomePips({document:dom.window.document,setInterval:()=>0,clearInterval(){},postMessage:m=>{if(m.type!=='pipsRequest')return;asked.push(m.request);const result=reply(m.request);
    queueMicrotask(()=>home.receive({type:'pipsReply',id:m.id,ok:result!==undefined,...(result!==undefined?{result}:{error:{message:'no'}})}));},
   onOpen(){},onModel:m=>{model=m;},dismissed:{},onDismissed(){},projectFolder:()=>folder});
  home.receive({type:'pipsConnection',generation:1,apiVersion:93,connected:true,supported:true,enabled:true});
  for(let i=0;i<60;i++){await settle();if(model?.ready&&asked.some(r=>r.type==='list_pip_attention'))break;}
  await settle();await settle();home.dispose();
  return {asked,model};
 };
 const all=await run('');
 assert.equal(all.asked.find(r=>r.type==='list_pip_attention').projects,'all');
 assert.deepEqual(all.model.cards.filter(c=>c.pip===OTHER).map(c=>[c.scope,c.project,c.title]),[['project','billing-app','Email the billing report?']],'another folder\'s Project Pip has its card on Home, naming its project');
 assert.equal(all.model.need,1,'counted once');
 const one=await run(BILLING);
 assert.equal(one.asked.find(r=>r.type==='list_pip_attention').projects,X,'one folder: its workspace');
 assert.equal(one.model.cards.filter(c=>c.pip===OTHER).length,1);
 const none=await run(NOTES);
 assert.equal('projects' in none.asked.find(r=>r.type==='list_pip_attention'),false,'a folder with no workspace adds nothing');
 assert.deepEqual(none.model.cards.filter(c=>c.scope==='project'),[]);
 const before=await run(null);
 assert.equal('projects' in before.asked.find(r=>r.type==='list_pip_attention'),false,'no dropdown (an older DGC): asked as before');
 assert.equal(before.asked.some(r=>r.type==='list_project_folders'),false);
});
