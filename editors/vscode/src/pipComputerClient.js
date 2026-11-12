// A Pip's computer in an editor tab: its Browser, Files and Terminal, like Grok's bots.
// The tab talks to the extension host exactly as the Pips view does (pipsRequest/pipsReply), and
// the host pins it to this one Pip and to the computer commands.
import {carefulWords,sendsWords,isPayment,asksEveryTime,asksWords,coversWords} from './pipCareful.js';
// One set of tokens for every page, first, so each page's own stylesheet can lean on it (media/shared/tokens.css).
import '../media/shared/tokens.css';
import '../media/shared/menu.css';
import './pipComputer.css';
import '../media/shared/menu.js';
import '../media/pips/plush.js';
import RFB from '@novnc/novnc';
import {esc,errorText,record,requestBroker,pipComputer,pipComputerView,pipComputerAction,pipComputerFiles,pipComputerFile,pipComputerTerminal,pipComputerTerminalEntry,pipComputerDesktop,pipComputerPointer,pipComputerApps} from './pipsModel.js';

const vscode=acquireVsCodeApi();
const TYPES=['core','scout','lens','patch','rook','pulse','lock','quill'];
// The computer opens on its desktop with nothing open, like a computer you switch on (a user:
// "show default OS screen, with nothing opened"). The browser comes up when you open it from the
// dock, or by itself when the Pip starts using it, so you can watch.
const S={connected:false,apiVersion:0,generation:0,pip:null,app:'',open:[],computer:null,error:'',actionError:false,notice:'',
 view:null,viewError:'',files:{path:'',entries:[],total:0,more:false,selected:null,preview:null,error:''},
 terminal:{entries:[],error:'',running:false,draft:''},busy:false,
 // What you are typing in the address bar. Every new frame redraws the bar with the page's address,
 // and that wiped each letter as you typed it (a user's report); it shows yours until you go,
 // press Escape or leave the bar.
 address:null,
 // The full screen, like Grok's bots: the CLI can stream it (screenCapable) and this machine has it (desktop.available).
 screenCapable:false,desktop:null,screen:{state:'off',reason:''},
 // Where the Pip last acted by position (Pips API 53): you see its cursor there while it works.
 pointer:null,pointerSeq:-1,pointerAt:0,pointerPulse:false,screenWatching:false,
 // Its image editor, document editor and PDF viewer (Pips API 54): the one offer to download the ones this computer lacks.
 apps:null,appsBusy:false};
// Which of the Pip's computers this tab is (pips-17d, Pips API 86): its number, said with every open and view, and its
// name for the header. S.number is 0 for a Pip's one tab, as before; `numbers`: the CLI's screen stream takes a number.
Object.assign(S,{number:0,name:'',numbers:false});
// Big files (pc-background-commands, Pips API 87): Add file… and Save to this computer… ask the host, which shows VS Code's
// own dialog and has DGC copy the file itself, up to 1 GB. This page never knows a path on this computer: it says only
// which folder or file in Files. `adding`: {folder, names} while an Add is under way (names once the files are picked);
// `saving`: the file in Files being saved.
Object.assign(S.files,{adding:null,saving:''});
const bigFiles=()=>S.apiVersion>=87;
const which=()=>S.number&&S.apiVersion>=86?{number:S.number}:{};
function computerName(){
 if(!S.number||S.apiVersion<86)return 'Computer';
 const names=S.computer?.names;
 if(Array.isArray(names))return names.length>1?names.find(n=>n.number===S.number)?.name||`Computer ${S.number}`:'Computer';
 return S.name||'Computer';
}
// How the screen is shown and what is open over it (pc-fills-tab, pc-fullscreen-viewer): Fit scales it to the tab and
// 100% shows real pixels; the size its screen next starts at (Pips API 86); full screen ('screen' is the browser's own,
// 'tab' fills this tab when the editor refuses that); the keyboard or clipboard panel; and the clipboard's two halves.
// What was copied on the computer is kept here and drawn only while the clipboard panel is open.
Object.assign(S,{fit:true,full:'',panel:'',sizeMenu:false,sizeBusy:false,sizePicked:false,restart:null,
 clip:{draft:'',there:null,over:false,fresh:false,note:'',bad:false,typing:false}});
