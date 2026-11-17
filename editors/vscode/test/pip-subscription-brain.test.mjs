// Pips API 55 (pip_brain): a Personal Pip can run on the user's own Claude Code or Codex. Its model picker lists the
// ones signed in on this computer, says once that its replies and routines use that plan's usage, and saves
// {mode: "subscription", engine}; Default names the subscription DGC follows. Project Pips use the same
// restricted model transport while keeping their own policy. Below API 55, the host refuses the choice.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {pickerDom} from './support/picker-dom.mjs';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const markdownCode=(await build({entryPoints:[new URL('markdown.ts',base).pathname],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const markdownModule={exports:{}};new Function('module','exports','require',markdownCode)(markdownModule,markdownModule.exports,require);
const bridge=(await build({entryPoints:[new URL('pipsView.ts',base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const model=await import(new URL('pipsModel.js',base).href);
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PW='ws_'+'p'.repeat(32),PIP='pip_'+'t'.repeat(32);
const view=(()=>{const m={exports:{}};new Function('module','exports','require',bridge)(m,m.exports,name=>name==='vscode'?{}:require(name));return m.exports;})();
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(extra={})=>({id:PIP,workspace_id:PW,pip_type:'lens',name:'Tees',goal:'Help with what I ask.',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,model_choice:{mode:'default'},source_policy:{mode:'personal'},...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:65536,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const SUBS=[{engine:'claude',name:'Claude Code'},{engine:'codex',name:'Codex'}];
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function setup({api=55,job=pip(),kind='personal',catalog={default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS}}={}){
 const dom=new JSDOM(view.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let current=job;
 w.TextEncoder=TextEncoder;w.DgcMarkdown=markdownModule.exports;w.HTMLCanvasElement.prototype.getContext=()=>null;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:[current]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),get_pip:()=>({pip:current}),list_pip_runs:()=>({runs:[]}),list_pip_messages:()=>({pip_id:PIP,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),list_pip_models:()=>catalog,
  get_pip_computer:()=>({computer:{pip_id:PIP,granted:false,available:true,reason:'',pending:0,actions:[]}}),list_pip_app_links:()=>({pip_id:PIP,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,list_pip_routines:()=>({pip_id:PIP,workspace_id:PW,routines:[]}),
  propose_pip_update:()=>({proposal:{id:'proposal_'+'1'.repeat(32),pip_id:PIP,expected_version:current.current_version,definition:{...current,...r.changes}}}),accept_pip_update:()=>{current={...current,model_choice:requests('propose_pip_update').at(-1).request.changes.model_choice,current_version:current.current_version+1};return{pip:current};}}[r.type]?.());
 async function drain(){for(let i=0;i<18;i++){await flush();let n=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answer(m,result);n++;}}if(!n)break;}await flush();}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const click=selector=>{const e=w.document.querySelector(selector);assert.ok(e,selector);e.click();};
 return{w,d:w.document,requests,drain,click,select:async()=>{await drain();click(`[data-job="${PIP}"]`);await drain();}};
}
// The model picker (media/shared/modelpicker.js): its rail's connections, the shown one's rows, the line under them.
const P=x=>pickerDom(x.d);
const openList=async x=>{if(!P(x).open())x.click('#chat-model');await x.drain();};
const chooseProvider=(x,key)=>{const conn=P(x).conn(key);assert.ok(conn,key);conn.click();};
const row=(x,value)=>P(x).rows().find(r=>r.dataset.value===value)||null;
const pick=async(x,value)=>{assert.ok(row(x,value),value);row(x,value).click();await x.drain();};
const under=x=>[...x.d.querySelectorAll('.dgc-mp-under .dgc-mp-note')].map(n=>n.textContent);

test('the picker opens on the models: CLI default, each model of the CLI, and any other by name, as in Work; the choice is saved with its model',async()=>{
 const x=setup({catalog:{default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:[{engine:'claude',name:'Claude Code',models:['opus','sonnet','haiku']},{engine:'codex',name:'Codex',models:[]}]}});await x.select();
 x.click('#chat-model');await x.drain();
 assert.ok(row(x,'model:model-a'),'the current connection\'s models show at once: no extra click');
 chooseProvider(x,'subscription:claude');
 assert.equal(x.d.querySelector('.dgc-mp-head').textContent,'Claude Codeyour subscription');
 // (An older DGC says no versions and no fixed list: its nicknames then follow the newest, and say so.)
 assert.deepEqual(P(x).names(),['CLI default','Opus (newest)','Sonnet (newest)','Haiku (newest)']);
 assert.deepEqual(P(x).rows().map(r=>r.dataset.value),['subscription:claude','subscription:claude:opus','subscription:claude:sonnet','subscription:claude:haiku']);
 assert.equal(P(x).foot('typed').textContent,'Enter another model…');
 await pick(x,'subscription:claude:sonnet');
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{model_choice:{mode:'subscription',engine:'claude',model:'sonnet'}});
 assert.match(x.d.body.textContent,/Its replies and routines use your Claude Code plan’s usage\./,'the plan is the CLI\'s, with no model in its name');
 assert.match(x.d.querySelector('#chat-model').textContent,/Claude Code · sonnet/,'the chip names both');
 await openList(x);
 assert.equal(P(x).conn('subscription:claude').getAttribute('aria-selected'),'true','it opens on its connection');
 assert.equal(row(x,'subscription:claude:sonnet').getAttribute('aria-selected'),'true','and on it');
 assert.equal(row(x,'subscription:claude').getAttribute('aria-selected'),'false');
});
test('Claude Code\'s rows: each nickname with the version it last ran as, then the fixed versions a Pip can stay on',async()=>{
 const claude={engine:'claude',name:'Claude Code',models:['fable','opus','sonnet','haiku'],versions:{opus:'claude-opus-5-5'},fixed:['claude-fable-5-2','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']};
 const x=setup({catalog:{default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:[claude]}});await x.select();await openList(x);
 chooseProvider(x,'subscription:claude');
 assert.deepEqual(P(x).names(),['CLI default','Fable (newest)','Opus 5.5','Sonnet (newest)','Haiku (newest)','Fable 5.2','Opus 5.5','Sonnet 5.5','Haiku 5.5']);
 assert.deepEqual(P(x).sections(),['Fixed versions']);
 assert.equal(P(x).desc('Opus 5.5'),'Follows the newest Opus · now claude-opus-5-5');
 assert.equal(row(x,'subscription:claude:claude-opus-5-5').querySelector('.dgc-mp-desc').textContent,'claude-opus-5-5 · stays on this version');
 await pick(x,'subscription:claude:claude-opus-5-5');
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{model_choice:{mode:'subscription',engine:'claude',model:'claude-opus-5-5'}},'a fixed version is saved by its full name: the Pip never moves off it by itself');
 await openList(x);
 assert.deepEqual(P(x).chosen(),['Opus 5.5']);
 assert.equal(row(x,'subscription:claude:claude-opus-5-5').getAttribute('aria-selected'),'true','the fixed one, not the nickname that runs as it today');
 assert.equal(row(x,'subscription:claude:opus').getAttribute('aria-selected'),'false');
});
test('Enter another model takes a name, and a name outside the list stays offered once chosen',async()=>{
 const x=setup({catalog:{default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:[{engine:'codex',name:'Codex',models:[]}]}});await x.select();await openList(x);
 chooseProvider(x,'subscription:codex');
 assert.deepEqual(P(x).names(),['CLI default'],'a CLI that lists no models still offers its default');
 P(x).foot('typed').click();
 const box=x.d.querySelector('.dgc-mp-input');assert.ok(box,'a box for the name');
 assert.equal(box.getAttribute('aria-label'),'Model name');
 box.value='gpt-5.5-codex';box.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await x.drain();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{model_choice:{mode:'subscription',engine:'codex',model:'gpt-5.5-codex'}});
 await openList(x);
 assert.equal(row(x,'subscription:codex:gpt-5.5-codex').getAttribute('aria-selected'),'true');
});
test('a Personal Pip picks its own Codex, and is told once that its runs use that plan',async()=>{
 const x=setup();await x.select();await openList(x);
 chooseProvider(x,'subscription:codex');
 assert.equal(P(x).shown(),'Codex');
 assert.ok(row(x,'subscription:codex'));
 assert.deepEqual(under(x),[],'no usage line until a subscription is chosen');
 await pick(x,'subscription:codex');
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{model_choice:{mode:'subscription',engine:'codex'}});
 assert.equal(x.requests('accept_pip_update').length,1,'a Personal Pip saves its own choice at once');
 assert.match(x.d.body.textContent,/Tees now uses Codex\. Its replies and routines use your Codex plan’s usage\./);
 assert.match(x.d.querySelector('#chat-model').textContent,/Codex/,'the chip names it');
 await openList(x);
 assert.equal(row(x,'subscription:codex').getAttribute('aria-selected'),'true');
 assert.deepEqual(under(x),['Its replies and routines use your Codex plan’s usage.'],'said once, where it is chosen');
 chooseProvider(x,'subscription:claude');
 assert.deepEqual(under(x),[],'and not under a subscription it isn\'t on');
});

test('Default names the subscription DGC follows',async()=>{
 const x=setup({catalog:{default_model:'',models:[],connection:'configured',subscriptions:SUBS,default_engine:{engine:'codex',name:'Codex',available:true}}});
 await x.select();await openList(x);
 assert.equal(P(x).conn('subscription:codex').getAttribute('aria-selected'),'true','it opens on the connection Default follows');
 assert.equal(row(x,'default').querySelector('.dgc-mp-name').textContent,'Default (Codex)');
 assert.deepEqual(P(x).chosen(),['Default (Codex)']);
 assert.match(under(x)[0],/your Codex plan’s usage/);
});

test('a project Pip can choose a subscription, while an older backend cannot',async()=>{
 for(const [api,job,kind] of [[54,pip(),'personal'],[55,pip({source_policy:{mode:'committed_only'},pip_type:'rook'}),'project']]){
  const x=setup({api,job,kind});await x.select();await openList(x);
  assert.equal(!!P(x).conn('subscription:codex'),api>=55,`api ${api}`);
  if(api<55)assert.doesNotMatch(P(x).connNames().join(' ')+P(x).box().textContent,/Codex/);
 }
 for(const api of [54,55]){
  const sent=[],posted=[];
  const editor=new view.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'p',request:{type:'propose_pip_update',pip_id:'pip_a',expected_version:1,changes:{model_choice:{mode:'subscription',engine:'codex'}},reason:'Changed.'}});
  editor.receive({type:'pipsRequest',id:'c',request:{type:'create_pip',workspace_id:'ws',name:'Tees',goal:'Help',source_ref:'HEAD',model_choice:{mode:'subscription',engine:'claude'}}});
  assert.equal(sent.length,api===55?2:0,`api ${api}`);
  if(api===54)assert.match(posted.at(-1).error.message,/Update DGC to run a Pip on your own Claude Code or Codex/);
 }
});

