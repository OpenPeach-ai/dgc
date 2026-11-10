import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// A message to a Pip can be up to 256 KB from Pips API 79 (Limits for everyone). The extension host checks each request's
// size before it reaches DGC: a 100 KB message was refused there at 16 KiB, though the client and DGC both took it
// (found live, 11 Nov). From API 79 a message may be as large as DGC's own request limit (2 MiB); an older DGC keeps
// 16 KiB, which is what it would take.
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
function host(api){
 const posted=[],sent=[];const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{}:require(name));
 const editor=new out.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 return {editor,posted,sent};
}
const PIP='pip_'+'a'.repeat(32);
const message=(bytes)=>({type:'send_pip_message',pip_id:PIP,text:'garden log '.repeat(Math.ceil(bytes/11)).slice(0,bytes),idempotency_key:'k1'});

test('from API 79 the host passes a 100 KB and a 256 KB message to DGC; an older DGC keeps its 16 KiB',()=>{
 for(const bytes of [100*1024,256*1024]){
  const x=host(79);x.editor.receive({type:'pipsRequest',id:'m',request:message(bytes)});
  assert.equal(x.posted.find(m=>m.id==='m')?.error,undefined,`${bytes} bytes: not refused by the host`);
  assert.equal(x.sent.length,1,`${bytes} bytes: forwarded`);
  assert.equal(x.sent[0].request.text.length,bytes,'whole');
 }
 const old=host(78);old.editor.receive({type:'pipsRequest',id:'m',request:message(100*1024)});
 assert.equal(old.sent.length,0);
 assert.match(old.posted.find(m=>m.id==='m').error.message,/16 KiB limit\. Nothing was sent\./);
 // Anything else keeps its own limit at API 79.
 const other=host(79);other.editor.receive({type:'pipsRequest',id:'n',request:{type:'add_pip_note',pip_id:PIP,text:'n'.repeat(20000),shared:false}});
 assert.equal(other.sent.length,0,'a note is not a message');
});
