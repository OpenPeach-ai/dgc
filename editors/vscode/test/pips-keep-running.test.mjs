// Keep Pips running in the Pips view (API 41): one switch beside the runner, worded from the
// backend's own status, and never offered where it cannot work.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const model=load(await bundle('pipsModel.js')),viewCode=await bundle('pipsView.ts');
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const workspace={id:'ws_'+'1'.repeat(32),name:'Project'};
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id,role:id,description:'Read committed source',available:['rook','scout','lens','lock'].includes(id),unavailable_reason:['rook','scout','lens','lock'].includes(id)?null:'Planned',default_name:id,default_goal:'Review',engine:['rook','scout','lens','lock'].includes(id)?'source_audit':null}));
const status=(extra={})=>({platform:'linux',supported:true,reason:'',on:false,starts_at_login:false,restarts_after_failure:false,while_logged_out:false,...extra});
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({api=41,host='editor',keep=status()}={}){
 const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);const sent=[],answered=new Set();let listener;
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.setInterval=()=>1;w.eval(client);
 w.DgcPips.mount({root:w.document,host,postMessage:m=>sent.push(m),onMessage:fn=>{listener=fn;},onSetupPrompt:()=>true});
 const answer=(m,result,ok=true)=>{answered.add(m.id);listener({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces:[workspace],current_workspace_id:workspace.id}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:[]}),get_pip_runner:()=>({runner:{runner_id:'r',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}}}),get_workspace_context:()=>({context:{workspace_id:workspace.id,revision:0,entries:[]}}),list_pip_starters:()=>({starters:[]}),get_pips_keep_running:()=>({keep_running:keep})}[r.type]?.());
 async function drain(overrides={}){for(let n=0;n<15;n++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answer(m,result);count++;}}if(!count)break;}await flush();}
 listener({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const change=(checked)=>{const box=w.document.getElementById('keep-running');box.checked=checked;box.dispatchEvent(new w.Event('change',{bubbles:true}));};
 return {w,d:w.document,sent,answer,requests,drain,change};
}

test('the switch shows the backend state and asks once', async()=>{
 const x=setup({keep:status()});await x.drain();
 assert.equal(x.requests('get_pips_keep_running').length,1);
 const box=x.d.getElementById('keep-running');assert.ok(box);assert.equal(box.checked,false);
 assert.match(x.d.body.textContent,/Off: Pips run only while a runner you started is running/);
 await x.drain();assert.equal(x.requests('get_pips_keep_running').length,1,'not on every render');
});

test('turning it on sends exactly that, and the reply decides what it says', async()=>{
 const x=setup();await x.drain();
 x.change(true);
 const sent=x.requests('set_pips_keep_running')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(sent.request)),{type:'set_pips_keep_running',enabled:true});
 x.answer(sent,{keep_running:status({on:true,starts_at_login:true,restarts_after_failure:true,while_logged_out:true})});await x.drain();
 assert.equal(x.d.getElementById('keep-running').checked,true);
 assert.match(x.d.body.textContent,/runs while you are logged out/);
 x.change(false);
 assert.equal(x.requests('set_pips_keep_running')[1].request.enabled,false);
 x.answer(x.requests('set_pips_keep_running')[1],{keep_running:status()});await x.drain();
 assert.match(x.d.body.textContent,/The runner running now keeps going until you stop it/);
});

test('where it cannot work it says why instead of offering a switch', async()=>{
 const x=setup({keep:status({platform:'win32',supported:false,reason:'Keeping Pips running is available on Linux and macOS.'})});await x.drain();
 assert.equal(x.d.getElementById('keep-running'),null);
 assert.match(x.d.body.textContent,/available on Linux and macOS/);
});

test('a malformed status is refused, an older CLI and the Remote are never asked', async()=>{
 const x=setup({keep:{...status(),extra:1}});await x.drain();
 assert.equal(x.d.getElementById('keep-running'),null);
 assert.match(x.d.body.textContent,/keep-running status is invalid/);
 for(const options of [{api:40},{host:'remote'}]){const y=setup(options);await y.drain();assert.equal(y.requests('get_pips_keep_running').length,0,JSON.stringify(options));}
 assert.throws(()=>model.pipsKeepRunning(status({supported:false,on:true,reason:'x'})),/invalid/,'unsupported is never on');
});

test('the extension host passes the switch only to an API 41 CLI', ()=>{
 for(const api of [40,41]){const posted=[],sent=[];const {PipsEditor}=load(viewCode,name=>name==='vscode'?{}:require(name));const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  bridge.receive({type:'pipsRequest',id:'g',request:{type:'get_pips_keep_running'}});bridge.receive({type:'pipsRequest',id:'s',request:{type:'set_pips_keep_running',enabled:true}});
  assert.equal(sent.length,api>=41?2:0,`API ${api}`);}
});

test('a host read goes to the backend and its reply never reaches a webview', async()=>{
 const sent=[],posted=[];const {PipsEditor}=load(viewCode,name=>name==='vscode'?{}:require(name));
 const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));
 bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:40},{});
 await assert.rejects(bridge.hostRead('get_pip_digest'));assert.equal(sent.length,0,'an older CLI is never asked');
 bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:41},{other:1});
 const reading=bridge.hostRead('get_pip_digest');
 assert.equal(sent.length,1);assert.equal(sent[0].type,'pips_control');assert.equal(sent[0].request.type,'get_pip_digest');assert.match(sent[0].request.request_id,/^pips-host-/);
 const before=posted.length;
 assert.equal(bridge.event({type:'pips_result',request_id:sent[0].request.request_id,command:'get_pip_digest',ok:true,result:{digest:null}}),true);
 assert.deepEqual(await reading,{digest:null});assert.equal(posted.length,before,'nothing is posted to a webview');
});

