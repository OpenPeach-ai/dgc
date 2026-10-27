import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
// Chromium the way the other layout tests start it: a machine without it skips (GitHub's release job installs
// none, and a launch here failed the 0.48.2 release), and DGC_REQUIRE_CHROMIUM=1 makes that a failure.
async function launchOrSkip(t){try{return await chromium.launch({args:['--headless=new','--no-sandbox']});}catch(error){if(process.env.DGC_REQUIRE_CHROMIUM==='1')throw error;t.skip('Chromium could not start: '+String(error?.message||error).split('\n')[0]);return null;}}
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const markdownCode=(await build({entryPoints:[new URL('markdown.ts',base).pathname],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const markdownModule={exports:{}};new Function('module','exports','require',markdownCode)(markdownModule,markdownModule.exports,require);
const bridge=(await build({entryPoints:[new URL('pipsView.ts',base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const ws={id:'ws',name:'Project'},types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id,role:id,description:'Read committed source',available:['rook','scout','lens','lock'].includes(id),unavailable_reason:['rook','scout','lens','lock'].includes(id)?null:'Unavailable',default_name:id,default_goal:'Read source',engine:['rook','scout','lens','lock'].includes(id)?'source_audit':null}));
const job=(id='a',extra={})=>({id,workspace_id:'ws',pip_type:'rook',name:'Review '+id,goal:'Inspect source',source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',proposals:[],model_choice:{mode:'default'},...extra});
const controls=(options={context_size:8192,thinking:'off'})=>({version:1,mode:'read_only',options,options_source:'last_message',inherited_context_size:1048576,effective_context_size:options.context_size,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'The provider may interpret thinking levels differently.',context_note:'The provider can enforce a smaller window.'});
const catalog={default_model:'local-default',models:[{id:'model-a',name:'Local A'},{id:'model-b',name:'Local B'}],connection:'configured'};
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const message=(id='m1',pip='a',extra={})=>({id,pip_id:pip,workspace_id:'ws',role:'assistant',text:'Saved reply',run_id:'run-'+id,model:'local-default',created_at:'2026-10-02T10:00:00Z',status:'succeeded',...extra});
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function setup({api=24,jobs=[job()],messages=[],runs=[],chatControls=controls(),continuity=null}={}){
 const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let receive;
 w.TextEncoder=TextEncoder;w.DgcMarkdown=markdownModule.exports;w.HTMLCanvasElement.prototype.getContext=()=>null;w.setInterval=()=>1;w.eval(client);const instance=w.DgcPips.mount({root:w.document,postMessage:m=>sent.push(m),onMessage:fn=>{receive=fn;}});
 const answer=(m,result,ok=true)=>{answered.add(m.id);receive({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[ws],current_workspace_id:'ws'}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:jobs}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:'ws',revision:0,entries:[]}}),get_pip:()=>({pip:jobs.find(p=>p.id===r.pip_id)}),list_pip_runs:()=>({runs:runs.filter(run=>run.pip_id===r.pip_id)}),list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:'ws',messages:messages.filter(m=>m.pip_id===r.pip_id),next_before_id:null,active_run:null,history_context_omitted_count:0,continuity,...(api>=24?{chat_controls:chatControls}:{})}),list_pip_models:()=>catalog}[r.type]?.());
 async function drain(overrides={}){for(let i=0;i<18;i++){await flush();let n=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answer(m,result);n++;}}if(!n)break;}await flush();}
 receive({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const click=selector=>{const e=w.document.querySelector(selector);assert.ok(e,selector);e.click();};
 const control=selector=>{if(!w.document.querySelector(selector))click(selector==='#chat-context'?'#chat-context-toggle':'#chat-model');return w.document.querySelector(selector);};
 return{w,d:w.document,instance,answer,requests,drain,sent,receive,click,control,select:async id=>{await drain();click(`[data-job="${id}"]`);await drain();},input:(selector,value)=>{const e=w.document.querySelector(selector);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));},choose:(selector,value)=>{const e=control(selector);e.value=selector==='#chat-thinking'?['off','low','medium','high','xhigh'].indexOf(value):value;e.dispatchEvent(new w.Event('change',{bubbles:true}));},submit:()=>w.document.querySelector('#chat-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}))};
}

test('inline model picker uses the actual catalog without leaving chat or changing its draft',async()=>{const x=setup();await x.select('a');x.input('#chatText','Keep this question');x.click('#chat-model');await x.drain();x.click('#chat-model-summary');assert.equal(x.d.querySelector('[data-tab=chat]').getAttribute('aria-pressed'),'true');assert.equal(x.d.querySelector('#chatText').value,'Keep this question');assert.match(x.d.querySelector('.composer-model-menu').textContent,/Local A|Local B/);assert.equal(x.requests('list_pip_models').length,1);assert.equal(x.requests('propose_pip_update').length,0);const enter=new x.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});x.d.querySelector('#chatModelSearch').dispatchEvent(enter);assert.equal(enter.defaultPrevented,true,'model search Enter must not submit the message form');assert.equal(x.requests('send_pip_message').length,0);x.input('#chatModelSearch','Local B');assert.equal(x.d.querySelector('[data-chat-model="model:model-a"]'),null);assert.ok(x.d.querySelector('[data-chat-model="model:model-b"]'));x.d.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(x.d.querySelector('.composer-model-menu'),null);assert.equal(x.d.activeElement.id,'chat-model');});