const CLIP_BYTES=1000000,TYPE_CHARS=5000;
const tabTitle=()=>`${S.pip?.name||'Pip'} · ${computerName()}`;
const broker=requestBroker(message=>vscode.postMessage({...message,generation:S.generation}));
const $=id=>document.getElementById(id);
const send=(type,fields={})=>broker.request({type,...fields});
let frameTimer=null,frameBusy=false,statusTimer=null,terminalTimer=null,desktopTimer=null,setupTimer=null,cleanupFace=null,pointerTimer=null,pointerBusy=false;
let computerRefreshSerial=0;
// The Pip's cursor: an arrow with its name, like a person's cursor in a shared document.
const CURSOR=`<svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true" focusable="false"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L13.5 22.6 L10 15.2 L17 15.2 Z" fill="#fff" stroke="#1d1d22" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
function cursorMarkup(){return `<span class="pc-cursor" id="pc-cursor" hidden aria-hidden="true">${CURSOR}<span class="pc-cursor-name">${esc(S.pip?.name||'Pip')}</span></span>`;}
function notePointer(value){
 const p=value==null?null:pipComputerPointer(value);
 if(p&&p.seq!==S.pointerSeq){S.pointerSeq=p.seq;S.pointerAt=Date.now();S.pointerPulse=true;}
 S.pointer=p;
}
// On the page's screenshot (the browser window), or on the full screen (the browser is a window on its desktop).
function placeCursor(){
 const c=$('pc-cursor'),p=S.pointer;if(!c)return;
 const show=!!p&&(using()||S.screenWatching||Date.now()-S.pointerAt<8000);
 let x=null,y=null;
 if(show&&screenMode()){
  const live=$('pc-live'),canvas=$('pc-vnc')?.querySelector('canvas');
  if(live&&canvas&&p.screen_x!==undefined){const a=live.getBoundingClientRect(),b=canvas.getBoundingClientRect(),fw=canvas.width||p.screen_width,fh=canvas.height||p.screen_height;
   if(b.width&&b.height&&fw&&fh){x=b.left-a.left+p.screen_x/fw*b.width;y=b.top-a.top+p.screen_y/fh*b.height;}}
 }else if(show&&S.view?.ok){
  const img=$('pc-screen');
  if(img){const a=img.parentElement.getBoundingClientRect(),b=img.getBoundingClientRect();
   if(b.width&&b.height&&S.view.width&&S.view.height){x=b.left-a.left+p.x/S.view.width*b.width;y=b.top-a.top+p.y/S.view.height*b.height;}}
 }
 if(x===null){c.hidden=true;return;}
 c.hidden=false;c.style.left=`${Math.round(x)}px`;c.style.top=`${Math.round(y)}px`;c.dataset.kind=p.kind;
 if(S.pointerPulse){S.pointerPulse=false;c.classList.remove('pulse');void c.offsetWidth;c.classList.add('pulse');}
}
async function pollPointer(){
 if(pointerBusy||!S.pip||!screenMode()||S.apiVersion<53)return;pointerBusy=true;
 try{const v=(await send('use_pip_computer_view',{pip_id:S.pip.id,op:'pointer',...which()})).view;if(record(v)&&v.ok===true){notePointer(v.pointer);S.screenWatching=v.watching===true;}}
 catch{}
 finally{pointerBusy=false;placeCursor();}
}

function plushFace(state){
 const plush=window.PipConcepts?.plush,index=TYPES.indexOf(S.pip?.pip_type);
 return plush&&index>=0?plush.markup({index,name:S.pip.name},state,'computer-face',{includeStyles:false}):'';
}
function screenMode(){return S.screenCapable&&S.apiVersion>=43&&S.desktop?.available===true&&S.computer?.granted===true;}
function using(){return screenMode()?S.desktop?.using===true:S.view?.watching===true;}
function headerMarkup(){
 const waiting=(S.computer?.actions||[]).filter(a=>a.status==='pending').length;
 const status=!S.connected?'Connecting…':!S.computer?'Loading…':!S.computer.granted?'No computer yet':!S.computer.available?'Setup needed':using()?`${S.pip.name} is using its computer`:waiting?`${waiting} waiting for you`:'Idle';
 return `<header class="pc-header"><span class="pc-face" aria-hidden="true">${plushFace(using()?'working':waiting?'waiting_approval':'idle')}</span><div class="pc-title"><h1>${esc(tabTitle())}</h1><p class="pc-status" role="status">${esc(status)}</p></div><button type="button" id="pc-stop" class="pc-quiet"${S.busy||!S.computer?.granted?' disabled':''}>Stop computer</button></header>`;
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
 const sub=app==='browser'?(S.view?.ok?S.view.url:''):app==='files'?(S.files.path?['Files',...S.files.path.split('/')].join(' / '):''):'Online · public websites only · works in its Files';
 return `<section class="pc-window" aria-label="${APPS[app]}"><div class="pc-titlebar"><span class="pc-win-icon">${appIcon(app,16)}</span><strong>${APPS[app]}</strong><span class="pc-win-sub">${esc(sub)}</span><span class="pc-win-buttons"><button type="button" class="pc-win-button" data-minimize="${app}" aria-label="Minimise ${APPS[app]}" title="Minimise">–</button><button type="button" class="pc-win-button" data-close="${app}" aria-label="Close ${APPS[app]}" title="Close">×</button></span></div><div class="pc-window-body">${body}</div></section>`;
}
// What a held form sends, on the card itself: a payment's bill number and amount, an order's sizes (never a hidden field).
function sendsMarkup(summary){const line=sendsWords(summary);return line?`<span class="pc-sends">${esc(line)}</span>`:'';}
function waitingMarkup(){
 const waiting=(S.computer?.actions||[]).filter(a=>a.status==='pending');
 if(!waiting.length)return '';
 return `<section class="pc-waiting" aria-label="Waiting for you">${waiting.map(a=>{const words=carefulWords(a.summary,S.pip?.name||'The Pip');return words
   // Careful mode: a new site, or something it read from your apps; no Always allow for these.
   // A login to save (API 56) is saved from its chat's card or its page: the form is there, never in this tab.
   ?a.summary.kind==='login'?`<article class="pc-hold"><div><strong>${esc(words[0])}</strong><span>${esc(words[1])} Save it from the card in its chat.</span></div><div class="pc-actions"><button type="button" class="pc-quiet" data-reject="${esc(a.id)}">Not now</button></div></article>`
   :`<article class="pc-hold"><div><strong>${esc(words[0])}</strong><span>${esc(words[1])}</span>${a.summary.kind==='text'&&typeof a.summary.text==='string'?`<pre class="pc-held-text">${esc(a.summary.text)}</pre>`:''}</div><div class="pc-actions"><button type="button" data-send="${esc(a.id)}">${esc(words[2])}</button><button type="button" class="pc-quiet" data-reject="${esc(a.id)}">Not now</button></div></article>`
   :`<article class="pc-hold"><div><strong>${isPayment(a.summary)?'Pay on':'Send a form to'} ${esc(a.summary.host)}</strong>${sendsMarkup(a.summary)}<span>${a.summary.payment===true?'Sends payment card details. ':''}${esc(asksWords(a.summary))}${asksWords(a.summary)?' ':''}Nothing has been sent.${asksEveryTime(a.summary)?'':` ${esc(coversWords(a.summary))}.`}</span></div><div class="pc-actions"><button type="button" data-send="${esc(a.id)}">Send once</button>${asksEveryTime(a.summary)?'':`<button type="button" class="pc-quiet" data-always="${esc(a.id)}">Always allow</button>`}<button type="button" class="pc-quiet" data-reject="${esc(a.id)}">Reject</button></div></article>`;}).join('')}</section>`;
}
function browserMarkup(){
 const v=S.view;
 return `<section class="pc-pane pc-browser" aria-label="Browser"><form id="pc-go" class="pc-bar"><button type="button" id="pc-back" class="pc-quiet" aria-label="Back">←</button><input id="pc-url" aria-label="Address" placeholder="Search or type a web address" autocomplete="off" value="${esc(S.address??(v?.ok?v.url:''))}"><button type="submit">Go</button></form><div class="pc-screen${S.viewError.startsWith('The browser is closed.')?' pc-screen-closed':''}" tabindex="0" aria-label="The Pip's browser. Click to click there; type to type into the page.">${v?.ok?`<img id="pc-screen" alt="" src="${v.image}" data-width="${v.width}" data-height="${v.height}">${cursorMarkup()}`:`<p class="pc-muted">${esc(S.viewError||'Opening the browser…')}</p>${S.viewError.startsWith('The browser is closed.')?'<button type="button" id="pc-reopen-browser">Open browser</button>':''}`}</div><p class="pc-muted pc-hint">${using()?'The Pip is using its browser. You can watch; it is yours again when it stops.':'You are driving. What you submit here is sent; the Pip\'s own submits wait for you.'}</p></section>`;
}
// Files, twice: the Files window on the desktop of a computer with no live screen, and (panel) the Files panel under the
// live screen's bar. One markup and one set of handlers; in the panel, Add and Remove are off while a Pip run uses the
// computer, as Keyboard and Clipboard are.
function filesMarkup(panel=false){
 const held=panel&&using(),why=held?` title="${esc(`${S.pip?.name||'The Pip'} is using it`)}"`:'';
 const f=S.files,crumbs=['Files',...(f.path?f.path.split('/'):[])];
 const size=n=>n==null?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(1)} GB`;
 const rows=f.entries.map(e=>`<li><button type="button" class="pc-file${f.selected===e.name?' active':''}" data-${e.kind==='folder'?'folder':'file'}="${esc(e.name)}"><span class="pc-icon" aria-hidden="true">${e.kind==='folder'?'▸':'·'}</span><span class="pc-name">${esc(e.name)}</span><span class="pc-size">${size(e.bytes)}</span></button></li>`).join('');
 const p=f.preview;
 // A copy under way: the file's name with "copying" (one command each, so no made-up progress bar).
 const copying=f.adding&&f.adding.folder===f.path?f.adding.names.map(name=>`<li class="pc-file pc-copying" role="status"><span class="pc-icon" aria-hidden="true">·</span><span class="pc-name">${esc(name)}</span><span class="pc-size">copying</span></li>`).join(''):'';
 const preview=!p?'<p class="pc-muted">Select a file to see it.</p>':p.text!=null?`<pre class="pc-text">${esc(p.text)}</pre>${p.truncated?'<p class="pc-muted">Showing the first 64 KB.</p>':''}`:p.data&&p.mime.startsWith('image/')?`<img class="pc-image" alt="${esc(p.name)}" src="${p.data}">`:`<p class="pc-muted">${p.too_large?'This file is over 2 MB, too large to show here.':'No preview for this kind of file.'}</p>`;
 return `<section class="${panel?'pc-panel pc-files pc-files-panel" id="pc-files-panel':'pc-pane pc-files'}" aria-label="Files"><div class="pc-bar"><nav class="pc-crumbs" aria-label="Folder">${crumbs.map((c,i)=>`<button type="button" class="pc-crumb" data-crumb="${i}">${esc(c)}</button>`).join('<span aria-hidden="true">/</span>')}</nav>${bigFiles()?`<button type="button" id="pc-add" class="dgc-btn small pc-add-big"${f.adding||f.saving||held?' disabled':''}${why}>${f.adding?'Adding…':'Add file…'}</button>`:`<label class="pc-add${held?' pc-add-off':''}"${why}><input type="file" id="pc-add-input" multiple hidden${held?' disabled':''}>Add files…</label>`}</div>${f.error?`<p class="pc-error" role="alert">${esc(f.error)}</p>`:''}<div class="pc-split"><ul class="pc-list" aria-label="Files in this folder">${copying}${rows||(copying?'':'<li class="pc-muted">Nothing here yet. Downloads from the browser land in Downloads.</li>')}</ul><div class="pc-preview">${p?`<div class="pc-bar"><strong>${esc(p.name)}</strong><span class="pc-muted">${size(p.bytes)}</span>${bigFiles()?`<button type="button" id="pc-save-as" class="dgc-btn small pc-save-big"${f.saving||f.adding?' disabled':''}>${f.saving===p.path?'Saving…':'Save to this computer…'}</button>`:`<button type="button" id="pc-save" class="pc-quiet"${p.data||p.text!=null&&!p.truncated?'':' disabled'}>Save to…</button>`}<button type="button" id="pc-remove" class="${bigFiles()?'dgc-btn small pc-remove-big':'pc-quiet'}"${held?' disabled':''}${why}>Remove</button></div>`:''}${preview}</div></div><p class="pc-muted">${size(f.total)} used. Only this computer's files: never your own.</p></section>`;
}
function terminalMarkup(){
 const t=S.terminal;
 const rows=t.entries.map(e=>`<article class="pc-run"><p class="pc-prompt"><span class="pc-who">${e.by==='pip'?esc(S.pip?.name||'Pip'):'You'}</span> $ ${esc(e.command)}</p>${e.output?`<pre>${esc(e.output)}</pre>`:''}${e.exit!==0?`<p class="pc-exit">Exit ${esc(String(e.exit))}</p>`:''}${e.reached?.length?`<p class="pc-hosts">Reached ${esc(e.reached.join(', '))}</p>`:''}${e.blocked?.length?`<p class="pc-hosts pc-blocked">Blocked: ${esc(e.blocked.join(', '))}, on this computer or your network</p>`:''}</article>`).join('');
 return `<section class="pc-pane pc-terminal" aria-label="Terminal"><div class="pc-log" id="pc-log" role="log" aria-live="polite">${rows||'<p class="pc-muted">Commands you and the Pip run show here.</p>'}</div>${t.error?`<p class="pc-error" role="alert">${esc(t.error)}</p>`:''}<form id="pc-run" class="pc-bar"><span aria-hidden="true">$</span><input id="pc-command" aria-label="Command" autocomplete="off" spellcheck="false" value="${esc(t.draft)}"${t.running?' disabled':''}><button type="submit"${t.running?' disabled':''}>${t.running?'Running…':'Run'}</button></form><p class="pc-muted">Online: commands can reach public websites (to download or install, for example), never this computer or your home network. It works in its Files.</p></section>`;
}
// The screen's bytes ride the extension host's messages; noVNC sees a WebSocket-like channel.
function toB64(bytes){let text='';for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(text);}
function fromB64(text){const raw=atob(text),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}
class ScreenChannel{
 constructor(){this.binaryType='arraybuffer';this.protocol='';this.readyState='connecting';this.onopen=null;this.onmessage=null;this.onclose=null;this.onerror=null;}
 send(data){if(this.readyState!=='open')return;const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);vscode.postMessage({type:'pipDesktop',op:'send',data:toB64(bytes)});}
 close(){if(this.readyState==='closed')return;this.readyState='closed';vscode.postMessage({type:'pipDesktop',op:'close'});this.onclose?.({code:1000,reason:'',wasClean:true});}
 // The viewer attaches a moment after it is made. Bytes that arrive before it listens wait for it, in order: handed to
 // no one, the server's first words were lost and the screen never opened.
 deliver(text,held=false){
  if(this.readyState==='closed')return;
  if(!held&&(this.early||!this.onmessage)){(this.early||=[]).push(text);if(!this.earlyTimer)this.earlyTimer=setInterval(()=>this.flushEarly(),5);return;}
  if(this.readyState==='connecting'){this.readyState='open';this.onopen?.();}const bytes=fromB64(text);this.onmessage?.({data:bytes.buffer});}
 flushEarly(){
  if(this.readyState!=='closed'&&!this.onmessage)return;
  clearInterval(this.earlyTimer);this.earlyTimer=null;const early=this.early||[];this.early=null;
  for(const text of early)this.deliver(text,true);}
 end(reason){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.({code:1000,reason,wasClean:false});}
}
let channel=null,viewer=null;
function startScreen(explicit=false){
 // One stream per Pip: while another tab of this Pip shows its screen, this one takes it back only when asked (Show here).
 if(!screenMode()||S.screen.state==='opening'||S.screen.state==='live'||S.screen.state==='restarting'&&!explicit||S.screen.state==='elsewhere'&&!explicit)return;
 S.screen={state:'opening',reason:''};render();
 channel=new ScreenChannel();
 const Viewer=globalThis.__dgcTestRFB||RFB;
 try{
  viewer=new Viewer($('pc-vnc'),channel,{shared:true});
  viewer.scaleViewport=S.fit;viewer.resizeSession=false;viewer.focusOnClick=true;viewer.background='transparent';
  viewer.addEventListener?.('connect',()=>{S.screen={state:'live',reason:''};S.restart=null;S.sizePicked=false;render();});
  viewer.addEventListener?.('disconnect',()=>{if(!['closed','elsewhere','restarting'].includes(S.screen.state)){S.screen={state:'closed',reason:S.screen.reason||'The screen closed.'};render();}});
  // What was copied on the computer (ServerCutText): text only, at most 1 MB.
  viewer.addEventListener?.('clipboard',event=>{const text=event?.detail?.text;if(typeof text!=='string')return;
   const over=bytesOf(text)>CLIP_BYTES;S.clip={...S.clip,there:over?null:text,over,fresh:S.panel!=='clip'};render();});
 }catch(error){S.screen={state:'closed',reason:errorText(error)};render();return;}
 vscode.postMessage({type:'pipDesktop',op:'open',...(S.numbers?which():{})});
}
function overlayMarkup(){
 const name=esc(S.pip?.name||'The Pip');
 if(S.screen.state==='opening')return `<p class="pc-overlay-note">Opening ${name}'s screen…</p>`;
 if(S.screen.state==='restarting')return `<p class="pc-overlay-note">Restarting ${name}'s computer…</p>`;
 if(S.screen.state==='elsewhere')return `<div class="pc-overlay-card"><p>${esc(`Showing ${S.screen.name||'its computer'} in another tab`)}</p><button type="button" id="pc-show-here">Show here</button></div>`;
 if(S.screen.state==='closed')return `<div class="pc-overlay-card"><p>${esc(S.screen.reason||'The screen closed.')}</p><button type="button" id="pc-reconnect">Open the screen again</button></div>`;
 return using()?`<p class="pc-overlay-badge">${name} is using its computer. You can watch; it is yours again when it stops.</p>`:'';
}
// Its image editor, document editor and PDF viewer (Pips API 54). When this computer lacks them, one line asks once to
// download them (what and how big); declined, it never asks again. Nothing to show when they are all here.
function appsMarkup(){
 const a=S.apps;if(!a||S.apiVersion<54||!S.computer?.granted)return '';
 const off=S.appsBusy?' disabled':'';
 if(a.state==='offer')return `<div class="pc-notice pc-apps" role="group" aria-label="Apps for this computer"><span>${esc(a.line)}</span>`
  +`<button type="button" data-apps="download"${off}>Download</button><button type="button" class="pc-quiet" data-apps="not_now"${off}>Not now</button></div>`;
 if(a.state==='downloading'||a.state==='unavailable')return `<p class="pc-notice pc-apps" role="status">${esc(a.line)}</p>`;
 return '';
}
async function loadApps(){
 if(!S.pip||!S.connected||S.apiVersion<54||!S.computer?.granted)return;
 try{const value=pipComputerApps((await send('get_pip_computer_apps')).apps);const changed=JSON.stringify(value)!==JSON.stringify(S.apps);S.apps=value;if(changed)render();}
 catch{/* the next look tries again */}
}
async function answerApps(choice){
 if(S.appsBusy)return;S.appsBusy=true;render();
 try{S.apps=pipComputerApps((await send('set_pip_computer_apps',{choice})).apps);S.notice=choice==='download'?'Downloading. Its apps appear on its dock when they are ready.':'Not now. It won’t ask again.';}
 catch(error){S.error=errorText(error);}
 finally{S.appsBusy=false;render();}
}
// ---- The screen's own bar: how it is shown, its size, full screen, and the keyboard and clipboard panels.
const ICON={
 size:'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 13.75h5M8 11.25v2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
 keys:'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.25" y="3.75" width="13.5" height="8.5" rx="1.75" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 6.5h.01M6.65 6.5h.01M9.35 6.5h.01M12 6.5h.01M4 9.6h.01M12 9.6h.01M6.4 9.6h3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
 clip:'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3.25" y="2.75" width="9.5" height="11.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 2.75V2a.75.75 0 0 1 .75-.75h2.5A.75.75 0 0 1 10 2v.75M5.75 7h4.5M5.75 9.5h4.5M5.75 12h2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
 files:'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.9l1.6 1.75h5a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
 full:'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
 leave:'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'};
