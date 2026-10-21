// Opening a Pip from a chat (its run line, the agent map, a setup card's "Open in Pips"): the founder, 2026-10-18,
// "in the chat I could see the model ran my Pips ... when I click the Pip, it opens the Pips page, but I can only see
// the Core Pip, and it says 'This Pip is not available in the selected workspace. Refresh the dashboard.'" The Pips
// view opens on your Personal Pips; a project's Pip lives in its project. It opens there now, and one that is gone
// says so.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const client=(await build({entryPoints:[new URL('../src/pipsClient.js',import.meta.url).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
const PW='ws_'+hex('e'),W='ws_'+hex('d'),CORE='pip_'+hex('c'),AUDIT='pip_'+hex('a'),GONE='pip_'+hex('f'),RUN='run_'+hex('b');
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,workspace,name,type,extra={})=>({id,workspace_id:workspace,pip_type:type,name,goal:'Review the ERP exports',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const core=pip(CORE,PW,'Core','core',{source_policy:{mode:'personal'}}),audit=pip(AUDIT,W,'ERP daily audit','rook');
const run={id:RUN,pip_id:AUDIT,workspace_id:W,status:'failed',created_at:'2026-10-18T09:00:00.000Z',started_at:'2026-10-18T09:00:01.000Z',finished_at:'2026-10-18T09:00:02.000Z',
 manifest:{job_version:1,source_revision:'a'.repeat(40),run_kind:'audit',workspace_context:{workspace_id:W,revision:0,entries:[],digest:'a'.repeat(64)}},result:null,error:{code:'model_failed',message:'cannot connect to http://127.0.0.1:9/v1'}};
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

// The side bar's Pips view as main.js mounts it (a shadow root), on a backend with your Personal Pips and a project.
function setup(){
 const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),listeners=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
 w.eval(client);
 const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
 const app=w.DgcPips.mount({root:shadow,postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>undefined,setState(){}});
 const message=data=>listeners.forEach(l=>l(data));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:result})});};
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const pips={[PW]:[core],[W]:[audit]};
 const reply=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'},{id:W,name:'erp-tools',kind:'project'}],current_workspace_id:W}),
  list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  list_pips:()=>({pips:pips[r.workspace_id]||[],total:(pips[r.workspace_id]||[]).length,next_offset:null}),
  get_pip:()=>{const p=[core,audit].find(p=>p.id===r.pip_id);return p?{pip:p}:{error:{code:'not_found',message:'That Pip isn’t on this computer. It may have been deleted.'}};},
  list_pip_runs:()=>({runs:r.pip_id===AUDIT?[run]:[]}),get_pip_run:()=>({run}),
  get_workspace_context:()=>({context:{workspace_id:r.workspace_id||W,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0}),
  list_pip_attention:()=>({as_of:new Date().toISOString(),total:0,counts:{},by_pip:{},items:[],truncated:false}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1}),
  list_pip_approvals:()=>({approvals:[],next_cursor:null}),list_pip_checkpoints:()=>({checkpoints:[],next_cursor:null}),get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<20;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=reply(m.request);if(result===undefined)continue;if(result.error)answer(m,result.error,false);else answer(m,result);}}await flush();}
 message({type:'pipsConnection',apiVersion:47,generation:1,connected:true,supported:true,enabled:true});
 const text=()=>(shadow.querySelector('.pip-app-root')?.textContent||'').replace(/\s+/g,' ');
 return {w,d:shadow,app,sent,drain,text,requests:type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type)};
}

test('a project Pip opened from a chat opens in its project, at the run, not "not available" in Personal',async()=>{
 const x=setup();await x.drain();
 assert.ok(x.d.querySelector(`[data-job="${CORE}"]`),'the view opens on your Personal Pips: Core');
 assert.equal(x.d.querySelector(`[data-job="${AUDIT}"]`),null);
 const going=x.app.navigate({pip:AUDIT,section:'runs',run:RUN});await x.drain();await going;await x.drain();
 assert.doesNotMatch(x.text(),/not available in the selected workspace|Refresh the dashboard/);
 assert.equal(x.d.querySelector('#pips-tab-project')?.getAttribute('aria-selected'),'true','the Pips view is on the Pip\'s project now: its Project tab');
 assert.equal(x.d.querySelector(`[data-job="${AUDIT}"]`)?.getAttribute('aria-current'),'true','and the Pip is open');
 assert.match(x.text(),/ERP daily audit/);
 assert.ok(x.requests('get_pip_run').some(m=>m.request.run_id===RUN),'at the run it was opened for');
});

test('a Pip that is gone says so, in plain words',async()=>{
 const x=setup();await x.drain();
 const going=x.app.navigate({pip:GONE,section:'runs',run:RUN});await x.drain();await going;await x.drain();
 assert.match(x.text(),/That Pip isn’t on this computer\. It may have been deleted\./);
 assert.doesNotMatch(x.text(),/Refresh the dashboard/);
 assert.ok(x.d.querySelector(`[data-job="${CORE}"]`),'your Pips stay where they were');
});
