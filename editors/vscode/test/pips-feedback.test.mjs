// Thumbs up or down on a finished Pip result (API 41): the user's own rating and note, which the
// Pip's later runs read. The job itself does not change.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const base=new URL('../src/',import.meta.url);
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const workspace={id:'ws_'+'1'.repeat(32),name:'Project'},pipId='pip_'+'2'.repeat(32),runId='run_'+'3'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id,role:id,description:'Read committed source',available:['rook','scout','lens','lock'].includes(id),unavailable_reason:['rook','scout','lens','lock'].includes(id)?null:'Planned',default_name:id,default_goal:'Review',engine:['rook','scout','lens','lock'].includes(id)?'source_audit':null}));
const job={id:pipId,workspace_id:workspace.id,pip_type:'lens',name:'Market brief',goal:'Brief me before the open.',source_policy:{mode:'personal'},source_ref:null,status:'active',current_version:1,lifecycle_revision:1,policy:'read_only',trigger:'manual',proposals:[]};
const run=(extra={})=>({id:runId,pip_id:pipId,workspace_id:workspace.id,status:'succeeded',created_at:'2026-10-05T03:00:00.000Z',manifest:{run_kind:'personal_task',source_policy:{mode:'personal'}},result:{text:'Nifty opened flat.',external_actions:false,tools_called:0,usage:{}},...extra});
const rated=(rows)=>({pip_id:pipId,feedback:rows});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
function setup({feedback=rated([]),current=run(),api=41}={}){
 const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let listener;
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.setInterval=()=>1;w.eval(client);
 w.DgcPips.mount({root:w.document,host:'editor',postMessage:m=>sent.push(m),onMessage:fn=>{listener=fn;},onSetupPrompt:()=>true});
 const answer=(m,result)=>{answered.add(m.id);listener({type:'pipsReply',id:m.id,ok:true,result});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[workspace],current_workspace_id:workspace.id}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:[job]}),get_pip:()=>({pip:job}),list_pip_runs:()=>({runs:[current]}),get_pip_run:()=>({run:current}),list_pip_run_activity:()=>({events:[],next_after:0}),get_pip_runner:()=>({runner:{runner_id:'r',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}}}),get_workspace_context:()=>({context:{workspace_id:workspace.id,revision:0,entries:[]}}),list_pip_starters:()=>({starters:[]}),list_pip_feedback:()=>feedback,get_pips_keep_running:()=>undefined,get_pips_desktop_notifications:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answer(m,result);count++;}}if(!count)break;}await flush();}
 listener({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const note=(value)=>{const e=w.document.getElementById('feedbackNote');e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));};
 return {w,d:w.document,sent,answer,requests,drain,note,async open(){await drain();w.document.querySelector('[data-job]').click();await drain();w.document.querySelector('[data-tab=runs]')?.click();await drain();w.document.querySelector(`[data-run="${runId}"]`)?.click();await drain();}};
}

test('a finished result asks whether it was useful, and a thumb saves the rating with the note', async()=>{
 const x=setup();await x.open();
 const section=x.d.querySelector('.feedback');
 assert.ok(section,'the rating sits under the result');
 assert.match(section.textContent,/Was this result useful\?/);
 assert.match(section.textContent,/Its next runs read your rating and note\. The job itself does not change\./);
 assert.equal(x.d.getElementById('rate-up').getAttribute('aria-pressed'),'false');
 assert.equal(x.d.getElementById('rate-clear'),null,'nothing to clear yet');
 x.note('  Lead with the three biggest movers.  ');
 x.d.getElementById('rate-down').click();
 const saved=x.requests('set_pip_feedback')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(saved.request)),{type:'set_pip_feedback',run_id:runId,rating:'down',note:'Lead with the three biggest movers.'});
 x.answer(saved,rated([{run_id:runId,rating:'down',note:'Lead with the three biggest movers.',at:'2026-10-05T04:00:00.000Z'}]));await x.drain();
 assert.match(x.d.body.textContent,/Saved\. Its next runs will read your thumbs down and note\./);
 assert.equal(x.d.getElementById('rate-down').getAttribute('aria-pressed'),'true');
 assert.equal(x.d.getElementById('feedbackNote').value,'Lead with the three biggest movers.');
 x.d.getElementById('rate-clear').click();
 const cleared=x.requests('set_pip_feedback')[1];
 assert.deepEqual(JSON.parse(JSON.stringify(cleared.request)),{type:'set_pip_feedback',run_id:runId,rating:null,note:''});
 x.answer(cleared,rated([]));await x.drain();
 assert.match(x.d.body.textContent,/Rating cleared\./);
 assert.equal(x.d.getElementById('rate-down').getAttribute('aria-pressed'),'false');
});

test('an earlier rating shows as pressed, with its note', async()=>{
 const x=setup({feedback:rated([{run_id:runId,rating:'up',note:'Perfect length.',at:'2026-10-05T04:00:00.000Z'}])});await x.open();
 assert.equal(x.d.getElementById('rate-up').getAttribute('aria-pressed'),'true');
 assert.equal(x.d.getElementById('feedbackNote').value,'Perfect length.');
});

test('a reply that does not match the choice is not shown as saved', async()=>{
 const x=setup();await x.open();
 x.d.getElementById('rate-up').click();
 x.answer(x.requests('set_pip_feedback')[0],rated([]));await x.drain();
 assert.doesNotMatch(x.d.body.textContent,/Saved\. Its next runs/);
 assert.match(x.d.body.textContent,/The saved rating differs from your choice/);
});

test('only finished results are rated, and only with API 41', async()=>{
 for(const [label,options] of [['a failed run',{current:run({status:'failed',result:null,error:{code:'worker_failed',message:'Model unavailable.'}})}],
                                ['a running run',{current:run({status:'running',result:null})}],
                                ['an older CLI',{api:40}]]){
  const x=setup(options);await x.open();
  assert.equal(x.d.querySelector('.feedback'),null,label);
  assert.equal(x.requests('list_pip_feedback').length,0,label);
 }
});

test('a long note in emoji, counted as the runner counts characters, still shows', async()=>{
 const note='😀'.repeat(300);                      // 300 characters, 600 UTF-16 units
 const x=setup({feedback:rated([{run_id:runId,rating:'up',note,at:'2026-10-05T04:00:00.000Z'}])});await x.open();
 assert.equal(x.d.getElementById('rate-up')?.getAttribute('aria-pressed'),'true');
 assert.equal(x.d.getElementById('feedbackNote').value,note);
});
