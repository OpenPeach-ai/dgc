// The main chat's Pips bar: one digest a day instead of a message per run (Pips API 41).
// Read-only. It appears when the backend says the digest is due (once a local day when there is
// something to say, or straight away for a finding at a Pip's alert level), opens the Pips view,
// and marks the digest seen only when the user dismisses it. Finding titles are model text: they
// are set as text, never as markup, and never reach the chat's model.
import {pipDigest} from './pipsModel.js';

const POLL_MS = 60000;

export function mountDigestBar(options) {
 const doc=options.document, bar=doc.getElementById('pipsbar');
 const quiet={receive(){},refresh(){},dispose(){}};
 if(!bar)return quiet;
 const main=doc.getElementById('pips-digest-main'), text=doc.getElementById('pips-digest-text'),
  panel=doc.getElementById('pips-digest-panel'), openButton=doc.getElementById('pips-digest-open'),
  dismissButton=doc.getElementById('pips-digest-dismiss');
 if(!main||!text||!panel||!openButton||!dismissButton)return quiet;
 const pending=new Map(), setTimer=options.setInterval||setInterval, clearTimer=options.clearInterval||clearInterval;
 let generation=0,epoch=0,sequence=0,connected=false,ready=false,digest=null,expanded=false,busy=false,loading=false,timer=null,disposed=false;
 const node=(tag,cls,value)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
 const request=(type,fields={})=>new Promise((resolve,reject)=>{
  const id=`pip-digest-${epoch}-${++sequence}`;
  const t=setTimeout(()=>{pending.delete(id);reject(Error('No reply from DGC.'));},20000);
  pending.set(id,{resolve,reject,timer:t});
  options.postMessage({type:'pipsRequest',id,generation,request:{type,...fields}});
 });
 function facts(pip){
  const ran=pip.runs.succeeded+pip.runs.failed+pip.runs.cancelled,parts=[];
  if(ran)parts.push(`${ran} run${ran===1?'':'s'}`);
  if(pip.runs.failed)parts.push(`${pip.runs.failed} failed`);
  if(pip.new_total)parts.push(`${pip.new_total} new at ${pip.min_severity} or worse`);
  else if(pip.scope==='project'&&ran)parts.push('nothing new');
  if(pip.skipped_unchanged)parts.push(`${pip.skipped_unchanged} skipped, nothing changed`);
  if(pip.gone_after_change)parts.push(`${pip.gone_after_change} earlier gone after a change`);
  return parts.join(' · ')||'no runs';
 }
 function paintPanel(){
  panel.replaceChildren();
  for(const pip of digest.pips){
   const row=node('div','pips-digest-pip');row.dataset.alert=String(pip.alert);
   row.append(node('strong','',pip.name),node('span','pips-digest-facts',facts(pip)));
   panel.append(row);
   if(pip.new_findings.length){
    const list=node('ul','pips-digest-findings');
    for(const f of pip.new_findings){
     const item=node('li'),open=node('button','pips-digest-finding');open.type='button';
     open.title=`Open this report in Pips: ${f.title}`;
     open.append(node('span',`pips-digest-severity sev-${f.severity}`,f.severity),node('span','pips-digest-title',f.title),node('span','pips-digest-path',`${f.path}:${f.line}`));
     open.onclick=()=>options.onOpen?.({pip:pip.pip_id,section:'runs',run:f.run_id});
     item.append(open);list.append(item);
    }
    panel.append(list);
   }
  }
  const waiting=digest.pending_reviews+digest.pending_setups+(digest.pending_actions||0);
  if(waiting)panel.append(node('p','pips-digest-note',`${waiting} review${waiting===1?'':'s'} waiting for you in Pips.`));
  if(digest.omitted_pips)panel.append(node('p','pips-digest-note',`And ${digest.omitted_pips} more Pips. Open Pips to see them all.`));
 }
 function paint(){
  if(disposed)return;
  const show=!!digest?.due;
  bar.hidden=!show;
  if(!show){expanded=false;panel.hidden=true;panel.replaceChildren();options.onChange?.();return;}
  bar.dataset.reason=digest.reason;
  text.textContent=digest.headline;
  main.title=digest.reason==='alert'?'A Pip found something at its alert level. Show the digest':'Show what your Pips did since you last looked';
  main.setAttribute('aria-expanded',String(expanded));
  panel.hidden=!expanded;
  if(expanded)paintPanel();
  dismissButton.disabled=busy||!connected;
  openButton.disabled=!connected;
  options.onChange?.();
 }
 async function load(){
  if(disposed||!connected||!ready||loading||busy)return;
  const token=epoch;loading=true;
  try{const value=pipDigest((await request('get_pip_digest')).digest);if(token===epoch)digest=value;}
  catch{if(token===epoch)digest=null;}            // an invalid or failed digest is hidden, never half-shown
  finally{if(token===epoch){loading=false;paint();}}
 }
 async function dismiss(){
  if(!digest||busy||!connected)return;
  const token=epoch,until=digest.until;busy=true;paint();
  try{await request('mark_pip_digest_seen',{until});if(token===epoch)digest=null;}
  catch{/* stays visible; the next poll tries again */}
  finally{if(token===epoch){busy=false;paint();}}
 }
 main.onclick=()=>{if(!digest)return;expanded=!expanded;paint();};
 openButton.onclick=()=>options.onOpen?.(null);
 dismissButton.onclick=()=>{void dismiss();};
 function receive(message){
  if(disposed)return;
  if(message.type==='pipsConnection'){
   if(generation!==message.generation){epoch++;loading=false;busy=false;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('The chat connection changed.'));}pending.clear();}
   generation=message.generation;connected=message.connected===true;
   ready=connected&&message.supported!==false&&message.enabled===true&&(message.apiVersion||0)>=41;
   if(ready){if(timer===null)timer=setTimer(()=>{if(!doc.hidden)void load();},POLL_MS);void load();}
   else{digest=null;paint();}
   return;
  }
  if(message.type!=='pipsReply')return;
  const p=pending.get(message.id);if(!p)return;
  pending.delete(message.id);clearTimeout(p.timer);
  message.ok?p.resolve(message.result):p.reject(Error(message.error?.message||'DGC could not read the Pips digest.'));
 }
 options.postMessage({type:'pipsReady'});
 return {receive,refresh(){void load();},dispose(){disposed=true;if(timer!==null)clearTimer(timer);for(const p of pending.values())clearTimeout(p.timer);pending.clear();bar.hidden=true;}};
}
