import {esc,activityLabel,personalStatusLabel} from './pipsModel.js';
import {cronDays} from './pipRoutines.js';
import {postArtifact,docCardMarkup} from './pipRunPosts.js';   // a long reply's document: the card a run's post draws
import {FOLDER_ICON} from './pipProjects.js';   // a project's mark in a sent message (pips-21)
import '../media/mentions.js';   // globalThis.DgcMentions: @ marks in the bubble, the same in all three chats
import '../media/msgtime.js';   // globalThis.DgcTime: a message's time, the same in all three chats
import '../media/pictureFold.js';   // globalThis.DgcPictureFold: a reply's pictures fold away, the same in all three chats
import '../media/shared/filesheet.js';   // globalThis.DgcFileSheet: a made file's small sheet and its Download mark

const foldPictures=(key,inner,facts)=>globalThis.DgcPictureFold?globalThis.DgcPictureFold.markup(key,inner,facts):inner;

// These controls mirror the main conversation's action row. They are SVG rather
// than font glyphs so they also work inside the Pip client's isolated ShadowRoot.
export function transcriptIcon(name) {
  const paths={plug:'<path d="M6 2v3M10 2v3"/><path d="M4.5 5h7v2a3.5 3.5 0 0 1-7 0Z"/><path d="M8 10.5V14"/>',speaker:'<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5Z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',stop:'<rect x="4" y="4" width="8" height="8" rx="1"/>',copy:'<rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 5V2H2v9h3"/>',check:'<path d="m3 8 3 3 7-8"/>',edit:'<path d="m10 2 4 4-8 8H2v-4Z M8 4l4 4"/>',retry:'<path d="M13 6a5.5 5.5 0 1 0 .2 4M13 2v4H9"/>',info:'<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5v.2"/>',tool:'<path d="M6 2 3 8l3 6M10 2l3 6-3 6"/>',files:'<path d="M3 1.5h6l4 4v9H3Z M9 1.5V6h4 M5.5 9h5M5.5 11.5h3"/>',chevron:'<path d="m6 3 5 5-5 5"/>',reply:'<path d="M6.5 4 2.5 8l4 4"/><path d="M2.5 8h7a4 4 0 0 1 4 4v.5"/>',clock:'<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',yes:'<path d="M5.2 7.2 7.6 2.4c.9 0 1.6.7 1.6 1.6v2h3a1.2 1.2 0 0 1 1.2 1.4l-.8 4.6a1.2 1.2 0 0 1-1.2 1H5.2Z"/><path d="M5.2 7.2H2.6V13h2.6"/>'};
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||''}</svg>`;
}

const phase=status=>({queued:'Queued',running:'Working',cancelling:'Stopping',failed:'Failed',cancelled:'Stopped'}[status]||'');
// Read aloud (media/readaloud.js keeps it in step): a speaker, and Stop while it reads.
const readAction=id=>`<button type="button" class="ract" data-chat-action="read" data-message-id="${esc(id)}" data-read-aloud="${esc(id)}" aria-label="Read aloud" title="Read aloud" aria-pressed="false"><span class="ra-play">${transcriptIcon('speaker')}</span><span class="ra-stop">${transcriptIcon('stop')}</span><span class="sr-only">Read aloud</span></button>`;
const action=(name,label,id,disabled=false)=>`<button type="button" class="ract" data-chat-action="${name}" data-message-id="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}"${disabled?' disabled':''}>${transcriptIcon(name)}<span class="sr-only">${esc(label)}</span></button>`;

// A reply as the Pip means it to read: one bubble, or the short messages it parts with a line of just ---
// (pip_chat.BUBBLES). Where it breaks is the Pip's call: split at every paragraph, a poem came apart at each
// stanza and an email draft at each paragraph (asked 2026-11-03: "leave this to the llm model to decide").
// A --- in a code block is code, the --- lines are not shown, and a reply is never more than eight bubbles.
export function replyParts(text) {
  const parts=[];let current=[],fence=false;
  const flush=()=>{const chunk=current.join('\n').trim();if(chunk)parts.push(chunk);current=[];};
  for(const line of String(text).split('\n')){
    if(/^\s*(```|~~~)/.test(line))fence=!fence;
    if(!fence&&/^\s*---\s*$/.test(line)){flush();continue;}
    current.push(line);
  }
  flush();
  return parts.length>8?[...parts.slice(0,7),parts.slice(7).join('\n\n')]:parts;
}