test('the model list is checked: only Claude Code or Codex, and a well-formed default',()=>{
 const ok=model.pipModels({default_model:'',models:[],connection:'configured',subscriptions:SUBS,default_engine:{engine:'kimi',name:'Kimi Code',available:false,reason:'Kimi Code can’t switch off its own shell and file tools, so Pips don’t use it.'}});
 assert.equal(ok.default_engine.available,false);
 assert.deepEqual(model.pipModels({default_model:'m',models:[]}).subscriptions,[],'an older backend lists none');
 for(const bad of [{subscriptions:[{engine:'kimi',name:'Kimi'}]},{subscriptions:'codex'},{default_engine:{engine:'codex'}}])
  assert.throws(()=>model.pipModels({default_model:'',models:[],...bad}));
 assert.deepEqual(model.modelChoice('subscription:codex',[],SUBS),{mode:'subscription',engine:'codex'});
 assert.throws(()=>model.modelChoice('subscription:codex',[],[]),/Choose Default or a model/);
 assert.equal(model.modelLabel({mode:'subscription',engine:'claude'}),'Claude Code');
 assert.equal(model.modelValue({mode:'subscription',engine:'claude'}),'subscription:claude');
});

test('the Pip\'s model picker reads Default (the model it runs): the Pips default from Settings, else DGC\'s own',async()=>{
 // list_pip_models' default_model is what Default runs: Settings -> Agents -> Model for Pips when set, DGC's model
 // otherwise. The menu used to read "Same as DGC", which a Pips default would have made untrue.
 const x=setup({catalog:{default_model:'glm-5.3:cloud',models:[{id:'glm-5.3:cloud',name:'glm-5.3:cloud'},{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS}});
 await x.select();
 assert.match(x.d.querySelector('#chat-model').textContent,/glm-5\.3:cloud/,'the chip names the model Default runs');
 await openList(x);
 const item=row(x,'default');
 assert.equal(item.querySelector('.dgc-mp-name').textContent,'Default (glm-5.3:cloud)');
 assert.equal(item.getAttribute('aria-selected'),'true','a Pip on Default');
 assert.equal(P(x).rows()[0],item,'first in its connection\'s list');
 assert.doesNotMatch(P(x).box().textContent,/Same as DGC/);
 assert.equal(model.modelLabel({mode:'default'}),'Default');
});

// Pips API 74: every provider saved in Settings -> Models, the same list Work has. The Pip keeps its id and a model.
const SECOND='provider_'+'b'.repeat(32),HOME_HOST='provider_'+'a'.repeat(32);
const savedCatalog=(extra={})=>({default_model:'local-default',models:[{id:'model-a',name:'Local A'}],connection:'configured',subscriptions:SUBS,
 providers:[{id:HOME_HOST,name:'Home host',default:true,models:['model-a']},{id:SECOND,name:'Second host',default:false,models:['second-a','second-b']}],...extra});
const providerRows=x=>P(x).connNames();

test('a Pip lists every saved provider by name, then its models, and keeps only its id and the model',async()=>{
 const x=setup({api:74,catalog:savedCatalog()});await x.select();await openList(x);
 assert.deepEqual(providerRows(x),['Home host','Second host','Claude Code · your subscription','Codex · your subscription'],'by name; the default is not also "Current host"');
 assert.deepEqual(P(x).rail().map(b=>b.textContent.trim()),['H','S','',''],'a provider with no mark of its own is a lettered tile; a subscription app wears its company\'s');
 chooseProvider(x,`provider:${SECOND}`);
 assert.deepEqual(P(x).names(),['second-a','second-b']);
 await pick(x,`provider:${SECOND}:second-b`);
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('propose_pip_update')[0].request.changes)),{model_choice:{mode:'provider',provider:SECOND,model:'second-b'}});
 assert.equal(x.requests('accept_pip_update').length,1,'a Personal Pip saves its own choice at once');
 assert.match(x.d.body.textContent,/Tees now uses second-b on Second host\./);
 assert.match(x.d.querySelector('#chat-model').textContent,/second-b/,'the chip names the model');
 assert.match(x.d.querySelector('#chat-model').title,/second-b · Second host/,'its hover names the provider');
 await openList(x);
 assert.equal(P(x).conn(`provider:${SECOND}`).getAttribute('aria-selected'),'true','it opens on the chosen provider');
 assert.equal(row(x,`provider:${SECOND}:second-b`).getAttribute('aria-selected'),'true');
});

