import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Pip computers in the editor (Pips API 42): one switch to give a Personal Pip a computer, the
// approval card for what it would submit, and the live browser the user drives to sign in.
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const pure=(await build({entryPoints:[src+'pipsModel.js'],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const viewModule={exports:{}};new Function('module','exports','require',view)(viewModule,viewModule.exports,name=>name==='vscode'?{}:require(name));
const model={exports:{}};new Function('module','exports',pure)(model,model.exports);
const windows=[];after(()=>windows.forEach(w=>w.close()));
const ws={id:'ws',name:'Personal',kind:'personal'},pipId='a',runId='run_'+'b'.repeat(32),actionId='compact_'+'c'.repeat(32);
const PLAN={schema_version:1};
const job=(extra={})=>({id:pipId,workspace_id:'ws',name:'Shopper',goal:'Fill in forms for me',source_ref:'HEAD',status:'active',current_version:1,policy:'read_only',trigger:'manual',proposals:[],source_policy:{mode:'personal'},pip_type:'rook',...extra});
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>{const available=['scout','lens','rook','lock'].includes(id),name=id[0].toUpperCase()+id.slice(1);return{id,name,character_index,role:{core:'Main chat',scout:'Repository exploration',lens:'Repository research',patch:'Code changes',rook:'Code review',pulse:'Test execution',lock:'Security review',quill:'Documentation writing'}[id],description:available?'Inspect committed source with a focused read-only preset.':'This role is planned.',available,unavailable_reason:available?null:'This engine is not available yet.',default_name:name+' job',default_goal:available?'Inspect source for '+id+' findings.':'',engine:available?'source_audit':null};});
const JPEG='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const action=(extra={})=>({id:actionId,pip_id:pipId,workspace_id:'ws',run_id:runId,summary:{method:'POST',host:'shop.example',path:'/order',page:'https://shop.example/cart',fields:[{name:'name',value:'Ada'},{name:'password',value:'•••'}],more_fields:0,body_bytes:30},digest:'d'.repeat(64),frame:'0002.jpg',status:'pending',created_at:'2026-10-04T10:00:00Z',expires_at:'2099-10-05T10:00:00Z',resolved_at:null,resolved_by:null,continuation_run_id:null,...extra});
const grant={id:'grant_'+'e'.repeat(32),kind:'computer_submit',server:'shop.example',connection_digest:'1'.repeat(64),account:'browser',schema_digest:'2'.repeat(64),tool:'POST /order',label:'Submit in its browser to shop.example/order',created_at:'2026-10-05T10:00:00Z',created_by:'editor-user'};
const computer=(extra={})=>({pip_id:pipId,granted:true,available:true,reason:'',pending:0,actions:[],...extra});
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

function setup({apiVersion=42,pip=job(),status=computer({granted:false}),runs=[]}={}){
 const dom=new JSDOM(viewModule.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),timers=[];let current=pip,state=status;
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.setInterval=fn=>{timers.push({fn,live:true});return timers.length;};w.clearInterval=id=>{if(timers[id-1])timers[id-1].live=false;};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(code);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(request,result,ok=true)=>{answered.add(request.id);message({type:'pipsReply',id:request.id,ok,...(ok?{result}:{error:result})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:'ws',messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0}),list_pip_types:()=>({types}),list_workspaces:()=>({workspaces:[ws],current_workspace_id:'ws'}),list_pips:()=>({pips:[current]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),get_pip:()=>({pip:current}),list_pip_runs:()=>({runs}),get_pip_run:()=>({run:runs.find(x=>x.id===r.run_id)}),get_pip_computer:()=>({computer:state})}[r.type]?.());
 async function drain(overrides={}){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answer(m,result);count++;}}await flush();if(!count)break;}await flush();}
 message({type:'pipsConnection',apiVersion,connected:true,supported:true,enabled:true});
 const x={w,d:w.document,sent,timers,answer,requests,drain,setPip:p=>{current=p;},setStatus:s=>{state=s;},
  click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();},
  input:(s,value)=>{const e=w.document.querySelector(s);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));},
  submit:s=>w.document.querySelector(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})),
  async openJob(){await drain();const first=w.document.querySelector('[data-job]');if(first&&!w.document.querySelector('[data-job][aria-current=true]'))first.click();await drain();x.click('[data-tab=job]');await drain();}};
 return x;
}

