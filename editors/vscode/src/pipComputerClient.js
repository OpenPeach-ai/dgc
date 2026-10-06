// A Pip's computer in an editor tab: its Browser, Files and Terminal, like Grok's bots.
// The tab talks to the extension host exactly as the Pips view does (pipsRequest/pipsReply), and
// the host pins it to this one Pip and to the computer commands.
import './pipComputer.css';
import '../media/pips/plush.js';
import {esc,errorText,record,requestBroker,pipComputer,pipComputerView,pipComputerAction,pipComputerFiles,pipComputerFile,pipComputerTerminal,pipComputerTerminalEntry} from './pipsModel.js';

const vscode=acquireVsCodeApi();
const TYPES=['core','scout','lens','patch','rook','pulse','lock','quill'];
const S={connected:false,apiVersion:0,generation:0,pip:null,app:'browser',open:['browser'],computer:null,error:'',notice:'',
 view:null,viewError:'',files:{path:'',entries:[],total:0,more:false,selected:null,preview:null,error:''},
 terminal:{entries:[],error:'',running:false,draft:''},busy:false};
const broker=requestBroker(message=>vscode.postMessage({...message,generation:S.generation}));
const $=id=>document.getElementById(id);
const send=(type,fields={})=>broker.request({type,...fields});
let frameTimer=null,frameBusy=false,statusTimer=null,terminalTimer=null,cleanupFace=null;

