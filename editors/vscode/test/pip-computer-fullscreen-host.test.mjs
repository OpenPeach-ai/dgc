// Full screen in a Pip computer's tab, the host's half (0.52, decided 12 Nov: "full screen, yes agreed"). The page says
// when Full screen goes on and off (pipComputerFull {on}); the host gives the computer the window with VS Code's own
// "Maximize Editor Group and Hide Side Bars" (workbench.action.maximizeEditorHideSidebar), or the editor group alone where
// this VS Code has no such command, and puts back what it changed when Full screen ends: once, and only when the last
// tab in Full screen leaves it, so two computer tabs never undo each other. The page's half is tested in real Chromium
// (pip-computer-room-browser.test.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule=stub=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?stub:require(name));return out.exports;};
const HIDE='workbench.action.maximizeEditorHideSidebar',TOGGLE='workbench.action.toggleMaximizeEditorGroup';
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'},OTHER={id:'pip_'+'o'.repeat(32),name:'Banker',pip_type:'lock'};
const uri=path=>({path,fsPath:path,scheme:'file'});

// One VS Code window: the commands it has, how many editor groups, and whether DGC's side bar view is showing.
function host({commands=[HIDE,TOGGLE],groups=1,side=true,fail=''}={}){
 const ran=[],panels=[],w={groups,side,shown:0};
 const vscode={ViewColumn:{Active:-1},Uri:{joinPath:(...p)=>uri(p.map(x=>x.path||x).join('/')),file:uri},workspace:{workspaceFolders:[]},
  commands:{getCommands:async()=>commands,executeCommand:async id=>{ran.push(id);if(id===fail)throw Error('refused');if(id===HIDE)w.side=false;}},
  window:{get tabGroups(){return {all:Array.from({length:w.groups},()=>({}))};},
   createWebviewPanel:(id,title)=>{const p={id,title,posted:[],receive:null,dispose:null,webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
    reveal(){},onDidDispose:f=>{p.dispose=f;},onDidChangeViewState(){}};panels.push(p);return p;}}};
 const module=viewModule(vscode);
 // Two Pips pages in one window (the side bar's and the Pips tab's), as the panel makes them: each opens computer tabs.
 const editor=()=>{const e=new module.PipsEditor({path:'ext'},()=>true,()=>{},true);e.attach(()=>{});e.ready({pips_supported:true,pips_enabled:true,pips_api_version:87},{});
  e.fullScreenSide={visible:()=>w.side,show:()=>{w.side=true;w.shown++;}};return e;};
 const a=editor(),b=editor();
 const open=(e,pip)=>{e.receive({type:'pipsOpenComputer',pip});return panels.at(-1);};
 const settle=()=>module.computerFullScreen.set({},false);   // nothing new: resolves when the window has followed everything before it
 return {ran,w,a,b,open,settle,full:async(tab,on)=>{tab.receive({type:'pipComputerFull',on});await settle();}};
}

test('Full screen on runs VS Code\'s own Maximize Editor Group and Hide Side Bars, once; off puts back the group and DGC\'s side bar, once',async()=>{
 const h=host({groups:2,side:true});const tab=h.open(h.a,PIP);
 await h.full(tab,true);
 assert.deepEqual(h.ran,[HIDE]);
 await h.full(tab,true);assert.deepEqual(h.ran,[HIDE],'said twice, done once');
 await h.full(tab,false);
 assert.deepEqual(h.ran,[HIDE,TOGGLE],'the editor group gets its size back');
 assert.equal(h.w.shown,1,'and DGC\'s side bar view is shown again');assert.equal(h.w.side,true);
 await h.full(tab,false);
 assert.deepEqual(h.ran,[HIDE,TOGGLE],'put back once');assert.equal(h.w.shown,1);
 // And again, the same way.
 await h.full(tab,true);await h.full(tab,false);
 assert.deepEqual(h.ran,[HIDE,TOGGLE,HIDE,TOGGLE]);assert.equal(h.w.shown,2);
});

