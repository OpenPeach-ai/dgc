// A Pip's on/off switch (0.52, asked 12 Nov), in the page's own script with a stub host: what each switch is, what it
// tells DGC, and what a refusal does. On is active, off is paused (dgc/pips.py: pause_pip and resume_pip take
// {pip_id, expected_lifecycle_revision} and answer {pip}; a revision that is not the Pip's is refused with
// "This Pip changed. Refresh, then try again."). Its layout and its black and white are checked in real Chromium
// (pip-switch-browser.test.mjs).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule={exports:{}};new Function('module','exports','require',view)(viewModule,viewModule.exports,name=>name==='vscode'?{}:require(name));
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PROJECT='ws_'+'1'.repeat(32);
const workspaces=[{id:PW,name:'Personal',kind:'personal'},{id:PROJECT,name:'demo_project',kind:'project'}];
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(c,name,type,extra={})=>({id:'pip_'+c.repeat(32),workspace_id:PW,pip_type:type,name,goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const REFUSED='This Pip changed. Refresh, then try again.';
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

/** The page with `jobs` listed. DGC's side of the switch is `store`: pause_pip and resume_pip change it and answer
    {pip}, as dgc/pips.py does; `refuse` makes it turn every one away, in DGC's words. */
function setup({apiVersion=43,jobs=[],current=PROJECT,refuse=false,hold=false}={}){
 const dom=new JSDOM(viewModule.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),store=jobs.map(p=>({...p})),held=[];
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(code);
 const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(request,result,ok=true)=>{answered.add(request.id);send({type:'pipsReply',id:request.id,ok,...(ok?{result}:{error:result})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type).map(m=>{const {type:_t,...rest}=m.request;return rest;});
 const turn=(r,on)=>{const found=store.find(p=>p.id===r.pip_id);if(refuse||!found||r.expected_lifecycle_revision!==found.lifecycle_revision)throw Error(REFUSED);found.status=on?'active':'paused';return {pip:{...found}};};
 const defaults=r=>({list_workspaces:()=>({workspaces,current_workspace_id:current}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:store.filter(p=>p.workspace_id===(r.workspace_id||PROJECT)).map(p=>({...p}))}),list_pip_flows:()=>({flows:[],core_suggestions:[]}),
  get_pip:()=>({pip:{...store.find(p=>p.id===r.pip_id)}}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:r.workspace_id||PW,revision:0,entries:[]}}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,continuity:null,chat_controls:controls}),
  list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  get_pip_computer:()=>({computer:{pip_id:r.pip_id,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  pause_pip:()=>turn(r,false),resume_pip:()=>turn(r,true)}[r.type]?.());
 async function drain(){for(let round=0;round<14;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){
   if(hold&&['pause_pip','resume_pip'].includes(m.request.type)){if(!held.includes(m))held.push(m);continue;}
   let result;try{result=defaults(m.request);}catch(error){answer(m,error.message,false);count++;continue;}
   if(result!==undefined){answer(m,result);count++;}}await flush();if(!count)break;}await flush();}
 send({type:'pipsConnection',apiVersion,connected:true,supported:true,enabled:true});
 const d=w.document,toggle=id=>d.querySelector(`[data-pip-switch="${id}"]`);
 return {w,d,sent,store,requests,drain,toggle,
  /** Answer a held pause or resume now, as DGC would. */
  release:async()=>{for(const m of held.splice(0)){try{answer(m,defaults(m.request));}catch(error){answer(m,error.message,false);}}await flush();},
  row:id=>{const b=d.querySelector(`.pip-row[data-job="${id}"]`),line=b?.closest('.pip-row-line');return b&&{says:b.querySelector('small').textContent,off:!!line?.classList.contains('is-off'),lined:!!line};}};
}
const CORE=pip('c','Core','core'),TRAVEL=pip('1','Travel','scout'),BILLS=pip('2','Bills','lens',{status:'paused',lifecycle_revision:3}),OLD=pip('3','Old mail','quill',{status:'archived'});
const personal=()=>[CORE,TRAVEL,BILLS,OLD];

test('each Pip in the Personal list has a switch at its row, on for a Pip that runs and off for a paused one; Core and an archived Pip have none',async()=>{
 const x=setup({jobs:personal()});await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('[data-pip-switch]')].map(b=>b.dataset.pipSwitch),[TRAVEL.id,BILLS.id],'Travel and Bills; not Core (the main chat\'s Pip)');
 const on=x.toggle(TRAVEL.id),off=x.toggle(BILLS.id);
 // The switch the maintainer gave, in the page's own markup: a real button with role="switch", and one span inside.
 for(const [b,checked] of [[on,true],[off,false]]){
  assert.equal(b.tagName,'BUTTON');assert.equal(b.getAttribute('type'),'button');assert.equal(b.getAttribute('role'),'switch');
  assert.equal(b.getAttribute('aria-checked'),String(checked));assert.equal(b.dataset.state,checked?'checked':'unchecked');
  assert.equal(b.children.length,1);assert.equal(b.firstElementChild.tagName,'SPAN');assert.equal(b.firstElementChild.dataset.state,b.dataset.state);
  assert.equal(b.disabled,false);assert.equal(b.hasAttribute('data-disabled'),false);
  assert.equal(b.closest('[data-job]'),null,'a control of its own, beside the row: never inside the row\'s button');
  assert.ok(b.classList.contains('switch'),'the one switch look the page has');
 }
 assert.match(on.getAttribute('aria-label'),/^Travel/);assert.match(off.getAttribute('aria-label'),/^Bills/);
 assert.deepEqual(x.row(TRAVEL.id),{says:'Ready when you are',off:false,lined:true});
 assert.deepEqual(x.row(BILLS.id),{says:'Off',off:true,lined:true},'an off Pip says Off in its line, and its row is marked off');
 assert.equal(x.row(CORE.id).lined,false);
});