test('the model chip names the model once the catalog loads, and a click elsewhere closes its menu',async()=>{const x=setup();await x.select('a');x.click('#chat-model');await x.drain();x.click('#chat-model');assert.match(x.d.querySelector('#chat-model').textContent,/local-default/,'not "Same as DGC"');x.click('#chat-model');await x.drain();assert.ok(x.d.querySelector('.composer-model-menu'));x.d.querySelector('.conversation-log').dispatchEvent(new x.w.MouseEvent('click',{bubbles:true}));assert.equal(x.d.querySelector('.composer-model-menu'),null);x.click('#chat-context-toggle');assert.ok(x.d.querySelector('.composer-context-menu'));x.d.querySelector('#chatText').dispatchEvent(new x.w.MouseEvent('click',{bubbles:true}));assert.equal(x.d.querySelector('.composer-context-menu'),null);});

test('model selection remains a reviewed job change and refuses a substituted saved choice',async()=>{const x=setup();await x.select('a');x.click('#chat-model');await x.drain();x.click('#chat-model-summary');x.click('[data-chat-model="model:model-a"]');const sent=x.requests('propose_pip_update')[0];assert.deepEqual(JSON.parse(JSON.stringify(sent.request)),{type:'propose_pip_update',pip_id:'a',expected_version:1,changes:{model_choice:{mode:'model',model:'model-a'}},reason:'Model selected in this Pip conversation.'});assert.equal(x.requests('accept_pip_update').length,0);x.answer(sent,{proposal:{id:'p',pip_id:'a',expected_version:1,definition:{model_choice:{mode:'model',model:'other'}}}});await x.drain();assert.match(x.d.body.textContent,/differs from the selection/);assert.equal(x.d.querySelector('#review-confirm'),null);});

test('context and thinking restore the saved options and clearly keep permissions read-only',async()=>{const x=setup({chatControls:controls({context_size:16384,thinking:'high'})});await x.select('a');assert.equal(x.control('#chat-context').value,'16384');assert.equal(x.control('#chat-thinking').getAttribute('aria-valuetext'),'High');assert.match(x.control('#chat-thinking').title,/next reply/i);assert.match(x.d.querySelector('.composer-note').textContent,/next reply.*provider/i);x.click('#chat-context-toggle');assert.match(x.d.querySelector('.composer-context-menu').textContent,/1,048,576/);x.click('#chat-permissions');assert.match(x.d.querySelector('[role=dialog]').textContent,/can’t run commands/);assert.equal(x.d.querySelector('#review-confirm'),null);assert.equal(x.requests('propose_pip_update').length,0);});

