// A Pip connects your apps from its own chat, like Grok's connectors (Pips API 43). The founder's Gmail
// Pip answered "I can't set up the Gmail connection myself — I've got no tool for it"; now it asks with
// connect_app and this card is the user's side. The host opens the sign-in page from the backend's
// reply: the webview never sees the link.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewCode=await bundle('pipsView.ts');

const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'g'.repeat(32),LINK='applink_'+'a'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,name,type,extra={})=>({id,workspace_id:PW,pip_type:type,name,goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const pipRow=pip(PIP,'Gmail','scout');
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const link=(extra={})=>({id:LINK,pip_id:PIP,workspace_id:PW,toolkit:'gmail',app:'Gmail',reason:'To read your new mail each morning.',status:'requested',label:null,error:null,created_at:'2026-10-07T09:00:00.000Z',updated_at:new Date().toISOString(),...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));
function setup({links=[link()],composio=true,messages=[],drafts=[],computer=null}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),timers=[];
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 const realTimeout=w.setTimeout.bind(w);
 w.setTimeout=(fn,ms)=>{if(ms===4000){timers.push({fn,ms});return 0;}return realTimeout(fn,ms);};
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'},{id:'ws_'+'1'.repeat(32),name:'demo',kind:'project'}],current_workspace_id:'ws_'+'1'.repeat(32)}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:r.workspace_id===PW?[pipRow]:[]}),get_pip:()=>({pip:pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:r.workspace_id||PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:computer||{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:PIP,links,composio}),list_pip_message_drafts:()=>({drafts:drafts.map(d=>({id:d.id,pip_id:d.pip_id,workspace_id:d.workspace_id,status:d.status,expired:d.expired,subject:d.payload.message.subject,digest:d.digest,source_run_id:d.source_run_id,expires_at:d.expires_at,action_id:d.action_id})),next_cursor:null}),get_pip_message_draft:()=>({draft:drafts.find(d=>d.id===r.draft_id)}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion:43,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,timers,setLinks:v=>{links=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}

test('the Pip asks; the card says what for, Connect goes to DGC by card, and Not now says no',async()=>{
 const x=setup();await openChat(x);
 const card=x.d.querySelector(`[data-app-link="${LINK}"]`);assert.ok(card,'the Connect card is in the chat');
 assert.match(card.textContent,/Connect Gmail.*To read your new mail each morning\./);
 assert.deepEqual([...card.querySelectorAll('button')].map(b=>b.textContent),['Connect Gmail','Not now']);
 x.click(`[data-app-link-start="${LINK}"]`);
 const start=x.requests('start_pip_app_link')[0];assert.deepEqual(JSON.parse(JSON.stringify(start.request)),{type:'start_pip_app_link',pip_id:PIP,link_id:LINK});
 assert.match(x.d.querySelector(`[data-app-link="${LINK}"]`).textContent,/Opening…/);
 x.answer(start,{link:link({status:'authorizing'}),opened:true,sign_in_host:'connect.composio.dev'});await flush();
 const waiting=x.d.querySelector(`[data-app-link="${LINK}"]`);
 assert.match(waiting.textContent,/Finish signing in to Gmail.*Your browser opened connect\.composio\.dev/);
 assert.deepEqual([...waiting.querySelectorAll('button')].map(b=>b.textContent),['I’ve signed in','Open sign-in again','Not now']);
 assert.equal(x.d.body.innerHTML.includes('https://'),false,'no sign-in link in the page');
});

test('while the browser is open the card looks by itself, and turns into connected; the Pip is asked to carry on',async()=>{
 const x=setup({links:[link({status:'authorizing'})]});await openChat(x);
 x.click(`[data-app-link-start="${LINK}"]`);x.answer(x.requests('start_pip_app_link')[0],{link:link({status:'authorizing'}),opened:true,sign_in_host:'connect.composio.dev'});await flush();
 const look=x.timers.filter(t=>t.ms===4000).at(-1);assert.ok(look,'a look in four seconds');look.fn();await flush();
 const check=x.requests('check_pip_app_link').at(-1);assert.equal(check.request.link_id,LINK);
 x.answer(check,{link:link({status:'authorizing'}),connected:false});await flush();
 x.click(`[data-app-link-check="${LINK}"]`);
 const now=x.requests('check_pip_app_link').at(-1);x.setLinks([link({status:'connected',label:'me@example.com',server:'composio',account:'ca_done'})]);x.answer(now,{link:link({status:'connected',label:'me@example.com',server:'composio',account:'ca_done'}),connected:true});await x.drain();
 const done=x.d.querySelector(`[data-app-link="${LINK}"]`);
 assert.match(done.textContent,/Gmail connected.*me@example\.com/);assert.equal(done.querySelectorAll('button').length,0);
 assert.match(x.d.body.textContent,/Gmail is connected to Gmail\./);
 assert.ok(x.requests('list_pip_messages').length>=2,'the chat reloads: the Pip carries on');
});

test('without Composio the card says how to add it, and Not now declines',async()=>{
 const x=setup({composio:false});await openChat(x);
 const card=x.d.querySelector(`[data-app-link="${LINK}"]`);
 assert.match(card.textContent,/first turn on Composio in Settings → Plugins/);
 x.click(`[data-app-link-settings="${LINK}"]`);assert.deepEqual(JSON.parse(JSON.stringify(x.sent.at(-1))),{type:'openSettings',section:'plugins'});
 x.click(`[data-app-link-decline="${LINK}"]`);
 const no=x.requests('decline_pip_app_link')[0];assert.equal(no.request.link_id,LINK);
 x.answer(no,{link:link({status:'declined'})});await flush();
 assert.equal(x.d.querySelector(`[data-app-link="${LINK}"]`),null,'gone after Not now');
});

test('a card for another Pip, or a forged reply, is refused',async()=>{
 const x=setup({links:[link({pip_id:'pip_'+'h'.repeat(32)})]});await openChat(x);
 assert.equal(x.d.querySelector('[data-app-link]'),null);
 assert.match(x.d.body.textContent,/cards didn’t load|card didn’t load/);
});

test('the host opens the sign-in page from the backend reply, and the webview never gets the link',async()=>{
 const opened=[];const vs={env:{openExternal:async uri=>{opened.push(String(uri));return true;}},Uri:{parse:(s)=>({toString:()=>s}),joinPath:()=>''}};
 const sent=[],posted=[];const {PipsEditor}=load(viewCode,name=>name==='vscode'?vs:require(name));
 const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));
 bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:43},{});
 for(const [url,expected] of [['https://connect.composio.dev/link/ln_abc',true],['http://connect.composio.dev/link/x',false],['https://u:p@evil.example/x',false]]){
  bridge.receive({type:'pipsRequest',id:'c1',request:{type:'start_pip_app_link',pip_id:PIP,link_id:LINK}});
  const out=sent.at(-1);assert.equal(out.request.type,'start_pip_app_link');
  bridge.event({type:'pips_result',request_id:out.request.request_id,command:'start_pip_app_link',ok:true,result:{link:link({status:'authorizing'}),redirect_url:url,sign_in_host:'connect.composio.dev'}});
  await flush();await flush();
  const reply=posted.at(-1);assert.equal(reply.id,'c1');
  assert.equal(JSON.stringify(reply).includes(url),false,'the link stays in the host');
  assert.equal(reply.result.opened,expected);
 }
 assert.deepEqual(opened,['https://connect.composio.dev/link/ln_abc']);
});

