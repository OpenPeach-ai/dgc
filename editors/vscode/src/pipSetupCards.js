// Main-chat setup reviews. Tool output supplies an identity only: every actionable
// card is loaded again from the local registry and approved by its exact digest.
import '../media/pips/plush.js';
import {pipSetup,pipSetupResolution,pipModels,modelChoice,modelLabel,modelValue,subscriptionUsage,scheduleLabel,commandLine} from './pipsModel.js';
import {appReadWords} from './pipsAppPicker.js';
import {mountRunCards} from './pipRunCards.js';
import {mountEmailCards} from './pipEmailCards.js';

export function mountSetupCards(options) {
 const doc=options.document||document, entries=new Map(), pending=new Map();
 let generation=0, epoch=0, sequence=0, connected=false, supported=false, api=0, backgroundSetup=false, disposed=false, dockView=null;
 const node=(tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
 const request=(type,fields={})=>new Promise((resolve,reject)=>{
  if(!connected||!supported)return reject(Error('Reconnect, then try again.'));
  const id=`pip-card-${epoch}-${++sequence}`;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('No reply from DGC. Refresh this card before trying again.'));},20000);
  pending.set(id,{resolve,reject,timer});options.postMessage({type:'pipsRequest',id,generation,request:{type,...fields}});
 });
 const emails=mountEmailCards({document:doc,request,onOpen:options.onOpenRun,ready:()=>options.postMessage({type:'pipsReady'})});
 const runs=mountRunCards({document:doc,request,onOpen:options.onOpenRun,ready:()=>options.postMessage({type:'pipsReady'}),onChange:options.onRunsChange});
 function repaint(entry){for(const view of entry.views){if(view.root.isConnected)paint(entry,view);}if(dockView?.entry===entry&&entry.setup?.status==='pending')paintDock(dockView);else refreshDock();}
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
    if(seen.has(next)||seen.size>=8)throw Error('This card changed several times. Open Pips to see the latest.');
    seen.add(next);const reply=await request('get_pip_setup',{setup_id:next});if(token!==epoch)return;
    s=pipSetup(reply.setup,s.workspace_id,next);
   }
   if(token!==epoch)return;
   remap(entry,s.id);entry.setup=s;entry.choice=s.model_choice||{mode:'default'};
  }).catch(error=>{if(token===epoch)entry.error=error.message;}).finally(()=>{if(token===epoch){entry.loading=false;repaint(entry);}});
 }
 function button(label,fn,cls='') {const b=node('button',cls,label);b.type='button';b.onclick=fn;return b;}
 function detail(parent,label,value){const row=node('div','pip-setup-fact');row.append(node('dt','',label),node('dd','',value));parent.append(row);}
 const TYPES=['core','scout','lens','patch','rook','pulse','lock','quill'];
 const typeName=t=>t?t[0].toUpperCase()+t.slice(1):'Pip';
 function face(entry,size,pose,uid){
  const span=node('span',`pip-setup-avatar pip-setup-avatar-${size}`);span.setAttribute('aria-hidden','true');const s=entry.setup;
  if(s&&globalThis.PipConcepts?.plush){try{span.innerHTML=globalThis.PipConcepts.plush.markup({index:TYPES.indexOf(s.pip_type),name:s.name},pose,uid,{paused:true});}catch{span.replaceChildren();}}
  return span;
 }
 // What the card's chips say, in the user's words: when it runs, what it reads, what it may do.
 function chips(s){
  const out=[];
  out.push(s.event_trigger?'After each commit':s.schedule?scheduleLabel(s.schedule):'When you ask');
  if(s.run_now)out.push('Runs once now');
  if(s.app_plan){const server=String(s.app_plan.server||'');out.push('Reads '+(/gmail/i.test(server)?'Gmail':/calendar/i.test(server)?'Google Calendar':/drive/i.test(server)?'Google Drive':server||'a connected app'));}
  if(s.web_plan)out.push('Reads the web');
  if(s.verification_plan){const n=s.verification_plan.action.tests.length;out.push(`${n} fixed ${s.work_kind==='app_smoke_test'?(n===1?'check':'checks'):(n===1?'command':'commands')}`);}
  out.push(s.source_policy==='personal'?'Asks before sending':s.pip_type==='quill'?'Drafts docs':'Reads committed code');
  out.push(s.model_choice?.mode==='model'?s.model_choice.model:s.model_choice?.mode==='subscription'?modelLabel(s.model_choice):'Your DGC model');
  return out;
 }
 const pendingTitle=s=>(s.pip_id?'Change Pip: ':'New Pip: ')+s.name;
 const createLabel=s=>s.pip_id?'Update Pip':s.run_now?'Create & run':'Create Pip';
 function createDisabled(entry){const s=entry.setup;return entry.busy||JSON.stringify(entry.choice)!==JSON.stringify(s.model_choice||{mode:'default'})||(s.pip_type==='pulse'&&api<27)||Date.parse(s.expires_at)<=Date.now()||!connected;}
 // Everything a reviewer may want before deciding: the exact facts, notices, why, and the model.
 function details(entry,{goal=true}={}){
  const s=entry.setup,body=node('div','pip-setup-body');
  if(goal)body.append(node('p','pip-setup-goal',s.goal));          // the docked card shows it already
  const facts=node('dl','pip-setup-facts');detail(facts,s.source_policy==='personal'?'Scope':'Project',s.source_policy==='personal'?'Personal':s.project_root);if(s.event_trigger)detail(facts,'Runs',`After each new commit to ${s.source_ref}`);else detail(facts,'Schedule',s.schedule?scheduleLabel(s.schedule):'When you ask');
  if(s.next_run_at)detail(facts,'Next run',`${new Date(s.next_run_at).toLocaleString()} (your local time)`);
  detail(facts,'Run once now',s.run_now?'Yes, after you create it':'No');if(s.source_policy!=='personal')detail(facts,'Source',s.source_ref);detail(facts,s.pip_type==='pulse'?'Chat model':'Model',s.model_choice?.mode==='model'?s.model_choice.model:s.model_choice?.mode==='subscription'?modelLabel(s.model_choice):'Your DGC model');
  if(s.verification_plan){detail(facts,'Runs','Set checks · no model');for(const test of s.verification_plan.action.tests)detail(facts,'Check',s.work_kind==='app_smoke_test'?`GET ${test.argv[1]} → status ${test.argv[2]}`:commandLine(test.argv)+' · in '+test.cwd);}
  if(s.app_plan)for(const words of appReadWords(s.app_plan))detail(facts,'Reads',words);
  if(s.web_plan)for(const read of s.web_plan.reads||[])detail(facts,read.kind==='page'?'Web page':'Web search',read.kind==='page'?read.url:read.query);
  body.append(facts,node('p','pip-setup-notice',s.scope_notice),node('p','pip-setup-notice',s.runner_notice));
  if(s.run_now_policy)body.append(node('p','pip-setup-notice',s.run_now_policy));
  const reason=node('details','pip-setup-reason');reason.append(node('summary','','Why this Pip'),node('p','',s.reason));body.append(reason);
  if(s.status==='pending'&&!entry.loading&&api>=25&&!s.verification_plan){
   const models=node('div','pip-setup-model');
   if(entry.models){
    const label=node('label','','Model for this Pip'),select=node('select');select.setAttribute('aria-label','Model for this Pip');
    const current=s.model_choice||{mode:'default'}, following=entry.models.default_engine?.name||entry.models.default_model, choices=[{value:'',name:`Your DGC model${following?' · '+following:''}`}];
    for(const item of entry.models.models)choices.push({value:typeof item==='string'?item:item.id,name:typeof item==='string'?item:item.name||item.id});
    if(current.mode==='model'&&!choices.some(c=>c.value===current.model))choices.push({value:current.model,name:current.model});
    // API 55: a personal setup may run on the user's own Claude Code or Codex (pip_brain). "|" is never in a model ID.
    const subs=api>=55&&s.source_policy==='personal'?entry.models.subscriptions||[]:[];
    for(const sub of subs)choices.push({value:'subscription|'+sub.engine,name:sub.name+' · your subscription'});
    for(const choice of choices){const o=node('option','',choice.name);o.value=choice.value;select.append(o);}select.value=entry.choice.mode==='model'?entry.choice.model:entry.choice.mode==='subscription'?'subscription|'+entry.choice.engine:'';
    select.onchange=()=>{const v=select.value;entry.choice=v.startsWith('subscription|')?{mode:'subscription',engine:v.slice(13)}:v?{mode:'model',model:v}:{mode:'default'};repaint(entry);};label.append(select);models.append(label);
    if(entry.choice.mode==='subscription')models.append(node('p','pip-setup-notice',subscriptionUsage(modelLabel(entry.choice))));
    if(JSON.stringify(entry.choice)!==JSON.stringify(current))models.append(button('Use this model',()=>revise(entry),'pip-setup-secondary'),node('p','pip-setup-notice','The card is saved again with this model. Nothing is created until you choose '+createLabel(s)+'.'));
   }else models.append(button('Choose model',()=>modelsFor(entry),'pip-setup-secondary'));
   body.append(models);
  }
  return body;
 }
 function stateLine(entry){
  const s=entry.setup;if(!s)return entry.error?'Could not load this Pip':'Checking…';
  if(s.status==='pending')return dockView?.entry===entry?'Waiting for you above the chat box':'Waiting for you';
  if(s.status==='accepted'){const run=s.receipt?.run_id?'Its first run is starting':s.next_run_at?`First run ${new Date(s.next_run_at).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})}`:'Runs when you ask';return run;}
  if(s.status==='rejected')return 'Not created';return 'This card expired. Ask DGC again.';
 }
 function lineTitle(entry){
  const s=entry.setup;if(!s)return 'New Pip';
  if(s.status==='accepted')return s.pip_id?`${s.name} is updated`:`${s.name} is on`;
  if(s.status==='pending')return pendingTitle(s);return s.name;
 }
 // The line in the reply: what became of the proposal, and its details on request.
 function paintLine(entry,view){
  view.dispose?.();view.dispose=null;view.root.replaceChildren();const s=entry.setup;
  view.root.dataset.status=s?.status||'loading';
  const head=node('div','pip-setup-summary');
  head.append(face(entry,'line',s?.status==='accepted'?'success':'idle',view.uid));
  const title=node('span','pip-setup-title');title.title=lineTitle(entry);title.append(node('strong','',lineTitle(entry)),node('span','',stateLine(entry)));head.append(title);
  const quick=node('span','pip-setup-quick-actions');
  if(s?.status==='pending'&&!entry.loading&&!(options.dock&&dockView?.entry===entry)){
   if(options.dock){quick.append(button('Review',()=>{entry.later=false;refreshDock(true);},'pip-setup-primary'));}
   else{const create=button(createLabel(s),()=>resolve(entry,true),'pip-setup-primary');create.disabled=createDisabled(entry);
    const reject=button('Not now',()=>resolve(entry,false),'pip-setup-secondary');reject.disabled=entry.busy||!connected;quick.append(create,reject);}
  }
  if(s?.status==='accepted'&&options.onOpenRun&&s.receipt?.pip_id)quick.append(button('Open in Pips',()=>options.onOpenRun({pip:s.receipt.pip_id}),'pip-setup-review'));
  const more=button(view.open?'Hide details':'Details',()=>{view.open=!view.open;paintLine(entry,view);},'pip-setup-review');more.setAttribute('aria-expanded',String(!!view.open));
  if(s||entry.error)quick.append(more);
  head.append(quick);view.root.append(head);
  const body=node('div','pip-setup-details');body.hidden=!view.open&&!entry.error;view.root.append(body);
  if(s)body.append(details(entry));                     // kept in the page, shown by Details
  if(s?.status==='accepted'){
   const allowed=String(s.receipt.actor||'').startsWith('chat-permission:');
   body.append(node('p','pip-setup-receipt',(allowed?(String(s.receipt.actor).endsWith(':auto')?'Created in auto mode. ':'Created on your Allow in the chat. '):'')+'Pause, change or delete it in Pips.'+(s.receipt.run_id?' Its first run is queued.':'')));
   if(!entry.continued&&!allowed)body.append(button('Let the chat know',()=>continueChat(entry),'pip-setup-secondary'));
  }
  if(entry.error){const error=node('p','pip-setup-error',entry.error);error.setAttribute('role','alert');body.append(error);}
  if(entry.continued)body.append(node('p','pip-setup-notice','The chat was told it is on.'));
  if(entry.busy)body.append(node('p','pip-setup-notice','Saving your choice…'));
  body.append(button('Refresh',()=>load(entry),'pip-setup-refresh'));
  view.root.querySelectorAll('button,select,input').forEach(el=>{if(entry.busy)el.disabled=true;});
  if(s?.status==='accepted'&&s.receipt?.run_id)runs.add(view.root,s.receipt.run_id,s.receipt.pip_id);
 }
 // The card docked above the chat box, where questions dock: one waiting Pip at a time.
 function paintDock(view){
  const entry=view.entry,s=entry.setup;view.root.replaceChildren();
  const head=node('div','ask-head pip-dock-head');
  const words=node('div','pip-dock-words');words.append(node('div','ask-q pip-dock-title',pendingTitle(s)),node('div','pip-dock-sub',`A ${typeName(s.pip_type)} · ${s.source_policy==='personal'?'personal':'this project'} · ${s.schedule||s.event_trigger?'runs on its own':'runs when you ask'}`));
  const later=button('',()=>{entry.later=true;refreshDock();},'ask-x');later.setAttribute('aria-label','Later');later.title='Later: keep this card in the chat';later.innerHTML='<span class="codicon codicon-close" aria-hidden="true"></span>';
  head.append(face(entry,'dock','idle',view.uid),words,later);view.root.append(head);
  const goal=node('p','pip-dock-goal',s.goal);view.root.append(goal);
  const row=node('div','pip-dock-chips');for(const text of chips(s))row.append(node('span','pip-dock-chip',text));view.root.append(row);
  if(view.open){const more=node('div','pip-dock-details');more.append(details(entry,{goal:false}));view.root.append(more);}
  if(entry.error){const error=node('p','pip-setup-error',entry.error);error.setAttribute('role','alert');view.root.append(error);}
  const foot=node('div','pip-dock-foot');
  const no=button('Not now',()=>resolve(entry,false),'ask-skip pip-dock-no');no.disabled=entry.busy||!connected;
  const more=button(view.open?'Hide details':'Details',()=>{view.open=!view.open;paintDock(view);},'ask-act pip-dock-more');more.setAttribute('aria-expanded',String(!!view.open));
  const create=button(entry.busy?'Saving…':createLabel(s),()=>resolve(entry,true),'ask-act primary pip-dock-create');create.disabled=createDisabled(entry);
  foot.append(no,more,create);view.root.append(foot);
 }
 function refreshDock(focus=false){
  if(!options.dock)return;
  const next=[...entries.values()].find(e=>e.setup?.status==='pending'&&!e.later&&!e.loading&&connected);
  if(dockView&&dockView.entry!==next){const old=dockView;dockView=null;options.dock.hide(old.root);repaint(old.entry);}
  if(!next)return;
  if(!dockView){
   const root=node('section','ask pip-dock');root.setAttribute('role','group');root.setAttribute('aria-label',`New Pip: ${next.setup.name}`);root.dataset.setupId=next.id;
   const view={kind:'dock',root,entry:next,uid:`pip-dock-face-${++sequence}`,open:false};paintDock(view);
   if(!options.dock.show(root))return;
   dockView=view;repaint(next);
  }else paintDock(dockView);
  if(focus)dockView.root.querySelector('.pip-dock-create')?.focus({preventScroll:true});
 }
 function paint(entry,view){paintLine(entry,view);}
 async function modelsFor(entry){const token=epoch;try{const models=pipModels(await request('list_pip_models'));if(token===epoch){entry.models=models;repaint(entry);}}catch(error){if(token===epoch){entry.error=error.message;repaint(entry);}}}
 async function revise(entry){
  const token=epoch,s=entry.setup;entry.busy=true;entry.error='';repaint(entry);
  try{
   const value=await request('revise_pip_setup',{setup_id:s.id,expected_digest:s.digest,model_choice:modelChoice(modelValue(entry.choice),entry.models?.models||[],api>=55&&s.source_policy==='personal'?entry.models?.subscriptions||[]:[])});if(token!==epoch)return;
   const next=pipSetup(value.setup,s.workspace_id);if(next.status!=='pending'||next.id===s.id)throw Error('This was changed or answered somewhere else. Refresh to see it.');
   remap(entry,next.id);entry.setup=next;entry.choice=next.model_choice||{mode:'default'};
  }catch(error){if(token===epoch)entry.error=error.message;}finally{if(token===epoch){entry.busy=false;repaint(entry);}}
 }
 async function resolve(entry,accept){
  if(accept&&entry.setup?.pip_type==='pulse'&&api<27){entry.error='Update DGC to set up Pulse from the chat.';repaint(entry);return;}
  if(entry.busy||!entry.setup)return;const token=epoch,s=entry.setup;entry.busy=true;entry.error='';repaint(entry);
  try{
   const latest=pipSetup((await request('get_pip_setup',{setup_id:s.id})).setup,s.workspace_id,s.id);if(token!==epoch)return;
   if(latest.digest!==s.digest||latest.status!=='pending') {entry.setup=latest;throw Error('This was changed or answered somewhere else. Refresh to see it.');}
   const value=await request(accept?'accept_pip_setup':'reject_pip_setup',{setup_id:s.id,expected_digest:s.digest});if(token!==epoch)return;
   entry.setup=pipSetupResolution(value.setup,s,accept);
   if(accept){for(const v of entry.views)v.open=false;continueChat(entry);}
  }catch(error){if(token===epoch)entry.error=error.message;}finally{if(token===epoch){entry.busy=false;repaint(entry);}}
 }
 async function continueChat(entry){
  if(entry.setup?.status!=='accepted'||entry.continued||entry.notifying)return;
  if(!backgroundSetup){entry.error=`${entry.setup?.name||'The Pip'} is created. Reload the window so the chat hears about it.`;repaint(entry);return;}
  const token=epoch;entry.notifying=true;
  try{const value=await request('notify_pip_setup',{setup_id:entry.setup.id});if(token!==epoch)return;
   if(value.setup_id!==entry.setup.id||!['started','queued','steered','already_notified'].includes(value.notification))throw Error('The chat wasn’t told. Try again.');
   entry.continued=true;
  }catch(error){if(token===epoch)entry.error=error.message;}finally{if(token===epoch){entry.notifying=false;repaint(entry);}}
 }
 function addView(entry,parent,expanded=false){
  if(entry.views.length){
   const view=entry.views[0],previous=view.root.closest('[data-pip-setup]');
   if(previous&&previous!==parent.closest('[data-pip-setup]'))previous.classList.add('pip-setup-moved');
   parent.append(view.root);return;
  }
  const root=node('div','pip-setup-card pip-setup-line');root.dataset.setupId=entry.id;
  const view={kind:'line',root,uid:`pip-setup-face-${++sequence}`,open:expanded};entry.views.push(view);parent.append(root);paint(entry,view);
 }
 function receive(message){
  if(message.type==='pipsVisibility'){runs.setVisible(message.visible);return;}
  if(message.type==='pipsConnection'){
   const changed=generation!==message.generation;generation=message.generation;connected=message.connected===true;api=message.apiVersion||0;backgroundSetup=message.backgroundSetup===true;supported=connected&&message.enabled===true&&api>=23;
   if(changed){epoch++;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('The chat connection changed. Refresh the setup card.'));}pending.clear();for(const e of entries.values()){e.loading=false;e.busy=false;}}
   emails.connection(supported&&api>=32);runs.connection(supported);for(const e of entries.values()){repaint(e);if(supported)load(e);}refreshDock();return;
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
  card.querySelector('.verb').textContent='New Pip';card.querySelector('.tool-toggle')?.setAttribute('aria-expanded','true');card.classList.add('open');
  if(!connected)options.postMessage({type:'pipsReady'});else load(entry);
 }
 function finish(block){
  runs.finish(block);
  const ids=[...block.querySelectorAll('[data-pip-setup]')].map(c=>c.dataset.pipSetup);
  if(!ids.length)return;let group=block.querySelector(':scope > .pip-setup-pending');if(!group){group=node('section','pip-setup-pending');group.setAttribute('aria-label','New Pips from this reply');block.append(group);}
  for(const id of new Set(ids)){const entry=entries.get(id);if(!entry)continue;const view=entry.views.find(v=>block.contains(v.root));if(view){const tool=view.root.closest('[data-pip-setup]');group.append(view.root);if(tool)tool.classList.add('pip-setup-moved');}}
 }
 function reset(){emails.reset();runs.reset();if(dockView){options.dock?.hide(dockView.root);dockView=null;}epoch++;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('The conversation changed.'));}pending.clear();for(const e of entries.values())for(const v of e.views){v.dispose?.();v.root.remove();}entries.clear();}
 // The host's dock was taken by a question (yieldDock) or is free again (dockFree).
 function yieldDock(){if(dockView){const old=dockView;dockView=null;options.dock?.hide(old.root);repaint(old.entry);}}
 return {receive,toolResult,finish,reset,yieldDock,dockFree:()=>refreshDock(),runs:()=>runs.list(),openRun:id=>runs.open(id),dispose(){reset();runs.dispose();disposed=true;}};
}
