// Big files into and out of a Pip computer's Files, the editor half (pc-background-commands, Pips API 87).
//
// - Add file… asks the extension host, which shows VS Code's own open dialog (several files) and sends one
//   copy_pip_computer_file_in per file into the folder being shown. Save to this computer… asks the host, which shows
//   VS Code's save dialog and sends copy_pip_computer_file_out.
// - The page never sends a path on this computer: only which folder or file in Files. A page message carrying a path is
//   ignored, and no page can send the copy commands themselves.
// - Before API 87 nothing changes: today's Add files… and Save to…, 2 MB.
// The layout is tested in real Chromium (pip-computer-bigfiles-browser.test.mjs).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'};
const OTHER='pip_'+'o'.repeat(32);
const viewModule=(stub={})=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?stub:require(name));return out.exports;};
async function flush(){for(let i=0;i<14;i++)await Promise.resolve();}
const settle=async(until,what)=>{for(let i=0;i<200&&!until();i++)await new Promise(r=>setTimeout(r,2));assert.ok(until(),what);};

// ---- The page -------------------------------------------------------------------------------------------------
function page(api=87){
 const dom=new JSDOM(viewModule().computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 const files={'':[{name:'Downloads',kind:'folder',bytes:null,modified:1},{name:'notes.txt',kind:'file',bytes:12,modified:2},{name:'film.mov',kind:'file',bytes:700*1024*1024,modified:3}],Downloads:[]};
 w.setInterval=()=>0;w.clearInterval=()=>{};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(code);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answers=r=>({get_pip_computer:()=>({computer:{pip_id:PIP.id,granted:true,available:true,reason:'',pending:0,actions:[]}}),
  use_pip_computer_view:()=>({view:{ok:false,error:''}}),
  list_pip_computer_files:()=>({path:r.path,entries:files[r.path]||[],more:false,total_bytes:700*1024*1024+12}),
  read_pip_computer_file:()=>r.path==='film.mov'?{path:r.path,name:'film.mov',mime:'video/quicktime',bytes:700*1024*1024,too_large:true}
   :{path:r.path,name:r.path.split('/').at(-1),mime:'text/plain',bytes:12,text:'buy milk\n',truncated:false},
  add_pip_computer_file:()=>({path:r.name,name:r.name,bytes:3})}[r.type]?.());
 async function drain(){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=answers(m.request);
  if(result!==undefined){answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});count++;}}if(!count)break;}await flush();}
 message({type:'pipComputerInit',pip:PIP,desktop:false});
 message({type:'pipsConnection',generation:7,apiVersion:api,connected:true,supported:true,enabled:true});
 const d=w.document;
 return {w,d,sent,files,drain,message,posted:type=>JSON.parse(JSON.stringify(sent.filter(m=>m.type===type))),requests:type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type),
  click:s=>{const el=d.querySelector(s);assert.ok(el,'Missing '+s);el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));},
  drop:list=>{const e=new w.Event('drop',{bubbles:true,cancelable:true});e.dataTransfer={files:list,types:['Files']};d.dispatchEvent(e);}};
}
const openFiles=async(api)=>{const x=page(api);await x.drain();x.click('[data-app=files]');await x.drain();return x;};

