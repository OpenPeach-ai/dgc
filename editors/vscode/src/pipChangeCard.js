// A change waiting for you, as a card (media/shared/card.js): what the Pip wants in one sentence, what exactly as
// chips, and every value in full for the card's Details. It read as one run-on line before ("Web pages: Search · top
// India news headlines today, Search · world news headlines today, Page · https://…"), which nobody could take in at
// 300 px. Pure: it reads the saved proposal and the Pip as it is now, and decides nothing.
import {record,scheduleLabel,eventTrigger,EVENT_TRIGGER_NAMES,modelLabel,sourcePolicyLabel,adaptationLabel,githubReadLabel,commandLine} from './pipsModel.js';
import {appReadWords} from './pipsAppPicker.js';

const plural=(n,one,many=one+'s')=>`${n} ${n===1?one:many}`;
const lower=s=>s?s.slice(0,1).toLowerCase()+s.slice(1):s;
const clip=(s,n=120)=>{const t=String(s??'').trim();return t.length>n?t.slice(0,n-1).trimEnd()+'…':t;};
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);

/** A page as a person names it: its site and path, without the scheme, "www." or a closing slash. */
export function pageWords(url){
  try{const u=new URL(url);return (u.host.replace(/^www\./,'')+u.pathname.replace(/\/+$/,'')+u.search)||url;}catch{return String(url);}
}
/** One web read as a chip: a search by its words, a page by its site. */
export const webReadChip=read=>read.kind==='page'?{label:pageWords(read.url),icon:'web',title:read.url}:{label:`Search: ${read.query}`,icon:'search',title:read.query};

/** When it would run, as the end of "wants to run …", and the time zone when it has one. */
export function scheduleWords(schedule){
  if(schedule==null)return {words:'only when you ask',zone:''};
  if(record(schedule)&&schedule.type==='interval'&&Number.isInteger(schedule.minutes)){
    const m=schedule.minutes;return {words:m===60?'every hour':m%1440===0?(m===1440?'every day':`every ${m/1440} days`):m%60===0?`every ${m/60} hours`:`every ${m} minutes`,zone:''};
  }
  const [label,zone='']=scheduleLabel(schedule).split(' · ');
  if(record(schedule)&&schedule.type==='daily')return {words:`every day at ${schedule.time}`,zone};
  if(record(schedule)&&schedule.type==='once')return {words:lower(label),zone};
  // "Every day at 09:00", "Weekdays at 09:00", "Mondays and Thursdays at 08:00": a day's name keeps its capital.
  if(/^(Every day|Weekdays|Weekends) /.test(label))return {words:(label.startsWith('Every')?'':'on ')+lower(label),zone};
  if(/^Cron /.test(label))return {words:'on its own schedule',zone,exact:label};
  return {words:/^[A-Z][a-z]+days?\b/.test(label)?`on ${label}`:lower(label),zone};
}

/**
 * The card for one waiting change.
 *   proposal  the saved change ({definition, reason, expected_version, …}); pip: the Pip as it is now
 * Returns { icon, title, sub, chips, rows, kinds }: `kinds` names what differs (for a test, and for the mark).
 */