test('an older CLI shows no computer; on API 42 one plain dialog gives it, as a reviewed change',async()=>{
 const old=setup({apiVersion:41});await old.openJob();
 assert.equal(old.requests('get_pip_computer').length,0);assert.doesNotMatch(old.d.body.textContent,/Give this Pip a computer/);
 assert.equal([...old.d.querySelectorAll('h3')].some(h=>h.textContent==='Computer'),false,'no Computer section at all');
 const x=setup();await x.openJob();
 assert.equal(x.requests('get_pip_computer')[0].request.pip_id,pipId);
 assert.match(x.d.body.textContent,/its own browser and files, separate from yours/);
 x.click('#give-computer');
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog);
 assert.match(dialog.textContent,/Give Shopper a computer\?/);
 for(const rule of [/waits for your approval, with a screenshot/,/never sees your passwords/,/cannot reach your home network\. A payment waits for your approval like anything else/,/cannot also read your connected apps/])assert.match(dialog.textContent,rule);
 assert.equal(x.requests('propose_pip_update').length,0,'opening the dialog changes nothing');
 x.click('#review-confirm');
 const proposed=x.requests('propose_pip_update')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(proposed.request)),{type:'propose_pip_update',pip_id:pipId,expected_version:1,changes:{computer_plan:PLAN},reason:'Give this Pip a computer.'});
 const proposal={id:'proposal-1',pip_id:pipId,expected_version:1,status:'proposed',definition:{...job(),computer_plan:PLAN}};
 x.answer(proposed,{proposal});await flush();
 const accepted=x.requests('accept_pip_update')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(accepted.request)),{type:'accept_pip_update',pip_id:pipId,proposal_id:'proposal-1',expected_version:1});
 x.setPip(job({computer_plan:PLAN,current_version:2}));x.setStatus(computer());
 x.answer(accepted,{pip:job({computer_plan:PLAN,current_version:2})});await x.drain();
 assert.equal(x.d.querySelector('[role=dialog]'),null);
 assert.match(x.d.body.textContent,/Shopper has a computer. Use Open browser to sign in/);
 assert.ok(x.d.querySelector('#open-computer'));assert.ok(x.d.querySelector('#stop-computer'));assert.ok(x.d.querySelector('#remove-computer'));
});

test('a saved proposal that differs from the choice is never accepted',async()=>{
 const x=setup();await x.openJob();x.click('#give-computer');x.click('#review-confirm');
 x.answer(x.requests('propose_pip_update')[0],{proposal:{id:'proposal-1',pip_id:pipId,expected_version:1,status:'proposed',definition:{...job(),computer_plan:{schema_version:1,network:'any'}}}});await flush();
 assert.equal(x.requests('accept_pip_update').length,0);
 assert.match(x.d.querySelector('[role=dialog]').textContent,/differs from your choice/);
});

test('a machine without the sandbox says why instead of offering the switch',async()=>{
 const x=setup({status:computer({granted:false,available:false,reason:'Pip computers need bubblewrap. Install it with your package manager.'})});await x.openJob();
 assert.equal(x.d.querySelector('#give-computer'),null);assert.match(x.d.body.textContent,/need bubblewrap/);
});

