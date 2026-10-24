// Personal | Project: two tabs on the Pips page, as the Sessions home has Chat | Work, where a dropdown listed your
// Personal Pips and every project DGC knows. The founder, 2026-10-21: "tabs would look better and make more sense", and
// "for Project Pips, it should only show the opened project's Pips, not other projects', as that might confuse the
// user, who might ask that project's main DGC to fix another project's Pips." With no folder open the Project tab says
// so in one line; the chosen tab is remembered per window. The side bar's Pips view, mounted as main.js mounts it.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
// Personal, this window's project, and another project DGC knows from another window.
const PW='ws_'+hex('e'),W='ws_'+hex('d'),X='ws_'+hex('9');
const CORE='pip_'+hex('c'),AUDIT='pip_'+hex('a'),OTHER='pip_'+hex('b');
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,workspace,name,type,extra={})=>({id,workspace_id:workspace,pip_type:type,name,goal:'Review the exports',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const core=pip(CORE,PW,'Core','core',{source_policy:{mode:'personal'}}),audit=pip(AUDIT,W,'ERP daily audit','rook'),other=pip(OTHER,X,'Billing app watcher','scout');
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

/** `folder`: what the host says (undefined: an older host that doesn't). `current`: list_workspaces' current_workspace_id (null: none). */
function setup({folder=true,current=W,saved,api=58,host,workspaces}={}){
 const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),listeners=new Set(),states=[];
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
 w.eval(client);
 const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
 const app=w.DgcPips.mount({root:shadow,...(host?{host}:{}),postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>saved,setState(s){states.push(s);}});
 const message=data=>listeners.forEach(l=>l(data));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:result})});};
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const pips={[PW]:[core],[W]:[audit],[X]:[other]};
 const listed=workspaces||[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'erp-tools',kind:'git'},{id:X,name:'billing-app',kind:'git'}];
 const reply=r=>({list_workspaces:()=>({workspaces:listed,...(current===null?{}:{current_workspace_id:current})}),
  list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  list_pips:()=>({pips:pips[r.workspace_id]||[],total:(pips[r.workspace_id]||[]).length,next_offset:null}),
  get_pip:()=>{const p=[core,audit,other].find(p=>p.id===r.pip_id);return p?{pip:p}:{error:{code:'not_found',message:'That Pip isn’t on this computer. It may have been deleted.'}};},
  list_pip_runs:()=>({runs:[]}),get_workspace_context:()=>({context:{workspace_id:r.workspace_id,revision:0,entries:[]}}),
  list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:[core,audit,other].find(p=>p.id===r.pip_id)?.workspace_id||PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0}),
  list_pip_attention:()=>({as_of:new Date().toISOString(),total:0,counts:{},by_pip:{},items:[],truncated:false}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
  list_pip_approvals:()=>({approvals:[],next_cursor:null}),list_pip_checkpoints:()=>({checkpoints:[],next_cursor:null}),get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<20;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=reply(m.request);if(result===undefined)continue;if(result.error)answer(m,result.error,false);else answer(m,result);}}await flush();}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true,...(folder===undefined?{}:{folder})});
 const $=s=>shadow.querySelector(s),text=()=>(shadow.querySelector('.pip-app-root')?.textContent||'').replace(/\s+/g,' ');
 const key=async(el,k)=>{el.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true,composed:true,cancelable:true}));await drain();};
 const listed_for=()=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type==='list_pips').map(m=>m.request.workspace_id);
 return {w,d:shadow,$,app,sent,drain,text,key,states,listedFor:listed_for,tab:name=>$(`#pips-tab-${name}`),chosen:()=>shadow.querySelector('[role="tab"][aria-selected="true"]')?.id||null};
}

test('Personal | Project are tabs, as on the Sessions home: roles, one tab stop, and the panel they control',async()=>{
 const x=setup();await x.drain();
 assert.equal(x.$('select'),null,'no dropdown on the Pips page');
 const list=x.$('[role="tablist"]');assert.ok(list,'a tab list');
 const tabs=[...list.querySelectorAll('[role="tab"]')];
 assert.deepEqual(tabs.map(t=>t.textContent.trim()),['Personal','Project']);
 assert.ok(list.getAttribute('aria-label'),'the tab list is named');
 assert.deepEqual(tabs.map(t=>[t.id,t.getAttribute('aria-selected'),t.tabIndex]),[['pips-tab-personal','true',0],['pips-tab-project','false',-1]],
  'Personal is chosen first, and only the chosen tab is a tab stop');
 assert.ok(tabs.every(t=>t.tagName==='BUTTON'&&t.type==='button'&&t.title),'each is a button that says what it shows on hover');
 const panel=x.$('#pips-tabpanel');
 assert.ok(tabs.every(t=>t.getAttribute('aria-controls')==='pips-tabpanel'),'both control the one panel');
 assert.equal(panel?.getAttribute('role'),'tabpanel');
 assert.equal(panel.getAttribute('aria-labelledby'),'pips-tab-personal');
 assert.ok(panel.querySelector(`[data-job="${CORE}"]`),'the panel is your Personal Pips');
});

