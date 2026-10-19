// A Pip's eyes and cursor (Pips API 53): you see where the Pip clicks (its cursor in the live view, on the
// full screen, and in "What it saw"), a text-only Pip's page says how it sees and changes it, an older CLI is
// never asked, and a payment never offers Always allow.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const tabCode=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const viewCode=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const clientCode=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const pure=(await build({entryPoints:[src+'pipsModel.js'],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const view=load(viewCode,name=>name==='vscode'?{}:require(name)),model=load(pure);
const windows=[];after(()=>windows.forEach(w=>w.close()));
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const JPEG='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'};
const rect=(left,top,width,height)=>()=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top});

// --------------------------------------------------------------------------- the computer tab

function tab({apiVersion=53,screen=false,viewer=null,desktop={}}={}){
 const dom=new JSDOM(view.computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),timers=[];
 w.setInterval=fn=>{timers.push({fn,live:true});return timers.length;};w.clearInterval=id=>{if(timers[id-1])timers[id-1].live=false;};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 if(viewer)w.__dgcTestRFB=viewer;w.eval(tabCode);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({get_pip_computer:()=>({computer:{pip_id:PIP.id,granted:true,available:true,reason:'',pending:0,actions:[]}}),open_pip_computer:()=>({view:{pip_id:PIP.id,ready:true}}),
  use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://shop.example/',width:1280,height:800,image:JPEG}}),
  get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,available:true,reason:'',install:'',using:false,browser:'Google Chrome',chrome_install:'',...desktop}})}[r.type]?.());
 async function drain(overrides={}){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});count++;}}if(!count)break;}await flush();}
 message({type:'pipComputerInit',pip:PIP,desktop:screen});
 message({type:'pipsConnection',generation:7,apiVersion,connected:true,supported:true,enabled:true});
 return {w,d:w.document,sent,requests,drain,timers,tick:async(o={})=>{for(const t of timers.filter(t=>t.live))t.fn();await drain(o);},
  click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));}};
}

test('the live browser shows the Pip\'s cursor where it last clicked, with its name, while it works',async()=>{
 const x=tab();await x.drain();
 const using=pointer=>({use_pip_computer_view:()=>({view:{ok:true,watching:true,url:'https://tees.example/',width:1280,height:800,image:JPEG,pointer}})});
 x.click('[data-app=browser]');await x.drain(using({kind:'click_at',x:640,y:200,seq:1,at:'2026-10-20T10:00:00Z'}));
 const img=x.d.querySelector('#pc-screen');
 // The screenshot is drawn at half size, 20 px in from the screen's corner.
 img.getBoundingClientRect=rect(30,20,640,400);img.parentElement.getBoundingClientRect=rect(10,0,700,500);
 await x.tick(using({kind:'click_at',x:640,y:200,seq:1}));
 const img2=x.d.querySelector('#pc-screen');img2.getBoundingClientRect=rect(30,20,640,400);img2.parentElement.getBoundingClientRect=rect(10,0,700,500);
 img2.dispatchEvent(new x.w.Event('load'));
 const cursor=x.d.querySelector('#pc-cursor');
 assert.equal(cursor.hidden,false,'its cursor shows');
 assert.deepEqual([cursor.style.left,cursor.style.top],['340px','120px'],'at (640, 200) of the page, scaled to the screen');
 assert.equal(cursor.querySelector('.pc-cursor-name').textContent,'Shopper');
 assert.equal(cursor.dataset.kind,'click_at');
 // A pointer that isn't one is not drawn.
 await x.tick(using({kind:'teleport',x:1,y:1,seq:2}));
 assert.equal(x.d.querySelector('#pc-cursor').hidden,true);
});

