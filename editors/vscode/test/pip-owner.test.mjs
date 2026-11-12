// A Project Pip's owner session, on its Settings page (0.52, asked 12 Nov; Pips API 89, dgc/pip_owners.py): "for project
// Pips, there has to be a session owner... User should be able to change the owner session on Project Pips settings."
//   - "Reports to": the owner session's title (the titles the editor's Work list shows), or "No session: its reports
//     wait in the Pips view"
//   - Change: a picker of this project's Work sessions, plus "No session"; a choice is one set_pip_owner
//   - a refusal stays in sight and the owner stays as it was
//   - a Personal Pip has no such row; below API 89 there is no row and nothing is asked
// (Harness from pips-project-shell.)
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';

const src=fileURLToPath(new URL('../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
const PW='ws_'+hex('e'),W='ws_'+hex('d');
const PLANNER='pip_'+hex('f'),AUDIT='pip_'+hex('a');
const S1='20261106-101500-a1',S2='20261106-091200-b2',S3='20261105-221000-c3';
const TITLES=[{id:S1,title:'Run the shell command and say what is there'},{id:S2,title:'Visits page alignment'}];
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,
  description:`${id} reads and reports`,available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id[0].toUpperCase()+id.slice(1),default_goal:'Review the committed code.',
  engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,type,name,extra={})=>({id,workspace_id:W,pip_type:type,name,goal:`${name} looks after billing.py.`,source_ref:'HEAD',source_policy:{mode:'committed_only'},status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const planner={...pip(PLANNER,'lens','Planner'),workspace_id:PW,source_policy:{mode:'personal'}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const row=id=>({session_id:id,workspace_id:W,workspace_binding_id:'binding_'+hex('1'),updated_at:'2026-11-06T10:15:00Z',runner_id:'runner_'+hex('2')});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({api=89,owner={session_id:S2,chosen:false},sessions=[S3,S2,S1],titles=TITLES}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
  const sent=[],answered=new Set(),listeners=new Set(),hold=new Set();
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
  w.eval(client);
  const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
  w.DgcPips.mount({root:shadow,postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>undefined,setState(){},onAskDgc:()=>true,onSetupPrompt:()=>true});
  const message=data=>listeners.forEach(l=>l(data));
  const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
  const pips={[PW]:[planner],[W]:[pip(AUDIT,'rook','Billing audit')]};
  const byId=id=>[...pips[PW],...pips[W]].find(p=>p.id===id);
  const state={owner};
  const reply=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'shop',kind:'git'}],current_workspace_id:W}),
    list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),get_pip_runner:()=>({runner}),list_pip_starters:()=>({starters:[]}),
    list_pips:()=>{const list=pips[r.workspace_id]||[];return {pips:list,total:list.length,next_offset:null};},
    get_pip:()=>({pip:byId(r.pip_id)}),list_pip_runs:()=>({runs:[]}),
    get_workspace_context:()=>({context:{workspace_id:r.workspace_id,revision:0,entries:[]}}),
    list_pip_models:()=>({default_model:'m',models:[{id:'m',name:'m'}],connection:'configured'}),
    list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:byId(r.pip_id).workspace_id,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
    list_pip_run_posts:()=>({pip_id:r.pip_id,workspace_id:byId(r.pip_id).workspace_id,posts:[],next_before_id:null}),
    list_pip_run_fixes:()=>({pip_id:r.pip_id,workspace_id:byId(r.pip_id).workspace_id,fixes:[]}),list_pip_reply_stats:()=>({pip_id:r.pip_id,stats:[]}),
    list_pip_handoffs:()=>({pip_id:r.pip_id,workspace_id:W,handoffs:[],has_more:false,next_before_id:null}),
    list_pip_attention:()=>({as_of:new Date().toISOString(),total:0,counts:{},by_pip:{},items:[],truncated:false}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
    list_pip_approvals:()=>({approvals:[],next_cursor:null}),list_pip_checkpoints:()=>({checkpoints:[],next_cursor:null}),get_pip_digest:()=>undefined,
    get_pip_owner:()=>({pip_id:r.pip_id,...state.owner}),
    set_pip_owner:()=>{state.owner={session_id:r.session_id,chosen:true};return {pip_id:r.pip_id,session_id:r.session_id};},
    list_workspace_sessions:()=>({workspace_id:r.workspace_id,sessions:[...sessions].sort().map(row),next_cursor:[...sessions].sort().at(-1)||'',has_more:false}),
    list_work_session_titles:()=>({sessions:titles})}[r.type]?.());
  async function drain(){for(let n=0;n<25;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id)&&!hold.has(m.request.type))){const result=reply(m.request);if(result===undefined)continue;answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});}}await flush();}
  message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true,folder:true});
  const $=s=>shadow.querySelector(s),$$=s=>[...shadow.querySelectorAll(s)];
  const click=async s=>{const el=$(s);assert.ok(el,'Missing '+s);el.click();await drain();};
  async function tab(scope){if(!$(`[data-pips-tab="${scope}"]`))$('#simple-back')?.click();await drain();$(`[data-pips-tab="${scope}"]`)?.click();await drain();}
  async function settings(id,scope='project'){await tab(scope);await click(`[data-job="${id}"]`);const item=$('.pip-topbar .pip-menu [data-tab="job"]')||$('[data-tab="job"]');assert.ok(item,'its Settings');item.click();await drain();}
  const asked=t=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===t);
  const requests=t=>JSON.parse(JSON.stringify(asked(t).map(m=>m.request)));
  const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
  return {w,d:shadow,$,$$,sent,drain,click,tab,settings,requests,asked,answer,hold,state};
}
const text=el=>el?.textContent.replace(/\s+/g,' ').trim()||'';
const choices=x=>x.$$('.pip-owner [data-owner-session]').map(b=>[b.dataset.ownerSession,text(b.querySelector('.pip-owner-title')),b.getAttribute('aria-checked')]);

