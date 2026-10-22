// A Pip's runs in its own chat (Pips API 51), as the Pip saying them. The founder (21 Oct) picked "The Pip speaks":
// each finished run is a chat message from the Pip, its face and name and the time, in its own short words; the
// detail (findings, the report, Ask DGC to fix) is a small attachment under it, one click away; and repeated all-clear
// runs fold into ONE message that updates itself ("Both checks passed again" · "✓ Passed 12 times since Monday").
// The backend writes one post per run (dgc/pip_run_posts.py, the same summary the Work chat's card shows); this
// draws it where it falls among the chat's messages, live and on replay alike.
//
// The words. Deterministic first person, from the post's own fields: every number, file name and title the Pip says
// is the report's, so its sentence can never contradict it. A model line would read a little better and could
// invent; this can't. A few wordings per kind of run, chosen by the run's id and moved off the wording the run before
// used, so a week of runs doesn't drumbeat, and the same post reads the same every time it is drawn. A Personal Pip's
// task says what the Pip itself wrote, shortened with Show all; so does a routine's reply (pipsClient.js).
//
// Long chats. Runs that passed or found nothing, one after another with no message between them, are one message;
// the next run that finds something or fails breaks the fold and says so in its own message, and a run after you
// write starts a new one. The fold is worked out from the posts every time, so a reload or a replay draws it the
// same. (Before, runs nobody answered folded into "N earlier runs" after a day: a log line where the Pip had spoken.
// The all-clear fold takes the pile that line was for; what remains is news, each said once, and History keeps all.)
import {esc,record} from './pipsModel.js';
import '../media/msgtime.js';

const RUN=/^run_[0-9a-f]{32}$/;
// 'live' (Pips API 60): a live-data Pip's run, its summary grounded in what its approved read-only commands printed.
export const POST_KINDS=['audit','checks','draft','result','live'];
export const POST_OUTCOMES=['findings','clear','failed','checks_failed','checks_passed','draft','result','live_clear','live_attention'];
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

const startOfDay=t=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();};
const daysAgo=(t,now)=>Math.round((startOfDay(now)-startOfDay(t))/DAY);
const clock=t=>new Date(t).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
/** "Today's", "Yesterday's", "Saturday's" in the last week; null before that. */
export function dayWord(time,now=Date.now()){
  const days=daysAgo(time,now);
  if(days===0)return 'Today’s';
  if(days===1)return 'Yesterday’s';
  if(days>1&&days<7)return `${new Date(time).toLocaleDateString('en-US',{weekday:'long'})}’s`;
  return null;
}
const kindWord=p=>({audit:'audit',checks:'checks',draft:'draft',result:'result',live:'check'})[p.kind];
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
const lower=s=>String(s||'').replace(/^(The|Its|It|A|An|This)\b/,w=>w.toLowerCase());
/** A run in a few words, for a History row: {text, tone}. */
export function postShort(p){
  if(p.outcome==='findings'){const w=worst(p);return {text:`${plural(count(p.total),'finding')}${w?` · ${w.n} ${w.severity}`:''}`,tone:w?'bad':''};}
  if(p.outcome==='clear')return {text:'Nothing found',tone:'clear'};
  if(p.outcome==='checks_passed')return {text:count(p.checks?.total)===1?'The check passed':`All ${count(p.checks?.total)} checks passed`,tone:'clear'};
  if(p.outcome==='checks_failed')return {text:`${count(p.checks?.failed)} of ${plural(count(p.checks?.total),'check')} failed`,tone:'bad'};
  if(p.outcome==='live_clear')return {text:'All clear',tone:'clear'};
  if(p.outcome==='live_attention'){const f=count(p.commands?.failed);return {text:f?`Needs you · ${f} of ${plural(count(p.commands?.total),'command')} didn’t run`:'Needs you',tone:'bad'};}
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
  if(p.outcome==='live_clear')return `${who}: all clear`;
  if(p.outcome==='live_attention')return `${who}: needs you`;
  return `${who} is ready`;
}

