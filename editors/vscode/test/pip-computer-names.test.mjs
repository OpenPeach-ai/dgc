import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {pipComputer} from '../src/pipsModel.js';

// A Pip's computers have names (pips-17d; Pips API 86). One editor tab per computer, "Shopper · Wren"; with one
// computer the tab still reads "Shopper · Computer". A tab's client says which computer (`number`) with
// open_pip_computer, use_pip_computer_view and the screen's open, only at API 86 and (for the screen) only to a CLI
// that says pips_desktop_numbers. There is one stream per Pip: a second tab of the same Pip says "Showing Wren in
// another tab" with Show here. A rename retitles the open tabs. The host's allow-list takes rename_pip_computer from the
// Pips page only, and `number` only at API 86.
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'};
const OTHER={id:'pip_'+'o'.repeat(32),name:'Desk',pip_type:'lens'};
const JPEG='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const NAMES=[{number:1,name:'Juniper',named:false,state:'closed'},{number:2,name:'Wren',named:false,state:'working',doing:'Find a flat in Pune'}];
const computer=(extra={})=>({pip_id:PIP.id,granted:true,available:true,reason:'',pending:0,actions:[],computers:2,computers_limit:3,names:NAMES,screen:'1280x800',screens:['1280x800','1440x900','1920x1080'],...extra});
async function flush(){for(let i=0;i<14;i++)await Promise.resolve();}
const viewModule=(stub={})=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?stub:require(name));return out.exports;};

function host(api=86,capabilities={}){
 const panels=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>({path:p.map(x=>x.path||x).join('/')}),file:p=>({path:p})},workspace:{workspaceFolders:[],fs:{}},
  window:{createWebviewPanel:(id,title)=>{const p={id,title,revealed:0,posted:[],receive:null,dispose:null,
   webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
   reveal(){p.revealed++;},onDidDispose:f=>{p.dispose=f;},onDidChangeViewState(){} };panels.push(p);return p;}}};
 const {PipsEditor}=viewModule(vscode);const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api,...capabilities},{});
 const generation=()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation;
 let serial=0;
 // A request from the Pips page, answered by DGC: what the host passes on, and what it learns from the answer.
 const ask=(request,result,from=null)=>{const id='q'+(++serial),before=sent.length;(from?from.receive:m=>editor.receive(m))({type:'pipsRequest',id,generation:generation(),request});
  const call=sent.slice(before).find(m=>m.type==='pips_control');
  if(call&&result!==undefined)editor.event({type:'pips_result',request_id:call.request.request_id,command:request.type,ok:true,result});
  return {call:call?.request,reply:(from?from.posted:main).filter(m=>m.type==='pipsReply'&&m.id===id).at(-1)};};
 const know=(names=NAMES,pip=PIP)=>ask({type:'get_pip_computer',pip_id:pip.id},{computer:{...computer({names}),pip_id:pip.id}});
 return {editor,panels,main,sent,generation,ask,know,desktop:()=>sent.filter(m=>m.type==='pip_desktop')};
}

function fakeViewer(){
 const made=[];
 class Viewer{constructor(target,channel,options){this.target=target;this.channel=channel;this.options=options;this.listeners={};made.push(this);
  channel.onopen=()=>{this.opened=true;};channel.onmessage=e=>{(this.got||=[]).push(new Uint8Array(e.data));};channel.onclose=e=>{this.closed=e;};}
  addEventListener(kind,fn){this.listeners[kind]=fn;}}
 return {Viewer,made};
}
function tab({api=86,init={},status=computer(),screen=false,viewer=null}={}){
 const dom=new JSDOM(viewModule().computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),timers=[];let state=status;
 w.setInterval=fn=>{timers.push({fn,live:true});return timers.length;};w.clearInterval=id=>{if(timers[id-1])timers[id-1].live=false;};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 if(viewer)w.__dgcTestRFB=viewer;w.eval(code);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type).map(m=>m.request);
 const defaults=r=>({get_pip_computer:()=>({computer:state}),open_pip_computer:()=>({view:{pip_id:PIP.id,ready:true}}),
  use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://shop.example/',width:1280,height:800,image:JPEG}}),
  get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,available:screen,reason:'',install:'',using:false,browser:'Google Chrome',chrome_install:''}})}[r.type]?.());
 async function drain(){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});count++;}}if(!count)break;}await flush();}
 message({type:'pipComputerInit',pip:PIP,desktop:screen,...init});
 message({type:'pipsConnection',generation:7,apiVersion:api,connected:true,supported:true,enabled:true});
 return {w,d:w.document,sent,requests,drain,message,setState:s=>{state=s;},
  click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));},
  tick:async()=>{for(const t of timers.filter(t=>t.live))t.fn();await drain();}};
}