test('on the full screen the cursor is asked for on its own, without a frame, and drawn over the screen',async()=>{
 const made=[];class Viewer{constructor(target,channel){this.target=target;made.push(this);channel.onopen=()=>{};channel.onmessage=()=>{};channel.onclose=()=>{};}addEventListener(){}}
 const x=tab({screen:true,viewer:Viewer,desktop:{using:true}});await x.drain();
 const canvas=x.d.createElement('canvas');canvas.width=1280;canvas.height=800;x.d.querySelector('#pc-vnc').appendChild(canvas);
 canvas.getBoundingClientRect=rect(0,40,960,600);x.d.querySelector('#pc-live').getBoundingClientRect=rect(0,40,960,600);
 await x.tick({use_pip_computer_view:r=>({view:{ok:true,watching:true,pointer:{kind:'drag',x:500,y:300,from_x:400,from_y:300,screen_x:520,screen_y:420,screen_width:1280,screen_height:800,seq:4}}})});
 const asked=x.requests('use_pip_computer_view');
 assert.ok(asked.length>=1,'asked for the cursor');assert.ok(asked.every(m=>m.request.op==='pointer'),'never a screenshot: the screen streams itself');
 const cursor=x.d.querySelector('#pc-cursor');
 assert.equal(cursor.hidden,false);assert.deepEqual([cursor.style.left,cursor.style.top],['390px','315px'],'(520, 420) on a 1280x800 screen drawn at 960x600');
 const old=tab({screen:true,viewer:Viewer,apiVersion:52});await old.drain();await old.tick();
 assert.equal(old.requests('use_pip_computer_view').length,0,'an older CLI is never asked');
});

// --------------------------------------------------------------------------- the Pips view

const PW='ws_'+'p'.repeat(32),PID='pip_'+'g'.repeat(32),RUN='run_'+'a'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(extra={})=>({id:PID,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Make my tees.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true},computer_plan:{schema_version:1},model_choice:{mode:'model',model:'glm-5.3:cloud'},...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const now=new Date().toISOString();

function pips({apiVersion=53,eyes,row=pip(),runs=[],overrides={}}={}){
 const dom=new JSDOM(view.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(clientCode);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const state={row,eyes:eyes||{pip_id:PID,model:'glm-5.3:cloud',sees:false,choice:'ask',vision_model:'deepseek-v4.1-flash:cloud'}};
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[state.row]}),get_pip:()=>({pip:state.row}),list_pip_runs:()=>({runs}),get_pip_run:()=>({run:runs.find(x=>x.id===r.run_id)}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PID,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PID,granted:true,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PID,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:PID,workspace_id:PW,routines:[]}),list_pip_shared:()=>({pip_id:PID,workspace_id:PW,kind:r.kind,items:[]}),
  list_pip_action_grants:()=>({pip_id:PID,grants:[]}),list_pip_plugins:()=>({pip_id:PID,plugins:[],installed:[]}),list_pip_notes:()=>({pip_id:PID,notes:[],max:60}),
  list_pip_sites:()=>({pip_id:PID,careful:true,sites:[]}),list_pip_attention:()=>({as_of:now,total:0,counts:{},by_pip:{},items:[],truncated:false}),
  get_pip_eyes:()=>({eyes:state.eyes}),...overrides}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,state};
}
async function openPage(x){await x.drain();x.click(`[data-job="${PID}"]`);await x.drain();x.click('[data-tab="job"]');await x.drain();}

test('a text-only Pip\'s page says it can\'t see, and how it sees is one choice away',async()=>{
 const x=pips();await openPage(x);
 const group=x.d.querySelector('[aria-label="Seeing"]');assert.ok(group,'on its page');
 assert.match(group.textContent,/Seeing.*glm-5\.3:cloud can’t see images\. It asks you when it needs to see\./);
 assert.deepEqual([...x.d.querySelectorAll('#pipEyes option')].map(o=>o.textContent),['Ask me when it needs to','Use deepseek-v4.1-flash:cloud to see','Don’t let it see']);
 const select=x.d.querySelector('#pipEyes');select.value='relay';select.dispatchEvent(new x.w.Event('change',{bubbles:true}));await flush();
 const set=x.requests('set_pip_eyes').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(set.request)),{type:'set_pip_eyes',pip_id:PID,choice:'relay'});
 x.answer(set,{eyes:{...x.state.eyes,choice:'relay'}});await x.drain();
 assert.match(x.d.body.textContent,/deepseek-v4\.1-flash:cloud sees for it from now on\./);
 assert.match(x.d.querySelector('[aria-label="Seeing"]').textContent,/deepseek-v4\.1-flash:cloud sees for it; glm-5\.3:cloud does the rest\./);
 x.click('[data-eyes-switch]');await flush();
 const proposed=x.requests('propose_pip_update').at(-1);
 assert.deepEqual(JSON.parse(JSON.stringify(proposed.request.changes)),{model_choice:{mode:'model',model:'deepseek-v4.1-flash:cloud'}},'switching is its model, changed the usual way');
});