test('a held submit is reviewed with its screenshot; Send once sends that exact action and digest',async()=>{
 const hostile=action({summary:{...action().summary,host:'<img src=x onerror=alert(1)>',fields:[{name:'note',value:'<script>bad()</script>'}]}});
 const x=setup({pip:job({computer_plan:PLAN}),status:computer({pending:1,actions:[hostile]})});await x.openJob();
 assert.match(x.d.body.textContent,/Waiting for you/);
 assert.equal(x.d.querySelectorAll('#app img').length,0,'page text from the website is shown as text');
 x.click(`[data-computer-action="${actionId}"]`);await flush();
 const frame=x.requests('get_pip_computer_frame')[0];assert.deepEqual(JSON.parse(JSON.stringify(frame.request)),{type:'get_pip_computer_frame',run_id:runId,frame:'0002.jpg'});
 x.answer(frame,{run_id:runId,frame:'0002.jpg',image:JPEG});await flush();
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog);
 assert.equal(dialog.querySelectorAll('img').length,1);assert.equal(dialog.querySelector('img').getAttribute('src'),JPEG);
 assert.match(dialog.textContent,/<script>bad\(\)<\/script>/);assert.match(dialog.textContent,/Nothing has been sent/);
 assert.equal(x.requests('decide_pip_computer_action').length,0,'opening the review sends nothing');
 x.click('#review-confirm');
 const decided=x.requests('decide_pip_computer_action')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(decided.request)),{type:'decide_pip_computer_action',action_id:actionId,expected_digest:'d'.repeat(64),approve:true});
 x.setStatus(computer());x.answer(decided,{action:{...hostile,status:'approved',resolved_at:'2026-10-04T10:01:00Z',resolved_by:'editor-user'}});await x.drain();
 assert.equal(x.d.querySelector('[role=dialog]'),null);assert.match(x.d.body.textContent,/Approved. It is sent within a few seconds, exactly as shown/);
});

test('Always allow sends this submit and lets the Pip make the same one on that site without asking',async()=>{
 const x=setup({pip:job({computer_plan:PLAN}),status:computer({pending:1,actions:[action({frame:null,summary:{...action().summary,payment:true}})]})});await x.openJob();
 x.click(`[data-computer-action="${actionId}"]`);await flush();
 const dialog=x.d.querySelector('[role=dialog]');
 assert.match(dialog.textContent,/This sends payment card details\./,'a payment is said plainly, then decided like anything else');
 assert.ok(x.d.querySelector('#review-always'),'Always allow sits beside Send once');
 x.click('#review-always');x.click('#review-always');
 const asked=x.requests('always_allow_pip_computer_action');
 assert.equal(asked.length,1,'one decision, however many clicks');
 assert.deepEqual(JSON.parse(JSON.stringify(asked[0].request)),{type:'always_allow_pip_computer_action',action_id:actionId,expected_digest:'d'.repeat(64)});
 assert.equal(x.requests('decide_pip_computer_action').length,0,'not also a Send once');
 x.setStatus(computer());x.answer(asked[0],{action:action({frame:null,status:'approved',resolved_at:'2026-10-05T10:00:00Z',resolved_by:'editor-user'}),grant});await x.drain();
 assert.equal(x.d.querySelector('[role=dialog]'),null);
 assert.match(x.d.body.textContent,/Always allowed: Submit in its browser to shop\.example\/order\. It is sent within a few seconds/);
});

test('an Always allow receipt that is not an approval is not reported as done',async()=>{
 const x=setup({pip:job({computer_plan:PLAN}),status:computer({pending:1,actions:[action({frame:null})]})});await x.openJob();
 x.click(`[data-computer-action="${actionId}"]`);await flush();x.click('#review-always');
 const asked=x.requests('always_allow_pip_computer_action')[0];
 x.answer(asked,{action:action({frame:null,status:'pending'}),grant});await x.drain();
 assert.doesNotMatch(x.d.body.textContent,/Always allowed/);
 assert.match(x.d.body.textContent,/differs from your choice/);
});

test('Always allow for a browser submit needs a CLI with Pip computers',async()=>{
 const x=setup({apiVersion:41,pip:job({computer_plan:PLAN})});await x.drain();
 assert.equal(x.requests('get_pip_computer').length,0);assert.equal(x.d.querySelector('#review-always'),null);
});