test('a Project Pip’s Settings says which session it reports to, by the title the Work list shows',async()=>{
  const x=setup();await x.settings(AUDIT);
  assert.deepEqual(x.requests('get_pip_owner'),[{type:'get_pip_owner',pip_id:AUDIT}],'asked once, about this Pip');
  const row=x.$('.pip-owner');
  assert.ok(row,'a Reports to row');
  assert.equal(text(row.querySelector('h2')).replace(/\s*What is this\?.*$/,'').slice(0,10),'Reports to');
  assert.equal(text(row.querySelector('.pip-owner-now')),'Visits page alignment');
  assert.ok(x.$('#pip-owner-change'),'Change');
  assert.equal(x.$$('.pip-owner [data-owner-session]').length,0,'the picker is closed until Change');
  assert.doesNotMatch(text(row),/20261106/,'never a session’s id where it has a title');
});

test('no owner session: its reports wait in the Pips view',async()=>{
  const x=setup({owner:{session_id:null,chosen:true}});await x.settings(AUDIT);
  assert.equal(text(x.$('.pip-owner-now')),'No session: its reports wait in the Pips view');
});

test('Change opens a picker of this project’s Work sessions, newest first, plus No session; a choice is one set_pip_owner',async()=>{
  const x=setup();await x.settings(AUDIT);
  await x.click('#pip-owner-change');
  assert.deepEqual(x.requests('list_workspace_sessions').map(r=>r.workspace_id),[W],'the sessions of the Pip’s own project');
  assert.equal(x.requests('list_work_session_titles').length,2,'and the titles the editor shows, read afresh for the picker');
  // (Live, 12 Nov: the project's sessions as DGC links them include ones never saved or since deleted. Only those the
  // Work list has are offered; S3 isn't in it.)
  assert.deepEqual(choices(x),[[S1,'Run the shell command and say what is there','false'],[S2,'Visits page alignment','true'],['','No session','false']],
    'each by its title, the owner marked; one the Work list doesn\'t have is not offered');
  assert.match(text(x.$('.pip-owner [data-owner-session=""]')),/Its reports wait in the Pips view/);
  x.hold.add('set_pip_owner');
  await x.click(`.pip-owner [data-owner-session="${S1}"]`);
  assert.deepEqual(x.requests('set_pip_owner'),[{type:'set_pip_owner',pip_id:AUDIT,session_id:S1}]);
  assert.ok(x.$$('.pip-owner [data-owner-session]').every(b=>b.disabled),'nothing more to press while it is saved');
  x.state.owner={session_id:S1,chosen:true};
  x.answer(x.asked('set_pip_owner')[0],{pip_id:AUDIT,session_id:S1});await x.drain();
  assert.equal(text(x.$('.pip-owner-now')),'Run the shell command and say what is there');
  assert.equal(x.$$('.pip-owner [data-owner-session]').length,0,'the picker closes');
  x.hold.delete('set_pip_owner');
  await x.click('#pip-owner-change');
  await x.click('.pip-owner [data-owner-session=""]');
  assert.deepEqual(x.requests('set_pip_owner').at(-1),{type:'set_pip_owner',pip_id:AUDIT,session_id:null},'No session is a null owner');
  assert.equal(text(x.$('.pip-owner-now')),'No session: its reports wait in the Pips view');
});

