import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// A Pip's computer as an editor tab (Pips API 43), like Grok's bots: "Gmail · Computer" with its
// Browser, Files and Terminal. The host opens one tab per Pip and pins it to that Pip's computer.
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'};
const OTHER='pip_'+'o'.repeat(32);
const JPEG='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const actionId='compact_'+'c'.repeat(32);
const hold={id:actionId,pip_id:PIP.id,workspace_id:'ws',run_id:'run_'+'b'.repeat(32),summary:{method:'POST',host:'shop.example',path:'/order',page:'https://shop.example/cart',fields:[],more_fields:0,body_bytes:14},digest:'d'.repeat(64),frame:null,status:'pending',created_at:'2026-10-06T09:00:00.000Z',expires_at:'2026-10-07T09:00:00.000Z',resolved_at:null,resolved_by:null,continuation_run_id:null};
const computer=(extra={})=>({pip_id:PIP.id,granted:true,available:true,reason:'',pending:0,actions:[],...extra});
async function flush(){for(let i=0;i<14;i++)await Promise.resolve();}
const viewModule=(stub={})=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?stub:require(name));return out.exports;};

function setup({desktop=null,screen=false,viewer=null,status=computer(),files={'':[{name:'Downloads',kind:'folder',bytes:null,modified:1},{name:'notes.txt',kind:'file',bytes:12,modified:2}],Downloads:[{name:'report.pdf',kind:'file',bytes:2048,modified:3}]},terminal={entries:[],running:null}}={}){
 const dom=new JSDOM(viewModule().computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),timers=[];let state=status,term=terminal;
 w.setInterval=fn=>{timers.push({fn,live:true});return timers.length;};w.clearInterval=id=>{if(timers[id-1])timers[id-1].live=false;};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 if(viewer)w.__dgcTestRFB=viewer;w.eval(code);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(request,result,ok=true)=>{answered.add(request.id);message({type:'pipsReply',id:request.id,ok,...(ok?{result}:{error:result})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({get_pip_computer:()=>({computer:state}),open_pip_computer:()=>({view:{pip_id:PIP.id,ready:true}}),
  use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://shop.example/',width:1280,height:800,image:JPEG}}),
  list_pip_computer_files:()=>({path:r.path,entries:files[r.path]||[],more:false,total_bytes:2060}),
  read_pip_computer_file:()=>({path:r.path,name:r.path.split('/').at(-1),mime:'text/plain',bytes:12,text:'buy milk\n',truncated:false}),
  list_pip_computer_terminal:()=>term,run_pip_computer_command:()=>({running:{by:'you',command:r.command,at:1}}),
  remove_pip_computer_file:()=>({path:r.path,removed:true}),add_pip_computer_file:()=>({path:r.name,name:r.name,bytes:3}),
  decide_pip_computer_action:()=>({action:{...hold,status:r.approve?'approved':'rejected'}}),stop_pip_computer:()=>({pip_id:PIP.id,stopping:true}),
  get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,available:true,reason:'',install:'',using:false,browser:'Google Chrome',chrome_install:'',...(desktop||{})}})}[r.type]?.());
 async function drain(overrides={}){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=m.request.type in overrides?overrides[m.request.type](m.request):defaults(m.request);if(result!==undefined){answer(m,result);count++;}}if(!count)break;}await flush();}
 message({type:'pipComputerInit',pip:PIP,desktop:screen});
 message({type:'pipsConnection',generation:7,apiVersion:43,connected:true,supported:true,enabled:true});
 return {w,d:w.document,sent,timers,answer,requests,drain,message,setState:s=>{state=s;},setTerminal:t=>{term=t;},
  click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.dispatchEvent(new w.MouseEvent('click',{bubbles:true,clientX:el._x||0,clientY:el._y||0}));},
  submit:s=>w.document.querySelector(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})),
  tick:async(overrides={})=>{for(const t of timers.filter(t=>t.live))t.fn();await drain(overrides);}};
}