test('switching a Pip off tells DGC to pause it with the revision the list holds, shows it at once, and never opens the Pip; on again resumes it',async()=>{
 const x=setup({jobs:personal(),hold:true});await x.drain();
 x.toggle(TRAVEL.id).click();await x.drain();
 assert.deepEqual(x.requests('pause_pip'),[{pip_id:TRAVEL.id,expected_lifecycle_revision:0}]);
 assert.equal(x.toggle(TRAVEL.id).getAttribute('aria-checked'),'false','off at once, while DGC is told');
 assert.equal(x.toggle(TRAVEL.id).dataset.state,'unchecked');assert.equal(x.row(TRAVEL.id).off,true);
 x.toggle(TRAVEL.id).click();await x.drain();
 assert.equal(x.requests('pause_pip').length,1,'a second press while DGC is told asks nothing more');assert.deepEqual(x.requests('resume_pip'),[]);
 await x.release();await x.drain();
 assert.equal(x.store.find(p=>p.id===TRAVEL.id).status,'paused');
 assert.deepEqual(x.row(TRAVEL.id),{says:'Off',off:true,lined:true});
 assert.deepEqual(x.requests('get_pip'),[],'the Pip was not opened');assert.deepEqual(x.requests('list_pip_messages'),[]);
 assert.ok(x.d.querySelector('.pip-rows'),'still on the list');assert.equal(x.d.querySelector('[role=alert]'),null);
 // Bills is off: its switch resumes it, with its own revision.
 x.toggle(BILLS.id).click();await x.drain();await x.release();await x.drain();
 assert.deepEqual(x.requests('resume_pip'),[{pip_id:BILLS.id,expected_lifecycle_revision:3}]);
 assert.deepEqual(x.row(BILLS.id),{says:'Ready when you are',off:false,lined:true},'its colour and its line come back');
 assert.equal(x.toggle(BILLS.id).getAttribute('aria-checked'),'true');
});

test('a refusal puts the switch back, says why in DGC\'s words, and reads the list again',async()=>{
 const x=setup({jobs:personal(),refuse:true,hold:true});await x.drain();
 const lists=x.requests('list_pips').length;
 x.toggle(TRAVEL.id).click();await x.drain();
 assert.equal(x.toggle(TRAVEL.id).getAttribute('aria-checked'),'false');
 await x.release();await x.drain();
 assert.equal(x.toggle(TRAVEL.id).getAttribute('aria-checked'),'true','back on');assert.equal(x.toggle(TRAVEL.id).dataset.state,'checked');
 assert.deepEqual(x.row(TRAVEL.id),{says:'Ready when you are',off:false,lined:true});
 assert.equal(x.d.querySelector('[role=alert]')?.textContent.trim(),REFUSED);
 assert.ok(x.requests('list_pips').length>lists,'the list is read again, so the next try carries what DGC holds now');
 assert.equal(x.store.find(p=>p.id===TRAVEL.id).status,'active');
});