test('Add file… asks the host with the folder being shown and nothing else; the names show as "copying" until DGC answers',async()=>{
 const x=await openFiles();
 const add=x.d.querySelector('#pc-add');
 assert.equal(add.textContent,'Add file…');assert.ok(add.classList.contains('dgc-btn'),'the shared button');
 assert.equal(x.d.querySelector('#pc-add-input'),null,'no file input: a page has no path to give');
 x.click('[data-folder="Downloads"]');await x.drain();
 x.click('#pc-add');
 assert.deepEqual(x.posted('pipComputerAddFiles'),[{type:'pipComputerAddFiles',folder:'Downloads'}],'only the folder in Files');
 assert.equal(x.d.querySelector('#pc-add').textContent,'Adding…');assert.ok(x.d.querySelector('#pc-add').disabled);
 x.click('#pc-add');assert.equal(x.posted('pipComputerAddFiles').length,1,'one at a time');
 x.message({type:'pipComputerAdding',names:['film.mov','data.bin']});
 assert.deepEqual([...x.d.querySelectorAll('.pc-copying')].map(li=>[li.querySelector('.pc-name').textContent,li.querySelector('.pc-size').textContent]),[['film.mov','copying'],['data.bin','copying']]);
 assert.equal(x.d.querySelector('progress,[role=progressbar]'),null,'no made-up progress bar');
 // The first has landed: the list is read again, and one is left copying.
 const before=x.requests('list_pip_computer_files').length;
 x.files.Downloads=[{name:'film.mov',kind:'file',bytes:700*1024*1024,modified:4}];
 x.message({type:'pipComputerAdding',names:['data.bin'],refresh:true});await x.drain();
 assert.equal(x.requests('list_pip_computer_files').length,before+1);
 assert.deepEqual([...x.d.querySelectorAll('.pc-list .pc-name')].map(e=>e.textContent),['data.bin','film.mov']);
 assert.equal(x.d.querySelector('[data-file="film.mov"] .pc-size').textContent,'700.0 MB');
 // Done, and the second was over the limit: DGC's words stay, after the list is read again.
 x.message({type:'pipComputerAdded',added:['film.mov'],errors:['That file is 1.4 GB. A Pip\'s computer takes files up to 1 GB.']});await x.drain();
 assert.equal(x.requests('list_pip_computer_files').length,before+2);
 assert.equal(x.d.querySelector('.pc-copying'),null);
 assert.equal(x.d.querySelector('#pc-add').textContent,'Add file…');assert.ok(!x.d.querySelector('#pc-add').disabled);
 assert.equal(x.d.querySelector('.pc-files .pc-error').textContent,'That file is 1.4 GB. A Pip\'s computer takes files up to 1 GB.');
 assert.equal(x.requests('add_pip_computer_file').length,0,'nothing went as a data URI');
 assert.ok(x.sent.every(m=>!/copy_pip_computer_file/.test(JSON.stringify(m))),'the page never sends a copy command');
});

test('a cancelled Add file… leaves the panel as it was; copying rows show only in the folder they go to',async()=>{
 const x=await openFiles();
 x.click('#pc-add');x.message({type:'pipComputerAdded',added:[],errors:[],cancelled:true});await x.drain();
 assert.equal(x.d.querySelector('#pc-add').textContent,'Add file…');assert.equal(x.d.querySelector('.pc-files .pc-error'),null);
 x.click('#pc-add');x.message({type:'pipComputerAdding',names:['a.bin']});
 assert.equal(x.d.querySelectorAll('.pc-copying').length,1);
 x.click('[data-folder="Downloads"]');await x.drain();
 assert.equal(x.d.querySelectorAll('.pc-copying').length,0,'not in another folder');
 assert.equal(x.d.querySelector('#pc-add').textContent,'Adding…');
 // A host that said "adding" with no Add under way is not believed.
 const y=await openFiles();y.message({type:'pipComputerAdding',names:['ghost.bin']});
 assert.equal(y.d.querySelector('.pc-copying'),null);
});