test('a Pip that sees just says so; an invalid answer is not shown; an older CLI is not asked',async()=>{
 const x=pips({eyes:{pip_id:PID,model:'deepseek-v4.1-flash:cloud',sees:true,choice:'ask',vision_model:null}});await openPage(x);
 assert.match(x.d.querySelector('[aria-label="Seeing"]').textContent,/deepseek-v4\.1-flash:cloud sees Ava's screen and the photos you send\./);
 assert.equal(x.d.querySelector('#pipEyes'),null);assert.equal(x.d.querySelector('[data-eyes-switch]'),null);
 const bad=pips({eyes:{pip_id:PID,model:'m',sees:'yes',choice:'ask',vision_model:null}});await openPage(bad);
 assert.match(bad.d.querySelector('[aria-label="Seeing"]').textContent,/didn't load/);
 const old=pips({apiVersion:52});await openPage(old);
 assert.equal(old.requests('get_pip_eyes').length,0);assert.equal(old.d.querySelector('[aria-label="Seeing"]'),null);
});

test('"What it saw" asks where each step acted and draws the cursor and a drag\'s path on its screenshot',async()=>{
 const run={id:RUN,pip_id:PID,status:'succeeded',created_at:'2026-10-20T10:00:00Z',manifest:{run_kind:'personal_task',job_version:1},result:{text:'Done.',external_actions:false,computer:{calls:2,held:[]}}};
 const x=pips({runs:[run]});await x.drain();x.click(`[data-job="${PID}"]`);await x.drain();
 x.click('[data-tab=runs]');await x.drain();if(x.d.querySelector(`[data-run="${RUN}"]`))x.click(`[data-run="${RUN}"]`);await x.drain();
 x.click('#computer-timeline');await flush();
 const list=x.requests('list_pip_computer_frames')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(list.request)),{type:'list_pip_computer_frames',run_id:RUN,pointers:true});
 x.answer(list,{run_id:RUN,frames:[{frame:'0001.jpg',label:'Dragged from 400, 300 (canvas) to 500, 250.',url:'https://tees.example/',at:'t',pointer:{kind:'drag',x:500,y:250,from_x:400,from_y:300}},
  {frame:'0002.jpg',label:'open https://tees.example/',url:'https://tees.example/',at:'t'}]});await flush();
 const img=x.d.querySelector('#computer-timeline-img');Object.defineProperty(img,'naturalWidth',{value:1280});Object.defineProperty(img,'naturalHeight',{value:800});
 x.answer(x.requests('get_pip_computer_frame')[0],{run_id:RUN,frame:'0001.jpg',image:JPEG});await flush();
 const svg=x.d.querySelector('#computer-timeline-cursor');
 assert.equal(svg.hasAttribute('hidden'),false);assert.equal(svg.getAttribute('viewBox'),'0 0 1280 800');
 assert.equal(svg.querySelector('.ct-ring').getAttribute('cx'),'500');assert.equal(svg.querySelector('.ct-path').getAttribute('x1'),'400');
 assert.equal(x.d.querySelector('#computer-timeline-label').textContent,'Dragged from 400, 300 (canvas) to 500, 250. · https://tees.example/');
 x.click('#computer-next');await flush();x.answer(x.requests('get_pip_computer_frame')[1],{run_id:RUN,frame:'0002.jpg',image:JPEG});await flush();
 assert.equal(x.d.querySelector('#computer-timeline-cursor').hasAttribute('hidden'),true,'a step by ref has no cursor');
 const old=pips({apiVersion:52,runs:[run]});await old.drain();old.click(`[data-job="${PID}"]`);await old.drain();
 old.click('[data-tab=runs]');await old.drain();if(old.d.querySelector(`[data-run="${RUN}"]`))old.click(`[data-run="${RUN}"]`);await old.drain();
 old.click('#computer-timeline');await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(old.requests('list_pip_computer_frames')[0].request)),{type:'list_pip_computer_frames',run_id:RUN},'an older CLI gets the request it knows');
});