// A reply that read messages sent while it worked (Pips API 99, `steers`: [{id, at}]) is drawn in pieces, each of
// those messages between the words written before it was read and the words written after. `at` counts characters as
// Python does, so the text is cut by code point. `has(id)`: is that message here to be drawn (one from a page not
// loaded isn't, and the words on each side of it stay together). Returns [{text} | {steer: id}], no empty text.
export function replyPieces(text,steers,has=()=>true){
  const chars=[...String(text)],out=[];let from=0;
  const words=to=>{const piece=chars.slice(from,to).join('');from=to;if(piece.trim()){const last=out.at(-1);if(last&&'text' in last)last.text+=piece;else out.push({text:piece});}};
  for(const s of Array.isArray(steers)?steers:[]){if(!has(s.id)||s.at<from||s.at>chars.length)continue;words(s.at);out.push({steer:s.id});}
  words(chars.length);
  return out;
}

// A sent message's words with its links as links: the same button a reply's link is, with its site's favicon, as in
// Work and ChatDGC (media/mentions.js, "links"). A page with no document (a test of the words alone) gets the words.
const promptWords=text=>globalThis.DgcMentions?.linkWordsHtml&&globalThis.document?globalThis.DgcMentions.linkWordsHtml(String(text),{doc:globalThis.document}):esc(text);
// A message's words with its @ marks where they were typed, or "" for plain words. A face keeps a key of its own, so a
// redraw leaves it moving (pipsDomPatch.js).
function promptWithMarks(m,pluginLogo){
  const M=globalThis.DgcMentions;
  if(!M||!Array.isArray(m.display_mentions)||!m.display_mentions.length)return '';
  let n=0;
  // (The words between the marks: their links are links, built where no image loads until the page draws them.)
  const words=text=>{const held=globalThis.document.createElement('template');held.innerHTML=`<div>${M.linkWordsHtml(text,{doc:globalThis.document})}</div>`;return held.content.firstChild;};
  const node=M.sentNode(String(m.text),m.display_mentions,{doc:globalThis.document,words,
    pillFor:mark=>({logo:mark.kind==='plugin'?pluginLogo(mark.identity):'',plug:transcriptIcon('plug'),folder:FOLDER_ICON,faceStyles:false,faceId:`sent-${m.id}-${++n}`}),
    decorate:(pill,mark)=>{if(mark.kind!=='pip')return;const face=pill.querySelector('.composer-pip-face');if(face){face.setAttribute('data-avatar-key',`mention-${m.id}-${n}`);face.setAttribute('data-character',mark.pip_type);face.setAttribute('data-pose','idle');}}});
  return node?node.innerHTML:'';
}

