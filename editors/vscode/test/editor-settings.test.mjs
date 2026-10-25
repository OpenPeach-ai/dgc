import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const src=fileURLToPath(new URL('../src/',import.meta.url));
const result=await build({entryPoints:[src+'settingsClient.js'],bundle:true,write:false,loader:{'.css':'empty','.ico':'dataurl','.png':'dataurl','.svg':'dataurl'},format:'iife'});
const code=result.outputFiles[0].text;
const view=await build({entryPoints:[src+'settingsView.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const module={exports:{}};new Function('module','exports',view.outputFiles[0].text)(module,module.exports);
const windows=[];after(()=>windows.forEach(w=>w.close()));
// A row's words: its one-line hint and the detail behind its "?", which settings keep one click away.
const rowHint=el=>el.closest('.field').querySelector('.hint').textContent;
const rowDetail=el=>el.closest('.field').querySelector('.detail')?.textContent||'';
const rowSaid=el=>rowHint(el)+' '+rowDetail(el);
function setup(){const dom=new JSDOM(module.exports.settingsDocument(),{runScripts:'outside-only'});const {window:w}=dom;windows.push(w);const sent=[];w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m)});w.eval(code);const message=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m}));const config={type:'config',base_url:'https://model.example/v1',model:'original',mode:'default',think:'high',subscription_engine:'',subagent_base_url:'https://agent.example/v1',subagent_model:'agent',fallback_model:'backup',sandbox:true,sandbox_network:false,prompt_cache:false,capability_cache_ttl_s:300,context_size:65536};message({type:'event',event:config});return{w,d:w.document,sent,message,config,click:s=>w.document.querySelector(s).click(),input:(s,value)=>{const e=w.document.querySelector(s);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));}};}
const plugin={name:'fixture',display_name:'Fixture',summary:'Package description',installed:true,apps:[{id:'service',name:'Declared service'}],mcps:[{name:'fixture',url:'https://mcp.example/mcp'}],skills:[{name:'first',description:'First frontmatter',enabled:true},{name:'second',description:'Second frontmatter',enabled:false}]};
test('Save says it applies to every workspace, which is where it writes',()=>{
  // Carried over from the in-panel settings dialog, which is being deleted. Saving writes the user
  // config (~/.dgc/config.json, through set_config) that every workspace on the machine reads, and
  // the tab said nothing about that at all -- the statement existed only on the surface nobody
  // could open. Checked on every page that offers Save, because each renders its own button.
  const x=setup();
  for(const nav of ['general','models','agents','web','chatdgc','security']){
    x.click(`[data-nav=${nav}]`);
    const save=x.d.querySelector('#save');
    assert.ok(save,`${nav} offers Save`);
    assert.doesNotMatch(save.title,/this workspace/,`${nav}: not just this workspace`);
    assert.match(save.title,/every workspace/,`${nav}: says where it writes`);
  }
});

test('the Show model thinking select carries show_reasoning and thinking_inline together',()=>{
  // Carried over from the in-panel settings dialog. One control stands for two config keys, and
  // the mapping has to survive in both directions: a config paints the select, and a choice saves
  // the pair. Each Save is acknowledged, or `saving` leaves the button disabled and the later
  // iterations dispatch nothing at all -- the loop would then re-read the FIRST message and pass
  // while proving nothing.
  const x=setup();
  x.click('[data-nav=general]');
  for(const [values,expected] of [[{show_reasoning:true,thinking_inline:true},'inline'],
                                  [{show_reasoning:true,thinking_inline:false},'collapsed'],
                                  [{show_reasoning:false,thinking_inline:false},'hidden']]){
    x.message({type:'event',event:{...x.config,...values}});
    assert.equal(x.d.querySelector('#show_reasoning').value,expected,JSON.stringify(values));
  }
  for(const [choice,show,inline] of [['inline',true,true],['collapsed',true,false],['hidden',false,false]]){
    x.input('#show_reasoning',choice);
    x.click('#save');
    const saved=x.sent.filter(m=>m.type==='saveSettings').pop();
    assert.equal(saved.values.show_reasoning,show,choice);
    assert.equal(saved.values.thinking_inline,inline,choice);
    x.message({type:'settingsSaved',ok:true});
  }
});