test('the desktop notifications switch says when this computer cannot show them', async()=>{
 const off=(extra={})=>({on:true,available:true,platform:'linux',last:null,...extra});
 const x=setup();await x.drain({get_pips_desktop_notifications:()=>({desktop_notifications:off({last:{shown:false,at:'2026-10-05T01:00:00.000Z'}})})});
 const box=x.d.getElementById('desktop-notifications');assert.ok(box);assert.equal(box.checked,true);
 assert.match(x.d.body.textContent,/The last one did not show/);
 box.checked=false;box.dispatchEvent(new x.w.Event('change',{bubbles:true}));
 const sent=x.requests('set_pips_desktop_notifications')[0];assert.equal(sent.request.enabled,false);
 x.answer(sent,{desktop_notifications:off({on:false})});await x.drain();
 assert.match(x.d.body.textContent,/The editor still tells you while it is open/);
 assert.throws(()=>model.pipsDesktopNotifications(off({last:{shown:'no',at:'x'}})),/invalid/);
});

test('a current CLI that cannot run Pips here says why, not "update"', async()=>{
 const make=(api)=>{const dom=new JSDOM('<main id="app"></main><div id="review-root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);let listener;
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.setInterval=()=>1;w.eval(client);
  w.DgcPips.mount({root:w.document,host:'editor',postMessage:()=>{},onMessage:fn=>{listener=fn;},onSetupPrompt:()=>true});
  listener({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:false,enabled:true});return w.document;};
 const windowsHost=make(41);await flush();
 assert.match(windowsHost.body.textContent,/Pips run on Linux and macOS/);assert.doesNotMatch(windowsHost.body.textContent,/Update the DGC CLI/);
 const old=make(8);await flush();assert.match(old.body.textContent,/Update the DGC CLI to use Pips/);
});

test('sharing: export opens the file for Save As, import reads the picked file and never more than 24 KiB', async()=>{
 const calls=[];let picked=[{path:'/home/u/brief.pip.json'}],bytes=new TextEncoder().encode('{"format":"dgc-pip"}');
 const vs={window:{showOpenDialog:async()=>picked,showTextDocument:async(d)=>calls.push(['show',d.language])},
  workspace:{fs:{readFile:async()=>bytes},openTextDocument:async(o)=>{calls.push(['open',o.language,o.content]);return {...o,uri:'untitled:x'};}},
  commands:{executeCommand:async(...a)=>calls.push(['command',a[0]])},ViewColumn:{Active:1},Uri:{joinPath:()=>''}};
 const sent=[],posted=[];const {PipsEditor}=load(viewCode,name=>name==='vscode'?vs:require(name));
 const bridge=new PipsEditor({},m=>{sent.push(m);return true;},()=>{});bridge.attach(m=>posted.push(m));
 bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:40},{});
 bridge.receive({type:'pipsRequest',id:'e0',request:{type:'export_pip_file',pip_id:'pip_1'}});
 assert.match(posted.at(-1).error.message,/API 41/);
 bridge.ready({pips_supported:true,pips_enabled:true,pips_api_version:41},{b:1});
 bridge.receive({type:'pipsRequest',id:'e1',request:{type:'export_pip_file',pip_id:'pip_1'}});
 const exp=sent.at(-1);assert.deepEqual([exp.type,exp.request.type,exp.request.pip_id],['pips_control','export_pip','pip_1']);
 bridge.event({type:'pips_result',request_id:exp.request.request_id,command:'export_pip',ok:true,result:{text:'{"format":"dgc-pip"}\n',document:{left_out:['Memory stays.']}}});
 await flush();await flush();
 assert.deepEqual(calls.map(c=>c[0]+':'+c[1]),['open:json','show:json','command:workbench.action.files.saveAs']);
 assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))),{type:'pipsReply',id:'e1',ok:true,result:{opened:true,left_out:['Memory stays.']}});
 bridge.receive({type:'pipsRequest',id:'i1',request:{type:'import_pip_file'}});await flush();await flush();
 const imp=sent.at(-1);assert.deepEqual([imp.request.type,imp.request.document],['import_pip_document','{"format":"dgc-pip"}']);
 bridge.event({type:'pips_result',request_id:imp.request.request_id,command:'import_pip_document',ok:true,result:{setup:{id:'s'},left_out:[]}});
 assert.equal(posted.at(-1).id,'i1');assert.equal(posted.at(-1).ok,true);
 picked=undefined;bridge.receive({type:'pipsRequest',id:'i2',request:{type:'import_pip_file'}});await flush();await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1).result)),{cancelled:true},'cancelling sends nothing');
 picked=[{path:'/big.json'}];bytes=new Uint8Array(24577);const before=sent.length;
 bridge.receive({type:'pipsRequest',id:'i3',request:{type:'import_pip_file'}});await flush();await flush();
 assert.equal(sent.length,before);assert.match(posted.at(-1).error.message,/at most 24 KiB/);
});
