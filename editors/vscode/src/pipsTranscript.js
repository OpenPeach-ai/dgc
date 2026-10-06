import {esc,activityLabel} from './pipsModel.js';

// These controls mirror the main conversation's action row. They are SVG rather
// than font glyphs so they also work inside the Pip client's isolated ShadowRoot.
export function transcriptIcon(name) {
  const paths={copy:'<rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 5V2H2v9h3"/>',check:'<path d="m3 8 3 3 7-8"/>',edit:'<path d="m10 2 4 4-8 8H2v-4Z M8 4l4 4"/>',retry:'<path d="M13 6a5.5 5.5 0 1 0 .2 4M13 2v4H9"/>',info:'<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5v.2"/>',tool:'<path d="M6 2 3 8l3 6M10 2l3 6-3 6"/>',files:'<path d="M3 1.5h6l4 4v9H3Z M9 1.5V6h4 M5.5 9h5M5.5 11.5h3"/>',chevron:'<path d="m6 3 5 5-5 5"/>'};
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||''}</svg>`;
}

const phase=status=>({queued:'Queued',running:'Working',cancelling:'Stopping',failed:'Failed',cancelled:'Stopped'}[status]||'');
const action=(name,label,id,disabled=false)=>`<button type="button" class="ract" data-chat-action="${name}" data-message-id="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}"${disabled?' disabled':''}>${transcriptIcon(name)}<span class="sr-only">${esc(label)}</span></button>`;

// A reply as a chat would show it: one short bubble per paragraph. A code block or a list stays
// in one piece, and a long reply never becomes more than eight bubbles.
export function replyParts(text) {
  const parts=[];let current=[],fence=false;
  const flush=()=>{const chunk=current.join('\n').trim();if(chunk)parts.push(chunk);current=[];};
  for(const line of String(text).split('\n')){
    if(/^\s*(```|~~~)/.test(line))fence=!fence;
    if(!fence&&!line.trim()){flush();continue;}
    current.push(line);
  }
  flush();
  const listy=p=>/^\s*([-*+]|\d+[.)])\s/.test(p);
  const merged=[];for(const p of parts){if(merged.length&&listy(p)&&listy(merged.at(-1)))merged[merged.length-1]+='\n\n'+p;else merged.push(p);}
  return merged.length>8?[...merged.slice(0,7),merged.slice(7).join('\n\n')]:merged;
}