function plushFace(state){
 const plush=window.PipConcepts?.plush,index=TYPES.indexOf(S.pip?.pip_type);
 return plush&&index>=0?plush.markup({index,name:S.pip.name},state,'computer-face',{includeStyles:false}):'';
}
function using(){return S.view?.watching===true;}
function headerMarkup(){
 const waiting=(S.computer?.actions||[]).filter(a=>a.status==='pending').length;
 const status=!S.connected?'Connecting…':!S.computer?'Loading…':!S.computer.granted?'No computer yet':using()?`${S.pip.name} is using its computer`:waiting?`${waiting} waiting for you`:'Idle';
 return `<header class="pc-header"><span class="pc-face" aria-hidden="true">${plushFace(using()?'working':waiting?'waiting_approval':'idle')}</span><div class="pc-title"><h1>${esc(S.pip?.name||'Pip')} · Computer</h1><p class="pc-status" role="status">${esc(status)}</p></div><button type="button" id="pc-stop" class="pc-quiet"${S.busy||!S.computer?.granted?' disabled':''}>Stop computer</button></header>`;
}
// A desktop like Grok's bots' computers: a wallpaper, a dock with three apps, apps in windows.
const APPS={browser:'Browser',files:'Files',terminal:'Terminal'};
function appIcon(app,size=34){
 const box=`width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true" focusable="false"`;
 if(app==='browser')return `<svg ${box}><circle cx="20" cy="20" r="17" fill="#2f7cf6"/><circle cx="20" cy="20" r="17" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.6"/><ellipse cx="20" cy="20" rx="7.5" ry="17" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M3.5 14h33M3.5 26h33M20 3v34" stroke="#fff" stroke-width="1.6" fill="none"/></svg>`;
 if(app==='files')return `<svg ${box}><path d="M4 11a3 3 0 0 1 3-3h9l4 4h13a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#f4b23e"/><path d="M4 16h32v15a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#ffc95c"/></svg>`;
 return `<svg ${box}><rect x="3" y="5" width="34" height="30" rx="5" fill="#1d2430"/><rect x="3" y="5" width="34" height="6" rx="3" fill="#2c3646"/><path d="M10 18l5 4-5 4" stroke="#7ee787" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 27h9" stroke="#e6edf3" stroke-width="2.2" stroke-linecap="round"/></svg>`;
}
function dockMarkup(){
 return `<nav class="pc-dock" aria-label="Apps">${Object.entries(APPS).map(([id,label])=>`<button type="button" class="pc-dock-app${S.open.includes(id)?' open':''}${S.app===id?' active':''}" data-app="${id}" aria-label="${label}" title="${label}" aria-pressed="${S.app===id}">${appIcon(id)}</button>`).join('')}</nav>`;
}
function windowMarkup(app,body){
 const sub=app==='browser'?(S.view?.ok?S.view.url:''):app==='files'?(S.files.path?['Files',...S.files.path.split('/')].join(' / '):''):'No internet · home is its Files';
 return `<section class="pc-window" aria-label="${APPS[app]}"><div class="pc-titlebar"><span class="pc-win-icon">${appIcon(app,16)}</span><strong>${APPS[app]}</strong><span class="pc-win-sub">${esc(sub)}</span><span class="pc-win-buttons"><button type="button" class="pc-win-button" data-minimize="${app}" aria-label="Minimise ${APPS[app]}" title="Minimise">–</button><button type="button" class="pc-win-button" data-close="${app}" aria-label="Close ${APPS[app]}" title="Close">×</button></span></div><div class="pc-window-body">${body}</div></section>`;
}
function waitingMarkup(){
 const waiting=(S.computer?.actions||[]).filter(a=>a.status==='pending');
 if(!waiting.length)return '';
 return `<section class="pc-waiting" aria-label="Waiting for you">${waiting.map(a=>`<article class="pc-hold"><div><strong>${esc(a.summary.method==='POST'?'Submit':a.summary.method)} to ${esc(a.summary.host)}${esc(a.summary.path)}</strong><span>${a.summary.payment===true?'Sends payment card details. ':''}Nothing has been sent.</span></div><div class="pc-actions"><button type="button" data-send="${esc(a.id)}">Send once</button><button type="button" class="pc-quiet" data-always="${esc(a.id)}">Always allow</button><button type="button" class="pc-quiet" data-reject="${esc(a.id)}">Reject</button></div></article>`).join('')}</section>`;
}
function browserMarkup(){
 const v=S.view;
 return `<section class="pc-pane pc-browser" aria-label="Browser"><form id="pc-go" class="pc-bar"><button type="button" id="pc-back" class="pc-quiet" aria-label="Back">←</button><input id="pc-url" aria-label="Address" placeholder="Search or type a web address" autocomplete="off" value="${esc(v?.ok?v.url:'')}"><button type="submit">Go</button></form><div class="pc-screen" tabindex="0" aria-label="The Pip's browser. Click to click there; type to type into the page.">${v?.ok?`<img id="pc-screen" alt="" src="${v.image}" data-width="${v.width}" data-height="${v.height}">`:`<p class="pc-muted">${esc(S.viewError||'Opening the browser…')}</p>`}</div><p class="pc-muted pc-hint">${using()?'The Pip is using its browser. You can watch; it is yours again when it stops.':'You are driving. What you submit here is sent; the Pip\'s own submits wait for you.'}</p></section>`;
}
function filesMarkup(){
 const f=S.files,crumbs=['Files',...(f.path?f.path.split('/'):[])];
 const size=n=>n==null?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
 const rows=f.entries.map(e=>`<li><button type="button" class="pc-file${f.selected===e.name?' active':''}" data-${e.kind==='folder'?'folder':'file'}="${esc(e.name)}"><span class="pc-icon" aria-hidden="true">${e.kind==='folder'?'▸':'·'}</span><span class="pc-name">${esc(e.name)}</span><span class="pc-size">${size(e.bytes)}</span></button></li>`).join('');
 const p=f.preview;
 const preview=!p?'<p class="pc-muted">Select a file to see it.</p>':p.text!=null?`<pre class="pc-text">${esc(p.text)}</pre>${p.truncated?'<p class="pc-muted">Showing the first 64 KB.</p>':''}`:p.data&&p.mime.startsWith('image/')?`<img class="pc-image" alt="${esc(p.name)}" src="${p.data}">`:`<p class="pc-muted">${p.too_large?'This file is over 2 MB, too large to show here.':'No preview for this kind of file.'}</p>`;
 return `<section class="pc-pane pc-files" aria-label="Files"><div class="pc-bar"><nav class="pc-crumbs" aria-label="Folder">${crumbs.map((c,i)=>`<button type="button" class="pc-crumb" data-crumb="${i}">${esc(c)}</button>`).join('<span aria-hidden="true">/</span>')}</nav><label class="pc-add"><input type="file" id="pc-add-input" multiple hidden>Add files…</label></div>${f.error?`<p class="pc-error" role="alert">${esc(f.error)}</p>`:''}<div class="pc-split"><ul class="pc-list" aria-label="Files in this folder">${rows||'<li class="pc-muted">Nothing here yet. Downloads from the browser land in Downloads.</li>'}</ul><div class="pc-preview">${p?`<div class="pc-bar"><strong>${esc(p.name)}</strong><span class="pc-muted">${size(p.bytes)}</span><button type="button" id="pc-save" class="pc-quiet"${p.data||p.text!=null&&!p.truncated?'':' disabled'}>Save to…</button><button type="button" id="pc-remove" class="pc-quiet">Remove</button></div>`:''}${preview}</div></div><p class="pc-muted">${size(f.total)} of 1 GB used. Only this computer's files: never your own.</p></section>`;
}
function terminalMarkup(){
 const t=S.terminal;
 const rows=t.entries.map(e=>`<article class="pc-run"><p class="pc-prompt"><span class="pc-who">${e.by==='pip'?esc(S.pip?.name||'Pip'):'You'}</span> $ ${esc(e.command)}</p>${e.output?`<pre>${esc(e.output)}</pre>`:''}${e.exit!==0?`<p class="pc-exit">Exit ${esc(String(e.exit))}</p>`:''}</article>`).join('');
 return `<section class="pc-pane pc-terminal" aria-label="Terminal"><div class="pc-log" id="pc-log" role="log" aria-live="polite">${rows||'<p class="pc-muted">Commands you and the Pip run show here.</p>'}</div>${t.error?`<p class="pc-error" role="alert">${esc(t.error)}</p>`:''}<form id="pc-run" class="pc-bar"><span aria-hidden="true">$</span><input id="pc-command" aria-label="Command" autocomplete="off" spellcheck="false" value="${esc(t.draft)}"${t.running?' disabled':''}><button type="submit"${t.running?' disabled':''}>${t.running?'Running…':'Run'}</button></form><p class="pc-muted">No internet here: the browser is this computer's way online. Its home is the computer's Files.</p></section>`;
}
function render(){
 const app=document.getElementById('app');
 const pane=!S.computer?'':!S.computer.granted?`<section class="pc-window pc-note"><p>${esc(S.pip?.name||'This Pip')} has no computer yet. Give it one from its chat.</p></section>`:!S.app?'':windowMarkup(S.app,S.app==='files'?filesMarkup():S.app==='terminal'?terminalMarkup():browserMarkup());
 const focus=document.activeElement?.id,caret=document.activeElement?.selectionStart;
 cleanupFace?.();
 app.innerHTML=`${headerMarkup()}${S.error?`<p class="pc-error" role="alert">${esc(S.error)}</p>`:''}${S.notice?`<p class="pc-notice" role="status">${esc(S.notice)}</p>`:''}${waitingMarkup()}<div class="pc-desktop">${pane}${S.computer?.granted?dockMarkup():''}</div>`;
 cleanupFace=window.PipConcepts?.plush?.mount?.(app);
 if(focus&&$(focus)){$(focus).focus();if(caret!=null&&$(focus).setSelectionRange)try{$(focus).setSelectionRange(caret,caret);}catch{}}
 const log=$('pc-log');if(log)log.scrollTop=log.scrollHeight;
}

