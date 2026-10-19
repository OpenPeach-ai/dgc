// A Pip's runs in its own chat (Pips API 51). The founder (19 Oct) picked "Yes, post in its chat": each finished
// run is a short message from the Pip in its conversation, the way Grok Bots and OpenAI Dots post a scheduled run,
// and the Runs tab became History. The backend writes one post per run (dgc/pip_run_posts.py, the same summary the
// Work chat's card shows); this draws it, where it falls among the chat's messages, live and on replay alike.
//
// What it draws. Findings: "Today's audit found 5 things, 2 of them high", the top three, Open full report and Ask
// DGC to fix. A failure: what stopped it in plain words, that nothing was changed, and when it runs next. A clean run:
// one quiet line between the messages, not a message. A Personal Pip's result: its words, as a message.
//
// Long chats. Each run is one post. Runs nobody replied to pile up in a "stretch" (posts with no message between
// them); in a stretch, posts more than a day old fold into one "N earlier runs" line, except the stretch's newest.
// A run you missed today stays news; a week of nightly runs nobody answered is history, and History keeps them all.
// A post someone replied to is never folded: the reply ends its stretch.
import {esc,record} from './pipsModel.js';
import '../media/msgtime.js';

const RUN=/^run_[0-9a-f]{32}$/;
export const POST_KINDS=['audit','checks','draft','result'];
export const POST_OUTCOMES=['findings','clear','failed','checks_failed','checks_passed','draft','result'];
const TRIGGERS=['schedule','event','you','chat','handoff'];
const SEVERITIES=['critical','high','medium','low'];
const DAY=86400000;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:0;
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const at=p=>Date.parse(p.posted_at);

export function validPost(p){
  return record(p)&&RUN.test(String(p.run_id||''))&&POST_KINDS.includes(p.kind)&&POST_OUTCOMES.includes(p.outcome)
    &&TRIGGERS.includes(p.trigger)&&typeof p.posted_at==='string'&&Number.isFinite(Date.parse(p.posted_at));
}
/** list_pip_run_posts, checked: oldest first. A post this editor can't read is left out; it never costs the chat. */
export function runPostsPage(value,pip,workspace){
  if(!record(value)||value.pip_id!==pip||value.workspace_id!==workspace||!Array.isArray(value.posts)||value.posts.length>50
    ||!(value.next_before_id===null||typeof value.next_before_id==='string'&&RUN.test(value.next_before_id)))
    throw new Error('Run posts are invalid or belong to another Pip.');
  return {posts:value.posts.filter(validPost),next_before_id:value.next_before_id};
}
/** Merge newly read posts into what is held: one per run, oldest first. */
export function mergePosts(held,more){
  const byRun=new Map(held.map(p=>[p.run_id,p]));
  for(const p of more)byRun.set(p.run_id,p);
  return [...byRun.values()].sort((a,b)=>at(a)-at(b)||(a.run_id<b.run_id?-1:1)).slice(-200);
}
export const quietPost=p=>p.outcome==='clear'||p.outcome==='checks_passed';