export function messageMarkup(message,{name,formatDate,renderMarkdown,prompt,canSend,activity,split=false,imageSrc=()=>''}) {
  const m=message,user=m.role==='user',label=user?'You':name;
  const pictures=user&&Array.isArray(m.images)&&m.images.length?`<div class="msg-images">${m.images.slice(0,4).map(i=>{const key=`${m.id}:${Number(i.index)}`,src=imageSrc(m.id,Number(i.index));return `<img class="msg-image" data-message-image="${esc(key)}" alt="Image ${Number(i.index)+1}"${src?` src="${esc(src)}"`:''}>`;}).join('')}</div>`:'';
  const size=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`;
  const files=user&&Array.isArray(m.files)&&m.files.length?`<div class="msg-files">${m.files.slice(0,4).map(f=>{const name=String(f.name||''),dot=name.lastIndexOf('.');return `<span class="msg-file" title="${esc(name)}"><span class="chat-file-ext" aria-hidden="true">${esc((dot>0?name.slice(dot+1):'txt').slice(0,4))}</span><span class="chat-file-name">${esc(name)}</span><span class="chat-file-size">${esc(size(Number(f.bytes)||0))}</span></span>`;}).join('')}</div>`:'';
  // A message that is only images or files shows them, not DGC's stand-in text.
  const standIn=pictures&&m.text==='(sent an image)'||files&&m.text==='(sent a file)';
  const body=user?`${pictures}${files}${standIn?'':`<div class="bubble"><div class="prompt-text">${esc(m.text)}</div></div>`}`:split?`<div class="answer split">${replyParts(m.text).map(part=>`<div class="message-body text final reply-part">${renderMarkdown(part)}</div>`).join('')}</div>`:`<div class="answer"><div class="message-body text final">${renderMarkdown(m.text)}</div></div>`;
  const status=user&&phase(m.status)?`<p class="message-status" role="status" data-status="${esc(m.status)}">${phase(m.status)}${m.status==='failed'||m.status==='cancelled'?' · No completed reply was recorded.':''}</p>`:'';
  const options=!user&&prompt?`${action('retry','Run this prompt again',m.id,!canSend)}${action('edit','Edit this prompt',m.id,false)}`:'';
  const details=`<details class="message-details" data-details="message-${esc(m.id)}"><summary title="${user?'Message details':'Response details'}" aria-label="${user?'Message details':'Response details'}">${transcriptIcon('info')}<span class="sr-only">${user?'Message details':'Response details'}</span></summary><div class="message-provenance"><dl><dt>${user?'Sent':'Saved'}</dt><dd>${esc(formatDate(m.created_at))}</dd>${!user&&m.model?`<dt>Model</dt><dd>${esc(m.model)}</dd>`:''}<dt>Status</dt><dd>${esc(m.status)}</dd></dl><button type="button" data-chat-run="${esc(m.run_id)}">${m.status==='failed'?'View error':'Run details'}</button></div></details>`;
  const activityRow=!user?`<button type="button" class="chat-activity-toggle" data-chat-activity="${esc(m.run_id)}" aria-expanded="${activity?.open===true}">${transcriptIcon('tool')}<span>${activity?.loading?'Loading activity…':'Tool activity'}</span><span class="activity-chevron">${transcriptIcon('chevron')}</span></button>${activity?.open?activityMarkup(activity,m.run_id):''}`:'';
  return `<article class="pip-message msg ${user?'user':'assistant dgc'}" data-message="${esc(m.id)}"><span class="sr-only role">${esc(label)}</span>${activityRow}${body}${status}<div class="response-actions">${action('copy',user?'Copy message':'Copy response',m.id)}${options}${details}<span class="copy-feedback sr-only" role="status"></span></div></article>`;
}

export function activityMarkup(value,runId) {
  const rows=(value.events||[]).filter(e=>e.event_type!=='pip_run_progress'||e.payload.kind!=='text_delta');
  return `<div class="chat-activity" aria-label="Saved tool activity">${value.error?`<p class="notice error">${esc(value.error)}</p>`:''}${rows.map(e=>`<div class="chat-tool-row"><span class="tool-glyph">${transcriptIcon('tool')}</span><span>${esc(activityLabel(e))}</span></div>`).join('')}${!value.loading&&!rows.length&&!value.error?'<p class="muted">No tool activity was recorded.</p>':''}${value.truncated?'<p class="muted">Earlier activity is no longer retained.</p>':''}${value.hasMore?`<button type="button" data-chat-run="${esc(runId)}">View complete run activity</button>`:''}</div>`;
}

export function executionCardMarkup(run,{changedFiles=null,tests=null,error='',formatDate}) {
  const patch=run.manifest.run_kind==='patch',files=changedFiles||[];
  return `<section class="chat-result-card" aria-label="${patch?'Private edited files':'Recorded test results'}"><div class="chat-result-head"><span class="chat-result-mark">${transcriptIcon('files')}</span><div><strong>${patch?'Edited files in private copy':'Test results'}</strong><small>${esc(formatDate(run.finished_at||run.created_at))} · ${esc(run.status)}</small></div><button type="button" data-chat-run="${esc(run.id)}">Review</button></div>${error?`<p class="notice error">${esc(error)}</p>`:changedFiles!==null?`<ul>${files.slice(0,8).map(path=>`<li>${transcriptIcon('files')}<span>${esc(path)}</span></li>`).join('')}</ul>${files.length>8?`<p class="muted">${files.length-8} more files in the review.</p>`:''}${!files.length?'<p class="muted">No source files changed.</p>':''}${tests!==null?`<p class="muted">${tests} recorded test ${tests===1?'invocation':'invocations'}.</p>`:''}`:'<p class="muted">Open the saved run to inspect its evidence.</p>'}<p class="chat-result-note">Your working tree is unchanged. Review this isolated result before using it.</p></section>`;
}
