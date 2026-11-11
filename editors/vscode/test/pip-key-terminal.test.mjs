// pips-10, slice 2c (Pips API 85): "Also let its Terminal use it" on a site's key card. Only when the Pip is at Do it
// all and has a computer, the card has one quiet tick under the box: "Also let its Terminal use it, as
// $INVOICELY_API_KEY (it could read it there)", off to begin. Save sends terminal: true only when it is ticked; below
// Do it all, without a computer, on a generator's key or with an older DGC there is no tick and `terminal` is never
// sent. On the Pip's page, Keys: a saved key ticked for the Terminal says "· In its Terminal as $INVOICELY_API_KEY", or
// below Do it all "· In its Terminal at Do it all only". The variable's name is DGC's (the row's terminal_name); the
// page's own copy of the rule is pinned to the Python cases in tests/test_pip_keys_terminal.py.
// (Harness from pip-own-key-card.test.mjs. How it looks: pip-key-terminal-browser.test.mjs.)
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewCode=await bundle('pipsView.ts');
const keysModule=load(await bundle('pipKeys.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'9'.repeat(32),KEYID='pipkey_'+'a'.repeat(32),KEYID2='pipkey_'+'b'.repeat(32);
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
// A stand-in, never a real key.
const KEY='inv_test_0123456789abcdefSECRET';
const key=(extra={})=>({id:KEYID,pip_id:PIP,workspace_id:PW,kind:'site',terminal:false,terminal_name:'INVOICELY_API_KEY',name:'Invoicely API key',why:'To read your unpaid invoices.',host:'api.invoicely.example',header:'Authorization: Bearer',status:'requested',saved:false,refused:false,created_at:'2026-11-11T09:00:00Z',saved_at:null,declined_at:null,...extra});
const gen=(extra={})=>{const {terminal_name,...row}=key({kind:'generator',generator:'fal',name:'fal FLUX schnell key',why:'To make pictures.',host:'',header:'',...extra});return row;};
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));
const LEVELS=[['ask','Ask me first'],['approve','Approve for me'],['full','Do it all']].map(([level,name])=>({level,name,says:name+'.'}));

