import {extraReadTools,validateExtraRead} from './pipsAppPicker.js';
// Pure presentation boundaries shared by the editor and deterministic tests.
export const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const active = status => ['queued','running','cancelling'].includes(status);
export const statusLabel = status => ({queued:'Waiting to start',running:'Auditing source',cancelling:'Cancelling',cancelled:'Cancelled',failed:'Failed',succeeded:'Report ready',active:'Ready',paused:'Paused'}[status] || 'Status unknown');
/** A Personal Pip's run, in its words: it works and is done; it does not audit or report. */
export const personalStatusLabel = status => ({queued:'Waiting to start',running:'Working',cancelling:'Stopping',cancelled:'Stopped',failed:'Failed',succeeded:'Done',active:'Ready',paused:'Paused'}[status] || 'Status unknown');
/** How a command, test or run ended, in words, never the stored enum ("timed_out"). */
export const outcomeWords = value => ({passed:'Passed',failed:'Failed',completed:'Done',complete:'Every command finished',succeeded:'Done',exited:'Finished',timed_out:'Stopped: took too long',output_limit:'Stopped: too much output',resource_limit:'Stopped: hit a memory or process limit',cancelled:'Cancelled',interrupted:'Interrupted',failed_to_start:'Didn’t start',unfinalized:'No result saved',stale_grant:'Stopped: its approval changed',infrastructure_failure:'Stopped: DGC couldn’t run it'}[value] || String(value ?? '').replaceAll('_',' '));
/** A review's state in words (handoffs, statements, waiting changes). */
export const reviewStatusWords = value => ({pending:'Waiting for you',accepted:'Accepted',approved:'Approved',rejected:'Rejected',expired:'Expired',superseded:'Set aside'}[value] || String(value ?? ''));
/** An exact argument list as one readable command line: an argument with spaces or quotes is shell-quoted, so nothing is ambiguous. */
export const commandLine = argv => argv.map(a => /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`).join(' ');
export const errorText = value => typeof value === 'string' ? value : record(value) && typeof value.message === 'string' ? value.message : 'Something went wrong. Refresh and try again.';
// Only expose recorded, allowlisted metrics. Missing legacy fields are unknown, not zero.
export const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Not recorded';
export function duration(start, end) {
  const a = typeof start === 'string' ? Date.parse(start) : NaN;
  const b = typeof end === 'string' ? Date.parse(end) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 'Not recorded';
  const seconds = (b - a) / 1000;
  return seconds < 60 ? `${Number(seconds.toFixed(2))} s` : `${Math.floor(seconds / 60)} min ${Number((seconds % 60).toFixed(1))} s`;
}
export function execution(run) {
  const m = record(run?.manifest) ? run.manifest : {};
  const r = record(run?.result) ? run.result : {};
  const usage = record(r.usage) ? r.usage : {};
  const limits = record(m.limits) ? m.limits : {};
  const text = value => typeof value === 'string' && value.length > 0 ? value : 'Not recorded';
  return {
    model: text(m.model), runner: text(m.runner_id), policy: text(m.policy),
    policyDigest: text(m.policy_digest),
    tools: Array.isArray(m.tools) && m.tools.length <= 128 && m.tools.every(t => typeof t === 'string') ? m.tools : null,
    calls: count(r.tools_called),
    usage: [['Input tokens','input_tokens'],['Output tokens','output_tokens'],['Cached input','cached_input_tokens'],['Reasoning tokens','reasoning_tokens'],['Model requests','requests']].map(([label,key]) => [label,count(usage[key])]),
    // 0 is none: a Pip run keeps going (2026-10-14), a reviewed specialist patch run too (a saved version-1 one has bounds).
    limits: [['Time limit','wall_seconds'],['Tool-call limit','tool_calls'],['Step limit','iterations'],['Code size limit (bytes)','snapshot_bytes']].map(([label,key]) => [label,key !== 'snapshot_bytes' && limits[key] === 0 ? 'None' : count(limits[key]) + (key === 'wall_seconds' && Number.isSafeInteger(limits[key]) && limits[key] >= 0 ? ' s' : '')]),
    queueDuration: duration(run?.created_at, run?.started_at),
    duration: duration(run?.started_at, run?.finished_at),
  };
}
export function activityPage(value, run, after) {
  if (!record(value) || value.run_id !== run.id || value.pip_id !== run.pip_id || value.workspace_id !== run.workspace_id || !Array.isArray(value.events) || value.events.length > 50 || !Number.isSafeInteger(value.next_cursor) || value.next_cursor < after || typeof value.has_more !== 'boolean' || typeof value.history_may_be_truncated !== 'boolean' || !Number.isSafeInteger(value.retention_limit) || value.retention_limit < 0 || value.retention_scope !== 'workspace') throw new Error('Run activity is invalid or belongs to another workspace.');
  let cursor=after;
  for (const event of value.events) {
    if (!record(event) || event.run_id !== run.id || event.pip_id !== run.pip_id || event.workspace_id !== run.workspace_id || !Number.isSafeInteger(event.seq) || event.seq <= cursor || typeof event.event_type !== 'string' || !record(event.payload) || typeof event.created_at !== 'string') throw new Error('Run activity contains an invalid event.');
    cursor=event.seq;
  }
  if (cursor !== value.next_cursor || (value.has_more && !value.events.length)) throw new Error('Run activity returned an invalid cursor.');
  return value;
}
export function activityLabel(event) {
  const p=event.payload;
  if (event.event_type === 'pip_run_progress') {
    const tool=typeof p.tool === 'string' ? p.tool : 'Tool';
    if (p.kind === 'tool_call') return `${tool} · started`;
    if (p.kind === 'tool_result') return `${tool} · ${p.status === 'completed' ? 'completed' : p.status === 'failed' ? 'failed' : 'finished'}`;
    if (p.kind === 'tool_denied') return `${tool} · not allowed`;
    if (p.kind === 'error') return 'Something went wrong';
    return typeof p.message === 'string' ? p.message : 'Working';
  }
  return {pip_run_queued:'Waiting to start',pip_run_started:'Started',pip_run_snapshot:'Getting ready',pip_run_succeeded:'Report ready',pip_run_failed:'Run failed',pip_run_cancelled:'Run cancelled',pip_run_cancelling:'Stopping',workspace_session_turn_completed:'A DGC chat turn was saved',workspace_committed_paths_changed:'Watched paths changed in a commit'}[event.event_type] || 'Step';
}
export function report(value) {
  if (!record(value) || typeof value.summary !== 'string' || value.tests_executed !== false || typeof value.verification !== 'string' || !Array.isArray(value.findings) || value.findings.length > 16 || !Array.isArray(value.limitations) || value.limitations.length > 12 || !value.limitations.every(v => typeof v === 'string')) return null;
  if (!value.findings.every(f => record(f) && typeof f.title === 'string' && typeof f.path === 'string' && typeof f.evidence === 'string' && Number.isInteger(f.line) && f.line > 0 && ['low','medium','high','critical'].includes(f.severity) && f.verification === 'source_excerpt_only')) return null;
  return value;
}
export function runner(value) {
  if (!record(value) || !['running','stopping','stopped','offline'].includes(value.status) || typeof value.online !== 'boolean' || typeof value.paused !== 'boolean' || !record(value.counts) || !['queued','running','cancelling'].every(k => Number.isInteger(value.counts[k]) && value.counts[k] >= 0)) throw new Error('Can’t tell if Pips are running. Refresh to check again.');
  if (value.error != null && (!record(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string')) throw new Error('Runner returned an invalid error record.');
  return value;
}
export function context(value, workspace) {
  if (!record(value) || value.workspace_id !== workspace || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries) || value.entries.length > 32 || !value.entries.every(e => record(e) && typeof e.id === 'string' && typeof e.title === 'string' && typeof e.content === 'string' && typeof e.kind === 'string' && record(e.provenance))) throw new Error('Workspace context is unavailable or invalid.');
  for(const entry of value.entries){if(entry.provenance.source==='session_execution')commandOutcomeEntry(entry,workspace);if(entry.kind==='execution')executionContextEntry(entry);if(entry.kind==='session_outcome')sessionOutcomeEntry(entry,workspace);if(entry.kind==='finding'&&entry.provenance.schema_version!==undefined)findingContextEntry(entry);}
  return value;
}
export function scheduleLabel(value) {
  if (value == null) return 'Manual only';
  if (record(value) && value.type === 'interval' && Number.isInteger(value.minutes) && value.minutes >= 5 && value.minutes <= 10080) return `Every ${value.minutes} minutes`;
  if (record(value) && value.type === 'daily' && typeof value.time === 'string' && typeof value.timezone === 'string') return `Daily at ${value.time} · ${value.timezone}`;
  if(record(value)&&value.type==='once'&&typeof value.at==='string')return `Once at ${value.at}`;
  if(record(value)&&value.type==='cron'&&typeof value.cron==='string'&&typeof value.timezone==='string'){
    // The two shapes starters write, in words; anything else stays the exact expression.
    const m=/^(\d{1,2}) (\d{1,2}) \* \* (1-5|1)$/.exec(value.cron);
    if(m&&Number(m[1])<60&&Number(m[2])<24)return `${m[3]==='1-5'?'Weekdays':'Mondays'} at ${m[2].padStart(2,'0')}:${m[1].padStart(2,'0')} · ${value.timezone}`;
    return `Cron ${value.cron} · ${value.timezone}`;
  }
  return 'Schedule unavailable';
}
export function cronExpression(value) {
  const expression=String(value).trim().replace(/\s+/g,' '),fields=expression.split(' '),ranges=[[0,59],[0,23],[1,31],[1,12],[0,7]],expanded=[];
  if(expression.length>256||fields.length!==5)throw new Error('Use five numeric cron fields: minute hour day month weekday.');
  for(let i=0;i<5;i++){
    const values=new Set(),[min,max]=ranges[i];
    for(const part of fields[i].split(',')){
      const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);if(!match)throw new Error('Cron accepts numbers, *, comma lists, ascending ranges, and positive steps.');
      const step=match[2]?Number(match[2]):1,base=match[1];if(match[2]&&base!=='*'&&!base.includes('-'))throw new Error('Use */step or an explicit range/step; scalar steps are not supported.');let lo,hi;
      if(base==='*'){lo=min;hi=max;}else{const pair=base.split('-');lo=Number(pair[0]);hi=pair.length===2?Number(pair[1]):match[2]?max:lo;}
      if(!Number.isSafeInteger(step)||step<1||lo<min||hi>max||lo>hi)throw new Error('A cron value, range, or step is outside its allowed field.');
      for(let n=lo;n<=hi;n+=step)values.add(n);
    }
    expanded.push([...values].sort((a,b)=>a-b));
  }
  const times=expanded[1].flatMap(h=>expanded[0].map(m=>h*60+m)).sort((a,b)=>a-b);
  if(times.some((time,i)=>(i?time-times[i-1]:1440+time-times.at(-1))<5))throw new Error('Cron runs must be spaced at least five minutes apart.');
  return expression;
}
function scheduleZone(value){
  const timezone=String(value).trim();if(!timezone||timezone.length>100)throw new Error('Enter an IANA time zone, such as Europe/Paris.');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format(0);}catch{throw new Error('Enter a recognized IANA time zone, such as Europe/Paris.');}return timezone;
}
function onceInstant(value,now){
  const at=String(value).trim(),m=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(at);
  if(!m)throw new Error('Enter an ISO date and time including seconds, at most three fractional digits, and Z or an explicit offset, such as 2099-10-02T09:00:00+05:30.');
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  const parsed=Date.parse(at);if(year<1||month<1||month>12||day<1||day>days[month-1]||!Number.isFinite(parsed))throw new Error('Enter a valid calendar date and time.');
  if(parsed<=now)throw new Error('Choose a future time. It must still be in the future when you approve it.');return new Date(parsed).toISOString();
}

export function scheduleFromDraft(value,now=Date.now()) {
  if (value.scheduleType === 'manual') return null;
  if (value.scheduleType === 'interval') {
    const raw=String(value.scheduleMinutes).trim(),minutes=Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(minutes) || minutes < 5 || minutes > 10080) throw new Error('Use a whole interval from 5 to 10080 minutes.');
    return {type:'interval',minutes,missed_policy:'coalesce_latest'};
  }
  if (value.scheduleType === 'daily') {
    const time=String(value.scheduleTime).trim(),timezone=String(value.scheduleZone).trim();
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a daily time from 00:00 to 23:59.');
    if (!timezone || timezone.length > 100) throw new Error('Enter an IANA time zone, such as Europe/Paris.');
    try { new Intl.DateTimeFormat('en',{timeZone:timezone}).format(0); } catch { throw new Error('Enter a recognized IANA time zone, such as Europe/Paris.'); }
    return {type:'daily',time,timezone,missed_policy:'coalesce_latest',dst_policy:'skip_gap_first_fold'};
  }
  if(value.scheduleType==='once')return {type:'once',at:onceInstant(value.scheduleAt,now),missed_policy:'coalesce_latest'};
  if(value.scheduleType==='cron')return {type:'cron',cron:cronExpression(value.scheduleCron),timezone:scheduleZone(value.scheduleZone),missed_policy:'coalesce_latest',dst_policy:'skip_gap_first_fold'};
  throw new Error('Choose Manual, Interval, Daily, Once, or Cron.');
}
export const approvalStatus = value => ({pending:'Waiting for you',approved:'Accepted',rejected:'Turned down',expired:'Expired',superseded:'Set aside'}[value] || 'Unknown');
export function approvalsPage(value,pip) {
  if (!record(value) || !Array.isArray(value.approvals) || value.approvals.length > 20 || !(value.next_before_id === null || typeof value.next_before_id === 'string')) throw new Error('Review history is invalid.');
  const seen=new Set();
  for (const a of value.approvals) {
    if (!record(a) || a.pip_id !== pip || typeof a.id !== 'string' || !a.id || seen.has(a.id) || typeof a.proposal_id !== 'string' || !Number.isSafeInteger(a.expected_version) || (a.expected_version < 0 || a.expected_version===0&&!(a.status==='approved'&&a.requested_by==='core_setup'&&typeof a.resolved_by==='string'&&typeof a.resolved_at==='string')) || !['job_update','schedule_update'].includes(a.action_type) || typeof a.action_summary !== 'string' || approvalStatus(a.status) === 'Unknown' || typeof a.requested_by !== 'string' || typeof a.created_at !== 'string' || typeof a.expires_at !== 'string') throw new Error('Review history contains an invalid or unrelated record.');
    seen.add(a.id);
  }
  if (value.next_before_id !== null && value.next_before_id !== value.approvals.at(-1)?.id) throw new Error('Review history returned an invalid cursor.');
  return value;
}
const characterIds = ['core','scout','lens','patch','rook','pulse','lock','quill'];
export function pipTypes(value) {
  if (!record(value) || !Array.isArray(value.types) || value.types.length !== characterIds.length) throw new Error('Pip types are unavailable. Refresh before creating a Pip.');
  const seen = new Set();
  for (const t of value.types) {
    if (!record(t) || !characterIds.includes(t.id) || seen.has(t.id) || t.character_index !== characterIds.indexOf(t.id) || typeof t.available !== 'boolean' || !['name','role','description','default_name','default_goal'].every(k=>typeof t[k]==='string') || !(t.unavailable_reason===null || typeof t.unavailable_reason==='string') || !(t.engine===null || typeof t.engine==='string') || (t.available && (t.engine!==(t.id==='patch'?'patch':t.id==='pulse'?'test':t.id==='quill'?'documentation_draft':'source_audit') || !t.default_goal.trim())) || (!t.available && !t.unavailable_reason)) throw new Error('DGC sent a kind of Pip this editor doesn’t know. Update the DGC extension to create Pips.');
    seen.add(t.id);
  }
  return [...value.types].sort((a,b)=>a.character_index-b.character_index);
}
export function pipType(pip, types) {
  const id = pip && Object.hasOwn(pip,'pip_type') ? pip.pip_type : 'rook';
  return types.find(t=>t.id===id) || null;
}
export const pendingReviews = pip => Number.isSafeInteger(pip?.pending_review_count) && pip.pending_review_count >= 0 ? pip.pending_review_count : 0;
export function messagesPage(value,pip,workspace) {
  if(!record(value)||value.pip_id!==pip||value.workspace_id!==workspace||!Array.isArray(value.messages)||value.messages.length>50||!(value.next_before_id===null||typeof value.next_before_id==='string')||!Number.isSafeInteger(value.history_context_omitted_count)||value.history_context_omitted_count<0)throw new Error('Conversation response is invalid or belongs to another Pip.');
  const ids=new Set();
  for(const m of value.messages){if(!record(m)||m.pip_id!==pip||m.workspace_id!==workspace||typeof m.id!=='string'||!m.id||ids.has(m.id)||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||typeof m.run_id!=='string'||typeof m.model!=='string'||typeof m.created_at!=='string'||!['queued','running','cancelling','succeeded','failed','cancelled'].includes(m.status))throw new Error('Conversation contains an invalid or unrelated message.');ids.add(m.id);}
  // Choices a Pip offered under a reply: 2–4 short lines, never on the user's own message.
  // Why a turn failed, under the user's message (a newer DGC): one short line.
  for(const m of value.messages)if(m.error!==undefined&&(m.role!=='user'||m.status!=='failed'||typeof m.error!=='string'||!m.error||m.error.length>300))throw new Error('Conversation error text is invalid.');
  // The plugins a reply took an answer from ("Used Aave"): up to 8, each its id and a name of up to 80 characters (as
  // Python counts them), never on the user's message. A line under a reply never costs the chat: a bad one is dropped.
  for(const m of value.messages)if(m.plugins!==undefined){
    const ok=m.role==='assistant'&&Array.isArray(m.plugins)?m.plugins.filter(p=>record(p)&&typeof p.plugin==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.plugin)&&typeof p.name==='string'&&p.name&&[...p.name].length<=80).slice(0,8):[];
    if(ok.length)m.plugins=ok;else delete m.plugins;
  }
  for(const m of value.messages)if(m.choices!==undefined&&(m.role!=='assistant'||!Array.isArray(m.choices)||m.choices.length<2||m.choices.length>4||m.choices.some(c=>typeof c!=='string'||!c||c.length>80)))throw new Error('Conversation choices are invalid.');
  if(value.next_before_id!==null&&value.next_before_id!==value.messages[0]?.id)throw new Error('Conversation history cursor is invalid.');
  if(value.active_run!==null&&(!record(value.active_run)||typeof value.active_run.id!=='string'||!active(value.active_run.status)))throw new Error('Conversation active run is invalid.');
  return value;
}
export function chatContinuity(value,pip,workspace){
 if(value==null)return null;
 if(!record(value)||value.version!==1||value.pip_id!==pip||value.workspace_id!==workspace||!Number.isSafeInteger(value.checkpoint_id)||value.checkpoint_id<1||!Number.isSafeInteger(value.summarized_messages)||value.summarized_messages<0||value.summarized_messages%2||value.summarized_messages>20000||typeof value.summary!=='string'||new TextEncoder().encode(value.summary).length>8192||!['none','model','mechanical'].includes(value.strategy)||typeof value.notice!=='string'||typeof value.run_id!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||!record(value.provenance))throw Error('Conversation continuity is invalid or belongs to another Pip.');
 return value;
}
// API 55: a Personal Pip can run on the user's own Claude Code or Codex (pip_brain). `subscriptions` lists the ones
// signed in here; `default_engine` is the one "Same as DGC" follows when DGC's default is a subscription.
export const SUBSCRIPTION_NAMES={claude:'Claude Code',codex:'Codex'};
export function pipModels(value) {
  if(!record(value)||typeof value.default_model!=='string'||!Array.isArray(value.models)||value.models.length>500||!value.models.every(m=>record(m)&&typeof m.id==='string'&&m.id&&typeof m.name==='string')||new Set(value.models.map(m=>m.id)).size!==value.models.length)throw new Error('Models didn’t load. You can still use the same model as DGC.');
  const subscriptions=value.subscriptions===undefined?[]:value.subscriptions,engine=value.default_engine===undefined?null:value.default_engine;
  if(!Array.isArray(subscriptions)||subscriptions.length>8||!subscriptions.every(s=>record(s)&&Object.hasOwn(SUBSCRIPTION_NAMES,s.engine)&&typeof s.name==='string'&&s.name)
    ||engine!==null&&!(record(engine)&&typeof engine.engine==='string'&&typeof engine.name==='string'&&typeof engine.available==='boolean'&&(engine.reason===undefined||typeof engine.reason==='string')))throw new Error('Models didn’t load. You can still use the same model as DGC.');
  return {...value,subscriptions,default_engine:engine};
}
export function modelChoice(value,models,subscriptions=[]) {
  if(value==='default')return{mode:'default'};
  if(typeof value==='string'&&value.startsWith('subscription:')){
    const engine=value.slice(13);
    if(!subscriptions.some(s=>s.engine===engine))throw new Error('Choose Same as DGC or a model from the list.');
    return{mode:'subscription',engine};
  }
  const id=typeof value==='string'&&value.startsWith('model:')?value.slice(6):'';
  if(!id||!models.some(m=>m.id===id))throw new Error('Choose Same as DGC or a model from the list.');
  return{mode:'model',model:id};
}
export const modelValue=choice=>record(choice)&&choice.mode==='model'?'model:'+choice.model:record(choice)&&choice.mode==='subscription'?'subscription:'+choice.engine:'default';
export const modelLabel=value=>record(value)&&value.mode==='model'&&typeof value.model==='string'?value.model:record(value)&&value.mode==='subscription'&&Object.hasOwn(SUBSCRIPTION_NAMES,value.engine)?SUBSCRIPTION_NAMES[value.engine]:'Same as DGC';
// Said once, where a subscription is chosen for a Pip: its scheduled runs use the user's own plan.
export const subscriptionUsage=name=>`Its replies and routines use your ${name} plan’s usage.`;
export function presentation(pip, runs, connected, runnerState) {
  if (!connected) return {state:'offline',label:'Disconnected'};
  if (pip?.status === 'archived') return {state:'offline',label:'Archived'};
  const current = record(pip?.active_run) && active(pip.active_run.status) ? pip.active_run : runs.find(r => ['running','cancelling'].includes(r.status)) || runs.find(r => r.status === 'queued');
  const latest = record(pip?.latest_run) ? pip.latest_run : runs[0];
  const conversation=run=>run?.run_kind==='conversation'||run?.manifest?.run_kind==='conversation';
  const label=run=>run?.status==='running'&&run.execution_mode==='standalone_plan'?'Running approved commands':run?.status==='running'&&(run?.run_kind||run?.manifest?.run_kind)==='draft'?'Drafting documentation':conversation(run)&&run.status==='running'?'Replying':(run?.run_kind||run?.manifest?.run_kind)==='personal_task'?personalStatusLabel(run.status):['patch','test'].includes(run?.run_kind||run?.manifest?.run_kind)&&run.status==='running'?'Working on a handoff':statusLabel(run.status);
  if (!runnerState || !runnerState.online) return {state:'offline',label:`${runnerState?'Pips not running':'Can’t tell if Pips are running'}${current?` · last: ${label(current)}`:''}`};
  if (current) return {state: current.status === 'queued' ? 'idle' : 'working', label:label(current)};
  if (pendingReviews(pip)>0) return {state:'waiting_approval',label:'Waiting for you'};
  if (pip?.status === 'paused' || runnerState.paused) return {state:'idle',label:runnerState.paused?'Pips stopped':'Paused'};
  if (latest?.status === 'failed') return {state:'failure',label:'Last run failed'};
  if (latest?.status==='succeeded'&&latest.execution_mode==='standalone_plan'){const p=pulseProgress(latest);return {state:p?.failed?'failure':'idle',label:p?`${p.failed} failed · ${p.passed} passed`:'Commands finished · see results'};}
  if (latest?.status === 'succeeded') return {state:'success',label:conversation(latest)?'Reply ready':(latest?.run_kind||latest?.manifest?.run_kind)==='draft'?'Draft ready':['patch','test'].includes(latest?.run_kind||latest?.manifest?.run_kind)?'Results ready':'Report ready'};
  if (latest?.status === 'cancelled') return {state:'idle',label:'Last run cancelled'};
  return {state:'idle',label: pip ? 'Ready when you are' : 'Ready'};
}
export function requestBroker(send, namespace=globalThis.crypto.randomUUID()) {
  let sequence = 0;
  const pending = new Map();
  return {
    request(request) {
      if (pending.size >= 48) return Promise.reject(new Error('DGC is busy. Reconnect and try again.'));
      return new Promise((resolve,reject) => { const id = 'view-' + namespace + '-' + (++sequence); pending.set(id,{resolve,reject,at:Date.now()}); send({type:'pipsRequest',id,request}); });
    },
    receive(message) { const item=pending.get(message.id); if (!item) return; pending.delete(message.id); message.ok === true ? item.resolve(message.result) : item.reject(new Error(errorText(message.error))); },
    reset() { for(const item of pending.values()) item.reject(new Error('The connection to DGC changed. Refresh and try again.')); pending.clear(); },
    expire(now) { for(const [id,item] of pending) if(now-item.at > 60000) { pending.delete(id); item.reject(new Error('DGC didn’t answer in time. Refresh to see whether it worked before trying again.')); } }
  };
}

function checkpointMetadata(value,pip,workspace) {
 const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max,fail=()=>{throw new Error('Checkpoint metadata is invalid or belongs to another Pip.');};
 if(!record(value)||!integer(value.id,1)||value.pip_id!==pip||value.workspace_id!==workspace||typeof value.run_id!=='string'||!value.run_id||!integer(value.job_version,1,999999)||!['model','created_at','context_digest'].every(k=>typeof value[k]==='string')||!integer(value.context_revision)||!/^[a-f0-9]{64}$/.test(value.context_digest)||!(value.baseline_checkpoint_id===null||integer(value.baseline_checkpoint_id,1,value.id-1))||!record(value.counts)||Object.keys(value.counts).sort().join()!=='new,not_observed,repeated,total'||!integer(value.counts.total,0,16))fail();
 if(value.schema_version!==undefined){
  if(value.schema_version!==2||!record(value.source_policy)||!Object.hasOwn(value,'source_snapshot'))fail();sourcePin(value);
  const c=value.comparison;if(!record(c)||Object.keys(c).sort().join()!=='previous_checkpoint_id,reason,status'||!(c.previous_checkpoint_id===null||integer(c.previous_checkpoint_id,1,value.id-1)))fail();
  if(c.status==='unavailable'){
   if(value.baseline_checkpoint_id!==null||!['no_checkpoint','source_policy_changed'].includes(c.reason)||(c.reason==='no_checkpoint')!==(c.previous_checkpoint_id===null)||!['new','repeated','not_observed'].every(k=>value.counts[k]===null))fail();return value;
  }
  // A committed Pip's first report under safe_source_v2 is compared with nothing: everything is new, as in version 1.
  const first=c.previous_checkpoint_id===null&&value.baseline_checkpoint_id===null&&sourcePin(value).kind==='committed_only';
  if(c.status!=='compared'||c.reason!==null||c.previous_checkpoint_id===null&&!first||value.baseline_checkpoint_id!==c.previous_checkpoint_id)fail();
 }else if(typeof value.source_revision!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.source_revision)||Object.hasOwn(value,'source_snapshot')||Object.hasOwn(value,'source_policy')||Object.hasOwn(value,'comparison'))fail();
 if(!['new','repeated','not_observed'].every(k=>integer(value.counts[k],0,16))||value.counts.new+value.counts.repeated!==value.counts.total||value.baseline_checkpoint_id===null&&(value.counts.repeated!==0||value.counts.not_observed!==0))fail();
 return value;
}
export function runCheckpoint(value,identity){
  if(value==null)return null;
  checkpointMetadata(value,identity.pip_id,identity.workspace_id);
  if(value.run_id!==identity.id||!Array.isArray(value.findings)||value.findings.length!==value.counts.total)throw new Error('Checkpoint findings do not match this run.');
  const ids=new Set();
  for(let i=0;i<value.findings.length;i++){
    const f=value.findings[i],r=f?.review;
    if(!record(f)||f.finding_index!==i||typeof f.finding_id!=='string'||!f.finding_id||ids.has(f.finding_id)||typeof f.identity!=='string'||!/^[a-f0-9]{64}$/.test(f.identity)||!['title','path','evidence'].every(k=>typeof f[k]==='string')||!Number.isSafeInteger(f.line)||f.line<1||!['low','medium','high','critical'].includes(f.severity)||f.verification!=='source_excerpt_only'||!(value.comparison?.status==='unavailable'?['uncompared']:['new','repeated']).includes(f.comparison)||!record(r)||!['open','accepted','dismissed'].includes(r.status)||!Number.isSafeInteger(r.revision)||r.revision<0||r.revision>100||!['actor','reason','updated_at'].every(k=>r[k]===null||typeof r[k]==='string'))throw new Error('Checkpoint contains an invalid finding review.');
    ids.add(f.finding_id);
  }
  if(value.comparison?.status!=='unavailable'&&value.findings.filter(f=>f.comparison==='new').length!==value.counts.new)throw new Error('Checkpoint comparison counts do not match its findings.');
  return value;
}
export function checkpointsPage(value,pip,workspace){
  if(!record(value)||value.pip_id!==pip||value.workspace_id!==workspace||!Array.isArray(value.checkpoints)||value.checkpoints.length>20||typeof value.has_more!=='boolean'||value.retention_limit!==20000||!(value.next_before_id===null||Number.isSafeInteger(value.next_before_id)&&value.next_before_id>0))throw new Error('Checkpoint history is invalid.');
  let previous=Infinity;for(const c of value.checkpoints){checkpointMetadata(c,pip,workspace);if(c.id>=previous)throw new Error('Checkpoint history did not advance.');previous=c.id;}
  if((value.has_more&&(value.next_before_id!==value.checkpoints.at(-1)?.id||!value.checkpoints.length))||(!value.has_more&&value.next_before_id!==null))throw new Error('Checkpoint history returned an invalid cursor.');return value;
}
export function checkpointBaseline(value,pip,workspace){
  if(value==null)return null;
  if(!record(value)||![1,2,3].includes(value.schema_version)||value.pip_id!==pip||value.workspace_id!==workspace||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))throw new Error('The pinned checkpoint baseline is invalid.');
  if(value.checkpoint===null)return value;
  const c=value.checkpoint;checkpointMetadata(c,pip,workspace);if(value.schema_version===1&&c.schema_version===2)throw new Error('A legacy baseline cannot contain current-tree metadata.');
  if(!Number.isSafeInteger(c.total_findings)||c.total_findings<0||c.total_findings>16||!Number.isSafeInteger(c.omitted_findings)||c.omitted_findings<0||!Array.isArray(c.findings)||c.findings.length+c.omitted_findings!==c.total_findings||!Array.isArray(c.finding_identities)||c.finding_identities.length!==c.total_findings||!c.finding_identities.every(id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)))throw new Error('The pinned checkpoint baseline is invalid.');
  if(c.total_findings!==c.counts.total||new Set(c.findings.map(f=>f?.finding_id)).size!==c.findings.length)throw new Error('The pinned checkpoint finding identities are invalid.');
  for(const [index,f]of c.findings.entries()){
    const r=f?.review;if(!record(f)||f.finding_index!==index||f.identity!==c.finding_identities[index]||typeof f.finding_id!=='string'||!f.finding_id||!['title','path','evidence'].every(k=>typeof f[k]==='string')||!Number.isSafeInteger(f.line)||f.line<1||!['low','medium','high','critical'].includes(f.severity)||f.verification!=='source_excerpt_only'||!(c.comparison?.status==='unavailable'?['uncompared']:['new','repeated']).includes(f.comparison)||!record(r)||!['open','accepted','dismissed'].includes(r.status)||!Number.isSafeInteger(r.revision)||r.revision<0||r.revision>100||!['actor','reason','updated_at'].every(k=>r[k]===null||typeof r[k]==='string'))throw new Error('The pinned checkpoint occurrence is invalid.');
  }
  if(c.comparison?.status!=='unavailable')for(const kind of ['new','repeated']){const included=c.findings.filter(f=>f.comparison===kind).length;if(included>c.counts[kind]||c.omitted_findings===0&&included!==c.counts[kind])throw new Error('The pinned checkpoint comparison counts do not match its occurrences.');}
  return value;
}

export const executionPip = pip => pip?.source_policy?.mode!=='personal' && ['patch','pulse'].includes(pip?.pip_type || pip?.id);
export const pulsePip = pip => pip?.source_policy?.mode!=='personal' && (pip?.pip_type || pip?.id)==='pulse';
const bytes = value => new TextEncoder().encode(value).length;
const text = value => typeof value==='string' && !!value;
const hexDigest = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function relativePath(value,directory=false){
  return text(value)&&bytes(value)<=1024&&!/[\\\x00-\x1f\x7f:*?\[\]]/.test(value)&&!value.startsWith('/')&&(directory&&value==='.'||value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git'));
}
export function handoffAction(kind,paths='',tests='[]',specialists=undefined){
  if(specialists!==undefined&&kind!=='patch')throw Error('Only a reviewed Patch action can grant specialist calls.');
  if(kind==='read_only')return {kind};
  if(!['patch','test'].includes(kind))throw new Error('Choose a supported handoff target.');
  let commands;try{commands=JSON.parse(tests);}catch{throw new Error('Tests must be a JSON array of objects with argv and cwd. A shell command is not accepted.');}
  if(!Array.isArray(commands)||commands.length>4||(kind==='test'&&!commands.length))throw new Error('Use at most four commands; Pulse requires at least one.');
  let totalArgumentBytes=0;
  for(const command of commands){
    if(!record(command)||Object.keys(command).sort().join()!=='argv,cwd'||!Array.isArray(command.argv)||!command.argv.length||command.argv.length>32||command.argv.some(a=>typeof a!=='string'||!a||/[\x00-\x1f\x7f]/.test(a)||bytes(a)>1024)||!command.argv[0]||command.argv.reduce((n,a)=>n+bytes(a),0)>8192||!relativePath(command.cwd,true))throw new Error('Each test needs an exact argv array (1–32 arguments, at most 1,024 bytes each and 8,192 total) and a relative cwd.');
    totalArgumentBytes+=command.argv.reduce((n,a)=>n+bytes(a),0);
    if(totalArgumentBytes>8192)throw new Error('These commands are too long. Shorten their arguments.');
  }
  if(kind==='test')return {kind,tests:commands};
  const write_paths=paths.split('\n').map(p=>p.trim()).filter(Boolean);
  if(!write_paths.length||write_paths.length>32||new Set(write_paths).size!==write_paths.length||!write_paths.every(p=>relativePath(p)))throw new Error('List 1–32 distinct exact relative file paths, one per line. No parent paths or .git files.');
  return {kind,write_paths,tests:commands,...(specialists===undefined?{}:{specialists:specialistGrant(specialists)})};
}
export function reviewedAction(value){
  if(!record(value))throw new Error('The saved handoff action is invalid.');
  const parsed=handoffAction(value.kind,(value.write_paths||[]).join('\n'),JSON.stringify(value.tests||[]),value.specialists);
  if(value.kind==='read_only') {if(Object.keys(value).length!==1)throw new Error('The read-only handoff action is invalid.');return parsed;}
  const limits={wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32};
  if(value.network!==false||!record(value.limits)||Object.keys(value.limits).length!==5||Object.entries(limits).some(([k,v])=>value.limits[k]!==v)||Object.keys(value).sort().join()!==[...Object.keys(parsed),'network','limits'].sort().join())throw new Error('The saved action exceeds the supported execution policy.');
  return value;
}
const gitDigest=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export function patchArtifactSource(source){
  if(!record(source)||!['pip_id','run_id','model'].every(k=>text(source[k]))||!Number.isSafeInteger(source.job_version)||source.job_version<1||!gitDigest(source.source_revision)||!hexDigest(source.result_digest)||source.review_status!=='accepted'||!Number.isSafeInteger(source.review_revision)||source.review_revision<1||source.review_revision>100||Object.keys(source).sort().join()!=='artifact,changed_files,job_version,model,pip_id,result_digest,review_revision,review_status,run_id,source_revision'||!record(source.artifact)||Object.keys(source.artifact).sort().join()!=='bytes,path,sha256'||source.artifact.path!=='artifacts/changes.patch'||!hexDigest(source.artifact.sha256)||!Number.isSafeInteger(source.artifact.bytes)||source.artifact.bytes<1||source.artifact.bytes>262144||!Array.isArray(source.changed_files)||!source.changed_files.length||source.changed_files.length>32||!source.changed_files.every(p=>relativePath(p))||new Set(source.changed_files).size!==source.changed_files.length||source.changed_files.join('\n')!==[...source.changed_files].sort().join('\n'))throw new Error('The handoff does not identify an accepted Patch artifact.');
  return source;
}
export function personalHandoffPayload(p){
 const fail=()=>{throw Error('Personal handoff has invalid scope, result text or permissions.');};
 const s=p?.source,t=p?.target,a=p?.action;
 if(!record(p)||p.type!=='personal_result.v1'||!record(s)||!record(t)||!record(a)||bytes(JSON.stringify(p))>24576)fail();
 if(Object.keys(s).sort().join()!=='job_version,lifecycle_revision,model,pip_id,result_digest,run_id,source_revision,text'||s.source_revision!==null||!text(s.text)||bytes(s.text)>12000||!hexDigest(s.result_digest)||!text(s.model)||!Number.isSafeInteger(s.job_version)||s.job_version<1)fail();
 if(Object.keys(t).sort().join()!=='app_plan,app_plan_digest,connection_digest,job_version,lifecycle_revision,model,name,pip_id,pip_type,source_ref'||!hexDigest(t.app_plan_digest)||!['scout','lens','rook','lock','patch','pulse','quill'].includes(t.pip_type)||s.pip_id===t.pip_id)fail();
 for(const v of [s,t])if(!Number.isSafeInteger(v.lifecycle_revision)||v.lifecycle_revision<0)fail();
 if(t.app_plan!==null)appReadPlan(t.app_plan);
 if(Object.keys(a).sort().join()!=='external_actions,kind,tools'||a.kind!=='personal_task'||a.external_actions!==false||!Array.isArray(a.tools)||a.tools.length)fail();
 return p;
}
export function handoffRecord(value,pip,workspace){
  const h=value,p=h?.payload,s=p?.source,t=p?.target,artifact=p?.type==='patch_artifact.v1',personal=p?.type==='personal_result.v1';
  const fail=()=>{throw new Error('Handoff data is invalid or belongs to another Pip or workspace.');};
  if(!record(h)||!text(h.id)||h.workspace_id!==workspace||![h.source_pip_id,h.target_pip_id].includes(pip)||!['pending','accepted','rejected','expired'].includes(h.status)||!Number.isSafeInteger(h.revision)||h.revision<0||!['source_pip_id','source_run_id','target_pip_id','requested_by','created_at','expires_at'].every(k=>text(h[k]))||((artifact||personal)?h.source_finding_id!==null:!text(h.source_finding_id))||!hexDigest(h.payload_digest)||!['resolved_by','resolved_at','resolution_reason','run_id','run_status'].every(k=>h[k]===null||typeof h[k]==='string'))fail();
  if(h.revision!==(h.status==='pending'?0:1)||!['created_at','expires_at'].every(k=>Number.isFinite(Date.parse(h[k])))||h.resolved_at!==null&&!Number.isFinite(Date.parse(h.resolved_at))||(h.status==='pending'&&(h.resolved_by!==null||h.resolved_at!==null||h.resolution_reason!==null))||(h.status==='accepted'&&(!text(h.resolved_by)||!text(h.resolved_at))))fail();
  if(!record(p)||!['audit_finding.v1','patch_artifact.v1','personal_result.v1'].includes(p.type)||p.workspace_id!==workspace||!text(p.task)||bytes(p.task)>4000||!hexDigest(p.action_digest)||!record(s)||!record(t))fail();
  if(s.pip_id!==h.source_pip_id||s.run_id!==h.source_run_id||t.pip_id!==h.target_pip_id||!['name','pip_type','source_ref','model'].every(k=>text(t[k]))||!Number.isSafeInteger(t.job_version)||t.job_version<1||!hexDigest(t.connection_digest))fail();
  if(personal){personalHandoffPayload(p);}
  else if(artifact){patchArtifactSource(s);if(t.pip_type!=='pulse'||p.action?.kind!=='test')fail();}
  else if(s.finding_id!==h.source_finding_id||!Number.isSafeInteger(s.checkpoint_id)||s.checkpoint_id<1||!Number.isSafeInteger(s.finding_index)||s.finding_index<0||s.finding_index>=16||!Number.isSafeInteger(s.job_version)||s.job_version<1||!Number.isSafeInteger(s.review_revision)||s.review_revision<0||!Number.isSafeInteger(s.line)||s.line<1||!['source_revision','model','title','path','evidence'].every(k=>text(s[k]))||!hexDigest(s.identity)||s.verification!=='source_excerpt_only'||!['open','accepted','dismissed'].includes(s.review_status)||!['low','medium','high','critical'].includes(s.severity))fail();
  if(!personal)reviewedAction(p.action);
  if(!personal&&p.action.kind!==(t.pip_type==='patch'?'patch':t.pip_type==='pulse'?'test':['scout','lens','rook','lock'].includes(t.pip_type)?'read_only':'unsupported'))fail();
  if(h.status==='accepted'&&(!text(h.run_id)||!['queued','running','cancelling','succeeded','failed','cancelled'].includes(h.run_status)))fail();
  if(h.status!=='accepted'&&(h.run_id!==null||h.run_status!==null))fail();
  return h;
}
export function handoffsPage(value,pip,workspace){
  if(!record(value)||value.pip_id!==pip||value.workspace_id!==workspace||!Array.isArray(value.handoffs)||value.handoffs.length>20||typeof value.has_more!=='boolean'||!(value.next_before_id===null||text(value.next_before_id)))throw new Error('Handoff history is invalid.');
  const seen=new Set();for(const h of value.handoffs){handoffRecord(h,pip,workspace);if(seen.has(h.id))throw new Error('Handoff history repeated a record.');seen.add(h.id);}
  if(value.has_more?(!value.handoffs.length||value.next_before_id!==value.handoffs.at(-1).id):value.next_before_id!==null)throw new Error('Handoff history returned an invalid cursor.');
  return value;
}
export function handoffPin(value,run,workspace){
  if(!record(value)||value.run_id!==run.id||!text(value.handoff_id)||!record(value.review)||!text(value.review.actor)||!text(value.review.approved_at)||!record(value.payload))throw new Error('The run has no valid handoff approval pin.');
  const p=value.payload,m=run.manifest;
  handoffRecord({id:value.handoff_id,workspace_id:workspace,source_pip_id:p.source?.pip_id,source_run_id:p.source?.run_id,source_finding_id:['patch_artifact.v1','personal_result.v1'].includes(p.type)?null:p.source?.finding_id,target_pip_id:p.target?.pip_id,payload:p,payload_digest:value.digest,status:'accepted',revision:1,requested_by:value.review.actor,created_at:run.created_at,expires_at:value.review.approved_at,resolved_by:value.review.actor,resolved_at:value.review.approved_at,resolution_reason:null,run_id:run.id,run_status:run.status},run.pip_id,workspace);
  if(p.target.pip_id!==run.pip_id||m.job_version!==p.target.job_version||m.model!==p.target.model||m.source_revision!==p.source.source_revision||m.run_kind!==(p.action.kind==='read_only'?'audit':p.action.kind))throw new Error('The handoff does not match this run’s pinned inputs.');
  return value;
}
export function executionResult(value,kind,action,payload){
  if(!record(value)||!record(value.changes)||value.changes.kind!==kind||!Array.isArray(value.changes.changed_files)||value.changes.changed_files.length>32||!value.changes.changed_files.every(p=>relativePath(p))||typeof value.changes.diff!=='string'||bytes(value.changes.diff)>8192||typeof value.changes.diff_truncated!=='boolean'||!Array.isArray(value.tests)||value.tests.length>4)throw new Error('The execution result is invalid. Do not interpret this as a successful patch or test.');
  const artifact=(a,path,maximum)=>record(a)&&Object.keys(a).sort().join()==='bytes,path,sha256'&&a.path===path&&hexDigest(a.sha256)&&Number.isSafeInteger(a.bytes)&&a.bytes>=0&&a.bytes<=maximum;
  if(!artifact(value.changes.artifact,'artifacts/changes.patch',262144))throw new Error('The diff artifact reference is invalid.');
  if(new Set(value.changes.changed_files).size!==value.changes.changed_files.length||kind==='patch'&&value.changes.changed_files.some(p=>!action.write_paths.includes(p)))throw new Error('The recorded diff exceeds the approved file scope.');
  if(kind==='test'&&value.changes.changed_files.length)throw new Error('Test execution unexpectedly reports source changes.');
  if(!value.changes.changed_files.length&&(value.changes.diff||value.changes.artifact.bytes))throw new Error('An unchanged copy cannot claim a nonempty diff.');
  const stopStates=['timed_out','cancelled','output_limit','resource_limit'];let executed=0;
  for(const [index,t] of value.tests.entries()){
    const approved=action.tests[index];
    if(!record(t)||!Number.isSafeInteger(t.index)||t.index!==index||!approved||JSON.stringify(t.argv)!==JSON.stringify(approved.argv)||t.cwd!==approved.cwd||!['passed','failed',...stopStates].includes(t.status)||!(t.exit_code===null||Number.isInteger(t.exit_code)&&t.exit_code>=-128&&t.exit_code<=255)||typeof t.output!=='string'||bytes(t.output)>4096||typeof t.output_truncated!=='boolean'||!artifact(t.artifact,`artifacts/test-${index+1}.txt`,65536)||(t.status==='passed'&&t.exit_code!==0)||(t.status==='failed'&&t.exit_code===0)||(stopStates.includes(t.status)&&index!==value.tests.length-1))throw new Error('Test evidence does not match an approved command.');
    if(t.exit_code===null){if(t.status!=='cancelled'||t.output||t.artifact.bytes)throw new Error('A test cancelled before spawn cannot claim output.');}else executed++;
  }
  if(value.tests.length<action.tests.length&&(!value.tests.length||!stopStates.includes(value.tests.at(-1).status)))throw new Error('Approved tests are missing without a recorded stop.');
  if(value.tests_not_run!==undefined&&(!Number.isSafeInteger(value.tests_not_run)||value.tests_not_run!==action.tests.length-executed))throw new Error('The count of tests not run is inconsistent.');
  if(value.input!==undefined){
    const input=value.input;
    if(kind!=='test'||!record(input)||Object.keys(input).sort().join(',')!=='artifact_sha256,source_revision,source_run_id,tree,type'||input.type!=='patch_artifact.v1'||!text(input.source_run_id)||!gitDigest(input.source_revision)||!hexDigest(input.artifact_sha256)||!gitDigest(input.tree))throw new Error('The test input receipt is invalid.');
    if(payload&&(payload.type!=='patch_artifact.v1'||input.source_run_id!==payload.source.run_id||input.source_revision!==payload.source.source_revision||input.artifact_sha256!==payload.source.artifact.sha256))throw new Error('The test input receipt does not match the reviewed Patch artifact.');
  }else if(payload?.type==='patch_artifact.v1')throw new Error('The completed artifact test has no receipt for its approved input.');
  return value;
}

export function executionReview(value,runId){
  if(value==null)return null;
  if(!record(value)||value.run_id!==runId||!['open','accepted','dismissed'].includes(value.status)||!Number.isSafeInteger(value.revision)||value.revision<0||!hexDigest(value.result_digest)||!(value.actor===null||text(value.actor))||typeof value.reason!=='string'||bytes(value.reason)>2000||!(value.updated_at===null||Number.isFinite(Date.parse(value.updated_at))))throw new Error('Execution review is invalid or belongs to another run.');
  if(value.revision===0?(value.status!=='open'||value.actor!==null||value.reason!==''||value.updated_at!==null):(!value.actor||!value.reason.trim()||!value.updated_at))throw new Error('Execution review has invalid decision provenance.');
  return value;
}

export function executionContextContent(p){
  const stopped=['timed_out','cancelled','output_limit','resource_limit'];
  return `Historical runner receipt for ${p.run_id} at source ${p.source_revision}.\nPrivate changed files: ${p.changed_files}. Recorded commands: ${p.tests.length}; passed: ${p.tests.filter(t=>t.status==='passed').length}; failed: ${p.tests.filter(t=>t.status==='failed').length}; stopped: ${p.tests.filter(t=>stopped.includes(t.status)).length}; not run: ${p.tests_not_run}.\nOutcome accepted at review revision ${p.review_revision}; result SHA-256 ${p.result_digest}.\nThis records the reviewed execution at that time, not current source health or proof of correctness. Later reviews may differ. No changes were applied by recording this receipt; it grants no execution or write permission.`;
}
/** An accepted Patch or Pulse result saved to context, in words. The stored text stays exact (it is checked above). */
export function executionContextWords(p){
  if(!record(p)||!Array.isArray(p.tests))return '';
  const stopped=['timed_out','cancelled','output_limit','resource_limit'],count=(n,one,many)=>`${n} ${n===1?one:many}`,passed=p.tests.filter(t=>t.status==='passed').length,failed=p.tests.filter(t=>t.status==='failed').length,stops=p.tests.filter(t=>stopped.includes(t.status)).length;
  return `${p.run_kind==='patch'?`${count(p.changed_files,'file','files')} changed in a private copy. `:''}${p.tests.length+p.tests_not_run?`Tests: ${passed} passed, ${failed} failed${stops?`, ${stops} stopped`:''}${p.tests_not_run?`, ${p.tests_not_run} didn’t run`:''}.`:'No tests.'} Commit ${String(p.source_revision).slice(0,12)}.`;
}
export function executionContextEntry(entry){
  const p=entry?.provenance,fail=()=>{throw new Error('Workspace execution context has an invalid historical receipt.');},integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  const keys='artifact,changed_files,classification,input,job_version,model,pip_id,result_digest,review_revision,review_status,run_id,run_kind,source,source_revision,tests,tests_not_run,verification';
  if(entry?.kind!=='execution'||!record(p)||Object.keys(p).sort().join()!==keys||p.source!=='pip_execution'||p.classification!=='runner_receipt'||p.verification!=='recorded_execution_only'||p.review_status!=='accepted'||!['patch','test'].includes(p.run_kind)||!/^run_[a-f0-9]{32}$/.test(p.run_id)||!/^pip_[a-f0-9]{32}$/.test(p.pip_id)||!integer(p.job_version,1,999999)||!integer(p.review_revision,1,100)||!integer(p.changed_files,0,32)||!integer(p.tests_not_run,0,4)||!text(p.model)||bytes(p.model)>256||!gitDigest(p.source_revision)||!hexDigest(p.result_digest))fail();
  const a=p.artifact;if(!record(a)||Object.keys(a).sort().join()!=='bytes,sha256'||!hexDigest(a.sha256)||!integer(a.bytes,0,262144)||(p.changed_files===0&&a.bytes!==0)||(p.run_kind==='test'&&p.changed_files!==0)||!Array.isArray(p.tests)||p.tests.length>4)fail();
  const stops=['timed_out','cancelled','output_limit','resource_limit'];let executed=0;
  for(const [index,t]of p.tests.entries()){
    if(!record(t)||Object.keys(t).sort().join()!=='command_digest,exit_code,index,output_bytes,output_sha256,status'||t.index!==index||!['passed','failed',...stops].includes(t.status)||!integer(t.output_bytes,0,65536)||!hexDigest(t.command_digest)||!hexDigest(t.output_sha256)||!(t.exit_code===null||integer(t.exit_code,-128,255))||(t.status==='passed'&&t.exit_code!==0)||(t.status==='failed'&&t.exit_code===0)||(stops.includes(t.status)&&index!==p.tests.length-1))fail();
    if(t.exit_code===null){if(t.status!=='cancelled'||t.output_bytes!==0)fail();}else executed++;
  }
  const total=executed+p.tests_not_run;if(total<p.tests.length||total>4||(total>executed&&(!p.tests.length||!stops.includes(p.tests.at(-1).status))))fail();
  if(p.input!==null){const i=p.input;if(p.run_kind!=='test'||!record(i)||Object.keys(i).sort().join()!=='artifact_sha256,source_revision,source_run_id,tree,type'||i.type!=='patch_artifact.v1'||!/^run_[a-f0-9]{32}$/.test(i.source_run_id)||i.source_revision!==p.source_revision||!hexDigest(i.artifact_sha256)||!gitDigest(i.tree))fail();}
  if(entry.title!==(p.run_kind==='patch'?'Reviewed Patch outcome':'Reviewed Pulse outcome')||entry.content!==executionContextContent(p))fail();return entry;
}

export const documentationPip=pip=>pip?.source_policy?.mode!=='personal' && (pip?.pip_type||pip?.id)==='quill';
export const DRAFT_VERIFICATION='Draft text; cited excerpts checked against pinned source. Prose remains model-authored and is not verified documentation.';
export function documentationDraft(result){
  const fail=()=>{throw new Error('The documentation draft is invalid. No verified documentation or file change is implied.');};
  const textWithin=(s,max,single=false)=>typeof s==='string'&&!!s.trim()&&bytes(s)<=max&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)&&!(single?/[\x00-\x1f\x7f]/:/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(s);
  if(!record(result)||Object.keys(result).sort().join()!=='draft,snapshot,summary,tests_executed,title,tools_called,usage,verification'||!textWithin(result.title,160,true)||!textWithin(result.summary,2000)||result.tests_executed!==false||result.verification!==DRAFT_VERIFICATION||!Number.isSafeInteger(result.tools_called)||result.tools_called<1||result.tools_called>1000000||!record(result.usage)||Object.entries(result.usage).some(([k,v])=>!['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens','requests'].includes(k)||!Number.isSafeInteger(v)||v<0))fail();
  const d=result.draft,a=d?.artifact,s=result.snapshot;
  if(!record(d)||Object.keys(d).sort().join()!=='artifact,citations,markdown'||!textWithin(d.markdown,24576)||!record(a)||Object.keys(a).sort().join()!=='bytes,path,sha256'||a.path!=='artifacts/documentation.md'||!hexDigest(a.sha256)||a.bytes!==bytes(d.markdown)||!record(s)||Object.keys(s).sort().join()!=='bytes,files,sha256'||!hexDigest(s.sha256)||!Number.isSafeInteger(s.files)||s.files<0||s.files>10000||!Number.isSafeInteger(s.bytes)||s.bytes<0||s.bytes>268435456||!Array.isArray(d.citations)||!d.citations.length||d.citations.length>16)fail();
  for(const c of d.citations){if(!record(c)||Object.keys(c).sort().join()!=='excerpt,line,path,verification'||!textWithin(c.path,1024,true)||c.path.startsWith('/')||/[\\:]/.test(c.path)||c.path.split('/').some(p=>!p||['.','..','.git'].includes(p))||!Number.isSafeInteger(c.line)||c.line<1||c.line>100000||!textWithin(c.excerpt,1000)||c.excerpt.split('\n').length>8||c.verification!=='source_excerpt_only')fail();}
  if(bytes(JSON.stringify(result))>61440)fail();return result;
}
// Direct dashboard links must fetch the exact saved proposal, not substitute a list row.
export function savedProposal(value,pip,workspace,id){
 const fail=()=>{throw new Error('The saved proposal is invalid or belongs to another Pip. Refresh the review.');};
 const p=value?.proposal,a=p?.approval;
 const bounded=(v,n,empty=false)=>typeof v==='string'&&(empty||v.length>0)&&bytes(v)<=n;
 if(!record(value)||Object.keys(value).sort().join()!=='as_of,proposal,runner_id'||!bounded(value.runner_id,128)||!bounded(value.as_of,40)||!Number.isFinite(Date.parse(value.as_of))||!record(p)||Object.keys(p).sort().join()!=='actor,approval,created_at,definition,expected_version,id,pip_id,reason,status,workspace_id'||p.id!==id||p.pip_id!==pip||p.workspace_id!==workspace||!Number.isSafeInteger(p.expected_version)||(p.expected_version<0||p.expected_version===0&&!(p.status==='accepted'&&p.actor==='core_setup'&&a?.status==='approved'))||p.expected_version>999999||!record(p.definition)||bytes(JSON.stringify(p.definition))>16384||!bounded(p.actor,512)||!bounded(p.reason,4000,true)||!bounded(p.created_at,40)||!['proposed','accepted','rejected','superseded','expired'].includes(p.status))fail();
 if(!record(a)||Object.keys(a).sort().join()!=='action_summary,action_type,created_at,effective_status,expires_at,id,resolved_at,resolved_by,status'||!bounded(a.id,128)||!['job_update','schedule_update'].includes(a.action_type)||!bounded(a.action_summary,1024)||!bounded(a.created_at,40)||!bounded(a.expires_at,40)||!Number.isFinite(Date.parse(a.expires_at))||approvalStatus(a.status)==='Unknown'||approvalStatus(a.effective_status)==='Unknown'||!(a.resolved_by===null||bounded(a.resolved_by,512))||!(a.resolved_at===null||bounded(a.resolved_at,40)))fail();
 const effective=a.status==='pending'&&Date.parse(a.expires_at)<=Date.parse(value.as_of)?'expired':a.status;if(a.effective_status!==effective)fail();
 return {...p,approval_id:a.id,approval_status:a.effective_status,expires_at:a.expires_at};
}

export const ADAPTATION_MODES={locked:'Never',context_adaptive:'Uses notes you shared',suggest_changes:'Suggests changes',bounded_adaptive:'Only what I tick',autonomous:'May rename itself'};
export function adaptationPolicy(value='suggest_changes'){
 const fail=()=>{throw new Error('Choose a supported adaptation policy. Automatic changes may include only the name and source ref.');};
 if(typeof value==='string'){if(!Object.hasOwn(ADAPTATION_MODES,value)||value==='bounded_adaptive')fail();value={mode:value,allowed_fields:value==='autonomous'?['name','source_ref']:[]};}
 if(!record(value)||Object.keys(value).sort().join()!=='allowed_fields,mode'||typeof value.mode!=='string'||!Object.hasOwn(ADAPTATION_MODES,value.mode)||!Array.isArray(value.allowed_fields)||value.allowed_fields.length>2||new Set(value.allowed_fields).size!==value.allowed_fields.length||value.allowed_fields.some(k=>!['name','source_ref'].includes(k)))fail();
 const fields=[...value.allowed_fields].sort(),expected=value.mode==='autonomous'?['name','source_ref']:[];
 if(value.mode==='bounded_adaptive'?!fields.length:JSON.stringify(fields)!==JSON.stringify(expected))fail();
 return {mode:value.mode,allowed_fields:fields};
}
export function adaptationLabel(value){try{const p=adaptationPolicy(value);return ADAPTATION_MODES[p.mode]+(p.allowed_fields.length?' · '+p.allowed_fields.map(k=>k==='name'?'name':'source ref').join(', '):' · no automatic job changes');}catch{return 'Unsupported adaptation policy';}}
export function adaptationsPage(value,pip,workspace){
 const fail=()=>{throw new Error('Adaptation history is invalid or belongs to another Pip.');},bounded=(v,n)=>typeof v==='string'&&v.trim().length>0&&bytes(v)<=n;
 if(!record(value)||Object.keys(value).sort().join()!=='adaptations,next_before_id'||!Array.isArray(value.adaptations)||value.adaptations.length>50||!(value.next_before_id===null||bounded(value.next_before_id,128))||bytes(JSON.stringify(value.adaptations))>65536)fail();
 const ids=new Set();let previous=Infinity;
 for(const a of value.adaptations){
  if(!record(a)||Object.keys(a).sort().join()!=='changes,created_at,from_version,id,pip_id,policy,policy_approval_id,policy_version,reason,to_version,workspace_id'||!/^adaptation_[a-f0-9]{32}$/.test(a.id)||ids.has(a.id)||a.pip_id!==pip||a.workspace_id!==workspace||!bounded(a.policy_approval_id,128)||!bounded(a.reason,4000)||[...a.reason].length>1000||!bounded(a.created_at,40)||!Number.isFinite(Date.parse(a.created_at))||![a.from_version,a.to_version,a.policy_version].every(n=>Number.isSafeInteger(n)&&n>=1&&n<1000000)||a.to_version!==a.from_version+1||a.policy_version>a.from_version||a.to_version>=previous||!record(a.changes)||!Object.keys(a.changes).length)fail();
  const p=adaptationPolicy(a.policy);if(!['bounded_adaptive','autonomous'].includes(p.mode)||Object.keys(a.changes).some(k=>!p.allowed_fields.includes(k)))fail();
  for(const[k,v]of Object.entries(a.changes)){if(!bounded(v,k==='name'?480:200)||[...v].length>(k==='name'?120:200)||v!==v.trim()||/[\x00-\x1f\x7f]/.test(v)||k==='source_ref'&&(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v)||v.includes('..')))fail();}
  previous=a.to_version;ids.add(a.id);
 }
 if(value.next_before_id!==null&&value.next_before_id!==value.adaptations.at(-1)?.id)fail();return value;
}

const pathKeys=(value,keys)=>record(value)&&Object.keys(value).sort().join()===keys;
const pathHash=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]+$/.test(value);
const pathCommit=value=>typeof value==='string'&&[40,64].includes(value.length)&&/^[a-f0-9]+$/.test(value);
const pathId=(value,prefix)=>typeof value==='string'&&value.length===prefix.length+33&&value.startsWith(prefix+'_')&&/^[a-f0-9]+$/.test(value.slice(prefix.length+1));
const pathRef=value=>typeof value==='string'&&value.length>=1&&value.length<=200&&!/[\r\n]/.test(value)&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)&&!value.includes('..');
export function commitPathRules(value){
 const fail=()=>{throw Error('Use 1 to 32 different paths inside the project, with no wildcards or .git, and keep each one short.');};
 if(!Array.isArray(value)||value.length<1||value.length>32)fail();const seen=new Set(),encoder=new TextEncoder();
 const rules=value.map(rule=>{if(!pathKeys(rule,'kind,path')||!['exact','directory'].includes(rule.kind)||typeof rule.path!=='string'||!rule.path||rule.path.length>256||/^[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(rule.path)||/[\x00-\x1f\x7f\\:*?\[\]]/.test(rule.path)||[...rule.path].some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff)||bytes(rule.path)>256||rule.path.split('/').some(c=>!c||c==='.'||c==='..'||c.toLowerCase()==='.git')||seen.has(rule.path))fail();seen.add(rule.path);return {kind:rule.kind,path:rule.path};});
 rules.sort((a,b)=>{const x=encoder.encode(a.path),y=encoder.encode(b.path);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;});if(bytes(JSON.stringify(rules))>2048)fail();return rules;
}
export function commitPathComparison(value,rules){
 const fail=()=>{throw Error('The saved committed-path comparison is invalid.');};const allowed=['baseline_unavailable','comparison_unavailable','comparison_timeout','metadata_limit','unsupported_path','invalid_metadata','root_changed'];
 const canonical=commitPathRules(rules);if(!pathKeys(value,'after_revision,before_revision,changed_entries,comparison,digest,matched_rule_indices,policy_digest,reason,schema_version,status')||value.schema_version!==1||value.comparison!=='commit_trees'||!pathCommit(value.before_revision)||!pathCommit(value.after_revision)||!pathHash(value.policy_digest)||!pathHash(value.digest)||!Array.isArray(value.matched_rule_indices)||value.matched_rule_indices.length>canonical.length||value.matched_rule_indices.some((v,i)=>!Number.isSafeInteger(v)||v<0||v>=canonical.length||i>0&&value.matched_rule_indices[i-1]>=v))fail();
 if(value.status==='unavailable'){if(!allowed.includes(value.reason)||value.changed_entries!==null||value.matched_rule_indices.length)fail();}else if(!['matched','unmatched'].includes(value.status)||value.reason!==null||!Number.isSafeInteger(value.changed_entries)||value.changed_entries<0||value.changed_entries>10000||(value.status==='matched')!==(value.matched_rule_indices.length>0)||value.status==='matched'&&value.changed_entries===0||value.before_revision===value.after_revision&&(value.changed_entries!==0||value.matched_rule_indices.length))fail();
 if(bytes(JSON.stringify(value))>2048)fail();return value;
}
export function commitPathMatch(value,manifest,event,policy){
 const fail=()=>{throw Error('The saved committed-path match does not belong to this run.');};
 if(!pathKeys(value,'binding_digest,binding_id,comparison,digest,job_version,observed_at,pip_id,policy_digest,schema_version,source_ref,workspace_id')||value.schema_version!==1||!pathId(value.pip_id,'pip')||!pathId(value.workspace_id,'ws')||!pathId(value.binding_id,'binding')||value.pip_id!==manifest.pip_id||value.workspace_id!==manifest.workspace_id||value.binding_id!==manifest.binding_id||value.job_version!==manifest.job_version||!pathRef(value.source_ref)||value.source_ref!==manifest.job?.source_ref||!pathHash(value.binding_digest)||!pathHash(value.policy_digest)||!pathHash(value.digest)||!canonicalTime(value.observed_at)||value.observed_at!==event.created_at||event.event_type!=='workspace_committed_paths_changed'||(!pathCommit(manifest.source_revision)||sourcePin(manifest).kind!=='committed_only'))fail();
 const comparison=commitPathComparison(value.comparison,policy.commit_paths);if(comparison.status!=='matched'||comparison.before_revision===comparison.after_revision||comparison.policy_digest!==value.policy_digest||bytes(JSON.stringify(value))>4096)fail();return value;
}

export function commitPathObservation(value,pip){
 if(value==null)return null;const fail=()=>{throw Error('The committed-path observation is unavailable.');};
 if(pathKeys(value,'reason,schema_version,status')&&value.schema_version===1&&value.status==='unavailable'&&['invalid_stored_observation','stale_observation'].includes(value.reason))return value;
 if(!pathKeys(value,'job_version,last_checked_at,last_comparison,last_comparison_at,last_probe,observed_changes,policy_digest,revision,schema_version,status')||value.schema_version!==1||value.status!=='available'||value.job_version!==pip?.current_version||!Number.isSafeInteger(value.job_version)||value.job_version<1||value.job_version>999999||!pathHash(value.policy_digest)||!(value.revision===null||pathCommit(value.revision))||!Number.isSafeInteger(value.observed_changes)||value.observed_changes<0||!(value.last_checked_at===null||canonicalTime(value.last_checked_at))||!(value.last_comparison_at===null||canonicalTime(value.last_comparison_at))||(value.last_comparison===null)!==(value.last_comparison_at===null)||(value.last_probe===null)!==(value.last_checked_at===null))fail();
 const policy=eventTrigger(pip.event_trigger);if(!policy?.commit_paths)fail();
 if(value.last_comparison!==null){const c=commitPathComparison(value.last_comparison,policy.commit_paths);if(c.status==='unavailable'||c.policy_digest!==value.policy_digest||value.last_checked_at===null||value.last_comparison_at>value.last_checked_at)fail();}
 const p=value.last_probe;if(p!==null){
  if(!pathKeys(p,'after_revision,before_revision,checked_at,comparison_digest,policy_digest,reason,schema_version,status')||p.schema_version!==1||p.checked_at!==value.last_checked_at||p.policy_digest!==value.policy_digest||!(p.before_revision===null||pathCommit(p.before_revision))||!(p.after_revision===null||pathCommit(p.after_revision)))fail();
  if(p.status==='unavailable'){if(!['root_unavailable','root_changed','ref_unavailable','baseline_unavailable','comparison_unavailable','comparison_timeout','metadata_limit','unsupported_path','invalid_metadata'].includes(p.reason)||p.comparison_digest!==null)fail();}
  else if(!['baselined','unchanged','compared'].includes(p.status)||p.reason!==null||p.after_revision===null||p.after_revision!==value.revision)fail();
  else if(p.status==='baselined'){if(p.before_revision!==null||p.comparison_digest!==null)fail();}
  else if(p.status==='unchanged'){if(p.before_revision!==p.after_revision||p.comparison_digest!==null)fail();}
  else if(p.before_revision===null||p.before_revision===p.after_revision||!pathHash(p.comparison_digest)||p.comparison_digest!==value.last_comparison?.digest||value.last_comparison_at!==p.checked_at||value.last_comparison.before_revision!==p.before_revision||value.last_comparison.after_revision!==p.after_revision)fail();
  if(bytes(JSON.stringify(p))>1024)fail();
 }return value;
}

export const EVENT_TRIGGER_NAMES={context_updated:'Workspace context changes',finding_accepted:'A finding is accepted',commit_changed:'A new commit on its branch',session_turn_completed:'A DGC chat turn is saved',committed_paths_changed:'Watched paths change in a commit'};
export function eventTrigger(value){
 if(value==null)return null;
 const fail=()=>{throw new Error('Choose one to four supported events and an interval from 5 to 10,080 minutes.');};
 if(!record(value)||Object.keys(value).some(k=>!['events','minimum_minutes','missed_policy','commit_paths'].includes(k))||!Array.isArray(value.events)||value.events.length<1||value.events.length>4||value.events.some(e=>typeof e!=='string'||!Object.hasOwn(EVENT_TRIGGER_NAMES,e))||new Set(value.events).size!==value.events.length)fail();
 const minutes=value.minimum_minutes===undefined?5:value.minimum_minutes;if(!Number.isSafeInteger(minutes)||minutes<5||minutes>10080||(value.missed_policy===undefined?'coalesce_latest':value.missed_policy)!=='coalesce_latest')fail();
 const paths=value.events.includes('committed_paths_changed');if(paths&&value.events.includes('commit_changed')||!paths&&Object.hasOwn(value,'commit_paths'))fail();
 return {events:[...value.events].sort(),minimum_minutes:minutes,missed_policy:'coalesce_latest',...(paths?{commit_paths:commitPathRules(value.commit_paths)}:{})};
}
export function eventTriggerLabel(value){try{const p=eventTrigger(value);return p?p.events.map(e=>EVENT_TRIGGER_NAMES[e]).join('; ')+` · at least ${p.minimum_minutes} minutes apart`:'No events';}catch{return 'Events this editor doesn’t know';}}
export function eventTriggerFromDraft(draft,rules){
 if(!/^\d+$/.test(String(draft.triggerMinutes)))throw new Error('Use a whole number of minutes between 5 and 10,080.');
 return eventTrigger({events:[...(draft.triggerContext?['context_updated']:[]),...(draft.triggerFinding?['finding_accepted']:[]),...(draft.triggerCommit?['commit_changed']:[]),...(draft.triggerSession?['session_turn_completed']:[]),...(draft.triggerPaths?['committed_paths_changed']:[])],minimum_minutes:Number(draft.triggerMinutes),missed_policy:'coalesce_latest',...(draft.triggerPaths?{commit_paths:rules}:{})});
}
/** What an event was, in words, never its stored type. */
export const eventWords = event => ({workspace_context_recorded:'A context note was added',workspace_context_archived:'A context note was archived',workspace_finding_accepted:'A finding was saved to context',workspace_execution_recorded:'A run result was saved to context',pip_finding_accepted:'A finding was accepted',workspace_commit_changed:'A new commit',workspace_session_turn_completed:'A DGC chat turn was saved',workspace_committed_paths_changed:'Watched paths changed in a commit'}[event?.event_type] || String(event?.event_type ?? 'An event').replaceAll('_',' '));
export function eventRunPin(manifest){
 if(manifest?.trigger!=='event')return null;
 const p=manifest.event_trigger,e=p?.event,fail=()=>{throw new Error('This run has an invalid event-trigger receipt.');};
 if(!record(p)||Object.keys(p).sort().join()!==(e?.event_type==='workspace_committed_paths_changed'?'checked_at,commit_path_match,event,expected_after_seq,history_may_be_incomplete,job_version,policy,source_semantics':'checked_at,event,expected_after_seq,history_may_be_incomplete,job_version,policy,source_semantics')||p.job_version!==manifest.job_version||!Number.isSafeInteger(p.job_version)||p.job_version<1||p.job_version>999999||manifest.policy!=='read_only'||!['rook','scout','lens','lock','quill'].includes(manifest.pip_type??'rook')||(manifest.pip_type==='quill'?manifest.run_kind!=='draft':!['audit',undefined].includes(manifest.run_kind))||typeof p.history_may_be_incomplete!=='boolean'||p.source_semantics!=='Current approved committed source at enqueue; event metadata does not select a historical checkout.')fail();
 const spec=eventTrigger(p.policy),mapping={context_updated:['workspace_context_recorded','workspace_context_archived','workspace_finding_accepted','workspace_execution_recorded'],finding_accepted:['pip_finding_accepted'],commit_changed:['workspace_commit_changed'],session_turn_completed:['workspace_session_turn_completed'],committed_paths_changed:['workspace_committed_paths_changed']};
 if(!spec||Object.keys(p.policy).sort().join()!==(spec.commit_paths?'commit_paths,events,minimum_minutes,missed_policy':'events,minimum_minutes,missed_policy')||spec.commit_paths&&!sameJson(spec.commit_paths,p.policy.commit_paths)||JSON.stringify(spec.events)!==JSON.stringify(p.policy.events)||spec.minimum_minutes!==p.policy.minimum_minutes||spec.missed_policy!==p.policy.missed_policy||!record(e)||Object.keys(e).sort().join()!=='created_at,event_id,event_type,seq'||typeof e.event_id!=='string'||!e.event_id||new TextEncoder().encode(e.event_id).length>128||/[\u0000-\u001f\u007f]/.test(e.event_id)||!Number.isSafeInteger(e.seq)||e.seq<1||!Number.isSafeInteger(p.expected_after_seq)||p.expected_after_seq<0||p.expected_after_seq>=e.seq||!spec.events.flatMap(v=>mapping[v]).includes(e.event_type)||typeof e.created_at!=='string'||e.created_at.length>40||!Number.isFinite(Date.parse(e.created_at))||typeof p.checked_at!=='string'||p.checked_at.length>32||!Number.isFinite(Date.parse(p.checked_at))||Date.parse(p.checked_at)<Date.parse(e.created_at))fail();if(spec.commit_paths){
  if(!pathId(e.event_id,'evt')||!canonicalTime(e.created_at)||!canonicalTime(p.checked_at)||!['pip','ws','binding'].every((prefix,i)=>pathId(manifest[['pip_id','workspace_id','binding_id'][i]],prefix))||manifest.requested_by!=='local-event-trigger'||manifest.run_kind!==(manifest.pip_type==='quill'?'draft':'audit')||!pathCommit(manifest.source_revision)||sourcePin(manifest).kind!=='committed_only'||['handoff','conversation','specialists','pulse_verification','main_chat_request','schedule','scheduled_at','schedule_occurrence'].some(k=>Object.hasOwn(manifest,k))||!pathKeys(manifest.job,'goal,model_choice,name,pip_type,source_policy,source_ref')||manifest.job.pip_type!==manifest.pip_type||!committedPolicy(manifest.job.source_policy)||!pathRef(manifest.job.source_ref))fail();
  if(e.event_type==='workspace_committed_paths_changed')commitPathMatch(p.commit_path_match,manifest,e,spec);
 }return p;
}


const sameJson=(a,b)=>Array.isArray(a)?Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>sameJson(v,b[i])):record(a)?record(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&sameJson(a[k],b[k])):a===b;
const canonicalTime=value=>typeof value==='string'&&value.length===24&&Number(value.slice(0,4))>=1&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function automationSchedule(value){
 const fail=()=>{throw new Error('The saved draft automation schedule is invalid.');};
 if(!record(value))fail();
 let checked;
 try{checked=scheduleFromDraft({scheduleType:value.type,scheduleMinutes:value.minutes,scheduleTime:value.time,scheduleZone:value.timezone,scheduleAt:value.at,scheduleCron:value.cron},-Infinity);}catch{fail();}
 if(!checked||!sameJson(checked,value))fail();return checked;
}
export function draftAutomationPin(manifest){
 if(!record(manifest))return null;
 const grant=manifest.draft_automation,automatic=manifest.pip_type==='quill'&&(['schedule','event'].includes(manifest.trigger)||['schedule','scheduled_at','event_trigger'].some(k=>Object.hasOwn(manifest,k))),fail=()=>{throw new Error('This run has an invalid reviewed Quill automation grant. No approved automated draft is implied.');};
 if(manifest.pip_type==='quill'&&manifest.run_kind==='audit'||['rook','scout','lens','lock'].includes(manifest.pip_type)&&manifest.run_kind==='draft')fail();
 if(!automatic){if(Object.hasOwn(manifest,'draft_automation'))fail();return null;}
 const keys='definition_digest,digest,job_digest,job_version,occurrence,pip_id,policy,schema_version,trigger,workspace_id';
 const sha=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v);
 const id=(v,prefix)=>typeof v==='string'&&v.length===prefix.length+32&&v.startsWith(prefix)&&/^[a-f0-9]+$/.test(v.slice(prefix.length));
 if(!record(grant)||Object.keys(grant).sort().join()!==keys||new TextEncoder().encode(JSON.stringify(grant)).length>4096||grant.schema_version!==1||!['schedule','event'].includes(grant.trigger)||manifest.run_kind!=='draft'||manifest.policy!=='read_only'||grant.trigger!==manifest.trigger||grant.job_version!==manifest.job_version||!Number.isSafeInteger(grant.job_version)||grant.job_version<1||grant.job_version>999999||!id(grant.pip_id,'pip_')||!id(grant.workspace_id,'ws_')||grant.pip_id!==manifest.pip_id||grant.workspace_id!==manifest.workspace_id||!sha(grant.definition_digest)||!sha(grant.job_digest)||!sha(grant.digest)||!record(manifest.job)||manifest.job.pip_type!=='quill'||sourcePin(manifest).kind!=='committed_only')fail();
 const job=manifest.job,choice=job.model_choice;
 if(Object.keys(job).sort().join()!=='goal,model_choice,name,pip_type,source_policy,source_ref'||!committedPolicy(job.source_policy)||!sameJson(manifest.tools,['glob','grep','read_file','repo_map','todo'])||['handoff','specialists','conversation','audit_checkpoint','changes_since_checkpoint','pip_memory','main_chat_request'].some(k=>Object.hasOwn(manifest,k)))fail();
 for(const [key,max] of [['name',120],['goal',4000],['source_ref',200]])if(typeof job[key]!=='string'||!job[key]||job[key]!==job[key].trim()||[...job[key]].length>max||job[key].includes('\0'))fail();
 if(!record(choice)||!(Object.keys(choice).join()==='mode'&&choice.mode==='default'||Object.keys(choice).sort().join()==='mode,model'&&choice.mode==='model'&&typeof choice.model==='string'&&choice.model.length<=256&&/^[A-Za-z0-9_][A-Za-z0-9._:/@+\-]*$/.test(choice.model)&&!/[\r\n]/.test(choice.model)&&!choice.model.includes('://')))fail();
 const o=grant.occurrence;
 if(grant.trigger==='event'){
  const pin=eventRunPin(manifest);
  if(manifest.requested_by!=='local-event-trigger'||Object.hasOwn(manifest,'schedule')||Object.hasOwn(manifest,'scheduled_at')||Object.hasOwn(manifest,'schedule_occurrence')||!sameJson(grant.policy,pin.policy)||!sameJson(o,{job_version:pin.job_version,expected_after_seq:pin.expected_after_seq,checked_at:pin.checked_at,event:pin.event,history_may_be_incomplete:pin.history_may_be_incomplete}))fail();
 }else{
  const spec=automationSchedule(grant.policy);
  if(manifest.requested_by!=='local-scheduler'||Object.hasOwn(manifest,'event_trigger')||Object.hasOwn(manifest,'event_occurrence')||!sameJson(spec,manifest.schedule)||!canonicalTime(manifest.scheduled_at)||!record(o)||Object.keys(o).sort().join()!=='anchor_at,checked_at,expected_next_due,job_version,next_due_at,scheduled_at'||o.job_version!==grant.job_version||!['anchor_at','checked_at','expected_next_due','scheduled_at'].every(k=>canonicalTime(o[k]))||!(o.next_due_at===null||canonicalTime(o.next_due_at))||o.scheduled_at!==manifest.scheduled_at)fail();
  const anchor=Date.parse(o.anchor_at),first=Date.parse(o.expected_next_due),due=Date.parse(o.scheduled_at),checked=Date.parse(o.checked_at),next=o.next_due_at===null?null:Date.parse(o.next_due_at);
  if(!(anchor<first&&first<=due&&due<=checked)||next!==null&&next<=checked)fail();
  if(spec.type==='once'){if(o.next_due_at!==null||o.expected_next_due!==spec.at||o.scheduled_at!==spec.at)fail();}
  else if(next===null)fail();
  if(spec.type==='interval'){const step=spec.minutes*60000;if((first-anchor)%step!==0||due!==anchor+Math.floor((checked-anchor)/step)*step||next!==due+step)fail();}
 }
 return grant;
}

const pulseKeys=(v,keys)=>record(v)&&Object.keys(v).sort().join()===keys.split(',').sort().join();
const pulseInt=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const pulseHash=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v);
const pulseId=(v,prefix)=>typeof v==='string'&&v.length===prefix.length+33&&v.startsWith(prefix+'_')&&/^[a-f0-9]+$/.test(v.slice(prefix.length+1));
const pulseText=(v,max)=>typeof v==='string'&&!!v&&bytes(v)<=max&&!/[\x00-\x1f\x7f]/.test(v)&&![...v].some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff);
const pulseFail=()=>{throw Error('The reviewed Pulse plan or command receipt is invalid. No completed verification is implied.');};
export function pulsePlan(value){
 if(value===null||value===undefined)return null;
 if(!pulseKeys(value,'schema_version,action')||value.schema_version!==1||!pulseKeys(value.action,'kind,tests,network,limits')||value.action.kind!=='test')pulseFail();
 if(value.action.network==='loopback_http_v1'){
  reviewedAction({...value.action,network:false});
  for(const t of value.action.tests){const a=t.argv,m=typeof a[1]==='string'&&/^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})(\/[A-Za-z0-9_./-]*)$/.exec(a[1]);if(t.cwd!=='.'||a.length!==3||a[0]!=='dgc-http-check'||!m||+m[1]<1024||+m[1]>65535||m[2].includes('..')||m[2].includes('//')||!(/^[1-5][0-9]{2}$/.test(a[2])))pulseFail();}
 }else reviewedAction(value.action);
 if(bytes(JSON.stringify(value))>12288||value.action.tests.some(t=>!pulseText(t.cwd,1024)||t.argv.some(a=>!pulseText(a,1024))))pulseFail();
 return value;
}
export function pulsePlanFromCommands(commands){
 return pulsePlan({schema_version:1,action:{...handoffAction('test','',JSON.stringify(commands)),network:false,limits:{wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32}}});
}
export const pulsePlanEqual=(left,right)=>sameJson(pulsePlan(left),pulsePlan(right));
export function pulseRunPins(pip){
 if(!pulsePip(pip)||!pulsePlan(pip.verification_plan)||!pulseHash(pip.verification_plan_digest)||!pulseInt(pip.current_version,1,999999)||!pulseInt(pip.lifecycle_revision)||sourcePolicy(pip.source_policy).mode!=='committed_only'||pip.event_trigger!=null)pulseFail();
 return {expected_version:pip.current_version,expected_lifecycle_revision:pip.lifecycle_revision,expected_plan_digest:pip.verification_plan_digest};
}
export function pulseVerificationPin(m){
 if(!record(m))pulseFail();
 if(!Object.hasOwn(m,'pulse_verification')){
  if(m.run_kind==='test'&&!Object.hasOwn(m,'handoff')&&(m.model==null||m.job?.verification_plan!=null))pulseFail();
  return null;
 }
 const g=m.pulse_verification;
 if(!pulseKeys(g,'schema_version,pip_id,workspace_id,binding_id,runner_id,job_version,definition_digest,approval_id,plan_digest,action_digest,lifecycle_revision,source_revision,binding_digest,model,trigger,request,digest')||g.schema_version!==1||bytes(JSON.stringify(g))>4096||m.run_kind!=='test'||m.pip_type!=='pulse'||m.policy!=='review_required'||m.model!==null||m.model_settings!==null||!sameJson(m.tools,[])||sourcePin(m).kind!=='committed_only'||m.source_snapshot!==null||['handoff','specialists','conversation','audit_checkpoint','changes_since_checkpoint','pip_memory','main_chat_request','workspace_context','event_trigger','event_occurrence','draft_automation'].some(k=>Object.hasOwn(m,k)))pulseFail();
 const job=m.job;
 if(!pulseKeys(job,'name,goal,source_ref,pip_type,model_choice,source_policy,verification_plan')||job.pip_type!=='pulse'||!sameJson(job.source_policy,{mode:'committed_only'})||!pulsePlan(job.verification_plan))pulseFail();
 for(const [k,max] of [['name',120],['goal',4000],['source_ref',200]])if(typeof job[k]!=='string'||!job[k]||job[k]!==job[k].trim()||[...job[k]].length>max||job[k].includes('\0')||[...job[k]].some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff))pulseFail();
 const choice=job.model_choice;
 if(!record(choice)||!(pulseKeys(choice,'mode')&&choice.mode==='default'||pulseKeys(choice,'mode,model')&&choice.mode==='model'&&pulseText(choice.model,256)&&/^[A-Za-z0-9_][A-Za-z0-9._:/@+\-]*$/.test(choice.model)&&!choice.model.includes('://'))||!sameJson(g.model,{invoked:false,choice}))pulseFail();
 for(const [k,prefix] of [['pip_id','pip'],['workspace_id','ws'],['binding_id','binding'],['runner_id','runner']])if(!pulseId(g[k],prefix)||g[k]!==m[k])pulseFail();
 if(!pulseId(g.approval_id,'approval')||!pulseInt(g.job_version,1,999999)||g.job_version!==m.job_version||!pulseInt(g.lifecycle_revision)||!['definition_digest','plan_digest','action_digest','binding_digest','digest'].every(k=>pulseHash(g[k]))||g.source_revision!==m.source_revision||m.policy_digest!==g.action_digest||g.trigger!==m.trigger) pulseFail();
 const r=g.request;
 if(g.trigger==='manual'){
  if(!pulseKeys(r,'kind,actor,key_digest,expected_version,expected_lifecycle_revision,expected_plan_digest')||r.kind!=='manual'||!pulseText(r.actor,128)||r.actor!==m.requested_by||!pulseHash(r.key_digest)||r.expected_version!==g.job_version||r.expected_lifecycle_revision!==g.lifecycle_revision||r.expected_plan_digest!==g.plan_digest||['schedule','scheduled_at','schedule_occurrence'].some(k=>Object.hasOwn(m,k)))pulseFail();
 }else if(g.trigger==='schedule'){
  if(!pulseKeys(r,'kind,policy,occurrence')||r.kind!=='schedule'||m.requested_by!=='local-scheduler'||!sameJson(automationSchedule(r.policy),m.schedule))pulseFail();
  const o=r.occurrence;if(!pulseKeys(o,'job_version,expected_next_due,scheduled_at,next_due_at,checked_at,anchor_at')||o.job_version!==g.job_version||!['expected_next_due','scheduled_at','checked_at','anchor_at'].every(k=>canonicalTime(o[k]))||!(o.next_due_at===null||canonicalTime(o.next_due_at))||o.scheduled_at!==m.scheduled_at)pulseFail();
  const anchor=Date.parse(o.anchor_at),first=Date.parse(o.expected_next_due),due=Date.parse(o.scheduled_at),checked=Date.parse(o.checked_at),next=o.next_due_at===null?null:Date.parse(o.next_due_at);
  if(!(anchor<first&&first<=due&&due<=checked)||next!==null&&next<=checked)pulseFail();
  if(r.policy.type==='once'){if(o.expected_next_due!==r.policy.at||o.scheduled_at!==r.policy.at||next!==null)pulseFail();}else if(next===null)pulseFail();
  if(r.policy.type==='interval'){const step=r.policy.minutes*60000;if((first-anchor)%step!==0||due!==anchor+Math.floor((checked-anchor)/step)*step||next!==due+step)pulseFail();}
 }else pulseFail();
 return g;
}
export function pulseVerificationReceipt(value,m,status){
 const g=pulseVerificationPin(m);if(!g)pulseFail();
 if(!pulseKeys(value,'schema_version,classification,grant_digest,plan_digest,model_invoked,snapshot,phase,terminal_reason,commands')||value.schema_version!==1||value.classification!=='reviewed_command_outcomes'||value.grant_digest!==g.digest||value.plan_digest!==g.plan_digest||value.model_invoked!==false||bytes(JSON.stringify(value))>65536)pulseFail();
 const snapshot=value.snapshot;
 if(snapshot!==null&&(!pulseKeys(snapshot,'sha256,files,bytes')||!pulseHash(snapshot.sha256)||!pulseInt(snapshot.files,0,10000)||!pulseInt(snapshot.bytes,0,67108864)))pulseFail();
 const terminal=['succeeded','failed','cancelled'].includes(status),stopped=['cancelled','timed_out','output_limit','resource_limit'];
 if(terminal){if(value.phase!=='terminal'||!['complete',...stopped,'interrupted','stale_grant','infrastructure_failure'].includes(value.terminal_reason)||(status==='succeeded')!==(value.terminal_reason==='complete')||(status==='cancelled')!==(value.terminal_reason==='cancelled'))pulseFail();}
 else if(!['queued','running','cancelling'].includes(status)||value.phase!=='running'||value.terminal_reason!==null)pulseFail();
 const tests=m.job.verification_plan.action.tests;
 if(!Array.isArray(value.commands)||value.commands.length!==tests.length)pulseFail();
 let blocked=false;
 for(const [i,c]of value.commands.entries()){
  if(!pulseKeys(c,'index,launch_state,outcome')||c.index!==i||!['not_started','launch_reserved','finished'].includes(c.launch_state)||blocked&&c.launch_state!=='not_started')pulseFail();
  if(c.launch_state==='finished'){
   const t=c.outcome,a=t?.artifact;
   if(snapshot===null||!pulseKeys(t,'index,argv,cwd,status,exit_code,output,output_truncated,artifact')||t.index!==i||!sameJson(t.argv,tests[i].argv)||t.cwd!==tests[i].cwd||!['passed','failed',...stopped].includes(t.status)||!(t.exit_code===null||pulseInt(t.exit_code,-128,255))||typeof t.output!=='string'||bytes(t.output)>4096||typeof t.output_truncated!=='boolean'||!pulseKeys(a,'path,sha256,bytes')||a.path!==`artifacts/test-${i+1}.txt`||!pulseHash(a.sha256)||!pulseInt(a.bytes,0,65536)||t.status==='passed'&&t.exit_code!==0||t.status==='failed'&&t.exit_code===0)pulseFail();
   if(t.exit_code===null&&(t.status!=='cancelled'||t.output||a.bytes))pulseFail();
   blocked=stopped.includes(t.status);
  }else{if(c.outcome!==null||c.launch_state==='launch_reserved'&&snapshot===null)pulseFail();blocked=true;}
 }
 if(value.terminal_reason==='complete'&&value.commands.some(c=>c.launch_state!=='finished'||!['passed','failed'].includes(c.outcome.status))||status==='queued'&&value.commands.some(c=>c.launch_state!=='not_started'))pulseFail();
 return value;
}
export function pulseCommandLabel(command){
 if(command.launch_state==='not_started'||command.launch_state==='finished'&&command.outcome.exit_code===null)return 'Didn’t run';
 if(command.launch_state==='launch_reserved')return 'Result unknown';
 return command.outcome.status==='passed'?'Passed':command.outcome.status==='failed'?'Failed':'Stopped';
}
export function pulseProgress(run){
 if(run?.execution_mode!=='standalone_plan')return null;
 const p=run.command_progress,terminal=['succeeded','failed','cancelled'].includes(run.status);
 if(!pulseKeys(p,'phase,terminal_reason,passed,failed,stopped,unexecuted,unknown,total')||!pulseInt(p.total,1,4)||!['passed','failed','stopped','unexecuted','unknown'].every(k=>pulseInt(p[k],0,p.total))||p.passed+p.failed+p.stopped+p.unexecuted+p.unknown!==p.total)return null;
 if(terminal){if(p.phase!=='terminal'||!['complete','cancelled','timed_out','interrupted','output_limit','resource_limit','stale_grant','infrastructure_failure'].includes(p.terminal_reason)||(run.status==='succeeded')!==(p.terminal_reason==='complete')||(run.status==='cancelled')!==(p.terminal_reason==='cancelled'))return null;}
 else if(!active(run.status)||p.phase!=='running'||p.terminal_reason!==null)return null;
 if(p.terminal_reason==='complete'&&p.passed+p.failed!==p.total)return null;
 return p;
}

/** A Pip's own Excluded folders (safe_source_v2, Pips API 50): 1-32 patterns in the .gitignore format that only leave things out. */
export const MAX_SOURCE_EXCLUDES=32;
export function sourceExcludeError(item){
 const value=typeof item==='string'?item.trim().replace(/^(?:\.\/)+/,''):'';
 if(!value)return 'Type a folder or pattern, like uploads/ or *.mp4.';
 if(value.length>200)return 'Use at most 200 characters.';
 if(/^[!#]/.test(value))return 'A pattern can only leave things out, so it can’t start with ! or #.';
 if(value.includes('\\')||/[\u0000-\u001f\u007f]/.test(value))return 'Use plain characters, without backslashes.';
 if(value.split('/').includes('..'))return 'Stay inside the project: no .. in the path.';
 if(!value.replace(/[/*]/g,''))return 'Name a folder or file pattern, not everything.';
 return '';
}
export function sourceExcludes(values){
 if(!Array.isArray(values)||values.length<1||values.length>MAX_SOURCE_EXCLUDES)throw new Error('List 1 to 32 folders or patterns to leave out.');
 const cleaned=[];
 for(const item of values){const why=sourceExcludeError(item);if(why)throw new Error(why);const value=item.trim().replace(/^(?:\.\/)+/,'');if(!cleaned.includes(value))cleaned.push(value);}
 return cleaned;
}
/** Committed source under either rule set, in its saved canonical form (event and automation pins). */
function committedPolicy(value){try{const p=sourcePolicy(value);return p.mode==='committed_only'&&sameJson(p,value);}catch{return false;}}
export function sourcePolicy(value){
 if(record(value)&&Object.keys(value).join()==='mode'&&value.mode==='personal')return {mode:'personal'};
 if(value===undefined||value==='committed_only')return {mode:'committed_only'};
 if(record(value)&&Object.keys(value).sort().join()==='mode'&&value.mode==='committed_only')return {mode:'committed_only'};
 if(record(value)&&Object.keys(value).sort().join()==='exclusions,mode'&&value.mode==='current_tree'&&value.exclusions==='safe_source_v1')return {mode:'current_tree',exclusions:'safe_source_v1'};
 // safe_source_v2 (Pips API 50): either source, with an optional Excluded folders list.
 const keys=record(value)?Object.keys(value).sort().join():'';
 if((keys==='exclusions,mode'||keys==='exclude,exclusions,mode')&&['committed_only','current_tree'].includes(value.mode)&&value.exclusions==='safe_source_v2'){
  const policy={mode:value.mode,exclusions:'safe_source_v2'};
  if(Object.hasOwn(value,'exclude')){const list=sourceExcludes(value.exclude);if(JSON.stringify(list)!==JSON.stringify(value.exclude))throw new Error('This Pip’s Excluded folders are not in their saved form. Refresh.');policy.exclude=list;}
  return policy;
 }
 throw new Error('This Pip reads code in a way this editor doesn’t know. Refresh, or update DGC.');
}
/** 'safe_source_v1' (the original rules), 'safe_source_v2', or null for a Personal Pip. */
export function sourceRules(value){const p=sourcePolicy(value);return p.mode==='personal'?null:p.exclusions==='safe_source_v2'?'safe_source_v2':'safe_source_v1';}
/** The policy to save: the same source with these Excluded folders under safe_source_v2 ([] keeps none). */
export function sourceWithExcludes(value,list){
 const p=sourcePolicy(value);if(p.mode==='personal')throw new Error('Personal Pips have no project source.');
 const next={mode:p.mode,exclusions:'safe_source_v2'};if(list.length)next.exclude=sourceExcludes(list);return sourcePolicy(next);
}
export function sourcePolicyLabel(value){try{if(sourcePolicy(value).mode==='personal')return 'Personal · no project access';return sourcePolicy(value).mode==='current_tree'?'Your current files · only when you ask':'Committed code';}catch{return 'Not supported here';}}
export function sourceSnapshot(value){
 const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
 if(record(value)&&value.exclusions==='safe_source_v2'){
  // safe_source_v2 receipts also count the files the copy skipped: up to 256 MiB copied, 100,000 entries looked at.
  if(Object.keys(value).sort().join()!=='bytes,consistency,excluded_directories,excluded_entries,exclusions,files,kind,schema_version,sha256,skipped_files'||value.schema_version!==2||value.kind!=='current_tree'||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||value.consistency!=='checked_non_atomic'||!integer(value.files,1,10000)||!integer(value.bytes,0,268435456)||!integer(value.excluded_entries,0,100000)||!integer(value.excluded_directories,0,value.excluded_entries)||!integer(value.skipped_files,0,100000)||value.files+value.excluded_entries+value.skipped_files>100000)throw new Error('The current-tree snapshot receipt is invalid.');
  return value;
 }
 if(!record(value)||Object.keys(value).sort().join()!=='bytes,consistency,excluded_directories,excluded_entries,exclusions,files,kind,schema_version,sha256'||value.schema_version!==1||value.kind!=='current_tree'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.sha256!=='string'||value.exclusions!=='safe_source_v1'||value.consistency!=='checked_non_atomic'||!integer(value.files,1,10000)||!integer(value.bytes,0,67108864)||!integer(value.excluded_entries,0,10000)||!integer(value.excluded_directories,0,value.excluded_entries)||value.files+value.excluded_entries>10000)throw new Error('The current-tree snapshot receipt is invalid.');
 return value;
}
const LEFT_OUT_REASONS={too_large:'over the 4 MiB per-file limit',link:'a symbolic link',hard_link:'a hard-linked file',special:'not a regular file',submodule:'a submodule',unsupported_name:'a name DGC can’t copy safely',too_deep:'nested deeper than 32 folders',other_filesystem:'on another filesystem',secret:'holds one of your configured secrets'};
const LEFT_OUT_RULES={gitignore:'the project’s ignore files',dgcignore:'.dgcignore',pip:'Excluded folders'};
/** What a safe_source_v2 copy skipped or left out (get_pip_run_source, check_pip_source), checked. */
export function sourceLeftOut(value){
 const fail=()=>{throw new Error('The record of what this copy left out is invalid.');};
 const count=v=>Number.isSafeInteger(v)&&v>=0;
 if(!record(value)||Object.keys(value).sort().join()!=='excluded,excluded_count,omitted,rules,schema_version,skipped,skipped_bytes,skipped_count'||value.schema_version!==1||value.rules!=='safe_source_v2'||!Array.isArray(value.skipped)||!Array.isArray(value.excluded)||value.skipped.length+value.excluded.length>400||!count(value.skipped_count)||!count(value.skipped_bytes)||!count(value.omitted)||!record(value.excluded_count)||Object.keys(value.excluded_count).sort().join()!=='dgcignore,fixed,gitignore,pip'||!Object.values(value.excluded_count).every(count))fail();
 for(const item of value.skipped)if(!record(item)||Object.keys(item).filter(k=>k!=='bytes').sort().join()!=='path,reason'||typeof item.path!=='string'||!item.path||item.path.length>300||!Object.hasOwn(LEFT_OUT_REASONS,item.reason)||Object.hasOwn(item,'bytes')&&!count(item.bytes))fail();
 for(const item of value.excluded)if(!record(item)||Object.keys(item).filter(k=>k!=='files'&&k!=='bytes').sort().join()!=='path,rule'||typeof item.path!=='string'||!item.path||item.path.length>301||!Object.hasOwn(LEFT_OUT_RULES,item.rule)||Object.hasOwn(item,'files')!==Object.hasOwn(item,'bytes')||Object.hasOwn(item,'files')&&(!count(item.files)||!count(item.bytes)))fail();
 return value;
}
export const sizeText=n=>n>=1048576?(n/1048576).toFixed(1)+' MiB':n>=1024?Math.round(n/1024)+' KiB':n+' bytes';
/** Plain lines for a left-out record: skipped files and why, then what the rules left out. */
export function leftOutLines(value){
 const v=sourceLeftOut(value),lines=[];
 for(const item of v.skipped)lines.push(`${item.path} · skipped, ${LEFT_OUT_REASONS[item.reason]}${Object.hasOwn(item,'bytes')?' ('+sizeText(item.bytes)+')':''}`);
 for(const item of v.excluded)lines.push(`${item.path} · left out by ${LEFT_OUT_RULES[item.rule]}${Object.hasOwn(item,'files')?` (${item.files} files, ${sizeText(item.bytes)})`:''}`);
 if(v.excluded_count.fixed)lines.push(`${v.excluded_count.fixed} more left out by DGC’s fixed rules (credentials, version control, dependencies, caches, build output)`);
 if(v.omitted)lines.push(`${v.omitted} more not listed`);
 return lines;
}
/** check_pip_source's answer, checked for what the Source section shows. */
export function sourceCheck(value){
 const fail=()=>{throw new Error('The source check is invalid.');};
 const count=v=>Number.isSafeInteger(v)&&v>=0;
 if(!record(value)||typeof value.applies!=='boolean'||typeof value.fits!=='boolean'||!count(value.files)||!count(value.bytes)||!Array.isArray(value.biggest_folders)||value.biggest_folders.length>5||!(value.message===null||typeof value.message==='string'&&value.message.length<=4000))fail();
 for(const item of value.biggest_folders)if(!record(item)||typeof item.path!=='string'||!count(item.bytes)||!count(item.files))fail();
 if(value.left_out!=null)sourceLeftOut(value.left_out);
 if(value.applies&&(!record(value.limits)||!count(value.limits.bytes)||!count(value.limits.entries)))fail();
 return value;
}
export function sourcePin(value){
 if(!record(value))throw new Error('Source identity was not recorded.');
 const policy=sourcePolicy(value.source_policy);
 if(policy.mode==='personal'){if(value.source_revision!==null||value.source_snapshot!==null)throw Error('Personal jobs cannot contain project source.');return {kind:'personal',revision:null,snapshot:null};}
 if(policy.mode==='current_tree'){
  if(value.source_revision!==null)throw new Error('A working-tree snapshot cannot claim a Git commit identity.');
  return {kind:'current_tree',revision:null,snapshot:sourceSnapshot(value.source_snapshot)};
 }
 if(value.source_snapshot!=null||typeof value.source_revision!=='string'||!value.source_revision||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.source_revision))throw new Error('The committed source identity is invalid.');
 return {kind:'committed_only',revision:value.source_revision,snapshot:null};
}

export function findingContextEntry(entry){
 const p=entry?.provenance,fail=()=>{throw new Error('The current-tree finding provenance is invalid.');};
 if(entry?.kind!=='finding'||!record(p)||p.schema_version!==2||Object.keys(p).sort().join()!=='classification,evidence,finding_index,job_version,line,model,path,pip_id,run_id,schema_version,severity,source,source_policy,source_revision,source_snapshot,verification'||p.source!=='pip_finding'||p.classification!=='model_assessment'||p.verification!=='source_excerpt_only'||p.evidence!==entry.content||typeof p.evidence!=='string'||new TextEncoder().encode(p.evidence).length>4096||!['pip_id','run_id','model'].every(k=>typeof p[k]==='string'&&p[k])||!Number.isSafeInteger(p.job_version)||p.job_version<1||p.job_version>999999||!Number.isSafeInteger(p.finding_index)||p.finding_index<0||p.finding_index>15||!Number.isSafeInteger(p.line)||p.line<1||p.line>1000000||!['low','medium','high','critical'].includes(p.severity)||typeof p.path!=='string'||!p.path||p.path.startsWith('/')||p.path.split('/').includes('..')||/[\\:]/.test(p.path))fail();
 sourcePin(p);return entry;
}

export function sourceResult(manifest,result){
 const pin=sourcePin(manifest);if(pin.kind==='current_tree'){
  const s=result?.snapshot;if(!record(s)||Object.keys(s).sort().join()!=='bytes,files,sha256'||s.sha256!==pin.snapshot.sha256||s.files!==pin.snapshot.files||s.bytes!==pin.snapshot.bytes)throw new Error('The report snapshot does not match its pinned working-tree receipt.');
 }return pin;
}

// Session statements are authored claims. Their selected source is not execution provenance.
export const SESSION_STATEMENT_NOTICE='User-reviewed statement; execution was not verified. The source reference was selected for this statement, not recorded as the source used by a command. This grants no tools, permissions or execution.\n\n';
const outcomeKeys=['id','workspace_id','session','title','statement','source_reference','classification','verification','created_at','created_by'];
const exactOutcome=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const outcomeId=(v,p)=>typeof v==='string'&&v.length===p.length+33&&new RegExp('^'+p+'_[0-9a-f]{32}$').test(v);
const sessionId=v=>typeof v==='string'&&!/[\r\n]/.test(v)&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(v);
const outcomeInt=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function outcomeText(v,max,multiline=false){return typeof v==='string'&&v.length<=max&&!!v.trim()&&!Array.from(v).some(c=>{const n=c.codePointAt(0);return n>=0xd800&&n<=0xdfff||n<32&&!(multiline&&'\n\r\t'.includes(c));})&&new TextEncoder().encode(v).length<=max;}
export function sessionGeneration(v){if(!exactOutcome(v,['id','revision','sha256','bytes'])||!sessionId(v.id)||!outcomeInt(v.revision)||typeof v.sha256!=='string'||v.sha256.length!==64||!/^[0-9a-f]{64}$/.test(v.sha256)||!outcomeInt(v.bytes,1,8388608))throw Error('The inspected session generation is invalid. Inspect the saved session again.');return v;}
export function sessionSourceSelection(v){if(exactOutcome(v,['kind','revision'])&&v.kind==='commit'&&typeof v.revision==='string'&&[40,64].includes(v.revision.length)&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v.revision))return v;if(exactOutcome(v,['kind','run_id'])&&v.kind==='pip_run'&&outcomeId(v.run_id,'run'))return v;throw Error('Select an exact Git commit or a completed Pip run ID. A source reference is not execution evidence.');}
export function sessionStatementPayload(v,workspace){
 if(!exactOutcome(v,outcomeKeys)||!outcomeId(v.id,'outcome')||!outcomeId(v.workspace_id,'ws')||(workspace!==undefined&&v.workspace_id!==workspace)||v.classification!=='user_reviewed_statement'||v.verification!=='not_execution_verified'||!outcomeText(v.title,240)||!outcomeText(v.statement,1536,true)||!outcomeText(v.created_at,40)||!outcomeText(v.created_by,128)||new TextEncoder().encode(JSON.stringify(v)).length>8192)throw Error('The saved session statement is invalid or belongs to another workspace.');
 sessionGeneration(v.session);const r=v.source_reference;if(!exactOutcome(r,['selection','source_policy','source_revision','source_snapshot','relation'])||r.relation!=='selected_for_statement')throw Error('A session statement must label its source as selected, not used by execution.');const selected=sessionSourceSelection(r.selection),pin=sourcePin(r);if(selected.kind==='commit'&&(pin.kind!=='committed_only'||r.source_revision!==selected.revision))throw Error('The selected commit differs from the saved source reference.');return v;
}
export function sessionStatement(v,workspace){
 if(!exactOutcome(v,[...outcomeKeys,'digest','status','reviewed_at','reviewed_by','entry_id'])||typeof v.digest!=='string'||v.digest.length!==64||!/^[0-9a-f]{64}$/.test(v.digest)||!['pending','accepted','rejected'].includes(v.status))throw Error('The statement review is invalid. Refresh its saved proposal.');
 sessionStatementPayload(Object.fromEntries(outcomeKeys.map(k=>[k,v[k]])),workspace);
 if(v.status==='pending'?[v.reviewed_at,v.reviewed_by,v.entry_id].some(x=>x!==null):!outcomeText(v.reviewed_at,40)||!outcomeText(v.reviewed_by,128)||(v.status==='accepted'?!outcomeId(v.entry_id,'ctx'):v.entry_id!==null))throw Error('The statement review contains an invalid resolution receipt.');return v;
}
export function sessionStatementsPage(v,workspace){if(!exactOutcome(v,['workspace_id','proposals','next_before_id'])||v.workspace_id!==workspace||!Array.isArray(v.proposals)||v.proposals.length>20||!(v.next_before_id===null||outcomeInt(v.next_before_id,1,Number.MAX_SAFE_INTEGER))||v.next_before_id!==null&&!v.proposals.length)throw Error('Statement history is invalid. Refresh before retrying.');const ids=new Set();for(const p of v.proposals){sessionStatement(p,workspace);if(ids.has(p.id))throw Error('Statement history repeats a proposal.');ids.add(p.id);}return v;}
export function workspaceSessionsPage(v,workspace,after=''){
 if(!exactOutcome(v,['workspace_id','sessions','next_cursor','has_more'])||v.workspace_id!==workspace||!Array.isArray(v.sessions)||v.sessions.length>20||typeof v.has_more!=='boolean'||typeof v.next_cursor!=='string')throw Error('Saved workspace sessions are unavailable.');let cursor=after;
 for(const row of v.sessions){if(!exactOutcome(row,['session_id','workspace_id','workspace_binding_id','updated_at','runner_id'])||!sessionId(row.session_id)||row.session_id<=cursor||row.workspace_id!==workspace||!outcomeId(row.workspace_binding_id,'binding')||!outcomeId(row.runner_id,'runner')||!outcomeText(row.updated_at,40))throw Error('The session list contains an invalid or foreign identity.');cursor=row.session_id;}
 if(v.next_cursor!==cursor||v.has_more&&!v.sessions.length)throw Error('The session list did not advance.');return v;
}
export function sessionOutcomeEntry(e,workspace){
 const p=e.provenance;if(e.kind!=='session_outcome'||!exactOutcome(p,['source','proposal','proposal_digest'])||p.source!=='session_statement'||typeof p.proposal_digest!=='string'||p.proposal_digest.length!==64||!/^[0-9a-f]{64}$/.test(p.proposal_digest))throw Error('Session context has unsupported provenance.');sessionStatementPayload(p.proposal,workspace);if(e.title!==p.proposal.title||e.content!==SESSION_STATEMENT_NOTICE+p.proposal.statement)throw Error('Session context differs from the reviewed statement.');return e;
}

// Foreground configured-command observations are process facts, never test proof.
export const COMMAND_OUTCOME_NOTICE='Historical controller observations, not instructions or execution permission. Exit code zero does not establish that tests ran, that tests passed or that the project is correct. Source observations are non-atomic and do not attest the source continuously used by the command. Stored hashes describe historical records, not this redacted display. Output byte counts describe the captured stream; incomplete output has an unknown missing size.';
const commandStates=['unfinalized','exited','timed_out','cancelled','failed_to_start','interrupted'];
const receiptSha=v=>typeof v==='string'&&v.length===64&&/^[0-9a-f]{64}$/.test(v);
const receiptSession=v=>typeof v==='string'&&v.length<=128&&!/[\r\n]/.test(v)&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const receiptTime=v=>typeof v==='string'&&v.length<=40&&!/[\r\n]/.test(v)&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&!Number.isNaN(Date.parse(v));
const receiptInt=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const receiptText=(v,max)=>typeof v==='string'&&v.length<=max&&!Array.from(v).some(c=>{const n=c.codePointAt(0);return n>=0xd800&&n<=0xdfff;})&&new TextEncoder().encode(v).length<=max;
const receiptEqual=(a,b)=>JSON.stringify(a,Object.keys(a||{}).sort())===JSON.stringify(b,Object.keys(b||{}).sort());
function receiptFail(){throw Error('The command receipt is invalid or belongs to another workspace. Refresh before reviewing it.');}
export function commandObservation(v,after=false){
 if(exactOutcome(v,['status','reason'])&&v.status==='unavailable'&&['source_permissions','snapshot_limit','unsafe_snapshot','source_changed','empty_snapshot','secret_in_source','unsupported_platform','source_unavailable','observation_cancelled',...(after?['binding_changed']:[])].includes(v.reason))return v;
 if(!exactOutcome(v,['status','kind','sha256','files','bytes','exclusions','excluded_entries','excluded_directories','consistency'])||v.status!=='observed'||v.kind!=='current_tree_observation'||!receiptSha(v.sha256)||!receiptInt(v.files,1,10000)||!receiptInt(v.bytes,0,67108864)||!receiptInt(v.excluded_entries,0,10000)||!receiptInt(v.excluded_directories,0,v.excluded_entries)||v.files+v.excluded_entries>10000||v.exclusions!=='safe_source_v1'||v.consistency!=='checked_non_atomic')receiptFail();return v;
}
function commandComparison(before,after,value){commandObservation(before);commandObservation(after,true);const expected=before.status==='observed'&&after.status==='observed'?(receiptEqual(before,after)?'unchanged_observation':'changed_observation'):'unavailable';if(value!==expected)receiptFail();}
function commandFacts(v){
 if(!exactOutcome(v,['state','exit_code','duration_ms','output_sha256','output_bytes','preview_bytes','omitted_bytes','output_complete','started_at','ended_at','output_digest_kind'])||!commandStates.slice(1).includes(v.state)||!(v.exit_code===null||receiptInt(v.exit_code,-2147483648,2147483647))||(v.state==='exited'&&v.exit_code===null)||(v.state==='failed_to_start'&&v.exit_code!==null)||!['duration_ms','output_bytes','omitted_bytes'].every(k=>receiptInt(v[k]))||!receiptInt(v.preview_bytes,0,4096)||v.preview_bytes+v.omitted_bytes!==v.output_bytes||typeof v.output_complete!=='boolean'||!receiptSha(v.output_sha256)||v.output_digest_kind!=='decoded_redacted_utf8'||!receiptTime(v.ended_at))receiptFail();
 const emptyHash='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
 if(v.output_bytes===0&&v.output_sha256!==emptyHash)receiptFail();if(v.state==='failed_to_start'?(v.started_at!==null||v.output_bytes!==0||v.preview_bytes!==0):!receiptTime(v.started_at))receiptFail();return v;
}
export function commandRecording(v){if(!exactOutcome(v,['id','status','created_revision','created_at','created_by'])||!outcomeId(v.id,'ctx')||!['active','archived'].includes(v.status)||!receiptInt(v.created_revision,1,2147483647)||!receiptTime(v.created_at)||!outcomeText(v.created_by,128))receiptFail();return v;}
export function commandReceiptsPage(v,workspace,session=null){
 if(!exactOutcome(v,['workspace_id','session_id','receipts','next_before_id','has_more','total_in_scope','retention_limit'])||v.workspace_id!==workspace||!outcomeId(v.workspace_id,'ws')||v.session_id!==session||!(session===null||receiptSession(session))||!Array.isArray(v.receipts)||v.receipts.length>20||typeof v.has_more!=='boolean'||v.retention_limit!==10000||!receiptInt(v.total_in_scope,0,10000)||v.receipts.length>v.total_in_scope||!(v.next_before_id===null||outcomeId(v.next_before_id,'exec'))||new TextEncoder().encode(JSON.stringify(v)).length>49152)receiptFail();
 const seen=new Set();let previous=null;
 for(const r of v.receipts){if(!exactOutcome(r,['id','workspace_id','session_id','created_at','state','exit_code','command_preview','command_truncated','redacted','recording'])||!outcomeId(r.id,'exec')||r.workspace_id!==workspace||!receiptSession(r.session_id)||session!==null&&r.session_id!==session||!receiptTime(r.created_at)||!commandStates.includes(r.state)||!(r.exit_code===null||receiptInt(r.exit_code,-2147483648,2147483647))||(r.state==='exited'&&r.exit_code===null)||(['unfinalized','failed_to_start'].includes(r.state)&&r.exit_code!==null)||!receiptText(r.command_preview,256)||typeof r.command_truncated!=='boolean'||typeof r.redacted!=='boolean'||seen.has(r.id)||previous&&(r.created_at>previous.created_at||r.created_at===previous.created_at&&r.id>=previous.id))receiptFail();if(r.recording!==null)commandRecording(r.recording);seen.add(r.id);previous=r;}
 if(v.has_more?(!v.receipts.length||v.next_before_id!==v.receipts.at(-1).id):v.next_before_id!==null)receiptFail();return v;
}
export function commandReceipt(v,workspace,attempt){
 if(!exactOutcome(v,['schema_version','id','workspace_id','session_id','turn_id','session_revision_at_attempt','created_at','finalized_at','kind','state','attempt_digest','final_digest','command','source_before','source_after','source_comparison','facts','output_preview','projection','view_digest','recording','can_record','record_blocked_reason'])||v.schema_version!==1||!outcomeId(v.id,'exec')||attempt!==undefined&&v.id!==attempt||v.workspace_id!==workspace||!outcomeId(v.workspace_id,'ws')||!receiptSession(v.session_id)||!outcomeId(v.turn_id,'turn')||!receiptInt(v.session_revision_at_attempt)||!receiptTime(v.created_at)||v.kind!=='configured_verifier'||!commandStates.includes(v.state)||!receiptSha(v.attempt_digest)||!receiptSha(v.view_digest)||!exactOutcome(v.command,['text','sha256','digest_kind','redacted'])||!receiptText(v.command.text,32768)||!receiptSha(v.command.sha256)||v.command.digest_kind!=='original_utf8'||typeof v.command.redacted!=='boolean'||!exactOutcome(v.projection,['kind','redacted','notice'])||v.projection.kind!=='redacted_historical_reference'||typeof v.projection.redacted!=='boolean'||v.projection.notice!==COMMAND_OUTCOME_NOTICE||typeof v.can_record!=='boolean'||new TextEncoder().encode(JSON.stringify({workspace_id:workspace,receipt:v})).length>32768)receiptFail();
 commandObservation(v.source_before);if(v.recording!==null)commandRecording(v.recording);
 if(v.state==='unfinalized'){if(v.recording!==null||[v.finalized_at,v.final_digest,v.source_after,v.source_comparison,v.facts,v.output_preview].some(x=>x!==null)||v.can_record||v.record_blocked_reason!=='unfinalized'||v.projection.redacted!==v.command.redacted)receiptFail();}
 else{commandFacts(v.facts);commandComparison(v.source_before,v.source_after,v.source_comparison);if(v.facts.state!==v.state||!receiptTime(v.finalized_at)||!receiptSha(v.final_digest)||!exactOutcome(v.output_preview,['text','redacted'])||!receiptText(v.output_preview.text,32768)||typeof v.output_preview.redacted!=='boolean'||v.projection.redacted!==(v.command.redacted||v.output_preview.redacted)||v.record_blocked_reason!==(v.recording?.status==='active'?'already_recorded':null)||v.can_record!==(v.record_blocked_reason===null))receiptFail();}return v;
}
export function commandOutcomeContent(p){const f=p.facts,outcome=f.state==='failed_to_start'?'failed to start':f.exit_code!==null?`${f.state}; native exit code ${f.exit_code}`:f.state;return `Historical configured command outcome for ${p.attempt_id}: ${outcome}.\nCaptured output: ${f.output_bytes} decoded/redacted UTF-8 bytes; output complete: ${f.output_complete?'yes':'no'}. Output prose is not included.\nSource comparison: ${p.source_comparison}; observations are checked and non-atomic.\nThis human-recorded outcome does not establish that tests ran or passed, or that the project is correct. Source observations do not attest the source continuously used by the command. Stored record and output hashes describe historical bytes, not this redacted context. No command is executed or authorized by this record; later source and circumstances may differ.`;}
export function commandOutcomeEntry(e,workspace){
 const p=e?.provenance;if(e?.kind!=='command'||!exactOutcome(p,['schema_version','source','classification','verification','workspace_id','attempt_id','session_id','turn_id','session_revision_at_attempt','attempt_digest','final_digest','view_digest','command','facts','source_before','source_after','source_comparison'])||p.schema_version!==1||p.source!=='session_execution'||p.classification!=='controller_observed_execution'||p.verification!=='native_process_facts_only'||!outcomeId(p.workspace_id,'ws')||workspace!==undefined&&p.workspace_id!==workspace||!outcomeId(p.attempt_id,'exec')||!outcomeId(p.turn_id,'turn')||!receiptSession(p.session_id)||!receiptInt(p.session_revision_at_attempt)||!['attempt_digest','final_digest','view_digest'].every(k=>receiptSha(p[k]))||!exactOutcome(p.command,['preview','truncated','redacted','sha256','digest_kind'])||!receiptText(p.command.preview,256)||typeof p.command.truncated!=='boolean'||typeof p.command.redacted!=='boolean'||!receiptSha(p.command.sha256)||p.command.digest_kind!=='original_utf8')receiptFail();commandFacts(p.facts);commandComparison(p.source_before,p.source_after,p.source_comparison);if(e.title!=='Recorded configured command outcome'||e.content!==commandOutcomeContent(p)||new TextEncoder().encode(JSON.stringify(e)).length>6144)receiptFail();return e;
}

// Presentation only: the persisted canonical record remains exact and validated.
export function commandOutcomeSummary(entry){
 const p=commandOutcomeEntry(entry).provenance,f=p.facts;
 return {
  qualifier:'What happened when a session ran its check command. Not a test result.',
  outcome:`${outcomeWords(f.state)}${f.exit_code===null?'':` · exit ${f.exit_code}`} · ${f.duration_ms} ms`,
  output:`${f.output_bytes} bytes${f.output_complete?'':' · some output missing'}`,
  source:p.source_comparison==='unchanged_observation'?'Files looked the same before and after':p.source_comparison==='changed_observation'?'Files changed while it ran':'Couldn’t compare the files',
 };
}

const NOTIFICATION_WORDS={job_update:'A change is waiting for you',schedule_update:'A schedule change is waiting for you',handoff:'A handoff is waiting for you',session_outcome:'A session statement is waiting for you',run:'A run failed'};
/** A notification's title in words. The stored title stays exactly as DGC sends it (checked below). */
export const notificationWords = n => NOTIFICATION_WORDS[n?.source_kind] || n?.title || 'Notification';
const NOTIFICATION_TITLES={job_update:'Pip job update needs review',schedule_update:'Pip schedule update needs review',handoff:'Pip handoff needs review',session_outcome:'Session statement needs review',run:'Pip run failed'};
const notificationInteger=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const notificationDate=v=>typeof v==='string'&&v.length<=40&&!/[\r\n]/.test(v)&&!Number.isNaN(Date.parse(v));
function invalidNotification(){throw Error('Notification metadata is invalid or belongs to another workspace. Refresh the computer connection.');}
export function pipNotification(value,workspace=null){
 const v=value;if(!exactOutcome(v,['id','seq','workspace_id','pip_id','kind','source_kind','reference','title','occurred_at','created_at','read_at','read_by','revision','source_status','actionable'])||!outcomeId(v.id,'notification')||!outcomeId(v.workspace_id,'ws')||workspace!==null&&v.workspace_id!==workspace||!notificationInteger(v.seq,1)||typeof v.source_kind!=='string'||!Object.hasOwn(NOTIFICATION_TITLES,v.source_kind)||v.title!==NOTIFICATION_TITLES[v.source_kind]||v.kind!==(v.source_kind==='run'?'run_failed':'needs_review')||!notificationDate(v.occurred_at)||!notificationDate(v.created_at)||![0,1].includes(v.revision)||typeof v.actionable!=='boolean')invalidNotification();
 if(v.revision===0?(v.read_at!==null||v.read_by!==null):(!notificationDate(v.read_at)||typeof v.read_by!=='string'||!v.read_by.trim()||bytes(v.read_by)>128||/[\x00-\x1f\x7f]/.test(v.read_by)))invalidNotification();
 const r=v.reference,kind=v.source_kind,statuses=kind==='run'?['queued','running','cancelling','succeeded','failed','cancelled']:kind==='handoff'?['pending','accepted','rejected','expired']:kind==='session_outcome'?['pending','accepted','rejected']:['pending','approved','rejected','expired','superseded'];
 if(![...statuses,'unavailable'].includes(v.source_status)||v.actionable!==(v.source_status===(kind==='run'?'failed':'pending')))invalidNotification();
 if(kind==='session_outcome'){if(v.pip_id!==null||!exactOutcome(r,['proposal_id'])||!outcomeId(r.proposal_id,'outcome'))invalidNotification();}
 else{if(!outcomeId(v.pip_id,'pip'))invalidNotification();if(kind==='handoff'){if(!exactOutcome(r,['handoff_id','target_pip_id'])||!outcomeId(r.handoff_id,'handoff')||r.target_pip_id!==v.pip_id)invalidNotification();}else if(kind==='run'){if(!exactOutcome(r,['run_id','pip_id'])||!outcomeId(r.run_id,'run')||r.pip_id!==v.pip_id)invalidNotification();}else if(!exactOutcome(r,['approval_id','proposal_id','pip_id'])||!outcomeId(r.approval_id,'approval')||!outcomeId(r.proposal_id,'proposal')||r.pip_id!==v.pip_id)invalidNotification();}
 return v;
}
export function notificationsPage(value,workspace=null){
 const v=value;if(!exactOutcome(v,['runner_id','workspace_id','notifications','unread_count','retained_count','oldest_seq','next_before_seq','has_more','retention_limit','evicted_total','unavailable_sources_total','history_may_be_incomplete','sync_pending','sync_scanned'])||!outcomeId(v.runner_id,'runner')||v.workspace_id!==workspace||!Array.isArray(v.notifications)||v.notifications.length>20||!notificationInteger(v.retained_count,0,500)||!notificationInteger(v.unread_count,0,v.retained_count)||v.retention_limit!==500||!notificationInteger(v.evicted_total)||!notificationInteger(v.unavailable_sources_total)||typeof v.history_may_be_incomplete!=='boolean'||typeof v.sync_pending!=='boolean'||!notificationInteger(v.sync_scanned,0,100)||typeof v.has_more!=='boolean'||!(v.oldest_seq===null||notificationInteger(v.oldest_seq,1))||(v.retained_count===0)!==(v.oldest_seq===null)||!(v.next_before_seq===null||notificationInteger(v.next_before_seq,1))||v.has_more!==(v.next_before_seq!==null)||v.notifications.length>v.retained_count||(v.evicted_total>0||v.unavailable_sources_total>0)&&!v.history_may_be_incomplete)invalidNotification();
 let previous=Infinity;const ids=new Set();for(const n of v.notifications){pipNotification(n,workspace);if(n.seq>=previous||n.seq<v.oldest_seq||ids.has(n.id))invalidNotification();previous=n.seq;ids.add(n.id);}
 if(v.has_more&&v.next_before_seq!==v.notifications.at(-1)?.seq||v.notifications.filter(n=>n.revision===0).length>v.unread_count)invalidNotification();return v;
}
export function notificationNavigation(v){pipNotification(v);return v.source_kind==='session_outcome'?{pip:'',section:'context',reviewKind:'session_outcome',review:v.reference.proposal_id}:v.source_kind==='run'?{pip:v.pip_id,section:'runs',run:v.reference.run_id}:v.source_kind==='handoff'?{pip:v.pip_id,section:'handoffs',reviewKind:'handoff',review:v.reference.handoff_id}:{pip:v.pip_id,section:'revisions',reviewKind:v.source_kind,review:v.reference.proposal_id};}

export const PIP_MEMORY_NOTICE='An exception tells this Pip a finding is fine. It doesn’t hide or close the finding, confirm the model was right, add to shared context, or let the Pip run anything.';
const memoryHash=v=>typeof v==='string'&&v.length===64&&/^[0-9a-f]{64}$/.test(v);
const memoryTime=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString()===v;
const memoryInt=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const memorySourceKeys=['run_id','checkpoint_id','finding_index','finding_id','finding_identity','finding','context_reference','finding_review_revision','job_version','source_policy','source_revision','source_snapshot'];
const memoryBodyKeys=['schema_version','id','pip_id','workspace_id','kind','source','reason','created_at','created_by','expires_at','classification','verification','effect'];
const memoryJson=v=>JSON.stringify(v,(_k,x)=>record(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function memoryInvalid(){throw Error('Pip exception metadata is invalid, unsupported, or belongs to another source. Refresh before reviewing.');}
function memoryPinSource(v){if(!exactOutcome(v,['source_policy','source_revision','source_snapshot']))memoryInvalid();sourcePin(v);return v;}
const memorySourcePin=v=>({source_policy:v.source_policy,source_revision:v.source_revision,source_snapshot:v.source_snapshot});
export function pipExceptionSource(v){
 if(!exactOutcome(v,memorySourceKeys)||!outcomeId(v.run_id,'run')||!memoryInt(v.checkpoint_id,1)||!memoryInt(v.finding_index,0,15)||typeof v.finding_id!=='string'||v.finding_id.length!==72||!/^finding_[0-9a-f]{64}$/.test(v.finding_id)||!memoryHash(v.finding_identity)||!memoryInt(v.finding_review_revision,0,100)||!memoryInt(v.job_version,1)||bytes(JSON.stringify(v))>6144)memoryInvalid();
 const f=v.finding;if(!exactOutcome(f,['title','severity','path','line','evidence','verification'])||!outcomeText(f.title,800)||!['low','medium','high','critical'].includes(f.severity)||!outcomeText(f.path,4096)||/[\\:]/.test(f.path)||f.path.startsWith('/')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||!memoryInt(f.line,1,1000000)||!outcomeText(f.evidence,4000,true)||f.verification!=='source_excerpt_only')memoryInvalid();
 if(v.context_reference!==null&&(!exactOutcome(v.context_reference,['revision','digest'])||!memoryInt(v.context_reference.revision)||!memoryHash(v.context_reference.digest)))memoryInvalid();memoryPinSource(memorySourcePin(v));return v;
}
export function pipExceptionSourceEqual(a,b){pipExceptionSource(a);pipExceptionSource(b);return memoryJson(a)===memoryJson(b);}
export function pipExceptionCandidate(v,pip,workspace){if(!exactOutcome(v,['pip_id','workspace_id','source','digest'])||v.pip_id!==pip||v.workspace_id!==workspace||!outcomeId(pip,'pip')||!outcomeId(workspace,'ws')||!memoryHash(v.digest))memoryInvalid();pipExceptionSource(v.source);return v;}
export function pipMemory(v,pip,workspace){
 if(!exactOutcome(v,[...memoryBodyKeys,'digest','status','revision','revoked_at','revoked_by','revoke_reason'])||v.schema_version!==1||!outcomeId(v.id,'memory')||!outcomeId(v.pip_id,'pip')||!outcomeId(v.workspace_id,'ws')||pip!==undefined&&v.pip_id!==pip||workspace!==undefined&&v.workspace_id!==workspace||v.kind!=='finding_exception'||v.classification!=='user_recorded_exception'||v.verification!=='not_execution_verified'||v.effect!=='reference_only'||!outcomeText(v.reason,1000,true)||!outcomeText(v.created_by,128)||!memoryTime(v.created_at)||!memoryHash(v.digest)||bytes(JSON.stringify(Object.fromEntries(memoryBodyKeys.map(k=>[k,v[k]]))))>6144)memoryInvalid();pipExceptionSource(v.source);
 if(v.expires_at!==null&&(!memoryTime(v.expires_at)||v.expires_at<=v.created_at))memoryInvalid();
 if(v.status==='active'){if(v.revision!==0||[v.revoked_at,v.revoked_by,v.revoke_reason].some(x=>x!==null))memoryInvalid();}
 else if(v.status==='revoked'){if(v.revision!==1||!memoryTime(v.revoked_at)||v.revoked_at<v.created_at||!outcomeText(v.revoked_by,128)||!outcomeText(v.revoke_reason,1000,true))memoryInvalid();}else memoryInvalid();return v;
}
export function pipMemoriesPage(v,pip,workspace){if(!exactOutcome(v,['pip_id','workspace_id','memories','next_before_id'])||v.pip_id!==pip||v.workspace_id!==workspace||!Array.isArray(v.memories)||v.memories.length>20||!(v.next_before_id===null||memoryInt(v.next_before_id,1))||v.next_before_id!==null&&!v.memories.length||bytes(JSON.stringify(v))>65536)memoryInvalid();const ids=new Set();for(const m of v.memories){pipMemory(m,pip,workspace);if(ids.has(m.id))memoryInvalid();ids.add(m.id);}return v;}
export function pipMemoryPin(v,run){
 if(record(v)&&v.schema_version===2)return pipTypedMemoryPin(v,run);
 if(!exactOutcome(v,['schema_version','pip_id','workspace_id','source','job_version','as_of','total_records','revoked_records','expired_records','eligible_records','omitted_records','entries','digest'])||v.schema_version!==1||v.pip_id!==run.pip_id||v.workspace_id!==run.workspace_id||!memoryInt(v.job_version,1)||v.job_version!==run.manifest?.job_version||!memoryTime(v.as_of)||!memoryHash(v.digest)||bytes(JSON.stringify(v))>8192)memoryInvalid();memoryPinSource(v.source);if(memoryJson(v.source)!==memoryJson(memorySourcePin(run.manifest)))memoryInvalid();
 for(const k of ['total_records','revoked_records','expired_records'])if(!memoryInt(v[k],0,1000))memoryInvalid();for(const k of ['eligible_records','omitted_records'])if(!memoryInt(v[k],0,32))memoryInvalid();if(!Array.isArray(v.entries)||v.entries.length>16||v.total_records!==v.eligible_records+v.revoked_records+v.expired_records||v.entries.length+v.omitted_records!==v.eligible_records)memoryInvalid();
 const ids=new Set();for(const e of v.entries){if(!exactOutcome(e,['memory','applicability']))memoryInvalid();const m=pipMemory(e.memory,v.pip_id,v.workspace_id);if(ids.has(m.id)||m.status!=='active'||m.created_at>v.as_of||m.expires_at!==null&&m.expires_at<=v.as_of)memoryInvalid();ids.add(m.id);const sameSource=memoryJson(memorySourcePin(m.source))===memoryJson(v.source),sameJob=m.source.job_version===v.job_version,expected=sameSource?(sameJob?'exact_source_and_job':'historical_job'):(sameJob?'historical_source':'historical_source_and_job');if(e.applicability!==expected)memoryInvalid();}return v;
}

export const PIP_STATEMENT_NOTICE='A claim is something you told this Pip; it may be wrong. A preference is a wish, not a rule. Only this Pip sees them. They don’t check the code, change what it’s set up to do, hide findings, add to shared context, or give it permissions.';
const statementAnchorKeys=['schema_version','pip_id','workspace_id','job_version','job_digest','lifecycle_revision','binding','context_reference','source_reference','source_semantics'];
const statementBodyKeys=['schema_version','id','pip_id','workspace_id','kind','title','statement','reason','anchor','anchor_digest','created_at','created_by','expires_at','classification','verification','effect'];
function statementInvalid(){throw Error('The Pip statement metadata is invalid, unsupported, or belongs to another Pip. Refresh before reviewing.');}
const statementText=(v,max,multiline=false)=>outcomeText(v,max,multiline);
function statementContext(v){if(!exactOutcome(v,['revision','digest'])||!memoryInt(v.revision,0,2147483647)||!memoryHash(v.digest))statementInvalid();}
export function pipStatementAnchor(v,pip,workspace){
 if(!exactOutcome(v,statementAnchorKeys)||v.schema_version!==1||!outcomeId(v.pip_id,'pip')||!outcomeId(v.workspace_id,'ws')||pip!==undefined&&v.pip_id!==pip||workspace!==undefined&&v.workspace_id!==workspace||!memoryInt(v.job_version,1,999999)||!memoryHash(v.job_digest)||!memoryInt(v.lifecycle_revision)||bytes(JSON.stringify(v))>3072)statementInvalid();
 const b=v.binding;if(!exactOutcome(b,['binding_id','runner_id','updated_at','root_digest'])||!outcomeId(b.binding_id,'binding')||!outcomeId(b.runner_id,'runner')||!memoryTime(b.updated_at)||!memoryHash(b.root_digest))statementInvalid();statementContext(v.context_reference);
 const s=v.source_reference;if(s===null){if(v.source_semantics!=='not_observed')statementInvalid();}else{
  if(v.source_semantics!=='selected_audit_reference'||!exactOutcome(s,['run_id','checkpoint_id','checkpoint_digest','checkpoint_digest_kind','job_version','source_policy','source_revision','source_snapshot','context_reference'])||!outcomeId(s.run_id,'run')||!memoryInt(s.checkpoint_id,1)||!memoryHash(s.checkpoint_digest)||s.checkpoint_digest_kind!=='stored_checkpoint_utf8'||!memoryInt(s.job_version,1,999999))statementInvalid();statementContext(s.context_reference);memoryPinSource(memorySourcePin(s));
 }return v;
}
export function pipStatementCandidate(v,pip,workspace){if(!exactOutcome(v,['anchor','digest'])||!memoryHash(v.digest))statementInvalid();pipStatementAnchor(v.anchor,pip,workspace);return v;}
export function pipStatement(v,pip,workspace){
 if(!exactOutcome(v,[...statementBodyKeys,'digest','status','revision','revoked_at','revoked_by','revoke_reason'])||v.schema_version!==1||!outcomeId(v.id,'memory')||!outcomeId(v.pip_id,'pip')||!outcomeId(v.workspace_id,'ws')||pip!==undefined&&v.pip_id!==pip||workspace!==undefined&&v.workspace_id!==workspace||!['fact','preference'].includes(v.kind)||v.classification!==(v.kind==='fact'?'user_recorded_claim':'user_recorded_preference')||v.verification!=='not_execution_verified'||v.effect!=='reference_only'||!statementText(v.title,200)||!statementText(v.statement,2000,true)||!statementText(v.reason,1000,true)||!statementText(v.created_by,128)||!memoryTime(v.created_at)||!memoryHash(v.anchor_digest)||!memoryHash(v.digest)||bytes(JSON.stringify(Object.fromEntries(statementBodyKeys.map(k=>[k,v[k]]))))>6144||bytes(JSON.stringify(v))>7680)statementInvalid();
 pipStatementAnchor(v.anchor,v.pip_id,v.workspace_id);if(v.expires_at!==null&&(!memoryTime(v.expires_at)||v.expires_at<=v.created_at))statementInvalid();
 if(v.status==='active'){if(v.revision!==0||[v.revoked_at,v.revoked_by,v.revoke_reason].some(x=>x!==null))statementInvalid();}
 else if(v.status==='revoked'){if(v.revision!==1||!memoryTime(v.revoked_at)||v.revoked_at<v.created_at||!statementText(v.revoked_by,128)||!statementText(v.revoke_reason,1000,true))statementInvalid();}else statementInvalid();return v;
}
export function pipStatementsPage(v,pip,workspace){
 if(!exactOutcome(v,['pip_id','workspace_id','as_of','entries','counts','returned_records','remaining_records','next_before_id','has_more','page_reduced_for_budget'])||v.pip_id!==pip||v.workspace_id!==workspace||!outcomeId(pip,'pip')||!outcomeId(workspace,'ws')||!memoryTime(v.as_of)||!Array.isArray(v.entries)||v.entries.length>20||!exactOutcome(v.counts,['retained','active','expired','revoked'])||!Object.values(v.counts).every(n=>memoryInt(n,0,1000))||v.counts.active>32||v.counts.retained!==v.counts.active+v.counts.expired+v.counts.revoked||v.returned_records!==v.entries.length||!memoryInt(v.remaining_records,0,1000)||v.returned_records+v.remaining_records>v.counts.retained||typeof v.has_more!=='boolean'||v.has_more!==(v.remaining_records>0)||!(v.next_before_id===null||memoryInt(v.next_before_id,1))||v.has_more!==(v.next_before_id!==null)||v.has_more&&!v.entries.length||typeof v.page_reduced_for_budget!=='boolean'||v.page_reduced_for_budget&&!v.has_more||bytes(JSON.stringify(v))>65536)statementInvalid();
 const ids=new Set(),counts={active:0,expired:0,revoked:0};for(const e of v.entries){if(!exactOutcome(e,['memory','effective_status']))statementInvalid();const m=pipStatement(e.memory,pip,workspace),status=m.status==='revoked'?'revoked':m.expires_at!==null&&m.expires_at<=v.as_of?'expired':'active';if(e.effective_status!==status||ids.has(m.id))statementInvalid();ids.add(m.id);counts[status]++;}if(Object.keys(counts).some(k=>counts[k]>v.counts[k]))statementInvalid();return v;
}
export function pipStatementDraft(v,now=Date.now()){
 if(!['fact','preference'].includes(v.kind)||!statementText(v.title,200)||!statementText(v.statement,2000,true)||!statementText(v.reason,1000,true))throw Error('Add a one-line title and a statement of a paragraph or two, and keep the reason short. Nothing is shortened for you.');
 let expires_at=null;if(v.expiry){const raw=v.expiry;if(typeof raw!=='string'||/[\r\n]/.test(raw)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw)||Number.isNaN(Date.parse(raw))||Date.parse(raw)<=now)throw Error('Enter a future expiry with seconds and an explicit offset or Z, or leave it empty.');expires_at=new Date(raw).toISOString();}
 if(v.source_run_id&&!outcomeId(v.source_run_id,'run'))throw Error('Choose a loaded successful audit from this Pip, or leave the source unobserved.');return {kind:v.kind,title:v.title,statement:v.statement,reason:v.reason,expires_at,...(v.source_run_id?{source_run_id:v.source_run_id}:{})};
}
export function pipStatementResult(v,request,workspace,anchor,original){
 if(!exactOutcome(v,['memory','replayed'])||typeof v.replayed!=='boolean')statementInvalid();const m=pipStatement(v.memory,request.pip_id,workspace);
 if(request.type==='record_pip_statement'){if(['kind','title','statement','reason','expires_at'].some(k=>m[k]!==request[k])||m.anchor_digest!==request.expected_anchor_digest||memoryJson(m.anchor)!==memoryJson(anchor)||(m.anchor.source_reference?.run_id??undefined)!==request.source_run_id)statementInvalid();}
 else if(request.type!=='revoke_pip_statement'||m.id!==request.memory_id||m.status!=='revoked'||m.revision!==1||m.revoke_reason!==request.reason||!original||m.digest!==original.digest||statementBodyKeys.some(k=>memoryJson(m[k])!==memoryJson(original[k])))statementInvalid();return v;
}
function pipTypedMemoryPin(v,run){
 const kinds=['finding_exception','fact','preference'],countsKeys=['total_records','revoked_records','expired_records','eligible_records','omitted_records'];
 const fail=()=>{throw Error('The typed Pip memory snapshot is invalid or differs from this run’s immutable source, job or context.');};
 if(!exactOutcome(v,['schema_version','pip_id','workspace_id','source','job_version','as_of','context_reference','counts_by_kind','entries','digest',...countsKeys])||v.schema_version!==2||!outcomeId(v.pip_id,'pip')||!outcomeId(v.workspace_id,'ws')||v.pip_id!==run.pip_id||v.workspace_id!==run.workspace_id||!memoryInt(v.job_version,1)||v.job_version!==run.manifest?.job_version||!memoryTime(v.as_of)||!memoryHash(v.digest)||bytes(JSON.stringify(v))>8192)fail();
 memoryPinSource(v.source);if(memoryJson(v.source)!==memoryJson(memorySourcePin(run.manifest)))fail();statementContext(v.context_reference);const context=run.manifest.workspace_context;if(!record(context)||context.workspace_id!==v.workspace_id||!memoryInt(context.revision,0,2147483647)||!memoryHash(context.digest)||memoryJson(v.context_reference)!==memoryJson({revision:context.revision,digest:context.digest}))fail();
 const checkCounts=c=>{if(!exactOutcome(c,countsKeys)||countsKeys.some(k=>!memoryInt(c[k],0,['eligible_records','omitted_records'].includes(k)?32:1000))||c.total_records!==c.revoked_records+c.expired_records+c.eligible_records||c.omitted_records>c.eligible_records)fail();};
 checkCounts(Object.fromEntries(countsKeys.map(k=>[k,v[k]])));if(!exactOutcome(v.counts_by_kind,kinds))fail();for(const k of kinds)checkCounts(v.counts_by_kind[k]);if(countsKeys.some(k=>v[k]!==kinds.reduce((n,kind)=>n+v.counts_by_kind[kind][k],0)))fail();
 if(!Array.isArray(v.entries)||v.entries.length>16)fail();const ids=new Set(),included={finding_exception:0,fact:0,preference:0};
 for(const e of v.entries){
  if(!exactOutcome(e,['memory','applicability'])||!record(e.memory)||!kinds.includes(e.memory.kind))fail();const exception=e.memory.kind==='finding_exception',m=exception?pipMemory(e.memory,v.pip_id,v.workspace_id):pipStatement(e.memory,v.pip_id,v.workspace_id);
  if(ids.has(m.id)||m.status!=='active'||m.created_at>v.as_of||m.expires_at!==null&&m.expires_at<=v.as_of)fail();ids.add(m.id);included[m.kind]++;
  const origin=exception?m.source:m.anchor.source_reference,job=exception?m.source.job_version:m.anchor.job_version,context=exception?m.source.context_reference:m.anchor.context_reference;
  const expected={source:origin===null?'not_observed':memoryJson(memorySourcePin(origin))===memoryJson(v.source)?'same_pinned_source':'historical_source',job:job===v.job_version?'same_pinned_job':'historical_job',context:context===null?'not_recorded':memoryJson(context)===memoryJson(v.context_reference)?'same_pinned_context':'historical_context'};
  if(!exactOutcome(e.applicability,['source','job','context'])||memoryJson(e.applicability)!==memoryJson(expected))fail();
 }if(kinds.some(k=>included[k]+v.counts_by_kind[k].omitted_records!==v.counts_by_kind[k].eligible_records))fail();return v;
}

export const SPECIALIST_ROLES=['explorer','critic','worker'];
export function specialistGrant(v){if(!exactOutcome(v,['roles','max_calls'])||!Array.isArray(v.roles)||!v.roles.length||v.roles.length>3||v.roles.some(r=>!SPECIALIST_ROLES.includes(r))||new Set(v.roles).size!==v.roles.length||!Number.isSafeInteger(v.max_calls)||v.max_calls<1||v.max_calls>3)throw Error('Choose unique Explorer, Critic or Worker roles and a total call cap of 1–3.');return {roles:SPECIALIST_ROLES.filter(r=>v.roles.includes(r)),max_calls:v.max_calls};}
// Helpers' policy versions (dgc/pip_specialists.py): 1 pinned 12 requests, 64 tool calls, 4,096 output tokens a request
// and 300 s; 2 (2026-10-14) pins none, as every Pip run, and its counts are real ones. Saved version-1 runs still read.
const SPECIALIST_CAPS={1:{requests:12,tools:64,output:4096},2:{requests:1000000,tools:1000000,output:1000000}};
function specialistLimits(version,grant){return version===1?{calls:grant.max_calls,requests:12,tool_calls:64,output_tokens_per_request:4096,wall_seconds:300}:{calls:grant.max_calls,requests:0,tool_calls:0,output_tokens_per_request:0,wall_seconds:0};}
export function specialistPolicy(manifest,action){
 const fail=()=>{throw Error('The saved specialist policy does not match this reviewed Patch run.');};
 if(!Object.hasOwn(action,'specialists')){if(Object.hasOwn(manifest,'specialists'))fail();return null;}
 const grant=specialistGrant(action.specialists),v=manifest.specialists;
 if(!record(v)||![1,2].includes(v.version))fail();
 const limits=specialistLimits(v.version,grant),run=v.version===1?{iterations:12,tool_calls:64,wall_seconds:300}:{iterations:0,tool_calls:0,wall_seconds:0};
 if(action.kind!=='patch'||manifest.run_kind!=='patch'||!exactOutcome(v,['version','grant','instructions','limits','digest'])||!memoryHash(v.digest)||memoryJson(v.grant)!==memoryJson(grant)||!exactOutcome(v.instructions,grant.roles)||!Object.values(v.instructions).every(memoryHash)||memoryJson(v.limits)!==memoryJson(limits)||!record(manifest.limits)||Object.entries(run).some(([k,n])=>manifest.limits[k]!==n))fail();return v;
}
export function specialistReceipt(result,manifest,action){
 const pin=specialistPolicy(manifest,action),fail=()=>{throw Error('Specialist receipts are invalid or do not match their saved policy. Their prose is not execution evidence.');};
 if(!pin){if(result&&Object.hasOwn(result,'specialists'))fail();return null;}
 const v=result?.specialists,cap=SPECIALIST_CAPS[pin.version];if(!exactOutcome(v,['version','policy_digest','calls','requests','model_calls','transport_attempts','output_token_reservations','tool_calls'])||v.version!==pin.version||v.policy_digest!==pin.digest||!memoryInt(v.requests,0,cap.requests)||!memoryInt(v.model_calls,0,v.requests)||!memoryInt(v.transport_attempts,0,v.requests)||!memoryInt(v.output_token_reservations,v.requests,v.requests*cap.output)||!memoryInt(v.tool_calls,0,cap.tools)||result.tools_called!==v.tool_calls||!Array.isArray(v.calls)||v.calls.length>pin.grant.max_calls)fail();
 const ids=new Set(),totals={requests:0,model_calls:0,transport_attempts:0,tool_calls:0};
 const specialistText=(s,max,empty=false)=>typeof s==='string'&&(empty||!!s.trim())&&!s.includes('\0')&&!Array.from(s).some(c=>c.codePointAt(0)>=0xd800&&c.codePointAt(0)<=0xdfff)&&bytes(s)<=max;
 for(const c of v.calls){if(!exactOutcome(c,['id','role','status','model','requests','model_calls','transport_attempts','tool_calls','usage','summary'])||typeof c.id!=='string'||c.id.length!==16||!/^sub-[0-9a-f]{12}$/.test(c.id)||ids.has(c.id)||!pin.grant.roles.includes(c.role)||!['completed','failed','cancelled'].includes(c.status)||!specialistText(c.model,256)||c.model!==manifest.model||!specialistText(c.summary,1200,true)||!memoryInt(c.requests,0,cap.requests)||!memoryInt(c.model_calls,0,c.requests)||!memoryInt(c.transport_attempts,0,c.requests)||!memoryInt(c.tool_calls,0,cap.tools)||!exactOutcome(c.usage,['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens','requests'])||!Object.values(c.usage).every(n=>memoryInt(n)))fail();ids.add(c.id);for(const k of Object.keys(totals))totals[k]+=c[k];}
 if(Object.keys(totals).some(k=>totals[k]>v[k]))fail();return v;
}

export function lifecycleRevision(pip){return Number.isSafeInteger(pip?.lifecycle_revision)&&pip.lifecycle_revision>=0?pip.lifecycle_revision:null;}
export function archivalResult(value,request,workspace){
 const v=value,r=v?.receipt,p=v?.pip,fail=()=>{throw Error('The archival receipt does not match the reviewed lifecycle. Refresh the Pip before another action.');};
 if(!exactOutcome(v,['pip','receipt','replayed'])||typeof v.replayed!=='boolean'||!record(p)||p.id!==request.pip_id||p.workspace_id!==workspace||!memoryInt(p.current_version,1,999999)||!['active','paused','archived'].includes(p.status)||lifecycleRevision(p)===null||!exactOutcome(r,['id','operation','pip_id','workspace_id','job_version','lifecycle_revision_before','lifecycle_revision_after','status_before','status_after','reason','actor','created_at'])||!outcomeId(r.id,'archive')||r.pip_id!==request.pip_id||r.workspace_id!==workspace||r.job_version!==request.expected_version||r.lifecycle_revision_before!==request.expected_lifecycle_revision||!memoryInt(r.lifecycle_revision_before,0,Number.MAX_SAFE_INTEGER-1)||r.lifecycle_revision_after!==r.lifecycle_revision_before+1||!outcomeText(r.reason,1000,true)||!outcomeText(r.actor,128)||!memoryTime(r.created_at)||r.reason!==request.reason||bytes(JSON.stringify(r))>8192)fail();
 const archive=request.type==='archive_pip';if(!['archive_pip','restore_pip'].includes(request.type)||r.operation!==(archive?'archive':'restore')||!(archive?['active','paused']:['archived']).includes(r.status_before)||r.status_after!==(archive?'archived':'paused')||p.lifecycle_revision<r.lifecycle_revision_after||p.current_version<r.job_version||!v.replayed&&(p.lifecycle_revision!==r.lifecycle_revision_after||p.status!==r.status_after||p.current_version!==r.job_version))fail();return v;
}


// Conversational setup is a saved proposal, never a model-authorized mutation.
const setupKeys='created_at,digest,expected_lifecycle_revision,expected_version,expires_at,goal,id,name,next_run_at,permissions,pip_id,pip_type,project_root,reason,receipt,run_now,run_now_policy,runner_notice,schedule,scope_notice,source_policy,source_ref,status,work_kind,workspace_id';
const setupText=(v,max=4096)=>typeof v==='string'&&v.trim().length>0&&new TextEncoder().encode(v).length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)&&Array.from(v).every(c=>c.length!==1||c.charCodeAt(0)<0xd800||c.charCodeAt(0)>0xdfff);
const setupTime=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
// Reviewed web reads (Pips API 40): exact public https pages and fixed searches that DGC reads
// before a Personal Pip runs. Mirrors dgc/pip_web_reads.validate; anything else is refused whole.
export function webReadPlan(value){
 const fail=()=>{throw Error('The web reads are not supported. Refresh this review.');};
 if(!record(value)||Object.keys(value).sort().join()!=='reads,schema_version'||value.schema_version!==1||!Array.isArray(value.reads)||!value.reads.length||value.reads.length>4)fail();
 const seen=new Set();
 for(const read of value.reads){
  if(!record(read))fail();
  const keys=Object.keys(read).sort().join();
  if(keys==='kind,url'&&read.kind==='page'){
   const url=read.url;let parsed;
   if(typeof url!=='string'||!url.length||url.length>2048||url!==url.trim()||/[\x00-\x20\x7f]/.test(url))fail();
   try{parsed=new URL(url);}catch{fail();}
   const host=parsed.hostname.replace(/\.$/,'').toLowerCase();
   if(parsed.protocol!=='https:'||!host||parsed.username||parsed.password||host==='localhost'||host.endsWith('.localhost')||/^[0-9.]+$/.test(host)||host.includes(':')||host.startsWith('['))fail();
  }else if(keys==='kind,query'&&read.kind==='search'){
   const q=read.query;if(typeof q!=='string'||!q.trim().length||q.length>300||q!==q.trim()||/[\x00-\x1f\x7f]/.test(q))fail();
  }else fail();
  const key=JSON.stringify([read.kind,read.url??read.query]);if(seen.has(key))fail();seen.add(key);
 }return value;
}
export function webReadLabel(read){return read.kind==='page'?'Page · '+read.url:'Search · '+read.query;}

export function appReadPlan(value){
 const fail=()=>{throw Error('The app-read permissions are not supported. Refresh this review.');};
 if(!record(value)||Object.keys(value).sort().join()!=='calls,connection_digest,schema_version,server'||![1,2,3].includes(value.schema_version)||!/^[-\w.]{1,80}$/.test(value.server)||!/^([a-f0-9]{64})$/.test(value.connection_digest)||!Array.isArray(value.calls)||!value.calls.length||value.calls.length>4||new TextEncoder().encode(JSON.stringify(value)).length>8192)fail();
 for(const call of value.calls){
  if(!record(call)||!['arguments,schema_digest,tool','account,arguments,schema_digest,tool','account,arguments,schema_digest,tool,window'].includes(Object.keys(call).sort().join())||!['GMAIL_FETCH_EMAILS','GOOGLECALENDAR_FIND_EVENT',...extraReadTools].includes(call.tool)||!/^([a-f0-9]{64})$/.test(call.schema_digest)||!record(call.arguments)||new TextEncoder().encode(JSON.stringify(call.arguments)).length>4096)fail();
  if(extraReadTools.includes(call.tool)){if(value.schema_version!==3||!Object.hasOwn(call,'account')||Object.hasOwn(call,'window'))fail();validateExtraRead(call.tool,call.arguments);}else if(!Number.isInteger(call.arguments.max_results)||call.arguments.max_results<1||call.arguments.max_results>20)fail();
  if(Object.hasOwn(call,'account')&&(typeof call.account!=='string'||!/^(?:ca|coup)_[A-Za-z0-9_-]{1,120}$/.test(call.account)))fail();
  if(Object.hasOwn(call,'window')){const w=call.window;if(![2,3].includes(value.schema_version)||call.tool!=='GOOGLECALENDAR_FIND_EVENT'||Object.hasOwn(call.arguments,'time_min')||Object.hasOwn(call.arguments,'time_max')||!record(w)||Object.keys(w).sort().join()!=='days,kind,start_day,timezone'||w.kind!=='calendar_days'||!Number.isInteger(w.start_day)||w.start_day<0||w.start_day>30||!Number.isInteger(w.days)||w.days<1||w.days>31||typeof w.timezone!=='string'||!w.timezone||w.timezone.length>100)fail();try{new Intl.DateTimeFormat('en',{timeZone:w.timezone});}catch{fail();}}
 }return value;
}

export function pipSetup(value,workspace,id=null) {
 const fail=()=>{throw Error('This setup is invalid or belongs to another project. Refresh before reviewing it.');};
 if(!record(value)||Object.keys(value).filter(k=>!['model_choice','verification_plan','app_plan','web_plan','event_trigger','computer'].includes(k)).sort().join()!==setupKeys||value.workspace_id!==workspace||!/^setup_[a-f0-9]{32}$/.test(value.id)||id!==null&&value.id!==id||!/^[a-f0-9]{64}$/.test(value.digest)||!setupText(value.project_root,16384)||!(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.project_root))||!setupText(value.name,480)||!setupText(value.goal,16000)||!setupText(value.reason,4000)||!setupText(value.scope_notice,4000)||!setupText(value.runner_notice,2000)||!setupText(value.source_ref,800)||!['scout','lens','rook','lock','quill','pulse'].includes(value.pip_type)||value.work_kind!==(value.source_policy==='personal'?'personal_task':value.pip_type==='pulse'?(value.verification_plan?.action?.network==='loopback_http_v1'?'app_smoke_test':'command_verification'):value.pip_type==='quill'?'documentation_draft':'source_review')||value.permissions!==(value.pip_type==='pulse'&&value.source_policy!=='personal'?'review_required':'read_only')||!['committed_only','personal'].includes(value.source_policy)||typeof value.run_now!=='boolean'||!['pending','accepted','rejected','expired'].includes(value.status)||!setupTime(value.created_at)||!setupTime(value.expires_at)||Date.parse(value.expires_at)<=Date.parse(value.created_at)||!(value.next_run_at===null||setupTime(value.next_run_at))||!(value.run_now?setupText(value.run_now_policy,2000):value.run_now_policy===null))fail();
 if(value.pip_type==='pulse'&&value.source_policy!=='personal'){if(!pulsePlan(value.verification_plan))fail();}else if(Object.hasOwn(value,'verification_plan'))fail();
 if(Object.hasOwn(value,'app_plan')){if(value.source_policy!=='personal')fail();appReadPlan(value.app_plan);}
 if(Object.hasOwn(value,'web_plan')){if(value.source_policy!=='personal')fail();webReadPlan(value.web_plan);}
 if(Object.hasOwn(value,'computer')&&(value.computer!==true||value.source_policy!=='personal'))fail();
 // A setup card's only trigger (Pips API 41): a review after each new commit, instead of a schedule.
 if(Object.hasOwn(value,'event_trigger')){const t=value.event_trigger;if(value.source_policy==='personal'||value.schedule!==null||value.pip_id!==null||!record(t)||Object.keys(t).sort().join()!=='events,minimum_minutes,missed_policy'||JSON.stringify(t.events)!=='["commit_changed"]'||!Number.isSafeInteger(t.minimum_minutes)||t.minimum_minutes<5||t.minimum_minutes>1440||t.missed_policy!=='coalesce_latest'||!['scout','lens','rook','lock','quill'].includes(value.pip_type))fail();}
 if(value.model_choice!==undefined){const m=value.model_choice;if(!record(m)||!(m.mode==='default'&&Object.keys(m).join()==='mode'||m.mode==='model'&&Object.keys(m).sort().join()==='mode,model'&&typeof m.model==='string'&&/^[A-Za-z0-9_][A-Za-z0-9._:/@+\-]{0,255}$/.test(m.model)&&!m.model.includes('://')||m.mode==='subscription'&&value.source_policy==='personal'&&Object.keys(m).sort().join()==='engine,mode'&&Object.hasOwn(SUBSCRIPTION_NAMES,m.engine)))fail();}
 const existing=value.pip_id!==null;
 if(existing?!/^pip_[a-f0-9]{32}$/.test(value.pip_id)||!Number.isSafeInteger(value.expected_version)||value.expected_version<1||!Number.isSafeInteger(value.expected_lifecycle_revision)||value.expected_lifecycle_revision<0:value.expected_version!==null||value.expected_lifecycle_revision!==null)fail();
 const schedule=value.schedule;
 if(schedule!==null){
  if(!record(schedule)||schedule.missed_policy!=='coalesce_latest'||!['interval','daily','once','cron'].includes(schedule.type))fail();
  const required={interval:'minutes,missed_policy,type',daily:'dst_policy,missed_policy,time,timezone,type',once:'at,missed_policy,type',cron:'cron,dst_policy,missed_policy,timezone,type'}[schedule.type];
  if(Object.keys(schedule).sort().join()!==required)fail();
  if(schedule.type==='interval'&&(!Number.isSafeInteger(schedule.minutes)||schedule.minutes<5||schedule.minutes>10080)||schedule.type==='once'&&!setupTime(schedule.at))fail();
  if(['daily','cron'].includes(schedule.type)){try{scheduleZone(schedule.timezone);}catch{fail();}if(schedule.dst_policy!=='skip_gap_first_fold')fail();if(schedule.type==='daily'&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))fail();if(schedule.type==='cron'){try{if(cronExpression(schedule.cron)!==schedule.cron)fail();}catch{fail();}}}
  if(value.next_run_at===null)fail();
 }else if(value.next_run_at!==null)fail();
 const r=value.receipt;
 if(['pending','expired'].includes(value.status)){if(r!==null)fail();}
 else{
  if(!record(r)||Object.keys(r).filter(k=>k!=='replacement_setup_id').sort().join()!=='accepted,actor,job_version,next_run_at,pip_id,resolved_at,run_id,setup_id'||r.setup_id!==value.id||typeof r.accepted!=='boolean'||r.accepted!==(value.status==='accepted')||!setupText(r.actor,512)||!setupTime(r.resolved_at))fail();
  if(r.replacement_setup_id!==undefined&&(r.accepted||!/^setup_[a-f0-9]{32}$/.test(r.replacement_setup_id)))fail();
  if(r.accepted){if(!/^pip_[a-f0-9]{32}$/.test(r.pip_id)||existing&&r.pip_id!==value.pip_id||!Number.isSafeInteger(r.job_version)||r.job_version!==(value.expected_version??0)+1||(value.run_now?!/^run_[a-f0-9]{32}$/.test(r.run_id):r.run_id!==null))fail();if(r.next_run_at!==value.next_run_at)fail();}
  else if(r.pip_id!==value.pip_id||r.job_version!==value.expected_version||r.run_id!==null||r.next_run_at!==null)fail();
 }
 return value;
}
export function pipSetups(value,workspace){
 if(!record(value)||!Array.isArray(value.setups)||value.setups.length>5)throw Error('Setup review list is invalid. Refresh before reviewing.');
 const seen=new Set();return value.setups.map(row=>{const setup=pipSetup(row,workspace);if(setup.status!=='pending'||seen.has(setup.id))throw Error('Setup review list contains duplicate or nonpending proposals.');seen.add(setup.id);return setup;});
}
export function pipSetupPrompt(workspace,text,pip=null){
 if(!record(workspace)||!setupText(workspace.id,100)||!setupText(workspace.name,200)||!setupText(text,4000)||pip!==null&&(!record(pip)||pip.workspace_id!==workspace.id||!/^pip_[a-f0-9]{32}$/.test(pip.id)||!setupText(pip.name,480)||!Number.isSafeInteger(pip.current_version)||pip.current_version<1||!Number.isSafeInteger(pip.lifecycle_revision)||pip.lifecycle_revision<0))throw Error('Describe the task in a few paragraphs at most. To change an existing Pip, refresh it first.');
 if(workspace.kind==='personal')return `Help me ${pip?'change':'create'} a personal Pip, available across my project directories. ${pip?`Pip reference: ${pip.id} · job v${pip.current_version} · lifecycle v${pip.lifecycle_revision}.`:''}\n\nMy request:\n${text.trim()}\n\nPrepare a pips_setup review card with scope personal and work_kind personal_task. Use this chat’s actual root as target_root; the controller will choose private profile storage. Do not grant project files, commands or browser access. App access needs exact inspected connection, account and read-call permissions; never invent a connected account. Ask for missing details. Do not activate it before my review.`;
 const project=JSON.stringify(workspace.name),name=pip?JSON.stringify(pip.name):'';
 const opening=pip?`Help me change the setup for ${name} in ${project}.\nPip reference: ${pip.id} · job v${pip.current_version} · lifecycle v${pip.lifecycle_revision}.`:`Help me set up a Pip for ${project}.`;
 return `${opening}\n\nMy request:\n${text.trim()}\n\nPrepare a setup card for my review; do not activate or run it yet. Confirm the project folder and ask for any missing details first.`;
}

export function pipSetupResolution(value,review,accepted){
 const setup=pipSetup(value,review.workspace_id,review.id);
 const stable=v=>Array.isArray(v)?v.map(stable):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const before=stable({...review,status:'pending',receipt:null}),after=stable({...setup,status:'pending',receipt:null});
 if(setup.status!==(accepted?'accepted':'rejected')||setup.digest!==review.digest||JSON.stringify(before)!==JSON.stringify(after))throw Error('The setup receipt differs from the proposal you reviewed. Refresh before retrying.');
 return setup;
}

// Fewer, better messages (Pips API 41): per-Pip notification settings, the daily digest and
// finding outcomes. Exact shapes: a digest is shown in the main chat, so nothing unexpected passes.
export const SEVERITIES = ['low','medium','high','critical'];
const digestKeys = (value, keys) => record(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const digestCount = value => Number.isSafeInteger(value) && value >= 0;
const digestPip = value => typeof value === 'string' && /^pip_[a-f0-9]{32}$/.test(value);
const digestRun = value => typeof value === 'string' && /^run_[a-f0-9]{32}$/.test(value);
const digestTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
export function pipNotifySettings(value, pip) {
  if (!digestKeys(value, ['pip_id','min_severity','alert_severity','revision','is_default']) || value.pip_id !== pip
    || !SEVERITIES.includes(value.min_severity) || !(value.alert_severity === null || SEVERITIES.includes(value.alert_severity))
    || value.alert_severity !== null && SEVERITIES.indexOf(value.alert_severity) < SEVERITIES.indexOf(value.min_severity)
    || !digestCount(value.revision) || typeof value.is_default !== 'boolean' || value.is_default !== (value.revision === 0))
    throw Error('Notification settings are invalid or belong to another Pip.');
  return value;
}
// Keep Pips running (API 41): the switch's state. Exact keys, since the panel words it.
export function pipsKeepRunning(value) {
  const keys = ['on', 'platform', 'reason', 'restarts_after_failure', 'starts_at_login', 'supported', 'while_logged_out'];
  if (!record(value) || Object.keys(value).sort().join() !== keys.join() || typeof value.platform !== 'string'
    || typeof value.reason !== 'string' || value.reason.length > 400
    || !['on', 'restarts_after_failure', 'starts_at_login', 'supported', 'while_logged_out'].every((key) => typeof value[key] === 'boolean')
    || (!value.supported && (value.on || !value.reason)))
    throw Error('The keep-running status is invalid. Refresh the Pips view.');
  return value;
}

// A Pip's token usage (API 41): exact shapes, since the Job tab draws them. daily_cap is always null since Pips
// lost their daily limit (2026-10-14); one from an older DGC is accepted and not shown.
export function pipUsage(value, pip) {
  const fail = () => { throw Error("This Pip's usage is invalid. Refresh this Pip."); };
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  const day = (d) => typeof d === 'string' && /^\d{4}-\d\d-\d\d$/.test(d);
  const entry = (e) => record(e) && Object.keys(e).sort().join() === 'day,runs,tokens' && day(e.day) && count(e.runs) && count(e.tokens);
  if (!record(value) || Object.keys(value).sort().join() !== 'capped_today,daily_cap,days,last_30_days,pip_id,today' || value.pip_id !== pip
    || !entry(value.today) || !record(value.last_30_days) || Object.keys(value.last_30_days).sort().join() !== 'runs,tokens'
    || !count(value.last_30_days.runs) || !count(value.last_30_days.tokens) || !Array.isArray(value.days) || value.days.length > 31
    || !value.days.every(entry) || !(value.daily_cap === null || (Number.isSafeInteger(value.daily_cap) && value.daily_cap >= 1000))
    || typeof value.capped_today !== 'boolean' || (value.daily_cap === null && value.capped_today)) fail();
  return value;
}

// Always allow (API 41): what a Personal Pip may run without asking, each pinned to one action's
// kind, connection, account, tool and schema. Only the user creates or removes one.
function actionGrantRow(g) {
  const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  return record(g) && Object.keys(g).sort().join() === 'account,connection_digest,created_at,created_by,id,kind,label,schema_digest,server,tool'
    && /^grant_[a-f0-9]{32}$/.test(g.id) && ['gmail_send', 'calendar_create', 'connector_call', 'computer_submit'].includes(g.kind)
    && text(g.server, 80) && text(g.account, 160) && text(g.tool, 160) && text(g.label, 200) && text(g.created_at, 40)
    && ['editor-user', 'local-console'].includes(g.created_by) && hash(g.connection_digest) && hash(g.schema_digest);
}
export function actionGrants(value, pip) {
  if (!record(value) || Object.keys(value).sort().join() !== 'grants,pip_id' || value.pip_id !== pip
    || !Array.isArray(value.grants) || value.grants.length > 20 || !value.grants.every(actionGrantRow))
    throw Error("This Pip's allowed actions are invalid. Refresh this Pip.");
  return value;
}
export function actionGrant(value) {
  if (!actionGrantRow(value)) throw Error('The allowed action DGC returned is invalid. Refresh this Pip.');
  return value;
}

// The user's ratings of a Pip's results (API 41), newest first. Its later runs read the newest five.
export function pipFeedback(value, pip) {
  const fail = () => { throw Error("This Pip's ratings are invalid. Refresh this Pip."); };
  const row = (r) => record(r) && Object.keys(r).sort().join() === 'at,note,rating,run_id'
    && typeof r.run_id === 'string' && r.run_id.length > 0 && r.run_id.length <= 128 && (r.rating === 'up' || r.rating === 'down')
    && typeof r.note === 'string' && [...r.note].length <= 500 && typeof r.at === 'string' && r.at.length <= 40;
  if (!record(value) || Object.keys(value).sort().join() !== 'feedback,pip_id' || value.pip_id !== pip
    || !Array.isArray(value.feedback) || value.feedback.length > 20 || !value.feedback.every(row)) fail();
  return value;
}

// The runner's desktop notifications (API 41). `last` is evidence: whether the last one showed.
export function pipsDesktopNotifications(value) {
  const fail = () => { throw Error('The desktop notification status is invalid. Refresh the Pips view.'); };
  if (!record(value) || Object.keys(value).sort().join() !== 'available,last,on,platform' || typeof value.on !== 'boolean'
    || typeof value.available !== 'boolean' || typeof value.platform !== 'string') fail();
  if (value.last !== null && (!record(value.last) || Object.keys(value.last).sort().join() !== 'at,shown'
    || typeof value.last.shown !== 'boolean' || typeof value.last.at !== 'string')) fail();
  return value;
}

export function pipOutcomes(value, pip) {
  const counts = ['reported','accepted','dismissed','still_reported','gone_after_change','gone_without_change','checkpoints_examined'];
  if (!digestKeys(value, ['pip_id','name','pip_type','history_truncated',...counts]) || value.pip_id !== pip || typeof value.name !== 'string'
    || typeof value.pip_type !== 'string' || typeof value.history_truncated !== 'boolean' || !counts.every(key => digestCount(value[key]))
    || value.still_reported + value.gone_after_change + value.gone_without_change !== value.reported)
    throw Error('Finding outcomes are invalid or belong to another Pip.');
  return value;
}
export function pipDigest(value) {
  if (value === null) return null;
  const fail = () => { throw Error('The Pips digest is invalid. Update DGC or open the Pips view.'); };
  // pending_actions (drafts and prepared actions waiting for you) came later in API 41; a digest may lack it.
  const base = ['schema_version','since','until','first','due','reason','headline','pips','omitted_pips','failed_runs','pending_reviews','pending_setups','truncated'];
  if (!(digestKeys(value, base) || digestKeys(value, [...base, 'pending_actions']))
    || (Object.hasOwn(value, 'pending_actions') && !digestCount(value.pending_actions))
    || value.schema_version !== 1 || !digestTime(value.since) || !digestTime(value.until) || value.since > value.until
    || typeof value.first !== 'boolean' || typeof value.due !== 'boolean' || ![null,'alert','daily'].includes(value.reason) || (value.reason !== null) !== value.due
    || typeof value.headline !== 'string' || !value.headline || value.headline.length > 400 || !Array.isArray(value.pips) || value.pips.length > 20
    || !['omitted_pips','failed_runs','pending_reviews','pending_setups'].every(key => digestCount(value[key])) || typeof value.truncated !== 'boolean') fail();
  for (const p of value.pips) {
    if (!digestKeys(p, ['pip_id','workspace_id','name','pip_type','scope','status','min_severity','alert_severity','runs','skipped_unchanged','new_total','below_threshold','new_findings','gone_after_change','alert','latest_run_id'])
      || !digestPip(p.pip_id) || !/^ws_[a-f0-9]{32}$/.test(p.workspace_id) || typeof p.name !== 'string' || typeof p.pip_type !== 'string'
      || !['project','personal'].includes(p.scope) || typeof p.status !== 'string' || !SEVERITIES.includes(p.min_severity)
      || !(p.alert_severity === null || SEVERITIES.includes(p.alert_severity)) || !digestKeys(p.runs, ['succeeded','failed','cancelled'])
      || !Object.values(p.runs).every(digestCount) || !['skipped_unchanged','new_total','below_threshold','gone_after_change'].every(key => digestCount(p[key]))
      || typeof p.alert !== 'boolean' || !(p.latest_run_id === null || digestRun(p.latest_run_id)) || !Array.isArray(p.new_findings)
      || p.new_findings.length > 5 || p.new_findings.length > p.new_total) fail();
    for (const f of p.new_findings)
      if (!digestKeys(f, ['severity','title','path','line','run_id','finding_index']) || !SEVERITIES.includes(f.severity)
        || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(p.min_severity) || typeof f.title !== 'string' || f.title.length > 200
        || typeof f.path !== 'string' || !f.path || !Number.isSafeInteger(f.line) || f.line < 1 || !digestRun(f.run_id)
        || !Number.isSafeInteger(f.finding_index) || f.finding_index < 0 || f.finding_index > 15) fail();
  }
  return value;
}

// Reviewed GitHub reads for project reviewers and Quill (Pips API 41): one repository, up to four
// fixed read kinds. Mirrors dgc/pip_github_reads.validate exactly; anything else is refused whole.
const GITHUB_LIMITS={open_issues:20,open_pulls:20,failed_runs:10};
export function githubReadPlan(value){
 const fail=()=>{throw Error('The GitHub reads are not supported. Refresh this review.');};
 if(!record(value)||Object.keys(value).sort().join()!=='reads,repository,schema_version'||value.schema_version!==1
   ||typeof value.repository!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value.repository)
   ||['.','..'].includes(value.repository.split('/')[1])||!Array.isArray(value.reads)||!value.reads.length||value.reads.length>4)fail();
 const seen=new Set();
 for(const read of value.reads){
  if(!record(read)||!['open_issues','open_pulls','commit_checks','failed_runs'].includes(read.kind)||seen.has(read.kind))fail();
  seen.add(read.kind);
  const keys=['kind',...(read.kind in GITHUB_LIMITS?['limit']:[]),...(read.kind==='open_issues'&&Object.hasOwn(read,'labels')?['labels']:[])];
  if(Object.keys(read).sort().join()!==keys.sort().join())fail();
  if(read.kind in GITHUB_LIMITS&&(!Number.isSafeInteger(read.limit)||read.limit<1||read.limit>GITHUB_LIMITS[read.kind]))fail();
  if(Object.hasOwn(read,'labels')&&(!Array.isArray(read.labels)||!read.labels.length||read.labels.length>5||new Set(read.labels).size!==read.labels.length
    ||!read.labels.every(l=>typeof l==='string'&&l.length>=1&&l.length<=50&&l===l.trim()&&!l.includes(',')&&!/[\x00-\x1f\x7f]/.test(l))))fail();
 }
 return value;
}
export function githubReadLabel(read){
 if(read.kind==='open_issues')return `Up to ${read.limit} open issues${read.labels?` labelled ${read.labels.join(', ')}`:''}`;
 if(read.kind==='open_pulls')return `Up to ${read.limit} open pull requests`;
 if(read.kind==='commit_checks')return 'CI checks for the commit the run reviews';
 return `Up to ${read.limit} recent failed workflow runs`;
}

// Pip computers (Pips API 42): exact shapes, because review cards show their text and images.
const COMPUTER_STATES=['pending','approved','rejected','expired','sent','lost'];
const jpegData=(v,max=140000)=>typeof v==='string'&&v.length<=max&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v);
// The live screen of a busy page (an inbox at 1280×800) is often over 100 KB; replies carry up to 4 MiB.
const LIVE_FRAME_CHARS=1_400_000;
export function pipComputerAction(value,pip){
 const fail=()=>{throw Error('A Pip computer action is invalid. Refresh this Pip.');};
 if(!record(value)||Object.keys(value).sort().join()!=='continuation_run_id,created_at,digest,expires_at,frame,id,pip_id,resolved_at,resolved_by,run_id,status,summary,workspace_id'
   ||!/^compact_[a-f0-9]{32}$/.test(value.id)||value.pip_id!==pip||!COMPUTER_STATES.includes(value.status)||!/^[a-f0-9]{64}$/.test(value.digest)
   ||!(value.frame===null||/^\d{4}\.jpg$/.test(value.frame))||!(value.run_id===null||/^run_[a-f0-9]{32}$/.test(value.run_id)))fail();
 const s=value.summary;
 if(!record(s)||typeof s.method!=='string'||typeof s.host!=='string'||typeof s.path!=='string'||typeof s.page!=='string'
   ||!Array.isArray(s.fields)||s.fields.length>24||!s.fields.every(f=>record(f)&&typeof f.name==='string'&&typeof f.value==='string')
   ||!Number.isSafeInteger(s.more_fields)||!Number.isSafeInteger(s.body_bytes))fail();
 return value;
}
export function pipComputer(value,pip){
 // needs_you: a site asked a person to prove they are not a robot; the Pip stopped for the user.
 const needs=value?.needs_you;if(needs!==undefined&&(!record(needs)||Object.keys(needs).sort().join()!=='at,host'||typeof needs.host!=='string'||!needs.host||needs.host.length>255||typeof needs.at!=='string'))throw Error('This Pip\'s computer status is invalid. Refresh this Pip.');
 if(!record(value)||Object.keys(value).filter(k=>k!=='needs_you').sort().join()!=='actions,available,granted,pending,pip_id,reason'||value.pip_id!==pip
   ||typeof value.granted!=='boolean'||typeof value.available!=='boolean'||typeof value.reason!=='string'
   ||!Number.isSafeInteger(value.pending)||!Array.isArray(value.actions)||value.actions.length>5)
  throw Error('This Pip\'s computer status is invalid. Refresh this Pip.');
 value.actions.forEach(a=>pipComputerAction(a,pip));
 return value;
}
export function pipComputerView(value){
 if(!record(value))throw Error('The browser view reply is invalid.');
 if(value.ok!==true)return {ok:false,error:typeof value.error==='string'?value.error.slice(0,300):'The browser is not available.',ready:value.ready!==false};
 if(!jpegData(value.image,LIVE_FRAME_CHARS)||typeof value.url!=='string'||typeof value.watching!=='boolean'||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height))
  throw Error('The browser view reply is invalid.');
 return value;
}
// Where a Pip acted by position (Pips API 53): its kind and point, in the page's pixels; a drag also says where it
// started, and on its desktop the point on the screen. Anything else is not drawn.
const POINT_KINDS=['click_at','double_click_at','right_click_at','drag','scroll_at','hover_at'];
const coordinate=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100000;
export function pipComputerPointer(value){
 if(!record(value)||!POINT_KINDS.includes(value.kind)||!coordinate(value.x)||!coordinate(value.y))return null;
 const out={kind:value.kind,x:value.x,y:value.y,seq:Number.isSafeInteger(value.seq)?value.seq:0};
 if(coordinate(value.from_x)&&coordinate(value.from_y))Object.assign(out,{from_x:value.from_x,from_y:value.from_y});
 if(coordinate(value.screen_x)&&coordinate(value.screen_y)&&coordinate(value.screen_width)&&coordinate(value.screen_height)&&value.screen_width>0&&value.screen_height>0)
  Object.assign(out,{screen_x:value.screen_x,screen_y:value.screen_y,screen_width:value.screen_width,screen_height:value.screen_height});
 return out;
}
export function pipComputerFrames(value,run){
 const rowKeys=f=>Object.keys(f).filter(k=>k!=='pointer').sort().join();
 if(!record(value)||Object.keys(value).sort().join()!=='frames,run_id'||value.run_id!==run||!Array.isArray(value.frames)||value.frames.length>200
   ||!value.frames.every(f=>record(f)&&rowKeys(f)==='at,frame,label,url'&&/^\d{4}\.jpg$/.test(f.frame)&&['label','url','at'].every(k=>typeof f[k]==='string'&&f[k].length<=500)
     &&(f.pointer===undefined||pipComputerPointer(f.pointer)!==null)))
  throw Error('This run\'s screenshots are invalid.');
 return value;
}
// The apps on a Pip computer's desktop (Pips API 54, get_pip_computer_apps / set_pip_computer_apps): which this machine
// has, and the one offer to download the ones it lacks, in one line with its size.
const APP_STATES=['ready','offer','downloading','declined','unavailable','measuring'];
export function pipComputerApps(value){
 const fail=()=>{throw Error('The computer\'s apps didn\'t load. Refresh to try again.');};
 if(!record(value)||Object.keys(value).sort().join()!=='apps,bytes,line,missing,state'||!APP_STATES.includes(value.state)
   ||typeof value.line!=='string'||value.line.length>600||!(value.bytes===null||Number.isSafeInteger(value.bytes)&&value.bytes>0)
   ||!Array.isArray(value.apps)||value.apps.length>8||!Array.isArray(value.missing)||value.missing.length>8)fail();
 for(const a of value.apps)if(!record(a)||Object.keys(a).sort().join()!=='available,key,name,program'||!['images','documents','pdf'].includes(a.key)
   ||typeof a.name!=='string'||typeof a.program!=='string'||typeof a.available!=='boolean')fail();
 if(!value.missing.every(k=>['images','documents','pdf'].includes(k)))fail();
 return value;
}
// Saved logins (Pips API 56, list_pip_logins): where each one fills, its username, whether it has a code and which
// Pips may use it. Never its password or its key: a reply that carries either is refused, not shown.
const LOGIN_KEYS='created_at,has_code,hosts,id,last_used_at,pips,site,source,username';
export function pipLogin(value,pip){
 const fail=()=>{throw Error('The saved logins didn\'t load. Refresh to try again.');};
 if(!record(value)||Object.keys(value).filter(k=>k!=='usable').sort().join()!==LOGIN_KEYS||!/^login_[0-9a-f]{32}$/.test(value.id)
   ||typeof value.site!=='string'||!value.site||value.site.length>512||!Array.isArray(value.hosts)||!value.hosts.length||value.hosts.length>20
   ||!value.hosts.every(h=>typeof h==='string'&&h&&h.length<=255)||typeof value.username!=='string'||value.username.length>512
   ||typeof value.has_code!=='boolean'||!(value.pips==='all'||Array.isArray(value.pips)&&value.pips.length<=64&&value.pips.every(p=>typeof p==='string'&&/^pip_[0-9a-f]{32}$/.test(p)))
   ||!['card','page','sdk'].includes(value.source)||typeof value.created_at!=='string'||!(value.last_used_at===null||typeof value.last_used_at==='string')
   ||(pip!==undefined&&typeof value.usable!=='boolean'))fail();
 return value;
}
export function pipLogins(value,pip){
 if(!record(value)||Object.keys(value).join()!=='logins'||!Array.isArray(value.logins)||value.logins.length>200)throw Error('The saved logins didn\'t load. Refresh to try again.');
 return value.logins.map(login=>pipLogin(login,pip));
}
// How a Personal Pip sees (Pips API 53, get_pip_eyes / set_pip_eyes): its model, whether that model can see, and when
// it can't, the user's choice (ask, a model that sees looks for it, or not now) and the model that would look.
export function pipEyes(value,pip){
 if(!record(value)||Object.keys(value).sort().join()!=='choice,model,pip_id,sees,vision_model'||value.pip_id!==pip
   ||typeof value.model!=='string'||!value.model||value.model.length>256||![true,false,null].includes(value.sees)
   ||!['ask','relay','off'].includes(value.choice)||!(value.vision_model===null||typeof value.vision_model==='string'&&value.vision_model&&value.vision_model.length<=256))
  throw Error('How this Pip sees didn\'t load. Refresh to try again.');
 return value;
}
export function pipComputerFrame(value,run,frame){
 if(!record(value)||value.run_id!==run||value.frame!==frame||!jpegData(value.image))throw Error('That screenshot is invalid.');
 return value;
}
// A Pip computer's Files and Terminal (Pips API 44).
const FILE_NAME=/^[^/\0]{1,255}$/;
function computerPath(path){
 if(path===''||typeof path==='string'&&path.length<=2048&&path.split('/').every(p=>FILE_NAME.test(p)&&p!=='.'&&p!=='..')&&path.split('/').length<=8)return path;
 throw Error('A Pip computer path is invalid.');
}
export function pipComputerFiles(value,path){
 const fail=()=>{throw Error('This computer\'s files are invalid. Refresh.');};
 if(!record(value)||Object.keys(value).sort().join()!=='entries,more,path,total_bytes'||value.path!==path||typeof value.more!=='boolean'
   ||!Number.isSafeInteger(value.total_bytes)||value.total_bytes<0||!Array.isArray(value.entries)||value.entries.length>500)fail();
 computerPath(value.path);
 for(const e of value.entries){
  if(!record(e)||Object.keys(e).sort().join()!=='bytes,kind,modified,name'||typeof e.name!=='string'||!FILE_NAME.test(e.name)||e.name==='.'||e.name==='..'
    ||!['file','folder'].includes(e.kind)||!(e.kind==='folder'?e.bytes===null:Number.isSafeInteger(e.bytes)&&e.bytes>=0)||!Number.isSafeInteger(e.modified))fail();
 }
 return value;
}
export function pipComputerFile(value,path){
 const fail=()=>{throw Error('This file could not be shown.');};
 if(!record(value)||value.path!==path||typeof value.name!=='string'||value.name!==path.split('/').at(-1)||typeof value.mime!=='string'||value.mime.length>200
   ||!Number.isSafeInteger(value.bytes)||value.bytes<0)fail();
 const keys=Object.keys(value).sort().join();
 if(keys==='bytes,mime,name,path,text,truncated'){if(typeof value.text!=='string'||value.text.length>65536||typeof value.truncated!=='boolean')fail();}
 else if(keys==='bytes,data,mime,name,path'){if(typeof value.data!=='string'||!value.data.startsWith(`data:${value.mime};base64,`)||value.data.length>2800000)fail();
  if(value.mime.startsWith('image/')&&!/^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/.test(value.data))fail();}
 else if(keys==='bytes,mime,name,path,too_large'){if(value.too_large!==true)fail();}
 else fail();
 return value;
}
export function pipComputerTerminalEntry(value){
 // reached / blocked: the sites a command reached through DGC, and what DGC refused (this computer, your network).
 const hosts=v=>v===undefined||Array.isArray(v)&&v.length<=12&&v.every(h=>typeof h==='string'&&h.length>0&&h.length<=255);
 if(!record(value)||Object.keys(value).filter(k=>k!=='reached'&&k!=='blocked').sort().join()!=='at,by,command,exit,output,seconds,timed_out'||!hosts(value.reached)||!hosts(value.blocked)||!['you','pip'].includes(value.by)
   ||typeof value.command!=='string'||value.command.length>4000||typeof value.output!=='string'||value.output.length>70000
   ||!(value.exit===null||Number.isSafeInteger(value.exit))||typeof value.timed_out!=='boolean'||typeof value.seconds!=='number'||!Number.isSafeInteger(value.at))
  throw Error('A terminal entry is invalid.');
 return value;
}
export function pipComputerTerminal(value){
 if(!record(value)||!Array.isArray(value.entries)||value.entries.length>200)throw Error('This computer\'s terminal is invalid.');
 value.entries.forEach(pipComputerTerminalEntry);
 return value;
}
// `setup`: DGC downloading the desktop and Chrome itself (pip_screen_setup); an older CLI sends none.
const SETUP_STATES=['none','running','ready','failed','unsupported'];
function desktopSetup(s){
 return s===undefined||record(s)&&Object.keys(s).sort().join()==='done,error,state,step,total'&&SETUP_STATES.includes(s.state)
  &&typeof s.step==='string'&&s.step.length<=200&&typeof s.error==='string'&&s.error.length<=400
  &&[s.done,s.total].every(n=>Number.isSafeInteger(n)&&n>=0);
}
export function pipComputerDesktop(value,pip){
 const keys=record(value)?Object.keys(value).filter(k=>k!=='setup').sort().join():'';
 if(!record(value)||keys!=='available,browser,chrome_install,install,pip_id,reason,using'||!desktopSetup(value.setup)||value.pip_id!==pip
   ||typeof value.available!=='boolean'||typeof value.using!=='boolean'||typeof value.reason!=='string'||typeof value.install!=='string'
   ||typeof value.chrome_install!=='string'||!(value.browser===null||['Google Chrome','Chromium'].includes(value.browser)))
  throw Error('This computer\'s screen status is invalid.');
 return value;
}