test('a backend config never populates a secret field in the webview',()=>{
  // Carried over from the in-panel settings dialog, which is being deleted: it was the only test
  // in the tree asserting this, and the same invariant lives here at settingsClient.js's
  // applyConfig -- `key.endsWith('api_key') ? '' : ...`. Dropping that ternary would paint a
  // stored key into a live webview, and nothing else would go red. Both key fields are checked
  // because only one of them had a test before.
  const x=setup();
  x.message({type:'event',event:{...x.config,api_key:'sk-live-secret',fallback_api_key:'sk-live-fallback'}});
  x.click('[data-nav=models]');
  assert.equal(x.d.querySelector('#api_key').value,'','the backend may hold a key; the webview may not');
  x.click('[data-nav=agents]');
  const fallback=x.d.querySelector('#fallback_api_key');
  if(fallback)assert.equal(fallback.value,'','nor the fallback route\'s key');
  assert.equal(JSON.stringify(x.sent).includes('sk-live-'),false,'and none of it is echoed back');
});
test('Save from General retains routes and false/zero values from other pages',()=>{const x=setup();x.message({type:'event',event:{...x.config,capability_cache_ttl_s:0}});x.click('#ultra_mode');x.click('#save');const values=x.sent.at(-1).values;assert.equal(values.subagent_model,'agent');assert.equal(values.subagent_base_url,'https://agent.example/v1');assert.equal(values.fallback_model,'backup');assert.equal(values.prompt_cache,false);assert.equal(values.capability_cache_ttl_s,0);assert.equal(values.sandbox,true);assert.equal(values.ultra_mode,true);assert.equal(values.base_url,x.config.base_url);});
test('unsaved edits survive navigation and background config responses',()=>{const x=setup();x.click('[data-nav=models]');x.input('#model','edited');x.input('#api_key','not-persisted-by-ui');x.click('[data-nav=security]');x.click('#sandbox_network');x.message({type:'event',event:x.config});x.click('[data-nav=models]');assert.equal(x.d.querySelector('#model').value,'edited');assert.equal(x.d.querySelector('#api_key').value,'not-persisted-by-ui');x.click('#save');assert.equal(x.sent.at(-1).values.sandbox_network,true);x.message({type:'settingsSaved',ok:true});assert.equal(x.d.querySelector('#api_key').value,'');});
test('installed switch enables mixed skills consistently without opening details',()=>{const x=setup();x.message({type:'plugins',items:[plugin]});x.click('[data-nav=plugins]');x.click('[data-plugin=fixture]');const messages=x.sent.filter(m=>m.type==='skillToggle');assert.deepEqual(messages.map(m=>[m.name,m.enabled]),[['second',true]]);assert.ok(!x.d.querySelector('#back'));x.click('[data-open=fixture]');assert.ok(x.d.querySelector('#back'));assert.match(x.d.body.textContent,/First frontmatter/);});
test('Apps and MCPs show their declared entries, not duplicate package titles',()=>{const x=setup();x.message({type:'plugins',items:[plugin]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');assert.equal(x.d.querySelector('#plugin-list strong').textContent,'Declared service');assert.match(x.d.querySelector('#plugin-list').textContent,/Uses MCP/);assert.equal(x.d.querySelector('[data-lane=mcp]'),null,'one door to MCP servers: its own page');x.click('[data-nav=mcp]');assert.equal(x.d.querySelector('#page>h2').textContent,'MCP servers');assert.equal(x.sent.at(-1).type,'listMcp');});
test('Save and connect on an MCP server says to finish in the browser, beside the button',()=>{
  // Found recording the remote sign-in (2026-10-15): the form stays up while the server connects, and the signin
  // message never redrew it, so after Save and connect nothing on the page said a browser was waiting.
  const x=setup();x.click('[data-nav=mcp]');x.click('#add-mcp');
  x.input('#mcp-name','field-notes');x.d.querySelector('#mcp-transport').value='remote';x.input('#mcp-target','https://notes.example/mcp');
  x.d.querySelector('#mcp-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  assert.equal(x.sent.at(-1).type,'mcpSave');
  x.message({type:'signin',server:'other-server',title:'Other'});
  assert.equal(x.d.querySelector('#mcp-signin'),null,'another server\'s sign-in is not this form\'s');
  x.message({type:'signin',server:'field-notes',title:'Field notes'});
  const box=x.d.querySelector('#mcp-signin');
  assert.ok(box,'the banner appears');
  assert.match(box.textContent,/Finish connecting Field notes in your browser/);
  assert.equal(box.previousElementSibling,x.d.querySelector('#mcp-form'),'right after the form and its Save and connect');
  assert.equal(x.d.querySelector('#mcp-name').value,'field-notes','the form was not redrawn: what was typed is still there');
  const before=x.sent.length;
  box.querySelector('[data-browser]').click();
  box.querySelector('[data-cancel-connect]').click();
  assert.deepEqual(x.sent.slice(before).map(m=>m.type),['openSignIn','cancelSignIn'],'and nothing else: no second save');
  x.message({type:'signin',clear:true});
  assert.equal(x.d.querySelector('#mcp-signin'),null,'gone once the sign-in ends');
});
test('install reviews the package before sending an install; then keeps the connection banner',()=>{const x=setup();x.message({type:'plugins',items:[{...plugin,installed:false}]});x.click('[data-nav=plugins]');assert.equal(x.d.querySelector('[data-install=fixture]'),null);x.click('#browse-directory');x.click('[data-install=fixture]');assert.equal(x.sent.at(-1).type,'inspectPlugin');assert.ok(x.d.querySelector('dialog'));assert.equal(x.sent.filter(m=>m.type==='installPlugin').length,0);x.message({type:'pluginPreview',requested:'fixture',item:{...plugin,supported:true,server_specs:{fixture:{url:'https://mcp.example/mcp'}}}});x.click('#confirm-plugin');assert.equal(x.sent.at(-1).type,'installPlugin');assert.deepEqual(Array.from(x.sent.at(-1).selectedServers),['fixture']);assert.ok(x.d.querySelector('#back'));x.message({type:'signin',server:'fixture',title:'Fixture'});assert.match(x.d.body.textContent,/Finish connecting Fixture in your browser/);x.click('[data-browser]');assert.equal(x.sent.at(-1).type,'openSignIn');x.message({type:'plugins',items:[{...plugin,connected:true}]});assert.doesNotMatch(x.d.body.textContent,/Finish connecting/);x.message({type:'pluginResult',name:'fixture',error:'No sign-in page was offered.'});assert.match(x.d.querySelector('[role=alert]').textContent,/No sign-in page/);});
test('rich usage ignores stale replies, shows figures/share bars and keyboard day readouts',()=>{const x=setup();x.click('[data-nav=usage]');const request=x.sent.at(-1);assert.equal(request.type,'getUsage');const report={type:'usage_report',request_id:request.requestId,range:'7d',timezone:'Asia/Kolkata',totals:{input_tokens:100000,output_tokens:1000,cached_input_tokens:10,requests:2},by_model:[{model:'local-model:Q4_K_M',provider:'local',host:'localhost:11434',input_tokens:100000,output_tokens:1000,requests:2}],by_day:[{date:'2026-09-21',input_tokens:60000,output_tokens:800,requests:1},{date:'2026-09-22',input_tokens:40000,output_tokens:200,requests:1}]};x.message({type:'event',event:{...report,request_id:'old'}});assert.equal(x.d.querySelector('#usage-content').hidden,true);x.message({type:'event',event:report});assert.equal(x.d.querySelectorAll('.usage-figure').length,4);assert.equal(x.d.querySelectorAll('.usage-share-fill').length,1);assert.equal(x.d.querySelectorAll('.usage-day').length,4);x.d.querySelector('#usage-days').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'End'}));assert.match(x.d.querySelector('#usage-day-readout').textContent,/40,000 input/);x.click('#usage-refresh');assert.notEqual(x.sent.at(-1).requestId,request.requestId);// This page has no icon font: its CSP is default-src 'none' with no font-src, and it draws
// every icon as an inline SVG. The Refresh markup was hand-copied from the chat panel, which
// links codicon.css -- so the copied span rendered as nothing at all, and aria-busy could not
// spin a non-replaced inline element either.
const refresh=x.d.querySelector('#usage-refresh');assert.ok(refresh.querySelector('svg'),'the settings page draws its own icons');assert.equal(refresh.querySelector('.codicon'),null,'there is no codicon font here to render one');});
test('usage empty state offers all time and reports unavailable without a stale ledger',()=>{const x=setup();x.click('[data-nav=usage]');x.message({type:'event',event:{type:'usage_report',request_id:x.sent.at(-1).requestId,range:'7d',totals:{requests:0}}});assert.equal(x.d.querySelector('#usage-empty').hidden,false);x.click('#usage-show-all');assert.equal(x.sent.at(-1).range,'all');x.message({type:'usage_unavailable',requestId:x.sent.at(-1).requestId,message:'Backend disconnected'});assert.match(x.d.querySelector('#usage-status').textContent,/Backend disconnected/);});
test('MCP controls send existing commands and split user/plugin servers',()=>{const x=setup();x.message({type:'plugins',items:[plugin]});x.message({type:'event',event:{type:'mcp_servers',items:[{name:'fixture',enabled:true,state:'connected'},{name:'local',enabled:true,state:'configured',command:'node'}]}});x.click('[data-nav=mcp]');x.click('[data-mcp-toggle=local]');assert.deepEqual({...x.sent.at(-1)},{type:'mcpToggle',name:'local',enabled:false});x.click('[data-mcp-edit=local]');assert.equal(x.d.querySelector('#mcp-target').value,'node');x.click('#mcp-cancel');assert.doesNotMatch(x.d.body.textContent,/From plugins/);assert.equal(x.d.querySelector('[data-mcp-toggle=fixture]'),null);});
test('the chat has no Plugins surface of its own',()=>{
  // Was: a guard that a background catalog must not OPEN the in-chat browser. That browser shipped
  // unreachable -- the only door was a settings dialog that could not be opened -- and has been
  // removed, so the guard is now structural. This is the stronger statement, and it is what stops
  // a weaker second install path reappearing beside the one on this tab.
  const source=readFileSync(src+'../media/main.js','utf8');
  assert.doesNotMatch(source,/function renderPlugins\(/,'the in-chat browser stays gone');
  assert.doesNotMatch(source,/openSurface\("plugins"\)/);
  assert.doesNotMatch(source,/plugins: \["Plugins"/,'and "plugins" is not a surface kind');
  assert.match(source,/function cachePluginLogos\(/,
    'the catalog still arrives, for the tool-card marks that are its one live consumer');
});

test('skill acknowledgements preserve keyboard focus on the switch',async()=>{const x=setup();x.message({type:'plugins',items:[plugin]});x.click('[data-nav=plugins]');x.d.querySelector('[data-plugin=fixture]').focus();x.click('[data-plugin=fixture]');x.message({type:'plugins',items:[{...plugin,skills:plugin.skills.map(s=>({...s,enabled:true}))}]});await Promise.resolve();assert.equal(x.d.activeElement.dataset.plugin,'fixture');});

test('directory search and marketplace filter use runtime catalog rows',()=>{const x=setup();x.message({type:'plugins',items:[plugin,{name:'second',display_name:'Second plugin',summary:'Searchable text',marketplace:'team',installed:false}]});x.click('[data-nav=plugins]');assert.equal(x.d.querySelectorAll('#plugin-list .row').length,1);x.click('#browse-directory');assert.equal(x.d.querySelectorAll('.directory-card').length,2);x.input('#directory-search','searchable');assert.equal(x.d.querySelectorAll('.directory-card').length,1);assert.match(x.d.querySelector('.directory-card').textContent,/Second plugin/);});
test('one-colour logos sit on their own plate, others on none',()=>{
 // Superpowers' black mark vanished on the dark theme, Composio's white one on the light (battle test 2026-10-09).
 const x=setup();const logoUrl='data:image/png;base64,iVBORw0KGgo=';
 x.message({type:'plugins',items:[{...plugin,logo:logoUrl},{name:'superpowers',display_name:'Superpowers',summary:'Skills',logo:logoUrl,installed:false},{name:'composio',display_name:'Composio',apps:[],skills:[],installed:false}]});
 x.click('[data-nav=plugins]');x.click('#browse-directory');
 const img=name=>[...x.d.querySelectorAll('.directory-card')].find(c=>c.textContent.includes(name))?.querySelector('img.logo');
 assert.ok(img('Superpowers').classList.contains('plate-light'));assert.ok(img('Composio').classList.contains('plate-dark'));
 assert.ok(img(plugin.display_name));assert.ok(![...img(plugin.display_name).classList].some(c=>c.startsWith('plate-')));
});
test('unavailable plugins are absent from browsing and old installs have removal controls only',()=>{
 const x=setup();const blocked={...plugin,name:'figma',display_name:'Figma',installed:false,install:'block',block_reason:'DGC approval is required'};
 x.message({type:'plugins',items:[plugin,blocked]});x.click('[data-nav=plugins]');x.click('#browse-directory');
 assert.equal(x.d.querySelectorAll('.directory-card').length,1);assert.equal(x.d.querySelector('#show-unavailable'),null);assert.equal(x.d.querySelector('[data-open=figma]'),null);assert.equal(x.d.querySelector('.directory-status').textContent,'','no count until a search narrows the list');x.input('#directory-search','zzz');assert.match(x.d.querySelector('.directory-status').textContent,/0 of 1/,'the blocked one is not counted');x.input('#directory-search','');
 x.message({type:'plugins',items:[plugin,{...blocked,installed:true}]});assert.equal(x.d.querySelector('[data-open=figma]'),null);
 x.click('#directory-back');assert.equal(x.d.querySelector('#plugin-list [data-open=figma]'),null);
 const retired=x.d.querySelector('.retired-plugins');assert.ok(retired);assert.equal(retired.open,false);retired.open=true;
 x.click('.retired-plugins [data-open=figma]');assert.match(x.d.body.textContent,/DGC approval is required/);
 assert.equal(x.d.querySelector('[data-connect=figma]'),null);assert.equal(x.d.querySelector('[data-plugin=figma]'),null);assert.ok(x.d.querySelector('[data-uninstall=figma]'));
});
test('Figma desktop setup prefills the existing MCP form and does not save until submit',()=>{
 const x=setup();x.message({type:'plugins',items:[{...plugin,name:'figma',display_name:'Figma',install:'block',block_reason:'Approval required'}]});x.click('[data-nav=plugins]');x.click('[data-open=figma]');x.click('[data-desktop-setup]');
 assert.match(x.d.querySelector('dialog').textContent,/Remote SSH/);assert.match(x.d.querySelector('dialog').textContent,/use_figma/);x.click('#configure-desktop');
 assert.equal(x.d.querySelector('#mcp-name').value,'figma-desktop');assert.equal(x.d.querySelector('#mcp-target').value,'http://127.0.0.1:3845/mcp');assert.equal(x.sent.filter(m=>m.type==='mcpSave').length,0);
 x.d.querySelector('#mcp-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));const request=x.sent.at(-1);assert.equal(request.type,'mcpSave');assert.equal(request.values.original_name,'');assert.equal(request.values.token,'');assert.equal(request.values.name,'figma-desktop');
});
test('uninstall is separate from skill toggle and cancellation restores its control',()=>{const x=setup();x.message({type:'plugins',items:[plugin]});x.click('[data-nav=plugins]');x.click('[data-open=fixture]');x.click('[data-uninstall=fixture]');assert.equal(x.sent.at(-1).type,'uninstallPlugin');assert.equal(x.sent.filter(m=>m.type==='skillToggle').length,0);x.message({type:'pluginOperationCancelled'});assert.equal(x.d.querySelector('[data-uninstall]').disabled,false);x.message({type:'pluginOperation',action:'uninstall_plugin',message:'Plugin uninstalled.'});x.message({type:'plugins',items:[{...plugin,installed:false}]});assert.equal(x.d.querySelector('#back'),null);assert.equal(x.d.querySelector('[data-plugin]'),null);});
test('Google review installs only checked connections and labels setup requirements',()=>{const x=setup();const google={name:'google',display_name:'Google',setup_required:true,setup_instructions:'Your Google OAuth project is required.',supported:true,server_specs:{gmail:{url:'https://gmail.example/mcp'},drive:{url:'https://drive.example/mcp'}}};x.message({type:'plugins',items:[google]});x.click('[data-nav=plugins]');x.click('#browse-directory');x.click('[data-install=google]');x.message({type:'pluginPreview',requested:'google',item:google});assert.match(x.d.querySelector('dialog').textContent,/OAuth project is required/);x.click('[data-server=drive]');x.click('#confirm-plugin');assert.deepEqual(Array.from(x.sent.at(-1).selectedServers),['gmail']);});
test('cancelled review ignores a late package reply and installs nothing',()=>{const x=setup();x.message({type:'plugins',items:[{...plugin,installed:false}]});x.click('[data-nav=plugins]');x.click('#browse-directory');x.click('[data-install=fixture]');x.click('#dialog-cancel');x.message({type:'pluginPreview',requested:'fixture',item:{...plugin,supported:true}});assert.equal(x.d.querySelector('dialog'),null);assert.equal(x.sent.filter(m=>m.type==='installPlugin').length,0);});
test('Add menu creates packages, adds marketplaces, and opens the real MCP form',()=>{const x=setup();x.click('[data-nav=plugins]');x.click('#add-menu');x.click('[data-add=create]');x.input('#create-name','my-plugin');x.input('#create-display','My plugin');x.input('#create-description','Use for fixtures');x.d.querySelector('#create-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));assert.equal(x.sent.at(-1).type,'createPlugin');x.message({type:'pluginOperation',action:'create_plugin',message:'Created',path:'/local/my-plugin'});x.click('#add-menu');x.click('[data-add=marketplace]');x.input('#market-source','owner/repository');x.d.querySelector('#market-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));assert.equal(x.sent.at(-1).type,'marketplaceAction');assert.equal(x.sent.at(-1).source,'owner/repository');x.click('#dialog-cancel');x.click('#add-menu');x.click('[data-add=mcp]');assert.ok(x.d.querySelector('#mcp-form'));});
test('Apps distinguish missing hosted connections from live MCP connections',()=>{const x=setup();x.message({type:'plugins',items:[{...plugin,mcps:[],connected:false}]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');assert.match(x.d.body.textContent,/Unavailable in DGC/);assert.doesNotMatch(x.d.body.textContent,/Declared app/);});


test('Google branded picker has four real service images and keyboard switches with honest setup status',()=>{
 const x=setup(); const apps=['gmail','calendar','contacts','drive'].map(id=>({id,name:id==='gmail'?'Gmail':'Google '+id}));
 const google={name:'google-workspace',display_name:'Google Workspace',supported:true,setup_required:true,setup_instructions:'Workspace preview access and an OAuth client are required.',apps,server_specs:Object.fromEntries(apps.map(a=>['google-workspace--'+a.id,{url:'https://example.com/'+a.id}]))};
 x.message({type:'plugins',items:[google]});x.click('[data-nav=plugins]');x.click('#browse-directory');x.click('[data-install=google-workspace]');x.message({type:'pluginPreview',requested:'google-workspace',item:google});
 const modal=x.d.querySelector('.google-dialog');assert.ok(modal);assert.equal(modal.querySelectorAll('.service-tile img').length,4);
 assert.equal(modal.querySelectorAll('[role=switch]').length,4);assert.match(modal.textContent,/does not grant account access/);
 assert.equal(modal.querySelector('.connection-art img[alt=DGC]').src.startsWith('data:image/svg+xml'),true);
 assert.equal(modal.querySelector('.connection-art img[alt=Google]').src.startsWith('data:image/png'),true);
 for(const c of modal.querySelectorAll('[data-server]'))c.click();assert.equal(x.d.querySelector('#confirm-plugin').disabled,true);
 x.click('[data-server=google-workspace--gmail]');x.click('#confirm-plugin');assert.deepEqual(Array.from(x.sent.at(-1).selectedServers),['google-workspace--gmail']);
});

test('Figma review shows DGC and the vendor mark plus the approval prerequisite before install',()=>{
 const x=setup();const figma={name:'figma',display_name:'Figma',auth:'browser',summary:'Figma tools',supported:true,skills:[],mcps:[{name:'figma',url:'https://mcp.figma.com/mcp'}],server_specs:{figma:{url:'https://mcp.figma.com/mcp'}}};
 x.message({type:'plugins',items:[figma]});x.click('[data-nav=plugins]');x.click('#browse-directory');x.click('[data-install=figma]');
 assert.ok(x.d.querySelector('.connection-art img[alt=DGC]'));assert.ok(x.d.querySelector('.connection-art img[alt=Figma]'));
 x.message({type:'pluginPreview',requested:'figma',item:figma});
 assert.ok(x.d.querySelector('.connection-dialog'));assert.match(x.d.querySelector('dialog').textContent,/Figma approval required/);
 assert.equal(x.d.querySelector('.connection-art img[alt=Figma]').src.startsWith('data:image/png'),true);
 assert.equal(x.sent.filter(m=>m.type==='installPlugin').length,0);
 x.click('#confirm-plugin');assert.equal(x.sent.at(-1).type,'installPlugin');assert.deepEqual(Array.from(x.sent.at(-1).selectedServers),['figma']);
 assert.match(x.d.querySelector('dialog').textContent,/Requesting a connection/);
 x.message({type:'pluginResult',name:'figma',error:'Registration failed: server exited'});
 assert.match(x.d.querySelector('dialog [role=alert]').textContent,/Registration failed/);
 assert.ok(x.d.querySelector('.connection-art img[alt=Figma]'));
 assert.equal(x.d.querySelector('[data-browser]'),null);
});

test('installed plugin reconnect uses the branded dialog and only actual sign-in events offer a browser',()=>{
 const x=setup();const row={...plugin,name:'figma',display_name:'Figma',server_names:['figma'],mcps:[{name:'figma',url:'https://mcp.figma.com/mcp'}]};
 x.message({type:'plugins',items:[row]});x.click('[data-nav=plugins]');x.click('[data-open=figma]');x.click('[data-connect=figma]');
 assert.equal(x.sent.filter(m=>m.type==='installPlugin').length,0);assert.ok(x.d.querySelector('.connection-art img[alt=DGC]'));
 x.click('#confirm-connect');assert.equal(x.sent.at(-1).type,'installPlugin');assert.equal(x.sent.filter(m=>m.type==='inspectPlugin').length,0);
 x.message({type:'signin',server:'unrelated',title:'Other'});assert.equal(x.d.querySelector('dialog [data-browser]'),null);
 x.message({type:'signin',server:'figma',title:'Figma'});assert.match(x.d.querySelector('dialog').textContent,/Finish connecting Figma/);x.click('dialog [data-browser]');assert.equal(x.sent.at(-1).type,'openSignIn');
 x.message({type:'plugins',items:[{...row,connected:true}]});assert.match(x.d.querySelector('dialog').textContent,/Figma is connected/);assert.doesNotMatch(x.d.querySelector('dialog').textContent,/approval required/);x.click('#connection-done');assert.equal(x.d.querySelector('dialog'),null);
});

test('cancelling branded browser progress sends the existing cancellation command',()=>{
 const x=setup();x.message({type:'plugins',items:[plugin]});x.click('[data-nav=plugins]');x.click('[data-open=fixture]');x.click('[data-connect=fixture]');x.click('#confirm-connect');assert.equal(x.d.querySelector('#dialog-cancel').textContent,'Hide');x.message({type:'signin',server:'fixture',title:'Fixture'});assert.equal(x.d.querySelector('#dialog-cancel').textContent,'Cancel');x.click('#dialog-cancel');assert.equal(x.sent.at(-1).type,'cancelSignIn');assert.equal(x.d.querySelector('dialog'),null);
});

const composioPlugin={name:'composio',display_name:'Composio',summary:'Connect your apps',installed:false,connected:false,auth:'browser',mcps:[{name:'composio',url:'https://connect.composio.dev/mcp'}],skills:[],apps:[]};
test('Composio Apps uses provider management with no per-app controls or invented app status',()=>{
 for(const connected of [false,true]) {
  const x=setup();x.message({type:'plugins',items:[{...composioPlugin,installed:connected,connected}]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');
  assert.ok(x.d.querySelector('.connector-panel img[alt=Composio]'));
  assert.equal(x.d.querySelectorAll('[data-app],[data-app-action],[data-app-browser],.connector-app').length,0);
  assert.match(x.d.body.textContent,/Composio For You → Connect Apps/);assert.match(x.d.body.textContent,/individual app status is shown in Composio/);
  assert.equal(x.d.querySelector('[data-lane=apps]').textContent,'Apps');
  x.click('[data-composio-catalog]');assert.equal(x.sent.at(-1).type,'composioCatalog');
  assert.equal(x.sent.filter(m=>m.type==='composioConnection').length,0);
 }
});
test('Composio detail retains branded account review and dashboard management',()=>{
 const x=setup();x.message({type:'plugins',items:[composioPlugin]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');x.click('[data-install=composio]');
 assert.ok(x.d.querySelector('dialog img[alt=DGC]'));assert.ok(x.d.querySelector('dialog img[alt=Composio]'));assert.equal(x.sent.at(-1).type,'inspectPlugin');
 x.click('#dialog-cancel');x.message({type:'plugins',items:[{...composioPlugin,installed:true,connected:true}]});x.click('[data-open=composio]');assert.ok(x.d.querySelector('[data-composio-catalog]'));assert.equal(x.d.querySelector('[data-app]'),null);
});
test('MCP lists manual servers only while plugin detail retains toggle, configure and reconnect',()=>{
 const x=setup();const linear={...plugin,name:'linear',display_name:'Linear',server_names:['linear--remote'],mcps:[{name:'linear--remote',url:'https://mcp.linear.app/mcp'}]};
 x.message({type:'plugins',items:[linear]});x.message({type:'event',event:{type:'mcp_servers',items:[{name:'linear--remote',url:'https://mcp.linear.app/mcp',transport:'remote',enabled:true,state:'connected'},{name:'local',command:'node',enabled:true,state:'configured'}]}});
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelectorAll('[data-mcp-toggle]').length,1);assert.equal(x.d.querySelector('[data-mcp-toggle="linear--remote"]'),null);assert.match(x.d.querySelector('.section-head h3').textContent,/Your servers · 1/);
 x.click('[data-nav=plugins]');x.click('[data-open=linear]');assert.ok(x.d.querySelector('.plugin-connections'));x.click('[data-mcp-toggle="linear--remote"]');assert.equal(x.sent.at(-1).type,'mcpToggle');assert.equal(x.sent.at(-1).name,'linear--remote');
 x.click('[data-mcp-edit="linear--remote"]');assert.equal(x.d.querySelector('#mcp-back').textContent,'Linear');assert.equal(x.d.querySelector('#mcp-target').value,'https://mcp.linear.app/mcp');
 x.click('#mcp-reconnect');assert.equal(x.sent.at(-1).type,'mcpReconnect');x.click('#mcp-cancel');assert.equal(x.d.querySelector('.hero h2').textContent,'Linear');
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelector('[data-mcp-toggle="linear--remote"]'),null);
});
test('plugin-only MCP connections leave a truthful empty manual-server list',()=>{
 const x=setup();x.message({type:'plugins',items:[{...composioPlugin,installed:true,connected:true,server_names:['composio']}]});x.message({type:'event',event:{type:'mcp_servers',items:[{name:'composio',state:'connected'}]}});
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelectorAll('[data-mcp-toggle]').length,0);assert.match(x.d.body.textContent,/No servers added manually/);assert.match(x.d.querySelector('.section-head h3').textContent,/Your servers · 0/);
});

test('plugin connection form keeps edits across server and catalog refreshes',()=>{
 const x=setup();
 x.message({type:'plugins',items:[plugin]});
 x.message({type:'event',event:{type:'mcp_servers',items:[{name:'fixture',transport:'remote',url:'https://mcp.example/mcp',state:'connected'}]}});
 x.click('[data-nav=plugins]');x.click('[data-open=fixture]');x.click('[data-mcp-edit=fixture]');
 x.input('#mcp-target','https://edited.example/mcp');
 x.message({type:'event',event:{type:'mcp_servers',items:[{name:'fixture',transport:'remote',url:'https://mcp.example/mcp',state:'connected'}]}});
 x.message({type:'plugins',items:[plugin]});
 assert.equal(x.d.querySelector('#mcp-target').value,'https://edited.example/mcp');
 x.click('#mcp-cancel');assert.ok(x.d.querySelector('[data-mcp-edit=fixture]'));
});

test('installed server identities do not hide manual servers named after a plugin',()=>{
 const x=setup();
 x.message({type:'plugins',items:[{...plugin,server_names:['fixture.remote'],sign_in_url:'https://example.invalid/login'}]});
 x.message({type:'event',event:{type:'mcp_servers',items:[{name:'fixture.remote',state:'connected'},{name:'fixture',state:'connected'}]}});
 x.click('[data-nav=mcp]');
 assert.ok(x.d.querySelector('[data-mcp-toggle=fixture]'));
 assert.equal(x.d.querySelector('[data-mcp-toggle="fixture.remote"]'),null);
});

const connectorCatalog=JSON.parse(readFileSync(new URL('../../../dgc/connector_catalog.json',import.meta.url),'utf8'));
const connectorRows=Object.entries(connectorCatalog).map(([name,def])=>({name,display_name:def.name,summary:def.summary,connector:name,installed:false,apps:[],skills:[],mcps:[]}));
test('Asana: the guided own-app setup shows each step, the exact redirect URL to copy, and sends the app',()=>{
  const x=setup();x.message({type:'plugins',items:connectorRows});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');
  x.click('[data-connector-setup=asana]');
  const dialogText=x.d.querySelector('dialog').textContent;
  assert.match(dialogText,/Create new app/);assert.match(dialogText,/MCP app/);assert.match(dialogText,/Manage distribution/);
  assert.equal(x.d.querySelector('#own-app-redirect').textContent,'http://localhost:3334/oauth/callback','the port DGC signs in on');
  assert.equal(x.d.querySelector('dialog a[href="https://app.asana.com/0/my-apps"]').textContent,'Open My apps in Asana');
  x.d.querySelector('[data-copy-redirect]').click();
  assert.deepEqual({...x.sent.at(-1)},{type:'copy',text:'http://localhost:3334/oauth/callback'});
  x.d.querySelector('#own-app-id').value=' 1209876543210 ';x.d.querySelector('#own-app-secret').value='s3cret-value';
  x.d.querySelector('#connector-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  const sent=x.sent.at(-1);
  assert.deepEqual({...sent},{type:'saveConnector',name:'asana',url:'https://mcp.asana.com/v2/mcp',auth:'own-app',client_id:'1209876543210',client_secret:'s3cret-value'});
  assert.equal(x.d.querySelector('#own-app-secret')?.value ?? '','','the secret leaves the form once sent');
  assert.doesNotMatch(x.d.body.innerHTML,/s3cret-value/);
});

test('Docusign: the account choice picks the endpoint and says what production needs; a saved app keeps its secret',()=>{
  const x=setup();x.message({type:'plugins',items:connectorRows});
  x.message({type:'event',event:{type:'mcp_servers',items:[{name:'docusign',url:'https://mcp.docusign.com/mcp',transport:'remote',oauth_client_id:'ik-123',oauth_port:3335}]}});
  x.click('[data-nav=plugins]');x.click('[data-lane=apps]');x.click('[data-connector-setup=docusign]');
  assert.equal(x.d.querySelector('#own-app-env').value,'production','reopens on the saved account');
  assert.match(x.d.querySelector('#own-app-env-note').textContent,/Go-Live/);
  assert.equal(x.d.querySelector('#own-app-id').value,'ik-123');
  assert.equal(x.d.querySelector('#own-app-secret').required,false,'blank keeps the saved secret key');
  assert.equal(x.d.querySelector('#own-app-redirect').textContent,'http://localhost:3335/oauth/callback');
  const env=x.d.querySelector('#own-app-env');env.value='demo';env.dispatchEvent(new x.w.Event('change'));
  assert.match(x.d.querySelector('#own-app-env-note').textContent,/developer account/i);
  x.d.querySelector('#connector-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  assert.equal(x.sent.at(-1).url,'https://mcp-d.docusign.com/mcp');assert.equal(x.sent.at(-1).client_secret,'');
});

test('Zoom: a public client: no secret field, 127.0.0.1 on its own port, the scopes to add, and only the ID is sent',()=>{
  const x=setup();x.message({type:'plugins',items:connectorRows});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');
  x.click('[data-connector-setup=zoom]');
  const dialogText=x.d.querySelector('dialog').textContent;
  for(const step of [/General app/,/User-managed/,/Use Public Client OAuth/,/OAuth allow list/,/Add Scopes/,/development public client ID/])
    assert.match(dialogText,step);
  assert.equal(x.d.querySelector('#own-app-secret'),null,'Zoom\'s public client has no secret to ask for');
  assert.match(x.d.querySelector('.own-app .note').textContent,/no secret/);
  assert.equal(x.d.querySelector('#own-app-redirect').textContent,'http://127.0.0.1:3336/oauth/callback','Zoom asks for 127.0.0.1, not localhost');
  assert.deepEqual([...x.d.querySelectorAll('#own-app-scopes code')].map(c=>c.textContent),connectorCatalog.zoom.own_app.scopes);
  assert.equal(x.d.querySelector('dialog a[href="https://marketplace.zoom.us/user/build"]').textContent,'Open Created Apps in Zoom');
  x.d.querySelector('[data-copy-redirect]').click();
  assert.deepEqual({...x.sent.at(-1)},{type:'copy',text:'http://127.0.0.1:3336/oauth/callback'});
  x.d.querySelector('#own-app-id').value=' zPublicClientId42 ';
  x.d.querySelector('#connector-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  assert.deepEqual({...x.sent.at(-1)},{type:'saveConnector',name:'zoom',url:'https://mcp.zoom.us/mcp/zoom/streamable',auth:'own-app',client_id:'zPublicClientId42'});
});

test('Apps offers named provider marks and routes each to its own setup',()=>{
 const x=setup();x.message({type:'plugins',items:[...connectorRows,{name:'composio',display_name:'Composio',apps:[],skills:[]}]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');
 for(const row of connectorRows){
  const card=x.d.querySelector(`[aria-label="${row.display_name} connector"]`);assert.ok(card);assert.ok(card.querySelector('img.logo').src.startsWith('data:'));
  x.click(`[data-connector-setup=${row.name}]`);assert.ok(x.d.querySelector('.connection-art img[alt=DGC]'));assert.ok(x.d.querySelector(`.connection-art img[alt="${row.display_name}"]`));
  if(connectorCatalog[row.name].own_app){
   // Your own app (Asana, Docusign, Zoom): the guided steps and the app's ID, its secret unless it is a public client
   // (Zoom), never a URL or token field.
   assert.ok(x.d.querySelector('.own-app-steps li'));assert.ok(x.d.querySelector('#own-app-id'));
   assert.equal(!!x.d.querySelector('#own-app-secret'),!!connectorCatalog[row.name].own_app.secret_label,`${row.name}'s secret field`);
   assert.equal(x.d.querySelector('#connector-url'),null);assert.equal(x.d.querySelector('#connector-token-field'),null);x.click('#dialog-cancel');continue;
  }
  assert.equal(!!x.d.querySelector('#connector-url'),!connectorCatalog[row.name].url);
  assert.equal(x.d.querySelector('#connector-token-field').hidden,row.name!=='zapier');x.click('#dialog-cancel');
 }
 assert.match(x.d.querySelector('[aria-label="Composio app connector"] h3').textContent,/Composio/);
 assert.equal(x.sent.filter(m=>m.type==='installPlugin').length,0);
});
test('Zapier token is sent once, cleared immediately and errors permit retry',()=>{
 const x=setup();x.message({type:'plugins',items:connectorRows});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');x.click('[data-connector-setup=zapier]');
 x.input('#connector-token','test-token');x.d.querySelector('#connector-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
 assert.equal(x.sent.at(-1).type,'saveConnector');assert.equal(x.sent.at(-1).token,'test-token');assert.equal(x.sent.at(-1).auth,'token');assert.equal(x.d.querySelector('#connector-token').value,'');assert.equal(x.d.querySelector('#connector-submit').disabled,true);
 assert.doesNotMatch(x.d.body.innerHTML,/test-token/);
 x.message({type:'connectorError',message:'Token rejected'});x.message({type:'connectorSaveFinished'});assert.match(x.d.querySelector('dialog').textContent,/Token rejected/);assert.equal(x.d.querySelector('#connector-submit').disabled,false);
});
test('Make setup exposes only a real sign-in event and cancellation uses existing host path',()=>{
 const x=setup();x.message({type:'plugins',items:connectorRows});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');x.click('[data-connector-setup=make]');
 assert.equal(x.d.querySelector('dialog [data-browser]'),null);
 x.d.querySelector('#connector-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
 x.message({type:'signin',server:'unrelated',title:'Other'});assert.equal(x.d.querySelector('dialog [data-browser]'),null);
 x.message({type:'signin',server:'make',title:'Make'});assert.match(x.d.querySelector('dialog').textContent,/Finish connecting Make/);x.click('dialog [data-browser]');assert.equal(x.sent.at(-1).type,'openSignIn');x.click('#dialog-cancel');assert.equal(x.sent.at(-1).type,'cancelSignIn');
});
test('n8n retains token choice from public state and connector-owned MCP stays out of manual tab',()=>{
 const x=setup();const row={...connectorRows.find(r=>r.name==='n8n'),installed:true,server_names:['n8n'],mcps:[{name:'n8n',url:'https://team.n8n.cloud/mcp-server/http'}]};
 x.message({type:'plugins',items:[row]});x.message({type:'event',event:{type:'mcp_servers',items:[{name:'n8n',url:row.mcps[0].url,auth_env:'DGC_MCP_BEARER_TOKEN',state:'connected',enabled:true}]}});
 x.click('[data-nav=plugins]');x.click('[data-lane=apps]');assert.match(x.d.querySelector('[aria-label="n8n connector"]').textContent,/Connected/);x.click('[data-connector-setup=n8n]');assert.equal(x.d.querySelector('#connector-auth').value,'token');assert.equal(x.d.querySelector('#connector-url').value,row.mcps[0].url);x.click('#dialog-cancel');
 x.click('[data-connector-manage=n8n]');assert.equal(x.sent.at(-1).type,'connectorManage');x.click('[data-uninstall=n8n]');assert.equal(x.sent.at(-1).type,'uninstallPlugin');x.message({type:'pluginOperationCancelled'});
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelector('[data-mcp-edit=n8n]'),null);
});


test('0.44 tool profile survives unrelated settings saves without silently reverting to adaptive',()=>{
 for(const profile of ['standard','adaptive','full']){
  const x=setup();x.message({type:'event',event:{...x.config,tool_profile:profile}});
  assert.equal(x.d.querySelector('#tool_profile').value,profile);
  x.click('#ultra_mode');x.click('#save');assert.equal(x.sent.at(-1).values.tool_profile,profile);
 }
});

test('typing a search key by key keeps every letter in order',()=>{
 // Each key rebuilds the list and its search box; the caret went back to the start, so "Granola"
 // typed in the real editor came out as "alonar".
 const x=setup();x.message({type:'plugins',items:[plugin,{name:'granola',display_name:'Granola',summary:'Meeting notes',marketplace:'dgc-curated',installed:false}]});
 x.click('[data-nav=plugins]');x.click('#browse-directory');
 for(const id of ['directory-search']){
  let typed='';
  for(const ch of 'Granola'){
   const box=x.d.getElementById(id),at=box.selectionStart??box.value.length;
   box.value=box.value.slice(0,at)+ch+box.value.slice(box.selectionEnd??at);box.setSelectionRange(at+1,at+1);
   box.dispatchEvent(new x.w.Event('input',{bubbles:true}));typed+=ch;
   const after=x.d.getElementById(id);assert.equal(after.value,typed);assert.equal(after.selectionStart,typed.length,'the caret stays after what was typed');
  }
  assert.equal(x.d.querySelectorAll('.directory-card').length,1);assert.match(x.d.querySelector('.directory-card').textContent,/Granola/);
 }
});

test('Web search: the one search Work, ChatDGC and Pips share, set here; its key is never shown back',()=>{
  const x=setup();
  x.click('[data-nav=web]');
  // A CLI that can't take the search from here never answers search_api_key_set.
  assert.match(x.d.querySelector('#page').textContent,/Update the DGC CLI/);
  // One Save covers every page, so it stays: this page's fields are what an older CLI can't take, and they are off.
  assert.equal(x.d.querySelector('#save').disabled,false,'Save all still saves the other pages');
  assert.ok([...x.d.querySelectorAll('#page .rows input,#page .rows select')].every(e=>e.disabled),'nothing here can be changed into a refused save');
  assert.equal(x.d.querySelector('#search_provider').disabled,true);
  x.message({type:'event',event:{...x.config,search:'duckduckgo',search_url:'',search_api_key_set:false}});
  const shown=()=>[...x.d.querySelectorAll('[data-search-for]')].filter(r=>!r.hidden).map(r=>r.querySelector('input').id);
  assert.equal(x.d.querySelector('#save').disabled,false);
  assert.deepEqual(shown(),[],'DuckDuckGo needs nothing');
  const pick=x.d.querySelector('#search_provider');
  pick.value='searxng';pick.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.deepEqual(shown(),['search_url'],'SearXNG: its address');
  pick.value='brave';pick.dispatchEvent(new x.w.Event('change',{bubbles:true}));pick.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  assert.deepEqual(shown(),['search_api_key'],'Brave: its key');
  x.input('#search_api_key','brave-key-123');
  x.click('#save');
  const saved=x.sent.filter(m=>m.type==='saveSettings').pop();
  assert.equal(saved.values.search_provider,'brave');
  assert.equal(saved.values.search_api_key,'brave-key-123');
  x.message({type:'settingsSaved',ok:true});
  x.message({type:'event',event:{...x.config,search:'brave',search_url:'',search_api_key_set:true,search_api_key:'brave-key-123'}});
  assert.equal(x.d.querySelector('#search_api_key').value,'','a saved key is never painted back');
  assert.match(x.d.querySelector('#page').textContent,/A key is saved/);
  assert.equal(x.d.querySelector('#search_provider').value,'brave');
});

test('Web search: Ollama, from a CLI that takes it, with its optional key saved like the others',()=>{
  const x=setup();
  x.click('[data-nav=web]');
  const options=()=>[...x.d.querySelectorAll('#search_provider option')].map(o=>o.value);
  const shown=()=>[...x.d.querySelectorAll('[data-search-for]')].filter(r=>!r.hidden).map(r=>r.querySelector('input').id);
  const hint=()=>x.d.querySelector('#search_api_key').closest('.field').querySelector('.hint').textContent;
  // A CLI whose handshake doesn't list it would refuse the whole save on it.
  x.message({type:'event',event:{...x.config,search:'duckduckgo',search_url:'',search_api_key_set:false}});
  assert.deepEqual(options(),['duckduckgo','brave','tavily','searxng'],'not offered to an older CLI');
  assert.doesNotMatch(x.d.querySelector('#page').textContent,/Ollama/);
  const offered=['duckduckgo','brave','tavily','searxng','ollama'];
  x.message({type:'event',event:{...x.config,search:'duckduckgo',search_url:'',search_api_key_set:false,search_providers:offered}});
  assert.deepEqual(options(),offered);
  assert.equal(x.d.querySelector('#search_provider option[value=ollama]').textContent,'Ollama (sign-in or key)');
  assert.match(x.d.querySelector('#page .page-detail').textContent,/Ollama uses your Ollama sign-in or a key/,'behind the page\'s "?"');
  const pick=x.d.querySelector('#search_provider');
  pick.value='ollama';pick.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.deepEqual(shown(),['search_api_key'],'Ollama: its key field');
  const said=()=>rowSaid(x.d.querySelector('#search_api_key'));
  assert.equal(hint(),'Optional when Ollama here is signed in.');
  assert.match(said(),/Signed in to Ollama on this computer\? Nothing to add\./);
  assert.match(said(),/ollama\.com → Settings → API keys/,'where to get one');
  assert.equal(x.d.querySelector('#search_api_key').type,'password');
  x.input('#search_api_key','ollama-key-123');
  x.click('#save');
  const saved=x.sent.filter(m=>m.type==='saveSettings').pop();
  assert.equal(saved.values.search_provider,'ollama');
  assert.equal(saved.values.search_api_key,'ollama-key-123','the same field and path as a Brave or Tavily key');
  x.message({type:'settingsSaved',ok:true});
  x.message({type:'event',event:{...x.config,search:'ollama',search_url:'',search_api_key_set:true,search_providers:offered}});
  assert.equal(x.d.querySelector('#search_provider').value,'ollama');
  assert.equal(x.d.querySelector('#search_api_key').value,'','a saved key is never painted back');
  assert.match(said(),/A key is saved.*used when Ollama on this computer isn't signed in/);
  const repainted=x.d.querySelector('#search_provider');
  repainted.value='brave';repainted.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(hint(),'A key is saved. Leave blank to keep it.','Brave keeps its own words');
});

test('Web search: from a CLI that keeps a key per provider, the field shows the chosen one\'s own and Remove clears just that one',()=>{
  // One shared key went with every switch: a Brave key was sent to Tavily, or to ollama.com. Now each provider has
  // its own, and the page shows the chosen provider's ("Saved" or empty, never the key) with Remove beside it.
  const x=setup();
  x.click('[data-nav=web]');
  const offered=['duckduckgo','brave','tavily','searxng','ollama'];
  const config=(keys,selected='brave')=>({...x.config,search:selected,search_url:'',search_api_key_set:keys[selected]===true,search_providers:offered,search_keys:keys});
  x.message({type:'event',event:config({brave:true,tavily:false,ollama:false})});
  const key=()=>x.d.querySelector('#search_api_key');
  const remove=()=>x.d.querySelector('#search-key-remove');
  const hint=()=>key().closest('.field').querySelector('.hint').textContent;
  const pick=(p)=>{const s=x.d.querySelector('#search_provider');s.value=p;s.dispatchEvent(new x.w.Event('input',{bubbles:true}));s.dispatchEvent(new x.w.Event('change',{bubbles:true}));};
  assert.equal(key().value,'','never the key');
  assert.equal(key().placeholder,'Saved','Brave: its own key is saved');
  assert.equal(remove().hidden,false);
  assert.equal(remove().textContent,'Remove');
  assert.equal(hint(),'A Brave key is saved. Leave blank to keep it.');
  pick('ollama');
  assert.equal(key().placeholder,'','Ollama: none of its own, so the field is empty');
  assert.equal(remove().hidden,true,'nothing of Ollama\'s to remove');
  assert.equal(hint(),'Optional when Ollama here is signed in.');
  assert.match(rowDetail(key()),/^Signed in to Ollama on this computer\?/);
  pick('tavily');
  assert.equal(key().placeholder,'');
  assert.equal(hint(),'Tavily needs a key of its own.');
  pick('brave');
  assert.equal(key().placeholder,'Saved','Brave still shows saved');
  remove().click();
  assert.deepEqual(JSON.parse(JSON.stringify(x.sent.filter(m=>m.type==='removeSearchKey'))),[{type:'removeSearchKey',provider:'brave'}]);
  assert.equal(x.sent.some(m=>m.type==='saveSettings'),false,'Remove is not a Save of the page');
  assert.equal(remove().disabled,true);
  assert.equal(remove().textContent,'Removing…');
  // The extension answers with the config its set_config asked for, then how it went.
  x.message({type:'event',event:config({brave:false,tavily:false,ollama:false})});
  x.message({type:'searchKeyRemoved',provider:'brave',ok:true});
  assert.equal(x.d.querySelector('#search_provider').value,'brave');
  assert.equal(key().placeholder,'','removed');
  assert.equal(remove().hidden,true);
  assert.equal(hint(),'Brave needs a key of its own.');
  assert.match(x.d.querySelector('#save-status').textContent,/Key removed/);
});

test('Web search: a key typed for one provider is never saved as another\'s',()=>{
  const x=setup();
  x.click('[data-nav=web]');
  const offered=['duckduckgo','brave','tavily','searxng','ollama'];
  x.message({type:'event',event:{...x.config,search:'tavily',search_url:'',search_api_key_set:false,search_providers:offered,search_keys:{brave:true,tavily:false,ollama:false}}});
  const pick=(p)=>{const s=x.d.querySelector('#search_provider');s.value=p;s.dispatchEvent(new x.w.Event('input',{bubbles:true}));s.dispatchEvent(new x.w.Event('change',{bubbles:true}));};
  x.input('#search_api_key','tvly-key-1');
  pick('ollama');
  assert.equal(x.d.querySelector('#search_api_key').value,'','cleared on the switch');
  x.click('#save');
  let saved=x.sent.filter(m=>m.type==='saveSettings').pop();
  assert.equal(saved.values.search_provider,'ollama');
  assert.equal(saved.values.search_api_key,'','nothing for Ollama: the Tavily key went nowhere');
  x.message({type:'settingsSaved',ok:true});
  pick('tavily');
  x.input('#search_api_key','tvly-key-1');
  x.click('#save');
  saved=x.sent.filter(m=>m.type==='saveSettings').pop();
  assert.deepEqual([saved.values.search_provider,saved.values.search_api_key],['tavily','tvly-key-1']);
  // A failed Remove says so and leaves the key shown as saved.
  x.message({type:'settingsSaved',ok:true});
  pick('brave');
  x.d.querySelector('#search-key-remove').click();
  x.message({type:'searchKeyRemoved',provider:'brave',ok:false,message:'synthetic rejection'});
  assert.equal(x.d.querySelector('#search_api_key').placeholder,'Saved');
  assert.equal(x.d.querySelector('#search-key-remove').disabled,false);
  assert.match(x.d.querySelector('#save-status').textContent,/synthetic rejection/);
});

test('Web search: an older CLI keeps its one key for every provider, shown as it always was, with no Remove',()=>{
  const x=setup();
  x.click('[data-nav=web]');
  x.message({type:'event',event:{...x.config,search:'brave',search_url:'',search_api_key_set:true,search_providers:['duckduckgo','brave','tavily','searxng','ollama']}});
  const hint=()=>x.d.querySelector('#search_api_key').closest('.field').querySelector('.hint').textContent;
  const pick=(p)=>{const s=x.d.querySelector('#search_provider');s.value=p;s.dispatchEvent(new x.w.Event('input',{bubbles:true}));s.dispatchEvent(new x.w.Event('change',{bubbles:true}));};
  assert.equal(x.d.querySelector('#search-key-remove'),null,'it can\'t remove a key from here');
  assert.equal(x.d.querySelector('#search_api_key').placeholder,'');
  assert.equal(hint(),'A key is saved. Leave blank to keep it.');
  x.input('#search_api_key','typed-1');
  pick('tavily');
  assert.equal(hint(),'A key is saved. Leave blank to keep it.','its one key, for Tavily too');
  assert.equal(x.d.querySelector('#search_api_key').value,'typed-1','as before');
  pick('ollama');
  assert.match(rowSaid(x.d.querySelector('#search_api_key')),/^A key is saved.*used when Ollama on this computer isn't signed in/);
});

test('ChatDGC: a personality and custom instructions, saved for every chat; hidden from a CLI that cannot take them',()=>{
  const x=setup();
  x.click('[data-nav=chatdgc]');
  assert.match(x.d.querySelector('#page').textContent,/Update the DGC CLI/);
  assert.equal(x.d.querySelector('#save').disabled,false,'Save all still saves the other pages');
  assert.equal(x.d.querySelector('#chatdgc_about').disabled,true,'this page\'s own fields an older CLI would refuse');
  x.message({type:'event',event:{...x.config,chatdgc_about:'I run a bakery in Pune.',chatdgc_style:'',chatdgc_personality:'candid'}});
  assert.equal(x.d.querySelector('#save').disabled,false);
  assert.equal(x.d.querySelector('#chatdgc_about').value,'I run a bakery in Pune.');
  assert.equal(x.d.querySelector('#chatdgc_personality').value,'candid');
  assert.equal((x.d.querySelector('#page').textContent.match(/Personality/g)||[]).length,1,'named once: its card is How it sounds');
  assert.equal(x.d.querySelector('#chatdgc_about').maxLength,1500);
  x.input('#chatdgc_style','Lead with the answer.');
  x.input('#chatdgc_personality','warm');
  assert.equal(x.d.querySelector('#chatdgc_window').value,'32k','the standard window unless chosen');
  x.input('#chatdgc_window','8k');
  x.click('#save');
  const saved=x.sent.filter(m=>m.type==='saveSettings').pop();
  assert.equal(saved.values.chatdgc_about,'I run a bakery in Pune.');
  assert.equal(saved.values.chatdgc_style,'Lead with the answer.');
  assert.equal(saved.values.chatdgc_personality,'warm');
  assert.equal(saved.values.chatdgc_window,'8k');
});

test('Memory: what DGC remembers, edited, deleted and added; projects switched; all deleted after you confirm', () => {
  const x = setup();
  x.click('[data-nav=memory]');
  assert.deepEqual(x.sent.slice(-2).map((m) => m.type), ['getMemory', 'getMemoryHistory'], 'the facts, then their history');
  assert.match(x.d.body.textContent, /Reading what DGC remembers/);
  x.message({ type: 'memory_history_unavailable' });          // an older CLI keeps no history: no Undo to offer
  const fact = (id, text, extra = {}) => ({ id, text, created_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-10T10:00:00Z', source: { surface: 'chat', where: 'Dinner' }, ...extra });
  const state = { type: 'memory_state', enabled: true,
    facts: [fact('mem_aaaaaaaaaaaa', '<b>Is vegetarian</b>'), fact('mem_bbbbbbbbbbbb', 'Prefers metric units', { source: { surface: 'settings', where: '' }, edited: true })],
    projects: [{ folder: '/w/openpeach', name: 'openpeach', when: '2026-10-09', recent: ['Billing page'], remember: true }] };
  x.message({ type: 'event', event: state });
  assert.equal(x.d.querySelector('h2').textContent, 'Memory');
  const rows = [...x.d.querySelectorAll('.memory-facts .row strong')].map((n) => n.textContent);
  assert.deepEqual(rows, ['<b>Is vegetarian</b>', 'Prefers metric units'], 'their words, as text');
  assert.equal(x.d.querySelectorAll('.memory-facts b').length, 0);
  assert.match(x.d.querySelector('.memory-facts').textContent, /From a chat: Dinner · 2026-10-10/);
  assert.match(x.d.querySelector('.memory-facts').textContent, /Added by you · 2026-10-10 · edited/);
  x.click('[data-memory-switch]');
  assert.deepEqual({ ...x.sent.at(-1) }, { type: 'memorySwitch', on: false });
  x.message({ type: 'event', event: state });
  x.click('[data-memory-edit=mem_aaaaaaaaaaaa]');
  const edit = x.d.querySelector('#memory-edit');
  edit.value = 'Is vegetarian, eats eggs';
  x.d.querySelector('[data-memory-save]').dispatchEvent(new x.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual({ ...x.sent.at(-1) }, { type: 'memoryEdit', id: 'mem_aaaaaaaaaaaa', text: 'Is vegetarian, eats eggs' });
  x.message({ type: 'event', event: state });
  x.click('[data-memory-forget=mem_bbbbbbbbbbbb]');
  assert.deepEqual({ ...x.sent.at(-1) }, { type: 'memoryForget', id: 'mem_bbbbbbbbbbbb' });
  x.message({ type: 'event', event: state });
  x.d.querySelector('#memory-add').value = 'Has two kids';
  x.d.querySelector('.memory-add').dispatchEvent(new x.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual({ ...x.sent.at(-1) }, { type: 'memoryAdd', text: 'Has two kids' });
  x.message({ type: 'event', event: { ...state, error: "That looks like a password, a key or an account number: DGC doesn't remember those." } });
  assert.match(x.d.querySelector('[role=alert]').textContent, /password, a key/);
  x.click('[data-memory-project]');
  assert.deepEqual({ ...x.sent.at(-1) }, { type: 'memoryProject', folder: '/w/openpeach', remember: false });
  x.message({ type: 'event', event: state });
  const before = x.sent.length;
  x.click('[data-memory-clear]');
  assert.match(x.d.querySelector('[role=alertdialog]').textContent, /Delete all 2 memories\? This can't be undone\./);
  assert.equal(x.sent.length, before, 'nothing deleted yet');
  x.click('[data-memory-clear-yes]');
  assert.deepEqual({ ...x.sent.at(-1) }, { type: 'memoryClear' });
  x.message({ type: 'memory_unavailable', message: 'Update the DGC CLI to see and manage what DGC remembers about you.' });
  assert.match(x.d.querySelector('[role=alert]').textContent, /Update the DGC CLI/);
});

test('Web search: ChatDGC searches on its own unless this switch turns it off, saved with the page', () => {
  const x = setup();
  x.message({ type: 'event', event: { ...x.config, search_provider: 'duckduckgo', search_api_key_set: false, search_url: '', chatdgc_web: true } });
  // It is ChatDGC's own setting, so it is on the ChatDGC page now; Web search says which search it uses.
  x.click('[data-nav=web]');
  assert.equal(x.d.querySelector('#chatdgc_web'), null, 'not on the Web search page');
  assert.match(x.d.querySelector('#page').textContent, /Whether ChatDGC searches is on the ChatDGC page/);
  x.click('[data-nav=chatdgc]');
  const on = x.d.querySelector('#chatdgc_web');
  assert.equal(on.getAttribute('aria-checked'), 'true', 'on unless you turn it off');
  assert.match(x.d.body.textContent, /Off: ChatDGC never goes online/);
  x.click('#chatdgc_web');
  x.click('#save');
  assert.equal(x.sent.at(-1).type, 'saveSettings');
  assert.equal(x.sent.at(-1).values.chatdgc_web, false);
});

test('Web search: with nothing saved, ChatDGC searches the web; this switch is the one place to turn it off (the prompt box has none)', () => {
  const x = setup();
  const { chatdgc_web: _never, ...config } = x.config;
  x.message({ type: 'event', event: { ...config, search_provider: 'duckduckgo', search_api_key_set: false, search_url: '' } });
  x.click('[data-nav=chatdgc]');
  assert.equal(x.d.querySelector('#chatdgc_web').getAttribute('aria-checked'), 'true', 'on by default');
  assert.match(x.d.body.textContent, /Search the web/);
  const y = setup();
  y.message({ type: 'event', event: { ...y.config, chatdgc_personality: 'default' } });
  y.click('[data-nav=chatdgc]');
  assert.equal(y.d.querySelector('#chatdgc_web').disabled, true, 'a CLI that takes no search from here: shown, not changeable');
});

test('ChatDGC: follow-ups under a reply, on unless this switch turns them off, saved with the page', () => {
  const x = setup();
  x.message({ type: 'event', event: { ...x.config, chatdgc_settable: true, chatdgc_personality: 'default', chatdgc_window: '32k', chatdgc_followups: true } });
  x.click('[data-nav=chatdgc]');
  const on = x.d.querySelector('#chatdgc_followups');
  assert.ok(on, 'the switch is on the ChatDGC page');
  assert.equal(on.getAttribute('aria-checked'), 'true');
  assert.equal(rowHint(on), 'A few next questions under a reply.');
  assert.match(rowDetail(on), /Click one to send it\./);
  x.click('#chatdgc_followups');
  x.click('#save');
  assert.equal(x.sent.at(-1).type, 'saveSettings');
  assert.equal(x.sent.at(-1).values.chatdgc_followups, false);
  const y = setup();
  y.message({ type: 'event', event: { ...y.config, chatdgc_settable: false } });
  y.click('[data-nav=chatdgc]');
  assert.equal(y.d.querySelector('#chatdgc_followups').disabled, true, 'an older CLI: shown, not changeable');
});

test('General: a token cap per turn, 0 for none, saved with the page; an older CLI shows it but cannot change it', () => {
  const x = setup();
  x.message({ type: 'event', event: { ...x.config, turn_token_budget: 0 } });
  const cap = x.d.querySelector('#turn_token_budget');
  assert.ok(cap, 'on the General page');
  assert.equal(cap.value, '0');
  assert.equal(cap.disabled, false);
  assert.equal(rowHint(cap), '0 means no cap.');
  assert.match(rowDetail(cap), /Tokens one turn may spend, sub-agents included\. When it is reached, no new sub-agent starts and the turn wraps up, keeping its work\./);
  x.input('#turn_token_budget', '2000000');
  x.click('#save');
  assert.equal(x.sent.at(-1).type, 'saveSettings');
  assert.equal(String(x.sent.at(-1).values.turn_token_budget), '2000000');
  const y = setup();
  y.message({ type: 'event', event: { ...y.config } });
  const old = y.d.querySelector('#turn_token_budget');
  assert.equal(old.disabled, true, 'an older CLI: shown, not changeable');
  assert.match(y.d.body.textContent, /Update the DGC CLI to set this here\./);
});

test('Settings -> Voice lists each model with its size and licence; Install shows its progress, then Use and Remove',()=>{
  const x=setup();
  const last=()=>JSON.parse(JSON.stringify(x.sent.at(-1)));   // the page's own object, from its window
  x.click('[data-nav=voice]');
  assert.deepEqual(x.sent.filter(m=>m.type==='getVoice').length,1,'it asks for the models once');
  assert.match(x.d.querySelector('main').textContent,/Reading your voice models/);
  const model=(id,role,name,size,licence,extra={})=>({id,role,name,summary:name+' summary',languages:'English',licence,size,installed:false,in_use:false,installing:null,...extra});
  const models=[model('moonshine-base-en','dictation','Moonshine',111266225,'MIT'),model('nemotron-3.5-asr','dictation','Nemotron 3.5',475271763,'NVIDIA Open Model (OpenMDW-1.1)'),
                model('kitten-mini-en','read_aloud','Kitten',67547594,'Apache-2.0'),model('pocket-tts','read_aloud','Pocket TTS',98336520,'Non-commercial use only')];
  x.message({type:'event',event:{type:'voice_state',runtime:{installed:false,size_mb:50},models,dictation:'',read_aloud:''}});
  const text=x.d.querySelector('main').textContent;
  for(const want of ['Dictation','Read aloud','Moonshine','Nemotron 3.5','475 MB','Licence: Non-commercial use only','voice engine (about 50 MB)']) assert.match(text,new RegExp(want.replace(/[()]/g,'\\$&')),want);
  x.click('[data-voice-install="nemotron-3.5-asr"]');
  assert.deepEqual(last(),{type:'voiceInstall',id:'nemotron-3.5-asr'});
  x.message({type:'event',event:{type:'voice_state',runtime:{installed:false,size_mb:50},models:models.map(m=>m.id==='nemotron-3.5-asr'?{...m,installing:{stage:'starting',done:0,total:m.size}}:m),dictation:'',read_aloud:''}});
  x.message({type:'event',event:{type:'voice_progress',id:'nemotron-3.5-asr',stage:'download',done:120000000,total:475271763}});
  const bar=x.d.querySelector('[data-voice-model="nemotron-3.5-asr"] [role=progressbar]');
  assert.equal(bar.getAttribute('aria-valuenow'),'25');
  assert.match(x.d.querySelector('[data-voice-model="nemotron-3.5-asr"]').textContent,/Downloading 120 MB of 475 MB/);
  x.click('[data-voice-cancel="nemotron-3.5-asr"]');
  assert.deepEqual(last(),{type:'voiceCancel',id:'nemotron-3.5-asr'},'Cancel works on the row the progress redrew');
  x.message({type:'event',event:{type:'voice_error',request_id:'settings-voice-1',code:'cancelled',message:'Stopped.',id:'nemotron-3.5-asr'}});
  assert.equal(x.d.querySelector('.banner.error'),null,'a cancel is not an error');
  const installed=models.map(m=>m.id==='moonshine-base-en'?{...m,installed:true,in_use:true}:m.id==='nemotron-3.5-asr'?{...m,installed:true}:m);
  x.message({type:'event',event:{type:'voice_state',runtime:{installed:true,size_mb:50},models:installed,dictation:'moonshine-base-en',read_aloud:''}});
  assert.match(x.d.querySelector('[data-voice-model="moonshine-base-en"]').textContent,/In use/);
  assert.doesNotMatch(x.d.querySelector('main').textContent,/voice engine \(about/,'the engine is there: no note');
  x.click('[data-voice-use="nemotron-3.5-asr"]');
  assert.deepEqual(last(),{type:'voiceUse',id:'nemotron-3.5-asr',role:'dictation'});
  x.click('[data-voice-remove="moonshine-base-en"]');
  assert.deepEqual(last(),{type:'voiceRemove',id:'moonshine-base-en'});
  x.message({type:'event',event:{type:'voice_error',request_id:'settings-voice-2',message:'Kitten didn\'t download correctly (its checksum doesn\'t match); try again.',id:'kitten-mini-en'}});
  assert.match(x.d.querySelector('.banner.error').textContent,/checksum/);
  x.message({type:'voice_unavailable',message:'Update the DGC CLI to use voice.'});
  assert.match(x.d.querySelector('.banner.error').textContent,/Update the DGC CLI/);
});

// A plugin that connects with a key the user makes at the vendor (GitHub's personal access token). The founder got
// "Configure GITHUB_PAT_TOKEN in MCP server settings before connecting." for Connect; the plugin's own page now has
// the field. The rows are what dgc serve's plugin list says: whether a key is saved, never the key.
const githubKey={server:'github',env:'GITHUB_PAT_TOKEN',saved:false,from_environment:false,sign_in:'',label:'GitHub personal access token',
  create_url:'https://github.com/settings/personal-access-tokens/new',create_label:'Create a fine-grained token on GitHub',
  manage_url:'https://github.com/settings/personal-access-tokens',help_url:'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
  permissions:'Repository permissions: Contents, Issues and Pull requests set to Read and write.',placeholder:'github_pat_…'};
const github={name:'github',display_name:'GitHub',summary:'Repositories, issues and pull requests.',installed:true,auth:'pat',
  server_names:['github'],mcps:[{name:'github',url:'https://api.githubcopilot.com/mcp/'}],skills:[],keys:[githubKey]};
const openGithub=(x,row=github)=>{x.message({type:'plugins',items:[row]});x.click('[data-nav=plugins]');x.click('[data-open=github]');};
const keyForm=x=>x.d.querySelector('[data-key-form]');

test('GitHub: its page has a masked token field with where to make one and what it needs; no Connect until one is saved',()=>{
  const x=setup();openGithub(x);
  const field=x.d.querySelector('[data-key-input]');
  assert.ok(field,'the field is on the plugin page itself');
  assert.equal(field.type,'password','masked');
  assert.equal(field.getAttribute('autocomplete'),'off');
  assert.equal(field.value,'');
  assert.match(field.closest('label').textContent,/GitHub personal access token/);
  const make=[...x.d.querySelectorAll('a[data-external]')].find(a=>/Create a fine-grained token/.test(a.textContent));
  assert.equal(make?.getAttribute('href'),'https://github.com/settings/personal-access-tokens/new');
  make.click();assert.deepEqual({...x.sent.at(-1)},{type:'openPluginLink',url:'https://github.com/settings/personal-access-tokens/new'});
  assert.match(x.d.querySelector('.key-permissions').textContent,/Contents, Issues and Pull requests/);
  assert.match(x.d.querySelector('.key-where').textContent,/Paste it here and choose Save, then Connect/);
  assert.equal(x.d.querySelector('[data-connect=github]'),null,'Connect waits for a key');
  assert.equal(x.d.querySelector('[data-key-remove]'),null,'nothing to remove yet');
  assert.doesNotMatch(x.d.body.textContent,/MCP server settings|Configure GITHUB_PAT_TOKEN/);
});

test('GitHub: Save sends the token once and clears it; the page then says Saved, never the token, and offers Remove',()=>{
  const x=setup();openGithub(x);
  x.input('[data-key-input]','github_pat_secret_value');
  keyForm(x).dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  const saved=x.sent.filter(m=>m.type==='savePluginKey');
  assert.deepEqual(saved.map(m=>({...m})),[{type:'savePluginKey',name:'github',server:'github',env:'GITHUB_PAT_TOKEN',key:'github_pat_secret_value'}]);
  assert.equal(x.d.querySelector('[data-key-input]').value,'','cleared at once');
  assert.match(x.d.querySelector('.key-form .save').textContent,/Saving/);
  x.message({type:'pluginKeyResult',name:'github',server:'github',message:'Saved your GitHub personal access token in your system keychain.'});
  x.message({type:'plugins',items:[{...github,keys:[{...githubKey,saved:true}]}]});
  assert.equal(x.d.querySelector('.key-saved').textContent,'Saved');
  assert.match(x.d.querySelector('[data-key-input]').placeholder,/Saved/);
  assert.equal(x.d.querySelector('[data-key-input]').value,'');
  assert.doesNotMatch(x.d.body.innerHTML,/github_pat_secret_value/,'the token is nowhere on the page');
  assert.ok(x.d.querySelector('[data-connect=github]'),'Connect is offered once a token is saved');
  x.click('[data-key-remove]');
  assert.deepEqual({...x.sent.at(-1)},{type:'removePluginKey',name:'github',server:'github',env:'GITHUB_PAT_TOKEN'});
  assert.match(x.d.querySelector('[data-key-remove]').textContent,/Removing/);
});

test('GitHub: a refused save and a failed connection are said on the page beside the field',()=>{
  const x=setup();openGithub(x);
  keyForm(x).dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  assert.equal(x.sent.filter(m=>m.type==='savePluginKey').length,0,'an empty field sends nothing');
  assert.match(x.d.querySelector('.key-error').textContent,/Paste the key first/);
  x.input('[data-key-input]','not a key');keyForm(x).dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  x.message({type:'pluginKeyResult',name:'github',server:'github',error:"That doesn't look like a key: it has spaces or line breaks in it."});
  assert.match(x.d.querySelector('.key-error').textContent,/spaces or line breaks/);
  const refused="GitHub didn't accept this personal access token (HTTP 401). Check that you copied all of it.";
  x.message({type:'pluginKeyResult',name:'github',server:'github',message:'Saved.'});
  x.message({type:'plugins',items:[{...github,keys:[{...githubKey,saved:true}],connection_error:refused}]});
  const error=x.d.querySelector('.plugin-key .key-error');
  assert.match(error.textContent,/didn't accept this personal access token \(HTTP 401\)/);
  assert.ok(error.closest('.plugin-key').querySelector('[data-key-input]'),'the field is right there');
  assert.equal(x.d.querySelectorAll('[role=alert]').length,1,'said once, in the panel');
  x.click('[data-connect=github]');
  assert.deepEqual({...x.sent.at(-1)},{type:'installPlugin',name:'github'},'Connect connects at once: no browser dialog');
  assert.equal(x.d.querySelector('dialog'),null);
  // Found in real VS Code: while the new Connect ran, the last attempt's error was still on the page as if it were
  // the answer. Until this one finishes, the page says it is connecting.
  assert.equal(x.d.querySelector('.plugin-key .key-error'),null,'no stale error while connecting');
  assert.match(x.d.querySelector('.plugin-key .key-note').textContent,/Connecting to GitHub…/);
  x.message({type:'pluginResult',name:'github',error:refused});
  assert.match(x.d.querySelector('.plugin-key .key-error').textContent,/HTTP 401/,'then the answer');
});

test('GitHub: a token kept in the owner-only file says so, not "keychain"',()=>{
  const x=setup();openGithub(x,{...github,keys:[{...githubKey,saved:true,stored:'file'}]});
  assert.match(x.d.querySelector('.key-where').textContent,/saved in an owner-only file on this computer/);
  assert.doesNotMatch(x.d.querySelector('.key-where').textContent,/keychain\./);
  const y=setup();openGithub(y,{...github,keys:[{...githubKey,saved:true,stored:'keychain'}]});
  assert.match(y.d.querySelector('.key-where').textContent,/saved in your system keychain/);
});

test('GitHub: a token from the environment is named as the fallback; a half-typed token survives a refresh',()=>{
  const x=setup();openGithub(x,{...github,keys:[{...githubKey,from_environment:true}]});
  assert.match(x.d.querySelector('.key-where').textContent,/GITHUB_PAT_TOKEN from the environment/);
  assert.ok(x.d.querySelector('[data-connect=github]'),'the environment token can connect');
  x.input('[data-key-input]','github_pat_half');
  x.message({type:'plugins',items:[{...github,keys:[{...githubKey,from_environment:true}]}]});
  assert.equal(x.d.querySelector('[data-key-input]').value,'github_pat_half');
});

// "What DGC may do on GitHub" (founder, 19 Oct 2026: "make the user decide"). The rows are dgc serve's: each
// permission, whether the next sign-in asks for it (chosen), whether the sign-in made has it (held), and whether a
// tool asked for it.
const permission=(id,label,short,scope,always=false)=>({id,label,short,scope,always,chosen:always,held:false,asked:false,description:`What ${label} lets DGC do.`});
const githubScopes=[permission('code','Code, issues and pull requests','code, issues, pull requests','repo',true),
  permission('organisations','Your organisations','organisations','read:org',true),
  permission('profile','Your profile and email','profile','read:user user:email',true),
  permission('notifications','Notifications','notifications','notifications'),permission('gists','Gists','gists','gist'),
  permission('projects','Projects','projects','read:project project'),
  permission('packages_read','Packages — read','reading packages','read:packages'),
  permission('packages_write','Packages — write','publishing packages','write:packages')];
const signInKey=(scopes=githubScopes,extra={})=>({...githubKey,sign_in:'GitHub',signed_in:false,sign_in_scopes:scopes.map(p=>({...p})),...extra});
const scopeBox=(x,id)=>x.d.querySelector(`[data-scope-choice=${id}]`);

test('GitHub: above Sign in with GitHub, what DGC may do: the always-on ones ticked for good, the rest off until turned on',()=>{
  const x=setup();openGithub(x,{...github,keys:[signInKey()]});
  const box=x.d.querySelector('.sign-in-scopes');
  assert.equal(box.querySelector('legend').textContent,'What DGC may do on GitHub');
  assert.ok(box.compareDocumentPosition(x.d.querySelector('[data-key-sign-in]'))&x.w.Node.DOCUMENT_POSITION_FOLLOWING,'the checklist comes before the button');
  const rows=[...box.querySelectorAll('.scope-choice')];
  assert.deepEqual(rows.map(r=>r.querySelector('strong').textContent),['Code, issues and pull requests','Your organisations','Your profile and email','Notifications','Gists','Projects','Packages — read','Packages — write']);
  for(const row of rows.slice(0,3)){
    const input=row.querySelector('input');
    assert.equal(input.checked,true,'always on');assert.equal(input.disabled,true,'and can not be unticked');
    assert.match(row.textContent,/Always on/);
  }
  for(const row of rows.slice(3)){const input=row.querySelector('input');assert.equal(input.checked,false,'off by default');assert.equal(input.disabled,false);}
  assert.equal(rows[0].querySelector('code').textContent,'repo','the GitHub scope it asks for');
  assert.match(rows[0].textContent,/What Code, issues and pull requests lets DGC do\./,'and its one line');
  assert.match(rows[5].querySelector('code').textContent,/read:project project/);
  scopeBox(x,'notifications').checked=true;scopeBox(x,'notifications').dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.deepEqual({...x.sent.at(-1),scopes:[...x.sent.at(-1).scopes]},{type:'setPluginSignInScopes',name:'github',scopes:['notifications']});
  assert.equal(scopeBox(x,'gists').disabled,true,'one save at a time');
  x.message({type:'pluginKeyResult',name:'github',server:'',kind:'scopes',message:'Saved. Signing in asks GitHub for: code, issues, pull requests, organisations, profile, notifications.'});
  assert.match(x.d.querySelector('.scope-note').textContent,/Signing in asks GitHub for: .*notifications/);
  assert.equal(x.d.querySelector('.key-note'),null,'said beside the checklist, not the key field');
  assert.equal(scopeBox(x,'notifications').checked,true);
  scopeBox(x,'gists').checked=true;scopeBox(x,'gists').dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.deepEqual([...x.sent.at(-1).scopes],['notifications','gists']);
  x.message({type:'pluginKeyResult',name:'github',server:'',kind:'scopes',error:"GitHub has no permission called 'x'."});
  assert.match(x.d.querySelector('.scope-note[role=alert]').textContent,/no permission called/);
  const saved=setup();openGithub(saved,{...github,keys:[signInKey(githubScopes.map(p=>p.id==='projects'?{...p,chosen:true}:p))]});
  assert.equal(scopeBox(saved,'projects').checked,true,'a saved choice is shown as saved');
});

test('GitHub: signed in, the page says what with; a change says GitHub asks again and offers Sign in again',()=>{
  const held=githubScopes.map(p=>['code','organisations','profile','notifications'].includes(p.id)?{...p,chosen:true,held:true}:p);
  const x=setup();openGithub(x,{...github,connected:true,keys:[signInKey(held,{signed_in:true})]});
  assert.equal(x.d.querySelector('.scope-summary').textContent,'Signed in with: code, issues, pull requests, organisations, profile, notifications');
  assert.equal(x.d.querySelector('[data-sign-in-again]'),null,'nothing to approve while the choice is what it has');
  scopeBox(x,'gists').checked=true;scopeBox(x,'gists').dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.match(x.d.querySelector('.scope-change').textContent,/You changed what DGC may do\. GitHub asks you to approve that, so it takes a new sign-in\./);
  x.message({type:'pluginKeyResult',name:'github',server:'',kind:'scopes',message:'Saved.'});
  x.click('[data-sign-in-again]');
  assert.deepEqual({...x.sent.at(-1),scopes:[...x.sent.at(-1).scopes]},{type:'signInAgain',name:'github',scopes:['notifications','gists']});
  assert.match(x.d.querySelector('[data-sign-in-again]').textContent,/Signing in…/);
  assert.equal(scopeBox(x,'projects').disabled,true,'the choice holds still while it signs in');
  const after=held.map(p=>p.id==='gists'?{...p,chosen:true,held:true}:p);
  x.message({type:'plugins',items:[{...github,connected:true,keys:[signInKey(after,{signed_in:true})]}]});
  x.message({type:'pluginResult',name:'github'});
  assert.equal(x.d.querySelector('.scope-summary').textContent,'Signed in with: code, issues, pull requests, organisations, profile, notifications, gists');
  assert.equal(x.d.querySelector('[data-sign-in-again]'),null);
  // Turning one off is a change too: GitHub issues a sign-in with less only when asked again.
  scopeBox(x,'notifications').checked=false;scopeBox(x,'notifications').dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.ok(x.d.querySelector('[data-sign-in-again]'));
  assert.deepEqual([...x.sent.at(-1).scopes],['gists']);
  // Signed in but not connected (the server off, or GitHub unreachable): said as that, and the button connects.
  const away=setup();openGithub(away,{...github,connected:false,keys:[signInKey(held,{signed_in:true})]});
  assert.match(away.d.querySelector('.key-where').textContent,/Signed in with GitHub, kept on this computer; not connected right now/);
  assert.equal(away.d.querySelector('[data-key-sign-in]').textContent,'Connect');
});

test('GitHub: a permission a tool asked for is marked, and the page says to turn it on and sign in again',()=>{
  const held=githubScopes.map(p=>p.always?{...p,held:true}:p.id==='notifications'?{...p,asked:true}:p);
  const x=setup();openGithub(x,{...github,connected:true,keys:[signInKey(held,{signed_in:true})]});
  const asked=scopeBox(x,'notifications').closest('.scope-choice');
  assert.match(asked.querySelector('.scope-tag.asked').textContent,/A tool asked for this/);
  assert.equal(x.d.querySelectorAll('.scope-tag.asked').length,1);
  assert.match(x.d.querySelector('.scope-asked').textContent,/A GitHub tool asked for Notifications\. Turn it on here, then sign in again\./);
  scopeBox(x,'notifications').checked=true;scopeBox(x,'notifications').dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(x.d.querySelector('.scope-asked'),null,'turned on: Sign in again is what is left');
  assert.ok(x.d.querySelector('[data-sign-in-again]'));
});

test('GitHub: with a token saved there is no checklist: the token decides what DGC may do',()=>{
  const x=setup();openGithub(x,{...github,keys:[signInKey(githubScopes,{saved:true})]});
  assert.equal(x.d.querySelector('.sign-in-scopes'),null);
  const plain=setup();openGithub(plain,{...github,keys:[{...githubKey,sign_in:'GitHub'}]});
  assert.equal(plain.d.querySelector('.sign-in-scopes'),null,'an older DGC sends no checklist; the button still works');
  assert.ok(plain.d.querySelector('[data-key-sign-in]'));
});

test('GitHub: Sign in with GitHub, once DGC has an app for it, connects and shows the code to enter',()=>{
  const x=setup();openGithub(x,{...github,keys:[{...githubKey,sign_in:'GitHub'}]});
  assert.match(x.d.querySelector('.key-where').textContent,/Sign in with GitHub in your browser, or paste your own GitHub personal access token/);
  x.click('[data-key-sign-in]');
  assert.deepEqual({...x.sent.at(-1)},{type:'installPlugin',name:'github'});
  x.message({type:'signin',server:'github',title:'GitHub',host:'github.com',id:'s1',code:'WDJB-MJHT'});
  assert.match(x.d.querySelector('.banner').textContent,/Enter the code WDJB-MJHT on the page that opened to finish connecting GitHub/);
  x.click('[data-copy-code]');
  assert.deepEqual({...x.sent.at(-1)},{type:'copy',text:'WDJB-MJHT'});
  x.message({type:'plugins',items:[{...github,connected:true,keys:[{...githubKey,sign_in:'GitHub'}]}]});
  assert.equal(x.d.querySelector('.key-saved').textContent,'Signed in');
  assert.equal(x.d.querySelector('[data-key-sign-in]'),null);
  const plain=setup();openGithub(plain);
  assert.equal(plain.d.querySelector('[data-key-sign-in]'),null,'no sign-in button without an app to sign in with');
});

test('Models -> Advanced: Wait for the first word (Auto, minutes, Never) and Wait between words',()=>{
  // 0.49. Both come from a CLI that answers model_wait_settings (the extension forwards them as the page shows them,
  // with wait_settable); an older CLI would refuse a save that carried them, so the controls are off there.
  const older=setup();
  older.click('[data-nav=models]');
  const oldPick=older.d.querySelector('#wait_first_word');
  assert.ok(oldPick,'the row is there');
  assert.equal(oldPick.disabled,true,'an older CLI cannot take it');
  assert.equal(older.d.querySelector('#wait_between_words').disabled,true);

  const x=setup();
  x.message({type:'event',event:{...x.config,base_url:'http://127.0.0.1:11434/v1',wait_settable:true,
    wait_first_word:'auto',wait_first_word_minutes:'',wait_between_words:'5'}});
  x.click('[data-nav=models]');
  const pick=x.d.querySelector('#wait_first_word'),minutes=x.d.querySelector('#wait_first_word_minutes'),between=x.d.querySelector('#wait_between_words');
  assert.ok(pick.closest('details.more'),'under Advanced');
  assert.equal(pick.disabled,false);
  assert.deepEqual([...pick.options].map(o=>[o.value,o.textContent]),[['auto','Auto'],['minutes','Minutes'],['never','Never']]);
  assert.equal(pick.value,'auto');
  assert.equal(minutes.hidden,true,'no minutes box for Auto');
  const row=pick.closest('.field');
  assert.match(row.querySelector('label.name').textContent,/^Wait for the first word$/);
  assert.match(row.querySelector('.hint').textContent,/Auto: as long as a local model works\./);
  assert.match(row.querySelector('.detail').textContent,/5 minutes for a cloud model/);
  assert.equal(row.querySelector('.detail').hidden,true,'detail one click away');
  row.querySelector('button.info').click();
  assert.equal(row.querySelector('.detail').hidden,false);
  assert.match(between.closest('.field').textContent,/Wait between words/);
  assert.equal(between.value,'5');

  x.input('#wait_first_word','minutes');pick.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(minutes.hidden,false,'Minutes shows its box');
  assert.equal(minutes.value,'15','starting from the 15 minutes a local model used to get');
  x.input('#wait_first_word_minutes','40');x.input('#wait_between_words','10');
  x.click('#save');
  let saved=x.sent.filter(m=>m.type==='saveSettings').pop().values;
  assert.deepEqual([saved.wait_first_word,saved.wait_first_word_minutes,saved.wait_between_words],['minutes','40','10']);
  x.message({type:'settingsSaved',ok:true});

  // What the CLI keeps comes back as the page shows it: a number of minutes, or Never.
  x.message({type:'event',event:{...x.config,wait_settable:true,wait_first_word:'never',wait_first_word_minutes:'',wait_between_words:'0'}});
  x.click('[data-nav=general]');x.click('[data-nav=models]');
  assert.equal(x.d.querySelector('#wait_first_word').value,'never');
  assert.equal(x.d.querySelector('#wait_first_word_minutes').hidden,true);
  assert.equal(x.d.querySelector('#wait_between_words').value,'0');
});

test('Models: the cache lifetime and, for a local Ollama only, how long the model stays loaded',()=>{
  // 0.48. Both come from a CLI that answers cache_settings (the extension marks the config it forwards with
  // cache_settable); an older CLI would refuse a save that carried them, so the controls are off there.
  const older=setup();
  older.click('[data-nav=models]');
  assert.equal(older.d.querySelector('#prompt_cache_ttl').disabled,true,'an older CLI cannot take it');
  assert.match(older.d.body.textContent,/Update the DGC CLI to set this here/);
  assert.equal(older.d.querySelector('#ollama_keep_alive'),null,'not an Ollama host: nothing to keep loaded');

  const x=setup();
  x.message({type:'event',event:{...x.config,base_url:'http://localhost:11434/v1',cache_settable:true,prompt_cache_ttl:'5m',ollama_keep_alive:'30m'}});
  x.click('[data-nav=models]');
  const ttl=x.d.querySelector('#prompt_cache_ttl'),keep=x.d.querySelector('#ollama_keep_alive');
  assert.equal(ttl.disabled,false);
  assert.deepEqual([...ttl.options].map(o=>o.value),['5m','1h']);
  assert.ok(keep,'a local Ollama shows the keep-loaded time');
  assert.equal(keep.value,'30m');
  assert.match(keep.closest('.field').textContent,/Keep the model loaded/);
  assert.match(keep.closest('.field').textContent,/after the last reply/);
  assert.deepEqual([...keep.options].map(o=>o.value),['5m','15m','30m','1h','4h','24h','-1','']);
  x.input('#prompt_cache_ttl','1h');x.input('#ollama_keep_alive','4h');
  x.click('#save');
  const saved=x.sent.filter(m=>m.type==='saveSettings').pop().values;
  assert.equal(saved.prompt_cache_ttl,'1h');assert.equal(saved.ollama_keep_alive,'4h');
  x.message({type:'settingsSaved',ok:true});

  // A value set elsewhere (the CLI, config.json) is shown as it is, not replaced by a preset.
  x.message({type:'event',event:{...x.config,base_url:'http://127.0.0.1:11434',cache_settable:true,prompt_cache_ttl:'5m',ollama_keep_alive:'45m'}});
  x.click('[data-nav=general]');x.click('[data-nav=models]');
  assert.equal(x.d.querySelector('#ollama_keep_alive').value,'45m');

  for(const remote of ['https://api.anthropic.com/v1','https://ollama.com/v1','https://api.deepseek.com/v1']){
    const y=setup();
    y.message({type:'event',event:{...y.config,base_url:remote,cache_settable:true,prompt_cache_ttl:'5m',ollama_keep_alive:'30m'}});
    y.click('[data-nav=models]');
    assert.equal(y.d.querySelector('#ollama_keep_alive'),null,`${remote}: not a local Ollama`);
    assert.ok(y.d.querySelector('#prompt_cache_ttl'));
  }
});

test('General: Context size says a vLLM or llama.cpp server set the window, and how to change it there',()=>{
  // 0.48. These servers size the window when they start; the extension adds the last server_window event to the
  // config it forwards (not a protocol field). A number here can only be smaller, and then decides when DGC compacts.
  const plain=setup();
  plain.click('[data-nav=general]');
  // One line, and the rest behind its "?" (rowSaid joins them).
  const hintOf=x=>rowSaid(x.d.querySelector('#context_size'));
  assert.equal(hintOf(plain),"Tokens DGC keeps before it compacts. The model's own maximum still applies.");

  const x=setup();
  x.message({type:'event',event:{...x.config,context_size:32768,server_window:{model:'qwen2.5-0.5b',window:8192,server:'vllm',trained:0}}});
  x.click('[data-nav=general]');
  assert.equal(hintOf(x),'Set by the server: 8K. Restart vLLM with --max-model-len to change it. A smaller number here makes DGC compact sooner.');
  assert.equal(x.d.querySelector('#context_size').value,'8192','the window in use: above the server\'s can\'t apply');
  assert.equal(x.d.querySelector('#context_size').max,'','a larger number typed is refused by nothing on the page: DGC holds it to the server\'s');

  // The server restarted with another size (or llama-server answered): said in place, a number being typed is kept.
  x.input('#context_size','4096');
  x.message({type:'event',event:{type:'server_window',model:'local',window:6144,server:'llamacpp',trained:32768}});
  assert.equal(hintOf(x),'Set by the server: 6K. Restart llama-server with -c to change it. A smaller number here makes DGC compact sooner.');
  assert.equal(x.d.querySelector('#context_size').value,'4096');
  x.message({type:'event',event:{type:'server_window',model:'qwen3.8:27b',window:0}});
  assert.equal(hintOf(x),"Tokens DGC keeps before it compacts. The model's own maximum still applies.");
  assert.equal(x.d.querySelector('#context_size').value,'4096','what you typed stays');
  x.click('#save');
  const saved=x.sent.filter(m=>m.type==='saveSettings').pop().values;
  assert.equal(saved.context_size,'4096');

  // The server's word arriving after the page opened: the number shown follows it until you type one.
  const y=setup();
  y.click('[data-nav=general]');
  assert.equal(y.d.querySelector('#context_size').value,'65536');
  y.message({type:'event',event:{type:'server_window',model:'qwen2.5-0.5b',window:24576,server:'vllm'}});
  assert.equal(y.d.querySelector('#context_size').value,'24576');
  assert.match(hintOf(y),/^Set by the server: 24K\. Restart vLLM/);
});

test('Agents: the sub-agents\' Context size, blank for the main model\'s window, checked like the main one',()=>{
  // Settings -> Agents -> Sub-agents had Model, Host URL, Transport and API key but not the window the backend has
  // had since 0.40 (subagent_context_size: 0 is the main model's, else 2,048 to 16,777,216 tokens).
  const hintOf=x=>x.d.querySelector('#subagent_context_size').closest('.field').querySelector('.hint').textContent;
  const older=setup();
  older.click('[data-nav=agents]');
  const box=older.d.querySelector('#subagent_context_size');
  assert.ok(box,'the card has the field');
  assert.equal(box.disabled,true,'a CLI that never answered it would refuse the save');
  assert.match(hintOf(older),/Update the DGC CLI/);

  const x=setup();
  x.message({type:'event',event:{...x.config,subagent_context_size:0}});
  x.click('[data-nav=agents]');
  const size=()=>x.d.querySelector('#subagent_context_size');
  assert.equal(size().disabled,false);
  assert.equal(size().value,'','0 is shown as blank');
  assert.equal(size().placeholder,'Same as the main model');
  assert.equal(size().closest('.group').querySelector('h3').textContent,'Sub-agents');
  x.message({type:'event',event:{...x.config,subagent_context_size:65536}});
  assert.equal(size().value,'65536');

  const saves=()=>x.sent.filter(m=>m.type==='saveSettings');
  for(const bad of ['1024','50000','33554432','-2048']){
    x.input('#subagent_context_size',bad);
    const before=saves().length;
    x.click('#save');
    assert.equal(saves().length,before,`${bad} is refused on the page, as the main Context size refuses one`);
  }
  for(const [typed,posted] of [['131072','131072'],['','' ],['0','0'],['2048','2048']]){
    x.input('#subagent_context_size',typed);
    x.click('#save');
    assert.equal(saves().at(-1)?.values.subagent_context_size,posted,typed||'blank');
    x.message({type:'settingsSaved',ok:true});
  }
  // Saved from another page, the window travels as it was read.
  x.message({type:'event',event:{...x.config,subagent_context_size:32768}});
  x.click('[data-nav=general]');x.click('#save');
  assert.equal(saves().at(-1).values.subagent_context_size,'32768');
});

// ---- Model boxes: each lists the models at its own card's host (list_models_at) ------------------------------
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const asks=x=>x.sent.filter(m=>m.type==='listModelsAt');
const answer=(x,ask,fields)=>x.message({type:'modelsAt',token:ask.token,role:ask.role,...fields});
const openList=(x,id)=>x.d.querySelector(`[data-model-open=${id}]`).dispatchEvent(new x.w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
const optionsOf=(x,id)=>[...x.d.querySelectorAll(`#${id}-list [role=option]`)].map(li=>li.textContent);

test('Model boxes stay text boxes with a CLI that can\'t list a host\'s models',()=>{
  const x=setup();
  for(const [nav,ids] of [['models',['model']],['agents',['subagent_model','fallback_model']]]){
    x.click(`[data-nav=${nav}]`);
    for(const id of ids){
      const box=x.d.querySelector('#'+id);
      assert.equal(box.tagName,'INPUT');
      assert.equal(box.getAttribute('role'),null,`${id}: no list to offer`);
      assert.equal(x.d.querySelector(`[data-model-open=${id}]`),null);
    }
  }
  assert.deepEqual(asks(x),[],'and nothing is asked of the CLI');
});

test('Models: the Model box lists the models at the host as typed, and still takes any name',async()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,list_models_at:true,api_mode:'ollama'}});
  x.click('[data-nav=models]');
  const box=x.d.querySelector('#model');
  assert.equal(box.getAttribute('role'),'combobox');
  const first=asks(x).at(-1);
  assert.deepEqual({role:first.role,base_url:first.base_url,api_mode:first.api_mode,key:'api_key' in first},
    {role:'main',base_url:'https://model.example/v1',api_mode:'ollama',key:false},'the saved host, and no key: none was typed');
  answer(x,first,{ids:['glm-5.3:cloud','original','qwen3:8b']});
  openList(x,'model');
  assert.deepEqual(optionsOf(x,'model'),['glm-5.3:cloud','original','qwen3:8b'],'opened on a listed name: every model, to pick another');
  assert.equal(x.d.querySelector('#model-list [aria-selected=true]').textContent,'original');
  assert.equal(box.getAttribute('aria-expanded'),'true');
  x.d.querySelector('#model-list [data-model="qwen3:8b"]').dispatchEvent(new x.w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  assert.equal(box.value,'qwen3:8b');
  assert.equal(x.d.querySelector('#model-list').hidden,true);
  // Typing filters; a name it doesn't list is kept.
  x.input('#model','glm');
  assert.deepEqual(optionsOf(x,'model'),['glm-5.3:cloud']);
  x.input('#model','my-own-model');
  assert.deepEqual(optionsOf(x,'model'),[]);
  assert.match(x.d.querySelector('#model-list').textContent,/Keep typing to use that name/);
  x.click('#save');
  assert.equal(x.sent.filter(m=>m.type==='saveSettings').pop().values.model,'my-own-model');
  x.message({type:'settingsSaved',ok:true});

  // Another host typed: listed again after a pause, without saving, and with no saved key.
  const before=asks(x).length;
  x.input('#base_url','http://127.0.0.1:11434/v1');
  x.input('#base_url','http://127.0.0.1:11434/v1/');
  assert.equal(asks(x).length,before,'not on every keystroke');
  await pause(750);
  assert.equal(asks(x).length,before+1,'once, after the pause');
  const local=asks(x).at(-1);
  assert.equal(local.base_url,'http://127.0.0.1:11434/v1/');
  assert.equal('api_key' in local,false);
  assert.equal(x.sent.filter(m=>m.type==='saveSettings').length,1,'nothing was saved to list it');
  // A key typed in the form goes with it; a transport chosen lists again.
  x.input('#api_key','typed-key');
  await pause(750);
  assert.equal(asks(x).at(-1).api_key,'typed-key');
  x.d.querySelector('#api_mode').value='chat_completions';
  x.d.querySelector('#api_mode').dispatchEvent(new x.w.Event('change',{bubbles:true}));
  await pause(750);
  assert.equal(asks(x).at(-1).api_mode,'chat_completions');
  // A late answer to an older request is not this box's any more.
  answer(x,local,{ids:['stale-model']});
  answer(x,asks(x).at(-1),{ids:[],error:'it needs an API key (HTTP 401)'});
  const status=x.d.querySelector('#model-status');
  assert.equal(status.hidden,false);
  assert.equal(status.textContent,"Couldn't list the models at this host: it needs an API key (HTTP 401).");
  x.input('#model','');
  openList(x,'model');
  assert.doesNotMatch(x.d.querySelector('#model-list').textContent,/stale-model/);
});

test('Models: the Model box works from the keyboard',()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,list_models_at:true}});
  x.click('[data-nav=models]');
  answer(x,asks(x).at(-1),{ids:['a-model','b-model','original']});
  const box=x.d.querySelector('#model');
  const key=k=>box.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
  box.focus();
  key('ArrowDown');
  assert.equal(x.d.querySelector('#model-list').hidden,false,'Down opens it');
  assert.equal(box.getAttribute('aria-activedescendant'),'model-opt-0');
  key('ArrowDown');
  assert.equal(box.getAttribute('aria-activedescendant'),'model-opt-1');
  key('Enter');
  assert.equal(box.value,'b-model');
  assert.equal(x.d.querySelector('#model-list').hidden,true);
  key('ArrowUp');
  assert.equal(box.getAttribute('aria-activedescendant'),'model-opt-2');
  key('Escape');
  assert.equal(x.d.querySelector('#model-list').hidden,true,'Esc closes it');
  assert.equal(box.value,'b-model','and keeps what is there');
});

test('Agents: each Model box lists its own card\'s host; Subscription model stays text',async()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,list_models_at:true,api_mode:'ollama',fallback_base_url:'',subagent_api_mode:'chat_completions'}});
  x.click('[data-nav=agents]');
  const of=role=>asks(x).filter(m=>m.role===role).at(-1);
  assert.deepEqual([of('subagent').base_url,of('subagent').api_mode],['https://agent.example/v1','chat_completions']);
  assert.deepEqual([of('fallback').base_url,of('fallback').api_mode],['https://model.example/v1','ollama'],
    'a blank host is the main one, with its transport ("Inherit")');
  answer(x,of('subagent'),{ids:['agent','worker-7b']});
  answer(x,of('fallback'),{ids:['backup','original']});
  openList(x,'subagent_model');
  assert.deepEqual(optionsOf(x,'subagent_model'),['agent','worker-7b']);
  openList(x,'fallback_model');
  assert.deepEqual(optionsOf(x,'fallback_model'),['backup','original']);
  // The fallback gets a host of its own: its box lists that one, and only that box asks again.
  const before=asks(x).length;
  x.input('#fallback_base_url','https://other.example/v1');
  await pause(750);
  const fresh=asks(x).slice(before);
  assert.deepEqual(fresh.map(m=>[m.role,m.base_url,m.api_mode]),[['fallback','https://other.example/v1','auto']],
    'another host is Auto when the transport is Inherit');
  x.input('#subagent_api_key','sub-typed');
  await pause(750);
  assert.equal(asks(x).at(-1).role,'subagent');
  assert.equal(asks(x).at(-1).api_key,'sub-typed');
  x.click('[data-nav=models]');
  assert.equal(x.d.querySelector('#subscription_model').getAttribute('role'),null,'a subscription CLI has no list');
});

test('a provider preset lists the host it fills in',async()=>{
  const x=setup();
  x.message({type:'providers',providers:[{id:'ollama',label:'Ollama',url:'http://127.0.0.1:11434/v1'}]});
  x.message({type:'event',event:{...x.config,list_models_at:true}});
  x.click('[data-nav=models]');
  const before=asks(x).length;
  const preset=x.d.querySelector('#provider');
  preset.value='ollama';preset.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  await pause(750);
  assert.equal(asks(x).length,before+1);
  assert.equal(asks(x).at(-1).base_url,'http://127.0.0.1:11434/v1');
});

test('Agents: Model for Pips, a Pips-wide default that every Pip on Default follows',()=>{
  const older=setup();
  older.click('[data-nav=agents]');
  const card=[...older.d.querySelectorAll('.group')].find(c=>c.querySelector('h3').textContent==='Pips');
  assert.ok(card,'a Pips group');
  assert.equal(card.querySelector('#pips_model').disabled,true,'a CLI that never answered pips_settings would refuse the save');
  assert.match(card.textContent,/Model for Pips/);
  assert.match(card.textContent,/Update the DGC CLI/);

  const x=setup();
  x.message({type:'event',event:{...x.config,list_models_at:true,api_mode:'ollama',pips_settable:true,pips_model:''}});
  x.click('[data-nav=agents]');
  const box=()=>x.d.querySelector('#pips_model');
  assert.equal(box().disabled,false);
  assert.equal(box().value,'');
  assert.equal(box().placeholder,'Same as DGC (original)','blank follows DGC, and says what that is now');
  assert.match(box().closest('.field').textContent,/Every Pip set to Default uses it/);
  // It lists DGC's main connection, which Pips use: the same host the Models page lists.
  const ask=asks(x).filter(m=>m.token.startsWith('pips_model-')).at(-1);
  assert.deepEqual([ask.role,ask.base_url,ask.api_mode],['main','https://model.example/v1','ollama']);
  answer(x,ask,{ids:['glm-5.3:cloud','original']});
  openList(x,'pips_model');
  assert.deepEqual(optionsOf(x,'pips_model'),['glm-5.3:cloud','original']);
  x.d.querySelector('#pips_model-list [data-model="glm-5.3:cloud"]').dispatchEvent(new x.w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  x.click('#save');
  assert.equal(x.sent.filter(m=>m.type==='saveSettings').pop().values.pips_model,'glm-5.3:cloud');
  x.message({type:'settingsSaved',ok:true});
  x.message({type:'event',event:{...x.config,list_models_at:true,pips_settable:true,pips_model:'glm-5.3:cloud'}});
  assert.equal(box().value,'glm-5.3:cloud');
  // DGC on a subscription: blank follows that CLI.
  x.message({type:'event',event:{...x.config,subscription_engine:'codex',pips_settable:true,pips_model:''}});
  assert.equal(box().placeholder,'Same as DGC (Codex)');
});

test('Agents: sub-agents Run at once takes up to 32 and says plainly what more costs',()=>{
  // It was General's "Parallel sub-agents"; the direction puts it with the sub-agents it counts.
  const x=setup();
  x.click('[data-nav=general]');
  assert.equal(x.d.querySelector('#max_parallel_tasks'),null,'one place for it');
  x.click('[data-nav=agents]');
  const box=x.d.querySelector('#max_parallel_tasks');
  assert.equal(box.closest('.group').querySelector('h3').textContent,'Sub-agents');
  assert.equal([box.min,box.max,box.step].join(' '),'1 32 1');
  // One line; what more costs is behind its "?".
  assert.equal(rowHint(box),'Up to 32. Ultra runs 8 unless you set one.');
  const more=rowDetail(box);
  assert.match(more,/its own copy of the project/);
  assert.match(more,/cloud APIs rate-limit/);
  assert.match(more,/OLLAMA_NUM_PARALLEL at once while the rest wait/);
  const saves=()=>x.sent.filter(m=>m.type==='saveSettings');
  x.input('#max_parallel_tasks','33');
  x.click('#save');
  assert.equal(saves().length,0,'33 is refused on the page');
  x.input('#max_parallel_tasks','32');
  x.click('#save');
  assert.equal(saves().at(-1).values.max_parallel_tasks,'32');
  x.message({type:'settingsSaved',ok:true});
  // Under Ultra: what it runs, and that a chosen number (wider than Ultra's 8 too) is kept.
  x.message({type:'event',event:{...x.config,ultra_mode:true,max_parallel_tasks:4}});
  assert.match(rowSaid(x.d.querySelector('#max_parallel_tasks')),/^Ultra is on, so 8 run\. Set any other number, up to 32, to pin it/);
  x.message({type:'event',event:{...x.config,ultra_mode:true,max_parallel_tasks:20}});
  assert.match(rowSaid(x.d.querySelector('#max_parallel_tasks')),/^Pinned here; Ultra would run 8\. Set 4 to let Ultra choose/);
});

test('Models and Agents: every setting still reachable, detail one click away',()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,list_models_at:true,cache_settable:true,subagent_context_size:0,pips_settable:true,pips_model:''}});
  x.click('[data-nav=models]');
  for(const id of ['base_url','provider','api_key','model','subscription_engine','subscription_model','subscription_effort','prompt_cache','api_mode','provider_state','prompt_cache_ttl','capability_cache_ttl_s'])
    assert.ok(x.d.querySelector('#'+id),`Models still has ${id}`);
  const advanced=x.d.querySelector('details[data-more=models-advanced]');
  assert.equal(advanced.open,false,'Advanced starts closed');
  for(const id of ['api_mode','provider_state','capability_cache_ttl_s','prompt_cache_ttl'])
    assert.ok(advanced.contains(x.d.querySelector('#'+id)),`${id} is under Advanced for a host that isn't Anthropic`);
  // A subscription's model and effort show only when one is on.
  const subs=x.d.querySelector('[data-when-engine]');
  assert.equal(subs.hidden,true);
  const engine=x.d.querySelector('#subscription_engine');
  engine.value='codex';engine.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(subs.hidden,false);
  // Advanced stays open through a redraw (a config reply re-renders the page).
  advanced.open=true;advanced.dispatchEvent(new x.w.Event('toggle'));
  x.message({type:'event',event:{...x.config,list_models_at:true,cache_settable:true}});
  assert.equal(x.d.querySelector('details[data-more=models-advanced]').open,true);
  // An Anthropic host: its cache lifetime is a Cache row, not Advanced.
  x.message({type:'event',event:{...x.config,base_url:'https://api.anthropic.com/v1',cache_settable:true}});
  assert.equal(x.d.querySelector('details[data-more=models-advanced]').contains(x.d.querySelector('#prompt_cache_ttl')),false);
  // A preset fills the host and goes back to reading "Presets".
  x.message({type:'providers',providers:[{id:'ollama',label:'Ollama (local)',url:'http://127.0.0.1:11434/v1'}]});
  const preset=x.d.querySelector('#provider');
  preset.value='ollama';preset.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(x.d.querySelector('#base_url').value,'http://127.0.0.1:11434/v1');
  assert.equal(preset.value,'');
  assert.equal(preset.selectedOptions[0].textContent,'Presets');

  x.click('[data-nav=agents]');
  for(const id of ['subagent_model','max_parallel_tasks','subagent_context_size','subagent_provider','subagent_base_url','subagent_api_mode','subagent_api_key','fallback_model','fallback_base_url','fallback_api_mode','fallback_api_key','pips_model'])
    assert.ok(x.d.querySelector('#'+id),`Agents still has ${id}`);
  // The sub-agents' own host is here (it is set); the fallback has none, so its host waits one click away.
  const subHost=x.d.querySelector('details[data-more=subagent-host]'),fbHost=x.d.querySelector('details[data-more=fallback-host]');
  assert.equal(subHost.open,true);
  assert.match(subHost.querySelector('summary').textContent,/Another host · agent\.example/);
  assert.equal(fbHost.open,false);
  assert.equal(x.d.querySelector('#fallback_base_url').placeholder,'Same as the main host');
  assert.equal(x.d.querySelector('#subagent_model').placeholder,'Same as the main model');
  assert.equal(x.d.querySelector('#fallback_model').placeholder,'None');
  assert.equal(rowHint(x.d.querySelector('#fallback_model')),'Tried when the main model fails.');
  // Save stays in a bar of its own, and still saves every page's edits.
  assert.ok(x.d.querySelector('.save-bar #save'));
  x.input('#fallback_model','backup-2');
  x.click('#save');
  const saved=x.sent.filter(m=>m.type==='saveSettings').pop().values;
  assert.equal(saved.fallback_model,'backup-2');
  assert.equal(saved.base_url,'http://127.0.0.1:11434/v1','the Models page\'s edit goes with it');
  x.click('[data-nav=security]');
  assert.ok(x.d.querySelector('.save-bar #save'),'and every settings page has the same one Save');
});

// ---- Settings everywhere (24 Oct 2026): one-line hints, "?" for the rest, one Save, plain words, safe danger ----
test('a hint is one line and the rest is behind "?": open, remembered through a redraw, closed again',()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,turn_token_budget:0}});
  x.click('[data-nav=agents]');
  const box=x.d.querySelector('#max_parallel_tasks');
  const info=box.closest('.field').querySelector('.info');
  assert.ok(info,'a "?" beside Run at once');
  assert.equal(info.getAttribute('aria-expanded'),'false');
  assert.equal(box.closest('.field').querySelector('.detail').hidden,true,'the detail waits one click away');
  assert.equal(x.d.querySelector(`label[for="max_parallel_tasks"]`).textContent,'Run at once','a real label for the box');
  info.click();
  assert.equal(info.getAttribute('aria-expanded'),'true');
  assert.equal(box.closest('.field').querySelector('.detail').hidden,false);
  x.message({type:'event',event:{...x.config,turn_token_budget:0}});
  assert.equal(x.d.querySelector('#max_parallel_tasks').closest('.field').querySelector('.detail').hidden,false,'still open after a redraw');
  x.d.querySelector('#max_parallel_tasks').closest('.field').querySelector('.info').click();
  assert.equal(x.d.querySelector('#max_parallel_tasks').closest('.field').querySelector('.detail').hidden,true);
  // A page's long intro is behind its own "?" too.
  x.click('[data-nav=running]');
  const page=x.d.querySelector('#page .sub .info');
  assert.ok(page);assert.equal(x.d.querySelector('#page-running-detail').hidden,true);
  page.click();assert.equal(x.d.querySelector('#page-running-detail').hidden,false);
  assert.match(x.d.querySelector('#page-running-detail').textContent,/after 12 hours at most/);
});

test('one Save for every page: it says so, and names the pages with unsaved changes',()=>{
  const x=setup();
  x.click('[data-nav=models]');
  const save=()=>x.d.querySelector('#save');
  assert.equal(save().textContent,'Save all');
  assert.match(save().title,/every page/);
  assert.equal(x.d.querySelector('#save-status').textContent,'','nothing changed yet');
  x.input('#model','edited');
  assert.equal(x.d.querySelector('#save-status').textContent,'Unsaved changes on Models');
  // The sandbox is on in this config, so its network switch is live.
  x.click('[data-nav=security]');x.click('#sandbox_network');
  x.click('[data-nav=general]');
  assert.equal(x.d.querySelector('#save-status').textContent,'Unsaved changes on Models and Security','said on every page');
  x.click('#save');
  const values=x.sent.filter(m=>m.type==='saveSettings').pop().values;
  assert.equal(values.model,'edited','one Save carries every page\'s change');
  x.message({type:'settingsSaved',ok:true});
  assert.equal(x.d.querySelector('#save-status').textContent,'Saved');
});

test('a narrow tab picks pages by name: the page picker lists every page and follows navigation',()=>{
  const x=setup();
  const picker=x.d.querySelector('#page-picker');
  assert.ok(picker,'the picker is there (CSS shows it in place of the side list below 620px)');
  assert.deepEqual([...picker.options].map(o=>o.textContent),[...x.d.querySelectorAll('[data-nav]')].map(b=>b.textContent));
  picker.value='voice';picker.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(x.d.querySelector('#page>h2').textContent,'Voice');
  x.click('[data-nav=mcp]');
  assert.equal(picker.value,'mcp');
  assert.equal(x.sent.at(-1).type,'listMcp');
});

test('Security: plain words, and the sandbox\'s network switch is off while the sandbox is',()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,sandbox:false,sandbox_network:false}});
  x.click('[data-nav=security]');
  for(const jargon of [/OS sandbox/,/Loopback only\./,/Broadens the read-only plan surface/]) assert.doesNotMatch(x.d.querySelector('#page').textContent.replace(/\(loopback\)/,''),jargon);
  assert.equal(x.d.querySelector('label[for=sandbox]').textContent,'Run commands in a sandbox');
  const net=()=>x.d.querySelector('#sandbox_network');
  assert.equal(net().disabled,true,'the network switch means nothing without the sandbox');
  assert.equal(rowHint(net()),'Only with the sandbox on.');
});

test('Security: turning the sandbox on wakes its network switch',async()=>{
  const x=setup();
  x.message({type:'event',event:{...x.config,sandbox:false,sandbox_network:false}});
  x.click('[data-nav=security]');
  x.click('#sandbox');
  await Promise.resolve();
  assert.equal(x.d.querySelector('#sandbox_network').disabled,false);
  x.click('#sandbox_network');
  x.click('#save');
  const values=x.sent.filter(m=>m.type==='saveSettings').pop().values;
  assert.deepEqual([values.sandbox,values.sandbox_network],[true,true]);
});

test('MCP form: plain words, sign-in details and logging under Advanced, and nothing destructive without a confirm',()=>{
  const x=setup();
  x.message({type:'event',event:{type:'mcp_servers',items:[{name:'local',command:'node',args:['server.js'],enabled:true,state:'configured',transport:'stdio'}]}});
  x.click('[data-nav=mcp]');
  x.click('[data-mcp-edit=local]');
  const text=x.d.querySelector('#page').textContent;
  for(const jargon of [/Local STDIO/,/SecretStorage/,/No shell parsing/,/Clear stored credentials/]) assert.doesNotMatch(text,jargon);
  assert.deepEqual([...x.d.querySelectorAll('#mcp-transport option')].map(o=>[o.value,o.textContent]),[['stdio','A command on this computer'],['remote','A URL']]);
  assert.equal(x.d.querySelector('#mcp-clear'),null,'no destructive checkbox beside everyday fields');
  const advanced=x.d.querySelector('.mcp-advanced');
  assert.ok(advanced.contains(x.d.querySelector('#mcp-log')) && advanced.contains(x.d.querySelector('#oauth-app')),'logging and your own sign-in app are Advanced');
  assert.deepEqual([...x.d.querySelectorAll('#mcp-log option')].map(o=>o.value),['warning','info','debug','error','off'],'the values the host takes');
  // Forget saved sign-in: asks first; Keep them sends nothing; Forget them saves with the saved sign-in cleared.
  const before=x.sent.length;
  x.input('#mcp-args','server.js\n--verbose');
  x.click('#mcp-forget');
  assert.equal(x.sent.length,before,'a click alone sends nothing');
  assert.match(x.d.querySelector('[role=alertdialog]').textContent,/Forget the token, keys and sign-in saved for local\?/);
  x.click('#mcp-confirm-no');
  assert.equal(x.d.querySelector('[role=alertdialog]'),null);
  assert.equal(x.sent.length,before);
  assert.equal(x.d.querySelector('#mcp-args').value,'server.js\n--verbose','the confirm never redrew the form');
  x.click('#mcp-forget');x.click('#mcp-forget-yes');
  const saved=x.sent.at(-1);
  assert.equal(saved.type,'mcpSave');
  assert.equal(saved.values.clear_secrets,true);
  assert.equal(saved.values.args,'server.js\n--verbose','with what the form holds');
  // An ordinary Save and connect never clears it.
  x.d.querySelector('#mcp-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
  assert.equal(x.sent.at(-1).values.clear_secrets,false);
  // Remove server: asks first, too.
  const n=x.sent.length;
  x.click('#mcp-remove');
  assert.equal(x.sent.length,n);
  x.click('#mcp-remove-yes');
  assert.deepEqual({...x.sent.at(-1)},{type:'mcpRemove',name:'local'});
  // A new server has nothing saved to forget or remove.
  x.click('[data-nav=mcp]');x.click('#add-mcp');
  assert.equal(x.d.querySelector('.danger-zone'),null);
});

test('a plugin\'s page: no maintainers\' notes, no "Not provided" rows; directory cards without package jargon',()=>{
  const x=setup();
  const noted={...plugin,verification:'DGC browser handoff verified. A user confirmed Figma connection.',audited_on:'2026-09-23',requirements:'An account.',license:'MIT',developer:'',version:''};
  x.message({type:'plugins',items:[noted]});
  x.click('[data-nav=plugins]');x.click('[data-open=fixture]');
  const text=x.d.querySelector('#page').textContent;
  assert.doesNotMatch(text,/A user confirmed|Checked 2026|handoff verified/,'an older CLI may still send them: never printed');
  assert.match(text,/An account\./,'what a user needs to know stays');
  assert.doesNotMatch(x.d.querySelector('.meta').textContent,/Not provided/);
  assert.match(x.d.querySelector('.meta').textContent,/License/);
  x.click('#back');x.click('#browse-directory');
  assert.doesNotMatch(x.d.querySelector('.directory-card-footer').textContent,/dgc-curated|MIT|License/);
});
