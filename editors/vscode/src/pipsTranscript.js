import {esc,activityLabel} from './pipsModel.js';

// These controls mirror the main conversation's action row. They are SVG rather
// than font glyphs so they also work inside the Pip client's isolated ShadowRoot.
export function transcriptIcon(name) {
  const paths={plug:'<path d="M6 2v3M10 2v3"/><path d="M4.5 5h7v2a3.5 3.5 0 0 1-7 0Z"/><path d="M8 10.5V14"/>',speaker:'<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5Z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',stop:'<rect x="4" y="4" width="8" height="8" rx="1"/>',copy:'<rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 5V2H2v9h3"/>',check:'<path d="m3 8 3 3 7-8"/>',edit:'<path d="m10 2 4 4-8 8H2v-4Z M8 4l4 4"/>',retry:'<path d="M13 6a5.5 5.5 0 1 0 .2 4M13 2v4H9"/>',info:'<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5v.2"/>',tool:'<path d="M6 2 3 8l3 6M10 2l3 6-3 6"/>',files:'<path d="M3 1.5h6l4 4v9H3Z M9 1.5V6h4 M5.5 9h5M5.5 11.5h3"/>',chevron:'<path d="m6 3 5 5-5 5"/>'};
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||''}</svg>`;
}

const phase=status=>({queued:'Queued',running:'Working',cancelling:'Stopping',failed:'Failed',cancelled:'Stopped'}[status]||'');
// Read aloud (media/readaloud.js keeps it in step): a speaker, and Stop while it reads.
const readAction=id=>`<button type="button" class="ract" data-chat-action="read" data-message-id="${esc(id)}" data-read-aloud="${esc(id)}" aria-label="Read aloud" title="Read aloud" aria-pressed="false"><span class="ra-play">${transcriptIcon('speaker')}</span><span class="ra-stop">${transcriptIcon('stop')}</span><span class="sr-only">Read aloud</span></button>`;
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

export function messageMarkup(message,{name,formatDate,renderMarkdown,prompt,canSend,activity,split=false,imageSrc=()=>'',pluginLogo=()=>'',choices=null,stats=null}) {
  const m=message,user=m.role==='user',label=user?'You':name;
  const pictures=user&&Array.isArray(m.images)&&m.images.length?`<div class="msg-images">${m.images.slice(0,4).map(i=>{const key=`${m.id}:${Number(i.index)}`,src=imageSrc(m.id,Number(i.index));return `<img class="msg-image" data-message-image="${esc(key)}" alt="Image ${Number(i.index)+1}"${src?` src="${esc(src)}"`:''}>`;}).join('')}</div>`:'';
  const size=n=>n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`;
  const files=user&&Array.isArray(m.files)&&m.files.length?`<div class="msg-files">${m.files.slice(0,4).map(f=>{const name=String(f.name||''),dot=name.lastIndexOf('.');return `<span class="msg-file" title="${esc(name)}"><span class="chat-file-ext" aria-hidden="true">${esc((dot>0?name.slice(dot+1):'txt').slice(0,4))}</span><span class="chat-file-name">${esc(name)}</span><span class="chat-file-size">${esc(size(Number(f.bytes)||0))}</span></span>`;}).join('')}</div>`:'';
  // A message that is only images or files shows them, not DGC's stand-in text.
  const standIn=pictures&&m.text==='(sent an image)'||files&&m.text==='(sent a file)';
  const body=user?`${pictures}${files}${standIn?'':`<div class="bubble"><div class="prompt-text">${esc(m.text)}</div></div>`}`:split?`<div class="answer split">${replyParts(m.text).map(part=>`<div class="message-body text final reply-part">${renderMarkdown(part)}</div>`).join('')}</div>`:`<div class="answer"><div class="message-body text final">${renderMarkdown(m.text)}</div></div>`;
  // The plugins it took an answer from, as ChatGPT names the apps it used ("Used [logo] Aave"): what it says came
  // from a plugin did, rather than from the model's memory. A logo not here yet shows a plug until the host sends it.
  const plugins=!user&&Array.isArray(m.plugins)?m.plugins.slice(0,8):[];
  const used=plugins.length?`<div class="msg-plugins" title="This reply used ${plugins.length===1?'this plugin':'these plugins'}"><span>Used</span> ${plugins.map((p,i)=>{const src=pluginLogo(p.plugin);return `<span class="msg-plugin"><span class="msg-plugin-mark" data-plugin-mark="${esc(p.plugin)}">${src?`<img alt="" src="${esc(src)}">`:transcriptIcon('plug')}</span><span>${esc(p.name)}${i<plugins.length-1?',':''}</span></span>`;}).join(' ')}</div>`:'';
  // Grok's A/B card: the choices the Pip offered under its latest reply; a tap answers it.
  const offered=!user&&Array.isArray(choices)&&choices.length?`<div class="msg-choices" role="group" aria-label="Answer ${esc(name)}">${choices.slice(0,4).map((c,i)=>`<button type="button" class="msg-choice" data-pip-choice="${esc(c)}"${canSend?'':' disabled'}><span class="msg-choice-key" aria-hidden="true">${'ABCD'[i]}</span><span>${esc(c)}</span></button>`).join('')}</div>`:'';
  const status=user&&phase(m.status)?`<p class="message-status" role="status" data-status="${esc(m.status)}">${phase(m.status)}${m.status==='failed'&&m.error?` · ${esc(m.error)}`:m.status==='failed'||m.status==='cancelled'?' · No reply':''}</p>`:'';
  const options=!user&&prompt?`${action('retry','Ask again',m.id,!canSend)}${action('edit','Edit message',m.id,false)}`:'';
  const details=`<details class="message-details" data-details="message-${esc(m.id)}"><summary title="${user?'Message details':'Response details'}" aria-label="${user?'Message details':'Response details'}">${transcriptIcon('info')}<span class="sr-only">${user?'Message details':'Response details'}</span></summary><div class="message-provenance"><dl><dt>${user?'Sent':'Saved'}</dt><dd>${esc(formatDate(m.created_at))}</dd>${!user&&m.model?`<dt>Model</dt><dd>${esc(m.model)}</dd>`:''}<dt>Status</dt><dd>${esc(({queued:'Waiting',running:'Working',cancelling:'Stopping',succeeded:'Done',failed:'Failed',cancelled:'Stopped'})[m.status]||m.status)}</dd></dl><button type="button" data-chat-run="${esc(m.run_id)}">${m.status==='failed'?'View error':'Details'}</button></div></details>`;
  const activityRow=!user?`<button type="button" class="chat-activity-toggle" data-chat-activity="${esc(m.run_id)}" aria-expanded="${activity?.open===true}">${transcriptIcon('tool')}<span>${activity?.loading?'Loading…':'What it did'}</span><span class="activity-chevron">${transcriptIcon('chevron')}</span></button>${activity?.open?activityMarkup(activity,m.run_id):''}`:'';
  return `<article class="pip-message msg ${user?'user':'assistant dgc'}" data-message="${esc(m.id)}"><span class="sr-only role">${esc(label)}</span>${activityRow}${body}${used}${offered}${status}<div class="response-actions">${action('copy',user?'Copy message':'Copy response',m.id)}${!user&&m.text&&globalThis.DgcReadAloud?readAction(m.id):''}${options}${details}${!user&&stats?replyStats(stats):''}<span class="copy-feedback sr-only" role="status"></span></div></article>`;
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
  return `<section class="chat-result-card" aria-label="${patch?'Private edited files':'Recorded test results'}"><div class="chat-result-head"><span class="chat-result-mark">${transcriptIcon('files')}</span><div><strong>${patch?'Edited files in private copy':'Test results'}</strong><small>${esc(formatDate(run.finished_at||run.created_at))} · ${esc(run.status)}</small></div><button type="button" data-chat-run="${esc(run.id)}">Review</button></div>${error?`<p class="notice error">${esc(error)}</p>`:changedFiles!==null?`<ul>${files.slice(0,8).map(path=>`<li>${transcriptIcon('files')}<span>${esc(path)}</span></li>`).join('')}</ul>${files.length>8?`<p class="muted">${files.length-8} more files in the review.</p>`:''}${!files.length?'<p class="muted">No source files changed.</p>':''}${tests!==null?`<p class="muted">${tests} recorded test ${tests===1?'invocation':'invocations'}.</p>`:''}`:'<p class="muted">Open the saved run to inspect its evidence.</p>'}<p class="chat-result-note">Your working tree is unchanged. Review this isolated result before using it.</p></section>`;
}