export function changeCard(proposal,pip){
  const d=record(proposal?.definition)?proposal.definition:{},p=pip||{},name=p.name||'This Pip';
  const differs=k=>Object.hasOwn(d,k)&&!same(d[k],p[k]);
  /** Each difference: its mark, what it wants ("wants to …"), a short chip for a card with several, the chips of a
      card with only this one, and its rows in Details. */
  const parts=[];
  const add=(kind,icon,wants,short,chips=[],rows=[])=>parts.push({kind,icon,wants,short,chips,rows});
  if(differs('name'))add('name','name',`be called ${d.name}`,`Name: ${d.name}`,[],[['Name',String(d.name)]]);
  if(differs('goal'))add('goal','name','change what it does','What it does',[],[['What it does',String(d.goal)]]);
  if(differs('schedule')||differs('event_trigger')){
    if(d.event_trigger){
      let events=[],gap='';try{const t=eventTrigger(d.event_trigger);events=t.events.map(e=>EVENT_TRIGGER_NAMES[e]);gap=`At least ${t.minimum_minutes} minutes apart`;}catch{events=['Events this editor doesn’t know'];}
      add('schedule','clock','start when something happens','Starts on events',events.map(e=>({label:e,icon:'clock'})),[...events.map(e=>['Starts when',e]),...(gap?[['How often',gap]]:[])]);
    }else{
      const s=scheduleWords(d.schedule);
      add('schedule','clock',`run ${s.words}`,`Runs ${s.words}`,[...(s.exact?[{label:s.exact,icon:'clock'}]:[]),...(s.zone?[{label:s.zone,icon:'clock'}]:[])],[['When',d.schedule==null?'Only when you ask':scheduleLabel(d.schedule).split(' · ').join(', ')]]);
    }
  }
  if(differs('model_choice'))add('model','model','use another model',`Model: ${modelLabel(d.model_choice)}`,[{label:modelLabel(d.model_choice),icon:'model'}],[['Model',modelLabel(d.model_choice)]]);
  if(differs('web_plan')){
    const reads=Array.isArray(d.web_plan?.reads)?d.web_plan.reads:[],pages=reads.filter(r=>r.kind==='page').length,searches=reads.length-pages;
    if(!reads.length)add('web','web','stop reading web pages','No web pages',[],[['Web pages','None']]);
    else add('web','web',`${searches&&!pages?`run ${plural(searches,'web search','web searches')}`:`read ${plural(reads.length,'web page')}`} before each run`,`Reads ${plural(reads.length,'web page')}`,
      reads.map(webReadChip),reads.map(r=>[r.kind==='page'?'Page':'Search',r.kind==='page'?r.url:r.query]));
  }
  if(differs('app_plan')){
    const words=d.app_plan?appReadWords(d.app_plan):[],server=String(d.app_plan?.server||'').replace(/^app:/,'');
    if(!d.app_plan)add('app','app','stop reading from your connected apps','No app reads',[],[['Apps','None']]);
    else add('app','app',`read from ${server||'a connected app'}`,`Reads from ${server||'an app'}`,words.map(w=>({label:w,icon:'app'})),words.length?words.map(w=>['Reads',w]):[['Reads from',server]]);
  }
  if(differs('computer_plan'))add('computer','computer',d.computer_plan?'get its own computer':'give up its computer',d.computer_plan?'Its own computer':'No computer',
    d.computer_plan?[{label:'Browser',icon:'web'},{label:'Terminal',icon:'code'},{label:'Files',icon:'doc'}]:[],[['Computer',d.computer_plan?'Its computer’s browser, Terminal and files. Anything it would submit waits for your OK.':'None']]);
  if(differs('github_plan')){
    let reads=[];try{reads=(d.github_plan?.reads||[]).map(githubReadLabel);}catch{reads=['GitHub reads this view cannot show'];}
    add('github','code',d.github_plan?'read from GitHub':'stop reading from GitHub',d.github_plan?'GitHub reads':'No GitHub reads',reads.map(r=>({label:r,icon:'code'})),reads.length?reads.map(r=>['GitHub',r]):[['GitHub','None']]);
  }
  if(differs('source_policy')){const [what,how='']=sourcePolicyLabel(d.source_policy).split(' · ');add('source','doc',`read ${lower(what)}`,what,how?[{label:how.slice(0,1).toUpperCase()+how.slice(1),icon:'doc'}]:[],[['Source',[what,how].filter(Boolean).join(', ')]]);}
  if(differs('adaptation_policy')){const [mode,...rest]=adaptationLabel(d.adaptation_policy).split(' · ');add('adaptation','change','change what it may change about itself',`Self-changes: ${lower(mode)}`,[{label:mode,icon:'change'}],[['Changes it may make itself',[mode,...rest].join(', ')]]);}
  if(differs('verification_plan')){
    let commands=[];try{commands=(d.verification_plan?.action?.tests||[]).map(t=>commandLine(t.argv));}catch{commands=[];}
    add('commands','code',d.verification_plan?'change the commands it may run':'stop running commands',d.verification_plan?plural(commands.length,'command')||'Commands':'No commands',commands.map(c=>({label:c,icon:'code'})),commands.length?commands.map(c=>['Command',c]):[['Commands',d.verification_plan?'See the full review':'None']]);
  }
  // A saved job leaves out live_plan when it has none, so taking the commands away is a difference too.
  if(!same(d.live_plan,p.live_plan))add('live','code',d.live_plan?'run live-data commands':'stop running live-data commands',d.live_plan?'Live-data commands':'No live-data commands',[],[['Live data',d.live_plan?'See the full review':'None']]);

  const reason=clip(proposal?.reason,160);
  if(!parts.length)return {icon:'change',title:`${name} has a change for you`,sub:reason,chips:[],rows:reason?[['Why',String(proposal.reason)]]:[],kinds:[]};
  const rows=[...parts.flatMap(x=>x.rows),...(proposal?.reason?[['Why',String(proposal.reason)]]:[])];
  if(parts.length===1){
    const x=parts[0];
    // What it does is a paragraph: its start is the quiet line, and the whole of it is in Details.
    return {icon:x.icon,title:`${name} wants to ${x.wants}`,sub:x.kind==='goal'?clip(d.goal,140):reason,chips:x.chips,rows,kinds:[x.kind]};
  }
  return {icon:'change',title:`${name} wants ${parts.length} changes`,sub:reason,chips:parts.map(x=>({label:x.short,icon:x.icon})),rows,kinds:parts.map(x=>x.kind)};
}