test("a Pip's Settings list its connected apps, and Disconnect stops it using one",async()=>{
 const x=setup({links:[link({status:'connected',label:'me@example.com',server:'composio',account:'ca_done',updated_at:'2026-10-01T09:00:00.000Z'})]});await openChat(x);
 assert.equal(x.d.querySelector('[data-app-link]'),null,'an old connection is not a card in the chat');
 x.click('.pip-menu [data-tab="job"]');await x.drain();
 const apps=x.d.querySelector('[aria-label="Apps"]');assert.ok(apps);assert.match(apps.textContent,/Gmail me@example\.com.*Disconnect/);
 x.click(`[data-app-link-disconnect="${LINK}"]`);
 const off=x.requests('disconnect_pip_app_link')[0];assert.equal(off.request.link_id,LINK);
 x.setLinks([link({status:'declined'})]);x.answer(off,{link:link({status:'declined'})});await x.drain();
 assert.match(x.d.querySelector('[aria-label="Apps"]').textContent,/Nothing connected\. Ask Gmail in its chat to connect an app/);
});

const message=(id,role,text,extra={})=>({id,pip_id:PIP,workspace_id:PW,role,text,run_id:'run_'+id.padEnd(32,'0').slice(0,32),status:'succeeded',model:'m',created_at:'2026-10-07T09:00:00.000Z',...extra});
test("Grok's A/B card: the Pip's choices sit under its latest reply, and a tap answers with one",async()=>{
 const x=setup({links:[],messages:[message('u1','user','Hi'),message('a1','assistant','Shall I connect Gmail?',{choices:['Yes, connect Gmail','Not yet']})]});await openChat(x);
 const choices=[...x.d.querySelectorAll('.msg-choice')];
 assert.deepEqual(choices.map(b=>b.textContent),['AYes, connect Gmail','BNot yet']);
 assert.equal(x.d.querySelector('[data-message="a1"] .msg-choices')!==null,true,'under the reply');
 choices[0].click();await flush();
 const sent=x.requests('send_pip_message').at(-1);assert.ok(sent,'the tap is the reply');assert.equal(sent.request.text,'Yes, connect Gmail');
});
test('choices under an older reply are not offered, and words already typed are kept',async()=>{
 const x=setup({links:[],messages:[message('u1','user','Hi'),message('a1','assistant','Shall I?',{choices:['Yes','No']}),message('u2','user','Yes')]});await openChat(x);
 assert.equal(x.d.querySelector('.msg-choice'),null,'answered already');
 const y=setup({links:[],messages:[message('u1','user','Hi'),message('a1','assistant','Which?',{choices:['Gmail','Calendar']})]});await openChat(y);
 const box=y.d.getElementById('chatText');box.value='and also';box.dispatchEvent(new y.w.Event('input',{bubbles:true}));
 y.d.querySelector('.msg-choice').click();await flush();
 assert.equal(y.requests('send_pip_message').length,0,'not sent over your draft');
 assert.equal(y.d.getElementById('chatText').value,'and also Gmail');
});

