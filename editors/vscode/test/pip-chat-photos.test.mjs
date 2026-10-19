import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Photos in a Pip's chat, the Work chat's way (Pips API 52). A phone photo of a medical bill can be over
// the 2 MB, four-image cap the inline path had: from API 52 the host writes each photo and file into the
// backend's spool and sends their names, so a photo can be 8 MB and a message 32 MB of photos, with no
// four-photo cap. An iPhone photo (HEIC) goes too, and the chat's thumbnails and "open" show the original.
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife'})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule={exports:{}};new Function('module','exports','require',view)(viewModule,viewModule.exports,name=>name==='vscode'?{}:require(name));
const windows=[];after(()=>windows.forEach(w=>w.close()));
const MB=1024*1024,PW='ws_'+'p'.repeat(32),PROJECT='ws_'+'1'.repeat(32);
const workspaces=[{id:PW,name:'Personal',kind:'personal'},{id:PROJECT,name:'demo_project',kind:'project'}];
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,name,type,extra={})=>({id,workspace_id:PW,pip_type:type,name,goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const runId='run_'+'a'.repeat(32);
const message=(id,role,text,pipId,extra={})=>({id,pip_id:pipId,workspace_id:PW,role,text,run_id:runId,status:'succeeded',model:'m',created_at:'2026-10-06T09:47:00.000Z',...extra});
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
const bills=pip('pip_'+'b'.repeat(32),'Bills','scout');

function setup({apiVersion=52,messages={}}={}){
 const dom=new JSDOM(viewModule.exports.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});w.eval(code);
 const send=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(request,result,ok=true)=>{answered.add(request.id);send({type:'pipsReply',id:request.id,ok,...(ok?{result}:{error:result})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const defaults=r=>({list_workspaces:()=>({workspaces,current_workspace_id:PROJECT}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),list_pips:()=>({pips:[bills].filter(p=>p.workspace_id===(r.workspace_id||PROJECT))}),
  get_pip:()=>({pip:bills}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),get_workspace_context:()=>({context:{workspace_id:r.workspace_id||PW,revision:0,entries:[]}}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:messages[r.pip_id]||[],next_before_id:null,active_run:null,history_context_omitted_count:0,continuity:null,chat_controls:controls}),
  list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  get_pip_computer:()=>({computer:{pip_id:r.pip_id,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_run_posts:()=>({pip_id:r.pip_id,workspace_id:PW,posts:[],next_before_id:null}),
  get_pip_digest:()=>undefined}[r.type]?.());
 async function drain(){for(let round=0;round<14;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined){answer(m,result);count++;}}await flush();if(!count)break;}await flush();}
 send({type:'pipsConnection',apiVersion,connected:true,supported:true,enabled:true});
 return {w,d:w.document,sent,answer,requests,drain,click:s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);el.click();}};
}
async function open(x){await x.drain();x.click(`[data-job="${bills.id}"]`);await x.drain();}
async function drop(x,files){
 const event=new x.w.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files,types:['Files']}});
 const chips=()=>x.d.querySelectorAll('.chat-file-chip,.chat-image-chip').length,before=chips();x.d.querySelector('#chatText').dispatchEvent(event);
 for(let i=0;i<400&&chips()<before+files.length&&!x.d.querySelector('.error');i++)await new Promise(r=>setTimeout(r,5));
}
const photo=(x,size,name='bill.jpg',type='image/jpeg')=>{const bytes=new Uint8Array(size);bytes.set([0xff,0xd8,0xff]);return new x.w.File([bytes],name,{type});};
const submit=async x=>{x.d.querySelector('#chat-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await flush();};

test('from API 52 five phone photos of a bill go in one message, far over the old 2 MB and four', async()=>{
 const x=setup();await open(x);
 await drop(x,[0,1,2,3,4].map(i=>photo(x,Math.round(2.5*MB)+i,`bill-${i+1}.jpg`)));
 assert.equal(x.d.querySelectorAll('.chat-image-chip').length,5);assert.equal(x.d.querySelector('.error'),null);
 await submit(x);
 const sent=x.requests('send_pip_message')[0];assert.ok(sent);
 assert.equal(sent.request.images.length,5,'the view hands the host the photos; the host spools them');
});

test('an iPhone photo is taken from API 52, named in its chip and sent for DGC to make a JPEG; before 52 it says to update', async()=>{
 const x=setup();await open(x);
 assert.match(x.d.querySelector('#chat-attach-input').getAttribute('accept'),/\.heic/);
 await drop(x,[photo(x,2*MB,'IMG_4417.HEIC','')]);
 const chip=x.d.querySelector('.chat-heic-chip');assert.ok(chip,'a chip, not a broken preview');
 assert.equal(chip.querySelector('img'),null);assert.match(chip.textContent,/IMG_4417\.HEIC/);assert.match(chip.title,/sent as a JPEG/);
 await submit(x);
 assert.match(x.requests('send_pip_message')[0].request.images[0],/^data:image\/heic;base64,/);
 const old=setup({apiVersion:51});await open(old);
 assert.doesNotMatch(old.d.querySelector('#chat-attach-input').getAttribute('accept'),/\.heic/);
 await drop(old,[photo(old,100,'IMG_4417.HEIC','image/heic')]);
 assert.equal(old.d.querySelectorAll('.chat-heic-chip,.chat-image-chip').length,0);
 assert.match(old.d.body.textContent,/Update DGC to send iPhone photos\./);
});

test('photos join the message in the order they were picked, not the order they finish reading', async()=>{
 const x=setup();await open(x);
 await drop(x,[photo(x,6*MB,'bill-page-1.jpg'),photo(x,200,'IMG_1.HEIC',''),photo(x,100,'tiny.png','image/png')]);
 await settle(()=>x.d.querySelectorAll('.chat-images > span').length===3);
 assert.deepEqual([...x.d.querySelectorAll('.chat-images > span')].map(c=>c.classList.contains('chat-heic-chip')?'heic':c.querySelector('img')?.getAttribute('src').slice(0,15)),
  ['data:image/jpeg','heic','data:image/png;'],'the 6 MB photo stays first');
});

test('the Work chat’s limits say what to do in one sentence', async()=>{
 for(const [files,says] of [
  [x=>[photo(x,8*MB+1,'huge.jpg')],/huge\.jpg is over 8 MB; send a smaller photo\./],
  [x=>[0,1,2,3,4].map(i=>photo(x,7*MB,`p${i}.jpg`)),/Send up to 32 MB of photos with one message\./],
  [x=>[new x.w.File([new Uint8Array(16*MB+1)],'scan.pdf',{type:'application/pdf'})],/scan\.pdf is over 16 MB; send a document of 16 MB or less\./],
  [x=>[new x.w.File([new Uint8Array(MB+1)],'notes.txt',{type:'text/plain'})],/notes\.txt is over 1 MB; send a text or code file of 1 MB or less\./],
 ]){
  const x=setup();await open(x);await drop(x,files(x));
  assert.match(x.d.querySelector('.error')?.textContent||'',says);assert.equal(x.d.querySelectorAll('.chat-file-chip,.chat-image-chip').length,0);
 }
 const old=setup({apiVersion:51});await open(old);await drop(old,[photo(old,3*MB)]);
 assert.match(old.d.body.textContent,/Send up to 2 MB of images and files with one message\./,'an older CLI keeps the inline bound');
});

test('every photo a message brought is shown, and a click opens the original', async()=>{
 const asked=message('message_1','user','What do I owe?',bills.id,{images:[0,1,2,3,4,5].map(index=>({index,mime:'image/jpeg',bytes:3*MB}))});
 const x=setup({messages:{[bills.id]:[asked]}});await open(x);
 const shown=x.d.querySelectorAll('img[data-message-image]');assert.equal(shown.length,6,'no four-photo cap');
 shown[5].click();
 assert.deepEqual(x.sent.filter(m=>m.type==='pipsOpenPhoto').map(({type,pip_id,message_id,index})=>({type,pip_id,message_id,index})),
  [{type:'pipsOpenPhoto',pip_id:bills.id,message_id:'message_1',index:5}]);
});

// ---- the extension host --------------------------------------------------------------------------------
function host(api,{spool=mkdtempSync(join(tmpdir(),'dgc-spool-')),vscode={}}={}){
 const posted=[],sent=[];const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?vscode:require(name));
 const editor=new out.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});editor.attach(m=>posted.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api,image_spool:true,image_spool_dir:spool},{});
 return {editor,posted,sent,spool};
}
const uri=(bytes,mime='image/jpeg')=>`data:${mime};base64,`+Buffer.from(bytes).toString('base64');
const jpegBytes=size=>{const b=Buffer.alloc(size,0x5a);b[0]=0xff;b[1]=0xd8;b[2]=0xff;return b;};
async function settle(predicate){for(let i=0;i<400&&!predicate();i++)await new Promise(r=>setTimeout(r,5));}
const base={type:'send_pip_message',pip_id:bills.id,text:'What do I owe?',idempotency_key:'k'};