// Asked 18 Nov: Download saves on the computer the editor runs on. DGC copies the file out and the host hands it to
// this page, which saves it there (media/shared/download.js); one too large for a page goes to the person's browser.
test('Download asks the host with the file in Files, whatever its size, and says "Downloaded <name>" or DGC\'s words',async()=>{
 const x=await openFiles();
 x.click('[data-file="film.mov"]');await x.drain();
 const save=x.d.querySelector('#pc-save-as');
 assert.equal(save.textContent,'Download');assert.ok(!save.disabled,'a 700 MB file can be downloaded: DGC copies it, not the page');
 assert.ok(save.classList.contains('dgc-btn'));assert.equal(x.d.querySelector('#pc-save'),null);
 x.click('#pc-save-as');
 assert.deepEqual(x.posted('pipComputerSaveAs'),[{type:'pipComputerSaveAs',path:'film.mov'}],'only the file in Files');
 assert.equal(x.d.querySelector('#pc-save-as').textContent,'Downloading…');assert.ok(x.d.querySelector('#pc-save-as').disabled);
 assert.ok(x.d.querySelector('#pc-add').disabled,'one copy at a time');
 x.message({type:'pipComputerSavedAs',ok:true,name:'film.mov',downloaded:true});
 assert.equal(x.d.querySelector('.pc-notice').textContent,'Downloaded film.mov.');
 assert.equal(x.d.querySelector('#pc-save-as').textContent,'Download');
 x.click('#pc-save-as');x.message({type:'pipComputerSavedAs',ok:false,error:'That file is not in this computer\'s Files.'});
 assert.equal(x.d.querySelector('.pc-files .pc-error').textContent,'That file is not in this computer\'s Files.');
 assert.equal(x.d.querySelector('.pc-notice'),null,'the old "Saved" is not left beside the refusal');
 x.click('#pc-save-as');x.message({type:'pipComputerSavedAs',ok:false,cancelled:true});
 assert.equal(x.d.querySelector('.pc-files .pc-error'),null,'a cancelled dialog says nothing');
 assert.equal(x.posted('pipComputerSave').length,0,'never as bytes through the page');
});

test('a dropped file has no path: up to 2 MB it goes as before, a bigger one says to use Add file…',async()=>{
 const x=await openFiles();
 const small=new x.w.File(['hey'],'hi.txt',{type:'text/plain'}),big=new x.w.File(['x'],'film.mov');
 Object.defineProperty(big,'size',{value:5*1024*1024});
 x.drop([big,small]);
 await settle(()=>x.requests('add_pip_computer_file').length===1,'the small one goes as a data URI');await x.drain();
 assert.equal(x.requests('add_pip_computer_file')[0].request.name,'hi.txt');
 assert.equal(x.d.querySelector('.pc-files .pc-error').textContent,'Use Add file… for files over 2 MB.');
 assert.equal(x.posted('pipComputerAddFiles').length,0,'a drop opens no dialog');
});

test('before API 87: Add files… is the file input, and Download saves the bytes it read from this page',async()=>{
 const x=await openFiles(86);
 assert.ok(x.d.querySelector('label.pc-add #pc-add-input'));assert.equal(x.d.querySelector('label.pc-add').textContent,'Add files…');
 assert.equal(x.d.querySelector('#pc-add'),null);
 x.click('[data-file="notes.txt"]');await x.drain();
 assert.equal(x.d.querySelector('#pc-save').textContent,'Download');assert.equal(x.d.querySelector('#pc-save-as'),null);
 assert.equal(x.d.querySelector('#pc-remove').className,'pc-quiet');
 let saved=null;x.w.URL.createObjectURL=b=>{saved={blob:b};return 'blob:notes';};x.w.URL.revokeObjectURL=()=>{};
 x.w.HTMLAnchorElement.prototype.click=function(){saved.name=this.download;};
 x.click('#pc-save');
 assert.equal(saved?.name,'notes.txt','saved by this page, on this computer');
 assert.equal(await saved.blob.text(),'buy milk\n');
 assert.equal(x.posted('pipComputerSave').length,0,'nothing asked of the host');
 x.click('[data-file="film.mov"]');await x.drain();
 assert.ok(x.d.querySelector('#pc-save').disabled,'over 2 MB it cannot be saved there');
 const big=new x.w.File(['x'],'film.mov');Object.defineProperty(big,'size',{value:5*1024*1024});
 x.drop([big]);await settle(()=>x.d.querySelector('.pc-files .pc-error'),'it says so');await x.drain();
 assert.equal(x.d.querySelector('.pc-files .pc-error').textContent,'film.mov is over 2 MB.');
 assert.equal(x.posted('pipComputerAddFiles').length+x.posted('pipComputerSaveAs').length,0);
});