test('the tabs take the Sessions home tabs\' keys: an arrow goes to the other tab, Home and End to the ends, and the focus follows',async()=>{
 const x=setup();await x.drain();
 x.tab('personal').focus();
 await x.key(x.tab('personal'),'ArrowRight');
 assert.equal(x.chosen(),'pips-tab-project');assert.equal(x.d.activeElement?.id,'pips-tab-project','the focus moves to the tab chosen');
 assert.equal(x.tab('project').tabIndex,0);assert.equal(x.tab('personal').tabIndex,-1);
 assert.equal(x.$('#pips-tabpanel')?.getAttribute('aria-labelledby'),'pips-tab-project');
 assert.ok(x.$(`#pips-tabpanel [data-job="${AUDIT}"]`),'the panel is this project\'s Pips');
 await x.key(x.tab('project'),'ArrowRight');
 assert.equal(x.chosen(),'pips-tab-personal','with two tabs, an arrow either way is the other one');
 await x.key(x.tab('personal'),'ArrowLeft');
 assert.equal(x.chosen(),'pips-tab-project');
 await x.key(x.tab('project'),'Home');
 assert.equal(x.chosen(),'pips-tab-personal');assert.equal(x.d.activeElement?.id,'pips-tab-personal');
 await x.key(x.tab('personal'),'End');
 assert.equal(x.chosen(),'pips-tab-project');assert.equal(x.d.activeElement?.id,'pips-tab-project');
 await x.key(x.tab('project'),'Enter');
 assert.equal(x.chosen(),'pips-tab-project','other keys leave the tabs alone');
 x.tab('personal').click();await x.drain();
 assert.equal(x.chosen(),'pips-tab-personal','a click chooses too');
 assert.ok(x.$(`[data-job="${CORE}"]`));assert.equal(x.$(`[data-job="${AUDIT}"]`),null,'one tab\'s Pips at a time');
});

test('Project is the open folder\'s Pips only: another project\'s are never listed, read or offered',async()=>{
 const x=setup();await x.drain();
 const offers=()=>[...x.d.querySelectorAll('button,option,a,[role="tab"]')].filter(n=>/billing/i.test(n.textContent+(n.title||'')));
 assert.deepEqual(offers().map(n=>n.textContent.trim()),[],'no choice anywhere on the page opens another project (the dropdown offered "Project · billing-app")');
 x.tab('project').click();await x.drain();
 assert.ok(x.$(`[data-job="${AUDIT}"]`),'this project\'s Pip');
 assert.equal(x.$(`[data-job="${OTHER}"]`),null);
 assert.doesNotMatch(x.text(),/billing-app|Billing app watcher/,'not another project, by name or by its Pips');
 assert.ok(x.listedFor().every(id=>id===PW||id===W),`only Personal and this project are read (${x.listedFor()})`);
 assert.deepEqual(offers().map(n=>n.textContent.trim()),[],'nothing offers it');
 x.tab('personal').click();await x.drain();x.tab('project').click();await x.drain();
 assert.ok(!x.listedFor().includes(X),'switching back and forth never reads it either');
});

test('a Pip of another project, opened from a link, stays out: it says where it lives',async()=>{
 const x=setup();await x.drain();
 const going=x.app.navigate({pip:OTHER,section:'runs'});await x.drain();await going;await x.drain();
 assert.match(x.text(),/Billing app watcher is another project’s Pip\. Open that project’s folder to see it\./);
 assert.equal(x.$(`[data-job="${OTHER}"]`),null,'it is not opened');
 assert.ok(!x.listedFor().includes(X),'nor its project read');
 assert.equal(x.chosen(),'pips-tab-personal','the tab you were on stays');
 assert.ok(x.$(`[data-job="${CORE}"]`));
});

test('a Pip of this project, opened from a Work chat, opens under the Project tab',async()=>{
 const x=setup();await x.drain();
 const going=x.app.navigate({pip:AUDIT,section:'chat'});await x.drain();await going;await x.drain();
 // A Project Pip has the Personal Pips page (24 Oct): its chat has no tabs over it, so the Pip is open in its page and
 // its way back is to the Project tab's list.
 assert.equal(x.$('.pip-topbar .pip-pill>span:not(.avatar)')?.textContent,'ERP daily audit','and the Pip is open');
 assert.equal(x.states.at(-1)?.scope_tab,'project');
 x.$('#simple-back').click();await x.drain();
 assert.equal(x.chosen(),'pips-tab-project');
 assert.ok(x.$(`[data-job="${AUDIT}"]`),'under the Project tab');
 const back=x.app.navigate({pip:CORE,section:'chat'});await x.drain();await back;await x.drain();
 assert.ok(['pips-tab-personal',null].includes(x.chosen()),'a Personal Pip opens under Personal (its chat has no tabs)');
 assert.ok(x.listedFor().includes(PW));
});