// level: the one the Pip is at ('' for a DGC that never answers). computer: whether it has one.
function setup({keys=[key()],apiVersion=85,level='full',computer=true}={}){
 const dom=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),state={level};
 const pipRow={id:PIP,workspace_id:PW,pip_type:'scout',name:'Ava',goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...(computer?{computer_plan:{schema_version:1}}:{})};
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips:[pipRow]}),get_pip:()=>({pip:pipRow}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:computer,available:true,reason:'',pending:0,actions:[]}}),
  set_pip_level:()=>{state.level=r.level;return {pip_id:PIP,level:state.level,default:'ask',kind:'personal',levels:LEVELS,on_its_own:[]};},
  get_pip_level:()=>state.level?{pip_id:PIP,level:state.level,default:'ask',kind:'personal',levels:LEVELS,on_its_own:[]}:undefined,
  list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_plugins:()=>({pip_id:PIP,plugins:[],key_requests:[],installed:[]}),
  list_pip_keys:()=>({pip_id:PIP,keys}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_routines:()=>({pip_id:PIP,routines:[]}),list_pip_action_grants:()=>({pip_id:PIP,grants:[]}),get_pip_digest:()=>undefined,
  list_pip_apps:()=>({apps:[]}),get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:1})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 const connect=()=>message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 connect();
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d:w.document,sent,answer,requests,drain,click,connect,state,setKeys:v=>{keys=v;}};
}
async function openChat(x){await x.drain();x.click(`[data-job="${PIP}"]`);await x.drain();}
async function openPage(x){await openChat(x);x.click('[data-tab="job"]');await x.drain();}
const clean=v=>JSON.parse(JSON.stringify(v));
const cardOf=(x,id=KEYID)=>x.d.querySelector(`[data-pip-key-card="${id}"]`);
const box=(x,id=KEYID)=>x.d.querySelector(`[data-pip-key-card="${id}"] input[type="password"]`);
const tick=(x,id=KEYID)=>x.d.querySelector(`[data-pip-key-card="${id}"] input[type="checkbox"]`);
const type=(x,el,value)=>{el.value=value;el.dispatchEvent(new x.w.Event('input',{bubbles:true}));};
const setTick=(x,on,id=KEYID)=>{const el=tick(x,id);el.checked=on;el.dispatchEvent(new x.w.Event('change',{bubbles:true}));};
const submit=(x,id=KEYID)=>cardOf(x,id).querySelector('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));
const everywhere=x=>x.d.documentElement.outerHTML+JSON.stringify(x.sent.filter(m=>m.type!=='pipsRequest'||m.request.type!=='save_pip_key'));
const rows=x=>[...x.d.querySelectorAll('section[aria-label="Keys"] [data-pip-key]')].map(r=>r.querySelector('small').textContent);

test('the page names the variable by DGC\'s own rule: every case the Python suite pins, and a few more',()=>{
 const source=readFileSync(new URL('../../../tests/test_pip_keys_terminal.py',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('def test_the_variable_names_are_safe_shell_names'));
 const cases=[...body.slice(0,body.indexOf('self.assertEqual')).matchAll(/\("([^"]*)",\s*"([^"]*)"\)/g)].map(m=>[m[1],m[2]]);
 assert.equal(cases.length,5,'the five cases in tests/test_pip_keys_terminal.py (a new one there is read here too)');
 assert.deepEqual(cases.map(c=>c[0]),['Invoicely API key','weather.com token!','1st key','PATH','']);
 assert.equal(typeof keysModule.terminalName,'function');
 for(const [name,expected] of cases)assert.equal(keysModule.terminalName(name),expected,JSON.stringify(name));
 // The rest of the rule (dgc/pip_keys.py terminal_name): each checked against Python by hand.
 for(const [name,expected] of [['  --my key--  ','MY_KEY'],['http proxy','PIP_KEY_HTTP_PROXY'],['corp_proxy','PIP_KEY_CORP_PROXY'],['ld preload','PIP_KEY_LD_PRELOAD'],
  ['café key','CAF_KEY'],['***','PIP_KEY'],['x'.repeat(70),'X'.repeat(60)],['9'.repeat(70),'KEY_'+'9'.repeat(60)],[undefined,'PIP_KEY'],['a'.repeat(59)+' b','A'.repeat(59)+'_'],['tz','PIP_KEY_TZ']])
  assert.equal(keysModule.terminalName(name),expected,JSON.stringify(name));
 // A row's own terminal_name wins; without one the page works it out.
 assert.equal(keysModule.pipKey(key({terminal_name:'INVOICELY_API_KEY_2'}),PIP).terminalName,'INVOICELY_API_KEY_2');
 const {terminal_name,...bare}=key();assert.equal(keysModule.pipKey(bare,PIP).terminalName,'INVOICELY_API_KEY');
 for(const bad of [{terminal_name:'lower'},{terminal_name:'A B'},{terminal_name:'$(x)'},{terminal_name:'1A'},{terminal_name:''},{terminal_name:7},{terminal:'yes'},{terminal:1}])
  assert.throws(()=>keysModule.pipKey(key(bad),PIP),/didn’t load/,JSON.stringify(bad));
});

test('at Do it all, with a computer: one quiet tick under the box, with the variable\'s name, off to begin',async()=>{
 const x=setup();await openChat(x);
 const el=cardOf(x),t=tick(x);assert.ok(el,'the card');assert.ok(t,'the tick is on the card');
 assert.equal(el.querySelectorAll('input[type="checkbox"]').length,1);
 assert.deepEqual([t.checked,t.hasAttribute('checked'),t.disabled],[false,false,false],'unticked by default');
 const label=t.closest('label');assert.ok(label,'its words are its label: a click on them ticks it');
 assert.equal(label.textContent,'Also let its Terminal use it, as $INVOICELY_API_KEY (it could read it there)');
 const order=[...el.querySelectorAll('input,button')].map(n=>n.type);
 assert.deepEqual(order,['password','checkbox','submit','button'],'under the box, before Save: the keyboard reaches it between them');
 assert.notEqual(t.tabIndex,-1);
 assert.match(el.textContent,/Only sent to api\.invoicely\.example, by DGC\. Ava never sees it\./,'the card\'s own words stay');
});

test('the name on the card is the row\'s terminal_name when DGC sent one',async()=>{
 const x=setup({keys:[key({terminal_name:'PIP_KEY_PATH',name:'PATH'})]});await openChat(x);
 assert.match(tick(x).closest('label').textContent,/as \$PIP_KEY_PATH \(/);
});

test('Save sends terminal: true only when it is ticked; unticked, the request is as it always was',async()=>{
 const x=setup();await openChat(x);
 type(x,box(x),KEY);submit(x);await flush();
 assert.deepEqual(clean(x.requests('save_pip_key')[0].request),{type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY},'unticked: no terminal at all');
 const y=setup();await openChat(y);
 setTick(y,true);type(y,box(y),KEY);
 // A redraw (the chat polls) keeps the tick and what was typed.
 y.connect();await y.drain();
 assert.deepEqual([tick(y).checked,box(y).value],[true,KEY],'a redraw keeps the tick');
 assert.ok(!everywhere(y).includes(KEY),'the key is in its box and nowhere else');
 submit(y);await flush();
 assert.deepEqual(clean(y.requests('save_pip_key')[0].request),{type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY,terminal:true});
 const saved=key({status:'saved',saved:true,terminal:true});y.setKeys([saved]);y.answer(y.requests('save_pip_key')[0],{key:saved});await y.drain();
 assert.match(cardOf(y).textContent,/Ava has the Invoicely API key.*Saved · In its Terminal as \$INVOICELY_API_KEY/,'saved for its Terminal: the card no longer says it never saw the key');
 assert.equal(cardOf(y).querySelector('input'),null);
 assert.ok(!everywhere(y).includes(KEY),'the key is nowhere on the page after it was sent');
 // Ticked and then unticked: not sent.
 const z=setup();await openChat(z);
 setTick(z,true);setTick(z,false);type(z,box(z),KEY);submit(z);await flush();
 assert.deepEqual(Object.keys(clean(z.requests('save_pip_key')[0].request)).sort(),['key_id','pip_id','type','value']);
});

test('below Do it all, without a computer, or before the level is known, there is no tick and terminal is never sent',async()=>{
 for(const [why,opts] of [['Approve for me',{level:'approve'}],['Ask me first',{level:'ask'}],['no computer',{computer:false}],['the level never loaded',{level:''}],['an older DGC (Pips API 84)',{apiVersion:84}]]){
  const x=setup(opts);await openChat(x);
  assert.ok(cardOf(x),why+': the card is there');
  assert.equal(cardOf(x).querySelector('input[type="checkbox"]'),null,why+': no tick');
  assert.ok(!/Terminal/.test(cardOf(x).textContent),why+': and no word of a Terminal');
  type(x,box(x),KEY);submit(x);await flush();
  assert.deepEqual(clean(x.requests('save_pip_key')[0].request),{type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY},why);
 }
});

test('a tick made at Do it all is not sent once the Pip is below it: the tick is gone from the card',async()=>{
 const x=setup();await openChat(x);
 setTick(x,true);type(x,box(x),KEY);
 // Changed in the chat's own menu ("Before Ava acts").
 x.click('#chat-level');await x.drain();x.click('[data-pip-level-pick="approve"]');await x.drain();
 assert.equal(x.requests('set_pip_level').length,1);
 assert.equal(tick(x),null,'below Do it all now: no tick');
 assert.equal(box(x).value,KEY,'what was typed stays');
 submit(x);await flush();
 assert.deepEqual(clean(x.requests('save_pip_key')[0].request),{type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY});
});

test('a generator\'s key card never has the tick',async()=>{
 const x=setup({keys:[gen(),key({id:KEYID2})]});await openChat(x);
 assert.equal(tick(x,KEYID),null,'kept in Settings for all of DGC: not a Terminal\'s');
 assert.ok(tick(x,KEYID2),'the site\'s key beside it has one');
 setTick(x,true,KEYID2);
 type(x,box(x,KEYID),KEY);submit(x,KEYID);await flush();
 assert.deepEqual(clean(x.requests('save_pip_key')[0].request),{type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY},'another card\'s tick is not this one\'s');
});

test('the Pip\'s page, Keys: a saved key ticked for the Terminal says the variable; below Do it all, "at Do it all only"',async()=>{
 const list=()=>[key({status:'saved',saved:true,terminal:true}),key({id:KEYID2,name:'Weather key',terminal_name:'WEATHER_KEY',host:'api.weather.example',status:'saved',saved:true})];
 const x=setup({keys:list()});await openPage(x);
 assert.deepEqual(rows(x),['api.invoicely.example · Saved · In its Terminal as $INVOICELY_API_KEY','api.weather.example · Saved'],'only the ticked one says so');
 const tip=x.d.querySelector('section[aria-label="Keys"] h3 [data-pip-tip]');
 assert.match(x.d.getElementById(tip.dataset.pipTip).textContent,/A key you ticked for its Terminal is also there at Do it all, where Ava could read it\./);
 for(const level of ['approve','ask']){
  const y=setup({keys:list(),level});await openPage(y);
  assert.deepEqual(rows(y),['api.invoicely.example · Saved · In its Terminal at Do it all only','api.weather.example · Saved'],level);
  assert.ok(!y.d.querySelector('section[aria-label="Keys"] [data-pip-key]').textContent.includes('$'),'no variable named below Do it all');
 }
 // A key still waited for, or one answered Not now, says nothing of a Terminal whatever its row carries.
 const z=setup({keys:[key({terminal:true}),key({id:KEYID2,status:'declined',terminal:true})]});await openPage(z);
 assert.deepEqual(rows(z),['api.invoicely.example · Waiting for you','api.invoicely.example · Not now']);
 const none=setup({keys:[key({status:'saved',saved:true})]});await openPage(none);
 assert.ok(!/Terminal/.test(none.d.getElementById(none.d.querySelector('section[aria-label="Keys"] h3 [data-pip-tip]').dataset.pipTip).textContent),'no ticked key: the "i" says nothing of a Terminal');
});

test('the editor passes terminal from Pips API 85 only, and only as true or false',async()=>{
 const body=(extra={})=>({type:'save_pip_key',pip_id:PIP,key_id:KEYID,value:KEY,...extra});
 const pass=(api,request)=>{const posted=[],sent=[],editor=new viewModule.PipsEditor({},m=>{sent.push(m);return true;},()=>{});
  editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'r',request});return {sent,posted};};
 for(const terminal of [true,false]){
  const now=pass(85,body({terminal}));
  assert.equal(now.sent.length,1,JSON.stringify(now.posted).slice(0,200));
  assert.deepEqual(clean(now.sent[0].request),{...body({terminal}),request_id:now.sent[0].request.request_id});
 }
 for(const api of [82,84]){
  const old=pass(api,body({terminal:true}));
  assert.equal(old.sent.length,0,`Pips API ${api} is never sent it`);
  assert.equal(old.posted.find(m=>m.id==='r').error.message,'Update DGC to let a Pip’s Terminal use a key.');
  assert.ok(!JSON.stringify(old.posted).includes(KEY),'and the key is never echoed');
  assert.equal(pass(api,body()).sent.length,1,'the save it always took still goes');
 }
 const guard=viewModule.pipKeyRefusal;
 assert.equal(guard(body({terminal:true}),85),'');assert.equal(guard(body({terminal:false}),85),'');assert.equal(guard(body(),85),'');
 for(const bad of [body({terminal:'true'}),body({terminal:1}),body({terminal:null}),body({terminal:true,header:'cookie'}),
  {type:'decline_pip_key',pip_id:PIP,key_id:KEYID,terminal:true},{type:'remove_pip_key',pip_id:PIP,key_id:KEYID,terminal:true},{type:'list_pip_keys',pip_id:PIP,terminal:true}]){
  const said=guard(bad,85);assert.notEqual(said,'',JSON.stringify(Object.keys(bad))+' '+String(bad.terminal));assert.ok(!said.includes(KEY));
 }
});