test('the tab is a desktop with nothing open, a dock of three apps below; the Browser opens in a window from the dock',async()=>{
 const x=setup();await x.drain();
 assert.match(x.d.querySelector('.pc-title h1').textContent,/Shopper · Computer/);
 assert.deepEqual([...x.d.querySelectorAll('.pc-dock [data-app]')].map(b=>b.getAttribute('aria-label')),['Browser','Files','Terminal']);
 // The founder: "lets show default OS screen, with nothing opened".
 assert.equal(x.d.querySelector('.pc-window'),null,'the bare desktop');
 assert.equal(x.d.querySelectorAll('.pc-dock .open').length,0,'nothing open in the dock');
 assert.equal(x.requests('open_pip_computer').length,0,'opening the tab starts no browser');
 x.click('[data-app=browser]');await x.drain();
 assert.equal(x.d.querySelector('.pc-window').getAttribute('aria-label'),'Browser');
 assert.ok(x.d.querySelector('.pc-dock [data-app=browser]').classList.contains('open'),'a dot under the open app');
 assert.equal(x.requests('open_pip_computer').length,1);
 assert.equal(x.d.querySelector('#pc-screen').getAttribute('src'),JPEG);
 assert.equal(x.d.querySelector('#pc-url').value,'https://shop.example/');
 assert.ok(x.d.querySelector('.pc-face .dgc-plush'),'its face is in the header');
 assert.ok(x.sent.filter(m=>m.type==='pipsRequest').every(m=>m.generation===7),'every request carries the connection generation');
 await x.tick();assert.ok(x.requests('use_pip_computer_view').length>=2,'the screen keeps refreshing');
});

test('a busy page\'s full-size screen shows (an inbox frame is often over 100 KB)',async()=>{
 const big='data:image/jpeg;base64,/9j/'+'A'.repeat(400_000);
 const x=setup();await x.drain();x.click('[data-app=browser]');await x.drain({use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://mail.google.com/',width:1280,height:800,image:big}})});
 assert.equal(x.d.querySelector('#pc-screen').getAttribute('src'),big);
});

test('minimise or close a window to see the desktop; the browser comes back when the Pip starts using it',async()=>{
 const x=setup();await x.drain();x.click('[data-app=browser]');await x.drain();
 x.click('[data-minimize=browser]');assert.equal(x.d.querySelector('.pc-window'),null,'the bare desktop');
 assert.ok(x.d.querySelector('.pc-dock [data-app=browser]').classList.contains('open'),'still open in the dock');
 x.click('[data-app=terminal]');await x.drain();x.click('[data-close=terminal]');
 assert.equal(x.d.querySelector('.pc-window'),null);assert.ok(!x.d.querySelector('.pc-dock [data-app=terminal]').classList.contains('open'));
 await x.tick();assert.equal(x.d.querySelector('.pc-window'),null,'nothing opens while the Pip is idle');
 await x.tick({use_pip_computer_view:()=>({view:{ok:true,watching:true,url:'https://mail.google.com/',width:1280,height:800,image:JPEG}})});
 assert.equal(x.d.querySelector('.pc-window')?.getAttribute('aria-label'),'Browser','its browser comes up so you can watch');
 assert.match(x.d.querySelector('.pc-status').textContent,/is using its computer/);
});

test('you drive the screen: a click lands at the same point of the page, typing and keys go to it',async()=>{
 const x=setup();await x.drain();x.click('[data-app=browser]');await x.drain();
 const img=x.d.querySelector('#pc-screen');img.getBoundingClientRect=()=>({left:10,top:20,width:640,height:400});img._x=10+320;img._y=20+100;
 x.click('#pc-screen');await x.drain();
 const click=x.requests('use_pip_computer_view').find(m=>m.request.op==='click');
 assert.deepEqual([click.request.x,click.request.y],[640,200],'scaled to the page');
 x.d.querySelector('.pc-screen').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await x.drain();
 assert.ok(x.requests('use_pip_computer_view').some(m=>m.request.op==='key'&&m.request.key==='Enter'));
 x.d.querySelector('#pc-url').value='kettles';x.submit('#pc-go');await x.drain();
 assert.ok(x.requests('use_pip_computer_view').some(m=>m.request.op==='go'&&m.request.url==='https://duckduckgo.com/?q=kettles'),'words search');
});

test('what you type in the address bar stays while the screen refreshes; Escape, leaving it and Go show the page\'s address',async()=>{
 const x=setup();await x.drain();x.click('[data-app=browser]');await x.drain();
 const bar=()=>x.d.querySelector('#pc-url');
 bar().focus();bar().value='example.or';bar().dispatchEvent(new x.w.Event('input',{bubbles:true}));
 await x.tick();await x.tick();
 // The founder: "i am trying to type an address, and it auto removes, as soon as i type a letter".
 assert.equal(bar().value,'example.or','two refreshes later, still what you typed');
 assert.equal(x.d.activeElement,bar(),'and still where you are typing');
 bar().dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(bar().value,'https://shop.example/','Escape shows the page\'s address again');
 bar().focus();bar().value='kettle shops';bar().dispatchEvent(new x.w.Event('input',{bubbles:true}));
 x.submit('#pc-go');await x.drain();
 assert.ok(x.requests('use_pip_computer_view').some(m=>m.request.op==='go'&&m.request.url==='https://duckduckgo.com/?q=kettle%20shops'));
 assert.equal(bar().value,'https://shop.example/','after Go the bar follows the page again');
 bar().focus();bar().value='half typed';bar().dispatchEvent(new x.w.Event('input',{bubbles:true}));
 x.d.querySelector('#pc-back').focus();await new Promise(r=>setTimeout(r,5));
 assert.equal(bar().value,'https://shop.example/','leaving the bar puts the page\'s address back');
});

test('what the Pip would submit waits at the top with Send once, Always allow and Reject',async()=>{
 const x=setup({status:computer({pending:1,actions:[hold]})});await x.drain();
 assert.match(x.d.querySelector('.pc-waiting').textContent,/Send a form to shop.example/);
 assert.match(x.d.querySelector('.pc-status').textContent,/1 waiting for you/);
 x.click(`[data-send="${actionId}"]`);await x.drain();
 const decided=x.requests('decide_pip_computer_action')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(decided.request)),{type:'decide_pip_computer_action',action_id:actionId,expected_digest:'d'.repeat(64),approve:true});
 assert.match(x.d.body.textContent,/Approved/);
});