// ---- The extension host ---------------------------------------------------------------------------------------
const uri=(path,scheme='file')=>({scheme,path,fsPath:path});
function host(api=87,{open=async()=>[uri('/home/me/film.mov')],save=async()=>uri('/home/me/Desktop/out.mov')}={}){
 const panels=[],dialogs=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>uri(p.map(x=>x.path||x).join('/')),file:p=>uri(p)},FileType:{File:1,Directory:2},
  workspace:{workspaceFolders:[],fs:{writeFile:async()=>{throw Error('the host writes no bytes here');},
   // (What a download reads: the file DGC copied out into its private folder.)
   stat:async u=>{const s=statSync(u.fsPath);return {type:s.isFile()?1:2,size:s.size};},readFile:async u=>readFileSync(u.fsPath)}},
  window:{showOpenDialog:async o=>{dialogs.push(['open',o]);return open(o);},showSaveDialog:async o=>{dialogs.push(['save',o]);return save(o);},
   createWebviewPanel:(id,title)=>{const p={id,title,posted:[],receive:null,dispose:null,
    webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
    reveal(){},onDidDispose:f=>{p.dispose=f;},onDidChangeViewState(){} };panels.push(p);return p;}}};
 const {PipsEditor}=viewModule(vscode);const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 editor.receive({type:'pipsOpenComputer',pip:PIP});
 const tab=panels[0];
 const copies=()=>sent.filter(m=>m.type==='pips_control'&&/^copy_pip_computer_file_/.test(m.request.type)).map(m=>m.request);
 const answer=(request,result,ok=true)=>editor.event({type:'pips_result',request_id:request.request_id,command:request.type,ok,...(ok?{result}:{error:result})});
 return {editor,tab,main,sent,dialogs,copies,answer,generation:()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation,
  last:type=>tab.posted.filter(m=>m.type===type).at(-1)};
}

test('the host shows VS Code\'s open dialog and sends one copy per picked file into the folder, one after another',async()=>{
 const h=host(87,{open:async()=>[uri('/home/me/film.mov'),uri('/srv/data/set.bin','vscode-remote')]});
 h.tab.receive({type:'pipComputerAddFiles',folder:'Downloads'});
 await settle(()=>h.copies().length===1,'the first copy is sent');
 assert.equal(h.dialogs.length,1);assert.equal(h.dialogs[0][0],'open');
 assert.equal(h.dialogs[0][1].canSelectMany,true);assert.equal(h.dialogs[0][1].canSelectFolders,false);
 const {request_id,...first}=h.copies()[0];
 assert.deepEqual(first,{type:'copy_pip_computer_file_in',pip_id:PIP.id,path:'Downloads',source:'/home/me/film.mov'});
 assert.deepEqual(h.last('pipComputerAdding').names,['film.mov','set.bin']);
 // A second Add while this one runs opens no second dialog.
 h.tab.receive({type:'pipComputerAddFiles',folder:''});await flush();assert.equal(h.dialogs.length,1);
 h.answer(h.copies()[0],{path:'Downloads/film (1).mov',name:'film (1).mov',bytes:5});
 await settle(()=>h.copies().length===2,'then the second');
 assert.equal(h.copies()[1].source,'/srv/data/set.bin','in a remote window the path is the remote machine\'s, where DGC runs');
 assert.deepEqual([h.last('pipComputerAdding').names,h.last('pipComputerAdding').refresh],[['set.bin'],true]);
 h.answer(h.copies()[1],{message:'That file is 1.4 GB. A Pip\'s computer takes files up to 1 GB.'},false);
 await settle(()=>h.last('pipComputerAdded'),'it says how it went');
 assert.deepEqual(h.last('pipComputerAdded'),{type:'pipComputerAdded',added:['film (1).mov'],errors:['That file is 1.4 GB. A Pip\'s computer takes files up to 1 GB.']});
 assert.equal(h.main.filter(m=>/^pipComputerAdd/.test(m.type)).length,0,'never to the Pips view');
 // Free again.
 h.tab.receive({type:'pipComputerAddFiles',folder:''});await settle(()=>h.dialogs.length===2,'a new Add opens the dialog again');
});

