// Controller responses are data, never provider plans or tool instructions.
const digest = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const accountId = value => typeof value==='string' && /^(?:ca|coup)_[A-Za-z0-9_-]{1,120}$/.test(value);
export const appLabels={gmail:'Gmail',googlecalendar:'Google Calendar',googledrive:'Google Drive',notion:'Notion',googlecontacts:'Google Contacts'};
const toolkits={gmail:'GMAIL_FETCH_EMAILS',googlecalendar:'GOOGLECALENDAR_FIND_EVENT',googledrive:'GOOGLEDRIVE_FIND_FILE',notion:'NOTION_SEARCH_NOTION_PAGE',googlecontacts:'GOOGLECONTACTS_SEARCH_CONTACTS'};
const driveFields='files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken,incompleteSearch';
const READ_WORDS={GMAIL_FETCH_EMAILS:'Gmail: emails',GOOGLECALENDAR_FIND_EVENT:'Google Calendar: events',GOOGLEDRIVE_FIND_FILE:'Google Drive: files',
 NOTION_SEARCH_NOTION_PAGE:'Notion: pages',GOOGLECONTACTS_SEARCH_CONTACTS:'Google Contacts: contacts'};
/** An app-read plan in words, one line per read: "Gmail: emails matching “is:unread”, up to 5". */
export function appReadWords(plan){
 if(!plan||typeof plan!=='object'||!Array.isArray(plan.calls))return [];
 return plan.calls.map(c=>{const a=c?.arguments||{},q=[a.query,a.q,a.search_term].find(v=>typeof v==='string'&&v);
  return `${READ_WORDS[c?.tool]||String(c?.tool||'An app').toLowerCase().replace(/_/g,' ')}${q?` matching “${q}”`:''}${Number.isInteger(a.max_results)?`, up to ${a.max_results}`:''}${c?.window?.days?`, the next ${c.window.days} ${c.window.days===1?'day':'days'}`:''}`;});
}
export const extraReadTools=['GOOGLEDRIVE_FIND_FILE','NOTION_SEARCH_NOTION_PAGE','GOOGLECONTACTS_SEARCH_CONTACTS'];
export const appReadNotices={googledrive:'Search names in My Drive. Only file names, IDs, types, edit dates and links reach the model. No contents or shared drives.',notion:'Search page titles. Only titles, IDs, edit dates and links reach the model. No page bodies; recently shared pages may not be indexed yet.',googlecontacts:'Search saved contacts. Only names, IDs and email addresses reach the model. No phone numbers or addresses.'};
export function extraReadArguments(tool,query,limit){
 if(tool==='GOOGLEDRIVE_FIND_FILE')return {q:query,pageSize:limit,fields:driveFields,spaces:'drive',corpora:'user',supportsAllDrives:false,includeItemsFromAllDrives:false};
 if(tool==='NOTION_SEARCH_NOTION_PAGE')return {query,page_size:limit,filter_value:'page',filter_property:'object'};
 if(tool==='GOOGLECONTACTS_SEARCH_CONTACTS')return {query,page_size:limit,sources:['CONTACT'],read_mask:'names,emailAddresses'};
 throw Error('Unsupported app search.');
}
export function validateExtraRead(tool,args){
 const query=args?.[tool==='GOOGLEDRIVE_FIND_FILE'?'q':'query'],limit=args?.[tool==='GOOGLEDRIVE_FIND_FILE'?'pageSize':'page_size'];
 if(typeof query!=='string'||!query||query!==query.trim()||new TextEncoder().encode(query).length>1024||/\p{C}/u.test(query)||!Number.isInteger(limit)||limit<1||limit>20)throw Error('Enter a search query and a limit of 1–20 items.');
 const expected=extraReadArguments(tool,query,limit);
 if(Object.keys(args).sort().join()!==Object.keys(expected).sort().join()||Object.keys(expected).some(k=>JSON.stringify(args[k])!==JSON.stringify(expected[k])))throw Error('This app search includes unsupported fields.');
 return args;
}
export function combineReadPlans(existing,next){
 if(!existing||existing.server!==next.server||existing.connection_digest!==next.connection_digest)throw Error('Adding a read requires the same unchanged connection. Choose replace instead.');
 if(!Array.isArray(existing.calls)||!Array.isArray(next.calls)||existing.calls.length+next.calls.length>4)throw Error('A Pip can have at most four reviewed reads.');
 return {...next,schema_version:Math.max(existing.schema_version,next.schema_version),calls:[...existing.calls,...next.calls]};
}
export function accountChoices(server, discovery, inspection){
 if(!discovery||!inspection||discovery.server!==server||inspection.server!==server||!digest(discovery.connection_digest)||discovery.connection_digest!==inspection.connection_digest||!Array.isArray(discovery.accounts)||discovery.accounts.length>64||!Array.isArray(inspection.tools)||inspection.tools.length>8)throw Error('The account list and connection inspection no longer match. Refresh account selection.');
 const seen=new Set();return discovery.accounts.map(a=>{if(!a||!Object.hasOwn(toolkits,a.toolkit)||!accountId(a.id)||typeof a.label!=='string'||!a.label.trim()||a.label.length>160||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(a.label))throw Error('The connection returned an invalid account identity.');const key=a.toolkit+':'+a.id;if(seen.has(key))throw Error('The connection returned duplicate accounts.');seen.add(key);const tool=inspection.tools.find(t=>t.tool===toolkits[a.toolkit]);if(!tool||tool.account_required!==true||!digest(tool.schema_digest))return null;return {id:a.id,label:a.label,toolkit:a.toolkit,tool:tool.tool,schema_digest:tool.schema_digest};}).filter(Boolean);
}
export function accountReadPlan(server, fingerprint, choices, selection, draft){
 if(!/^[A-Za-z0-9_.-]{1,80}$/.test(server)||!digest(fingerprint)||typeof selection!=='string'||!/^\d{1,2}$/.test(selection)||!choices[Number(selection)])throw Error('Choose a connected account. Nothing is selected automatically.');
 const choice=choices[Number(selection)],count=Number(draft.limit);if(!Number.isInteger(count)||count<1||count>20)throw Error('Choose a read limit between 1 and 20 items.');
 const query=String(draft.query||'').trim();if(query.length>1024)throw Error('Keep the search query to 1,024 characters.');
 let window;let args={max_results:count,...(query?{query}:{})};
 if(choice.toolkit==='gmail')args={...args,user_id:'me',include_payload:false};
 else if(extraReadTools.includes(choice.tool)){
  // The UI accepts a file-name fragment, never an implicit all-files query.
  if(!query)throw Error('Enter the name or title to search for.');
  const search=choice.toolkit==='googledrive'?"trashed = false and name contains '"+query.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'":query;
  args=validateExtraRead(choice.tool,extraReadArguments(choice.tool,search,count));
 }else if(draft.windowMode==='calendar_days'){
  const start=Number(draft.startDay),days=Number(draft.days);
  if(String(draft.startDay??'').trim()===''||String(draft.days??'').trim()===''||!Number.isInteger(start)||start<0||start>30||!Number.isInteger(days)||days<1||days>31||typeof draft.timezone!=='string'||draft.timezone.length>100)throw Error('Choose a timezone, start day 0–30 and length 1–31 days.');
  try{new Intl.DateTimeFormat('en',{timeZone:draft.timezone});}catch{throw Error('Choose a valid IANA timezone.');}
  window={kind:'calendar_days',timezone:draft.timezone,start_day:start,days};args={...args,calendar_id:'primary',single_events:true};
 }else{const start=Date.parse(draft.start),end=Date.parse(draft.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('Choose an explicit calendar start and end, with the end after the start.');args={...args,calendar_id:'primary',time_min:new Date(start).toISOString(),time_max:new Date(end).toISOString(),single_events:true};}
 return {schema_version:extraReadTools.includes(choice.tool)?3:window?2:1,server,connection_digest:fingerprint,calls:[{tool:choice.tool,schema_digest:choice.schema_digest,account:choice.id,arguments:args,...(window?{window}:{})}]};
}