test('Reject sends a rejection; a receipt for another decision is not reported as done',async()=>{
 const x=setup({pip:job({computer_plan:PLAN}),status:computer({pending:1,actions:[action({frame:null})]})});await x.openJob();
 x.click(`[data-computer-action="${actionId}"]`);await flush();
 assert.equal(x.requests('get_pip_computer_frame').length,0,'no screenshot, no frame request');
 x.click('#reject-computer-action');
 const decided=x.requests('decide_pip_computer_action')[0];assert.equal(decided.request.approve,false);
 x.answer(decided,{action:action({frame:null,status:'approved'})});await flush();
 assert.match(x.d.querySelector('[role=dialog]').textContent,/differs from your choice/);
 assert.doesNotMatch(x.d.body.textContent,/Rejected. Nothing was sent/);
});

test('an expired action cannot be sent',async()=>{
 const x=setup({pip:job({computer_plan:PLAN}),status:computer({pending:1,actions:[action({frame:null,expires_at:'2020-01-01T00:00:00Z'})]})});await x.openJob();
 x.click(`[data-computer-action="${actionId}"]`);await flush();
 assert.equal(x.d.querySelector('#review-confirm').disabled,true);
 x.d.querySelector('#review-confirm').disabled=false;x.click('#review-confirm');await flush();   // a stale enabled button
 assert.equal(x.requests('decide_pip_computer_action').length,0);
 assert.match(x.d.querySelector('[role=dialog]').textContent,/expired. Nothing was sent/);
});

test('the live browser: the user clicks, types and goes to a page; closing it stops the refresh',async()=>{
 const x=setup({pip:job({computer_plan:PLAN}),status:computer()});await x.openJob();
 x.click('#open-computer');await flush();
 assert.equal(x.requests('open_pip_computer')[0].request.pip_id,pipId);
 x.answer(x.requests('open_pip_computer')[0],{view:{pip_id:pipId,ready:true,host_id:'h'}});await flush();
 const first=x.requests('use_pip_computer_view')[0];assert.equal(first.request.op,'frame');
 x.answer(first,{view:{ok:true,watching:false,url:'https://accounts.example/login',width:1280,height:800,image:JPEG}});await flush();
 const screen=x.d.querySelector('#computer-screen');assert.equal(screen.getAttribute('src'),JPEG);
 assert.equal(x.d.querySelector('#computer-status').textContent,'https://accounts.example/login');
 // A click on the shown image lands on the same point of the page, at the page's own size.
 screen.getBoundingClientRect=()=>({left:10,top:20,width:640,height:400,right:650,bottom:420,x:10,y:20});
 screen.dispatchEvent(new x.w.MouseEvent('click',{bubbles:true,clientX:330,clientY:220}));await flush();
 const click=x.requests('use_pip_computer_view').at(-1).request;assert.deepEqual([click.op,click.x,click.y],['click',640,400]);
 x.answer(x.requests('use_pip_computer_view').at(-1),{view:{ok:true,watching:false,url:'https://accounts.example/login',width:1280,height:800,image:JPEG}});await flush();
 x.d.querySelector('#computer-text').value='ada@example.com';x.submit('#computer-type');
 const typed=x.requests('use_pip_computer_view').at(-1).request;assert.deepEqual([typed.op,typed.text],['type','ada@example.com']);
 assert.equal(x.d.querySelector('#computer-text').value,'','the typed text is not kept in the form');
 x.answer(x.requests('use_pip_computer_view').at(-1),{view:{ok:true,watching:false,url:'u',width:1280,height:800,image:JPEG}});await flush();
 x.d.querySelector('#computer-url').value='mail.example.com';x.submit('#computer-go');
 assert.deepEqual([x.requests('use_pip_computer_view').at(-1).request.op,x.requests('use_pip_computer_view').at(-1).request.url],['go','https://mail.example.com']);
 x.answer(x.requests('use_pip_computer_view').at(-1),{view:{ok:false,error:'That address is not allowed.'}});await flush();
 assert.equal(x.d.querySelector('#computer-status').textContent,'That address is not allowed.');
 x.click('#computer-tab');assert.deepEqual([x.requests('use_pip_computer_view').at(-1).request.op,x.requests('use_pip_computer_view').at(-1).request.key],['key','Tab']);
 x.answer(x.requests('use_pip_computer_view').at(-1),{view:{ok:true,watching:true,url:'u',width:1280,height:800,image:JPEG}});await flush();
 assert.match(x.d.querySelector('#computer-status').textContent,/The Pip is using its browser right now/);
 const timer=x.timers.find(t=>t.live&&t.fn.toString().includes('computerView'));assert.ok(timer,'the view refreshes while open');
 x.click('#review-cancel');assert.equal(timer.live,false,'closing the browser stops the refresh');
});