test('the extension host asks only an API 53 CLI about eyes, pointers and the cursor',()=>{
 const asks=[['get_pip_eyes',{pip_id:PID}],['set_pip_eyes',{pip_id:PID,choice:'relay'}],['list_pip_computer_frames',{run_id:RUN,pointers:true}],['use_pip_computer_view',{pip_id:PID,op:'pointer'}]];
 for(const api of [52,53]){
  const posted=[],sent=[];const editor=new view.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  for(const [type,extra] of asks)editor.receive({type:'pipsRequest',id:type,request:{type,...extra}});
  editor.receive({type:'pipsRequest',id:'frames',request:{type:'list_pip_computer_frames',run_id:RUN}});
  assert.equal(sent.length,api>=53?5:1,`API ${api}`);
  if(api<53)assert.match(posted.find(m=>m.id==='get_pip_eyes').error.message,/Update DGC to see where a Pip clicks/);
 }
});

test('a chat reply that used its computer offers What it saw…, as a task\'s result does',async()=>{
 const run={id:RUN,pip_id:PID,status:'succeeded',created_at:'2026-10-20T10:00:00Z',manifest:{run_kind:'conversation',job_version:1},result:{text:'Done.',computer:{calls:4,held:[]}}};
 const said=(id,role,text)=>({id,pip_id:PID,workspace_id:PW,role,text,run_id:RUN,status:'succeeded',model:'deepseek-v4.1-flash:cloud',created_at:'2026-10-20T10:00:00Z'});
 const x=pips({runs:[run],overrides:{list_pip_messages:()=>({pip_id:PID,workspace_id:PW,messages:[said('m1','user','Make my tee'),said('m2','assistant','Done.')],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls})}});
 await x.drain();x.click(`[data-job="${PID}"]`);await x.drain();
 x.click(`[data-chat-run="${RUN}"]`);await x.drain();
 assert.match(x.d.body.textContent,/Used its computer: 4 steps/);assert.ok(x.d.querySelector('#computer-timeline'));
});

test('validators: a pointer and How it sees, exactly as the CLI sends them',()=>{
 const m=model;
 assert.deepEqual(m.pipComputerPointer({kind:'click_at',x:1,y:2,seq:3,at:'t'}),{kind:'click_at',x:1,y:2,seq:3});
 for(const bad of [null,{kind:'click_at',x:-1,y:2},{kind:'click_at',x:'1',y:2},{kind:'look',x:1,y:2},{kind:'drag',x:1}])assert.equal(m.pipComputerPointer(bad),null);
 const frames={run_id:RUN,frames:[{frame:'0001.jpg',label:'l',url:'u',at:'t',pointer:{kind:'hover_at',x:5,y:6}}]};
 assert.equal(m.pipComputerFrames(frames,RUN),frames);
 assert.throws(()=>m.pipComputerFrames({run_id:RUN,frames:[{...frames.frames[0],pointer:{kind:'x',x:1,y:1}}]},RUN));
 assert.throws(()=>m.pipComputerFrames({run_id:RUN,frames:[{...frames.frames[0],extra:1}]},RUN));
 const eyes={pip_id:PID,model:'glm-5.3:cloud',sees:false,choice:'ask',vision_model:'deepseek-v4.1-flash:cloud'};
 assert.equal(m.pipEyes(eyes,PID),eyes);
 for(const bad of [{...eyes,pip_id:'x'},{...eyes,choice:'always'},{...eyes,sees:1},{...eyes,token:'x'},{...eyes,vision_model:''}])assert.throws(()=>m.pipEyes(bad,PID));
});