// ---- The Pip's own words ---------------------------------------------------------------------------------------
// A sentence is a list of parts: text, or {code} for a file name or a check, drawn as code and read as its words.
const code=s=>({code:String(s)});
const seed=id=>parseInt(String(id||'').slice(-8),16)||0;
/** One of a few wordings, by the run's id, moved off the one the run before it got. */
function pick(p,previous,variants){
  const options=variants.filter(Boolean);
  let i=seed(p.run_id)%options.length;
  if(previous&&options.length>1&&seed(previous.run_id)%options.length===i)i=(i+1)%options.length;
  return options[i];
}
const fileOf=f=>typeof f?.path==='string'&&f.path.trim()?f.path.trim().split('/').pop():'';
const titleOf=f=>lower(String(f?.title||'').trim().replace(/[.!?…]+$/,''));
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
const list=items=>items.flatMap((item,i)=>i===0?[item]:[i===items.length-1?' and ':', ',item]);
function findingsWords(p,previous){
  const total=count(p.total),c=count(p.counts?.critical),h=count(p.counts?.high),m=count(p.counts?.medium),l=count(p.counts?.low);
  const top=(Array.isArray(p.findings)?p.findings:[]).filter(record),first=top[0],title=first?titleOf(first):'';
  // "in billing.py" only when the report lists every finding and they are all in it.
  const one=top.length===total&&top.length>0&&top.every(f=>fileOf(f)&&f.path===top[0].path)?fileOf(top[0]):'';
  const where=one?[' in ',code(one)]:[];
  if(total===1){
    const kind={critical:'critical ',high:'serious ',low:'small '}[first?.severity]||'';
    const what=title?[': ',title,'.']:['.'];
    return pick(p,previous,[['I found one ',kind,'issue',...where,...what],['One ',kind,'issue',...where,' this run',...what]]);
  }
  const severity=c&&h?`${c} critical and ${h} serious`:c?(c===total?(total===2?'both critical':'all critical'):`${c} of them critical`)
    :h?(h===total?(total===2?'both serious':'all serious'):`${h} of them serious`)
    :m&&l?`${m} medium and ${l} low`:m?(total===2?'both medium':'all medium'):l?(total===2?'both small':'all small'):'';
  const said=severity?[', ',severity,'.']:['.'];
  const worstIs=lead=>title?[' ',lead,...(!one&&fileOf(first)?[' is in ',code(fileOf(first))]:[]),': ',title,'.']:[];
  return pick(p,previous,[
    ['I found ',String(total),' issues',...where,...said,...worstIs('The worst')],
    [String(total),' issues',...where,' this run',...said,...worstIs('The worst')],
    ['This run turned up ',String(total),' issues',...where,...said,...worstIs('The top one')]]);
}
function checksWords(p,previous){
  const n=count(p.checks?.total),f=count(p.checks?.failed);
  const all=n===1?'the check':n===2?'both checks':n?`all ${n} checks`:'the checks';
  if(p.outcome==='checks_passed'){
    if(previous?.outcome==='checks_passed')return pick(p,null,[[cap(all),' passed again. Nothing for you to do.']]);
    if(['checks_failed','failed'].includes(previous?.outcome))return [cap(all),' passed this time. Nothing for you to do.'];
    return pick(p,previous,[[cap(all),' passed. Nothing for you to do.'],['I ran ',all,': ',n===1?'it':'they',' passed. Nothing for you to do.'],[cap(all),' passed. All good.']]);
  }
  const labels=(Array.isArray(p.failed_checks)?p.failed_checks:[]).filter(s=>typeof s==='string'&&s).slice(0,2);
  const named=labels.length?list([...labels.map(code),...(f>labels.length?[`${f-labels.length} more`]:[])]):[];
  const which=named.length?[': ',...named,'.']:['.'];
  if(previous?.outcome==='checks_failed'&&named.length&&JSON.stringify(previous.failed_checks?.slice(0,2))===JSON.stringify(labels))
    return ['Still failing',...which];
  if(n===1)return ['The check failed',...which];
  if(f===n)return [n===2?'Both checks':`All ${n} checks`,' failed',...which];
  return pick(p,previous,[[`${f} of ${n} checks failed`,...which],[`I ran ${n} checks and ${f} failed`,...which],
    f===1&&labels.length?[code(labels[0]),' failed. ',n===2?'The other check passed.':`The other ${n-1} passed.`]:null]);
}
// "I'll try again tomorrow at 9:00 AM": the next run, when the Pip has one.
function nextWords(p,now){
  const next=Date.parse(p.next_run_at||'');
  if(!Number.isFinite(next)||next<=now)return '';
  const days=-daysAgo(next,now);
  return days===0?`today at ${clock(next)}`:days===1?`tomorrow at ${clock(next)}`:`on ${new Date(next).toLocaleDateString('en-GB',{day:'numeric',month:'short'})} at ${clock(next)}`;
}
// What stopped it, in the Pip's voice: "It ran out of time." becomes "I ran out of time."
const mine=r=>{const s=String(r||'It stopped with an error.').trim().replace(/^It(?= )/,'I').replace(/^Its(?= )/,'My');return /[.!?]$/.test(s)?s:s+'.';};
function failedWords(p,previous,{personal,now}){
  const noun={draft:'the draft',result:'this task'}[p.kind]||'this run';
  const lead=previous?.outcome==='failed'&&previous.reason===p.reason?[`I couldn’t finish ${noun} again.`]
    :pick(p,previous,[[`I couldn’t finish ${noun}.`],[`${cap(noun)} stopped before it finished.`],[`I didn’t get to the end of ${noun}.`]]);
  const when=nextWords(p,now);
  return [...lead,' ',mine(p.reason),' ',personal?'Nothing was sent or changed.':'Nothing in your project was changed.',...(when?[` I’ll try again ${when}.`]:[])];
}
function clearWords(p,previous){
  if(previous?.outcome==='clear')return pick(p,null,[['I found no issues again.']]);
  if(previous)return ['This time I found no issues.'];
  return pick(p,previous,[['I didn’t find any issues this run.'],['Nothing to report: I found no issues.'],['All clear: I found no issues this run.']]);
}
/** What the Pip says about a run, as paragraphs of parts. `previous`: its run before, of the same kind. */
export function pipWords(p,{previous=null,personal=false,now=Date.now()}={}){
  const before=previous&&previous.kind===p.kind?previous:null;
  if(p.outcome==='findings')return [findingsWords(p,before)];
  if(p.outcome==='clear')return [clearWords(p,before)];
  if(p.outcome==='checks_passed'||p.outcome==='checks_failed')return [checksWords(p,before)];
  if(p.outcome==='failed')return [failedWords(p,before,{personal,now})];
  if(p.outcome==='draft'){const t=String(p.title||'a draft');return [pick(p,before,[['I drafted “',t,'”.'],['Your draft is ready: “',t,'”.']]),...(p.summary?[[String(p.summary)]]:[])];}
  // A live-data run says its summary: the model's, held to the numbers its commands printed, or DGC's own line.
  if(p.outcome==='live_clear'||p.outcome==='live_attention')return [[String(p.summary||'')]];
  return [[String(p.preview||'')]];
}
const partHtml=x=>typeof x==='string'?esc(x):`<code>${esc(x.code)}</code>`;
const partText=x=>typeof x==='string'?x:x.code;
/** The words as plain text, the way a screen reader and a test read them. */
export const wordsText=paragraphs=>paragraphs.map(p=>p.map(partText).join('')).join(' ');