test('get_pip_computer\'s names are read: each computer\'s number, name and state, and nothing odd',()=>{
 const value=pipComputer(computer(),PIP.id);
 assert.deepEqual(value.names.map(n=>[n.number,n.name,n.state,n.doing||'']),[[1,'Juniper','closed',''],[2,'Wren','working','Find a flat in Pune']]);
 assert.equal(pipComputer(computer({names:undefined,screen:undefined,screens:undefined}),PIP.id).names,undefined,'an older DGC sends none');
 const bare=NAMES.map(({number,name,named})=>({number,name,named}));
 assert.equal(pipComputer(computer({names:bare}),PIP.id).names.length,2,'a state is not required');
 for(const bad of [[{number:0,name:'A',named:false}],[{number:1,name:'',named:false}],[{number:1,name:'x'.repeat(61),named:false}],[{number:1,name:'A',named:'yes'}],
  [{number:1,name:'A',named:false,state:'asleep'}],[{number:1,name:'A',named:false,state:'working',doing:7}],[{number:1,name:'A',named:false,token:'s'}],'Juniper',
  [{number:1,name:'A',named:false},{number:1,name:'B',named:false}]])
  assert.throws(()=>pipComputer(computer({names:bad}),PIP.id),/invalid/,JSON.stringify(bad));
 assert.throws(()=>pipComputer({...computer(),token:'secret'},PIP.id),/invalid/,'anything else is still refused');
});

test('one editor tab per computer, titled "Shopper · Wren"; with one computer it still reads "Shopper · Computer"',()=>{
 const h=host();h.know();
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:1});
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});
 assert.deepEqual(h.panels.map(p=>[p.title,p.revealed]),[['Shopper · Wren',1],['Shopper · Juniper',0]],'a second open of the same one brings it forward');
 h.panels[0].receive({type:'pipsReady'});
 const init=h.panels[0].posted.find(m=>m.type==='pipComputerInit');
 assert.deepEqual(init.pip,PIP);assert.equal(init.number,2);assert.equal(init.name,'Wren');
 for(const bad of [0,-1,1.5,'2',1001,null])h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:bad});
 assert.equal(h.panels.length,2,'a number that is not one of its computers opens nothing');
 // One computer: no name needed.
 const one=host();one.know([NAMES[0]]);
 one.editor.receive({type:'pipsOpenComputer',pip:PIP});
 assert.deepEqual(one.panels.map(p=>p.title),['Shopper · Computer']);
 one.panels[0].receive({type:'pipsReady'});
 assert.equal('number' in one.panels[0].posted.find(m=>m.type==='pipComputerInit'),false,'and no number');
 // Before API 86 a number is never taken: the Pip's one tab, as before.
 const old=host(85);old.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});old.editor.receive({type:'pipsOpenComputer',pip:PIP,number:1});
 assert.deepEqual(old.panels.map(p=>p.title),['Shopper · Computer']);
 old.panels[0].receive({type:'pipsReady'});
 assert.equal('number' in old.panels[0].posted.find(m=>m.type==='pipComputerInit'),false);
});

