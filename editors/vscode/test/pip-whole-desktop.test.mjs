// Pips use the whole desktop (Pips API 54): the computer tab offers, once and in one line, to download the image
// editor, document editor and PDF viewer this computer lacks; an older CLI is never asked.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const tabCode=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const viewCode=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const pure=(await build({entryPoints:[src+'pipsModel.js'],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const view=load(viewCode,name=>name==='vscode'?{}:require(name)),model=load(pure);
const windows=[];after(()=>windows.forEach(w=>w.close()));
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const JPEG='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'};
const APPS=[{key:'images',name:'Image editor',program:'LibreOffice Draw',available:false},{key:'documents',name:'Documents',program:'LibreOffice Writer',available:false},
 {key:'pdf',name:'PDF viewer',program:'Evince',available:true}];
const LINE='Add an image editor and a document editor to this computer? DGC downloads LibreOffice from your system\'s own package servers into its own folder: 79 MB, once.';
const offer={apps:APPS,missing:['images','documents'],state:'offer',line:LINE,bytes:79_000_000};

function tab({apiVersion=54,apps=offer}={}){
 const dom=new JSDOM(view.computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),timers=[];let current=apps;
 w.setInterval=fn=>{timers.push({fn,live:true});return timers.length;};w.clearInterval=id=>{if(timers[id-1])timers[id-1].live=false;};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(tabCode);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({get_pip_computer:()=>({computer:{pip_id:PIP.id,granted:true,available:true,reason:'',pending:0,actions:[]}}),
  use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://shop.example/',width:1280,height:800,image:JPEG}}),
  get_pip_computer_apps:()=>({apps:current}),
  set_pip_computer_apps:()=>{current=r.choice==='download'?{...offer,state:'downloading',line:'Downloading LibreOffice for its image editor and document editor…',bytes:null}
   :{...offer,state:'declined',line:'',bytes:null};return {apps:current};}}[r.type]?.());
 async function drain(){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answered.add(m.id);message({type:'pipsReply',id:m.id,ok:true,result});count++;}}if(!count)break;}}
 message({type:'pipComputerInit',pip:PIP,desktop:false});
 message({type:'pipsConnection',generation:7,apiVersion,connected:true,supported:true,enabled:true});
 return {w,d:w.document,sent,requests,drain,
  click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));}};
}

test('a computer that lacks its apps offers them once, in one line that says what and how big',async()=>{
 const x=tab();await x.drain();
 const line=x.d.querySelector('.pc-apps');
 assert.ok(line,'the offer is shown');
 assert.equal(line.querySelector('span').textContent,LINE);
 assert.deepEqual([...line.querySelectorAll('button')].map(b=>b.textContent),['Download','Not now']);
 x.click('[data-apps=download]');await x.drain();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('set_pip_computer_apps')[0].request)),{type:'set_pip_computer_apps',choice:'download'});
 assert.match(x.d.querySelector('.pc-apps').textContent,/Downloading LibreOffice/);
 assert.match(x.d.body.textContent,/Its apps appear on its dock when they are ready/);
 const later=tab();await later.drain();later.click('[data-apps=not_now]');await later.drain();
 assert.equal(later.d.querySelector('.pc-apps'),null,'declined: it never asks again');
 const ready=tab({apps:{apps:APPS.map(a=>({...a,available:true})),missing:[],state:'ready',line:'',bytes:null}});await ready.drain();
 assert.equal(ready.d.querySelector('.pc-apps'),null,'nothing to show when every app is here');
});

test('an older CLI is never asked about apps',async()=>{
 const old=tab({apiVersion:53});await old.drain();
 assert.equal(old.requests('get_pip_computer_apps').length,0);
 assert.equal(old.d.querySelector('.pc-apps'),null);
});

test('the apps reply is checked before it is shown',()=>{
 assert.deepEqual(model.pipComputerApps(offer),offer);
 for(const bad of [{...offer,state:'maybe'},{...offer,extra:1},{...offer,bytes:-1},{...offer,apps:[{...APPS[0],key:'games'}]},{...offer,missing:['games']},{...offer,line:7}])
  assert.throws(()=>model.pipComputerApps(bad),/apps didn't load/);
});

test('the extension host asks only an API 54 CLI about a computer\'s apps',()=>{
 for(const api of [53,54]){
  const posted=[],sent=[];const editor=new view.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
  editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  editor.receive({type:'pipsRequest',id:'get',request:{type:'get_pip_computer_apps'}});
  editor.receive({type:'pipsRequest',id:'set',request:{type:'set_pip_computer_apps',choice:'download'}});
  assert.equal(sent.length,api>=54?2:0,`API ${api}`);
  if(api<54)assert.match(posted.find(m=>m.id==='get').error.message,/Update DGC for the apps on a Pip's computer/);
 }
});