async function loadComputer(){
 if(!S.pip||!S.connected)return;
 try{S.computer=pipComputer((await send('get_pip_computer',{pip_id:S.pip.id})).computer,S.pip.id);S.error='';}
 catch(error){S.error=errorText(error);}
 render();
}
async function frame(op='frame',fields={},opening=false){
 if(!S.pip||!S.computer?.granted||frameBusy&&op==='frame')return;frameBusy=true;
 const was=using();
 try{
  if(opening)await send('open_pip_computer',{pip_id:S.pip.id});
  const reply=pipComputerView((await send('use_pip_computer_view',{pip_id:S.pip.id,op,...fields})).view);
  if(reply.ok){S.view=reply;S.viewError='';}else{S.viewError=reply.error;}
 }catch(error){S.viewError=errorText(error);}
 finally{
  frameBusy=false;
  // The Pip started using its browser while you were elsewhere: bring its window up to watch.
  if(!was&&using()&&S.app!=='browser'){show('browser');return;}
  if(S.app==='browser')render();else if(was!==using())render();
 }
}
async function loadFiles(path=S.files.path){
 try{const v=pipComputerFiles(await send('list_pip_computer_files',{pip_id:S.pip.id,path}),path);S.files={...S.files,path:v.path,entries:v.entries,total:v.total_bytes,more:v.more,error:''};}
 catch(error){S.files.error=errorText(error);}
 render();
}
async function openFile(name){
 const path=[S.files.path,name].filter(Boolean).join('/');S.files.selected=name;S.files.preview=null;render();
 try{S.files.preview=pipComputerFile(await send('read_pip_computer_file',{pip_id:S.pip.id,path}),path);}
 catch(error){S.files.error=errorText(error);}
 render();
}
async function loadTerminal(){
 try{S.terminal.entries=pipComputerTerminal(await send('list_pip_computer_terminal',{pip_id:S.pip.id})).entries;S.terminal.error='';}
 catch(error){S.terminal.error=errorText(error);}
 if(S.app==='terminal')render();
}
async function runCommand(command){
 if(!command.trim()||S.terminal.running)return;S.terminal.running=true;S.terminal.draft='';render();
 try{const entry=pipComputerTerminalEntry((await send('run_pip_computer_command',{pip_id:S.pip.id,command})).entry);S.terminal.entries=[...S.terminal.entries,entry].slice(-200);S.terminal.error='';}
 catch(error){S.terminal.error=errorText(error);S.terminal.draft=command;}
 finally{S.terminal.running=false;render();$('pc-command')?.focus();}
}
async function decide(id,how){
 const a=(S.computer?.actions||[]).find(x=>x.id===id);if(!a||S.busy)return;S.busy=true;render();
 try{
  if(how==='always'){await send('always_allow_pip_computer_action',{action_id:a.id,expected_digest:a.digest});S.notice='Sent, and allowed from now on for this site.';}
  else{const d=pipComputerAction((await send('decide_pip_computer_action',{action_id:a.id,expected_digest:a.digest,approve:how==='send'})).action,S.pip.id);S.notice=d.status==='approved'?'Approved. It is sent within a few seconds, exactly as shown.':'Rejected. Nothing was sent.';}
 }catch(error){S.error=errorText(error);}
 finally{S.busy=false;await loadComputer();}
}
function screenPoint(event){
 const img=$('pc-screen');if(!img)return null;const box=img.getBoundingClientRect();
 return {x:Math.round((event.clientX-box.left)/box.width*Number(img.dataset.width)),y:Math.round((event.clientY-box.top)/box.height*Number(img.dataset.height))};
}
function schedule(){
 clearInterval(frameTimer);clearInterval(statusTimer);clearInterval(terminalTimer);
 if(document.hidden||!S.computer?.granted)return;
 statusTimer=setInterval(()=>void loadComputer(),5000);
 // The browser's window refreshes its screen; without it, a slow check notices the Pip starting.
 frameTimer=setInterval(()=>void frame(),S.app==='browser'?800:4000);
 if(S.app==='terminal')terminalTimer=setInterval(()=>void loadTerminal(),2500);
}
function show(app){
 S.app=app;if(!S.open.includes(app))S.open=[...S.open,app];render();
 if(app==='browser')void frame('frame',{},true);if(app==='files')void loadFiles();if(app==='terminal')void loadTerminal();
 schedule();vscode.setState({app});
}