test('a provider chosen before reloads as chosen, and a project Pip is reviewed the same way',async()=>{
 const job=pip({model_choice:{mode:'provider',provider:SECOND,model:'second-a'}});
 const x=setup({api:74,job,catalog:savedCatalog()});await x.select();await openList(x);
 assert.equal(row(x,`provider:${SECOND}:second-a`).getAttribute('aria-selected'),'true');
 const y=setup({api:74,kind:'project',catalog:savedCatalog()});await y.select();await openList(y);
 assert.ok(P(y).conn(`provider:${SECOND}`),'a project Pip is offered it too');
});

test('with no default among them, the host stays "Current host", first',async()=>{
 const x=setup({api:74,catalog:savedCatalog({providers:[{id:SECOND,name:'Second host',default:false,models:['second-a']}]})});await x.select();await openList(x);
 assert.deepEqual(providerRows(x),['Current host','Second host','Claude Code · your subscription','Codex · your subscription']);
});

test('a provider removed from Settings says so in plain words, and is never silently replaced',async()=>{
 const job=pip({model_choice:{mode:'provider',provider:SECOND,model:'second-a'}});
 const x=setup({api:74,job,catalog:savedCatalog({providers:[{id:HOME_HOST,name:'Home host',default:true,models:['model-a']}]})});await x.select();
 assert.match(x.d.querySelector('[role="alert"].composer-unavailable').textContent,/was removed from Settings\. Choose another model/,'said with no menu open, before anything is sent');
 await openList(x);
 assert.match(x.d.querySelector('#chat-model').textContent,/second-a/,'the chip still says what it was set to');
 assert.equal(x.requests('propose_pip_update').length,0,'nothing changes by itself');
});