test('only what it changed is put back: one editor group is not toggled, and a side bar that was not showing stays shut',async()=>{
 const one=host({groups:1,side:true});const tab=one.open(one.a,PIP);
 await one.full(tab,true);await one.full(tab,false);
 assert.deepEqual(one.ran,[HIDE],'with one group there was nothing to maximize over, so nothing to undo');
 assert.equal(one.w.shown,1);
 const shut=host({groups:2,side:false});const t2=shut.open(shut.a,PIP);
 await shut.full(t2,true);await shut.full(t2,false);
 assert.deepEqual(shut.ran,[HIDE,TOGGLE]);assert.equal(shut.w.shown,0,'DGC\'s side bar was not showing before: it is not opened now');
 // The user opened the side bar themselves during Full screen: it is not shown a second time.
 const mine=host({groups:1,side:true});const t3=mine.open(mine.a,PIP);
 await mine.full(t3,true);mine.w.side=true;await mine.full(t3,false);
 assert.equal(mine.w.shown,0);
 // The other groups were closed during Full screen: there is no maximized group left to give back.
 const closed=host({groups:2,side:false});const t4=closed.open(closed.a,PIP);
 await closed.full(t4,true);closed.w.groups=1;await closed.full(t4,false);
 assert.deepEqual(closed.ran,[HIDE]);
});

test('two computer tabs don\'t undo each other, whichever Pips page opened them: put back when the last one leaves',async()=>{
 const h=host({groups:2,side:true});
 const first=h.open(h.a,PIP),second=h.open(h.b,OTHER);
 await h.full(first,true);await h.full(second,true);
 assert.deepEqual(h.ran,[HIDE],'the second tab changes nothing more');
 await h.full(first,false);
 assert.deepEqual(h.ran,[HIDE],'the first leaving does not undo the second\'s');assert.equal(h.w.shown,0);
 await h.full(second,false);
 assert.deepEqual(h.ran,[HIDE,TOGGLE]);assert.equal(h.w.shown,1);
});

test('a tab closed in Full screen puts the window back; a tab that was never in it changes nothing',async()=>{
 const h=host({groups:2,side:true});
 const tab=h.open(h.a,PIP),other=h.open(h.a,OTHER);
 other.dispose();await h.settle();
 assert.deepEqual(h.ran,[]);
 await h.full(tab,true);
 tab.dispose();await h.settle();
 assert.deepEqual(h.ran,[HIDE,TOGGLE]);assert.equal(h.w.shown,1);
});

test('a VS Code without the command falls back to the editor group alone, and one with neither is left as it is',async()=>{
 const old=host({commands:[TOGGLE],groups:2,side:true});const tab=old.open(old.a,PIP);
 await old.full(tab,true);
 assert.deepEqual(old.ran,[TOGGLE]);
 await old.full(tab,false);
 assert.deepEqual(old.ran,[TOGGLE,TOGGLE]);assert.equal(old.w.shown,0,'the side bars were never touched');
 const single=host({commands:[TOGGLE],groups:1});const t2=single.open(single.a,PIP);
 await single.full(t2,true);await single.full(t2,false);
 assert.deepEqual(single.ran,[],'one group: the toggle would do nothing');
 const none=host({commands:[],groups:2});const t3=none.open(none.a,PIP);
 await none.full(t3,true);await none.full(t3,false);
 assert.deepEqual(none.ran,[]);
 // The command is there but this VS Code has no way back for the group: the side bar is still put back.
 const half=host({commands:[HIDE],groups:2,side:true});const t4=half.open(half.a,PIP);
 await half.full(t4,true);await half.full(t4,false);
 assert.deepEqual(half.ran,[HIDE]);assert.equal(half.w.shown,1);
});

test('only a computer tab can ask, only `on: true` turns it on, and a command VS Code refuses breaks nothing',async()=>{
 const h=host({groups:2,side:true});const tab=h.open(h.a,PIP);
 h.a.receive({type:'pipComputerFull',on:true});await h.settle();
 assert.deepEqual(h.ran,[],'not from the Pips page itself');
 for(const on of ['true',1,{},undefined]){tab.receive({type:'pipComputerFull',on});await h.settle();}
 assert.deepEqual(h.ran,[]);
 assert.equal(tab.posted.filter(m=>/Full/.test(m.type)).length,0,'the host answers nothing: the page has no say in the window beyond on and off');
 const bad=host({groups:2,side:true,fail:HIDE});const t2=bad.open(bad.a,PIP);
 await bad.full(t2,true);await bad.full(t2,false);
 assert.deepEqual(bad.ran,[HIDE,TOGGLE],'it still puts back what it meant to change');
 await bad.full(t2,true);assert.equal(bad.ran.filter(c=>c===HIDE).length,2,'and Full screen works the next time');
});