test('a payment waits with Send once and Reject, never Always allow',async()=>{
 const x=setup({status:computer({pending:1,actions:[{...hold,summary:{...hold.summary,payment:true}}]})});await x.drain();
 assert.ok(x.d.querySelector(`[data-send="${actionId}"]`));assert.ok(x.d.querySelector(`[data-reject="${actionId}"]`));
 assert.equal(x.d.querySelector(`[data-always="${actionId}"]`),null,'a payment asks every time');
 const plain=setup({status:computer({pending:1,actions:[hold]})});await plain.drain();
 assert.ok(plain.d.querySelector(`[data-always="${actionId}"]`),'any other submit can be always allowed');
});

test('careful mode: a new site waits as "Let Shopper visit…" with Allow this site and Not now, never Always allow',async()=>{
 const site={...hold,summary:{kind:'site',site:'shop.example',shown:'shop.example',method:'GET',host:'shop.example',path:'/',page:'https://shop.example/',fields:[],more_fields:0,body_bytes:0}};
 const x=setup({status:computer({pending:1,actions:[site]})});await x.drain();
 const card=x.d.querySelector('.pc-waiting');
 assert.match(card.textContent,/Let Shopper visit shop\.example\?It hasn’t opened shop\.example for you before/);
 assert.deepEqual([...card.querySelectorAll('button')].map(b=>b.textContent),['Allow this site','Not now']);
 x.click(`[data-send="${actionId}"]`);await x.drain();
 assert.equal(x.requests('decide_pip_computer_action')[0].request.approve,true);
 assert.match(x.d.body.textContent,/Allowed\. It opens the site and carries on\./);
});

