// Main chat links to controller-owned drafts. Tool output supplies IDs only.
import {emailDraft,connectorDraft} from './pipsMessageReviews.js';
export function mountEmailCards(options){
 const doc=options.document,entries=new Map();let connected=false,epoch=0;
 const valid=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{32}$').test(v);
 const element=(tag,cls,text)=>{const node=doc.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 async function load(e){
  const token=epoch;e.open.disabled=true;e.state.textContent=connected?'Checking draft…':'Disconnected';if(!connected)return;
  try{const answer=await options.request(e.connector?'get_pip_connector_draft':e.calendar?'get_pip_calendar_draft':'get_pip_message_draft',{draft_id:e.id});if(token!==epoch||!e.root.isConnected)return;
   const d=e.connector?connectorDraft(answer.draft,e.pip,e.workspace):emailDraft(answer.draft,e.pip,e.workspace,e.calendar);if(d.id!==e.id)throw Error('Draft identity changed.');e.draft=d;e.title.textContent=e.connector?d.payload.action.call.tool:e.calendar?d.payload.event.summary:d.payload.message.subject;e.state.textContent=d.expired?'Expired':d.status==='prepared'?'Action review prepared':d.status==='dismissed'?'Dismissed':e.connector?'Connector draft · Review':e.calendar?'Calendar draft · Review':'Email draft · Review';e.open.disabled=false;
  }catch{if(token===epoch)e.state.textContent='Draft unavailable · Open Pips';}
 }
 function toolResult(card,event){
  if(event.is_error||!['draft_pip_email','draft_pip_calendar_event','draft_pip_connector_action'].includes(event.name)||typeof event.output!=='string'||event.output.length>8192)return;
  const calendar=event.name==='draft_pip_calendar_event',connector=event.name==='draft_pip_connector_action';
  let v;try{v=JSON.parse(event.output);}catch{return;}
  if(!valid(v?.draft_id,connector?'conndraft':calendar?'caldraft':'maildraft')||!valid(v.pip_id,'pip')||!valid(v.workspace_id,'ws'))return;
  const existing=entries.get(v.draft_id);
  if(existing){
   if(existing.pip!==v.pip_id||existing.workspace!==v.workspace_id)return;
   card.classList.add('pip-run-owned');
   if(!existing.root.isConnected){(card.closest('.tool-group')||card).after(existing.root);void load(existing);}
   return;
  }
  if(entries.size>=30)return;
  const root=element('div','pip-run-line'),open=element('button','pip-run-open agent-name'),title=element('span','pip-run-title',connector?'Connector draft':calendar?'Calendar draft':'Email draft'),state=element('span','pip-run-state','Checking draft…');
  root.setAttribute('aria-label',connector?'Pip connector draft':calendar?'Pip calendar draft':'Pip email draft');open.type='button';open.append(title);root.append(open,state);
  (card.closest('.tool-group')||card).after(root);card.classList.add('pip-run-owned');
  const e={calendar,connector,id:v.draft_id,pip:v.pip_id,workspace:v.workspace_id,root,open,title,state};entries.set(e.id,e);
  open.onclick=()=>{if(connected&&e.draft)options.onOpen?.({pip:e.pip,workspace:e.workspace,section:'chat',reviewKind:e.connector?'connector_draft':e.calendar?'calendar_draft':'email_draft',review:e.id});};
  if(connected)void load(e);else options.ready?.();
 }
 return {toolResult,connection(value){epoch++;connected=value===true;for(const e of entries.values())void load(e);},reset(){epoch++;for(const e of entries.values())e.root.remove();entries.clear();}};
}