// Grok's Allow card: the email a Pip wrote, inline, with Send / Always allow; the reviewed steps run
// without the dialogs, on the Pip's own connected Gmail account.
const RUN='run_'+'5'.repeat(32),DRAFT='maildraft_'+'3'.repeat(32),ACTION='appaction_'+'2'.repeat(32);
const mail={recipient_email:'friend@example.test',subject:'A short note',body:'Lunch on Friday? <img src=x>'};
const source={run_id:RUN,pip_id:PIP,workspace_id:PW,job_version:1,lifecycle_revision:0,result_digest:'e'.repeat(64)};
const draft=(extra={})=>({id:DRAFT,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status:'pending',digest:'c'.repeat(64),expired:false,expires_at:'2099-10-05T06:00:00Z',action_id:null,payload:{schema_version:1,source,message:mail},...extra});
const action=(status='pending')=>({id:ACTION,pip_id:PIP,workspace_id:PW,source_run_id:RUN,status,digest:'d'.repeat(64),expires_at:'2099-10-05T06:00:00Z',payload:{schema_version:1,kind:'gmail_send',source,server:'composio',connection_digest:'a'.repeat(64),schema_digest:'b'.repeat(64),account:'ca_home',message:mail},receipt:null});
const gmail=()=>link({status:'connected',label:'me@example.com',server:'composio',account:'ca_home',updated_at:'2026-10-01T09:00:00.000Z'});
test('the email a Pip wrote is an Allow card; Send prepares that exact draft on its Gmail account and sends it once',async()=>{
 const x=setup({links:[gmail()],drafts:[draft()]});await openChat(x);
 const card=x.d.querySelector(`[data-allow-card="${DRAFT}"]`);assert.ok(card,'inline in the chat');
 assert.match(card.textContent,/Send this email\?From me@example\.com.*To.*friend@example\.test.*A short note.*Lunch on Friday\? <img src=x>/);
 assert.equal(card.querySelector('img'),null,'the body is text');
 assert.deepEqual([...card.querySelectorAll('button')].map(b=>b.textContent),['Send','Always allow','Edit','Don’t send']);
 x.click(`[data-allow-send="${DRAFT}"]`);await flush();
 x.answer(x.requests('list_pip_accounts').at(-1),{server:'composio',connection_digest:'a'.repeat(64),accounts:[{id:'ca_other',label:'Work',toolkit:'gmail'},{id:'ca_home',label:'Home',toolkit:'gmail'}]});
 x.answer(x.requests('inspect_pip_send_connection').at(-1),{server:'composio',connection_digest:'a'.repeat(64),tool:'GMAIL_SEND_EMAIL',schema_digest:'b'.repeat(64),account_required:true});await flush();
 const prep=x.requests('prepare_pip_message_draft').at(-1);
 assert.deepEqual(JSON.parse(JSON.stringify(prep.request)),{type:'prepare_pip_message_draft',draft_id:DRAFT,expected_digest:'c'.repeat(64),server:'composio',connection_digest:'a'.repeat(64),account:'ca_home',schema_digest:'b'.repeat(64),message:mail});
 x.answer(prep,{action:action()});await flush();
 const ok=x.requests('accept_pip_app_action').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(ok.request)),{type:'accept_pip_app_action',action_id:ACTION,expected_digest:'d'.repeat(64)});
 assert.equal(x.requests('always_allow_pip_app_action').length,0);
 x.answer(ok,{action:action('approved')});await x.drain();
 assert.match(x.d.body.textContent,/Sent, exactly as shown\./);
});
test('Always allow sends this one and saves the grant; without a connected Gmail the card asks for an account; Don’t send dismisses',async()=>{
 const x=setup({links:[gmail()],drafts:[draft()]});await openChat(x);
 x.click(`[data-allow-always="${DRAFT}"]`);await flush();
 x.answer(x.requests('list_pip_accounts').at(-1),{server:'composio',connection_digest:'a'.repeat(64),accounts:[{id:'ca_home',label:'Home',toolkit:'gmail'}]});
 x.answer(x.requests('inspect_pip_send_connection').at(-1),{server:'composio',connection_digest:'a'.repeat(64),tool:'GMAIL_SEND_EMAIL',schema_digest:'b'.repeat(64),account_required:true});await flush();
 x.answer(x.requests('prepare_pip_message_draft').at(-1),{action:action()});await flush();
 assert.equal(x.requests('accept_pip_app_action').length,0);assert.ok(x.requests('always_allow_pip_app_action').at(-1),'Always allow');
 const y=setup({links:[],drafts:[draft()]});await openChat(y);
 const card=y.d.querySelector(`[data-allow-card="${DRAFT}"]`);
 assert.match(card.textContent,/No Gmail connected to it yet/);assert.deepEqual([...card.querySelectorAll('button')].map(b=>b.textContent),['Choose account…','Don’t send']);
 y.click(`[data-allow-dismiss="${DRAFT}"]`);
 const no=y.requests('dismiss_pip_message_draft').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(no.request)),{type:'dismiss_pip_message_draft',draft_id:DRAFT,expected_digest:'c'.repeat(64)});
});
test('a Gmail account Composio no longer has is never swapped for another',async()=>{
 const x=setup({links:[gmail()],drafts:[draft()]});await openChat(x);
 x.click(`[data-allow-send="${DRAFT}"]`);await flush();
 x.answer(x.requests('list_pip_accounts').at(-1),{server:'composio',connection_digest:'a'.repeat(64),accounts:[{id:'ca_other',label:'Work',toolkit:'gmail'}]});
 x.answer(x.requests('inspect_pip_send_connection').at(-1),{server:'composio',connection_digest:'a'.repeat(64),tool:'GMAIL_SEND_EMAIL',schema_digest:'b'.repeat(64),account_required:true});await x.drain();
 assert.equal(x.requests('prepare_pip_message_draft').length,0);
 assert.match(x.d.body.textContent,/me@example\.com is no longer in Composio/);
});