test('a rename retitles the open tabs, and tells them',()=>{
 const h=host();h.know();h.know([{number:1,name:'Fern',named:false,state:'closed'},{number:2,name:'Moss',named:false,state:'closed'}],OTHER);
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:1});h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});h.editor.receive({type:'pipsOpenComputer',pip:OTHER,number:2});
 assert.deepEqual(h.panels.map(p=>p.title),['Shopper · Juniper','Shopper · Wren','Desk · Moss']);
 const renamed=[{number:1,name:'Juniper',named:false},{number:2,name:'Travel',named:true}];
 const done=h.ask({type:'rename_pip_computer',pip_id:PIP.id,number:2,name:'Travel'},{pip_id:PIP.id,number:2,name:'Travel',names:renamed});
 assert.deepEqual(done.call,{...done.call,type:'rename_pip_computer',pip_id:PIP.id,number:2,name:'Travel'});
 assert.equal(done.reply.ok,true);
 assert.deepEqual(h.panels.map(p=>p.title),['Shopper · Juniper','Shopper · Travel','Desk · Moss'],'only that Pip\'s tab');
 assert.deepEqual(h.panels[1].posted.at(-1),{type:'pipComputerNames',names:[{number:1,name:'Juniper'},{number:2,name:'Travel'}]});
 assert.equal(h.panels[2].posted.some(m=>m.type==='pipComputerNames'&&m.names.some(n=>n.name==='Travel')),false,'another Pip\'s tab is told nothing');
 // A tab's own look at its computer (every few seconds) carries a rename made anywhere.
 h.ask({type:'get_pip_computer',pip_id:PIP.id},{computer:computer({names:[{...NAMES[0],name:'Front desk',named:true},NAMES[1]]})},h.panels[0]);
 assert.equal(h.panels[0].title,'Shopper · Front desk');
 // A reply that isn't a list of names changes nothing.
 h.ask({type:'get_pip_computer',pip_id:PIP.id},{computer:{...computer(),names:[{number:1,name:'<b>',named:true},{number:2,name:7}]}});
 assert.equal(h.panels[0].title,'Shopper · Front desk');
});

test('the allow-list: rename_pip_computer from the Pips page at API 86, and `number` never below it',()=>{
 const h=host();h.know();
 for(const [name,why] of [['!!',/letters, digits/],['x'.repeat(31),/letters, digits/],[7,/letters, digits/],[' lead',/letters, digits/]]){
  const r=h.ask({type:'rename_pip_computer',pip_id:PIP.id,number:1,name});assert.equal(r.call,undefined,String(name));assert.match(r.reply.error.message,why);}
 for(const number of [0,1.5,'1',1001,undefined]){const r=h.ask({type:'rename_pip_computer',pip_id:PIP.id,number,name:'Desk'});assert.equal(r.call,undefined,String(number));assert.equal(r.reply.ok,false);}
 assert.ok(h.ask({type:'rename_pip_computer',pip_id:PIP.id,number:1,name:''},{pip_id:PIP.id,number:1,name:'Juniper',names:NAMES}).call,'an empty name asks for its first name back');
 assert.ok(h.ask({type:'rename_pip_computer',pip_id:PIP.id,number:2,name:'Dad\'s (old) R&D-2'}).call);
 assert.ok(h.ask({type:'rename_pip_computer',pip_id:PIP.id,number:2,name:'Büro 2'}).call,'letters of any alphabet');
 for(const type of ['open_pip_computer','use_pip_computer_view']){
  assert.equal(h.ask({type,pip_id:PIP.id,op:'frame',number:2}).call.number,2,type);
  for(const number of [0,1.5,'2',1001,null]){const r=h.ask({type,pip_id:PIP.id,op:'frame',number});assert.equal(r.call,undefined);assert.equal(r.reply.ok,false);}
 }
 const old=host(85);
 for(const request of [{type:'rename_pip_computer',pip_id:PIP.id,number:1,name:'Desk'},{type:'open_pip_computer',pip_id:PIP.id,number:1},{type:'use_pip_computer_view',pip_id:PIP.id,op:'frame',number:1}]){
  const r=old.ask(request);assert.equal(r.call,undefined,request.type);assert.match(r.reply.error.message,/^Update DGC/);}
 assert.ok(old.ask({type:'open_pip_computer',pip_id:PIP.id}).call,'without a number it goes as before');
 assert.equal(old.sent.some(m=>JSON.stringify(m).includes('"number"')),false,'an older DGC is never sent a number');
 // A computer's tab keeps to its own computer, and never renames.
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});const t=h.panels.at(-1);
 assert.equal(h.ask({type:'use_pip_computer_view',pip_id:PIP.id,op:'frame',number:2},undefined,t).call.number,2);
 const other=h.ask({type:'use_pip_computer_view',pip_id:PIP.id,op:'frame',number:1},undefined,t);assert.equal(other.call,undefined);assert.equal(other.reply.ok,false);
 const rename=h.ask({type:'rename_pip_computer',pip_id:PIP.id,number:2,name:'Mine'},undefined,t);assert.equal(rename.call,undefined);assert.equal(rename.reply.ok,false);
});