test('a page message carrying a path on this computer is ignored: the host copies only what its own dialog returned',async()=>{
 // Nothing picked: nothing copied, whatever the page says.
 const none=host(87,{open:async()=>undefined,save:async()=>undefined});
 const evil={source:'/etc/shadow',sources:['/etc/shadow'],path:'/etc/shadow',paths:['/etc/shadow'],files:[{path:'/etc/shadow'}],uris:['file:///etc/shadow'],target:'/home/me/.bashrc',defaultUri:'/home/me/.ssh'};
 none.tab.receive({type:'pipComputerAddFiles',folder:'',...evil});
 await settle(()=>none.last('pipComputerAdded'),'the dialog was shown and closed');
 assert.equal(none.last('pipComputerAdded').cancelled,true);
 assert.equal(none.copies().length,0);assert.equal(none.sent.length,0,'nothing reached DGC');
 // Something picked: the path sent is the dialog's, and the page's is nowhere in it.
 const h=host();
 h.tab.receive({type:'pipComputerAddFiles',folder:'',...evil});
 await settle(()=>h.copies().length===1,'the picked file is copied');
 assert.equal(h.copies()[0].source,'/home/me/film.mov');
 assert.ok(!JSON.stringify(h.sent).includes('/etc/shadow')&&!JSON.stringify(h.sent).includes('.bashrc'));
 assert.deepEqual(Object.keys(h.copies()[0]).sort(),['path','pip_id','request_id','source','type']);
 h.answer(h.copies()[0],{path:'film.mov',name:'film.mov',bytes:5});await settle(()=>h.last('pipComputerAdded'),'done');
 h.tab.receive({type:'pipComputerSaveAs',path:'notes.txt',target:'/home/me/.bashrc',name:'../../.bashrc'});
 await settle(()=>h.copies().length===2,'the download is sent');
 assert.match(h.copies()[1].target,/dgc-download-[^/]+\/notes\.txt$/,'copied out into a private folder made for this download, named as in Files');
 assert.ok(!JSON.stringify(h.sent).includes('.bashrc'));
 // A folder or file that is not one in Files opens no dialog at all.
 const dialogs=h.dialogs.length;
 writeFileSync(h.copies()[1].target,'buy milk\n');
 h.answer(h.copies()[1],{path:'notes.txt',target:h.copies()[1].target,bytes:9});await settle(()=>h.last('pipComputerSavedAs'),'done');
 for(const bad of [{type:'pipComputerAddFiles',folder:'/etc'},{type:'pipComputerAddFiles',folder:'../..'},{type:'pipComputerAddFiles',folder:['x']},{type:'pipComputerAddFiles'},
                   {type:'pipComputerSaveAs',path:'/etc/passwd'},{type:'pipComputerSaveAs',path:'a/../../b'},{type:'pipComputerSaveAs',path:''},{type:'pipComputerSaveAs',path:7}]){
  h.tab.receive(bad);await flush();
 }
 assert.equal(h.dialogs.length,dialogs);assert.equal(h.copies().length,2);
});

