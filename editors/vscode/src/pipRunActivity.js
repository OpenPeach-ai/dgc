// A Pip's run while it runs, in words (reported 24 Oct): what it is doing now, how long it has been at it, and how it
// started. Read from the run itself -- its saved activity (list_pip_run_activity: pip_run_progress events and the run's
// own steps) and its manifest -- never from what an editor remembers, so the live post in the Pip's chat
// (pipsClient.js), the agent map's row for a run the Work chat started (pipRunCards.js) and a reload all say the same.
import {record} from './pipsModel.js';

const name=path=>String(path||'').split(/[\\/]/).filter(Boolean).pop()||'';
const code=s=>({code:String(s)});
const words=s=>String(s||'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
// What a tool call is, as a verb: the tools a Pip reads with, then any other tool by its name.
const TOOLS={
  read_file:p=>p?['Reading ',code(name(p))]:['Reading the code'],
  grep:()=>['Searching the code'], glob:()=>['Finding files'], repo_map:()=>['Mapping the project'], todo:()=>['Planning its steps'],
  write_file:p=>p?['Writing ',code(name(p))]:['Writing a file'], edit_file:p=>p?['Editing ',code(name(p))]:['Editing a file'],
  multi_edit:p=>p?['Editing ',code(name(p))]:['Editing a file'], apply_patch:()=>['Applying a change'],
  web_search:()=>['Searching the web'], web_fetch:()=>['Reading a web page'], task:()=>['Asking a helper'],
};
// The run's own steps, said the way its activity list says them.
const STEPS={pip_run_queued:'Waiting to start',pip_run_started:'Getting started',pip_run_snapshot:'Getting the code ready',pip_run_cancelling:'Stopping'};
/** One activity event as words (a list of parts: text, or {code} for a file name), or null when it says nothing new:
 *  a reply's text arriving, a tool's result, a step this view does not know. */
export function activityParts(event){
  if(!record(event)||!record(event.payload))return null;
  const p=event.payload;
  if(event.event_type==='pip_run_progress'){
    if(p.kind==='tool_call'&&typeof p.tool==='string'&&p.tool){
      const tool=TOOLS[p.tool];
      return tool?tool(typeof p.path==='string'?p.path:''):[`Using ${words(p.tool).slice(0,60)}`];
    }
    if(p.kind==='progress'&&typeof p.message==='string'&&p.message.trim())return [p.message.trim().replace(/\s+/g,' ').slice(0,120)];
    if(p.kind==='tool_denied')return ['Asked for something it may not do'];
    return null;
  }
  return STEPS[event.event_type]?[STEPS[event.event_type]]:null;
}
/** The newest thing a run says it is doing, from a page of its activity (oldest first); `previous` when none says. */
export function latestActivity(events,previous=null){
  let now=previous;
  for(const event of Array.isArray(events)?events:[]){const parts=activityParts(event);if(parts)now=parts;}
  return now;
}
export const activityText=parts=>(Array.isArray(parts)?parts:[]).map(x=>typeof x==='string'?x:x.code).join('');
/** Whether a page of activity says the run has ended. */
export const activityEnded=events=>(Array.isArray(events)?events:[]).some(e=>/^pip_run_(succeeded|failed|cancelled)$/.test(String(e?.event_type)));

/** "0:42", "12:05", "1:02:09": how long it has been at it. */
export function elapsed(ms){
  const total=Math.max(0,Math.floor((Number(ms)||0)/1000)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;
}
const clock=t=>new Date(t).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
// A project event (pip_event_triggers), as what happened.
const PROJECT_EVENTS={workspace_commit_changed:'From a new commit',workspace_committed_paths_changed:'From a new commit',
  workspace_context_recorded:'From a context change',workspace_context_archived:'From a context change',
  workspace_finding_accepted:'From an accepted finding',pip_finding_accepted:'From an accepted finding',
  workspace_execution_recorded:'From a saved result',workspace_session_turn_completed:'From a DGC chat'};
/** How a run started, in a few words: "Started by you", "On schedule · 9:00 AM", "From a new commit", "Asked by DGC",
 *  "From another Pip" or "First run". `run`: the run as get_pip_run or list_pip_runs gives it (its manifest's
 *  trigger, and the time it was due); `first`: it is the Pip's first run, started on its own setup card. */
export function startedWords(run,{first=false}={}){
  const m=record(run?.manifest)?run.manifest:{};
  if(m.trigger==='schedule'){const due=Date.parse(m.scheduled_at||run?.created_at||'');return Number.isFinite(due)?`On schedule · ${clock(due)}`:'On schedule';}
  if(m.trigger==='event')return PROJECT_EVENTS[m.event_trigger?.event?.event_type]||'From an event';
  if(m.trigger==='main_chat')return 'Asked by DGC';
  if(m.trigger==='handoff')return 'From another Pip';
  return first?'First run':'Started by you';
}
// A routine's hidden turn (pip_routines.ROUTINE_TURN) says when it is due: "is due (every day at 09:00)", "(when the
// shop app sends order.created)", "(when a new email matching ... arrives)", "(15 minutes before each calendar event)".
const DUE=/^This message is from DGC, not the user\. Your routine "[^"\n]{1,200}" is due \((.{1,400}?)\)\. Do it now:/;
/** How a routine's run started, from its hidden turn and when it was written. */
export function routineStartedWords(text,at){
  const when=DUE.exec(String(text||''))?.[1]||'';
  const app=/^when the (.{1,60}) app sends /.exec(when);
  if(app)return `From ${cap(app[1])} event`;
  if(/^when a new email/.test(when))return 'From Gmail event';
  if(/before each calendar event$/.test(when))return 'From Calendar event';
  const t=Date.parse(at||'');
  return Number.isFinite(t)?`On schedule · ${clock(t)}`:'On schedule';
}