test('the Project list has the same switch on each of its Pips',async()=>{
 const audit={...pip('4','Billing review','rook'),workspace_id:PROJECT,source_policy:{mode:'committed_only'}},docs={...pip('5','Docs drafts','quill',{status:'paused'}),workspace_id:PROJECT,source_policy:{mode:'committed_only'}};
 const x=setup({apiVersion:78,jobs:[audit,docs]});await x.drain();
 if(!x.d.querySelector(`.pip-row[data-job="${audit.id}"]`)){x.d.querySelector('[data-pips-tab="project"]')?.click();await x.drain();}
 assert.deepEqual([...x.d.querySelectorAll('[data-pip-switch]')].map(b=>[b.dataset.pipSwitch,b.getAttribute('aria-checked')]),[[audit.id,'true'],[docs.id,'false']]);
 assert.equal(x.row(docs.id).says,'Off');assert.equal(x.row(docs.id).off,true);
 x.toggle(audit.id).click();await x.drain();
 assert.deepEqual(x.requests('pause_pip'),[{pip_id:audit.id,expected_lifecycle_revision:0}]);
 assert.equal(x.row(audit.id).off,true);assert.deepEqual(x.requests('get_pip'),[]);
});

test('an off Pip\'s own chat and page say so: the same switch in the top bar, its pill marked off, and one quiet line over the prompt box',async()=>{
 const x=setup({jobs:personal()});await x.drain();
 x.d.querySelector(`.pip-row[data-job="${BILLS.id}"]`).click();await x.drain();
 const bar=()=>x.d.querySelector('.pip-topbar'),line=()=>x.d.querySelector('.pip-off-line')?.textContent||'';
 assert.ok(x.d.querySelector('#chat-form'),'its chat');
 assert.equal(bar().querySelector('.topbar-actions [role=switch]'),x.toggle(BILLS.id),'the same switch, in its top bar');
 assert.equal(x.toggle(BILLS.id).getAttribute('aria-checked'),'false');
 assert.ok(bar().querySelector('.pip-pill').classList.contains('is-off'));
 assert.equal(line(),'Off: it runs nothing on its own. It still answers when you write to it.');
 // Its page (Settings) keeps the switch and says Off.
 x.d.querySelector('[data-tab="job"]').click();await x.drain();
 assert.ok(bar().querySelector('.pip-pill').classList.contains('is-off'));assert.match(bar().querySelector('.pip-pill small').textContent,/Off/);
 assert.equal(bar().querySelector('.topbar-actions [role=switch]')?.getAttribute('aria-checked'),'false');
 // Switched on from its page: DGC resumes it, and nothing says Off any more.
 x.toggle(BILLS.id).click();await x.drain();
 assert.deepEqual(x.requests('resume_pip'),[{pip_id:BILLS.id,expected_lifecycle_revision:3}]);
 assert.equal(x.toggle(BILLS.id).getAttribute('aria-checked'),'true');
 assert.equal(bar().querySelector('.pip-pill').classList.contains('is-off'),false);assert.doesNotMatch(bar().querySelector('.pip-pill small').textContent,/Off/);
 x.d.querySelector('#simple-to-chat').click();await x.drain();
 assert.equal(line(),'','the line goes with it');
 // Core's own chat has no switch.
 x.d.querySelector('#simple-back').click();await x.drain();x.d.querySelector(`.pip-row[data-job="${CORE.id}"]`).click();await x.drain();
 assert.equal(bar().querySelector('[role=switch]'),null);
});

test('no switch where DGC could not take it: a Pip whose revision the list does not carry, and a DGC below the Pips API that pauses by revision',async()=>{
 const {lifecycle_revision:_r,...bare}=TRAVEL;
 const x=setup({jobs:[CORE,bare,BILLS]});await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('[data-pip-switch]')].map(b=>b.dataset.pipSwitch),[BILLS.id]);
 assert.equal(x.row(bare.id).lined,false);
 const old=setup({apiVersion:15,jobs:personal(),current:PW});await old.drain();
 assert.ok(old.d.querySelector('[data-job]'),'its Pips are listed');
 assert.equal(old.d.querySelector('[role=switch][data-pip-switch]'),null);
 old.d.querySelector(`[data-job="${BILLS.id}"]`).click();await old.drain();
 assert.equal(old.d.querySelector('[role=switch][data-pip-switch]'),null);assert.equal(old.d.querySelector('.pip-off-line'),null);
});

test('the words are plain, and never the banned one',async()=>{
 const x=setup({jobs:personal()});await x.drain();
 const words=[...x.d.querySelectorAll('[data-pip-switch]')].flatMap(b=>[b.title,b.getAttribute('aria-label')]);
 assert.deepEqual(words,['On. Switch it off to stop it running on its own.','Travel, on or off','Off. Switch it on to let it run again.','Bills, on or off']);
 for(const w of words)assert.doesNotMatch(w,/\bAI\b/);
});