test('a reply that is not a JPEG screenshot is refused rather than shown',async()=>{
 const x=setup({pip:job({computer_plan:PLAN}),status:computer()});await x.openJob();
 x.click('#open-computer');await flush();x.answer(x.requests('open_pip_computer')[0],{view:{pip_id:pipId,ready:true,host_id:'h'}});await flush();
 x.answer(x.requests('use_pip_computer_view')[0],{view:{ok:true,watching:false,url:'u',width:1,height:1,image:'data:text/html;base64,PHNjcmlwdD4='}});await flush();
 assert.equal(x.d.querySelector('#computer-screen').getAttribute('src'),null);
 assert.match(x.d.querySelector('#computer-status').textContent,/invalid/);
});

test('Stop asks the supervisor to stop; a proposal review says what changes about the computer',async()=>{
 const proposal={id:'proposal-2',pip_id:pipId,expected_version:1,status:'proposed',definition:{...job(),computer_plan:null},reason:'Remove the computer.'};
 const x=setup({pip:job({computer_plan:PLAN,proposals:[proposal]}),status:computer()});await x.openJob();
 x.click('#stop-computer');assert.equal(x.requests('stop_pip_computer')[0].request.pip_id,pipId);
 x.answer(x.requests('stop_pip_computer')[0],{pip_id:pipId,stopping:true});await x.drain();
 assert.match(x.d.body.textContent,/Stopping the computer/);
 x.click('[data-tab=revisions]');x.click('[data-proposal=proposal-2]');
 const dialog=x.d.querySelector('[role=dialog]').textContent;assert.match(dialog,/Computer nowIts own browser and files/);assert.match(dialog,/Computer afterNone/);
});

