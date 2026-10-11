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
test('Apps and MCPs show their declared entries, not duplicate package titles',()=>{const x=setup();x.message({type:'plugins',items:[plugin]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');assert.equal(x.d.querySelector('#plugin-list strong').textContent,'Declared service');assert.match(x.d.querySelector('#plugin-list').textContent,/Uses MCP/);x.click('[data-lane=mcp]');assert.equal(x.d.querySelector('h1').textContent,'MCP servers');assert.equal(x.sent.at(-1).type,'listMcp');});
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
 assert.equal(x.d.querySelectorAll('.directory-card').length,1);assert.equal(x.d.querySelector('#show-unavailable'),null);assert.equal(x.d.querySelector('[data-open=figma]'),null);assert.match(x.d.querySelector('.directory-status').textContent,/1 of 1/);
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
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelectorAll('[data-mcp-toggle]').length,1);assert.equal(x.d.querySelector('[data-mcp-toggle="linear--remote"]'),null);assert.equal(x.d.querySelector('[data-lane=mcp]').textContent,'MCPs 1');
 x.click('[data-nav=plugins]');x.click('[data-open=linear]');assert.ok(x.d.querySelector('.plugin-connections'));x.click('[data-mcp-toggle="linear--remote"]');assert.equal(x.sent.at(-1).type,'mcpToggle');assert.equal(x.sent.at(-1).name,'linear--remote');
 x.click('[data-mcp-edit="linear--remote"]');assert.equal(x.d.querySelector('#mcp-back').textContent,'Linear');assert.equal(x.d.querySelector('#mcp-target').value,'https://mcp.linear.app/mcp');
 x.click('#mcp-reconnect');assert.equal(x.sent.at(-1).type,'mcpReconnect');x.click('#mcp-cancel');assert.equal(x.d.querySelector('h1').textContent,'Linear');
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelector('[data-mcp-toggle="linear--remote"]'),null);
});
test('plugin-only MCP connections leave a truthful empty manual-server list',()=>{
 const x=setup();x.message({type:'plugins',items:[{...composioPlugin,installed:true,connected:true,server_names:['composio']}]});x.message({type:'event',event:{type:'mcp_servers',items:[{name:'composio',state:'connected'}]}});
 x.click('[data-nav=mcp]');assert.equal(x.d.querySelectorAll('[data-mcp-toggle]').length,0);assert.match(x.d.body.textContent,/No servers added manually/);assert.equal(x.d.querySelector('[data-lane=mcp]').textContent,'MCPs 0');
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
test('Apps offers named provider marks and routes each to its own setup',()=>{
 const x=setup();x.message({type:'plugins',items:[...connectorRows,{name:'composio',display_name:'Composio',apps:[],skills:[]}]});x.click('[data-nav=plugins]');x.click('[data-lane=apps]');
 for(const row of connectorRows){
  const card=x.d.querySelector(`[aria-label="${row.display_name} connector"]`);assert.ok(card);assert.ok(card.querySelector('img.logo').src.startsWith('data:'));
  x.click(`[data-connector-setup=${row.name}]`);assert.ok(x.d.querySelector('.connection-art img[alt=DGC]'));assert.ok(x.d.querySelector(`.connection-art img[alt="${row.display_name}"]`));
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
 x.click('[data-lane=mcp]');assert.equal(x.d.querySelector('[data-mcp-edit=n8n]'),null);
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
  assert.equal(x.d.querySelector('#save').disabled,true,'nothing to save into');
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

test('ChatDGC: a personality and custom instructions, saved for every chat; hidden from a CLI that cannot take them',()=>{
  const x=setup();
  x.click('[data-nav=chatdgc]');
  assert.match(x.d.querySelector('#page').textContent,/Update the DGC CLI/);
  assert.equal(x.d.querySelector('#save').disabled,true);
  assert.equal(x.d.querySelector('#chatdgc_about').disabled,true);
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
  assert.equal(x.sent.at(-1).type, 'getMemory');
  assert.match(x.d.body.textContent, /Reading what DGC remembers/);
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
  x.click('[data-nav=web]');
  const on = x.d.querySelector('#chatdgc_web');
  assert.equal(on.getAttribute('aria-checked'), 'true', 'on unless you turn it off');
  assert.match(x.d.body.textContent, /Off: ChatDGC never goes online/);
  x.click('#chatdgc_web');
  x.click('#save');
  assert.equal(x.sent.at(-1).type, 'saveSettings');
  assert.equal(x.sent.at(-1).values.chatdgc_web, false);
});

test('ChatDGC: follow-ups under a reply, on unless this switch turns them off, saved with the page', () => {
  const x = setup();
  x.message({ type: 'event', event: { ...x.config, chatdgc_settable: true, chatdgc_personality: 'default', chatdgc_window: '32k', chatdgc_followups: true } });
  x.click('[data-nav=chatdgc]');
  const on = x.d.querySelector('#chatdgc_followups');
  assert.ok(on, 'the switch is on the ChatDGC page');
  assert.equal(on.getAttribute('aria-checked'), 'true');
  assert.match(x.d.body.textContent, /A few next questions under a reply, as ChatGPT shows them\. Click one to send it\./);
  x.click('#chatdgc_followups');
  x.click('#save');
  assert.equal(x.sent.at(-1).type, 'saveSettings');
  assert.equal(x.sent.at(-1).values.chatdgc_followups, false);
  const y = setup();
  y.message({ type: 'event', event: { ...y.config, chatdgc_settable: false } });
  y.click('[data-nav=chatdgc]');
  assert.equal(y.d.querySelector('#chatdgc_followups').disabled, true, 'an older CLI: shown, not changeable');
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