test('Files shows the computer\'s own folder: open folders, preview, save, remove and add',async()=>{
 const x=setup();await x.drain();x.click('[data-app=files]');await x.drain();
 assert.equal(x.requests('list_pip_computer_files')[0].request.path,'');
 assert.deepEqual([...x.d.querySelectorAll('.pc-name')].map(e=>e.textContent),['Downloads','notes.txt']);
 x.click('[data-folder="Downloads"]');await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('.pc-name')].map(e=>e.textContent),['report.pdf']);
 x.click('[data-crumb="0"]');await x.drain();
 x.click('[data-file="notes.txt"]');await x.drain();
 assert.equal(x.d.querySelector('.pc-text').textContent,'buy milk\n');
 x.click('#pc-save');
 assert.deepEqual(x.sent.filter(m=>m.type==='pipComputerSave').map(m=>[m.name,m.text]),[['notes.txt','buy milk\n']],'the host saves it where you choose');
 x.click('#pc-remove');await x.drain();
 assert.equal(x.requests('remove_pip_computer_file')[0].request.path,'notes.txt');
 const file=new x.w.File(['hey'],'hi.txt',{type:'text/plain'}),input=x.d.querySelector('#pc-add-input');
 Object.defineProperty(input,'files',{value:[file],configurable:true});input.dispatchEvent(new x.w.Event('change',{bubbles:true}));
 for(let i=0;i<40&&!x.requests('add_pip_computer_file').length;i++){await new Promise(r=>setTimeout(r,5));await flush();}
 const added=x.requests('add_pip_computer_file')[0];
 assert.equal(added.request.name,'hi.txt');assert.match(added.request.data,/^data:text\/plain;base64,/);
});

test('the Terminal runs your command and shows yours and the Pip\'s, with no internet',async()=>{
 const pipRan={by:'pip',command:'ls Downloads',exit:0,output:'report.pdf\n',timed_out:false,seconds:0.1,at:1};
 const x=setup({terminal:{entries:[pipRan],running:null}});await x.drain();x.click('[data-app=terminal]');await x.drain();
 assert.match(x.d.querySelector('.pc-log').textContent,/Shopper \$ ls Downloads/);
 assert.match(x.d.querySelector('.pc-terminal').textContent,/Online: commands can reach public websites/);
 x.d.querySelector('#pc-command').value='wc -l notes.txt';x.submit('#pc-run');await x.drain();
 assert.equal(x.requests('run_pip_computer_command')[0].request.command,'wc -l notes.txt');
 x.setTerminal({entries:[pipRan,{by:'you',command:'wc -l notes.txt',exit:0,output:'1 notes.txt\n',timed_out:false,seconds:0.1,at:2}],running:null});
 await x.tick();
 assert.match(x.d.querySelector('.pc-log').textContent,/You \$ wc -l notes.txt\s*1 notes.txt/);
});

function host(api=43){
 const panels=[],saved=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>({path:p.map(x=>x.path||x).join('/')}),file:p=>({path:p})},
  workspace:{workspaceFolders:[],fs:{writeFile:async(uri,data)=>{saved.push([uri.path,Buffer.from(data).toString()]);}}},
  window:{showSaveDialog:async()=>({path:'/home/me/notes.txt'}),createWebviewPanel:(id,title)=>{const p={id,title,revealed:0,posted:[],receive:null,dispose:null,
   webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
   reveal(){p.revealed++;},onDidDispose:f=>{p.dispose=f;},onDidChangeViewState(){} };panels.push(p);return p;}}};
 const {PipsEditor}=viewModule(vscode);const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 return {editor,panels,main,sent,saved,generation:()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation};
}