test('per-message options are pinned with the retry identity and never update a job',async()=>{const x=setup();await x.select('a');x.input('#chatText','Inspect the saved source.');x.choose('#chat-context','16384');x.choose('#chat-thinking','high');x.submit();const first=x.requests('send_pip_message')[0];assert.deepEqual(JSON.parse(JSON.stringify(first.request.chat_options)),{context_size:16384,thinking:'high'});x.answer(first,'Unknown outcome',false);await flush();x.submit();const retry=x.requests('send_pip_message')[1];assert.equal(retry.request.idempotency_key,first.request.idempotency_key);assert.deepEqual(retry.request.chat_options,first.request.chat_options);x.answer(retry,'Unknown outcome',false);await flush();x.choose('#chat-thinking','off');x.submit();const changed=x.requests('send_pip_message')[2];assert.notEqual(changed.request.idempotency_key,first.request.idempotency_key);assert.equal(changed.request.chat_options.thinking,'off');assert.equal(x.requests('propose_pip_update').length,0);assert.equal(x.d.querySelector('#chatText').value,'','in the chat while it sends');x.answer(changed,'Unknown outcome',false);await flush();assert.equal(x.d.querySelector('#chatText').value,'Inspect the saved source.','back in the box when it did not send');});

test('unsent per-Pip options survive navigation and cannot leak into another Pip',async()=>{const x=setup({jobs:[job('a'),job('b')]});await x.select('a');x.choose('#chat-context','32768');x.choose('#chat-thinking','xhigh');x.click('[data-job=b]');await x.drain();assert.equal(x.control('#chat-context').value,'8192');assert.equal(x.control('#chat-thinking').getAttribute('aria-valuetext'),'Off');x.click('[data-job=a]');await x.drain();assert.equal(x.control('#chat-context').value,'32768');assert.equal(x.control('#chat-thinking').getAttribute('aria-valuetext'),'Extra high');});

test('older backend sends its legacy request without fabricating editable inference controls',async()=>{const x=setup({api:23});await x.select('a');assert.equal(x.d.querySelector('#chat-context,#chat-thinking'),null);x.click('#chat-model');assert.match(x.d.querySelector('.composer-unavailable').textContent,/Update DGC to change these settings/);x.input('#chatText','Legacy request');x.submit();assert.equal(Object.hasOwn(x.requests('send_pip_message')[0].request,'chat_options'),false);});

test('malformed inference metadata disables sends instead of defaulting silently',async()=>{for(const broken of [{mode:'auto'},{effective_context_size:16384},{context_max:1048576},{options:{context_size:8192,thinking:'auto'}},{extra:'permission'}]){const x=setup({chatControls:{...controls(),...broken}});await x.select('a');x.input('#chatText','Keep this draft');assert.equal(x.d.querySelector('.chat-send').disabled,true);x.submit();assert.equal(x.requests('send_pip_message').length,0);assert.equal(x.d.querySelector('#chatText').value,'Keep this draft');assert.match(x.d.body.textContent,/invalid|unavailable|differs|supported/i);}});

test('host refuses new options before API24 while preserving legacy sends',()=>{for(const api of [23,24]){const sent=[],posted=[],mod={exports:{}};new Function('module','exports','require',bridge)(mod,mod.exports,name=>name==='vscode'?{}:require(name));const editor=new mod.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});const request={type:'send_pip_message',pip_id:'a',text:'Hello',idempotency_key:'retry',chat_options:{context_size:8192,thinking:'off'}};editor.receive({type:'pipsRequest',id:'new',request});assert.equal(sent.length,api===24?1:0);if(api===23)assert.match(posted.at(-1).error.message,/change context and thinking/);else assert.deepEqual(sent[0].request.chat_options,request.chat_options);editor.receive({type:'pipsRequest',id:'legacy',request:{type:'send_pip_message',pip_id:'a',text:'Hello',idempotency_key:'old'}});assert.equal(sent.length,api===24?2:1);}});

