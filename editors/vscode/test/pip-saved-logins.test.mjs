// Saved logins for Personal Pips (Pips API 56). When a Pip meets a sign-in page with no saved login, its chat shows
// "Save a login for SITE so PIP can sign in itself?" with Save login… and Not now. The form takes the username, the
// password and an optional authenticator key, sends them to DGC once, and keeps nothing: not in the chat, its draft,
// the view's saved state or the page. Its page lists the logins it may use (Logins), never a password or key.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewModule=load(await bundle('pipsView.ts'),name=>name==='vscode'?{}:require(name));
const model=load(await bundle('pipsModel.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const tabCode=(await build({entryPoints:[fileURLToPath(new URL('pipComputerClient.js',base))],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'b'.repeat(32),OTHER='pip_'+'c'.repeat(32),ACTION='compact_'+'d'.repeat(32),DIGEST='e'.repeat(64);
const LOGIN='login_'+'1'.repeat(32),SHARED='login_'+'2'.repeat(32);
const PASSWORD='Nw-Pass-7Qx2-zz91',KEY='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,name,extra={})=>({id,workspace_id:PW,pip_type:'lens',name,goal:'Check my bank account when I ask.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true},computer_plan:{schema_version:1},...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const now=new Date().toISOString();
const offer={id:ACTION,pip_id:PIP,workspace_id:PW,run_id:'run_'+'a'.repeat(32),digest:DIGEST,frame:null,status:'pending',created_at:now,expires_at:'2999-01-01T00:00:00.000Z',
 resolved_at:null,resolved_by:null,continuation_run_id:null,summary:{method:'SIGN IN',host:'login.northwind-bank.example',path:'/signin',fields:[],more_fields:0,body_bytes:0,
 page:'https://login.northwind-bank.example/signin',kind:'login',site:'northwind-bank.example',shown:'login.northwind-bank.example',sign_in_page:'https://login.northwind-bank.example/signin'}};
const login=(extra={})=>({id:LOGIN,site:'northwind-bank.example',hosts:['login.northwind-bank.example'],username:'arjun.mehta',has_code:true,pips:[PIP],source:'card',created_at:now,last_used_at:null,usable:true,...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({apiVersion=56,actions=[offer],logins=[login(),login({id:SHARED,site:'contoso-mail.example',hosts:['mail.contoso-mail.example'],username:'arjun',has_code:false,pips:[OTHER],usable:false})],saveFails=''}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),states=[];
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:s=>states.push(JSON.stringify(s))});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const state={actions,logins};
 const rows=[pip(PIP,'Banker'),pip(OTHER,'Mailer')];
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:rows}),get_pip:()=>({pip:rows[0]}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:true,available:true,reason:'',pending:state.actions.length,actions:state.actions}}),
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:[]}),list_pip_plugins:()=>({pip_id:PIP,plugins:[],installed:[]}),list_pip_notes:()=>({pip_id:PIP,notes:[],max:60}),
  list_pip_sites:()=>({pip_id:PIP,careful:true,sites:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),list_pip_attention:()=>({as_of:now,total:0,counts:{},by_pip:{},items:[],truncated:false}),
  get_pip_eyes:()=>undefined,list_pip_logins:()=>({logins:state.logins}),
  save_pip_login:()=>saveFails?undefined:(state.actions=[],{login:login({source:r.action_id?'card':'page',pips:r.pips==='all'?'all':[PIP]}),...(r.action_id?{action:{...offer,status:'approved'}}:{})}),
  remove_pip_login:()=>(state.logins=state.logins.filter(l=>l.id!==r.login_id),{removed:true,login_id:r.login_id}),
  grant_pip_login:()=>({login:login({pips:r.pips})}),
  decide_pip_computer_action:()=>({action:{...offer,status:r.approve?'approved':'rejected'}})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
 return {w,d:w.document,sent,states,answer,requests,drain,click,type,state};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
async function openPage(x){await openChat(x);x.click('[data-tab="job"]');await x.drain();}
const plain=v=>JSON.parse(JSON.stringify(v));

test('a sign-in page with no saved login shows one card in its chat: Save login… and Not now',async()=>{
 const x=setup();await openChat(x);
 const card=x.d.querySelector(`[data-computer-card="${ACTION}"]`);assert.ok(card,'the card is in its chat');
 assert.match(card.textContent,/Save a login for northwind-bank\.example so Banker can sign in itself\?/);
 assert.match(card.textContent,/Banker needs to sign in on login\.northwind-bank\.example\. DGC keeps the login sealed on this computer and types it in for Banker, which never sees it\./);
 assert.deepEqual([...card.querySelectorAll('button')].map(b=>b.textContent),['Save login…','Not now']);
 x.click(`[data-computer-decide="${ACTION}"][data-approve="0"]`);await x.drain();
 assert.deepEqual(plain(x.requests('decide_pip_computer_action')[0].request),{type:'decide_pip_computer_action',action_id:ACTION,expected_digest:DIGEST,approve:false});
 assert.match(x.d.body.textContent,/Not now\. Banker won’t ask to save a login for northwind-bank\.example again today\./);
});

test('Save login… takes the username, password and key once, sends them to DGC, and keeps none of it',async()=>{
 const x=setup();await openChat(x);
 x.click(`[data-login-card="${ACTION}"]`);
 const dialog=x.d.querySelector('[role=dialog]');assert.ok(dialog);
 assert.match(dialog.textContent,/Save a login for northwind-bank\.example/);
 assert.match(dialog.textContent,/Site northwind-bank\.example \(login\.northwind-bank\.example\)/);
 assert.equal(x.d.querySelector('#loginSite'),null,'the card says where: no site box');
 assert.equal(x.d.querySelector('#loginPassword').type,'password');
 assert.equal(x.d.querySelector('#loginCode').type,'password','the key is hidden as it is typed too');
 assert.match(dialog.textContent,/never sees it, and it never goes in the chat/);
 x.type('#loginUser','arjun.mehta');x.type('#loginPassword',PASSWORD);x.type('#loginCode',KEY);
 x.click('#login-save');await flush();
 const sent=x.requests('save_pip_login');assert.equal(sent.length,1);
 assert.deepEqual(plain(sent[0].request),{type:'save_pip_login',pip_id:PIP,username:'arjun.mehta',password:PASSWORD,pips:'only',totp:KEY,action_id:ACTION,expected_digest:DIGEST});
 await x.drain();
 assert.equal(x.d.querySelector('[role=dialog]'),null,'closed');
 assert.match(x.d.body.textContent,/Saved\. Banker signs in to northwind-bank\.example by itself now\./);
 assert.equal(x.d.querySelector(`[data-computer-card="${ACTION}"]`),null,'the card is answered');
 for(const secret of [PASSWORD,KEY]){
  assert.equal(x.d.documentElement.outerHTML.includes(secret),false,'not on the page');
  assert.equal(x.states.some(s=>s.includes(secret)),false,'not in the view\'s saved state');
 }
 assert.equal(x.requests('send_pip_message').length,0,'nothing went into the chat');
});

test('a problem is said without repeating what was typed; Cancel empties the boxes; the page form asks for the site',async()=>{
 const x=setup({saveFails:'yes'});await openChat(x);
 x.click(`[data-login-card="${ACTION}"]`);
 x.type('#loginUser','arjun');x.click('#login-save');await flush();
 assert.equal(x.requests('save_pip_login').length,0);
 assert.equal(x.d.querySelector('#login-error').textContent,'Type the password.');
 x.type('#loginPassword',PASSWORD);x.type('#loginCode','not-a-key');x.click('#login-save');await flush();
 assert.match(x.d.querySelector('#login-error').textContent,/isn’t an authenticator key/);
 assert.equal(x.d.querySelector('#loginPassword').value,PASSWORD,'what you typed is still there to fix');
 x.type('#loginCode','');x.click('#login-save');await flush();
 const save=x.requests('save_pip_login')[0];x.answer(save,'That card was already answered (approved).',false);await flush();
 assert.match(x.d.querySelector('#login-error').textContent,/already answered/);
 assert.equal(x.d.querySelector('#loginUser').value,'arjun','an error never rebuilds the form');
 const box=x.d.querySelector('#loginPassword');x.click('#review-cancel');
 assert.equal(box.value,'','Cancel empties the boxes');assert.equal(x.d.querySelector('[role=dialog]'),null);
 const page=setup();await openPage(page);
 page.click('[data-login-new]');
 assert.ok(page.d.querySelector('#loginSite'),'from its page, you say the site');
 page.type('#loginUser','a');page.type('#loginPassword',PASSWORD);page.click('#login-save');await flush();
 assert.equal(page.d.querySelector('#login-error').textContent,'Type the site’s address, such as example.com.');
 page.type('#loginSite','https://mail.contoso-mail.example');page.d.querySelector('#loginAll').checked=true;page.click('#login-save');await flush();
 assert.deepEqual(plain(page.requests('save_pip_login')[0].request),{type:'save_pip_login',pip_id:PIP,username:'a',password:PASSWORD,pips:'all',site:'https://mail.contoso-mail.example'});
});

test('its page lists the logins it may use with who may use them; All Pips, Remove and Let it use another Pip\'s',async()=>{
 const x=setup();await openPage(x);
 const group=x.d.querySelector('[aria-label="Logins"]');assert.ok(group,'Logins on its page');
 const rows=[...group.querySelectorAll('[data-login]')];
 assert.match(rows[0].textContent,/northwind-bank\.example.*arjun\.mehta · Fills its code too · Only Banker/);
 assert.match(group.textContent,/Saved for your other Pips.*contoso-mail\.example.*arjun · saved for Mailer/);
 assert.equal(group.textContent.includes(PASSWORD),false);
 const all=group.querySelector(`[data-login-all="${LOGIN}"]`);all.checked=true;all.dispatchEvent(new x.w.Event('change',{bubbles:true}));await flush();
 assert.deepEqual(plain(x.requests('grant_pip_login')[0].request),{type:'grant_pip_login',login_id:LOGIN,pips:'all'});
 await x.drain();
 x.click(`[data-login-share="${SHARED}"]`);await flush();
 assert.deepEqual(plain(x.requests('grant_pip_login')[1].request),{type:'grant_pip_login',login_id:SHARED,pips:[OTHER,PIP]});
 await x.drain();
 x.click(`[data-login-ask-remove="${LOGIN}"]`);
 assert.match(x.d.querySelector('[aria-label="Logins"]').textContent,/Remove it\?/);
 x.click(`[data-login-remove="${LOGIN}"]`);await flush();
 assert.deepEqual(plain(x.requests('remove_pip_login')[0].request),{type:'remove_pip_login',login_id:LOGIN});
 await x.drain();
 assert.match(x.d.body.textContent,/Removed\. No Pip signs in to northwind-bank\.example with it now\./);
});

test('an older CLI is never asked about logins, and the host refuses them before API 56',async()=>{
 const old=setup({apiVersion:55,actions:[]});await openPage(old);
 assert.equal(old.requests('list_pip_logins').length,0);
 assert.equal(old.d.querySelector('[aria-label="Logins"]'),null);
 for(const api of [55,56]){
  const posted=[],out=[];const editor=new viewModule.PipsEditor({},m=>{out.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'l',request:{type:'list_pip_logins',pip_id:PIP}});
  editor.receive({type:'pipsRequest',id:'s',request:{type:'save_pip_login',pip_id:PIP,site:'x.example',username:'a',password:PASSWORD}});
  editor.receive({type:'pipsRequest',id:'r',request:{type:'remove_pip_login',login_id:LOGIN}});
  editor.receive({type:'pipsRequest',id:'g',request:{type:'grant_pip_login',login_id:LOGIN,pips:'all'}});
  assert.equal(out.length,api>=56?4:0,`API ${api}`);
  if(api<56)assert.match(posted.find(m=>m.id==='s').error.message,/Update DGC to save logins for your Pips/);
  if(api>=56)assert.equal(JSON.stringify(editor).includes(PASSWORD),false,'the host keeps no copy of what it sent');
 }
});

test('a login reply is checked: never a password or a key, and the right shape',()=>{
 assert.deepEqual(model.pipLogins({logins:[login()]},PIP),[login()]);
 for(const bad of [{...login(),password:PASSWORD},{...login(),totp:{secret:KEY}},{...login(),pips:['nope']},{...login(),has_code:'yes'},{...login(),id:'x'},{...login(),hosts:[]}])
  assert.throws(()=>model.pipLogins({logins:[bad]},PIP),/saved logins didn't load/);
 assert.throws(()=>model.pipLogins({logins:[],extra:1},PIP),/saved logins didn't load/);
});

test('the computer tab shows a login card with Not now only: the form is in its chat',async()=>{
 const dom=new JSDOM(viewModule.computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();w.setInterval=()=>0;w.clearInterval=()=>{};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(tabCode);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 message({type:'pipComputerInit',pip:{id:PIP,name:'Banker',pip_type:'lens'},desktop:false});
 message({type:'pipsConnection',generation:7,apiVersion:56,connected:true,supported:true,enabled:true});
 for(let round=0;round<10;round++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const r=m.request;const result={get_pip_computer:{computer:{pip_id:PIP,granted:true,available:true,reason:'',pending:1,actions:[offer]}},
  use_pip_computer_view:{view:{ok:true,watching:false,url:'https://login.northwind-bank.example/signin',width:1280,height:800,image:'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='}},
  get_pip_computer_apps:{apps:{apps:[],missing:[],state:'ready',line:'',bytes:null}}}[r.type];if(result){answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});}}}
 const hold=w.document.querySelector('.pc-hold');assert.ok(hold);
 assert.match(hold.textContent,/Save a login for northwind-bank\.example so Banker can sign in itself\?.*Save it from the card in its chat\./);
 assert.deepEqual([...hold.querySelectorAll('button')].map(b=>b.textContent),['Not now']);
});