// What a Personal Pip changed about itself at once, in a turn you started (Pips API 77, D6): one line per change after
// the reply that made it, "Pitch updated its job: name, instructions · Undo · Details", and Undone after an Undo.
const OWN_FIELD_WORDS={name:'name',goal:'instructions',schedule:'schedule',model_choice:'model'};
function scheduleWords(s){
  if(!s)return 'none (only when you ask)';
  if(s.type==='daily')return `every day at ${s.time}${s.timezone?` (${s.timezone})`:''}`;
  if(s.type==='interval')return `every ${s.minutes} minutes`;
  if(s.type==='once')return `once, at ${s.at}`;
  if(s.type==='cron'){
    const d=cronDays(s.cron),when=!d?s.cron:d.days==='Every day'?`every day at ${d.time}`:`on ${/^Week/.test(d.days)?d.days.toLowerCase():d.days} at ${d.time}`;
    return `${when}${s.timezone?` (${s.timezone})`:''}`;
  }
  return String(s.type||'');
}
function modelWords(c){
  if(!c||c.mode==='default')return 'DGC\u2019s default';
  if(c.mode==='router')return 'DGC Router';
  if(c.mode==='subscription')return c.engine==='codex'?'Codex':'Claude Code';
  return String(c.model||c.mode||'');
}
export function ownChangesMarkup(m,{name,undo=false,open=new Set(),busy='',errors=new Map()}){
  const changes=Array.isArray(m.changes)?m.changes.filter(c=>c&&typeof c.id==='string'&&/^own_[0-9a-f]{32}$/.test(c.id)).slice(0,8):[];
  if(!changes.length)return '';
  return changes.map(c=>{
    const after=c.after&&typeof c.after==='object'?c.after:{},routine=c.kind==='routine';
    // As it was called when it made the change: a later rename doesn't change what an older line says.
    const who=typeof after.by==='string'&&after.by?after.by:typeof after.name==='string'&&after.name?after.name:name;
    const words=routine?`${who} added a routine: ${String(after.title||'')}`
      :`${who} updated its job: ${(Array.isArray(c.fields)?c.fields:[]).map(f=>OWN_FIELD_WORDS[f]||f).join(', ')}`;
    const rows=routine?[['When',after.when],['What it does',after.prompt]]
      :(c.fields||[]).map(f=>[f==='goal'?'Instructions':f==='model_choice'?'Model':f[0].toUpperCase()+f.slice(1),
        f==='schedule'?scheduleWords(after.schedule):f==='model_choice'?modelWords(after.model_choice):after[f]]);
    const undone=c.status==='undone',shown=open.has(c.id);
    const act=undone?'<span class="own-change-undone">Undone</span>'
      :undo?`<button type="button" class="own-change-undo" data-own-undo="${esc(c.id)}"${busy?' disabled':''}>${busy===c.id?'Undoing\u2026':'Undo'}</button>`:'';
    // The dot after the words stays with them, and Undo · Details stay together, so a narrow chat never starts a line on a dot.
    return `<div class="own-change" data-own-change="${esc(c.id)}" data-status="${undone?'undone':'applied'}"><p class="own-change-line"><span class="own-change-words">${esc(words)}<span class="own-change-sep" aria-hidden="true">\u00a0\u00b7</span></span>`
      +`<span class="own-change-acts">${act?`${act}<span class="own-change-sep" aria-hidden="true">\u00b7</span>`:''}<button type="button" class="own-change-more" data-own-details="${esc(c.id)}" aria-expanded="${shown}">Details</button></span></p>`
      // Why an Undo couldn't happen, on the line itself: the page's own error slot is at the top of a long chat.
      +(errors.get(c.id)?`<p class="own-change-error" role="alert">${esc(errors.get(c.id))}</p>`:'')
      +`<dl class="own-change-list"${shown?'':' hidden'}>${rows.filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl></div>`;
  }).join('');
}

// One quiet line above a message: the start of the message it answers or replies to ("↪ book the 9 am train"). Drawn
// above a reply only when it answers something other than the message just above it, and above your own message when
// you chose Reply on one of the Pip's (pips-17c). One line, cut with an ellipsis; all of it is the tooltip.
export function quoteLine(text,{reply=false,who=''}={}){
  const words=String(text||'').replace(/^\s*---\s*$/gm,' ').replace(/\s+/g,' ').trim();
  if(!words)return '';
  const shown=words.length>160?words.slice(0,159).trimEnd()+'\u2026':words,said=reply?`Replying to ${who||'its message'}: `:'Answering: ';
  return `<p class="msg-quote" title="${esc(words.slice(0,600))}"><span class="msg-quote-mark" aria-hidden="true">\u21aa</span><span class="sr-only">${esc(said)}</span><span class="msg-quote-text">${esc(shown)}</span></p>`;
}
// Read receipts for a message sent while the Pip was working (pips-17c): a quiet clock until its model has read it,
// then a small tick, "Read by <Pip>". A message that started a reply of its own needs neither.
function readMark(m,name){
  if(m.role!=='user'||m.steered!==true)return '';
  const read=m.steer_status==='applied',waits=m.steer_status==='pending'&&(m.status==='queued'||m.status==='running');
  if(!read&&!waits)return '';
  const label=read?`Read by ${name}`:`${name} hasn\u2019t read this yet`;
  return `<span class="msg-read" data-read="${read?'read':'waiting'}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${transcriptIcon(read?'check':'clock')}</span>`;
}