test('at narrow and wide sizes only the transcript scrolls while composer position stays fixed',async(t)=>{
 const browser=await launchOrSkip(t);if(!browser)return;
 try{for(const embedded of [false,true]){
  const page=await browser.newPage({viewport:{width:300,height:700}});
  await page.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<style>html,body{margin:0;height:100%;overflow:hidden}#host{width:100%;height:100%}</style>'+(embedded?'<div id="host"></div>':'<main id="app"></main><div id="review-root"></div>')}):route.abort());
  await page.goto('https://pips-composer.invalid/');await page.addScriptTag({content:client});
  const css=['pips.css','pipsTranscript.css'].map(file=>readFileSync(new URL('../src/'+file,import.meta.url),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
  await page.evaluate(({css,embedded,ws,types,pip,runner,chatControls,catalog,messages})=>{
   // Geometry is independent of the polling clock. A real four-second timer
   // can replace a node between locator resolution and its geometry read when
   // this suite runs under load. Polling behavior has explicit event tests.
   window.setInterval=fn=>{window.__pipPoll=fn;return 1;};
   HTMLCanvasElement.prototype.getContext=()=>null;let receive;const root=embedded?document.querySelector('#host').attachShadow({mode:'open'}):document;if(!embedded){const style=document.createElement('style');style.textContent=css;document.head.append(style);}
   const result=r=>({list_workspaces:{workspaces:[ws],current_workspace_id:'ws'},list_pip_types:{types},list_pips:{pips:[pip]},list_pip_setups:{setups:[]},get_workspace_context:{context:{workspace_id:'ws',revision:0,entries:[]}},get_pip_runner:{runner},get_pip:{pip},list_pip_runs:{runs:[]},list_pip_models:catalog,list_pip_messages:{pip_id:'a',workspace_id:'ws',messages,next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:chatControls}}[r.type]);
   window.DgcPips.mount({root,...(embedded?{stylesheetText:css}:{}),onMessage:fn=>{receive=fn;},postMessage:msg=>{queueMicrotask(()=>{if(msg.type==='pipsReady')receive({type:'pipsConnection',apiVersion:24,generation:1,connected:true,supported:true,enabled:true});else if(msg.type==='pipsRequest'){const answer=result(msg.request);if(answer!==undefined)receive({type:'pipsReply',id:msg.id,ok:true,result:answer});}});}});
  },{css,embedded,ws,types,pip:job(),runner,chatControls:controls(),catalog,messages:Array.from({length:20},(_,i)=>message('m'+i,'a',{text:('A long saved reply with source details.\n').repeat(12)}))});
  await page.locator('[data-job=a]').click();await page.locator('#chat-context-toggle').waitFor({state:'visible'});
  for(const width of [300,700,1100]){await page.setViewportSize({width,height:700});const composer=page.locator('#chat-form'),before=await composer.boundingBox();assert.ok(before&&before.y+before.height<=700,`${embedded}:${width}: composer exceeds viewport`);assert.equal(await page.locator('#chat-model').isVisible(),true);assert.equal(await page.locator('#chat-context-toggle').isVisible(),true);assert.equal(await page.locator('#chat-permissions').isVisible(),true);assert.equal(await page.locator('#chat-context,#chat-thinking').count(),0,'inference controls belong in popups');assert.ok(before.height<=124,'the idle composer matches main chat height');const geometry=await composer.evaluate(el=>{const input=el.querySelector('textarea'),send=el.querySelector('.chat-send');return{radius:getComputedStyle(el).borderRadius,font:getComputedStyle(input).fontSize,lineHeight:getComputedStyle(input).lineHeight,button:send.getBoundingClientRect().height};});assert.deepEqual(geometry,{radius:'16px',font:'13px',lineHeight:'20.8px',button:28});const log=page.locator('.conversation-log');assert.ok(await log.evaluate(el=>el.scrollHeight>el.clientHeight&&el.clientHeight>20));await log.evaluate(el=>el.scrollTop=0);const after=await composer.boundingBox();assert.deepEqual(after,before,'scrolling transcript must not move the composer');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await composer.evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement){if(p.scrollHeight>p.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(p).overflowY))return false;}return true;}),true,'no scrolling composer ancestor');}
  await page.setViewportSize({width:1100,height:700});await page.mouse.move(800,650);await page.locator('#chatText').focus();const sidebar=page.locator('aside[aria-label="Workspace Pips"]');assert.equal(Math.round((await sidebar.boundingBox()).width),48,'collapsed sidebar is a face rail');assert.equal(await page.locator('.job-copy').isVisible(),false);await sidebar.hover();assert.equal(Math.round((await sidebar.boundingBox()).width),232,'hover expands labels over the transcript');assert.equal(await page.locator('.job-copy').isVisible(),true);await page.locator('[data-job=a]').click();await page.locator('#chatText').waitFor({state:'visible'});assert.equal(Math.round((await sidebar.boundingBox()).width),48,'selecting a Pip closes the hover overlay so section tabs stay reachable');await page.mouse.move(800,650);assert.equal(Math.round((await sidebar.boundingBox()).width),48,'leaving the rail collapses it');await page.locator('#pin-pips-sidebar').focus();await page.keyboard.press('Tab');assert.equal(Math.round((await sidebar.boundingBox()).width),232,'keyboard focus expands the rail');await page.locator('#chatText').focus();assert.equal(Math.round((await sidebar.boundingBox()).width),48,'leaving keyboard focus collapses the rail');await page.locator('#pin-pips-sidebar').click();await page.mouse.move(800,650);await page.locator('#chatText').focus();assert.equal(await page.locator('#pin-pips-sidebar').getAttribute('aria-pressed'),'true');assert.equal(Math.round((await sidebar.boundingBox()).width),232,'pinned sidebar reserves its width');await page.locator('#pin-pips-sidebar').click();await page.mouse.move(800,650);await page.locator('#chatText').focus();assert.equal(Math.round((await sidebar.boundingBox()).width),48);assert.equal(Math.round((await page.locator('.hero>.avatar').boundingBox()).width),32,'chat header character stays compact');
  await page.setViewportSize({width:300,height:700});await page.locator('#chatText').fill('A draft stays here');await page.locator('#chat-model').click();await page.locator('#chat-model-summary').click();await page.locator('[data-chat-model="model:model-a"]').waitFor({state:'visible'});assert.equal(await page.locator('#chatText').inputValue(),'A draft stays here');await page.locator('#chat-model-summary').click();assert.equal(await page.locator('#chat-thinking').isVisible(),true,'the model row goes back to the slider, as in DGC');await page.locator('#chat-thinking').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#chat-thinking').getAttribute('aria-valuetext'),'Low');await page.keyboard.press('Escape');assert.equal(await page.locator('#chat-model').evaluate(el=>el===el.getRootNode().activeElement),true);await page.locator('#chat-context-toggle').click();await page.locator('#chat-context').selectOption('16384');assert.equal(await page.locator('#chat-context').inputValue(),'16384');await page.keyboard.press('Escape');assert.equal(await page.locator('#chat-context-toggle').evaluate(el=>el===el.getRootNode().activeElement),true);assert.equal(await page.locator('#chatText').inputValue(),'A draft stays here');assert.equal(await page.locator('.chat-send').evaluate(el=>el.classList.contains('ready')),true);await page.locator('#chatText').fill('Long prompt\n'.repeat(40));assert.ok((await page.locator('#chatText').boundingBox()).height<=160);assert.ok(await page.locator('#chatText').evaluate(el=>el.scrollHeight>el.clientHeight));assert.ok((await page.locator('#chat-form').boundingBox()).y>=0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.close();
 }}finally{await browser.close();}
});