test('the host writes a message’s photos and files into the spool and sends their names (API 52)', async()=>{
 const h=host(52),photos=[0,1,2,3,4].map(i=>jpegBytes(3*MB+i)),heic=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypheic\0\0\0\0mif1heic')]);
 const pdf=Buffer.from('%PDF-1.4\nbill\n%%EOF\n');
 h.editor.receive({type:'pipsRequest',id:'send',request:{...base,images:[...photos.map(p=>uri(p)),uri(heic,'image/heic')],files:[{name:'hospital bill.pdf',data:uri(pdf,'application/octet-stream')}]}});
 await settle(()=>h.sent.length);
 assert.equal(h.sent.length,1,h.posted.at(-1)?.error?.message);
 const request=h.sent[0].request;
 assert.equal(request.images,undefined);assert.equal(request.files,undefined,'no data rides in the frame');
 assert.deepEqual(request.spooled_images.map(i=>i.media_type),['image/jpeg','image/jpeg','image/jpeg','image/jpeg','image/jpeg','image/heic']);
 assert.deepEqual(request.spooled_files.map(f=>f.name),['hospital bill.pdf']);
 for(const [i,item] of request.spooled_images.entries()){
  assert.match(item.name,/^[0-9a-f]{32}\.(jpg|heic)$/);
  assert.deepEqual(readFileSync(join(h.spool,item.name)),i<5?photos[i]:heic);
  assert.equal(statSync(join(h.spool,item.name)).mode&0o777,0o600);
 }
 assert.deepEqual(readFileSync(join(h.spool,request.spooled_files[0].spool)),pdf);
 assert.ok(Buffer.byteLength(JSON.stringify(h.sent[0]))<16384,'the frame carries names, not megabytes');
 // A refusal from DGC leaves nothing of this send in the spool.
 h.editor.event({type:'pips_result',request_id:request.request_id,command:'send_pip_message',ok:false,error:{code:'invalid_images',message:'no'}});
 await settle(()=>readdirSync(h.spool).length===0);
 assert.deepEqual(readdirSync(h.spool),[]);
});