for(const [name,options] of [['no folder is open',{folder:false}],['the open folder has no workspace',{current:null}],['the folder\'s workspace is not listed',{current:'ws_'+hex('7')}]]){
 test(`when ${name}, the Project tab is there and says so in one line`,async()=>{
  const x=setup(options);await x.drain();
  assert.ok(x.tab('project'),'the tab is not hidden');
  assert.match(x.tab('project').title,/Open a project folder/);
  const before=x.listedFor().length;
  x.tab('project').click();await x.drain();
  assert.equal(x.chosen(),'pips-tab-project');
  const panel=x.$('#pips-tabpanel');
  assert.equal(panel?.getAttribute('aria-labelledby'),'pips-tab-project');
  assert.equal(panel.textContent.trim(),'Open a project folder to see its Pips.');
  assert.equal(panel.querySelectorAll('button').length,0,'one plain line');
  assert.equal(x.$('[data-job]'),null,'no Pips under it');
  assert.equal(x.listedFor().length,before,'and nothing read for it');
  assert.ok(!x.listedFor().some(id=>id===W||id===X),'never the folder DGC happened to start in, or another project');
  x.tab('personal').click();await x.drain();
  assert.equal(x.chosen(),'pips-tab-personal');assert.ok(x.$(`[data-job="${CORE}"]`),'Personal is one click back');
 });
}

test('the tab is remembered per window: the page opens on the one chosen last',async()=>{
 const first=setup();await first.drain();
 first.tab('project').click();await first.drain();
 const saved=first.states.at(-1);
 assert.equal(saved?.scope_tab,'project');
 const again=setup({saved});await again.drain();
 assert.equal(again.chosen(),'pips-tab-project','reopened on Project');
 assert.equal(again.listedFor()[0],W,'reading this project first, not Personal');
 again.tab('personal').click();await again.drain();
 const back=setup({saved:again.states.at(-1)});await back.drain();
 assert.equal(back.chosen(),'pips-tab-personal');
 // Chosen with no folder open, it is the Project tab again, with its line, until a folder is open.
 const empty=setup({folder:false});await empty.drain();empty.tab('project').click();await empty.drain();
 const blank=setup({folder:false,saved:empty.states.at(-1)});await blank.drain();
 assert.equal(blank.chosen(),'pips-tab-project');
 assert.equal(blank.$('#pips-tabpanel')?.textContent.trim(),'Open a project folder to see its Pips.');
 const opened=setup({saved:empty.states.at(-1)});await opened.drain();
 assert.equal(opened.chosen(),'pips-tab-project');assert.ok(opened.$(`[data-job="${AUDIT}"]`),'and once one is, its Pips');
});

test('a view saved on another project, by the old dropdown, opens on Personal',async()=>{
 const x=setup({saved:{workspace_id:X,selected:OTHER,tab:'chat',overview:false}});await x.drain();
 assert.equal(x.chosen(),'pips-tab-personal');
 assert.ok(!x.listedFor().includes(X));
});

test('a remote view and a CLI without Personal Pips keep their one workspace and no tabs, as before',async()=>{
 const remote=setup({host:'remote',workspaces:[{id:W,name:'erp-tools',kind:'git'},{id:X,name:'billing-app',kind:'git'}]});await remote.drain();
 assert.equal(remote.$('[role="tablist"]'),null);assert.equal(remote.$('#pips-tabpanel'),null);
 assert.ok(remote.$(`[data-job="${AUDIT}"]`));
 const old=setup({api:40,workspaces:[{id:W,name:'erp-tools',kind:'git'}]});await old.drain();
 assert.equal(old.$('[role="tablist"]'),null);assert.ok(old.$(`[data-job="${AUDIT}"]`));
});

test('an older CLI (before simple Pips) has the same two tabs over its full view',async()=>{
 const x=setup({api:42});await x.drain();
 assert.equal(x.chosen(),'pips-tab-project','it opens on the project, as it did');
 assert.ok(x.$(`#pips-tabpanel [data-job="${AUDIT}"]`));
 x.tab('personal').click();await x.drain();
 assert.equal(x.chosen(),'pips-tab-personal');assert.ok(x.$(`#pips-tabpanel [data-job="${CORE}"]`));
 assert.ok(!x.listedFor().includes(X));
});

test('the host tells the view whether a folder is open; an editor that does not say leaves it out',()=>{
 for(const [vscode,expected] of [[{workspace:{workspaceFolders:[{uri:{fsPath:'/w'}}]}},true],[{workspace:{workspaceFolders:undefined}},false],[{workspace:{workspaceFolders:[]}},false],[{},undefined]]){
  const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?vscode:require(name));
  const posted=[],editor=new out.exports.PipsEditor({},()=>true,()=>{});editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:58},{});
  const connection=posted.filter(m=>m.type==='pipsConnection').at(-1);
  assert.ok(connection,'a connection was posted');
  assert.equal(connection.folder,expected,JSON.stringify(vscode));
  assert.equal('folder' in connection,expected!==undefined);
 }
});
