// pips-09: Settings → MCP servers → Add server has "Paste a link or a claude mcp add command". Pasting (or Fill) reads
// what was pasted in the page (src/mcpPaste.js, tested by mcp-paste.test.mjs) and fills the fields below: name, how it
// connects, URL or command, arguments, environment, and a token into the password field. It says what it read, its note
// or why it couldn't, in words. Nothing is saved until Save and connect, and what was pasted never leaves the page as is.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
const src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'settingsClient.js'],bundle:true,write:false,loader:{'.css':'empty','.ico':'dataurl','.png':'dataurl','.svg':'dataurl'},format:'iife'})).outputFiles[0].text;
const view=await build({entryPoints:[src+'settingsView.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const module={exports:{}};new Function('module','exports',view.outputFiles[0].text)(module,module.exports);
const windows=[];after(()=>windows.forEach(w=>w.close()));
function setup(){
 const dom=new JSDOM(module.exports.settingsDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const {window:w}=dom;windows.push(w);const sent=[];
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m)});w.eval(code);
 const message=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m}));
 message({type:'event',event:{type:'config',base_url:'https://model.example/v1',model:'original',mode:'default',think:'high',context_size:65536}});
 const d=w.document,$=s=>d.querySelector(s);
 const fields=()=>({name:$('#mcp-name').value,transport:$('#mcp-transport').value,target:$('#mcp-target').value,args:$('#mcp-args').value,env:$('#mcp-env').value,token:$('#mcp-token').value});
 // A paste, as a browser does it: the text lands in the box, then the page hears "paste".
 const paste=async text=>{const box=$('#mcp-paste');box.value=text;box.dispatchEvent(new w.Event('paste',{bubbles:true}));await new Promise(r=>w.setTimeout(r,5));};
 return {w,d,$,sent,message,fields,paste,click:s=>$(s).click(),says:()=>$('#mcp-paste-says'),
  add:()=>{$('[data-nav=mcp]').click();$('#add-mcp').click();}};
}
const SERVER={name:'local-files',enabled:true,state:'connected',transport:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-filesystem'],tool_count:12};

test('Add server has the paste box at the top of the form; a server being changed has none',()=>{
 const x=setup();x.add();
 const box=x.$('#mcp-paste');assert.ok(box,'the box');
 assert.equal(x.$('#mcp-form').firstElementChild,box.closest('.mcp-paste'),'at the top of the form');
 assert.match(x.$('label[for=mcp-paste]').textContent,/^Paste a link or a claude mcp add command/);
 assert.match(x.$('label[for=mcp-paste]').textContent,/Nothing is saved until you choose Save and connect/);
 assert.equal(x.$('#mcp-paste-fill').textContent,'Fill');assert.equal(x.$('#mcp-paste-fill').type,'button','Fill never submits the form');
 assert.equal(x.says().hidden,true);assert.equal(box.getAttribute('name'),null,'the box is no field of the server');
 const y=setup();y.message({type:'event',event:{type:'mcp_servers',items:[SERVER]}});y.$('[data-nav=mcp]').click();y.$('[data-mcp-edit="local-files"]').click();
 assert.ok(y.$('#mcp-form'),'its form');assert.equal(y.$('#mcp-paste'),null);
});

test('pasting a claude mcp add command for a URL fills the form, its token into the password field, and saves nothing',async()=>{
 const x=setup();x.add();const before=x.sent.length;
 await x.paste('claude mcp add --transport http notion https://mcp.notion.com/mcp --header "Authorization: Bearer ntn_secret_123" -H "X-Team: red"');
 assert.deepEqual(x.fields(),{name:'notion',transport:'remote',target:'https://mcp.notion.com/mcp',args:'',env:'',token:'ntn_secret_123'});
 assert.equal(x.$('#mcp-token').type,'password');
 assert.equal(x.$('#mcp-target-label').textContent,'Server URL');assert.equal(x.$('#token-label').hidden,false);assert.equal(x.$('#args-label').hidden,true,'the fields a URL has');
 const says=x.says();assert.equal(says.hidden,false);assert.equal(says.getAttribute('role'),'status');assert.equal(says.classList.contains('error'),false);
 assert.match(says.textContent,/^Filled in below: notion, a URL\. Its token is in the Token field\. DGC keeps only a bearer token; X-Team was left out\. Check it, then choose Save and connect\.$/);
 assert.equal(x.$('#mcp-paste').value,'','a token that was pasted does not stay in sight');
 assert.equal(x.sent.length,before,'nothing is saved, tested or sent by a paste');
 // Save and connect is what saves (and tests) it: the fields, never the pasted text.
 x.$('#mcp-form').dispatchEvent(new x.w.Event('submit',{cancelable:true}));
 const save=x.sent.at(-1);assert.equal(save.type,'mcpSave');
 assert.deepEqual({name:save.values.name,transport:save.values.transport,target:save.values.target,token:save.values.token,original_name:save.values.original_name},
  {name:'notion',transport:'remote',target:'https://mcp.notion.com/mcp',token:'ntn_secret_123',original_name:''});
 assert.equal(JSON.stringify(x.sent).includes('claude mcp add'),false,'what was pasted never goes to DGC as is');
 assert.equal(JSON.stringify(x.sent).includes('X-Team'),false);
});

test('Fill reads a command that starts a server: its command, arguments one per line and environment; a plain link; and a server’s JSON',async()=>{
 const x=setup();x.add();
 x.$('#mcp-paste').value='claude mcp add airtable --env AIRTABLE_API_KEY=pat123 --scope user -- npx -y airtable-mcp-server "My Base"';
 assert.deepEqual(x.fields().target,'','typing fills nothing until Fill');
 x.click('#mcp-paste-fill');
 assert.deepEqual(x.fields(),{name:'airtable',transport:'stdio',target:'npx',args:'-y\nairtable-mcp-server\nMy Base',env:'AIRTABLE_API_KEY=pat123',token:''});
 assert.equal(x.$('#args-label').hidden,false);assert.equal(x.$('#token-label').hidden,true,'the fields a command has');assert.equal(x.$('#mcp-target-label').textContent,'Command');
 assert.match(x.says().textContent,/^Filled in below: airtable, a command on this computer\. Its keys are under Environment\. Check it/);
 assert.equal(x.$('#mcp-paste').value,'','a key that was pasted does not stay in sight either');
 // A link alone: its name from the address; nothing secret, so what was pasted stays to be read.
 await x.paste('https://mcp.linear.app/sse');
 assert.deepEqual(x.fields(),{name:'linear',transport:'remote',target:'https://mcp.linear.app/sse',args:'',env:'',token:''},'a second paste replaces the first, whole');
 assert.equal(x.$('#mcp-paste').value,'https://mcp.linear.app/sse');
 assert.match(x.says().textContent,/^Filled in below: linear, a URL\. Check it, then choose Save and connect\.$/);
 // The JSON other apps share.
 x.$('#mcp-paste').value='{"mcpServers":{"files":{"command":"/usr/local/bin/files-mcp","args":["--root","/home/me/notes"]}}}';
 x.$('#mcp-paste').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
 assert.deepEqual(x.fields(),{name:'files',transport:'stdio',target:'/usr/local/bin/files-mcp',args:'--root\n/home/me/notes',env:'',token:''},'Ctrl+Enter fills too');
 assert.equal(x.sent.filter(m=>m.type==='mcpSave').length,0);
});

test('what can’t be read is said in words beside the box, and the fields keep what they had',async()=>{
 const x=setup();x.add();
 x.$('#mcp-name').value='mine';x.$('#mcp-target').value='my-server';
 for(const [text,why] of [['',/^Paste a server URL or a claude mcp add command\.$/],['npm install something',/^Paste a server URL, a claude mcp add command, or a server's JSON\.$/],
  ['claude mcp add "notion',/^A quote in what you pasted is never closed\.$/],['claude mcp add --frobnicate x y',/^DGC doesn't know --frobnicate in a claude mcp add command\.$/],['{"mcpServers":',/^That looks like JSON but it couldn't be read\.$/]]){
  await x.paste(text);
  assert.match(x.says().textContent,why,text);assert.equal(x.says().hidden,false);assert.equal(x.says().getAttribute('role'),'alert');assert.ok(x.says().classList.contains('error'));
  assert.equal(x.$('#mcp-paste').value,text,'what was pasted stays, to be put right');
  assert.deepEqual([x.fields().name,x.fields().target,x.fields().transport],['mine','my-server','stdio']);
 }
 await x.paste('https://notes.example/mcp');
 assert.equal(x.says().getAttribute('role'),'status');assert.equal(x.says().classList.contains('error'),false,'a good paste clears the error');
 assert.equal(x.sent.filter(m=>m.type==='mcpSave').length,0);
});