// A thumbs-up answers an open question (pips-08). The rule, kept narrow: only the Pip's latest reply, only while its
// choices are still waiting, and only when they read as yes or no: one begins with a yes word and another with a no
// word. The thumb then sends the first yes choice, in the Pip's own words ("Yes, send it"), exactly as a tap on that
// choice does. Any other choices ("Tea" / "Coffee") get no thumb: a bare "Yes" would answer nothing.
const YES_WORDS=/^(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|sounds good|approve|confirm|continue|proceed|allow)(?![\p{L}\p{N}])/iu;
const NO_WORDS=/^(?:no|nope|not now|not yet|don[\u2019']t|do not|cancel|stop|skip|later|never|wait|decline|reject)(?![\p{L}\p{N}])/iu;
export function yesChoice(choices){
  const list=Array.isArray(choices)?choices.slice(0,4).filter(c=>typeof c==='string').map(c=>c.trim()).filter(Boolean):[];
  const yes=list.find(c=>YES_WORDS.test(c));
  return yes&&list.some(c=>NO_WORDS.test(c))?yes:'';
}

// A file DGC made for you in a reply, as a row (pips-08; the reference: a file icon, the name, "PDF · 2.4 MB" and
// Download). In a Pip's chat that is each picture it made (generate_image): the row is the shared document card
// (media/shared/doccard.css) with the small sheet of its kind (media/shared/filesheet.js).
const fileBytes=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`;
const PICTURE_ENDING={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp'};
export function madeFilesMarkup(m){
  const sheets=globalThis.DgcFileSheet,made=Array.isArray(m.images)?m.images.slice(0,64).filter(i=>i&&Number.isInteger(i.index)&&i.index>=0&&PICTURE_ENDING[i.mime]):[];
  if(!sheets||!made.length)return '';
  return `<div class="msg-made-files" role="group" aria-label="Files in this reply">${made.map(i=>{
    const ending=PICTURE_ENDING[i.mime],name=`Picture ${i.index+1}.${ending}`,kind=sheets.of(ending,name),size=Number.isFinite(i.bytes)&&i.bytes>0?fileBytes(i.bytes):'';
    return `<div class="dgc-doc-card msg-made-file" data-tone="img"><span class="dgc-doc-tile has-sheet" aria-hidden="true">${sheets.forFile(ending,name)}</span>`
      +`<span class="dgc-doc-words"><span class="dgc-doc-name">${esc(name)}</span><span class="dgc-doc-meta">${esc(kind.tag)}${size?` \u00b7 ${esc(size)}`:''}</span></span>`
      +`<span class="dgc-doc-acts"><button type="button" class="dgc-doc-dl" data-message-download="${esc(`${m.id}:${i.index}`)}" aria-label="Download ${esc(name)}" title="Download">${sheets.DOWNLOAD}</button></span></div>`;
  }).join('')}</div>`;
}

// `inline`: the messages a reply read on the way, each one's drawn bubble by its id (replyPieces); `live`: the reply as
// it is being written, the finished reply's own markup without the row it ends with.
// `head`: a line above a reply the Pip sent unasked (a routine's: its face, name, routine and time); `clip`: {text, open,
// key}, a long one's start and its Show all.
export function messageMarkup(message,{name,formatDate,renderMarkdown,prompt,canSend,activity,split=false,imageSrc=()=>'',pluginLogo=()=>'',choices=null,stats=null,head='',clip=null,quote='',canReply=false,canDownload=false,undo=false,openChanges=new Set(),undoing='',undoErrors=new Map(),inline=null,live=false}) {
  const m=message,user=m.role==='user',label=user?'You':name;
  // Every photo the message brought (no four-photo cap from Pips API 52); a click opens the original.
  // A Pip's reply shows the images it made (generate_image) the same way, below its words.
  const pictures=Array.isArray(m.images)&&m.images.length?`<div class="msg-images">${m.images.slice(0,64).map(i=>{const key=`${m.id}:${Number(i.index)}`,src=imageSrc(m.id,Number(i.index));return `<img class="msg-image" data-message-image="${esc(key)}" data-pic-open alt="Image ${Number(i.index)+1}" title="Open the photo"${src?` src="${esc(src)}"`:''}>`;}).join('')}</div>`:'';
  const size=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`;
  const files=user&&Array.isArray(m.files)&&m.files.length?`<div class="msg-files">${m.files.slice(0,50).map(f=>{const name=String(f.name||''),dot=name.lastIndexOf('.');return `<span class="msg-file" title="${esc(name)}"><span class="chat-file-ext" aria-hidden="true">${esc((dot>0?name.slice(dot+1):'txt').slice(0,4))}</span><span class="chat-file-name">${esc(name)}</span><span class="chat-file-size">${esc(size(Number(f.bytes)||0))}</span></span>`;}).join('')}</div>`:'';
  // A message that is only images or files shows them, not DGC's stand-in text.
  const standIn=pictures&&m.text==='(sent an image)'||files&&m.text==='(sent a file)';
  const said=!user&&clip&&!clip.open?clip.text:m.text;
  const words=text=>split?`<div class="answer split">${replyParts(text).map(part=>`<div class="message-body text final reply-part">${renderMarkdown(part)}</div>`).join('')}</div>`:`<div class="answer"><div class="message-body text final">${renderMarkdown(replyParts(text).join('\n\n'))}</div></div>`;
  // The messages it read on the way, where it read them (`inline`: each one's own drawn bubble, by id).
  const pieces=!user&&!clip&&inline&&Array.isArray(m.steers)?replyPieces(m.text,m.steers,id=>inline.has(id)):[];
  const parted=pieces.some(p=>p.steer),lastWords=pieces.findLastIndex(p=>'text' in p);
  const body=user?`${pictures}${files}${standIn?'':`<div class="bubble"><div class="prompt-text">${promptWithMarks(m,pluginLogo)||promptWords(m.text)}</div></div>`}`:(parted?(lastWords<0?'':words(pieces[lastWords].text)):words(said))
    // A reply's pictures and videos fold away under one header row each, as in Work and ChatDGC (media/pictureFold.js).
    +(!user&&pictures?foldPictures(`pip:${m.id}:images`,pictures,{pictures:Math.min(64,m.images.length)}):'')
    // Each picture it made is a file too: a row with its kind, its size and Download (pips-08).
    +(!user&&pictures&&canDownload?madeFilesMarkup(m):'')
    // API 71: the videos it started (generate_video), each its job's figure (media/videoPlayer.js), filled in by the
    // page after it draws: its progress, then its player.
    +(!user&&Array.isArray(m.videos)&&m.videos.length?foldPictures(`pip:${m.id}:videos`,`<div class="msg-videos made-pictures">${m.videos.slice(0,4).map(v=>`<div class="msg-video" data-message-video="${esc(String(v.id||''))}"></div>`).join('')}</div>`,{videos:Math.min(4,m.videos.length),label:m.videos.length===1?String(m.videos[0].prompt||''):''}):'')
    +(!user&&clip?`<button type="button" class="link run-post-show" data-post-more="${esc(clip.key)}" aria-expanded="${clip.open===true}">${clip.open?'Show less':'Show all'}</button>`:'');
  // The plugins it took an answer from, as ChatGPT names the apps it used ("Used [logo] Aave"): what it says came
  // from a plugin did, rather than from the model's memory. A logo not here yet shows a plug until the host sends it.
  const plugins=!user&&Array.isArray(m.plugins)?m.plugins.slice(0,8):[];
  const used=plugins.length?`<div class="msg-plugins" title="This reply used ${plugins.length===1?'this plugin':'these plugins'}"><span>Used</span> ${plugins.map((p,i)=>{const src=pluginLogo(p.plugin);return `<span class="msg-plugin"><span class="msg-plugin-mark" data-plugin-mark="${esc(p.plugin)}">${src?`<img alt="" src="${esc(src)}">`:transcriptIcon('plug')}</span><span>${esc(p.name)}${i<plugins.length-1?',':''}</span></span>`;}).join(' ')}</div>`:'';
  // The plugins' own cards it showed (MCP Apps): each a slot the page fills with the card's live frame
  // (media/mcpApps.js), above its words, so a redraw never reloads one.
  const cards=!user&&Array.isArray(m.apps)?m.apps.filter(a=>a&&/^app_[0-9a-f]{24}$/.test(String(a.card_id||''))).slice(0,8):[];
  const shownCards=cards.length&&globalThis.DgcMcpApps?`<div class="msg-apps">${cards.map(a=>`<div class="mcp-app-slot" data-card-id="${esc(a.card_id)}"></div>`).join('')}</div>`:'';
  // Grok's A/B card: the choices the Pip offered under its latest reply; a tap answers it.
  const offered=!user&&Array.isArray(choices)&&choices.length?`<div class="msg-choices" role="group" aria-label="Answer ${esc(name)}">${choices.slice(0,4).map((c,i)=>`<button type="button" class="msg-choice" data-pip-choice="${esc(c)}"${canSend?'':' disabled'}><span class="msg-choice-key" aria-hidden="true">${'ABCD'[i]}</span><span>${esc(c)}</span></button>`).join('')}</div>`:'';
  // A mid-turn message the reply never read wasn't sent, and says so; one the reply read and then failed has no answer either.
  const unsent=user&&m.steer_status==='missed',again=user&&m.steered&&m.status==='failed'?` <button type="button" class="message-send-again" data-chat-action="resend" data-message-id="${esc(m.id)}"${canSend?'':' disabled'}>Send again</button>`:'';
  // A failed model request in a person's words, with what fixes it and the provider's own answer one click away.
  const failed=m.status==='failed'&&m.error?globalThis.DgcMarkdown?.modelFailure?.(m.error):null;
  const failure=failed?` · ${esc(failed.headline)} ${esc(failed.next)}${failed.fix?` <button type="button" class="message-send-again" data-open-models>Settings → Models</button>`:''}`:'';
  // All of it (API's error_detail), when the short line had to cut it; a DGC from before has only the line.
  const rawFailure=typeof m.error_detail==='string'&&m.error_detail?(globalThis.DgcMarkdown?.editorAdvice?.(m.error_detail)??m.error_detail):failed?.detail;
  const failureDetail=failed?`<details class="message-failure" data-details="failure-${esc(m.id)}"><summary>Details</summary><span>${esc(rawFailure)}</span></details>`:'';
  const status=user&&phase(m.status)?`<p class="message-status" role="status" data-status="${unsent?'unsent':esc(m.status)}">${unsent?'Not sent':phase(m.status)}${failure||(m.status==='failed'&&m.error?` · ${esc(m.error)}`:m.status==='failed'||m.status==='cancelled'?' · No reply':'')}${again}</p>${failureDetail}`:'';
  const options=!user&&prompt?`${action('retry','Ask again',m.id,!canSend)}${action('edit','Edit message',m.id,false)}`:'';
  // The word Trace after the icons, as in Work: only for a reply that recorded its steps (dgc/reply_trace.py).
  const trace=!user&&stats?.has_trace===true?`<button type="button" class="ract ract-trace" data-chat-action="trace" data-message-id="${esc(m.id)}" aria-label="Replay response trace" title="Replay response trace">Trace</button>`:'';
  const details=`<details class="message-details" data-details="message-${esc(m.id)}"><summary title="${user?'Message details':'Response details'}" aria-label="${user?'Message details':'Response details'}">${transcriptIcon('info')}<span class="sr-only">${user?'Message details':'Response details'}</span></summary><div class="message-provenance"><dl><dt>${user?'Sent':'Saved'}</dt><dd>${esc(formatDate(m.created_at))}</dd>${!user&&m.model?`<dt>Model</dt><dd>${esc(m.model)}</dd>`:''}<dt>Status</dt><dd>${unsent?'Not sent':esc(({queued:'Waiting',running:'Working',cancelling:'Stopping',succeeded:'Done',failed:'Failed',cancelled:'Stopped'})[m.status]||m.status)}</dd></dl><button type="button" data-chat-run="${esc(m.run_id)}">${m.status==='failed'&&!unsent?'View error':'Details'}</button></div></details>`;
  // When it was sent or written, at the message's own edge: after a prompt's buttons, before a reply's.
  const at=Date.parse(m.created_at),time=globalThis.DgcTime?.markup(at)||'';
  // A message sent while it worked: its time, then the clock or the tick (it said "Steered" before its time until 0.52).
  const sentTime=time+readMark(m,name);
  // Reply on a Pip's message: it becomes a quote in your prompt box (Pips API 83).
  const replyAction=!user&&canReply&&m.text?action('reply','Reply',m.id):'';
  // A thumbs-up on an open yes-or-no question answers it with its yes choice (yesChoice, above); it stays in sight.
  const yes=!user?yesChoice(choices):'',yesLabel=yes?`Answer \u201c${yes}\u201d`:'';
  const yesAction=yes?`<button type="button" class="ract ract-yes" data-pip-choice="${esc(yes)}" data-pip-yes aria-label="${esc(yesLabel)}" title="${esc(yesLabel)}"${canSend?'':' disabled'}>${transcriptIcon('yes')}<span class="sr-only">${esc(yesLabel)}</span></button>`:'';
  const quoted=quote?quoteLine(quote,{reply:user,who:name}):'';
  // A reply whose run got stuck, or was cut off by a restart, and started again says so in one line (dgc/pip_run_watchdog.py).
  // The one line a reply carries before its time: "Got stuck, started again" (Pips package 1), or that its backup model
  // answered, the first reply of an outage only (Pips package 6).
  const line=!user?[m.started_again,m.backup].filter(v=>typeof v==='string'&&v).join(' · '):'';
  const startedAgain=line?esc(line.slice(0,120)):'';
  const replyTime=startedAgain&&time?time.replace(/(<time[^>]*>)/,`$1${startedAgain} · `):startedAgain?`<span class="msg-time">${startedAgain}</span>`:time;
  const activityRow=!user?`<button type="button" class="chat-activity-toggle" data-chat-activity="${esc(m.run_id)}" aria-expanded="${activity?.open===true}">${transcriptIcon('tool')}<span>${activity?.loading?'Loading…':'What it did'}</span><span class="activity-chevron">${transcriptIcon('chevron')}</span></button>${activity?.open?activityMarkup(activity,m.run_id):''}`:'';
  // A reply in pieces: its first words carry what a reply opens with (What it did, a plugin's card), each message it read
  // follows the words before it, and its last words are the reply itself, with everything a reply ends with. One reply
  // to copy, read aloud and reply to, whatever it read on the way.
  const role=`<span class="sr-only role">${esc(label)}</span>`,opens=`${user?'':head}${role}${quoted}${activityRow}${shownCards}`;
  const drawn=id=>`<div class="steer-inline" data-steer-inline="${esc(id)}">${inline.get(id)}</div>`;
  let before='',after='',opened=false;
  if(parted)pieces.forEach((p,i)=>{
    if(p.steer){if(i>lastWords&&lastWords>=0)after+=drawn(p.steer);else before+=drawn(p.steer);return;}
    if(i===lastWords)return;
    before+=`<article class="pip-message msg assistant dgc reply-piece" data-reply-piece="${esc(m.id)}:${i}">${opened?role:opens}${words(p.text)}</article>`;opened=true;
  });
  return `${before}<article class="pip-message msg ${user?'user':'assistant dgc'}${head&&!user?' routine-reply':''}${parted?' reply-piece reply-end':''}${live?' live-reply':''}" ${live?`data-live-reply="${esc(m.run_id)}" aria-label="Live reply"`:`data-message="${esc(m.id)}"`}>${opened?role:opens}${body}${!user&&postArtifact(m)?docCardMarkup(postArtifact(m)):''}${used}${offered}${user?'':ownChangesMarkup(m,{name,undo,open:openChanges,busy:undoing,errors:undoErrors})}${status}${live?'</article>'+after:`<div class="response-actions">${user?'':head?(startedAgain?`<span class="msg-time">${startedAgain}</span>`:''):replyTime}${yesAction}${action('copy',user?'Copy message':'Copy response',m.id)}${!user&&m.text&&globalThis.DgcReadAloud?readAction(m.id):''}${replyAction}${options}${details}${trace}${!user&&stats?replyStats(stats):''}${user?sentTime:''}<span class="copy-feedback sr-only" role="status"></span></div></article>${after}`}`;
}

// What a reply took, beside its actions: its time and its tokens (in and out, all its model requests).
function replyStats(s){
  const parts=[];
  if(Number.isFinite(s.seconds))parts.push(s.seconds<10?`${s.seconds.toFixed(1)}s`:`${Math.round(s.seconds)}s`);
  const tokens=(s.input_tokens||0)+(s.output_tokens||0);
  if(tokens)parts.push(`${tokens>=10000?Math.round(tokens/1000)+'k':tokens>=1000?(tokens/1000).toFixed(1)+'k':tokens} tokens`);
  if(!parts.length)return '';
  const title=`${(s.input_tokens||0).toLocaleString('en-US')} in · ${(s.output_tokens||0).toLocaleString('en-US')} out · ${s.requests||0} model request${s.requests===1?'':'s'}`;
  return `<span class="reply-stats" title="${esc(title)}">${esc(parts.join(' · '))}</span>`;
}

export function activityMarkup(value,runId) {
  const rows=(value.events||[]).filter(e=>e.event_type!=='pip_run_progress'||e.payload.kind!=='text_delta');
  return `<div class="chat-activity" aria-label="Saved tool activity">${value.error?`<p class="notice error">${esc(value.error)}</p>`:''}${rows.map(e=>`<div class="chat-tool-row"><span class="tool-glyph">${transcriptIcon('tool')}</span><span>${esc(activityLabel(e))}</span></div>`).join('')}${!value.loading&&!rows.length&&!value.error?'<p class="muted">No steps for this reply.</p>':''}${value.truncated?'<p class="muted">Older steps aren’t kept.</p>':''}${value.hasMore?`<button type="button" data-chat-run="${esc(runId)}">View complete run activity</button>`:''}</div>`;
}

export function executionCardMarkup(run,{changedFiles=null,tests=null,error='',formatDate}) {
  const patch=run.manifest.run_kind==='patch',files=changedFiles||[];
  return `<section class="chat-result-card" aria-label="${patch?'Changes in a private copy':'Test results'}"><div class="chat-result-head"><span class="chat-result-mark">${transcriptIcon('files')}</span><div><strong>${patch?'Changes in a private copy':'Test results'}</strong><small>${esc(formatDate(run.finished_at||run.created_at))} · ${esc(personalStatusLabel(run.status))}</small></div><button type="button" data-chat-run="${esc(run.id)}">Review</button></div>${error?`<p class="notice error">${esc(error)}</p>`:changedFiles!==null?`<ul>${files.slice(0,8).map(path=>`<li>${transcriptIcon('files')}<span>${esc(path)}</span></li>`).join('')}</ul>${files.length>8?`<p class="muted">${files.length-8} more files in the review.</p>`:''}${!files.length?'<p class="muted">No files changed.</p>':''}${tests!==null?`<p class="muted">${tests} test ${tests===1?'command':'commands'} ran.</p>`:''}`:'<p class="muted">Open it to see what happened.</p>'}<p class="chat-result-note">Your files haven’t changed. Review this before you use it.</p></section>`;
}