/** A long reply's start, cut where a paragraph, a line or a sentence ends; `clipped` when there is more. A reply
 *  only a little over the limit stays whole: a Show all for one more sentence is noise. */
export function shortReply(text,limit=280){
  const t=String(text||'').trim();
  if(t.length<=limit+80)return {text:t,clipped:false};
  const head=t.slice(0,limit);
  for(const mark of ['\n\n','\n','. ']){const i=head.lastIndexOf(mark);if(i>=limit/3)return {text:head.slice(0,i+(mark==='. '?1:0)).trimEnd(),clipped:true};}
  const space=head.lastIndexOf(' ');
  return {text:(space>limit/2?head.slice(0,space):head).trimEnd()+'…',clipped:true};
}
// A routine's turn is DGC's (pip_routines.ROUTINE_TURN); the reply to it is the Pip's own, and says which routine.
const ROUTINE=/^This message is from DGC, not the user\. Your routine "([^"\n]{1,200})" is due/;
/** The routine a hidden turn ran, or null. */
export function routineTitle(text){const m=ROUTINE.exec(String(text||''));return m?m[1]:null;}

// ---- Drawing it -----------------------------------------------------------------------------------------------
const ICONS={doc:'<path d="M4 1.8h5.2L12 4.6v9.6H4Z"/><path d="M9 1.8v3h3M6 8h4M6 10.5h4"/>',warn:'<path d="M8 2 1.8 13h12.4Z"/><path d="M8 6.5v3.2M8 11.4v.2"/>',
  play:'<path d="M5 3.2v9.6L12.4 8Z"/>',fix:'<path d="M10.2 2.2a3.2 3.2 0 0 0-3.9 4.2L2.2 10.5l3.3 3.3 4.1-4.1a3.2 3.2 0 0 0 4.2-3.9l-2 2-2-.3-.3-2Z"/>',
  chev:'<path d="m6 3.5 4.5 4.5L6 12.5"/>'};