test('one stream per Pip: the screen goes to the tab that opened it last, the other says where it is showing',()=>{
 const h=host(86,{pips_desktop:1,pips_desktop_numbers:1});h.know();
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:1});h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});
 const [one,two]=h.panels;one.receive({type:'pipsReady'});two.receive({type:'pipsReady'});
 assert.equal(one.posted.find(m=>m.type==='pipComputerInit').numbers,true);
 one.receive({type:'pipDesktop',op:'open',number:1});
 assert.deepEqual(h.desktop().at(-1),{type:'pip_desktop',pip_id:PIP.id,op:'open',number:1});
 h.editor.event({type:'pip_desktop_data',pip_id:PIP.id,data:'AQID'});
 assert.deepEqual(one.posted.at(-1),{type:'pipDesktopData',data:'AQID'});
 two.receive({type:'pipDesktop',op:'open',number:2});
 assert.deepEqual(h.desktop().at(-1),{type:'pip_desktop',pip_id:PIP.id,op:'open',number:2});
 assert.deepEqual(one.posted.at(-1),{type:'pipDesktopElsewhere',number:2,name:'Wren'},'the first tab is told where the screen went');
 h.editor.event({type:'pip_desktop_data',pip_id:PIP.id,data:'BBBB'});
 assert.deepEqual(two.posted.at(-1),{type:'pipDesktopData',data:'BBBB'});
 assert.equal(one.posted.at(-1).type,'pipDesktopElsewhere','the bytes go to the one tab only');
 const before=h.desktop().length;
 one.receive({type:'pipDesktop',op:'send',data:'AQID'});one.receive({type:'pipDesktop',op:'close'});
 assert.equal(h.desktop().length,before,'the tab without the stream can neither type into it nor close it');
 two.receive({type:'pipDesktop',op:'send',data:'AQID'});
 assert.deepEqual(h.desktop().at(-1),{type:'pip_desktop',pip_id:PIP.id,op:'send',data:'AQID'});
 // Show here: the stream comes back, and the other tab is told.
 one.receive({type:'pipDesktop',op:'open',number:1});
 assert.deepEqual(h.desktop().at(-1),{type:'pip_desktop',pip_id:PIP.id,op:'open',number:1});
 assert.deepEqual(two.posted.at(-1),{type:'pipDesktopElsewhere',number:1,name:'Juniper'});
 const count=h.desktop().length;
 two.dispose();assert.equal(h.desktop().length,count,'closing the tab without the stream leaves the stream alone');
 h.editor.event({type:'pip_desktop_closed',pip_id:PIP.id,reason:'closed'});assert.deepEqual(one.posted.at(-1),{type:'pipDesktopClosed',reason:'closed'});
 one.receive({type:'pipDesktop',op:'open',number:1});
 one.dispose();assert.deepEqual(h.desktop().at(-1),{type:'pip_desktop',pip_id:PIP.id,op:'close'},'closing the tab that has it closes it');
 // A tab is its own computer: it can't ask for another's screen.
 h.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});const again=h.panels.at(-1),was=h.desktop().length;
 again.receive({type:'pipDesktop',op:'open',number:1});assert.equal(h.desktop().length,was);
 // A CLI that streams but doesn't take a number is never sent one.
 const plain=host(86,{pips_desktop:1});plain.know();plain.editor.receive({type:'pipsOpenComputer',pip:PIP,number:2});
 plain.panels[0].receive({type:'pipsReady'});assert.equal(plain.panels[0].posted.find(m=>m.type==='pipComputerInit').numbers,false);
 plain.panels[0].receive({type:'pipDesktop',op:'open'});
 assert.deepEqual(plain.desktop(),[{type:'pip_desktop',pip_id:PIP.id,op:'open'}]);
});