test('Pip messages use the main markdown renderer and keep model provenance behind details',async()=>{
 const text='## Result\n\nRead **source** in [main.py](src/main.py:3).\n\n```js\nconst checked = true;\n```',x=setup({messages:[message('user','a',{role:'user',text:'Review <script>unsafe</script>',run_id:'same'}),message('reply','a',{text,run_id:'same'})]});await x.select('a');
 assert.equal(x.d.querySelector('.pip-message.user .bubble .prompt-text').textContent,'Review <script>unsafe</script>');assert.equal(x.d.querySelector('.pip-message.user script'),null);
 assert.equal(x.d.querySelector('.pip-message.assistant h2').textContent,'Result');assert.equal(x.d.querySelector('.pip-message.assistant pre code').textContent,'const checked = true;\n');
 assert.equal(x.d.querySelector('.message-label,.message-model'),null);assert.equal(x.d.querySelector('.pip-message.user .message-provenance').textContent.includes('local-default'),false);
 assert.equal(x.d.querySelector('.pip-message.assistant .message-details').open,false);assert.match(x.d.querySelector('.pip-message.assistant .message-provenance').textContent,/local-default/);
 x.click('.pip-message.assistant [data-chat-action=copy]');assert.equal(x.sent.at(-1).type,'copy');assert.equal(x.sent.at(-1).text,text);assert.equal(x.d.querySelector('.pip-message.assistant [data-chat-action=copy]').getAttribute('aria-label'),'Copied');
 x.click('.pip-message.assistant button.copy');assert.equal(x.sent.at(-1).text,'const checked = true;\n');assert.equal(x.requests('send_pip_message').length,0);
 x.click('.pip-message.assistant .md-link');assert.deepEqual(JSON.parse(JSON.stringify(x.sent.at(-1))),{type:'openFile',path:'src/main.py',line:3});
});