test('below API 74 a list from a newer host is not offered',async()=>{
 const x=setup({api:73,catalog:savedCatalog()});await x.select();await openList(x);
 assert.deepEqual(providerRows(x),['Current host','Claude Code · your subscription','Codex · your subscription']);
});

test('with no provider the host answers a Pip\'s hello itself, and queues it once one is saved',async()=>{
 const sent=[],posted=[];let none=true;
 const editor=new view.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:74},{});
 editor.useSavedProviders(async()=>[],async()=>{},()=>none);
 const before=sent.length;
 editor.receive({type:'pipsRequest',id:'hello',request:{type:'introduce_pip',pip_id:PIP}});
 assert.equal(sent.length,before,'nothing goes to the Pips control');
 assert.deepEqual(JSON.parse(JSON.stringify(posted.find(m=>m.id==='hello'))),{type:'pipsReply',id:'hello',ok:true,result:{no_provider:true}});
 none=false;
 editor.receive({type:'pipsRequest',id:'hello2',request:{type:'introduce_pip',pip_id:PIP}});
 assert.equal(sent.at(-1).request.type,'introduce_pip');
});

test('the host adds the saved providers to the list and saves one before a Pip is set to it, with no key in the view',async()=>{
 const sent=[],posted=[];const calls=[];
 const editor=new view.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:74},{});
 editor.useSavedProviders(async()=>[{id:SECOND,name:'Second host',default:false,models:['second-a']}],async id=>{calls.push(id);if(id===HOME_HOST)throw new Error('Provider not found. Open Settings and add it again.');});
 const ask=(id,request)=>editor.receive({type:'pipsRequest',id,request});
 ask('list',{type:'list_pip_models'});
 const listed=sent.at(-1);
 editor.event({type:'pips_result',ok:true,command:'list_pip_models',request_id:listed.request.request_id,result:{default_model:'m',models:[]}});
 await flush();await new Promise(r=>setTimeout(r,0));
 const reply=posted.find(m=>m.type==='pipsReply'&&m.id==='list');
 assert.equal(reply.result.providers[0].name,'Second host');
 const before=sent.length;
 ask('good',{type:'propose_pip_update',pip_id:PIP,expected_version:1,changes:{model_choice:{mode:'provider',provider:SECOND,model:'second-a'}},reason:'x'});
 assert.equal(sent.length,before,'nothing goes to the Pips control before the provider is saved');
 await flush();await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls,[SECOND]);
 assert.equal(sent.at(-1).request.type,'propose_pip_update');
 assert.equal(JSON.stringify(sent.at(-1)).includes('api_key'),false);
 const count=sent.length;
 ask('gone',{type:'propose_pip_update',pip_id:PIP,expected_version:1,changes:{model_choice:{mode:'provider',provider:HOME_HOST,model:'m'}},reason:'x'});
 await flush();await new Promise(r=>setTimeout(r,0));
 assert.equal(sent.length,count,'a provider that could not be saved never reaches the Pip');
 assert.match(posted.find(m=>m.type==='pipsReply'&&m.id==='gone').error.message,/add it again/);
});