test('a run that used its computer shows how much, and what it saw one screenshot at a time',async()=>{
 const run={id:runId,pip_id:pipId,status:'succeeded',created_at:'2026-10-04T10:00:00Z',manifest:{run_kind:'personal_task',job_version:1},result:{text:'Two books renewed; one needs your approval.',external_actions:false,computer:{calls:3,held:[actionId]}}};
 const x=setup({pip:job({computer_plan:PLAN}),status:computer(),runs:[run]});await x.drain();x.click('[data-job]');await x.drain();
 x.click('[data-tab=runs]');await x.drain();if(x.d.querySelector(`[data-run="${runId}"]`))x.click(`[data-run="${runId}"]`);await x.drain();
 assert.match(x.d.body.textContent,/Used its computer: 3 steps · 1 waiting for your approval in the Job tab/);
 x.click('#computer-timeline');await flush();
 const list=x.requests('list_pip_computer_frames')[0];assert.deepEqual(JSON.parse(JSON.stringify(list.request)),{type:'list_pip_computer_frames',run_id:runId});
 const frames=[{frame:'0001.jpg',label:'open https://library.example/',url:'https://library.example/',at:'2026-10-04T10:00:01Z'},{frame:'0002.jpg',label:'<img src=x onerror=alert(1)>',url:'https://library.example/loans',at:'2026-10-04T10:00:02Z'}];
 x.answer(list,{run_id:runId,frames});await flush();
 assert.equal(x.requests('get_pip_computer_frame')[0].request.frame,'0001.jpg');
 x.answer(x.requests('get_pip_computer_frame')[0],{run_id:runId,frame:'0001.jpg',image:JPEG});await flush();
 const dialog=x.d.querySelector('[role=dialog]');
 assert.equal(x.d.querySelector('#computer-timeline-img').getAttribute('src'),JPEG);
 assert.equal(x.d.querySelector('#computer-timeline-status').textContent,'1 of 2');
 assert.equal(x.d.querySelector('#computer-prev').disabled,true);assert.equal(x.d.querySelector('#computer-next').disabled,false);
 x.click('#computer-next');await flush();
 assert.equal(x.requests('get_pip_computer_frame')[1].request.frame,'0002.jpg');
 assert.equal(x.d.querySelector('#computer-prev').disabled,false);assert.equal(x.d.querySelector('#computer-next').disabled,true);
 assert.equal(x.d.querySelector('#computer-timeline-label').textContent,'<img src=x onerror=alert(1)> · https://library.example/loans');
 assert.equal(dialog.querySelectorAll('img').length,1,'a label from a website is text');
 x.answer(x.requests('get_pip_computer_frame')[1],{run_id:runId,frame:'0001.jpg',image:JPEG});await flush();
 assert.match(x.d.querySelector('#computer-timeline-status').textContent,/invalid/,'a reply for another screenshot is refused');
 x.click('#review-cancel');x.click('#computer-timeline');await flush();
 x.answer(x.requests('list_pip_computer_frames')[1],{run_id:runId,frames:[{...frames[0],frame:'../secret.jpg'}]});await flush();
 assert.match(x.d.querySelector('#computer-timeline-status').textContent,/invalid/);assert.equal(x.requests('get_pip_computer_frame').length,2);
});

test('the extension host passes computer commands only to an API 42 CLI',()=>{
 for(const api of [41,42]){
  const posted=[],sent=[];const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{}:require(name));
  const editor=new out.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  for(const [type,extra] of [['always_allow_pip_computer_action',{action_id:actionId,expected_digest:'d'.repeat(64)}],['get_pip_computer',{pip_id:pipId}],['decide_pip_computer_action',{action_id:actionId,expected_digest:'d'.repeat(64),approve:true}],['use_pip_computer_view',{pip_id:pipId,op:'frame'}],['propose_pip_update',{pip_id:pipId,expected_version:1,changes:{computer_plan:PLAN},reason:'x'}]])
   editor.receive({type:'pipsRequest',id:type,request:{type,...extra}});
  assert.equal(sent.length,api>=42?5:0,`API ${api}`);
  if(api<42)assert.match(posted.at(-1).error.message,/API 42/);
 }
});

test('validators accept the backend shapes and refuse anything else',()=>{
 const m=model.exports,a=action();
 assert.equal(m.pipComputerAction(a,pipId),a);
 for(const bad of [{...a,extra:1},{...a,id:'pip_'+'c'.repeat(32)},{...a,pip_id:'b'},{...a,status:'sending'},{...a,digest:'x'},{...a,frame:'../x.jpg'},{...a,summary:{...a.summary,fields:'name=Ada'}}])
  assert.throws(()=>m.pipComputerAction(bad,pipId),JSON.stringify(bad).slice(0,60));
 assert.equal(m.pipComputer(computer({actions:[a],pending:1}),pipId).pending,1);
 assert.throws(()=>m.pipComputer({...computer(),token:'secret'},pipId),/invalid/);
 assert.deepEqual(m.pipComputerView({ok:false,error:'Closed.',ready:false}),{ok:false,error:'Closed.',ready:false});
 assert.throws(()=>m.pipComputerView({ok:true,watching:false,url:'u',width:1,height:1,image:'data:image/svg+xml;base64,PHN2Zz4='}));
 assert.throws(()=>m.pipComputerFrame({run_id:runId,frame:'0001.jpg',image:JPEG},runId,'0002.jpg'));
});