test('no page can send the copy commands themselves: not a computer tab, not the Pips view',async()=>{
 const h=host(),g=h.generation();
 const asks=[{type:'copy_pip_computer_file_in',pip_id:PIP.id,path:'',source:'/etc/shadow'},{type:'copy_pip_computer_file_out',pip_id:PIP.id,path:'notes.txt',target:'/home/me/.bashrc'}];
 for(const [i,request] of asks.entries()){
  h.tab.receive({type:'pipsRequest',id:'tab'+i,generation:g,request});
  h.editor.receive({type:'pipsRequest',id:'main'+i,generation:g,request});
 }
 assert.equal(h.sent.length,0,'nothing reached DGC');
 assert.deepEqual(h.tab.posted.filter(m=>m.type==='pipsReply').map(m=>[m.id,m.ok]),[['tab0',false],['tab1',false]]);
 assert.deepEqual(h.main.filter(m=>m.type==='pipsReply').map(m=>[m.id,m.ok]),[['main0',false],['main1',false]]);
 // The Pips view cannot ask for the dialogs either: they belong to a computer tab.
 h.editor.receive({type:'pipComputerAddFiles',folder:''});h.editor.receive({type:'pipComputerSaveAs',path:'notes.txt'});await flush();
 assert.equal(h.dialogs.length,0);
 // And a tab copies into its own Pip only: the Pip is the tab's, never the message's.
 h.tab.receive({type:'pipComputerAddFiles',folder:'',pip_id:OTHER,pip:{id:OTHER}});
 await settle(()=>h.copies().length===1,'copied');
 assert.equal(h.copies()[0].pip_id,PIP.id);
});

test('Download: no save dialog; DGC copies the file out into a private folder, the page is handed it, and says Downloaded or DGC\'s words',async()=>{
 const h=host();
 h.tab.receive({type:'pipComputerSaveAs',path:'Downloads/film.mov'});
 await settle(()=>h.copies().length===1,'sent');
 assert.deepEqual(h.dialogs,[],'no save dialog: it would browse the machine DGC runs on');
 const {request_id,target,...copy}=h.copies()[0];
 assert.deepEqual(copy,{type:'copy_pip_computer_file_out',pip_id:PIP.id,path:'Downloads/film.mov'});
 assert.match(target,/dgc-download-[^/]+\/film\.mov$/);
 writeFileSync(target,'the film');
 h.answer(h.copies()[0],{path:'Downloads/film.mov',target,bytes:8});
 await settle(()=>h.last('pipComputerSavedAs'),'answered');
 assert.deepEqual(h.last('pipComputerSavedAs'),{type:'pipComputerSavedAs',ok:true,name:'film.mov',downloaded:true});
 const handed=h.last('dgcDownload');assert.equal(handed.name,'film.mov');assert.equal(String(Buffer.from(handed.data)),'the film');
 assert.equal(existsSync(target),false,'its private folder is gone once handed over');
 h.tab.receive({type:'pipComputerSaveAs',path:'gone.txt'});await settle(()=>h.copies().length===2,'sent');
 h.answer(h.copies()[1],{message:'That file is not in this computer\'s Files.'},false);
 await settle(()=>h.tab.posted.filter(m=>m.type==='pipComputerSavedAs').length===2,'answered');
 assert.deepEqual(h.last('pipComputerSavedAs'),{type:'pipComputerSavedAs',ok:false,error:'That file is not in this computer\'s Files.'});
});

test('a copy is not waited for after the connection changes, and an older DGC is never asked',async()=>{
 const h=host();
 h.tab.receive({type:'pipComputerAddFiles',folder:''});await settle(()=>h.copies().length===1,'sent');
 h.editor.offline();
 await settle(()=>h.last('pipComputerAdded'),'it ends in words');
 assert.equal(h.last('pipComputerAdded').added.length,0);assert.match(h.last('pipComputerAdded').errors[0],/connection to DGC changed/);
 const old=host(86);
 old.tab.receive({type:'pipComputerAddFiles',folder:''});old.tab.receive({type:'pipComputerSaveAs',path:'notes.txt'});await flush();
 assert.equal(old.dialogs.length,0);assert.equal(old.sent.length,0);
 assert.match(old.last('pipComputerAdded').errors[0],/Update DGC/);assert.match(old.last('pipComputerSavedAs').error,/Update DGC/);
 old.tab.receive({type:'pipsRequest',id:'x',generation:old.generation(),request:{type:'copy_pip_computer_file_in',pip_id:PIP.id,path:'',source:'/home/me/a'}});
 assert.equal(old.sent.length,0);assert.match(old.tab.posted.at(-1).error.message,/Update DGC/);
});