const bytesOf=text=>new TextEncoder().encode(text).length;
const sizeWords=size=>size.replace('x',' × ');
// The sizes its screen may have (Pips API 86). One size (a Mac), or an older DGC: nothing to choose.
function screenSizes(){const all=S.apiVersion>=86&&Array.isArray(S.computer?.screens)?S.computer.screens:[];return all.length>1&&all.includes(S.computer.screen)?all:[];}
// The size the screen on show really is, from the viewer's own canvas.
function liveSize(){const canvas=S.screen.state==='live'?$('pc-vnc')?.querySelector('canvas'):null;return canvas?.width&&canvas?.height?`${canvas.width}x${canvas.height}`:'';}
// A size is taken as the screen next starts: until then the one on show is the old one.
function needsRestart(){if(!screenSizes().length||S.screen.state!=='live')return false;const live=liveSize();return live?live!==S.computer.screen:S.sizePicked;}
// The keys and the clipboard are the user's while the screen is on and no Pip run has the keyboard (DGC drops them then).
function mayType(){return S.screen.state==='live'&&!using();}
function toolsMarkup(){
 const busy=using(),name=S.pip?.name||'The Pip',off=!mayType(),why=busy?`${name} is using it`:'';
 const tool=(id,label,icon,o={})=>`<button type="button" id="${id}" class="dgc-btn small pc-tool" aria-label="${esc(label)}" title="${esc(o.off&&why?why:label)}"`
  +`${o.expanded!==undefined?` aria-expanded="${o.expanded}"`:''}${o.popup?' aria-haspopup="menu"':''}${o.off?' disabled':''}>${icon}<span class="pc-tool-label">${esc(label)}</span>${o.dot?'<span class="pc-dot" aria-hidden="true"></span>':''}</button>`;
 const sizes=screenSizes();
 const menu=S.sizeMenu&&sizes.length?`<div id="pc-size-menu" class="dgc-menu pc-size-menu" role="menu" aria-label="Screen size"><div class="dgc-menu-head" role="presentation"><span>Screen size</span></div>`
  +window.DgcMenu.html([{rows:sizes.map(size=>({id:size,label:sizeWords(size),checked:size===S.computer.screen,attrs:S.sizeBusy?'disabled':''}))}],{role:'menuitemradio',data:'size',check:true})+'</div>':'';
 return `<span class="pc-seg" role="group" aria-label="Zoom"><button type="button" id="pc-fit" class="dgc-btn small pc-tool" aria-pressed="${S.fit}" title="Fit the screen to this tab">Fit</button>`
  +`<button type="button" id="pc-actual" class="dgc-btn small pc-tool" aria-pressed="${!S.fit}" title="Real size: scroll to see the rest">100%</button></span>`
  +(sizes.length?tool('pc-size','Screen size',ICON.size,{expanded:S.sizeMenu,popup:true}):'')
  +tool('pc-keys','Keyboard',ICON.keys,{expanded:S.panel==='keys'&&!off,off})
  +tool('pc-clip','Clipboard',ICON.clip,{expanded:S.panel==='clip'&&!off,off,dot:S.clip.fresh&&!off})
  // Its Files (the folder DGC keeps for this computer): open whenever the computer is, also while a Pip run uses it.
  +tool('pc-files','Files',ICON.files,{expanded:S.panel==='files'})
  +(busy?`<span class="pc-using" id="pc-using" role="status">${esc(why)}</span>`:'')
  +`<span class="pc-tools-end"></span>`+tool('pc-full',S.full?'Leave full screen':'Full screen',S.full?ICON.leave:ICON.full)+menu;
}
function stripMarkup(){
 if(!needsRestart())return '';
 return `<div class="pc-restart" id="pc-restart-note" role="status"><span>Its screen is set to ${esc(sizeWords(S.computer.screen))}. Restart its computer to use it.</span>`
  +`<button type="button" id="pc-restart" class="dgc-btn small"${S.restart||using()?' disabled':''}${using()?` title="${esc(`${S.pip?.name||'The Pip'} is using it`)}"`:''}>Restart</button></div>`;
}
// Keys the editor would catch before the computer saw them, as X keysyms: each press goes down in order, then up in reverse.
const XK={esc:0xff1b,tab:0xff09,enter:0xff0d,del:0xffff,ctrl:0xffe3,alt:0xffe9,super:0xffeb};
const KEYBOARD=[['esc','Esc',[XK.esc]],['tab','Tab',[XK.tab]],['ctrl-alt-del','Ctrl+Alt+Del',[XK.ctrl,XK.alt,XK.del]],['ctrl-w','Ctrl+W',[XK.ctrl,0x77]],['ctrl-t','Ctrl+T',[XK.ctrl,0x74]],
 ['ctrl-l','Ctrl+L',[XK.ctrl,0x6c]],['alt-tab','Alt+Tab',[XK.alt,XK.tab]],['super','Super',[XK.super]],...Array.from({length:12},(_,i)=>[`f${i+1}`,`F${i+1}`,[0xffbe+i]])];