test('a session with nothing in it is never offered, and never called “(empty)”',async()=>{
  // Live, 12 Nov: most of the picker read “(empty)” (the backend's preview of a session with no message), and one
  // became the owner.
  const S4='20261104-080000-d4';
  const x=setup({sessions:[S4,S3,S2,S1],owner:{session_id:S2,chosen:false},titles:[...TITLES,{id:S4,title:'',empty:true}]});
  await x.settings(AUDIT);await x.click('#pip-owner-change');
  assert.deepEqual(choices(x).map(c=>c[0]),[S1,S2,''],'the empty session is left out, and S3, which the Work list doesn\'t have');
  assert.ok(choices(x).every(c=>c[1]!=='(empty)'));
});
test('the owner is shown even when the Work list doesn\'t have it, and with no Work list every session is offered',async()=>{
  const x=setup({owner:{session_id:S3,chosen:true}});await x.settings(AUDIT);await x.click('#pip-owner-change');
  assert.deepEqual(choices(x).map(c=>c[0]),[S1,S2,S3,''],'the current owner stays, said by when it is from');
  const y=setup({titles:[]});await y.settings(AUDIT);await y.click('#pip-owner-change');
  assert.deepEqual(choices(y).map(c=>c[0]),[S1,S2,S3,''],'no Work list (a remote view): every session, by when it is from');
});
test('the picker closes with Cancel and changes nothing; choosing the owner it has asks nothing',async()=>{
  const x=setup();await x.settings(AUDIT);
  await x.click('#pip-owner-change');
  await x.click(`.pip-owner [data-owner-session="${S2}"]`);
  assert.equal(x.requests('set_pip_owner').length,0,'it reports there already');
  assert.equal(x.$$('.pip-owner [data-owner-session]').length,0);
  await x.click('#pip-owner-change');
  await x.click('#pip-owner-cancel');
  assert.equal(x.$$('.pip-owner [data-owner-session]').length,0);
  assert.equal(x.requests('set_pip_owner').length,0);
  assert.equal(text(x.$('.pip-owner-now')),'Visits page alignment');
});

test('a refusal is said in the row, and the owner stays as it was',async()=>{
  const x=setup();await x.settings(AUDIT);
  await x.click('#pip-owner-change');
  x.hold.add('set_pip_owner');
  await x.click(`.pip-owner [data-owner-session="${S1}"]`);
  x.answer(x.asked('set_pip_owner')[0],'Choose one of this project’s sessions: that session isn’t one.',false);await x.drain();
  assert.match(text(x.$('.pip-owner [role="alert"]')),/Choose one of this project’s sessions: that session isn’t one\./);
  assert.equal(text(x.$('.pip-owner-now')),'Visits page alignment');
});

test('a Personal Pip has no such row, and a DGC before Pips API 89 is never asked',async()=>{
  const shown=setup();await shown.settings(AUDIT);
  assert.ok(shown.$('.pip-owner'),'a Project Pip at API 89 has the row');
  const x=setup();await x.settings(PLANNER,'personal');
  assert.equal(x.$('.pip-owner'),null,'a Personal Pip has its own chat');
  assert.equal(x.requests('get_pip_owner').length,0);
  const old=setup({api:88});await old.settings(AUDIT);
  assert.ok(old.$('#model-form'),'its Settings');
  assert.equal(old.$('.pip-owner'),null,'no row below API 89');
  for(const t of ['get_pip_owner','set_pip_owner','list_work_session_titles'])assert.equal(old.requests(t).length,0,t);
});
