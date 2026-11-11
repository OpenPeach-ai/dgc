import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// The extension host's side of a computer tab's screen bar (pc-fills-tab, pc-fullscreen-viewer; 0.52): the tab may
// choose its Pip's screen size (set_pip_computer_screen, Pips API 86), and its clipboard panel's Copy puts text on this
// computer's clipboard through the host (vscode.env.clipboard), text only and at most 1 MB. The page itself is checked
// in real Chromium (pip-computer-view-browser.test.mjs).
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule=(stub={})=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?stub:require(name));return out.exports;};
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'},OTHER='pip_'+'o'.repeat(32);
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,1));};

function host(api=86,{clipboardFails=false}={}){
 const panels=[],copied=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>({path:p.map(x=>x.path||x).join('/')}),file:p=>({path:p})},workspace:{workspaceFolders:[]},
  env:{clipboard:{writeText:async text=>{if(clipboardFails)throw Error('no clipboard');copied.push(text);}}},
  window:{createWebviewPanel:(id,title)=>{const p={id,title,posted:[],receive:null,dispose:null,
   webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
   reveal(){},onDidDispose:f=>{p.dispose=f;},onDidChangeViewState(){} };panels.push(p);return p;}}};
 const {PipsEditor,computerScreenRefusal}=viewModule(vscode);const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 editor.receive({type:'pipsOpenComputer',pip:PIP});
 const tab=panels[0],generation=()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation;
 let serial=0;
 const ask=(request,from=tab)=>{const id='q'+(++serial),before=sent.length;(from?from.receive:m=>editor.receive(m))({type:'pipsRequest',id,generation:generation(),request});
  return {call:sent.slice(before).find(m=>m.type==='pips_control')?.request,reply:(from?from.posted:main).filter(m=>m.type==='pipsReply'&&m.id===id).at(-1)};};
 return {editor,tab,main,sent,copied,ask,computerScreenRefusal};
}

test('a computer tab may choose its own Pip\'s screen size, from Pips API 86',()=>{
 const h=host();
 const ok=h.ask({type:'set_pip_computer_screen',pip_id:PIP.id,size:'1440x900'});
 assert.equal(ok.call.type,'set_pip_computer_screen');assert.equal(ok.call.pip_id,PIP.id);assert.equal(ok.call.size,'1440x900');
 assert.equal(ok.reply,undefined,'it waits for DGC\'s answer');
 h.editor.event({type:'pips_result',request_id:ok.call.request_id,command:'set_pip_computer_screen',ok:true,result:{pip_id:PIP.id,screen:'1440x900'}});
 assert.deepEqual(h.tab.posted.filter(m=>m.type==='pipsReply').at(-1).result,{pip_id:PIP.id,screen:'1440x900'});
 assert.equal(h.main.filter(m=>m.type==='pipsReply').length,0,'the answer goes to the tab, never to the Pips view');
 // Another Pip's screen is not this tab's to set.
 const other=h.ask({type:'set_pip_computer_screen',pip_id:OTHER,size:'1440x900'});
 assert.equal(other.call,undefined);assert.equal(other.reply.ok,false);assert.match(other.reply.error.message,/only uses this Pip's computer/);
 // A size that is no size never leaves the host.
 for(const size of ['big','1440X900','1440x900;rm','',null,1440,'99x99','100000x100000']){
  const bad=h.ask({type:'set_pip_computer_screen',pip_id:PIP.id,size});
  assert.equal(bad.call,undefined,String(size));assert.equal(bad.reply.error.message,'Choose one of the screen sizes on offer.');
 }
});

test('an older DGC is never asked to change a screen\'s size',()=>{
 const h=host(85);
 const old=h.ask({type:'set_pip_computer_screen',pip_id:PIP.id,size:'1440x900'});
 assert.equal(old.call,undefined);assert.equal(old.reply.ok,false);
 assert.equal(old.reply.error.message,'Update DGC to change the size of a Pip’s screen.');
 assert.equal(h.computerScreenRefusal({type:'get_pip_computer',pip_id:PIP.id},1),'','every other request is left alone');
});

test('Copy puts the computer\'s copied text on this computer\'s clipboard, through the host',async()=>{
 const h=host();
 h.tab.receive({type:'pipComputerCopy',text:'copied on the computer\nline two — ✓'});
 await settle();
 assert.deepEqual(h.copied,['copied on the computer\nline two — ✓']);
 assert.deepEqual(h.tab.posted.at(-1),{type:'pipComputerCopied',ok:true});
 assert.equal(h.sent.length,0,'nothing goes to DGC: the text never leaves this computer');
 // Exactly 1 MB goes; one byte more, an empty text, or anything that is not text does not.
 h.tab.receive({type:'pipComputerCopy',text:'a'.repeat(1_000_000)});
 await settle();
 assert.equal(h.copied.length,2);assert.equal(h.copied[1].length,1_000_000);
 for(const text of ['a'.repeat(1_000_001),'é'.repeat(500_001),'',null,undefined,42,{text:'x'},['x']]){
  h.tab.receive({type:'pipComputerCopy',text});
  await settle();
  assert.equal(h.copied.length,2,'refused: '+String(text).slice(0,12));
  assert.deepEqual(h.tab.posted.at(-1),{type:'pipComputerCopied',ok:false});
 }
});

test('only a computer tab copies, and a clipboard that refuses says so',async()=>{
 const h=host();
 const before=h.main.length;
 h.editor.receive({type:'pipComputerCopy',text:'from the Pips view'});
 await settle();
 assert.deepEqual(h.copied,[],'the Pips view has no such message');
 assert.equal(h.main.slice(before).filter(m=>m.type==='pipComputerCopied').length,0);
 const failing=host(86,{clipboardFails:true});
 failing.tab.receive({type:'pipComputerCopy',text:'x'});
 await settle();
 assert.deepEqual(failing.tab.posted.at(-1),{type:'pipComputerCopied',ok:false});
});