function panelMarkup(){
 if(S.panel==='files')return filesMarkup(true);
 if(!mayType()||!S.panel)return '';
 if(S.panel==='keys')return `<section class="pc-panel pc-keys-panel" id="pc-keys-panel" role="group" aria-label="Keyboard">`
  +KEYBOARD.map(([id,label])=>`${id==='f1'?'<span class="pc-key-break" aria-hidden="true"></span>':''}<button type="button" class="dgc-btn small pc-key" data-key="${id}">${label}</button>`).join('')+'</section>';
 const c=S.clip,there=c.there??'',shown=there.slice(0,2000);
 return `<section class="pc-panel pc-clip-panel" id="pc-clip-panel" aria-label="Clipboard">`
  +`<div class="pc-clip-half"><label class="pc-clip-head" for="pc-paste-text">Paste in</label><textarea id="pc-paste-text" rows="3" spellcheck="false" placeholder="Text for its clipboard"></textarea>`
  +`<div class="pc-clip-row"><button type="button" id="pc-paste" class="dgc-btn small primary"${c.typing?' disabled':''}>Paste in</button><button type="button" id="pc-type" class="dgc-btn small"${c.typing?' disabled':''}>${c.typing?'Typing…':'Type it'}</button>`
  +`<span class="pc-clip-note${c.bad?' pc-clip-bad':''}" id="pc-clip-note" role="${c.bad?'alert':'status'}">${esc(c.note)}</span></div></div>`
  +`<div class="pc-clip-half"><span class="pc-clip-head" id="pc-there-head">Copied there</span>`
  +(there?`<pre class="pc-there" id="pc-there" tabindex="0" aria-labelledby="pc-there-head">${esc(shown)}</pre>${there.length>shown.length?`<p class="pc-muted pc-clip-more">Showing the start. Copy takes all of it.</p>`:''}`
   :`<p class="pc-muted pc-there-none" id="pc-there">${c.over?'It copied more than 1 MB: too much to bring here.':'Nothing copied there yet. Text only, up to 1 MB.'}</p>`)
  +`<div class="pc-clip-row"><button type="button" id="pc-copy" class="dgc-btn small"${there?'':' disabled'}>Copy</button></div></div></section>`;
}
// A part of the stage is redrawn only when what it says changes, so a poll never takes a box you are typing in.
const drawn=new Map();
function put(id,html){const el=$(id);if(!el||drawn.get(id)===html&&(el.innerHTML!==''||html===''))return false;drawn.set(id,html);el.innerHTML=html;return true;}
function applyFit(){if(viewer&&'scaleViewport' in viewer&&viewer.scaleViewport!==S.fit){viewer.clipViewport=false;viewer.scaleViewport=S.fit;}}
function renderScreen(){
 const app=document.getElementById('app');
 if(!$('pc-live')){drawn.clear();app.innerHTML=`<div id="pc-top"></div><div class="pc-stage" id="pc-stage"><div class="pc-tools" id="pc-tools" role="toolbar" aria-label="Screen"></div><div id="pc-strip"></div><div id="pc-panel"></div>`
  +`<div class="pc-desktop pc-live" id="pc-live"><div id="pc-vnc" class="pc-vnc" aria-label="${esc(S.pip?.name||'The Pip')}'s computer screen"></div><div id="pc-overlay" class="pc-overlay"></div>${cursorMarkup()}</div></div>`;}
 cleanupFace?.();
 $('pc-top').innerHTML=`${headerMarkup()}${S.error?`<p class="pc-error" role="alert">${esc(S.error)}</p>`:''}${S.notice?`<p class="pc-notice" role="status">${esc(S.notice)}</p>`:''}${appsMarkup()}${waitingMarkup()}`;
 $('pc-overlay').innerHTML=overlayMarkup();
 const focus=document.activeElement?.id;
 if(put('pc-tools',toolsMarkup())){
  const menu=$('pc-size-menu');
  if(menu){window.DgcMenu.keys(menu,{close:()=>{S.sizeMenu=false;render();},trigger:()=>$('pc-size')});
   // Under its button, and inside the tab however narrow it is.
   const bar=$('pc-tools'),button=$('pc-size');menu.style.left=`${Math.max(8,Math.min(button.offsetLeft,bar.clientWidth-menu.offsetWidth-8))}px`;menu.style.top=`${button.offsetTop+button.offsetHeight+4}px`;}
  if(focus&&$(focus)&&document.activeElement?.id!==focus)$(focus).focus();
 }
 put('pc-strip',stripMarkup());
 const box=$('pc-paste-text'),caret=box&&document.activeElement===box?[box.selectionStart,box.selectionEnd]:null;
 if(put('pc-panel',panelMarkup())){const now=$('pc-paste-text');if(now){now.value=S.clip.draft;if(caret){now.focus();try{now.setSelectionRange(...caret);}catch{}}}}
 $('pc-live').classList.toggle('pc-actual',!S.fit);
 document.body.classList.toggle('pc-fill',S.full==='tab');
 applyFit();
 cleanupFace=window.PipConcepts?.plush?.mount?.($('pc-top'));
 placeCursor();
}
// Full screen: the screen with its bar. The browser's own when the editor allows it; else it fills this whole tab.
async function enterFull(){
 const stage=$('pc-stage');if(!stage||S.full)return;
 try{if(!stage.requestFullscreen)throw Error('no full screen here');await stage.requestFullscreen();S.full='screen';}
 catch{S.full='tab';}
 render();$('pc-full')?.focus();
}
function leaveFull(){
 if(!S.full)return;
 if(document.fullscreenElement)void document.exitFullscreen?.().catch(()=>{});
 S.full='';render();
}
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&S.full==='screen'){S.full='';render();}});
function pressKeys(id){
 const key=KEYBOARD.find(k=>k[0]===id);if(!key||!mayType()||!viewer?.sendKey)return;
 for(const sym of key[2])viewer.sendKey(sym,null,true);
 for(const sym of [...key[2]].reverse())viewer.sendKey(sym,null,false);
}
function clipSay(note,bad=false){S.clip={...S.clip,note,bad};render();}
function pasteIn(){
 const text=S.clip.draft;if(!mayType()||!viewer?.clipboardPasteFrom)return;
 if(!text){clipSay('Type or paste some text first.',true);return;}
 if(bytesOf(text)>CLIP_BYTES){clipSay('That is over 1 MB. Send less.',true);return;}
 viewer.clipboardPasteFrom(text);clipSay('On its clipboard. Press Ctrl+V there to paste it.');
}
// The text as keys, for a box that refuses a paste: a few at a time, and it stops when a Pip run takes the keyboard.
function keysymOf(char){
 const code=char.codePointAt(0);
 if(char==='\n')return XK.enter;if(char==='\t')return XK.tab;
 if(code<0x20||code>=0x7f&&code<0xa0)return 0;
 return code<=0xff?code:0x01000000+code;
}
function typeIt(){
 const text=S.clip.draft;if(!mayType()||!viewer?.sendKey||S.clip.typing)return;
 if(!text){clipSay('Type or paste some text first.',true);return;}
 const chars=[...text.replace(/\r\n?/g,'\n')];
 if(chars.length>TYPE_CHARS){clipSay(`Type it takes up to ${TYPE_CHARS.toLocaleString('en-US')} characters. Use Paste in for more.`,true);return;}
 S.clip={...S.clip,typing:true,note:'',bad:false};render();
 const mine=viewer;let at=0;
 const step=()=>{
  if(viewer!==mine||!mayType()){S.clip={...S.clip,typing:false,note:'Stopped typing.',bad:true};render();return;}
  for(const char of chars.slice(at,at+40)){const sym=keysymOf(char);if(sym){mine.sendKey(sym,null,true);mine.sendKey(sym,null,false);}}
  at+=40;
  if(at<chars.length)setTimeout(step,20);else{S.clip={...S.clip,typing:false,note:'Typed.',bad:false};render();}
 };
 step();
}
async function chooseSize(size){
 if(S.sizeBusy||!screenSizes().includes(size))return;
 if(size===S.computer.screen){S.sizeMenu=false;render();$('pc-size')?.focus();return;}
 S.sizeBusy=true;render();
 try{
  const result=await send('set_pip_computer_screen',{pip_id:S.pip.id,size});
  if(!record(result)||result.screen!==size)throw Error('The screen size was not saved. Try again.');
  ++computerRefreshSerial;   // a look started before this must not put the old size back
  S.computer={...S.computer,screen:size};S.sizePicked=S.screen.state==='live';S.error='';
 }catch(error){S.error=errorText(error);}
 finally{S.sizeBusy=false;S.sizeMenu=false;render();$('pc-size')?.focus();}
}
// Restart = stop its computer, then open it again: the screen comes back at the size chosen.
let restartTimer=null;
function reopenSoon(wait){clearTimeout(restartTimer);restartTimer=setTimeout(()=>{if(!S.restart)return;S.restart.tries++;S.screen={state:'restarting',reason:''};startScreen(true);},wait);}
async function restartComputer(){
 if(S.restart||using()||!S.pip)return;
 S.restart={tries:0};S.error='';render();
 try{await send('stop_pip_computer',{pip_id:S.pip.id});}
 catch(error){S.restart=null;S.error=errorText(error);render();return;}
 S.view=null;
 if(S.screen.state==='live'||S.screen.state==='opening'){S.screen={state:'restarting',reason:''};render();reopenSoon(6000);}   // its close comes first, as a rule
 else{S.screen={state:'restarting',reason:''};render();reopenSoon(600);}
}
// When DGC can download the desktop itself, show progress. An OS sandbox denial needs the
// machine's own setup; keep its exact reason visible instead of showing a permanent spinner.
function installMarkup(){
 const d=S.desktop;
 if(!S.screenCapable||!d)return S.computer?.available===false&&S.computer.reason?`<p class="pc-notice pc-install" role="status">${esc(S.computer.reason)}</p>`:'';
 if(d.available)return '';
 const s=d.setup;
 if(s&&!d.install&&(s.state==='running'||s.state==='none'&&d.reason.startsWith('Setting up this computer'))){
  // Plain words, no package names or megabytes (reported: "just show it as Setting up your Pip").
  // Downloading is most of the wait; unpacking finishes the bar.
  const share=s.total>0?(s.step==='Unpacking'?90+Math.round(s.done/s.total*10):Math.round(s.done/s.total*90)):null;
  return `<div class="pc-notice pc-setup" role="status"><strong>Setting up your Pip…</strong>`
   +(share!==null?`<span class="pc-setup-bar" role="progressbar" aria-label="Setting up your Pip" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100,share)}"><span style="width:${Math.min(100,share)}%"></span></span>`:'')
   +`<small>Getting its computer ready. This happens once.</small></div>`;
 }
 if(!d.reason&&!d.install)return '';
 return `<p class="pc-notice pc-install" role="status">${esc(d.reason)}${d.install?` <code>${esc(d.install)}</code>`:''}</p>`;
}
function render(){
 // The page's own title follows its computer's name, as the tab's does (src/pipsView.ts).
 if(S.pip&&document.title!==tabTitle())document.title=tabTitle();
 // With its real screen the tab has no side gutter: the screen runs edge to edge (pipComputer.css).
 document.body.classList.toggle('pc-screen-mode',screenMode());
 if(screenMode()){renderScreen();return;}
 if(S.full){if(document.fullscreenElement)void document.exitFullscreen?.().catch(()=>{});S.full='';}
 document.body.classList.remove('pc-fill');
 const app=document.getElementById('app');
 const pane=!S.computer?'':!S.computer.granted?`<section class="pc-window pc-note"><p>${esc(S.pip?.name||'This Pip')} has no computer yet. Give it one with the computer button at the top of its chat.</p></section>`:!S.computer.available?`<section class="pc-window pc-note"><p>This Pip’s computer cannot start on this machine yet. Follow the setup shown above, then reopen this tab.</p></section>`:!S.app?'':windowMarkup(S.app,S.app==='files'?filesMarkup():S.app==='terminal'?terminalMarkup():browserMarkup());
 const focus=document.activeElement?.id,caret=document.activeElement?.selectionStart;
 cleanupFace?.();
 app.innerHTML=`${headerMarkup()}${S.error?`<p class="pc-error" role="alert">${esc(S.error)}</p>`:''}${S.notice?`<p class="pc-notice" role="status">${esc(S.notice)}</p>`:''}${installMarkup()}${appsMarkup()}${waitingMarkup()}<div class="pc-desktop">${pane}${S.computer?.granted&&S.computer.available?dockMarkup():''}</div>`;
 cleanupFace=window.PipConcepts?.plush?.mount?.(app);
 if(focus&&$(focus)){$(focus).focus();if(caret!=null&&$(focus).setSelectionRange)try{$(focus).setSelectionRange(caret,caret);}catch{}}
 const log=$('pc-log');if(log)log.scrollTop=log.scrollHeight;
 const img=$('pc-screen');if(img)img.addEventListener('load',placeCursor,{once:true});
 placeCursor();
}