document.addEventListener('click',event=>{
 const t=event.target.closest('button,[data-crumb],img');if(!t)return;
 if(t.dataset.app)show(t.dataset.app);
 else if(t.dataset.minimize){S.app='';render();schedule();vscode.setState({app:''});}
 else if(t.dataset.close){S.open=S.open.filter(a=>a!==t.dataset.close);S.app='';render();schedule();vscode.setState({app:''});}
 else if(t.id==='pc-stop')void send('stop_pip_computer',{pip_id:S.pip.id}).then(()=>{S.notice='Stopped. Its sign-ins are kept.';S.view=null;return loadComputer();},error=>{S.error=errorText(error);render();});
 else if(t.id==='pc-back')void frame('back');
 else if(t.id==='pc-screen'){const p=screenPoint(event);if(p&&!using())void frame('click',p);}
 else if(t.dataset.folder!==undefined){S.files.selected=null;S.files.preview=null;void loadFiles([S.files.path,t.dataset.folder].filter(Boolean).join('/'));}
 else if(t.dataset.file!==undefined)void openFile(t.dataset.file);
 else if(t.dataset.crumb!==undefined){const i=Number(t.dataset.crumb);S.files.selected=null;S.files.preview=null;void loadFiles(S.files.path.split('/').filter(Boolean).slice(0,i).join('/'));}
 else if(t.id==='pc-save'&&S.files.preview)vscode.postMessage({type:'pipComputerSave',name:S.files.preview.name,data:S.files.preview.data||null,text:S.files.preview.data?null:S.files.preview.text});
 else if(t.id==='pc-remove'&&S.files.preview){const path=S.files.preview.path;void send('remove_pip_computer_file',{pip_id:S.pip.id,path}).then(()=>{S.files.selected=null;S.files.preview=null;return loadFiles();},error=>{S.files.error=errorText(error);render();});}
 else if(t.dataset.send)void decide(t.dataset.send,'send');
 else if(t.dataset.always)void decide(t.dataset.always,'always');
 else if(t.dataset.reject)void decide(t.dataset.reject,'reject');
});
document.addEventListener('submit',event=>{
 event.preventDefault();
 if(event.target.id==='pc-go'){const url=$('pc-url').value.trim();if(url)void frame('go',{url:/^[a-z]+:\/\//i.test(url)?url:/\s/.test(url)||!url.includes('.')?'https://duckduckgo.com/?q='+encodeURIComponent(url):'https://'+url});}
 if(event.target.id==='pc-run')void runCommand($('pc-command').value);
});
document.addEventListener('input',event=>{if(event.target.id==='pc-command')S.terminal.draft=event.target.value;});
const KEYS=new Set(['Enter','Tab','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','Delete']);
let typed='',typeTimer=null;
document.addEventListener('keydown',event=>{
 if(!event.target.closest?.('.pc-screen')||using()||event.metaKey||event.ctrlKey||event.altKey)return;
 if(KEYS.has(event.key)){event.preventDefault();flushTyped();void frame('key',{key:event.key});}
 else if(event.key.length===1){event.preventDefault();typed+=event.key;clearTimeout(typeTimer);typeTimer=setTimeout(flushTyped,250);}
});
function flushTyped(){clearTimeout(typeTimer);if(!typed)return;const text=typed;typed='';void frame('type',{text});}
document.addEventListener('wheel',event=>{if(!event.target.closest?.('.pc-screen')||using())return;event.preventDefault();void frame('scroll',{dy:Math.max(-2000,Math.min(2000,Math.round(event.deltaY)))});},{passive:false});
document.addEventListener('change',event=>{if(event.target.id==='pc-add-input'){void addFiles([...event.target.files]);event.target.value='';}});
document.addEventListener('dragover',event=>{if(S.app==='files'&&[...(event.dataTransfer?.types||[])].includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{if(S.app!=='files')return;const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();void addFiles(files);});
async function addFiles(files){
 for(const file of files){
  if(file.size>2*1024*1024){S.files.error=`${file.name} is over 2 MB.`;render();continue;}
  const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve(null);reader.readAsDataURL(file);});
  if(typeof data!=='string')continue;
  try{await send('add_pip_computer_file',{pip_id:S.pip.id,path:S.files.path,name:file.name,data});}
  catch(error){S.files.error=errorText(error);}
 }
 await loadFiles();
}
document.addEventListener('visibilitychange',schedule);
window.addEventListener('message',event=>{
 const m=event.data;if(!record(m))return;
 if(m.type==='pipsReply')broker.receive(m);
 else if(m.type==='pipsConnection'){const was=S.connected;S.connected=m.connected&&m.supported&&m.enabled;S.apiVersion=m.apiVersion;S.generation=m.generation;if(!S.connected)broker.reset();render();if(S.connected&&!was)void loadComputer().then(()=>{if(S.app)show(S.app);else{void frame('frame',{},true);schedule();}});}
 else if(m.type==='pipComputerInit'&&record(m.pip)){S.pip=m.pip;render();}
 else if(m.type==='pipComputerSaved'){S.notice=m.ok?`Saved ${m.name}.`:m.error||'Not saved.';render();}
});
setInterval(()=>broker.expire(Date.now()),5000);
S.app=['browser','files','terminal',''].includes(vscode.getState()?.app)?vscode.getState().app:'browser';S.open=S.app?[S.app]:[];
const style=document.createElement('style');style.textContent=window.PipConcepts?.plush?.styles||'';document.head.append(style);
render();
vscode.postMessage({type:'pipsReady'});