const icon=(name,cls='run-post-icon')=>`<svg class="${cls}" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const chev=icon('chev','run-post-chev');
const where=f=>typeof f.path==='string'&&f.path?`${f.path}${Number.isSafeInteger(f.line)&&f.line>0?`:${f.line}`:''}`:'';
const chip=(attrs,inner,cls='')=>`<button type="button" class="run-post-chip${cls?' '+cls:''}" ${attrs}>${inner}</button>`;

// The report under a run that found something: one click opens the top findings, or the checks that failed.
function reportMarkup(p){
  const id=esc(p.run_id);
  let label,rows,more=0;
  if(p.outcome==='findings'){
    const total=count(p.total),top=(Array.isArray(p.findings)?p.findings:[]).filter(record).slice(0,3);
    label=`Report · ${plural(total,'finding')}`;more=total-top.length;
    rows=top.map(f=>{const s=SEVERITIES.includes(f.severity)?f.severity:'low';return `<li><span class="sev" data-sev="${s}">${s}</span><span class="t">${esc(f.title)}</span>${where(f)?`<span class="w">${esc(where(f))}</span>`:''}</li>`;});
  }else if(p.kind==='live'){
    const labels=(Array.isArray(p.failed_commands)?p.failed_commands:[]).filter(l=>typeof l==='string').slice(0,3),n=count(p.commands?.total);
    label=`Output · ${plural(n,'command')}`;more=count(p.commands?.failed)-labels.length;
    rows=labels.map(l=>`<li><span class="sev" data-sev="high">didn’t run</span><span class="w">${esc(l)}</span></li>`);
  }else{
    const labels=(Array.isArray(p.failed_checks)?p.failed_checks:[]).filter(l=>typeof l==='string').slice(0,3);
    label=`Report · ${count(p.checks?.failed)} of ${count(p.checks?.total)} failed`;more=count(p.checks?.failed)-labels.length;
    rows=labels.map(l=>`<li><span class="sev" data-sev="high">failed</span><span class="w">${esc(l)}</span></li>`);
  }
  return `<details class="run-post-report" data-details="report-${id}"><summary class="run-post-chip">${icon('doc')}<span>${esc(label)}</span>${chev}</summary><div class="run-post-report-body">${rows.length?`<ul class="run-post-findings">${rows.join('')}</ul>`:''}${more>0?`<p class="run-post-more">${more} more in the full report</p>`:''}<button type="button" class="link" data-post-open="${id}">${p.kind==='live'?'Open the full output':'Open full report'}</button></div></details>`;
}
// Under a fold: "✓ Passed 12 times since Monday", which opens to every time it ran, by day; each opens that run.
function sinceWords(time,now){
  const days=daysAgo(time,now);
  return days<=0?clock(time):days===1?'yesterday':days<7?new Date(time).toLocaleDateString('en-US',{weekday:'long'}):new Date(time).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
}
export function foldWords(runs,now=Date.now()){
  const n=runs.length,times=n===2?'twice':`${n} times`;
  return `${runs[0].kind==='checks'?'Passed':runs[0].kind==='live'?'All clear':'Nothing found'} ${times} since ${sinceWords(at(runs[0]),now)}`;
}
function timesMarkup(runs,now){
  const days=new Map();
  for(const p of runs){const d=startOfDay(at(p));if(!days.has(d))days.set(d,[]);days.get(d).push(p);}
  const dayName=d=>{const n=daysAgo(d,now);return n===0?'Today':n===1?'Yesterday':new Date(d).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});};
  const rows=[...days].map(([d,list])=>`<div class="run-post-day"><span class="run-post-day-name">${esc(dayName(d))}</span><span class="run-post-day-times">${list.map(p=>`<button type="button" class="run-post-time" data-post-open="${esc(p.run_id)}" data-streak-run="${esc(p.run_id)}" title="${esc(new Date(at(p)).toLocaleString(undefined,{dateStyle:'full',timeStyle:'short'}))} · Open this run">${esc(clock(at(p)))}</button>`).join('')}</span></div>`).join('');
  return `<details class="run-post-times" data-details="streak-${esc(runs[0].run_id)}"><summary class="run-post-chip"><span class="ok" aria-hidden="true">✓</span> <span>${esc(foldWords(runs,now))}</span>${chev}</summary><div class="run-post-times-body">${rows}</div></details>`;
}

/** One run in the chat, or a fold of all-clear runs (`streak`, oldest first, `p` its newest), as a message from the
 *  Pip. `previous`: its run before (for "again"); `ask`: Ask DGC to fix is offered (a project Pip's audit or checks,
 *  with a chat to send it to); `asked`: it was; `canRun`: Run again now would start a run; `expanded`: Show all. */
export function postMarkup(p,{name,face='',now=Date.now(),personal=false,ask=false,asked=false,canRun=false,previous=null,streak=null,expanded=false,renderMarkdown=s=>`<p>${esc(s)}</p>`}){
  const id=esc(p.run_id),runs=streak&&streak.length>1?streak:null,before=runs?runs.at(-2):previous;
  const time=globalThis.DgcTime?.markup(at(p))||'';
  let body,text;
  if(p.outcome==='result'){
    const whole=String(p.preview||''),cut=shortReply(whole);
    body=renderMarkdown(expanded||!cut.clipped?whole:cut.text)
      +(expanded&&p.truncated?'<p class="run-post-more">The rest is in the full result.</p>':'')
      +(cut.clipped?`<button type="button" class="link run-post-show" data-post-more="${id}" aria-expanded="${expanded}">${expanded?'Show less':'Show all'}</button>`:'');
    text=cut.text.replace(/[*_`#>|]/g,'').replace(/\s+/g,' ').slice(0,200);
  }else{
    const words=pipWords(p,{previous:before,personal,now});
    body=words.map(w=>`<p>${w.map(partHtml).join('')}</p>`).join('');
    text=wordsText(words);
  }
  const askable=ask&&!personal&&['findings','checks_failed','failed','live_attention'].includes(p.outcome)&&['audit','checks','live'].includes(p.kind);
  const fix=askable?chip(`data-post-fix="${id}"${asked?' disabled title="DGC was asked to fix this run, in the Work chat it reports to."':''}`,`${icon('fix')}<span>${asked?'Asked DGC':'Ask DGC to fix'}</span>`,asked?'asked':''):'';
  const attach=runs?timesMarkup(runs,now)
    :p.outcome==='findings'||p.outcome==='checks_failed'||p.outcome==='live_attention'?reportMarkup(p)+fix
    :p.outcome==='failed'?chip(`data-post-open="${id}"`,`${icon('warn')}<span>See what happened</span>`)+(canRun?chip(`data-post-run="${id}"`,`${icon('play')}<span>Run again now</span>`):'')+fix
    :chip(`data-post-open="${id}"`,`<span>${p.outcome==='draft'?'Open draft':p.kind==='result'?'Open result':'Open run'}</span>${chev}`,'quiet');
  const head=`<div class="run-post-head">${face?`<span class="run-post-face" aria-hidden="true">${face}</span>`:''}<strong class="run-post-name">${esc(name)}</strong>${time}</div>`;
  return `<article class="pip-message assistant dgc run-post${runs?' run-post-streak':''}" data-run-post="${id}" data-outcome="${esc(p.outcome)}"${runs?` data-runs="${runs.length}"`:''} tabindex="-1" aria-label="${esc(`${name}: ${text}${runs?` ${foldWords(runs,now)}.`:''}`)}">${head}<div class="answer"><div class="message-body text final run-post-body">${body}</div></div><div class="run-post-attach">${attach}</div></article>`;
}