const startOfDay=t=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();};
/** "Today's", "Yesterday's", "Saturday's" in the last week; null before that. */
export function dayWord(time,now=Date.now()){
  const days=Math.round((startOfDay(now)-startOfDay(time))/DAY);
  if(days===0)return 'Today’s';
  if(days===1)return 'Yesterday’s';
  if(days>1&&days<7)return `${new Date(time).toLocaleDateString('en-US',{weekday:'long'})}’s`;
  return null;
}
const kindWord=p=>({audit:'audit',checks:'checks',draft:'draft',result:'result'})[p.kind];
/** "Today's audit", or "The audit on 12 Oct". */
export function whose(p,now=Date.now()){
  const day=dayWord(at(p),now);
  return day?`${day} ${kindWord(p)}`:`The ${kindWord(p)} on ${new Date(at(p)).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}`;
}
// The worst severity it found, with how many: "2 high". Medium and low alone are not singled out.
function worst(p){
  for(const s of ['critical','high'])if(count(p.counts?.[s]))return {n:count(p.counts[s]),severity:s};
  return null;
}
const lower=s=>String(s||'').replace(/^(The|Its|It|A|This)\b/,w=>w.toLowerCase());
/** A run in a few words, for a History row: {text, tone}. */
export function postShort(p){
  if(p.outcome==='findings'){const w=worst(p);return {text:`${plural(count(p.total),'finding')}${w?` · ${w.n} ${w.severity}`:''}`,tone:w?'bad':''};}
  if(p.outcome==='clear')return {text:'Nothing found',tone:'clear'};
  if(p.outcome==='checks_passed')return {text:count(p.checks?.total)===1?'The check passed':`All ${count(p.checks?.total)} checks passed`,tone:'clear'};
  if(p.outcome==='checks_failed')return {text:`${count(p.checks?.failed)} of ${plural(count(p.checks?.total),'check')} failed`,tone:'bad'};
  if(p.outcome==='failed'){const r=String(p.reason||'').replace(/\.$/,'');return {text:`Didn’t finish${r?` · ${lower(r).slice(0,90)}`:''}`,tone:'bad'};}
  if(p.outcome==='draft')return {text:'Draft ready',tone:''};
  return {text:'Result ready',tone:''};
}
/** The Pip page's status, under its name: what its last run found. */
export function postStatus(p,now=Date.now()){
  const who=whose(p,now);
  if(p.outcome==='failed')return `${who} didn’t finish`;
  if(p.outcome==='findings')return `${who}: ${plural(count(p.total),'finding')}`;
  if(p.outcome==='clear')return `${who}: nothing found`;
  if(p.outcome==='checks_passed')return `${who}: all passed`;
  if(p.outcome==='checks_failed')return `${who}: ${count(p.checks?.failed)} of ${count(p.checks?.total)} failed`;
  return `${who} is ready`;
}
const TRIGGER_WORDS={schedule:'on its schedule',event:'after a change',you:'you asked',chat:'asked from a chat',handoff:'on a handoff'};
const KIND_TITLE={audit:'Audit',checks:'Checks',draft:'Draft',result:'Result'};
const ICONS={clock:'<path d="M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z"/><path d="M8 4.5V8l2.3 1.6"/>',warn:'<path d="M8 2 1.8 13h12.4Z"/><path d="M8 6.5v3.2M8 11.4v.2"/>'};
const icon=name=>`<svg class="run-post-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const where=f=>typeof f.path==='string'&&f.path?`${f.path}${Number.isSafeInteger(f.line)&&f.line>0?`:${f.line}`:''}`:'';

/** The words of a post's body, as markup. */
function bodyMarkup(p,{now,personal,renderMarkdown}){
  const who=whose(p,now);
  if(p.outcome==='findings'){
    const total=count(p.total),w=worst(p),top=(Array.isArray(p.findings)?p.findings:[]).filter(record).slice(0,3);
    const more=total-top.length;
    return `<p><strong>${esc(who)} found ${esc(plural(total,'thing'))}</strong>${w?`, ${w.n===total&&total>1?`all ${esc(w.severity)}`:`${w.n} of them ${esc(w.severity)}`}`:''}.</p>`
      +`<ul class="run-post-findings">${top.map(f=>{const s=SEVERITIES.includes(f.severity)?f.severity:'low';return `<li><span class="sev" data-sev="${s}">${s}</span><span class="t">${esc(f.title)}</span>${where(f)?`<span class="w">${esc(where(f))}</span>`:''}</li>`;}).join('')}</ul>`
      +(more>0?`<p class="run-post-more">${more} more in the full report</p>`:'');
  }
  if(p.outcome==='checks_failed'){
    const labels=(Array.isArray(p.failed_checks)?p.failed_checks:[]).filter(l=>typeof l==='string').slice(0,3);
    return `<p><strong>${esc(who)}: ${count(p.checks?.failed)} of ${esc(plural(count(p.checks?.total),'check'))} failed.</strong></p>`
      +(labels.length?`<ul class="run-post-findings">${labels.map(l=>`<li><span class="sev" data-sev="high">failed</span><span class="w">${esc(l)}</span></li>`).join('')}</ul>`:'');
  }
  if(p.outcome==='failed'){
    const next=Date.parse(p.next_run_at||''),later=Number.isFinite(next)&&next>now;
    const clock=later?new Date(next).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'',day=later?nextWords(next,now):null;
    const when=day?`${day} at ${clock}`:later?`on ${new Date(next).toLocaleDateString('en-GB',{day:'numeric',month:'short'})} at ${clock}`:'';
    return `<p>${esc(who)} didn’t finish. ${esc(p.reason||'It stopped with an error.')} ${personal?'Nothing was sent or changed.':'Nothing in your project was changed.'}</p>`
      +(later?`<p>I’ll run again ${esc(when)}.</p>`:'');
  }
  if(p.outcome==='draft')return `<p><strong>${esc(who)} is ready:</strong> ${esc(p.title||'a draft')}.</p>${p.summary?`<p class="run-post-summary">${esc(p.summary)}</p>`:''}`;
  if(p.outcome==='result')return `${renderMarkdown(String(p.preview||''))}${p.truncated?'<p class="run-post-more">The rest is in the full result.</p>':''}`;
  return '';
}
// "Tomorrow" is the one word dayWord can't say: a next run in the coming day.
function nextWords(next,now){return startOfDay(next)===startOfDay(now)?'today':startOfDay(next)-startOfDay(now)===DAY?'tomorrow':null;}

/** One post in the chat. `ask`: whether Ask DGC to fix is offered here (a project Pip's audit or checks, with a
 *  chat to send it to); `asked`: it was. `canRun`: Run again now would start a run. */
export function postMarkup(p,{name,face='',now=Date.now(),personal=false,ask=false,asked=false,canRun=false,renderMarkdown=s=>`<p>${esc(s)}</p>`}){
  const time=globalThis.DgcTime?.markup(at(p))||'';
  if(quietPost(p)){
    const short=postShort(p);
    return `<div class="run-post-quiet" data-run-post="${esc(p.run_id)}" data-outcome="${esc(p.outcome)}" role="note" tabindex="-1" aria-label="${esc(`${name}: ${KIND_TITLE[p.kind]} · ${short.text}`)}"><span class="run-post-quiet-line"><span class="ok" aria-hidden="true">✓</span>${time} · ${esc(KIND_TITLE[p.kind])}: ${esc(short.text.charAt(0).toLowerCase()+short.text.slice(1))}<button type="button" class="link" data-post-open="${esc(p.run_id)}">Open</button></span></div>`;
  }
  const failed=p.outcome==='failed';
  const head=`<div class="run-post-head">${face?`<span class="run-post-face" aria-hidden="true">${face}</span>`:''}<strong class="run-post-name">${esc(name)}</strong><span class="run-post-what">${icon(failed?'warn':'clock')}${esc(KIND_TITLE[p.kind])} · ${esc(failed?'didn’t finish':TRIGGER_WORDS[p.trigger])}</span></div>`;
  const actions=[
    `<button type="button" class="${failed?'':'primary'}" data-post-open="${esc(p.run_id)}">${failed?'See what happened':p.kind==='result'?'Open full result':'Open full report'}</button>`,
    failed&&canRun?`<button type="button" data-post-run="${esc(p.run_id)}">Run again now</button>`:'',
    ask&&!personal&&['findings','checks_failed','failed'].includes(p.outcome)&&['audit','checks'].includes(p.kind)
      ?`<button type="button" class="${asked?'asked':''}" data-post-fix="${esc(p.run_id)}"${asked?' disabled title="This run’s prompt was sent to the Work chat."':''}>${asked?'Asked DGC':'Ask DGC to fix'}</button>`:'',
  ].join('');
  return `<article class="pip-message assistant dgc run-post" data-run-post="${esc(p.run_id)}" data-outcome="${esc(p.outcome)}" tabindex="-1" aria-label="${esc(`${name}: ${postStatus(p,now)}`)}">${head}<div class="answer"><div class="message-body text final run-post-body">${bodyMarkup(p,{now,personal,renderMarkdown})}</div></div><div class="run-post-actions">${actions}</div><div class="response-actions">${time}</div></article>`;
}

/** The chat's messages and posts in time order, with old unanswered stretches folded. `complete`: every message
 *  is loaded (else posts older than the first loaded message wait for "Load earlier messages"). */
export function timeline(messages,posts,{complete=true,now=Date.now()}={}){
  const first=messages.length?Date.parse(messages[0].created_at):Infinity;
  const shown=posts.filter(p=>complete||at(p)>=first);
  const items=[];let i=0,j=0;
  while(i<messages.length||j<shown.length){
    const m=messages[i],p=shown[j];
    if(p&&(!m||at(p)<Date.parse(m.created_at)))items.push({post:p}),j++;
    else items.push({message:m}),i++;
  }
  const out=[];
  for(let k=0;k<items.length;){
    if(!items[k].post){out.push(items[k++]);continue;}
    let e=k;while(e<items.length&&items[e].post)e++;
    const stretch=items.slice(k,e).map(x=>x.post),old=[];
    for(const p of stretch.slice(0,-1)){if(now-at(p)>DAY)old.push(p);else break;}
    if(old.length>=2)out.push({fold:old});else old.length=0;
    for(const p of stretch.slice(old.length))out.push({post:p});
    k=e;
  }
  return out;
}
/** "12 earlier runs · 3 with findings · 1 didn't finish", folded; opening it draws them in place. */
export function foldMarkup(posts,draw){
  const findings=posts.filter(p=>['findings','checks_failed'].includes(p.outcome)).length,failed=posts.filter(p=>p.outcome==='failed').length;
  const parts=[plural(posts.length,'earlier run'),findings&&`${findings} with findings`,failed&&`${failed} didn’t finish`].filter(Boolean);
  return `<details class="run-posts-fold" data-details="posts-${esc(posts[0].run_id)}"><summary>${esc(parts.join(' · '))}</summary><div class="run-posts-fold-body">${posts.map(draw).join('')}</div></details>`;
}