test('the host opens one "Shopper · Computer" tab per Pip, and only on an API 43 CLI',()=>{
 const old=host(42);old.editor.receive({type:'pipsOpenComputer',pip:PIP});assert.equal(old.panels.length,0);
 const h=host();
 for(const bad of [{...PIP,id:'../x'},{...PIP,name:''},{...PIP,pip_type:'robot'}])h.editor.receive({type:'pipsOpenComputer',pip:bad});
 assert.equal(h.panels.length,0);
 h.editor.receive({type:'pipsOpenComputer',pip:PIP});h.editor.receive({type:'pipsOpenComputer',pip:PIP});
 assert.equal(h.panels.length,1);assert.equal(h.panels[0].title,'Shopper · Computer');assert.equal(h.panels[0].revealed,1,'a second open brings it forward');
 h.panels[0].receive({type:'pipsReady'});
 assert.deepEqual(h.panels[0].posted.map(m=>m.type),['pipComputerInit','pipsConnection']);
 assert.deepEqual(h.panels[0].posted[0].pip,PIP);
});

test('a computer tab asks only about its own Pip\'s computer, and its replies come back to it',()=>{
 const h=host();h.editor.receive({type:'pipsOpenComputer',pip:PIP});const tab=h.panels[0],g=h.generation();
 tab.receive({type:'pipsRequest',id:'a',generation:g,request:{type:'archive_pip',pip_id:PIP.id}});
 tab.receive({type:'pipsRequest',id:'b',generation:g,request:{type:'list_pip_computer_files',pip_id:OTHER,path:''}});
 assert.equal(h.sent.length,0);assert.deepEqual(tab.posted.filter(m=>m.type==='pipsReply').map(m=>m.ok),[false,false]);
 tab.receive({type:'pipsRequest',id:'c',generation:g,request:{type:'run_pip_computer_command',pip_id:PIP.id,command:'ls'}});
 assert.equal(h.sent.length,1);
 const id=h.sent[0].request.request_id;
 h.editor.event({type:'pips_result',request_id:id,command:'run_pip_computer_command',ok:true,result:{running:{by:'you',command:'ls',at:1}}});
 assert.equal(tab.posted.at(-1).id,'c');assert.equal(tab.posted.at(-1).ok,true);
 assert.equal(h.main.filter(m=>m.type==='pipsReply').length,0,'never to the Pips view');
 const photo='data:application/pdf;base64,'+'A'.repeat(1_900_000);
 tab.receive({type:'pipsRequest',id:'d',generation:g,request:{type:'add_pip_computer_file',pip_id:PIP.id,path:'',name:'scan.pdf',data:photo}});
 assert.equal(h.sent.length,2,'a 1.4 MB file passes the host');
 tab.receive({type:'pipsRequest',id:'e',generation:g,request:{type:'add_pip_computer_file',pip_id:PIP.id,path:'',name:'x'.repeat(20000),data:photo}});
 assert.equal(h.sent.length,2,'the rest of the request keeps its bound');
 tab.dispose();
 h.editor.receive({type:'pipsOpenComputer',pip:PIP});assert.equal(h.panels.length,2,'closed, it opens afresh');
});

test('Save to… writes the file where you choose, from the host',async()=>{
 const h=host();h.editor.receive({type:'pipsOpenComputer',pip:PIP});const tab=h.panels[0];
 tab.receive({type:'pipComputerSave',name:'notes.txt',text:'buy milk\n'});
 for(let i=0;i<20&&!h.saved.length;i++)await new Promise(r=>setTimeout(r,1));
 assert.deepEqual(h.saved,[['/home/me/notes.txt','buy milk\n']]);
 await new Promise(r=>setTimeout(r,1));
 assert.equal(tab.posted.at(-1).type,'pipComputerSaved');assert.equal(tab.posted.at(-1).ok,true);
});

function fakeViewer(){
 const made=[];
 class Viewer{constructor(target,channel,options){this.target=target;this.channel=channel;this.options=options;this.listeners={};made.push(this);
  channel.onopen=()=>{this.opened=true;};channel.onmessage=e=>{(this.got||=[]).push(new Uint8Array(e.data));};channel.onclose=e=>{this.closed=e;};}
  addEventListener(kind,fn){this.listeners[kind]=fn;}}
 return {Viewer,made};
}