test('edit and retry use the matching original prompt without overwriting an unsent draft',async()=>{
 const messages=[message('u','a',{role:'user',text:'Original request',run_id:'pair'}),message('r','a',{run_id:'pair'})],x=setup({messages});await x.select('a');x.click('[data-chat-action=edit]');assert.equal(x.d.querySelector('#chatText').value,'Original request');assert.equal(x.requests('send_pip_message').length,0);
 x.input('#chatText','My unsent draft');x.click('[data-chat-action=retry]');assert.equal(x.d.querySelector('#chatText').value,'My unsent draft');assert.equal(x.requests('send_pip_message').length,0);assert.match(x.d.querySelector('.notice').textContent,/unsent message in the box/);
 x.input('#chatText','');x.click('[data-chat-action=retry]');assert.equal(x.requests('send_pip_message')[0].request.text,'Original request');assert.equal(x.requests('send_pip_message').length,1);
});

test('saved tool activity loads only on request and rejects another Pip’s response',async()=>{
 const x=setup({messages:[message()]});await x.select('a');assert.equal(x.requests('list_pip_run_activity').length,0);x.click('[data-chat-activity]');const request=x.requests('list_pip_run_activity')[0];assert.equal(request.request.run_id,'run-m1');
 const event={seq:1,run_id:'run-m1',pip_id:'a',workspace_id:'ws',event_type:'pip_run_progress',payload:{kind:'tool_call',tool:'read_file'},created_at:'2026-10-02T10:00:00Z'};
 x.answer(request,{run_id:'run-m1',pip_id:'a',workspace_id:'ws',events:[event],next_cursor:1,has_more:false,history_may_be_truncated:false,retention_limit:100,retention_scope:'workspace'});await flush();assert.match(x.d.querySelector('.chat-tool-row').textContent,/read_file · started/);x.click('[data-chat-activity]');assert.equal(x.d.querySelector('.chat-activity'),null);x.click('[data-chat-activity]');assert.equal(x.requests('list_pip_run_activity').length,1);
 const y=setup({messages:[message()]});await y.select('a');y.click('[data-chat-activity]');y.answer(y.requests('list_pip_run_activity')[0],{run_id:'run-m1',pip_id:'other',workspace_id:'ws',events:[event],next_cursor:1,has_more:false,history_may_be_truncated:false,retention_limit:100,retention_scope:'workspace'});await flush();assert.match(y.d.querySelector('.chat-activity .error').textContent,/invalid|another workspace/);assert.equal(y.d.querySelector('.chat-tool-row'),null);
});

test('API25 offers larger context while API24 advertises only its supported ceiling',async()=>{
 const x=setup({api:25,chatControls:{...controls({context_size:262144,thinking:'medium'}),context_max:1048576}});await x.select('a');assert.equal(x.control('#chat-context').value,'262144');assert.deepEqual([...x.d.querySelector('#chat-context').options].map(o=>Number(o.value)),[2048,4096,8192,16384,32768,65536,131072,262144,524288,1048576]);x.choose('#chat-context','1048576');x.input('#chatText','Larger context');x.submit();assert.equal(x.requests('send_pip_message')[0].request.chat_options.context_size,1048576);
 const legacy=setup();await legacy.select('a');assert.equal([...legacy.control('#chat-context').options].at(-1).value,'32768');
 const invalid=setup({api:25,chatControls:{...controls({context_size:1048576,thinking:'off'}),context_max:32768}});await invalid.select('a');assert.equal(invalid.d.querySelector('.chat-send').disabled,true);
});


