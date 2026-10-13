// Read-only main-chat run views. Tool receipts select IDs, never supply status.
import '../media/pips/plush.js';
import {active, record, pulseProgress} from './pipsModel.js';

const TYPES=['core','scout','lens','patch','rook','pulse','lock','quill'];
const id=(value,prefix)=>typeof value==='string'&&new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value);
export function mountRunCards(options) {
 const doc=options.document, entries=new Map();
 let epoch=0,connected=false,visible=true,sequence=0,disposed=false,timer=null;
 const node=(tag,cls,text)=>{const e=doc.createElement(tag);e.className=cls;if(text!==undefined)e.textContent=text;return e;};
 function paint(e){
  const r=e.run,stale=!connected||!!e.error;
  const labels={queued:'Waiting to start',running:'Working',cancelling:'Stopping',cancelled:'Cancelled',failed:'Failed',succeeded:r?.manifest?.run_kind==='personal_task'?'Done':'Report ready'};
  let label=r?labels[r.status]:'Checking…';
  if(r?.status==='succeeded'&&r.manifest?.run_kind==='draft')label='Draft ready';
  const pulse=r?.status==='succeeded'&&r.execution_mode==='standalone_plan'?pulseProgress(r):null;
  if(r?.status==='succeeded'&&(r.manifest?.run_kind==='test'||r.manifest?.run_kind==='patch'))label='Results ready';
  if(pulse)label=`${pulse.passed} passed · ${pulse.failed} failed`;
  const pose=stale||active(r?.status)&&!e.runner?.online?'offline':r?.status==='failed'||pulse?.failed?'failure':r?.status==='succeeded'?'success':r?.status==='running'?'working':'idle';
  e.root.dataset.state=stale?'offline':r?.status||'loading';
  const signature=`${e.pip?.pip_type}:${pose}`;
  if(e.faceKey!==signature){
   e.cleanup?.();e.face.replaceChildren();e.faceKey=signature;
   if(e.pip&&globalThis.PipConcepts?.plush){
    e.face.innerHTML=globalThis.PipConcepts.plush.markup({index:TYPES.indexOf(e.pip.pip_type),name:e.pip.name},pose,e.uid,{paused:stale,includeStyles:true});
    e.cleanup=globalThis.PipConcepts.plush.mount?.(e.face);
   }
  }
  e.title.textContent=e.pip?.name||'Pip';
  e.status.textContent=stale?(connected?'Status unavailable':'Disconnected'):label;
  e.detail.textContent=e.error||(!connected?'Reconnect to see how it’s going.':!r?'Loading…':
   active(r.status)?(!e.runner?.online?'Pips not running · '+label.toLowerCase():r.status==='queued'?'Waiting for its turn.':'Working on its own. You can keep chatting.'):
   r.status==='failed'?'Open it to see what went wrong.':r.status==='cancelled'?'It was cancelled.':'Ready to look at.');
  if(connected&&!e.error&&active(r?.status)&&!e.runner?.online){e.status.textContent='Pips not running';e.root.dataset.state='offline';}
  e.open.disabled=!r||!connected;e.refresh.disabled=e.loading||!connected;
  e.open.title=`Open ${e.pip?.name||'this Pip'} · ${e.status.textContent}`;
  e.open.setAttribute('aria-label',e.open.title);
  e.refresh.hidden=!e.error;
 }
 async function load(e){
  if(disposed||!connected||e.loading||!e.root.isConnected)return;
  const token=epoch;e.loading=true;e.error='';paint(e);
  try{
   const result=await options.request('get_pip_run',{run_id:e.id});
   if(token!==epoch)return;
   const r=result.run;
   if(!record(r)||r.id!==e.id||r.pip_id!==e.pipId||!id(r.workspace_id,'ws')||!['queued','running','cancelling','succeeded','failed','cancelled'].includes(r.status))throw Error('This didn’t load. Retry.');
   const [pv,rv]=await Promise.all([options.request('get_pip',{pip_id:e.pipId}),options.request('get_pip_runner')]);
   if(token!==epoch)return;
   if(!record(pv.pip)||pv.pip.id!==r.pip_id||pv.pip.workspace_id!==r.workspace_id||!TYPES.includes(pv.pip.pip_type)||typeof pv.pip.name!=='string'||!record(rv.runner)||typeof rv.runner.online!=='boolean')throw Error('This didn’t load. Retry.');
   e.run=r;e.pip=pv.pip;e.runner=rv.runner;
  }catch(error){if(token===epoch)e.error=error.message;}
  finally{if(token===epoch){e.loading=false;paint(e);}}
 }
 function add(parent,runId,pipId){
  if(disposed||!id(runId,'run')||!id(pipId,'pip')||!parent)return;
  const existing=entries.get(runId);if(existing){if(existing.pipId===pipId&&!existing.root.isConnected){parent.append(existing.root);load(existing);}return;}
  if(entries.size>=12){parent.append(node('p','pip-run-detail','Open Pips to see more.'));return;}
  const root=node('div','pip-run-line'),face=node('span','pip-run-avatar'),title=node('span','pip-run-title'),status=node('span','pip-run-state'),detail=node('span','pip-run-detail');
  root.setAttribute('aria-label','Pip at work');face.setAttribute('aria-hidden','true');
  root.setAttribute('role','group');
  const open=node('button','pip-run-open agent-name'),refresh=node('button','pip-run-refresh','Retry');open.type=refresh.type='button';
  open.append(title);root.append(face,open,status,detail,refresh);parent.append(root);
  const e={id:runId,pipId,root,face,title,status,detail,open,refresh,uid:`pip-run-face-${++sequence}`,loading:false};entries.set(runId,e);
  if(timer===null)timer=(options.setInterval||setInterval)(tick,5000);
  open.onclick=()=>{if(e.run&&connected)options.onOpen?.({pip:e.pipId,section:'runs',run:e.id});};
  refresh.onclick=()=>load(e);paint(e);if(connected)load(e);else options.ready?.();
 }
 function toolResult(card,event){
  if(event.is_error||event.name!=='run_pip_now'||typeof event.output!=='string'||event.output.length>65536)return;
  let v;try{v=JSON.parse(event.output);}catch{return;}
  if(!id(v?.run_id,'run')||!id(v?.pip_id,'pip'))return;
  const body=card.querySelector('.body');if(!body)return;
  body.replaceChildren();add(body,v.run_id,v.pip_id);
  const entry=entries.get(v.run_id);
  if(!entry||entry.pipId!==v.pip_id)return;
  // Keep the run at its tool-call position, just like a specialist agent line.
  // The original receipt remains in history but no longer draws a second card.
  const anchor=card.closest('.tool-group')||card;
  if(!entry.placed){anchor.after(entry.root);entry.placed=true;}
  card.classList.add('pip-run-owned');
 }
 // Inline runs stay where they started, including after the final response.
 function finish(){}
 function connection(value){epoch++;connected=value===true;for(const e of entries.values()){e.loading=false;paint(e);if(connected)load(e);}}
 const tick=()=>{if(visible&&!doc.hidden&&connected)for(const e of entries.values())if(!e.run||active(e.run.status))void load(e);};
 const wake=()=>{if(!doc.hidden)tick();};doc.addEventListener('visibilitychange',wake);
 function reset(){epoch++;if(timer!==null)(options.clearInterval||clearInterval)(timer);timer=null;for(const e of entries.values()){e.cleanup?.();e.root.remove();}entries.clear();}
 return {add,toolResult,finish,connection,tick,reset,setVisible(v){visible=v===true;if(visible)tick();},dispose(){disposed=true;reset();doc.removeEventListener('visibilitychange',wake);}};
}