/** The chat's messages and runs in time order. Each run is {post, previous}; all-clear runs of one kind in a row
 *  (passed, or found nothing, with no message between) are one {streak, previous}. `complete`: every message is
 *  loaded (else runs older than the first loaded message wait for "Load earlier messages"). */
export function timeline(messages,posts,{complete=true}={}){
  const first=messages.length?Date.parse(messages[0].created_at):Infinity;
  const shown=posts.filter(p=>complete||at(p)>=first);
  const previous=new Map(),last={};
  for(const p of shown){previous.set(p.run_id,last[p.kind]||null);last[p.kind]=p;}
  const items=[];let i=0,j=0;
  while(i<messages.length||j<shown.length){
    const m=messages[i],p=shown[j];
    if(p&&(!m||at(p)<Date.parse(m.created_at)))items.push({post:p}),j++;
    else items.push({message:m}),i++;
  }
  // Which runs fold together: passes of the same checks, or audits that found nothing.
  const fold=p=>p.outcome==='checks_passed'?`checks:${count(p.checks?.total)}`:p.outcome==='clear'?`${p.kind}:clear`:p.outcome==='live_clear'?'live:clear':'';
  const out=[];
  for(let k=0;k<items.length;){
    if(items[k].message){out.push(items[k++]);continue;}
    const p=items[k].post,key=fold(p);let e=k+1;
    if(key)while(e<items.length&&items[e].post&&fold(items[e].post)===key)e++;
    const runs=items.slice(k,e).map(x=>x.post);
    out.push(runs.length>1?{streak:runs,previous:previous.get(runs[0].run_id)}:{post:p,previous:previous.get(p.run_id)});
    k=e;
  }
  return out;
}
