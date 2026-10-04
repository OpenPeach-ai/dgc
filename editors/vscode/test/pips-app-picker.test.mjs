import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountChoices,accountReadPlan} from '../src/pipsAppPicker.js';
const fingerprint='a'.repeat(64),schema='b'.repeat(64);
const discovery={server:'composio',connection_digest:fingerprint,accounts:[{id:'ca_work',label:'Work <not HTML>',toolkit:'gmail'},{id:'ca_home',label:'Home',toolkit:'googlecalendar'}]};
const inspection={server:'composio',connection_digest:fingerprint,tools:[{tool:'GMAIL_FETCH_EMAILS',schema_digest:schema,account_required:true},{tool:'GOOGLECALENDAR_FIND_EVENT',schema_digest:schema,account_required:true}]};
const choices=()=>accountChoices('composio',structuredClone(discovery),structuredClone(inspection));
test('keeps both accounts with exact stable IDs; no default selection',()=>{assert.equal(choices().length,2);for(const value of ['',null,'default','-1','10','0junk'])assert.throws(()=>accountReadPlan('composio',fingerprint,choices(),value,{limit:5}),/Choose/);});
test('pins exact Gmail read without inherited capabilities',()=>{assert.deepEqual(accountReadPlan('composio',fingerprint,choices(),'0',{limit:'5',query:'is:unread'}),{schema_version:1,server:'composio',connection_digest:fingerprint,calls:[{tool:'GMAIL_FETCH_EMAILS',schema_digest:schema,account:'ca_work',arguments:{max_results:5,query:'is:unread',user_id:'me',include_payload:false}}]});});
test('requires exact reviewed calendar range',()=>{for(const draft of [{},{start:'tomorrow',end:'next week'},{start:'2026-10-05T12:00:00Z',end:'2026-10-05T11:00:00Z'}])assert.throws(()=>accountReadPlan('composio',fingerprint,choices(),'1',{limit:5,...draft}),/calendar/);const plan=accountReadPlan('composio',fingerprint,choices(),'1',{limit:10,start:'2026-10-05T12:00:00Z',end:'2026-10-05T13:00:00Z'});assert.equal(plan.calls[0].arguments.time_min,'2026-10-05T12:00:00.000Z');assert.equal(plan.calls[0].account,'ca_home');});
test('changed connection, duplicate IDs, invalid labels and unbound routes fail closed',()=>{for(const change of [d=>d.connection_digest='c'.repeat(64),d=>d.accounts.push(d.accounts[0]),d=>d.accounts[0].id='default',d=>d.accounts[0].label='work\u202eexe',d=>d.accounts[0].toolkit='__proto__']){const d=structuredClone(discovery);change(d);assert.throws(()=>accountChoices('composio',d,inspection));}const i=structuredClone(inspection);i.tools.forEach(t=>t.account_required=false);assert.deepEqual(accountChoices('composio',discovery,i),[]);});
test('limits stay explicit and bounded',()=>{for(const limit of [0,21,1.5,'NaN',undefined])assert.throws(()=>accountReadPlan('composio',fingerprint,choices(),'0',{limit}),/limit/);assert.throws(()=>accountReadPlan('composio',fingerprint,choices(),'0',{limit:5,query:'x'.repeat(1025)}),/query/);});
test('recurring calendar plan pins timezone and relative days without concrete date overrides',()=>{const plan=accountReadPlan('composio',fingerprint,choices(),'1',{limit:5,windowMode:'calendar_days',timezone:'Asia/Kolkata',startDay:'0',days:'7'});assert.equal(plan.schema_version,2);assert.deepEqual(plan.calls[0].window,{kind:'calendar_days',timezone:'Asia/Kolkata',start_day:0,days:7});assert.equal(plan.calls[0].account,'ca_home');assert.equal(plan.calls[0].arguments.time_min,undefined);for(const extra of [{timezone:'Missing/Zone'},{days:32},{startDay:-1}])assert.throws(()=>accountReadPlan('composio',fingerprint,choices(),'1',{limit:5,windowMode:'calendar_days',timezone:'UTC',startDay:0,days:1,...extra}));});

const extra=await import('../src/pipsAppPicker.js');
const {appReadPlan}=await import('../src/pipsModel.js');
function additionalChoices(){return ['googledrive','notion','googlecontacts'].map((toolkit,i)=>({toolkit,tool:extra.extraReadTools[i],id:'ca_'+toolkit,schema_digest:schema}));}
test('additional apps require query and exact account, with fixed data minimization fields',()=>{
 for(let i=0;i<3;i++){
  const c=additionalChoices();assert.throws(()=>accountReadPlan('composio',fingerprint,c,String(i),{limit:5,query:''}));
  const plan=accountReadPlan('composio',fingerprint,c,String(i),{limit:5,query:'Reading'});assert.equal(plan.schema_version,3);assert.equal(plan.calls[0].account,c[i].id);assert.equal(appReadPlan(plan),plan);
  const bad=structuredClone(plan);bad.calls[0].arguments.download=true;assert.throws(()=>appReadPlan(bad));
  const old=structuredClone(plan);old.schema_version=2;assert.throws(()=>appReadPlan(old));
  const missing=structuredClone(plan);delete missing.calls[0].account;assert.throws(()=>appReadPlan(missing));
 }
});
test('file-name fragments escape quotes and backslashes instead of expanding the Drive query',()=>{
 const plan=accountReadPlan('composio',fingerprint,additionalChoices(),'0',{limit:5,query:"O'Brien\\Plans"});
 assert.equal(plan.calls[0].arguments.q,"trashed = false and name contains 'O\\'Brien\\\\Plans'");
 assert.equal(plan.calls[0].arguments.corpora,'user');assert.equal(plan.calls[0].arguments.includeItemsFromAllDrives,false);
});
test('combining app reads preserves prior account scopes and calendar windows; rejects changed connection or fifth read',()=>{
 const calendar=accountReadPlan('composio',fingerprint,choices(),'1',{limit:5,windowMode:'calendar_days',timezone:'UTC',startDay:0,days:1});
 const drive=accountReadPlan('composio',fingerprint,additionalChoices(),'0',{limit:5,query:'Budget'});
 const mixed=extra.combineReadPlans(calendar,drive);assert.equal(mixed.schema_version,3);assert.equal(appReadPlan(mixed),mixed);assert.deepEqual(mixed.calls[0],calendar.calls[0]);assert.equal(calendar.calls.length,1);
 assert.throws(()=>extra.combineReadPlans({...calendar,connection_digest:'c'.repeat(64)},drive));
 assert.throws(()=>extra.combineReadPlans({...calendar,calls:Array(4).fill(calendar.calls[0])},drive));
});
test('discovery displays five app types without treating new services as Calendar',()=>{
 const more=additionalChoices();const ds={...discovery,accounts:[...discovery.accounts,...more.map(c=>({id:c.id,label:'Personal',toolkit:c.toolkit}))]};
 const ins={...inspection,tools:[...inspection.tools,...more.map(c=>({tool:c.tool,schema_digest:schema,account_required:true}))]};
 assert.equal(accountChoices('composio',ds,ins).length,5);assert.equal(extra.appLabels.notion,'Notion');
});