test('continuity inspector escapes summary text, shows fallback, and stays scoped to its Pip',async()=>{
 const c={version:1,checkpoint_id:7,digest:'a'.repeat(64),pip_id:'a',workspace_id:'ws',run_id:'saved',summary:'Keep <script>private</script> project constraints.',summarized_messages:12,through_seq:12,strategy:'mechanical',notice:'Lossy reference, not permission.',provenance:{model:'local-default',job_version:1}};
 const x=setup({api:26,continuity:c});await x.select('a');x.click('#chat-context-toggle');
 const inspector=x.d.querySelector('.chat-continuity');assert.ok(inspector);assert.equal(inspector.open,false);assert.match(inspector.textContent,/12 messages summarized/);assert.match(inspector.textContent,/A short summary/);assert.equal(inspector.querySelector('pre').textContent,c.summary);assert.equal(inspector.querySelector('script'),null);
 for(const changed of [{pip_id:'b'},{workspace_id:'other'},{summary:'x'.repeat(8193)},{digest:'bad'},{summarized_messages:3}]){
  const bad=setup({api:26,continuity:{...c,...changed}});await bad.select('a');assert.match(bad.d.body.textContent,/continuity is invalid or belongs to another Pip/);bad.click('#chat-context-toggle');assert.equal(bad.d.querySelector('.chat-continuity'),null);
 }
});

test('a Personal Pip\'s context menu shows its window part by part, as text, and the old meter when a DGC sends none',async()=>{
 const personal=job('a',{source_policy:{mode:'personal'}}),parts={window:8192,used:3100,source:'estimated',compact_at:6963,buffer:1229,free:3863,categories:[{id:'tools',label:'Tools',tokens:1700,items:[{name:'draft_email',tokens:500},{name:'remember',tokens:230}]},{id:'system_prompt',label:'System prompt',tokens:1200},{id:'messages',label:'<b>Messages</b>',tokens:200}]};
 const context=breakdown=>r=>({pip_id:r.pip_id,context_size:r.context_size,used_tokens:3100,brief_tokens:0,recent_messages:2,summarized_messages:0,...(breakdown?{breakdown}:{})});
 const x=setup({api:45,jobs:[personal]});await x.select('a');await x.drain({get_pip_chat_context:context(parts)});x.click('#chat-context-toggle');
 const menu=x.d.querySelector('.composer-context-menu');
 assert.deepEqual([...menu.querySelectorAll('.bd-list > .bd-row .bd-label, .bd-list > details .bd-label')].map(e=>e.childNodes[0].textContent),['Tools','System prompt','<b>Messages</b>','Kept free for summarizing','Free space']);
 assert.equal(menu.querySelector('b'),null,'a label is text, never markup');
 assert.deepEqual([...menu.querySelectorAll('.bd-item-name')].map(e=>e.textContent),['draft_email','remember'],'its tools one by one');
 assert.equal(menu.querySelector('.ctx-track'),null,'the bar is the breakdown now');
 assert.equal(menu.querySelector('.bd-details').open,false,'the parts are folded at first, under Details');
 assert.deepEqual([...menu.querySelectorAll('.bd-toggle > span')].map(e=>e.textContent),['Details','3.9k free']);
 assert.match(menu.querySelector('.ctx-head').textContent,/3,100 \/ 8,192/);
 for(const none of [null,{...parts,window:4096}]){const old=setup({api:45,jobs:[personal]});await old.select('a');await old.drain({get_pip_chat_context:context(none)});old.click('#chat-context-toggle');
  const plain=old.d.querySelector('.composer-context-menu');assert.equal(plain.querySelector('.bd'),null,'none sent, or one that doesn\'t fit its window');assert.ok(plain.querySelector('.ctx-track'));assert.match(plain.querySelector('.ctx-split').textContent,/2 recent messages/);}
});

test('the Pip in a chat\'s header is never clipped when it hops: only its name is cut to fit',async(t)=>{
 const browser=await launchOrSkip(t);if(!browser)return;
 try{
  const page=await browser.newPage({viewport:{width:320,height:200}});
  const css=readFileSync(new URL('../src/pips.css',import.meta.url),'utf8').replace(/^@import[^;]+;/gm,'');
  await page.setContent(`<style>${css}</style><div class="pip-topbar"><button>Back</button><div class="pip-pill"><span class="avatar"><span class="dgc-plush"><svg class="dgc-plush-rig"></svg></span></span><span>A Pip with a name far too long to fit in its header</span><small>Working</small></div><button>More</button></div>`);
  const got=await page.evaluate(()=>{const o=s=>getComputedStyle(document.querySelector(s)).overflow;return{avatar:o('.pip-pill .avatar'),body:o('.pip-pill .dgc-plush'),name:o('.pip-pill>span:not(.avatar)')};});
  assert.deepEqual(got,{avatar:'visible',body:'visible',name:'hidden'},'the name\'s ellipsis must not clip the Pip, whose drawing is spans too');
 }finally{await browser.close();}
});