test('the host keeps the spool to itself and the old bounds for an older CLI', async()=>{
 const h=host(52);
 h.editor.receive({type:'pipsRequest',id:'a',request:{...base,spooled_images:[{name:'x.jpg',media_type:'image/jpeg'}]}});
 assert.match(h.posted.at(-1).error.message,/Add photos and files with the message box/);
 h.editor.receive({type:'pipsRequest',id:'b',request:{type:'get_pip_message_image',pip_id:bills.id,message_id:'m',index:0,as_file:true}});
 assert.match(h.posted.at(-1).error.message,/Choose a photo in the chat/);
 h.editor.receive({type:'pipsRequest',id:'c',request:{...base,images:[uri(jpegBytes(8*MB+1))]}});
 assert.equal(h.posted.at(-1).error.message,'Send photos of up to 8 MB each, 32 MB in all.');
 h.editor.receive({type:'pipsRequest',id:'d',request:{...base,files:[{name:'scan.pdf',data:uri(Buffer.alloc(16*MB+1),'application/octet-stream')}]}});
 assert.match(h.posted.at(-1).error.message,/documents up to 16 MB/);
 await new Promise(r=>setTimeout(r,20));
 assert.equal(h.sent.length,0);assert.deepEqual(readdirSync(h.spool),[]);
 const old=host(51);
 old.editor.receive({type:'pipsRequest',id:'e',request:{...base,spooled_images:[{name:'x.jpg',media_type:'image/jpeg'}]}});
 assert.match(old.posted.at(-1).error.message,/Update DGC to send bigger photos and files to a Pip/);
 old.editor.receive({type:'pipsRequest',id:'f',request:{...base,images:Array(5).fill(uri(jpegBytes(100)))}});
 assert.match(old.posted.at(-1).error.message,/Send up to 4 images, 2 MB in all/);
 old.editor.receive({type:'pipsRequest',id:'g',request:{...base,images:[uri(jpegBytes(100))]}});
 assert.equal(old.sent.length,1);assert.equal(old.sent[0].request.images.length,1,'inline, as before');
 assert.equal(old.sent[0].request.spooled_images,undefined);
});