test('with the desktop installed, the tab is the Pip\'s real screen, streamed through the host',async()=>{
 const {Viewer,made}=fakeViewer();
 const x=setup({screen:true,viewer:Viewer});await x.drain();
 assert.equal(made.length,1,'one viewer');assert.equal(made[0].target.id,'pc-vnc');
 assert.deepEqual(x.sent.filter(m=>m.type==='pipDesktop').map(m=>m.op),['open']);
 assert.equal(x.requests('use_pip_computer_view').length,0,'no screenshots: the screen streams itself');
 assert.match(x.d.querySelector('.pc-overlay').textContent,/Opening Shopper's screen/);
 x.message({type:'pipDesktopData',data:Buffer.from('RFB 003.008\n').toString('base64')});
 assert.ok(made[0].opened,'the first bytes open the channel');assert.equal(Buffer.from(made[0].got[0]).toString(),'RFB 003.008\n');
 made[0].listeners.connect();assert.equal(x.d.querySelector('.pc-overlay').textContent,'');
 made[0].channel.send(new Uint8Array([1,2,3]).buffer);
 assert.deepEqual(x.sent.filter(m=>m.type==='pipDesktop'&&m.op==='send').map(m=>m.data),[Buffer.from([1,2,3]).toString('base64')]);
 x.message({type:'pipDesktopClosed',reason:'The computer\'s screen closed.'});
 assert.match(x.d.querySelector('.pc-overlay').textContent,/screen closed/);assert.ok(made[0].closed);
 x.click('#pc-reconnect');
 assert.equal(made.length,2);assert.deepEqual(x.sent.filter(m=>m.type==='pipDesktop').map(m=>m.op),['open','send','open']);
});

test('the first time, DGC sets the desktop up itself: the tab shows how far it has got, then opens the screen',async()=>{
 // The founder: "why does my system need that? Doesn't a Pip create its own virtual OS?"
 const {Viewer,made}=fakeViewer(),MB=1048576;
 const running=(done,step='Downloading Google Chrome and the desktop')=>({available:false,reason:"Setting up this computer's desktop.",install:'',using:false,browser:'Chromium',chrome_install:'',setup:{state:'running',step,done,total:133*MB,error:''}});
 const x=setup({screen:true,viewer:Viewer,desktop:running(44*MB)});await x.drain();
 const note=()=>x.d.querySelector('.pc-setup');
 // Plain words: the founder, "lets not show Downloading Google Chrome and desktop ... just Setting up your Pip".
 assert.match(note().textContent,/Setting up your Pip…/);
 assert.match(note().textContent,/Getting its computer ready. This happens once./);
 assert.doesNotMatch(note().textContent,/Chrome|MB|Downloading|package/,'no technical words');
 assert.equal(note().querySelector('[role=progressbar]').getAttribute('aria-valuenow'),'30','downloading is most of the bar');
 assert.equal(x.d.querySelector('.pc-install'),null,'no sudo command while DGC does it');
 assert.equal(x.sent.filter(m=>m.type==='pipDesktop').length,0,'no screen yet');
 await x.tick({get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,...running(133*MB)}})});
 assert.equal(note().querySelector('[role=progressbar]').getAttribute('aria-valuenow'),'90','it looks again on its own while setting up');
 await x.tick({get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,...running(0,'Unpacking'),setup:{state:'running',step:'Unpacking',done:3,total:19,error:''}}})});
 assert.equal(note().querySelector('[role=progressbar]').getAttribute('aria-valuenow'),'92','unpacking finishes the bar');
 await x.tick({get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,available:true,reason:'',install:'',using:false,browser:'Google Chrome',chrome_install:'',setup:{state:'ready',step:'',done:0,total:0,error:''}}})});
 assert.equal(note(),null);
 assert.equal(made.length,1,'the screen opens when it is ready');
 assert.deepEqual(x.sent.filter(m=>m.type==='pipDesktop').map(m=>m.op),['open']);
});