test('since API 47 the prompt box\'s context and thinking are the Pip\'s own, saved as soon as they change',async()=>{
 const x=setup({api:47,chatControls:{...controls(),context_max:1048576}});await x.select('a');
 assert.match(x.control('#chat-thinking').title,/For this Pip: its replies and the work it does on its own/);
 assert.match(x.d.querySelector('.composer-note').textContent,/For this Pip/);
 x.choose('#chat-context','262144');
 const saved=x.requests('set_pip_chat_options');
 assert.equal(saved.length,1,'saved at once, no reply needed');
 assert.deepEqual(JSON.parse(JSON.stringify(saved[0].request)),{type:'set_pip_chat_options',pip_id:'a',chat_options:{context_size:262144,thinking:'off'}});
 x.answer(saved[0],{chat_controls:{...controls({context_size:262144,thinking:'off'}),context_max:1048576,effective_context_size:262144}});await x.drain();
 assert.equal(x.control('#chat-context').value,'262144');
 x.choose('#chat-thinking','high');
 assert.equal(x.requests('set_pip_chat_options')[1].request.chat_options.thinking,'high');
 assert.equal(x.requests('propose_pip_update').length,0,'never a job change');
});

test('a window the main chat set shows in the prompt box at its next read, and the next message keeps it',async()=>{
 // Pips API 66: the main chat changes a Pip's context window (pips_propose context_window) while its page may be
 // open. The view had remembered the window it first read, showed that, and sent it with the next message, which
 // saved it back over the chat's change.
 const shown={...controls(),context_max:1048576},x=setup({api:66,chatControls:shown});await x.select('a');
 assert.equal(x.control('#chat-context').value,'8192');
 Object.assign(shown,{options:{context_size:65536,thinking:'off'},effective_context_size:65536});   // the chat's change
 x.receive({type:'pipsVisibility',visible:true});await x.drain();
 assert.equal(x.control('#chat-context').value,'65536','its prompt box shows what DGC keeps');
 x.input('#chatText','Check the invoices again.');x.submit();
 assert.equal(x.requests('send_pip_message')[0].request.chat_options.context_size,65536,'never the old window');
 assert.equal(x.requests('set_pip_chat_options').length,0,'reading it saves nothing');
});

test('a read that overlaps the prompt box saving its own choice never takes the choice back',async()=>{
 const x=setup({api:66,chatControls:{...controls(),context_max:1048576}});await x.select('a');
 const hold={list_pip_messages:()=>undefined,set_pip_chat_options:()=>undefined};
 x.receive({type:'pipsVisibility',visible:true});await x.drain(hold);                                   // a read, still on its way
 x.choose('#chat-context','262144');await x.drain(hold);                           // the user's choice, saving
 const save=x.requests('set_pip_chat_options')[0];
 x.answer(save,{chat_controls:{...controls({context_size:262144,thinking:'off'}),context_max:1048576,effective_context_size:262144}});await x.drain(hold);
 for(const read of x.requests('list_pip_messages').slice(1))x.answer(read,{pip_id:'a',workspace_id:'ws',messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,continuity:null,chat_controls:{...controls(),context_max:1048576}});
 await x.drain(hold);
 assert.equal(x.control('#chat-context').value,'262144','the read began before the save, so it is older');
 x.choose('#chat-context','131072');await x.drain(hold);
 x.receive({type:'pipsVisibility',visible:true});await x.drain({set_pip_chat_options:()=>undefined});    // a read while that save waits
 assert.equal(x.control('#chat-context').value,'131072');
});

test('before API 47 a choice is for the next reply only and nothing is saved',async()=>{
 const x=setup({api:46,chatControls:{...controls(),context_max:1048576}});await x.select('a');
 x.choose('#chat-context','65536');
 assert.equal(x.requests('set_pip_chat_options').length,0);
 assert.match(x.control('#chat-thinking').title,/next reply/i);
});