async function loadComputer(){
 if(!S.pip||!S.connected)return;
 const pipId=S.pip.id,serial=++computerRefreshSerial;
 try{
  const computer=pipComputer((await send('get_pip_computer',{pip_id:pipId})).computer,pipId);
  if(serial!==computerRefreshSerial||S.pip?.id!==pipId)return;
  S.computer=computer;if(!S.actionError)S.error='';
 }catch(error){if(serial!==computerRefreshSerial||S.pip?.id!==pipId)return;S.error=errorText(error);}
 render();
 void loadApps();
}
async function loadDesktop(){
 if(!S.pip||!S.connected||S.apiVersion<43||!S.screenCapable)return;
 const wasScreen=screenMode();
 try{S.desktop=pipComputerDesktop((await send('get_pip_computer_desktop',{pip_id:S.pip.id})).desktop,S.pip.id);}
 catch(error){S.desktop=null;}
 // While its desktop is being set up, look again often; once it is there the screen takes over.
 const settingUp=S.desktop?.setup?.state==='running';
 if(settingUp&&setupTimer===null)setupTimer=setInterval(()=>void loadDesktop(),1500);
 if(!settingUp&&setupTimer!==null){clearInterval(setupTimer);setupTimer=null;}
 if(screenMode())startScreen();
 if(screenMode()!==wasScreen)schedule();
 render();
}
async function frame(op='frame',fields={},opening=false){
 if(!S.pip||!S.computer?.granted||frameBusy&&op==='frame')return;frameBusy=true;
 const was=using();
 try{
  if(opening)await send('open_pip_computer',{pip_id:S.pip.id,...which()});
  const reply=pipComputerView((await send('use_pip_computer_view',{pip_id:S.pip.id,op,...fields,...which()})).view);
  if(reply.ok){S.view=reply;S.viewError='';notePointer(reply.pointer);}else{S.view=null;S.viewError=reply.error;}
 }catch(error){S.view=null;S.viewError=errorText(error);}
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
 const a=(S.computer?.actions||[]).find(x=>x.id===id);if(!a||S.busy)return;
 ++computerRefreshSerial; // A poll started before this decision must not restore its old card.
 S.busy=true;S.error='';S.actionError=false;S.notice='';render();
 try{
  if(how==='always'){
   const result=await send('always_allow_pip_computer_action',{action_id:a.id,expected_digest:a.digest});
   const done=pipComputerAction(result.action,S.pip.id);
   if(done.id!==a.id||done.status!=='approved'||!result.grant)throw Error('The approval did not complete. Refresh and try again.');
   S.notice='Sent, and allowed from now on for this browser request.';
  }else{
   const d=pipComputerAction((await send('decide_pip_computer_action',{action_id:a.id,expected_digest:a.digest,approve:how==='send'})).action,S.pip.id);
   if(d.id!==a.id||d.status!==(how==='send'?'approved':'rejected'))throw Error('The saved decision differs from your choice. Refresh and try again.');
   S.notice=a.summary?.kind==='site'?(d.status==='approved'?'Allowed. It opens the site and carries on.':'Not now. It won’t open it.'):a.summary?.kind==='text'?(d.status==='approved'?'Allowed once. It carries on.':'Not now. It won’t do that.'):d.status==='approved'?'Approved. It is sent within a few seconds, exactly as shown.':'Rejected. Nothing was sent.';
  }
  S.computer={...S.computer,actions:S.computer.actions.filter(item=>item.id!==a.id)};
 }catch(error){S.error=errorText(error);S.actionError=true;}
 finally{S.busy=false;await loadComputer();}
}
function screenPoint(event){
 const img=$('pc-screen');if(!img)return null;const box=img.getBoundingClientRect();
 return {x:Math.round((event.clientX-box.left)/box.width*Number(img.dataset.width)),y:Math.round((event.clientY-box.top)/box.height*Number(img.dataset.height))};
}
function schedule(){
 clearInterval(frameTimer);clearInterval(statusTimer);clearInterval(terminalTimer);clearInterval(desktopTimer);clearInterval(pointerTimer);
 if(document.hidden||!S.computer?.granted)return;
 statusTimer=setInterval(()=>void loadComputer(),5000);
 if(screenMode()){
  desktopTimer=setInterval(()=>void loadDesktop(),3000);                // the screen streams itself
  if(S.apiVersion>=53)pointerTimer=setInterval(()=>void pollPointer(),700);   // and its cursor is asked for
  return;
 }
 // The browser's window refreshes its screen; without it, a slow check notices the Pip starting.
 frameTimer=setInterval(()=>void frame(),S.app==='browser'?800:4000);
 if(S.app==='terminal')terminalTimer=setInterval(()=>void loadTerminal(),2500);
}
function show(app,explicit=false){
 S.app=app;if(!S.open.includes(app))S.open=[...S.open,app];render();
 if(app==='browser')void frame(explicit?'reopen':'frame',{},true);if(app==='files')void loadFiles();if(app==='terminal')void loadTerminal();
 schedule();vscode.setState({app,fit:S.fit});
}