test('a sent photo is read back from its kept file, the original, by the host (API 52)', async()=>{
 const h=host(52),state=mkdtempSync(join(tmpdir(),'dgc-pips-')),folder=join(state,'chat_images',bills.id);mkdirSync(folder,{recursive:true});
 const original=jpegBytes(6*MB),kept=join(folder,'a'.repeat(64)+'.jpg');writeFileSync(kept,original);
 h.editor.receive({type:'pipsRequest',id:'thumb',request:{type:'get_pip_message_image',pip_id:bills.id,message_id:'message_1',index:0}});
 const request=h.sent[0].request;assert.equal(request.as_file,true,'a photo of 6 MB is more than a frame carries');
 h.editor.event({type:'pips_result',request_id:request.request_id,command:'get_pip_message_image',ok:true,result:{pip_id:bills.id,message_id:'message_1',index:0,path:kept,mime:'image/jpeg',bytes:original.length}});
 await settle(()=>h.posted.some(m=>m.id==='thumb'));
 const reply=h.posted.find(m=>m.id==='thumb');assert.equal(reply.ok,true,reply.error?.message);
 assert.equal(reply.result.image,uri(original));
 // A path that is not a Pip chat's kept photo is never read.
 writeFileSync(join(state,'secret.jpg'),original);
 h.editor.receive({type:'pipsRequest',id:'odd',request:{type:'get_pip_message_image',pip_id:bills.id,message_id:'message_1',index:0}});
 const again=h.sent[1].request;
 h.editor.event({type:'pips_result',request_id:again.request_id,command:'get_pip_message_image',ok:true,result:{pip_id:bills.id,message_id:'message_1',index:0,path:join(state,'secret.jpg'),mime:'image/jpeg',bytes:original.length}});
 await settle(()=>h.posted.some(m=>m.id==='odd'));
 assert.equal(h.posted.find(m=>m.id==='odd').ok,false);
 const old=host(51);old.editor.receive({type:'pipsRequest',id:'t',request:{type:'get_pip_message_image',pip_id:bills.id,message_id:'m',index:0}});
 assert.equal(old.sent[0].request.as_file,undefined,'an older CLI answers with the data URI');
});

test('opening a photo shows the original in an editor tab, under a name a person can read', async()=>{
 const opened=[],info=[];
 const vscode={commands:{executeCommand:async(...a)=>{opened.push(a);}},Uri:{file:p=>({fsPath:p})},window:{showInformationMessage:m=>{info.push(m);}}};
 const h=host(52,{vscode}),state=mkdtempSync(join(tmpdir(),'dgc-pips-')),folder=join(state,'chat_images',bills.id);mkdirSync(folder,{recursive:true});
 const original=jpegBytes(5*MB),kept=join(folder,'b'.repeat(64)+'.jpg');writeFileSync(kept,original);
 h.editor.receive({type:'pipsOpenPhoto',pip_id:bills.id,message_id:'message_9',index:2});
 await settle(()=>h.sent.length);
 const request=h.sent[0].request;assert.deepEqual({...request,request_id:undefined},{type:'get_pip_message_image',pip_id:bills.id,message_id:'message_9',index:2,as_file:true,request_id:undefined});
 h.editor.event({type:'pips_result',request_id:request.request_id,command:'get_pip_message_image',ok:true,result:{pip_id:bills.id,message_id:'message_9',index:2,path:kept,mime:'image/jpeg',bytes:original.length}});
 await settle(()=>opened.length||info.length);
 assert.deepEqual(info,[]);
 const [[command,target]]=opened;assert.equal(command,'vscode.open');
 assert.match(target.fsPath,/message_9[\\/]Photo 3\.jpg$/);assert.deepEqual(readFileSync(target.fsPath),original);
 h.editor.receive({type:'pipsOpenPhoto',pip_id:'../x',message_id:'m',index:0});
 await settle(()=>info.length);assert.deepEqual(info,['That photo is no longer available.']);
 assert.ok(existsSync(target.fsPath));
});
