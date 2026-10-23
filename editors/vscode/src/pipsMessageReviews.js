// Closed, data-only validation for the human message review surface.
import {accountChoices} from './pipsAppPicker.js';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{32}$').test(v);
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>obj(v)&&Object.keys(v).sort().join()===keys.sort().join();
const text=(v,n,body=false)=>typeof v==='string'&&v.trim()===v&&v.length>0&&new TextEncoder().encode(v).length<=n&&!([...v].some(c=>/\p{C}/u.test(c)&&!(body&&['\n','\t'].includes(c))));
export const messageStates={pending:'Waiting for you',dispatching:'Not sure it was sent',succeeded:'Sent',unknown:'Not sure it was sent',rejected:'Rejected',expired:'Expired'};
export function sendAccounts(server,discovery,inspection){
 if(!inspection||inspection.tool!=='GMAIL_SEND_EMAIL'||inspection.account_required!==true||!hash(inspection.schema_digest))throw Error('This Gmail connection can’t send email. Ask the Pip to connect Gmail again.');
 return accountChoices(server,discovery,{...inspection,tools:[{tool:'GMAIL_FETCH_EMAILS',schema_digest:inspection.schema_digest,account_required:true}]}).filter(a=>a.toolkit==='gmail');
}
export function calendarAccounts(server,discovery,inspection){
 if(!inspection||inspection.tool!=='GOOGLECALENDAR_CREATE_EVENT'||inspection.account_required!==true||!hash(inspection.schema_digest))throw Error('This calendar connection can’t add events. Ask the Pip to connect Google Calendar again.');
 return accountChoices(server,discovery,{...inspection,tools:[{tool:'GOOGLECALENDAR_FIND_EVENT',schema_digest:inspection.schema_digest,account_required:true}]}).filter(a=>a.toolkit==='googlecalendar');
}
export const extendedCalendar=event=>obj(event)&&['attendees','repeat','send_invitations'].some(k=>Object.hasOwn(event,k));
const canonical=value=>Array.isArray(value)?value.map(canonical):obj(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function calendarDetails(event){
 calendarDraft(event);
 const r=event.repeat,unit=r?({daily:'day',weekly:'week',monthly:'month'})[r.frequency]:'';
 return {guests:(event.attendees||[]).join(', ')||'No guests',repeat:r?`${r.count} occurrences, every ${r.interval} ${unit}${r.interval===1?'':'s'}, including the first`:'Does not repeat',notifications:event.send_invitations?'Send invitations to all listed guests. Delivery and acceptance are not confirmed.':'No guest invitations',confirm:event.send_invitations?(r?'Create series and invite once':'Create and invite once'):(r?'Create series once':'Create once')};
}
export function calendarDraft(event){
 const base=['summary','description','start_datetime','end_datetime','timezone'];
 if(extendedCalendar(event)){
  if(!exact(event,[...base,'attendees','repeat','send_invitations'])||!Array.isArray(event.attendees)||event.attendees.length>10||typeof event.send_invitations!=='boolean'||event.send_invitations!==Boolean(event.attendees.length))throw Error('Review up to ten guest emails and explicitly enable invitations when guests are present.');
  const seen=new Set();for(const email of event.attendees){messageDraft({recipient_email:email,subject:'Invitation',body:'Reviewed event'});if(seen.has(email.toLowerCase()))throw Error('Guest emails must be unique.');seen.add(email.toLowerCase());}
  const r=event.repeat;if(r!==null&&(!exact(r,['frequency','interval','count'])||!['daily','weekly','monthly'].includes(r.frequency)||!Number.isInteger(r.interval)||r.interval<1||r.interval>12||!Number.isInteger(r.count)||r.count<2||r.count>52))throw Error('Choose a daily, weekly or monthly repeat, every 1–12 periods, for 2–52 occurrences.');
 }

 if(!exact(event,extendedCalendar(event)?[...base,'attendees','repeat','send_invitations']:base)||!text(event.summary,200)||!(event.description===''||text(event.description,8000,true))||!text(event.timezone,80))throw Error('Review a title, description, exact start/end and named time zone.');
 const format=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
 if(!format.test(event.start_datetime)||!format.test(event.end_datetime))throw Error('Use date-times with seconds and an explicit UTC offset, such as 2026-12-01T11:00:00+05:30.');
 const duration=Date.parse(event.end_datetime)-Date.parse(event.start_datetime);
 if(!Number.isFinite(duration)||duration<=0||duration>7*86400000)throw Error('End must be after start, within seven days.');
 try{new Intl.DateTimeFormat('en',{timeZone:event.timezone}).format();}catch{throw Error('Enter a valid IANA time zone, such as Asia/Kolkata.');}
 return event;
}
export function messageDraft(message){
 if(!exact(message,['recipient_email','subject','body'])||!text(message.recipient_email,254)||!text(message.subject,200)||!text(message.body,12000,true)||! /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(message.recipient_email))throw Error('Use one email address, a short subject and a plain-text message. BCC and attachments aren’t supported.');
 return message;
}
export function messageReview(value,pip,workspace,expected=null){
 const p=value?.payload,s=p?.source,calendar=p?.kind==='calendar_create',connector=p?.kind==='connector_call';
 if(!obj(value)||!id(value.id,'appaction')||value.pip_id!==pip||value.workspace_id!==workspace||!Object.hasOwn(messageStates,value.status)||!hash(value.digest)||!Number.isFinite(Date.parse(value.expires_at))||!exact(p,['schema_version','kind','source','server','connection_digest','account','schema_digest',connector?'call':calendar?'event':'message'])||p.schema_version!==(connector?3:calendar?(extendedCalendar(p.event)?4:2):1)||!['gmail_send','calendar_create','connector_call'].includes(p.kind)||!exact(s,['run_id','pip_id','workspace_id','job_version','lifecycle_revision','result_digest'])||s.pip_id!==pip||s.workspace_id!==workspace||s.run_id!==value.source_run_id||!id(s.run_id,'run')||!Number.isSafeInteger(s.job_version)||s.job_version<1||!Number.isSafeInteger(s.lifecycle_revision)||s.lifecycle_revision<0||!hash(s.result_digest)||!hash(p.connection_digest)||!hash(p.schema_digest)||!(/^[A-Za-z0-9_.-]{1,80}$/.test(p.server)||connector&&/^app:[a-z0-9-]{1,40}$/.test(p.server))||(connector?p.account!=='connection_managed':! /^(?:ca|coup)_[A-Za-z0-9_-]{1,120}$/.test(p.account)))throw Error('This email changed. Refresh to see the latest.');
 if(connector)connectorCall(p.call);else if(calendar)calendarDraft(p.event);else messageDraft(p.message);
 if(expected){for(const k of ['server','connection_digest',...(connector?[]:['account']),'schema_digest'])if(p[k]!==expected[k])throw Error('The saved connection differs from the prepared review.');if(s.run_id!==expected.source_run_id||(connector?JSON.stringify(p.call)!==JSON.stringify(expected.call):calendar?JSON.stringify(canonical(p.event))!==JSON.stringify(canonical(expected.event)):['recipient_email','subject','body'].some(k=>p.message[k]!==expected.message[k])))throw Error('The saved message differs from the prepared review.');}
 if(!calendar&&!connector&&value.status==='succeeded'&&(!exact(value.receipt,['provider','message_id','meaning'])||value.receipt.provider!=='Gmail'||! /^[A-Za-z0-9_-]{1,200}$/.test(value.receipt.message_id)||value.receipt.meaning!=='Provider accepted the message; delivery to the recipient is not confirmed.'))throw Error('Gmail acceptance receipt is missing. Refresh the saved review.');
 if(calendar&&value.status==='succeeded'&&(!exact(value.receipt,['provider','event_id','meaning'])||value.receipt.provider!=='Google Calendar'||! /^[a-v0-9]{5,1024}$/.test(value.receipt.event_id)||value.receipt.meaning!=='Provider confirmed creation of this calendar event.'))throw Error('The confirmed calendar receipt is missing. Refresh the saved review.');
 if(connector&&value.status==='succeeded'){
  const receipt=value.receipt;
  if(!exact(receipt,['provider','tool','response_digest','response_preview','meaning'])||receipt.provider!==(({zapier:'Zapier',arcade:'Arcade',make:'Make',n8n:'n8n'})[p.server]||p.server)||receipt.tool!==p.call.tool||!hash(receipt.response_digest)||typeof receipt.response_preview!=='string'||new TextEncoder().encode(receipt.response_preview).length>1024||receipt.meaning!==(/^app:/.test(p.server)?'The app answered that it did this.':'The connector returned a response. This does not confirm downstream completion.'))throw Error('The connector response receipt is invalid.');
 }
 return value;
}
export function messageHistory(value,pip){
 if(!obj(value)||!Array.isArray(value.actions)||value.actions.length>20||!(value.next_cursor===null||id(value.next_cursor,'appaction')))throw Error('The message-review history is invalid.');
 const seen=new Set();for(const a of value.actions){if(!obj(a)||!id(a.id,'appaction')||seen.has(a.id)||a.pip_id!==pip||!hash(a.digest)||!Object.hasOwn(messageStates,a.status)||!text(a.subject,200)||!text(a.recipient,254))throw Error('A message review does not match this Pip.');seen.add(a.id);}
 return value;
}

export function emailDraft(value,pip,workspace,calendar=false){
 const p=value?.payload,s=p?.source;
 if(!obj(value)||!id(value.id,calendar?'caldraft':'maildraft')||value.pip_id!==pip||value.workspace_id!==workspace||!hash(value.digest)||!['pending','prepared','dismissed'].includes(value.status)||typeof value.expired!=='boolean'||!Number.isFinite(Date.parse(value.expires_at))||!exact(p,['schema_version','source',calendar?'event':'message'])||p.schema_version!==1||!obj(s)||s.pip_id!==pip||s.workspace_id!==workspace||s.run_id!==value.source_run_id||!id(s.run_id,'run')||!hash(s.result_digest)||(value.status==='prepared'&&!id(value.action_id,'appaction')))throw Error('This draft does not match the selected Pip.');
 if(calendar)calendarDraft(p.event);else messageDraft(p.message);return value;
}
export function emailDraftsPage(value,pip,workspace,calendar=false){
 if(!obj(value)||!Array.isArray(value.drafts)||value.drafts.length>20||!(value.next_cursor===null||id(value.next_cursor,calendar?'caldraft':'maildraft')))throw Error('The draft history is invalid.');
 const seen=new Set();for(const d of value.drafts){if(!obj(d)||!id(d.id,calendar?'caldraft':'maildraft')||seen.has(d.id)||d.pip_id!==pip||d.workspace_id!==workspace||!['pending','prepared','dismissed'].includes(d.status)||typeof d.expired!=='boolean'||!text(d.subject,200)||!hash(d.digest))throw Error('The draft list does not match this Pip.');seen.add(d.id);}return value;
}

export function connectorCall(value){
 if(!exact(value,['tool','arguments'])||typeof value.tool!=='string'||!/^[A-Za-z0-9_.:/-]{1,160}$/.test(value.tool)||!obj(value.arguments)||new TextEncoder().encode(JSON.stringify(value)).length>10000)throw Error('Review one tool and its JSON input object, up to 10,000 bytes.');return value;
}
export function connectorInspection(value,server){
 if(!obj(value)||value.server!==server||!['zapier','arcade','make','n8n'].includes(server)||!hash(value.connection_digest)||value.account_binding!=='connection_managed'||!Array.isArray(value.tools)||value.tools.length>100)throw Error('The connector tool list is invalid.');
 const seen=new Set();for(const row of value.tools){connectorCall({tool:row?.tool,arguments:{}});if(seen.has(row.tool)||!hash(row.schema_digest)||typeof row.description!=='string'||!obj(row.input_schema)||row.input_schema.type!=='object')throw Error('The connector descriptor is invalid.');seen.add(row.tool);}return value;
}
export function actionStatus(action){return action.kind==='connector_call'||action.payload?.kind==='connector_call'?({succeeded:'Response received',dispatching:'Outcome unconfirmed',unknown:'Outcome unconfirmed'}[action.status]||messageStates[action.status]):messageStates[action.status];}

export function connectorDraft(value,pip,workspace){
 const p=value?.payload,s=p?.source,a=p?.action;
 if(!obj(value)||!id(value.id,'conndraft')||value.pip_id!==pip||value.workspace_id!==workspace||!hash(value.digest)||!['pending','prepared','dismissed'].includes(value.status)||typeof value.expired!=='boolean'||!Number.isFinite(Date.parse(value.expires_at))||!exact(p,['schema_version','source','action'])||p.schema_version!==1||!obj(s)||s.pip_id!==pip||s.workspace_id!==workspace||s.run_id!==value.source_run_id||!id(s.run_id,'run')||!hash(s.result_digest)||(value.status==='prepared'&&!id(value.action_id,'appaction'))||!exact(a,['server','connection_digest','schema_digest','call'])||!(/^[A-Za-z0-9_.-]{1,80}$/.test(a.server)||/^app:[a-z0-9-]{1,40}$/.test(a.server))||!hash(a.connection_digest)||!hash(a.schema_digest))throw Error('This connector draft does not match the selected Pip.');
 connectorCall(a.call);return value;
}
export function connectorDraftsPage(value,pip){
 if(!obj(value)||!Array.isArray(value.drafts)||value.drafts.length>20||!(value.next_cursor===null||id(value.next_cursor,'conndraft')))throw Error('The connector draft history is invalid.');
 const seen=new Set();for(const d of value.drafts){if(!obj(d)||!id(d.id,'conndraft')||seen.has(d.id)||d.pip_id!==pip||!['pending','prepared','dismissed'].includes(d.status)||typeof d.expired!=='boolean'||!text(d.subject,200)||!hash(d.digest))throw Error('The connector draft list does not match this Pip.');seen.add(d.id);}return value;
}