document.addEventListener('click',event=>{
 // A press anywhere else closes the size menu.
 if(S.sizeMenu&&!event.target.closest?.('#pc-size-menu,#pc-size')){S.sizeMenu=false;render();}
 const t=event.target.closest('button,[data-crumb],img');if(!t)return;
 if(t.dataset.apps)void answerApps(t.dataset.apps);
 else if(t.id==='pc-fit'||t.id==='pc-actual'){S.fit=t.id==='pc-fit';render();vscode.setState({app:S.app,fit:S.fit});}
 else if(t.id==='pc-size'){S.sizeMenu=!S.sizeMenu;render();if(S.sizeMenu)($('pc-size-menu')?.querySelector('[aria-checked="true"]')||$('pc-size-menu')?.querySelector('.dgc-menu-row'))?.focus();}
 else if(t.dataset.size)void chooseSize(t.dataset.size);
 else if(t.id==='pc-keys'||t.id==='pc-clip'){const panel=t.id==='pc-keys'?'keys':'clip';S.panel=S.panel===panel?'':panel;if(S.panel==='clip')S.clip={...S.clip,fresh:false};render();}
 else if(t.id==='pc-files'){S.panel=S.panel==='files'?'':'files';render();if(S.panel==='files')void loadFiles();}
 else if(t.id==='pc-full'){if(S.full)leaveFull();else void enterFull();}
 else if(t.dataset.key)pressKeys(t.dataset.key);
 else if(t.id==='pc-paste')pasteIn();
 else if(t.id==='pc-type')typeIt();
 else if(t.id==='pc-copy'){if(S.clip.there){vscode.postMessage({type:'pipComputerCopy',text:S.clip.there});}}
 else if(t.id==='pc-restart')void restartComputer();
 else if(t.dataset.app)show(t.dataset.app,true);
 else if(t.dataset.minimize){S.app='';render();schedule();vscode.setState({app:'',fit:S.fit});}
 else if(t.dataset.close){S.open=S.open.filter(a=>a!==t.dataset.close);S.app='';render();schedule();vscode.setState({app:'',fit:S.fit});}
 else if(t.id==='pc-reconnect'){S.screen={state:'off',reason:''};startScreen();}
 else if(t.id==='pc-show-here'){S.screen={state:'off',reason:''};startScreen(true);}
 else if(t.id==='pc-reopen-browser')void frame('reopen',{},true);
 else if(t.id==='pc-stop')void send('stop_pip_computer',{pip_id:S.pip.id}).then(()=>{S.notice='Stopped. Its sign-ins are kept.';S.view=null;return loadComputer();},error=>{S.error=errorText(error);render();});
 else if(t.id==='pc-back')void frame('back');
 else if(t.id==='pc-screen'){const p=screenPoint(event);if(p&&!using())void frame('click',p);}
 else if(t.dataset.folder!==undefined){S.files.selected=null;S.files.preview=null;void loadFiles([S.files.path,t.dataset.folder].filter(Boolean).join('/'));}
 else if(t.dataset.file!==undefined)void openFile(t.dataset.file);
 else if(t.dataset.crumb!==undefined){const i=Number(t.dataset.crumb);S.files.selected=null;S.files.preview=null;void loadFiles(S.files.path.split('/').filter(Boolean).slice(0,i).join('/'));}
 else if(t.id==='pc-add'&&!filesHeld()&&bigFiles()&&!S.files.adding&&!S.files.saving){S.files.adding={folder:S.files.path,names:[]};S.files.error='';render();vscode.postMessage({type:'pipComputerAddFiles',folder:S.files.path});}
 else if(t.id==='pc-save-as'&&bigFiles()&&S.files.preview&&!S.files.adding&&!S.files.saving){S.files.saving=S.files.preview.path;S.files.error='';S.notice='';render();vscode.postMessage({type:'pipComputerSaveAs',path:S.files.preview.path});}
 else if(t.id==='pc-save'&&S.files.preview)vscode.postMessage({type:'pipComputerSave',name:S.files.preview.name,data:S.files.preview.data||null,text:S.files.preview.data?null:S.files.preview.text});
 else if(t.id==='pc-remove'&&S.files.preview&&!filesHeld()){const path=S.files.preview.path;void send('remove_pip_computer_file',{pip_id:S.pip.id,path}).then(()=>{S.files.selected=null;S.files.preview=null;return loadFiles();},error=>{S.files.error=errorText(error);render();});}
 else if(t.dataset.send)void decide(t.dataset.send,'send');
 else if(t.dataset.always)void decide(t.dataset.always,'always');
 else if(t.dataset.reject)void decide(t.dataset.reject,'reject');
});
document.addEventListener('submit',event=>{
 event.preventDefault();
 if(event.target.id==='pc-go'){const url=$('pc-url').value.trim();S.address=null;if(url)void frame('go',{url:/^[a-z]+:\/\//i.test(url)?url:/\s/.test(url)||!url.includes('.')?'https://duckduckgo.com/?q='+encodeURIComponent(url):'https://'+url});}
 if(event.target.id==='pc-run')void runCommand($('pc-command').value);
});
document.addEventListener('input',event=>{if(event.target.id==='pc-command')S.terminal.draft=event.target.value;if(event.target.id==='pc-url')S.address=event.target.value;
 if(event.target.id==='pc-paste-text'){S.clip.draft=event.target.value;if(S.clip.note)clipSay('');}});
// Escape leaves full screen. Not while the screen itself has the keys: the viewer keeps those for the computer, and the
// keyboard panel's Esc is a button. (The size menu closes on its own Escape first.)
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&S.full&&!event.defaultPrevented&&!event.target.closest?.('#pc-size-menu,#pc-vnc')){event.preventDefault();leaveFull();$('pc-full')?.focus();}});
// Leaving the bar (or Escape in it) shows the page's own address again, as a browser does. A redraw
// replaces the bar, which blurs it too: that is not leaving, so it waits for the redraw to finish.
document.addEventListener('focusout',event=>{if(event.target.id==='pc-url')setTimeout(()=>{if(document.activeElement?.id!=='pc-url'&&S.address!==null){S.address=null;render();}},0);});
const KEYS=new Set(['Enter','Tab','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','Delete']);
let typed='',typeTimer=null;
document.addEventListener('keydown',event=>{
 if(event.target.id==='pc-url'&&event.key==='Escape'){S.address=null;render();return;}
 if(!event.target.closest?.('.pc-screen')||using()||event.metaKey||event.ctrlKey||event.altKey)return;
 if(KEYS.has(event.key)){event.preventDefault();flushTyped();void frame('key',{key:event.key});}
 else if(event.key.length===1){event.preventDefault();typed+=event.key;clearTimeout(typeTimer);typeTimer=setTimeout(flushTyped,250);}
});
function flushTyped(){clearTimeout(typeTimer);if(!typed)return;const text=typed;typed='';void frame('type',{text});}
document.addEventListener('wheel',event=>{if(!event.target.closest?.('.pc-screen')||using())return;event.preventDefault();void frame('scroll',{dy:Math.max(-2000,Math.min(2000,Math.round(event.deltaY)))});},{passive:false});
document.addEventListener('change',event=>{if(event.target.id==='pc-add-input'&&!filesHeld()){void addFiles([...event.target.files]);event.target.value='';}});
// Where Files is on show: its window, or the panel under the live screen. There, a Pip run using the computer holds Add and Remove.
const filesShown=()=>screenMode()?S.panel==='files':S.app==='files';
const filesHeld=()=>screenMode()&&using();
document.addEventListener('dragover',event=>{if(filesShown()&&!filesHeld()&&[...(event.dataTransfer?.types||[])].includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{if(!filesShown()||filesHeld())return;const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();void addFiles(files);});
async function addFiles(files){
 let said='';
 for(const file of files){
  // A dropped file has no path in a webview, so it travels as before, 2 MB at most; a bigger one goes by Add file….
  if(file.size>2*1024*1024){S.files.error=bigFiles()?'Use Add file… for files over 2 MB.':`${file.name} is over 2 MB.`;said=S.files.error;render();continue;}
  const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve(null);reader.readAsDataURL(file);});
  if(typeof data!=='string')continue;
  try{await send('add_pip_computer_file',{pip_id:S.pip.id,path:S.files.path,name:file.name,data});}
  catch(error){S.files.error=said=errorText(error);}
 }
 await loadFiles();
 // Reading the list again clears the panel's message: what was refused stays said.
 if(said&&!S.files.error){S.files.error=said;render();}
}
document.addEventListener('visibilitychange',schedule);
window.addEventListener('message',event=>{
 const m=event.data;if(!record(m))return;
 if(m.type==='pipsReply')broker.receive(m);
 else if(m.type==='pipsConnection'){const was=S.connected;S.connected=m.connected&&m.supported&&m.enabled;S.apiVersion=m.apiVersion;S.generation=m.generation;if(!S.connected)broker.reset();render();
  if(S.connected&&!was)void loadComputer().then(loadDesktop).then(()=>{if(screenMode()){schedule();return;}if(S.app)show(S.app);else{void frame();schedule();}});}
 else if(m.type==='pipComputerInit'&&record(m.pip)){S.pip=m.pip;S.screenCapable=m.desktop===true;
  S.number=Number.isSafeInteger(m.number)&&m.number>=1&&m.number<=1000?m.number:0;S.name=typeof m.name==='string'?m.name.slice(0,60):'';S.numbers=S.number>0&&m.numbers===true;render();}
 // A rename, from wherever it was made: the header takes the new name at once (the tab's title is the host's).
 else if(m.type==='pipComputerNames'&&Array.isArray(m.names)){const mine=m.names.find(n=>record(n)&&n.number===S.number);
  if(mine&&typeof mine.name==='string'){S.name=mine.name.slice(0,60);if(Array.isArray(S.computer?.names))S.computer={...S.computer,names:S.computer.names.map(n=>{const now=m.names.find(v=>record(v)&&v.number===n.number);return now&&typeof now.name==='string'?{...n,name:now.name.slice(0,60)}:n;})};render();}}
 // Its screen is showing in another tab of this Pip (one stream per Pip): say so, and offer it here.
 else if(m.type==='pipDesktopElsewhere'){S.screen={state:'elsewhere',reason:'',name:typeof m.name==='string'?m.name.slice(0,60):''};const old=channel;channel=null;old?.end('');render();}
 else if(m.type==='pipDesktopData'&&typeof m.data==='string')channel?.deliver(m.data);
 // Restarting: its screen closing is expected, and it is opened again (a few tries while the old one winds down).
 else if(m.type==='pipDesktopClosed'&&S.restart&&S.restart.tries<5){const old=channel;channel=null;S.screen={state:'restarting',reason:''};old?.end('');render();reopenSoon(700+400*S.restart.tries);}
 else if(m.type==='pipDesktopClosed'){S.restart=null;S.screen={state:'closed',reason:typeof m.reason==='string'&&m.reason?m.reason:'The screen closed.'};channel?.end(S.screen.reason);render();}
 else if(m.type==='pipComputerCopied'){clipSay(m.ok===true?'Copied.':'Could not copy here.',m.ok!==true);}
 // Add file…: the files are picked (their names show as "copying", fewer as each lands), then what DGC said of each.
 else if(m.type==='pipComputerAdding'&&S.files.adding&&Array.isArray(m.names)){S.files.adding={...S.files.adding,names:m.names.filter(n=>typeof n==='string').slice(0,200).map(n=>n.slice(0,255))};render();if(m.refresh===true)void loadFiles();}
 else if(m.type==='pipComputerAdded'){S.files.adding=null;const errors=Array.isArray(m.errors)?m.errors.filter(e=>typeof e==='string'&&e).slice(0,5).map(e=>e.slice(0,500)):[];
  const say=()=>{if(errors.length)S.files.error=errors.join(' ');render();};
  // The list is read again first (a read clears the panel's message), then DGC's words for what it refused are shown.
  if(m.cancelled!==true&&S.pip&&S.connected)void loadFiles().then(say);else say();}
 else if(m.type==='pipComputerSavedAs'){S.files.saving='';if(m.ok===true)S.notice=`Saved to ${typeof m.name==='string'&&m.name?m.name.slice(0,255):'this computer'}.`;else if(m.cancelled!==true)S.files.error=typeof m.error==='string'&&m.error?m.error.slice(0,500):'Not saved.';render();}
 else if(m.type==='pipComputerSaved'){S.notice=m.ok?`Saved ${m.name}.`:m.error||'Not saved.';render();}
});
setInterval(()=>broker.expire(Date.now()),5000);
S.app=['browser','files','terminal',''].includes(vscode.getState()?.app)?vscode.getState().app:'';S.open=S.app?[S.app]:[];S.fit=vscode.getState()?.fit!==false;
const style=document.createElement('style');style.textContent=window.PipConcepts?.plush?.styles||'';document.head.append(style);
render();
vscode.postMessage({type:'pipsReady'});