// Google's "unusual traffic" page: the Pip stopped (it never solves a robot check); the chat says it needs
// you, opens its computer, and "I've done it" lets it carry on.
test('a robot check on its computer is a "needs you" card: Open its computer, then I’ve done it',async()=>{
 const computer={pip_id:PIP,granted:true,available:true,reason:'',pending:0,actions:[],needs_you:{host:'www.google.com',at:'2026-10-07T09:00:00.000Z'}};
 const x=setup({links:[],computer});await openChat(x);
 const card=x.d.querySelector('[data-state="needs"]');assert.ok(card,'the card is in the chat');
 assert.match(card.textContent,/Gmail needs you.*www\.google\.com wants to check you’re not a robot/);
 x.click('[data-needs-open]');
 assert.deepEqual(JSON.parse(JSON.stringify(x.sent.at(-1))),{type:'pipsOpenComputer',pip:{id:PIP,name:'Gmail',pip_type:'scout'}});
 x.click('[data-needs-done]');
 const done=x.requests('finish_pip_computer_check').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(done.request)),{type:'finish_pip_computer_check',pip_id:PIP});
 delete computer.needs_you;x.answer(done,{pip_id:PIP,continued:true,run_id:'run_'+'9'.repeat(32)});await x.drain();
 assert.equal(x.d.querySelector('[data-state="needs"]'),null,'gone once you have done it');
 assert.match(x.d.body.textContent,/Gmail is carrying on\./);
});
