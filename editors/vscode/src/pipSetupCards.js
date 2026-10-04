// Main-chat setup reviews. Tool output supplies an identity only: every actionable
// card is loaded again from the local registry and approved by its exact digest.
import '../media/pips/plush.js';
import {pipSetup,pipSetupResolution,pipModels,modelChoice,scheduleLabel} from './pipsModel.js';
import {mountRunCards} from './pipRunCards.js';
import {mountEmailCards} from './pipEmailCards.js';

export function mountSetupCards(options) {
 const doc=options.document||document, entries=new Map(), pending=new Map();
 let generation=0, epoch=0, sequence=0, connected=false, supported=false, api=0, backgroundSetup=false, disposed=false;
 const node=(tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
 const request=(type,fields={})=>new Promise((resolve,reject)=>{
  if(!connected||!supported)return reject(Error('Reconnect to this chat before reviewing Pip setup.'));
  const id=`pip-card-${epoch}-${++sequence}`;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('No reply from DGC. Refresh this card before trying again.'));},20000);
  pending.set(id,{resolve,reject,timer});options.postMessage({type:'pipsRequest',id,generation,request:{type,...fields}});
 });
 const emails=mountEmailCards({document:doc,request,onOpen:options.onOpenRun,ready:()=>options.postMessage({type:'pipsReady'})});
 const runs=mountRunCards({document:doc,request,onOpen:options.onOpenRun,ready:()=>options.postMessage({type:'pipsReady'})});
 function repaint(entry){for(const view of entry.views){if(view.root.isConnected)paint(entry,view);}}
 function remap(entry,id){for(const view of entry.views){const tool=view.root.closest('[data-pip-setup]');if(tool)tool.dataset.pipSetup=id;view.root.dataset.setupId=id;}entries.delete(entry.id);entry.id=id;entries.set(id,entry);}
 function load(entry){
  if(entry.loading||entry.busy||!connected||!supported)return;
  entry.loading=true;entry.error='';repaint(entry);const token=epoch;
  request('get_pip_setup',{setup_id:entry.id}).then(async value=>{
   if(token!==epoch)return;
   let s=pipSetup(value.setup,value.setup?.workspace_id,entry.id);
   if(!/^ws_[a-f0-9]{32}$/.test(s.workspace_id))throw Error('Invalid project identity.');
   const seen=new Set([s.id]);
   while(s.status==='rejected'&&s.receipt?.replacement_setup_id){
    const next=s.receipt.replacement_setup_id;
    if(seen.has(next)||seen.size>=8)throw Error('This proposal has several revisions. Open Pips to review its latest setup.');
    seen.add(next);const reply=await request('get_pip_setup',{setup_id:next});if(token!==epoch)return;
    s=pipSetup(reply.setup,s.workspace_id,next);
   }
   if(token!==epoch)return;
   remap(entry,s.id);entry.setup=s;entry.choice=s.model_choice||{mode:'default'};
  }).catch(error=>{if(token===epoch)entry.error=error.message;}).finally(()=>{if(token===epoch){entry.loading=false;repaint(entry);}});
 }
 function button(label,fn,cls='') {const b=node('button',cls,label);b.type='button';b.onclick=fn;return b;}
 function detail(parent,label,value){const row=node('div','pip-setup-fact');row.append(node('dt','',label),node('dd','',value));parent.append(row);}
 function paint(entry,view){
  const open=view.root.open;view.root.dataset.status=entry.setup?.status||'loading';view.dispose?.();view.dispose=null;view.root.replaceChildren();
  const s=entry.setup, head=node('summary','pip-setup-summary'),face=node('span','pip-setup-avatar');
  if(s&&globalThis.PipConcepts?.plush){face.innerHTML=globalThis.PipConcepts.plush.markup({index:['core','scout','lens','patch','rook','pulse','lock','quill'].indexOf(s.pip_type),name:s.name},s.status==='pending'?'waiting_approval':'idle',view.uid,{paused:true});}
  const title=node('span','pip-setup-title');title.title=s?.name||'Pip proposal';title.append(node('strong','',s?.name||'Pip proposal'),node('span','',s?(s.verification_plan?`Pulse · ${s.verification_plan.action.tests.length} reviewed ${s.work_kind==='app_smoke_test'?'local HTTP checks':'commands'}`:s.pip_id?'Modify Pip':'Create Pip'):'Loading saved setup…'));
  const status=node('span','pip-setup-state',s?.status==='pending'?(s.pip_id?'Modify':'Create'):s?.status==='accepted'?'Saved':s?.status||'');head.append(face,title,status);
  const quick=node('span','pip-setup-quick-actions');
  const local=(label,fn,cls)=>button(label,event=>{event.preventDefault();event.stopPropagation();fn();},cls);
  if(s?.status==='pending'&&!entry.loading){
   const changed=JSON.stringify(entry.choice)!==JSON.stringify(s.model_choice||{mode:'default'});
   const approve=local(s.run_now?'Approve & run':'Approve',()=>resolve(entry,true),'pip-setup-primary');
   approve.title=s.run_now?'Approve this setup and queue its displayed immediate run':'Approve the saved setup';
   approve.disabled=entry.busy||changed||(s.pip_type==='pulse'&&api<27)||Date.parse(s.expires_at)<=Date.now()||!connected;
   const reject=local('Reject',()=>resolve(entry,false),'pip-setup-secondary');reject.disabled=entry.busy||!connected;
   quick.append(approve,reject);
  }
  const review=local(open?'Close':'Review',()=>{view.root.open=!view.root.open;paint(entry,view);},'pip-setup-review');
  review.setAttribute('aria-expanded',String(open));quick.append(review);head.append(quick);view.root.append(head);
  const body=node('div','pip-setup-body');view.root.append(body);
  if(s){
   body.append(node('p','pip-setup-goal',s.goal));
   const facts=node('dl','pip-setup-facts');detail(facts,s.source_policy==='personal'?'Scope':'Project',s.source_policy==='personal'?'Personal · across project directories':s.project_root);if(s.event_trigger)detail(facts,'Runs',`After each new commit to ${s.source_ref}`);else detail(facts,'Schedule',s.schedule?scheduleLabel(s.schedule):'Manual only');
   if(s.next_run_at)detail(facts,'Next run',`${new Date(s.next_run_at).toLocaleString()} (your local time)`);
   detail(facts,'Run once now',s.run_now?'Yes, after approval':'No');detail(facts,'Source',s.source_policy==='personal'?'No project access':s.source_ref);detail(facts,s.pip_type==='pulse'?'Chat model':'Model',s.model_choice?.mode==='model'?s.model_choice.model:'Inherit main DGC model');
   if(s.verification_plan){detail(facts,'Execution','Fixed checks · no model');for(const test of s.verification_plan.action.tests)detail(facts,'Exact check',s.work_kind==='app_smoke_test'?`GET ${test.argv[1]} → HTTP ${test.argv[2]}`:JSON.stringify(test.argv)+' · cwd '+test.cwd);}
   if(s.app_plan){detail(facts,'Connection',s.app_plan.server);for(const call of s.app_plan.calls||[])detail(facts,'Reviewed app read',call.tool+' · account '+(call.account||'server account')+' · '+JSON.stringify(call.arguments));}
   if(s.web_plan)for(const read of s.web_plan.reads||[])detail(facts,read.kind==='page'?'Reviewed web page':'Reviewed web search',read.kind==='page'?read.url:read.query);
   body.append(facts,node('p','pip-setup-notice',s.scope_notice),node('p','pip-setup-notice',s.runner_notice));
   if(s.run_now_policy)body.append(node('p','pip-setup-notice',s.run_now_policy));
   const reason=node('details','pip-setup-reason');reason.append(node('summary','','Why this Pip'),node('p','',s.reason));body.append(reason);
   if(s.status==='pending'&&!entry.loading){
    if(api>=25&&(!s.verification_plan)){
     const models=node('div','pip-setup-model');
     if(entry.models){
      const label=node('label','','Model for this Pip'),select=node('select');select.setAttribute('aria-label','Model for this Pip');
      const current=s.model_choice||{mode:'default'}, choices=[{value:'',name:`Inherit DGC${entry.models.default_model?' · '+entry.models.default_model:''}`}];
      for(const item of entry.models.models)choices.push({value:typeof item==='string'?item:item.id,name:typeof item==='string'?item:item.name||item.id});
      if(current.mode==='model'&&!choices.some(c=>c.value===current.model))choices.push({value:current.model,name:current.model});
      for(const choice of choices){const o=node('option','',choice.name);o.value=choice.value;select.append(o);}select.value=entry.choice.mode==='model'?entry.choice.model:'';
      select.onchange=()=>{entry.choice=select.value?{mode:'model',model:select.value}:{mode:'default'};repaint(entry);};label.append(select);models.append(label);
      const changed=JSON.stringify(entry.choice)!==JSON.stringify(current);
      if(changed)models.append(button('Update review card',()=>revise(entry),'pip-setup-secondary'),node('p','pip-setup-notice','Changing the model creates a new proposal to review. It does not install or run the Pip.'));
     }else models.append(button('Choose model',()=>modelsFor(entry),'pip-setup-secondary'));
     body.append(models);
    }
   }else if(s.status==='accepted'){
    body.append(node('p','pip-setup-receipt',s.receipt.run_id?'Setup saved. One run was queued; this is not a completed review.':'Setup saved. No immediate run was requested.'));
    if(!entry.continued)body.append(button('Retry chat notification',()=>continueChat(entry),'pip-setup-secondary'));
   }else if(s.status==='rejected')body.append(node('p','pip-setup-notice','Proposal rejected. This proposal did not change the Pip or start work.'));
   else if(s.status==='expired')body.append(node('p','pip-setup-notice','This proposal expired. Ask DGC for a fresh setup card.'));
  }
  if(entry.error){view.root.open=true;const error=node('p','pip-setup-error',entry.error);error.setAttribute('role','alert');body.append(error);}
  if(entry.loading)body.append(node('p','pip-setup-notice','Checking the saved proposal…'));
  if(entry.busy)body.append(node('p','pip-setup-notice','Saving your decision…'));
  if(entry.continued)body.append(node('p','pip-setup-notice','The main conversation has been notified.'));
  body.append(button('Refresh',()=>load(entry),'pip-setup-refresh'));
  body.querySelectorAll('button,select,input').forEach(el=>{if(entry.busy)el.disabled=true;});view.root.open=open||!!entry.error;
  if(s?.status==='accepted'&&s.receipt?.run_id)runs.add(body,s.receipt.run_id,s.receipt.pip_id);
 }
 async function modelsFor(entry){const token=epoch;try{const models=pipModels(await request('list_pip_models'));if(token===epoch){entry.models=models;repaint(entry);}}catch(error){if(token===epoch){entry.error=error.message;repaint(entry);}}}
 async function revise(entry){
  const token=epoch,s=entry.setup;entry.busy=true;entry.error='';repaint(entry);
  try{
   const value=await request('revise_pip_setup',{setup_id:s.id,expected_digest:s.digest,model_choice:modelChoice(entry.choice.mode==='default'?'default':'model:'+entry.choice.model,entry.models?.models||[])});if(token!==epoch)return;
   const next=pipSetup(value.setup,s.workspace_id);if(next.status!=='pending'||next.id===s.id)throw Error('DGC did not return a new pending proposal. Refresh before approving.');
   remap(entry,next.id);entry.setup=next;entry.choice=next.model_choice||{mode:'default'};
  }catch(error){if(token===epoch)entry.error=error.message;}finally{if(token===epoch){entry.busy=false;repaint(entry);}}
 }
 async function resolve(entry,accept){
  if(accept&&entry.setup?.pip_type==='pulse'&&api<27){entry.error='Update the DGC CLI (Pips API 27) for conversational Pulse setup.';repaint(entry);return;}
  if(entry.busy||!entry.setup)return;const token=epoch,s=entry.setup;entry.busy=true;entry.error='';repaint(entry);
  try{
   const latest=pipSetup((await request('get_pip_setup',{setup_id:s.id})).setup,s.workspace_id,s.id);if(token!==epoch)return;
   if(latest.digest!==s.digest||latest.status!=='pending') {entry.setup=latest;throw Error('This proposal changed or was resolved elsewhere. Review its current status.');}
   const value=await request(accept?'accept_pip_setup':'reject_pip_setup',{setup_id:s.id,expected_digest:s.digest});if(token!==epoch)return;
   entry.setup=pipSetupResolution(value.setup,s,accept);
   if(accept){for(const v of entry.views)v.root.open=false;continueChat(entry);}
  }catch(error){if(token===epoch)entry.error=error.message;}finally{if(token===epoch){entry.busy=false;repaint(entry);}}
 }
 async function continueChat(entry){
  if(entry.setup?.status!=='accepted'||entry.continued||entry.notifying)return;
  if(!backgroundSetup){entry.error='Setup is saved. Reload the window to get background approval notifications.';repaint(entry);return;}
  const token=epoch;entry.notifying=true;
  try{const value=await request('notify_pip_setup',{setup_id:entry.setup.id});if(token!==epoch)return;
   if(value.setup_id!==entry.setup.id||!['started','queued','steered','already_notified'].includes(value.notification))throw Error('The notification receipt did not match this setup.');
   entry.continued=true;
  }catch(error){if(token===epoch)entry.error=error.message;}finally{if(token===epoch){entry.notifying=false;repaint(entry);}}
 }
 function addView(entry,parent,expanded=false){
  if(entry.views.length){
   const view=entry.views[0],previous=view.root.closest('[data-pip-setup]');
   if(previous&&previous!==parent.closest('[data-pip-setup]'))previous.classList.add('pip-setup-moved');
   parent.append(view.root);return;
  }
  const root=node('details','pip-setup-card');root.dataset.setupId=entry.id;root.open=expanded;
  root.addEventListener('toggle',()=>{const review=root.querySelector('.pip-setup-review');if(review){review.textContent=root.open?'Close':'Review';review.setAttribute('aria-expanded',String(root.open));}});
  const view={root,uid:`pip-setup-face-${++sequence}`};entry.views.push(view);parent.append(root);paint(entry,view);
 }
 function receive(message){
  if(message.type==='pipsVisibility'){runs.setVisible(message.visible);return;}
  if(message.type==='pipsConnection'){
   const changed=generation!==message.generation;generation=message.generation;connected=message.connected===true;api=message.apiVersion||0;backgroundSetup=message.backgroundSetup===true;supported=connected&&message.enabled===true&&api>=23;
   if(changed){epoch++;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('The chat connection changed. Refresh the setup card.'));}pending.clear();for(const e of entries.values()){e.loading=false;e.busy=false;}}
   emails.connection(supported&&api>=32);runs.connection(supported);for(const e of entries.values()){repaint(e);if(supported)load(e);}return;
  }
  if(message.type!=='pipsReply')return;const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.ok?p.resolve(message.result):p.reject(Error(message.error?.message||'DGC could not review this setup.'));
 }
 function toolResult(card,event){
  if(!disposed){runs.toolResult(card,event);emails.toolResult(card,event);}
  if(disposed||event.is_error||event.name!=='pips_setup'||typeof event.output!=='string'||event.output.length>65536)return;
  let value;try{value=JSON.parse(event.output);}catch{return;}
  const id=value?.setup?.id;if(typeof id!=='string'||!/^setup_[a-f0-9]{32}$/.test(id))return;
  let entry=entries.get(id);if(!entry){if(entries.size>=100)return;entry={id,views:[],setup:null,choice:{mode:'default'},busy:false,loading:false,error:'',continued:false};entries.set(id,entry);}
  const body=card.querySelector('.body');if(!body)return;card.classList.remove('pip-setup-moved');body.replaceChildren();addView(entry,body,false);card.querySelector('.badge').textContent='Review';card.dataset.pipSetup=id;
  card.querySelector('.verb').textContent='Pip proposal';card.querySelector('.tool-toggle')?.setAttribute('aria-expanded','true');card.classList.add('open');
  if(!connected)options.postMessage({type:'pipsReady'});else load(entry);
 }
 function finish(block){
  runs.finish(block);
  const ids=[...block.querySelectorAll('[data-pip-setup]')].map(c=>c.dataset.pipSetup);
  if(!ids.length)return;let group=block.querySelector(':scope > .pip-setup-pending');if(!group){group=node('section','pip-setup-pending');group.setAttribute('aria-label','Pip proposals from this response');block.append(group);}
  for(const id of new Set(ids)){const entry=entries.get(id);if(!entry)continue;const view=entry.views.find(v=>block.contains(v.root));if(view){const tool=view.root.closest('[data-pip-setup]');group.append(view.root);if(tool)tool.classList.add('pip-setup-moved');}}
 }
 function reset(){emails.reset();runs.reset();epoch++;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('The conversation changed.'));}pending.clear();for(const e of entries.values())for(const v of e.views){v.dispose?.();v.root.remove();}entries.clear();}
 return {receive,toolResult,finish,reset,dispose(){reset();runs.dispose();disposed=true;}};
}