test('a failed setup says why, offers the install command, and an invalid setup report is not shown',async()=>{
 const {Viewer}=fakeViewer();
 const x=setup({screen:true,viewer:Viewer,desktop:{available:false,reason:'Updating package lists failed: E: unsigned. You can also install them, then open the computer again.',
  install:'sudo apt install tigervnc-standalone-server openbox tint2 xterm pcmanfm',setup:{state:'failed',step:'',done:0,total:0,error:'Updating package lists failed: E: unsigned.'}}});await x.drain();
 assert.equal(x.d.querySelector('.pc-setup'),null);
 assert.match(x.d.querySelector('.pc-install').textContent,/Updating package lists failed.*sudo apt install tigervnc-standalone-server/s);
 const y=setup({screen:true,viewer:Viewer,desktop:{available:false,reason:'x',install:'',setup:{state:'downloading',step:'',done:0,total:0,error:''}}});await y.drain();
 assert.equal(y.d.querySelector('.pc-setup'),null,'an unknown state is refused, not half-shown');
});

test('while the Pip uses its computer the screen says so; without the desktop it says what to install',async()=>{
 const {Viewer,made}=fakeViewer();
 const x=setup({screen:true,viewer:Viewer,desktop:{using:true}});await x.drain();
 x.message({type:'pipDesktopData',data:Buffer.from('x').toString('base64')});made[0].listeners.connect();
 assert.match(x.d.querySelector('.pc-overlay').textContent,/Shopper is using its computer/);
 assert.match(x.d.querySelector('.pc-status').textContent,/is using its computer/);
 const y=setup({screen:true,viewer:Viewer,desktop:{available:false,reason:'The desktop needs Xtigervnc.',install:'sudo apt install tigervnc-standalone-server openbox tint2 xterm pcmanfm'}});await y.drain();
 assert.ok(y.d.querySelector('.pc-dock'),'the drawn desktop stays');
 assert.match(y.d.querySelector('.pc-install').textContent,/sudo apt install tigervnc-standalone-server/);
 assert.equal(y.sent.filter(m=>m.type==='pipDesktop').length,0);
 const old=setup({screen:false,viewer:Viewer});await old.drain();
 assert.equal(old.requests('get_pip_computer_desktop').length,0,'a CLI without the stream is never asked');
});

test('the host relays the screen for its own tab only, and only to a CLI that streams it',()=>{
 const make=desktop=>{const h=host();h.editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:43,...(desktop?{pips_desktop:1}:{})},{});h.editor.receive({type:'pipsOpenComputer',pip:PIP});return h;};
 const h=make(true),tab=h.panels.at(-1);
 tab.receive({type:'pipsReady'});assert.equal(tab.posted.find(m=>m.type==='pipComputerInit').desktop,true);
 tab.receive({type:'pipDesktop',op:'open'});tab.receive({type:'pipDesktop',op:'send',data:'AQID'});
 tab.receive({type:'pipDesktop',op:'send',data:'not base64!'});tab.receive({type:'pipDesktop',op:'erase'});
 assert.deepEqual(h.sent.filter(m=>m.type==='pip_desktop').map(m=>[m.pip_id,m.op,m.data]),[[PIP.id,'open',undefined],[PIP.id,'send','AQID']]);
 assert.equal(h.editor.event({type:'pip_desktop_data',pip_id:PIP.id,data:'AQID'}),true);
 assert.deepEqual(tab.posted.at(-1),{type:'pipDesktopData',data:'AQID'});
 h.editor.event({type:'pip_desktop_data',pip_id:OTHER,data:'BBBB'});assert.equal(tab.posted.at(-1).data,'AQID','another Pip\'s screen never reaches this tab');
 h.editor.event({type:'pip_desktop_closed',pip_id:PIP.id,reason:'closed'});assert.deepEqual(tab.posted.at(-1),{type:'pipDesktopClosed',reason:'closed'});
 tab.dispose();assert.deepEqual(h.sent.filter(m=>m.type==='pip_desktop').at(-1),{type:'pip_desktop',pip_id:PIP.id,op:'close'},'closing the tab closes its stream');
 const old=make(false),oldTab=old.panels.at(-1);oldTab.receive({type:'pipsReady'});
 assert.equal(oldTab.posted.find(m=>m.type==='pipComputerInit').desktop,false);
 oldTab.receive({type:'pipDesktop',op:'open'});assert.equal(old.sent.filter(m=>m.type==='pip_desktop').length,0);
});