test('a computer\'s tab says which computer it is: its name in the header, its number with every open and view',async()=>{
 const x=tab({init:{number:2,name:'Wren',numbers:true}});await x.drain();
 assert.equal(x.d.querySelector('.pc-title h1').textContent,'Shopper · Wren');
 assert.equal(x.d.title,'Shopper · Wren');
 x.click('[data-app=browser]');await x.drain();await x.tick();
 assert.deepEqual(x.requests('open_pip_computer').map(r=>r.number),[2]);
 assert.ok(x.requests('use_pip_computer_view').length>=2);
 assert.ok(x.requests('use_pip_computer_view').every(r=>r.number===2),'every view names its computer');
 // A rename, told by the host or seen in its own look, retitles the header.
 x.message({type:'pipComputerNames',names:[{number:1,name:'Juniper'},{number:2,name:'Travel'}]});
 assert.equal(x.d.querySelector('.pc-title h1').textContent,'Shopper · Travel');
 x.setState(computer({names:[NAMES[0],{...NAMES[1],name:'Trips',named:true}]}));await x.tick();
 assert.equal(x.d.querySelector('.pc-title h1').textContent,'Shopper · Trips');
 // No number: as before, on any runtime.
 const plain=tab({status:computer({computers:1,names:[NAMES[0]]})});await plain.drain();plain.click('[data-app=browser]');await plain.drain();
 assert.equal(plain.d.querySelector('.pc-title h1').textContent,'Shopper · Computer');
 assert.equal(plain.sent.some(m=>JSON.stringify(m).includes('"number"')),false);
 // Below API 86 a number is never sent, whatever the tab was told.
 const old=tab({api:85,init:{number:2,name:'Wren',numbers:true},status:computer({names:undefined,screen:undefined,screens:undefined})});await old.drain();old.click('[data-app=browser]');await old.drain();
 assert.equal(old.requests('open_pip_computer').length,1);
 assert.equal(old.sent.some(m=>JSON.stringify(m).includes('"number"')),false,'never below API 86');
});

test('the screen: the open names its computer, and a tab whose stream moved says "Showing Juniper in another tab" with Show here',async()=>{
 const {Viewer,made}=fakeViewer();
 const x=tab({init:{number:2,name:'Wren',numbers:true},screen:true,viewer:Viewer});await x.drain();
 const own=v=>JSON.parse(JSON.stringify(v));   // (made in the page's realm: compared by what they hold)
 const opens=()=>own(x.sent.filter(m=>m.type==='pipDesktop'&&m.op==='open'));
 assert.deepEqual(opens(),[{type:'pipDesktop',op:'open',number:2}]);
 x.message({type:'pipDesktopData',data:Buffer.from('RFB 003.008\n').toString('base64')});made[0].listeners.connect();
 x.message({type:'pipDesktopElsewhere',number:1,name:'Juniper'});
 assert.equal(x.d.querySelector('.pc-overlay p').textContent,'Showing Juniper in another tab');
 assert.equal(x.d.querySelector('#pc-show-here').textContent,'Show here');
 assert.ok(made[0].closed,'its viewer lets go');
 assert.equal(x.sent.filter(m=>m.type==='pipDesktop'&&m.op==='close').length,0,'and it does not close the stream the other tab now has');
 await x.tick();await x.tick();
 assert.equal(opens().length,1,'it never takes the screen back by itself');
 x.click('#pc-show-here');
 assert.equal(made.length,2);assert.deepEqual(opens().at(-1),{type:'pipDesktop',op:'open',number:2});
 assert.match(x.d.querySelector('.pc-overlay').textContent,/Opening Shopper's screen/);
 // A CLI that takes no number for the screen, or a runtime before 86: the open says none.
 for(const opts of [{init:{number:2,name:'Wren',numbers:false}},{api:85,init:{number:2,name:'Wren',numbers:true},status:computer({names:undefined,screen:undefined,screens:undefined})}]){
  const y=tab({...opts,screen:true,viewer:fakeViewer().Viewer});await y.drain();
  assert.deepEqual(own(y.sent.filter(m=>m.type==='pipDesktop')),[{type:'pipDesktop',op:'open'}]);
 }
});
