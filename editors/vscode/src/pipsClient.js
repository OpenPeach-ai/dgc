import {createConnectorInputs,mountConnectorInputs,readConnectorInputs,mountConnectorSummary} from './pipsConnectorForm.js';
import {connectorDraft,connectorDraftsPage,connectorCall,connectorInspection,actionStatus,calendarAccounts,calendarDraft,calendarDetails,extendedCalendar,sendAccounts,messageDraft,messageReview,messageHistory,messageStates,emailDraft,emailDraftsPage} from './pipsMessageReviews.js';
import './pips.css';
import {accountChoices,accountReadPlan,appLabels,appReadNotices,extraReadTools,combineReadPlans} from './pipsAppPicker.js';
import './pipsTranscript.css';
import {messageMarkup,replyParts,executionCardMarkup,transcriptIcon} from './pipsTranscript.js';
import {mountSetupCards} from './pipSetupCards.js';
import {mountDigestBar} from './pipDigestBar.js';
import {pipSetup,pipSetups,pipSetupPrompt,pipSetupResolution,appReadPlan,webReadPlan,webReadLabel,SEVERITIES,pipNotifySettings,pipOutcomes,githubReadPlan,githubReadLabel,pipsKeepRunning,pipsDesktopNotifications,pipUsage,pipFeedback,actionGrants,actionGrant,pipComputer,pipComputerAction,pipComputerView,pipComputerFrame,pipComputerFrames} from './pipsModel.js';
import '../media/pips/plush.js';
import {PIP_STATEMENT_NOTICE,pipStatementCandidate,pipStatement,pipStatementsPage,pipStatementDraft,pipStatementResult} from './pipsModel.js';
import {COMMAND_OUTCOME_NOTICE,commandReceipt,commandReceiptsPage,commandRecording,commandOutcomeEntry,commandOutcomeSummary} from './pipsModel.js';
import {esc,record,active,statusLabel,errorText,report,runner,context,presentation,requestBroker,execution,activityPage,activityLabel,scheduleLabel,scheduleFromDraft,approvalStatus,approvalsPage,pipTypes,pipType,pendingReviews,messagesPage,chatContinuity,pipModels,modelChoice,modelLabel,runCheckpoint,checkpointsPage,checkpointBaseline,executionPip,pulsePip,pulsePlan,pulsePlanEqual,pulsePlanFromCommands,pulseRunPins,pulseVerificationPin,pulseVerificationReceipt,pulseCommandLabel,pulseProgress,handoffAction,handoffRecord,handoffsPage,handoffPin,executionResult,executionReview,patchArtifactSource,documentationPip,documentationDraft,savedProposal,ADAPTATION_MODES,adaptationPolicy,adaptationLabel,adaptationsPage,EVENT_TRIGGER_NAMES,commitPathRules,commitPathObservation,eventTrigger,eventTriggerLabel,eventTriggerFromDraft,eventRunPin,draftAutomationPin,sourcePolicy,sourcePolicyLabel,sourceSnapshot,sourcePin,sourceResult,SESSION_STATEMENT_NOTICE,sessionGeneration,sessionSourceSelection,sessionStatement,sessionStatementsPage,workspaceSessionsPage,pipNotification,notificationsPage,notificationNavigation,PIP_MEMORY_NOTICE,pipExceptionSourceEqual,pipExceptionCandidate,pipMemory,pipMemoriesPage,pipMemoryPin,SPECIALIST_ROLES,specialistGrant,specialistPolicy,specialistReceipt,lifecycleRevision,archivalResult} from './pipsModel.js';


// The main DGC chat mounts one instance in a ShadowRoot; the editor document is a fallback.
export const PIPS_API_VERSION=9;
export function mountPips(options) {
  const nativeDocument=window.document,root=options.root||nativeDocument;
  const embedded=root!==nativeDocument,owner=root.ownerDocument||nativeDocument,disposers=[];
  const remoteHost=options.host==='remote';
  let disposed=false,motionPaused=false;
  if(embedded){
    const uri=options.stylesheetUri||root.host?.dataset.styleUri;
    if(options.stylesheetText){const style=owner.createElement('style');style.textContent=options.stylesheetText;root.append(style);disposers.push(()=>style.remove());}else if(uri){const link=owner.createElement('link');link.rel='stylesheet';link.href=uri;root.append(link);disposers.push(()=>link.remove());}
    const shell=owner.createElement('div');shell.className='pip-app-root embedded-pips'+(remoteHost?' remote-pips':'');shell.innerHTML='<main id="app"></main><div id="review-root"></div>';root.append(shell);
  }else nativeDocument.body.classList.add('pip-app-root');
  const shell=embedded?root.querySelector('.pip-app-root'):nativeDocument.body;
  if(!remoteHost)shell.classList.add('extension-pips');
  const document={
    ownerDocument:owner,
    head:embedded?root:nativeDocument.head,body:shell,
    get hidden(){return nativeDocument.hidden;},get activeElement(){return root.activeElement;},
    createElement:tag=>owner.createElement(tag),getElementById:id=>root.querySelector('#'+id),
    querySelector:selector=>root.querySelector(selector),querySelectorAll:selector=>root.querySelectorAll(selector),
    addEventListener(type,fn){const target=type==='visibilitychange'?nativeDocument:root;target.addEventListener(type,fn);disposers.push(()=>target.removeEventListener(type,fn));}
  };
const vscode = {postMessage:options.postMessage};
const broker = requestBroker(message => vscode.postMessage({...message,generation:S.generation}));
const $ = id => document.getElementById(id);
const S = {apiVersion:0,connected:false,supported:false,enabled:false,epoch:0,workspace:null,jobs:[],selected:'',pip:null,runs:[],run:null,runId:'',context:null,runner:null,tab:'chat',versions:[],cursor:null,historyLoaded:false,create:false,loading:false,refreshing:false,busy:false,error:'',notice:'',review:null,visible:true,generation:null,activity:null,activityLoading:false,activityError:'',approvals:[],approvalCursor:null,approvalsLoaded:false,approvalsLoading:false,approvalsError:'',scheduleDirty:false,scheduleDraftVersion:null};
S.connectorDrafts=[];S.connectorDraftError="";let connectorDraftSeq=0;
S.workspaces=[];S.showArchived=false;S.emailDrafts=[];S.emailDraftError="";S.calendarDrafts=[];S.calendarDraftError="";let emailDraftSeq=0,calendarDraftSeq=0;
S.composerPanel='';S.chatControls=null;S.continuity=null;
const chatPreferences=new Map();
const chatActivities=new Map();
let setupEditing=false,setupRows=[],setupLoading=false,setupError='',setupSeq=0,setupDetailSeq=0;
const defaultZone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
S.sourceDirty=false;S.sourceDraftVersion=null;S.adaptations=[];S.adaptationCursor=null;S.adaptationsLoaded=false;S.adaptationsLoading=false;S.adaptationsError='';S.adaptationDirty=false;S.adaptationDraftVersion=null;S.handoffs=[];S.handoffCursor=null;S.handoffsLoaded=false;S.handoffsLoading=false;S.handoffsError='';S.handoffDraft=null;S.executionCapability=null;S.executionLoading=false;S.executionError='';S.checkpoints=[];S.checkpointCursor=null;S.checkpointsLoaded=false;S.checkpointsLoading=false;S.checkpointsError='';S.types=[];S.createStep='type';S.createType='';S.overview=true;S.messages=[];S.messageCursor=null;S.messagesLoaded=false;S.messagesLoading=false;S.messagesError='';S.chatActiveRun=null;S.omitted=0;S.models=[];S.defaultModel='';S.modelsError='';S.modelsLoading=false;S.modelDirty=false;S.stream=null;
const creationDrafts=new Map(),avatarIds=new Map(),chatDrafts=new Map(),chatRequests=new Map();let avatarSequence=0,avatarObserver=null,characterCleanup=null,messageSeq=0,streamSeq=0,streamLoading=false,selectionGeneration=0;
let savedView=options.getState?.(),restoreView=true,navigationPending=!!options.navigation;
S.sidebarPinned=savedView?.sidebar_pinned===true;
function rememberView(){savedView={workspace_id:S.workspace?.id,selected:S.selected,tab:S.tab,overview:S.overview,sidebar_pinned:S.sidebarPinned,drafts:Object.fromEntries([...chatDrafts].slice(-20))};options.setState?.(savedView);}
const characterStyles=document.createElement('style');characterStyles.id='pips-plush-styles';characterStyles.textContent=window.PipConcepts.plush.styles;document.head.append(characterStyles);
let outcomeSessions=[],outcomeSessionsCursor='',outcomeSessionsMore=false,outcomeSessionsLoaded=false,outcomeSessionsLoading=false,outcomeSessionsError='',outcomeHistory=[],outcomeCursor=null,outcomeLoaded=false,outcomeLoading=false,outcomeError='',outcomeInspection=null,outcomeInspecting=false,outcomeSessionSeq=0,outcomeSeq=0,outcomeInspectSeq=0,outcomeReviewSeq=0,outcomeRetry=null;
let notifications=null,notificationItems=[],notificationLoading=false,notificationError='',notificationSeq=0,notificationMark='';
let memories=[],memoryCursor=null,memoryLoaded=false,memoryLoading=false,memoryError='',memorySeq=0,memorySourceSeq=0;
let statementRows=[],statementPage=null,statementLoaded=false,statementLoading=false,statementError='',statementSeq=0,statementAnchorSeq=0,statementInspecting=false,statementRetry=null;
let commandReceipts=[],commandCursor=null,commandMore=false,commandTotal=0,commandLoaded=false,commandLoading=false,commandError='',commandSession='',commandSeq=0,commandDetailSeq=0;
let pulseCommands=[{argv:[''],cwd:'.'}],commitRules=[{kind:'exact',path:''}];
const draft = {newPipName:'',newPipCharacter:'scout',quickKind:'manual',quickTime:'08:30',quickHours:'4',quickZone:defaultZone,feedbackNote:'',webReads:'',chatModelSearch:'',setupTask:'',verificationEnabled:false,statementKind:'fact',statementTitle:'',statementText:'',statementReason:'',statementExpiry:'',statementSource:'',specialistExplorer:false,specialistCritic:false,specialistWorker:false,specialistCalls:'1',memoryExpiry:'',outcomeSession:'',outcomeSourceKind:'commit',outcomeSourceValue:'',outcomeTitle:'',outcomeText:'',sourceMode:'committed_only',sourceReason:'',triggerContext:false,triggerFinding:false,triggerCommit:false,triggerSession:false,triggerPaths:false,triggerMinutes:'5',adaptationMode:'suggest_changes',adaptationName:false,adaptationSource:false,adaptationReason:'',handoffText:'',handoffTarget:'',handoffTask:'',handoffPaths:'',handoffTests:'[]',createModel:'default',pipModel:'default',modelReason:'',findingReviewReason:'',chatText:'',scheduleType:'manual',scheduleAt:'',scheduleCron:'0 9 * * 1-5',scheduleMinutes:'60',scheduleTime:'09:00',scheduleZone:defaultZone,scheduleReason:'',name:'',goal:'',source_ref:'HEAD',revisionGoal:'',revisionReason:'',contextKind:'decision',contextTitle:'',contextContent:''};
let adaptationSeq=0,handoffSeq=0,handoffDetailSeq=0,checkpointSeq=0,refreshSeq=0,selectionSeq=0,detailSeq=0,historySeq=0,activitySeq=0,approvalSeq=0,polling=false,dialogReturn=null,lastMarkup='';
const send = (type,args={}) => broker.request({type,...args});
const usable = () => S.connected && S.supported && S.enabled;
const archived=()=>S.pip?.status==='archived';
const canLifecycle=()=>S.apiVersion>=16&&lifecycleRevision(S.pip)!==null&&lifecycleRevision(S.pip)<Number.MAX_SAFE_INTEGER;
const scope = () => `${S.epoch}:${S.workspace?.id || ''}:${S.selected}:${selectionGeneration}`;
const date = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
const button = (id,text,disabled=false,kind='') => `<button type="button" id="${id}" class="${kind}"${disabled?' disabled':''}>${esc(text)}</button>`;
function avatar(state='idle',type={id:'rook',character_index:4,name:'Rook'},key='welcome') {
  if(!avatarIds.has(key))avatarIds.set(key,++avatarSequence);
  const id=`editor-pip-${avatarIds.get(key)}`;
  return `<span class="avatar" data-avatar-key="${esc(key)}" data-character="${esc(type?.id||'unsupported')}" data-pose="${esc(state)}" aria-hidden="true">${type?window.PipConcepts.plush.markup({index:type.character_index,name:type.name},state,id,{includeStyles:false}):'<span class="unknown-avatar">?</span>'}</span>`;
}
function observeAvatars() {
  characterCleanup?.();
  characterCleanup=window.PipConcepts.plush.mount?.(document);
  avatarObserver?.disconnect();avatarObserver=null;
  if(typeof IntersectionObserver!=='function')return;
  avatarObserver=new IntersectionObserver(entries=>{for(const e of entries)e.target.classList.toggle('motion-offscreen',!e.isIntersecting);},{threshold:0});
  for(const node of document.querySelectorAll('.avatar')){node.classList.add('motion-offscreen');avatarObserver.observe(node);}
}
const field = (key,label,textarea=false) => `<label>${esc(label)}${textarea?`<textarea data-draft="${key}" id="${key}">${esc(draft[key])}</textarea>`:`<input data-draft="${key}" id="${key}" value="${esc(draft[key])}" autocomplete="off">`}</label>`;
const errorMarkup = value => value ? `<p class="notice error" role="alert">${esc(value)}</p>` : '';
function setError(error) { S.error=errorText(error); render(); }
function contextEntries(entries,archivable=false) {
  if(entries.some(e=>e.provenance?.source==='session_execution'))return entries.map(e=>e.provenance?.source==='session_execution'?`<article class="entry"><span class="badge">Recorded command outcome</span><h3>${esc(e.title)}</h3>${commandContextSummary(e)}${commandContextDetails(e)}${archivable?`<div class="actions"><button type="button" data-archive="${esc(e.id)}"${S.busy||!usable()?' disabled':''}>Archive record</button></div>`:''}</article>`:contextEntries([e],archivable)).join('');
  return entries.length ? entries.map(e=>`<article class="entry"><span class="badge">${e.kind==='session_outcome'?'Reviewed session statement':e.kind==='execution'?'Reviewed execution receipt':e.kind==='finding'?'Model assessment':esc(e.kind)}</span><h3>${esc(e.title)}</h3><div class="goal">${esc(e.kind==='session_outcome'?e.provenance.proposal.statement:e.content)}</div><p class="muted">${e.kind==='session_outcome'?SESSION_STATEMENT_NOTICE.trim():e.kind==='execution'?`Historical runner receipt · accepted review v${e.provenance.review_revision}. Later reviews may differ; this does not describe current source health or prove correctness.`:e.kind==='finding'?'Source excerpt checked; the conclusion is not independently verified.':'Recorded by a user.'} ${e.kind==='command'?'Reference only; this grants no permission to execute.':''}</p>${e.kind==='finding'&&e.provenance.schema_version===2?`<dl class="meta">${pinnedSourceMarkup(e.provenance)}</dl>${pinnedSourceNotice(e.provenance)}`:''}${e.kind==='session_outcome'?sessionStatementDetails(e.provenance.proposal,e.provenance.proposal_digest):''}${e.provenance?.run_id?`<small>Run ${esc(e.provenance.run_id)} · job v${esc(e.provenance.job_version)} · ${esc(e.provenance.model)}</small>`:''}${archivable?`<div class="actions"><button type="button" data-archive="${esc(e.id)}"${S.busy||!usable()?' disabled':''}>Archive record</button></div>`:''}</article>`).join('') : '<p class="muted">No active context records.</p>';
}
// Keep Pips running (API 41): one switch that starts the runner at login and after a restart.
let keepState={value:null,loading:false,error:'',asked:false};
async function loadKeepRunning(){
 if(remoteHost||S.apiVersion<41||!usable()||keepState.loading)return;
 const token=S.epoch;keepState={...keepState,loading:true,asked:true};   // runner-wide: not tied to a selected Pip
 try{const value=pipsKeepRunning((await send('get_pips_keep_running')).keep_running);if(token===S.epoch){keepState.value=value;keepState.error='';}}
 catch(error){if(token===S.epoch)keepState.error=errorText(error);}
 finally{keepState.loading=false;if(token!==S.epoch)keepState.asked=false;render();}
}
async function setKeepRunning(enabled){
 if(S.busy||!usable())return;const token=scope();S.busy=true;render();
 try{const value=pipsKeepRunning((await send('set_pips_keep_running',{enabled})).keep_running);if(token!==scope())return;keepState.value=value;keepState.error='';
  S.notice=value.on?(value.while_logged_out?'Pips keep running: the runner starts when you log in, restarts if it fails, and runs while you are logged out.':'Pips keep running: the runner starts when you log in and restarts if it fails.'):'Pips no longer start on their own. The runner running now keeps going until you stop it.';}
 catch(error){if(token===scope()){keepState.error=errorText(error);setError(error);}}
 finally{if(token===scope()){S.busy=false;render();}}
}
let desktopState={value:null,loading:false,error:'',asked:false};
async function loadDesktopNotifications(){
 if(remoteHost||S.apiVersion<41||!usable()||desktopState.loading)return;
 const token=S.epoch;desktopState={...desktopState,loading:true,asked:true};   // runner-wide: not tied to a selected Pip
 try{const value=pipsDesktopNotifications((await send('get_pips_desktop_notifications')).desktop_notifications);if(token===S.epoch){desktopState.value=value;desktopState.error='';}}
 catch(error){if(token===S.epoch)desktopState.error=errorText(error);}
 finally{desktopState.loading=false;if(token!==S.epoch)desktopState.asked=false;render();}
}
async function setDesktopNotifications(enabled){
 if(S.busy||!usable())return;const token=scope();S.busy=true;render();
 try{const value=pipsDesktopNotifications((await send('set_pips_desktop_notifications',{enabled})).desktop_notifications);if(token!==scope())return;desktopState.value=value;desktopState.error='';
  S.notice=value.on?'Desktop notifications on: the runner tells you about a new alert or review, even with the editor closed.':'Desktop notifications off. The editor still tells you while it is open (dgc.notifyPips).';}
 catch(error){if(token===scope()){desktopState.error=errorText(error);setError(error);}}
 finally{if(token===scope()){S.busy=false;render();}}
}
function desktopNotificationsMarkup(){
 if(remoteHost||S.apiVersion<41||!S.connected||!S.enabled)return '';
 if(!desktopState.asked&&usable())void loadDesktopNotifications();
 const d=desktopState.value;
 if(!d)return desktopState.error?`<p class="muted keep-running-note">${esc(desktopState.error)}</p>`:'';
 const note=!d.available?'This computer has no notification tool the runner can use. The editor still tells you while it is open.'
  :d.last&&!d.last.shown?'The last one did not show: this computer has no notification service running (a server you reach remotely, for example). The editor still tells you while it is open.'
  :'A new alert or review shows as a desktop notification, even with the editor closed.';
 return `<label class="keep-running"><input type="checkbox" id="desktop-notifications"${d.on?' checked':''}${S.busy||!usable()?' disabled':''}> Desktop notifications</label><p class="muted keep-running-note">${esc(note)}</p>`;
}
function keepRunningMarkup(){
 if(remoteHost||S.apiVersion<41||!S.connected||!S.enabled)return '';
 if(!keepState.asked&&usable())void loadKeepRunning();
 const k=keepState.value;
 if(!k)return keepState.error?`<p class="muted keep-running-note">${esc(keepState.error)}</p>`:'';
 if(!k.supported)return `<p class="muted keep-running-note">${esc(k.reason)}</p>`;
 const note=k.on?(k.while_logged_out?'Starts when you log in and after a restart, restarts if it fails, and runs while you are logged out.':'Starts when you log in and after a restart, and restarts if it fails.'):'Off: Pips run only while a runner you started is running. Turn this on so a schedule still runs after a restart.';
 return `<label class="keep-running"><input type="checkbox" id="keep-running"${k.on?' checked':''}${S.busy||!usable()?' disabled':''}> Keep Pips running</label><p class="muted keep-running-note">${esc(note)}</p>`;
}
function runnerMarkup() {
  const r=S.runner,paused=r?.paused;
  const state=`<span class="runner-status"><i class="status-dot${r?.online?' online':''}" aria-hidden="true"></i>${!S.connected?'Local DGC disconnected':!S.enabled?'Pips disabled':r?`Runner ${esc(r.status)}${paused?' · globally stopped':''}`:'Runner status unavailable'}</span>`;
  const start=remoteHost?'':`${r&&!r.online&&!paused?button('start-runner','Start runner',S.busy||!usable()):''}${paused?button('resume-runner','Resume runner…',S.busy||!usable()):''}`;
  const counts=r?`<span class="muted">${r.counts.queued} queued · ${r.counts.running} running</span>`:'';
  const controls=`${button('refresh','Refresh',!usable())}${button('stop-all','Stop all Pips…',!usable()||S.busy,'danger')}`;
  return `<div class="runner compact-runner">${state}${start}<details class="runner-controls" data-details="runner-controls"><summary id="runner-controls-toggle">Controls</summary><div class="runner-menu">${counts}${keepRunningMarkup()}${desktopNotificationsMarkup()}<div class="actions">${controls}</div><p class="muted">Stop pauses all Pips across local workspaces and cancels active runs. Resume the runner, then resume individual Pips.</p>${remoteHost?'<p class="muted">Start or resume the supervisor on the computer with <code>dgc pips resume</code> and <code>dgc pips serve</code>. Remote cannot enable Pips or change its runner configuration.</p>':button('disable','Disable local Pips…',S.busy||!usable())}</div></details></div>${r?.error?errorMarkup(r.error.message):''}`;
}
function welcome() {
  if(remoteHost&&!S.connected)return `<div class="empty">${avatar('offline')}<h2>Computer disconnected</h2><p class="muted">Reconnect the approved computer to read current Pips and send commands over the encrypted connection.</p>${button('reconnect','Check connection')}</div>`;
  if(remoteHost&&!S.enabled)return '<div class="empty"><h2>Enable Pips on the computer</h2><p class="muted">Remote cannot enable this feature, choose a local path, or start its supervisor.</p><code>dgc remote connect --pips</code></div>';
  if (!S.connected) return `<div class="empty">${avatar('offline')}<h2>Connect to local DGC</h2><p class="muted">Pips uses the DGC process in this editor. No web account is needed.</p>${button('reconnect','Reconnect')}</div>`;
  // An API new enough for Pips that still says unsupported is the platform, not the version.
  if (!S.supported && S.apiVersion >= 41) return `<div class="empty"><h2>Pips run on Linux and macOS</h2><p class="muted">Pips are not available on Windows yet. A DGC installed inside WSL is a Linux install. Everything else in DGC works here.</p></div>`;
  if (!S.supported) return `<div class="empty"><h2>Update the DGC CLI to use Pips</h2><p class="muted">This editor requires Pips API v${PIPS_API_VERSION}, including reviewed execution context and Patch artifact handoffs. Update the DGC CLI, then reconnect.</p>${button('reconnect','Reconnect')}</div>`;
  if (!S.enabled) return `<div class="empty">${avatar()}<h2>A small team for your committed code</h2><p>Choose a Pip to explore, research, review, or inspect security in a source snapshot.</p><p class="muted">Source presets inspect committed code. Patch and Pulse require a separate approved handoff for each isolated edit or test run. All chats stay read-only. Uses your configured DGC model.</p>${button('enable','Enable local Pips',S.busy,'primary')}</div>`;
  if (S.loading) return '<p role="status">Loading the current workspace…</p>';
  if (!S.types.length || !S.workspace) return `<div class="empty"><h2>Workspace and Pip types unavailable</h2><p class="muted">Reconnect to load the local type catalog and workspace before creating a Pip.</p>${button('reconnect','Reconnect')}</div>`;
  return '';
}
function createMarkup() {
  if(S.workspace?.kind==='personal'&&S.createStep!=='describe')return `<section class="setup-compose"><h2>Your personal Pip</h2><p class="muted">Available across your projects on this computer. No project files or app access are inherited.</p><form id="create-form" class="form"><label for="personal-character">Character</label><select id="personal-character">${S.types.filter(t=>t.available).map(t=>`<option value="${esc(t.id)}"${t.id===S.createType?' selected':''}>${esc(t.name)}</option>`).join('')}</select>${field('name','Name')}${field('goal','What would you like help with?',true)}${modelPicker('createModel','Model',draft.createModel)}<p class="muted">Start a private conversation. App access must be separately supported and reviewed before email or calendar jobs can run.</p><button type="submit" class="primary">Create personal Pip</button>${button('cancel-create','Cancel',S.busy)}</form></section>`;

  if(S.workspace?.kind==='personal'&&S.createStep==='describe')return `<section class="setup-compose"><p class="step">Personal · across your projects</p><h2>What would you like a hand with?</h2>${startersMarkup('personal')}${importMarkup()}<p class="muted">Describe the task in your own words. DGC will prepare a setup card for your review.</p><form id="setup-prompt-form" class="form">${field('setupTask','Describe the job',true)}<p class="muted">For example: Help me plan my week every Sunday at 6 pm. Ask me what to include.</p>${options.onSetupPrompt&&!remoteHost?'<button type="submit" class="primary">Describe to DGC</button>':'<p>Describe the task in the main DGC chat.</p>'}</form><p class="muted">Private to this DGC profile. No project files or connected apps are included automatically.</p><div class="actions">${button('advanced-create','Choose a Pip myself',S.busy)}${button('cancel-create','Cancel',S.busy)}</div></section>`;
  if(S.createStep==='describe')return `<section class="setup-compose" aria-labelledby="setup-compose-title"><p class="step">Start with the job</p><h2 id="setup-compose-title">What should your Pip look after?</h2>${startersMarkup('project')}${importMarkup()}<p class="muted">Tell DGC the project, the task, and when to do it. It will prepare one setup card for you to review before anything starts.</p><form id="setup-prompt-form" class="form">${field('setupTask','Describe the job',true)}<p class="muted">For example: Review committed changes in this project daily at 11:00 in Asia/Kolkata. Also run once today.</p>${options.onSetupPrompt&&!remoteHost?'<button type="submit" class="primary"'+(S.busy||!usable()?' disabled':'')+'>Describe to DGC</button>':'<p class="notice">Describe this setup in the main DGC chat on your computer. This view cannot send a setup prompt to that chat.</p>'}</form><p class="muted">Project: ${esc(S.workspace.name)}. DGC must resolve and confirm the project folder. Application smoke tests need separately reviewed test commands.</p><div class="actions">${button('advanced-create','Advanced: choose a Pip',S.busy)}${button('cancel-create','Cancel',S.busy)}</div></section>`;

  if(S.createStep==='type')return `<section class="type-picker" aria-labelledby="type-picker-title"><p class="step">Step 1 of 2 · Choose your Pip</p><h2 id="type-picker-title">Who’s right for this job?</h2><p class="muted">Scout, Lens, Rook and Lock inspect committed source. Patch and Pulse execute explicitly reviewed commands in an isolated copy. Pulse also supports reviewed standing command plans on API 21. Quill prepares private documentation drafts. Every Pip’s conversation stays read-only.</p>${S.types.length?`<div class="type-grid">${S.types.map(t=>`<article class="type-card${t.available?'':' planned'}" data-type-card="${esc(t.id)}">${avatar(t.available?'idle':'offline',t,`choose-${t.id}`)}<div class="type-copy"><h3>${esc(t.name)}<span class="badge">${t.available?(executionPip(t)?'Review required':documentationPip(t)?'Draft only':'Read-only preset'):'Planned'}</span></h3><p class="type-role">${esc(t.role)}</p><p class="muted">${esc(t.description)}</p>${!t.available?`<p class="type-reason">${esc(t.unavailable_reason)}</p>`:''}</div><button type="button" data-pip-type="${esc(t.id)}"${!t.available||S.busy||!usable()?' disabled':''}>${t.available?`Choose ${esc(t.name)}`:'Not available yet'}</button></article>`).join('')}</div>`:'<p class="notice error">Pip types are unavailable. Reconnect to retry.</p>'}<div class="actions">${button('cancel-create','Cancel',S.busy)}</div></section>`;
  const type=S.types.find(t=>t.id===S.createType);
  if(!type?.available)return '<p class="notice error">This Pip type is unavailable. Go back and choose an available type.</p>';
  return `<form id="create-form" class="form"><p class="step">Step 2 of 2 · Configure the job</p><div class="create-hero">${avatar('idle',type,`configure-${type.id}`)}<div><h2>Your ${esc(type.name)}</h2><p class="muted">${esc(type.role)} · ${executionPip(type)?'Reviewed execution':documentationPip(type)?'Private drafts':'Read-only preset'}</p></div></div><p>${esc(type.description)}</p><p class="muted">Starts manually in ${esc(S.workspace?.name || 'this workspace')}. ${pulsePip(type)?'Starts with no standing command permission. On API 21 you can separately review a command plan and calendar after creation.':executionPip(type)?'Only an approved handoff can execute this Pip; there are no schedules.':documentationPip(type)?(S.apiVersion>=20?'You can review a committed-source schedule or event trigger after creation. Quill cannot receive handoffs.':'Quill starts manually. Update the computer to Pips API 20 to review schedules or event triggers. Quill cannot receive handoffs.'):'You can review a schedule after creation.'} Only committed source at the selected Git ref is included.</p>${field('name','Name')}${field('goal','Job goal',true)}${field('source_ref','Source ref')}${modelPicker('createModel','Model',draft.createModel)}<p class="muted">Use HEAD, a branch, or a commit. Uncommitted edits are excluded. ${executionPip(type)?'Chat remains read-only. Each edit or test run requires its own permission review. Creating this Pip grants no standing write or test access.':documentationPip(type)?'Quill returns model-authored draft text and exact source citations. No project file is changed or published.':'This preset uses the shared read-only source engine; choosing a character grants no new permissions.'}</p><div class="actions">${button('back-types','Back to Pip types',S.busy)}<button class="primary" type="submit"${S.busy||!usable()?' disabled':''}>${executionPip(type)?'Review capabilities…':'Create Pip'}</button>${button('cancel-create','Cancel',S.busy)}</div></form>`;
}
async function finishCreate(result){
  if(!record(result.pip)||typeof result.pip.id!=='string'||result.pip.workspace_id!==S.workspace.id)throw new Error('Created Pip does not match this workspace.');
  creationDrafts.delete(S.createType);draft.name='';draft.goal='';draft.source_ref='HEAD';S.createType='';S.createStep='type';S.busy=false;await select(result.pip.id);await refresh(true);
}
function rememberCreationDraft(){if(S.createType)creationDrafts.set(S.createType,{name:draft.name,goal:draft.goal,source_ref:draft.source_ref,createModel:draft.createModel});}
function modelPicker(id,label,value) {
  const explicit=value.startsWith('model:')?value.slice(6):'';
  return `<label for="${id}">${esc(label)}</label><select id="${id}" data-draft="${id}"><option value="default"${value==='default'?' selected':''}>Configured default${S.defaultModel?` · ${esc(S.defaultModel)}`:''}</option>${explicit&&!S.models.some(m=>m.id===explicit)?`<option value="${esc(value)}" selected>${esc(explicit)} · not in current list</option>`:''}${S.models.map(m=>`<option value="model:${esc(m.id)}"${explicit===m.id?' selected':''}>${esc(m.name)}</option>`).join('')}</select>${S.modelsLoading?'<p class="muted" role="status">Loading models…</p>':''}${S.modelsError?`<p class="muted">${esc(S.modelsError)} ${button('refresh-models','Try again',S.modelsLoading||!usable(),'link')}</p>`:`<p class="muted">Models from your DGC connection. ${button('refresh-models','Refresh list',S.modelsLoading||!usable(),'link')}</p>`}`;
}
async function loadModels(){
  if(!usable()||S.modelsLoading)return;const epoch=S.epoch;S.modelsLoading=true;S.modelsError='';render();
  try{const result=pipModels(await send('list_pip_models'));if(epoch!==S.epoch)return;S.models=result.models;S.defaultModel=result.default_model;S.modelsError=result.error?errorText(result.error):'';}
  catch(error){if(epoch===S.epoch)S.modelsError=errorText(error);}
  finally{if(epoch===S.epoch){S.modelsLoading=false;render();}}
}
const chatThinkingLevels=['off','low','medium','high','xhigh'];
function checkedChatControls(value){
 const keys='context_max,context_min,context_note,effective_context_size,inherited_context_size,mode,options,options_source,reasoning_control,reasoning_note,thinking_levels,version';
 if(!record(value)||Object.keys(value).sort().join()!==keys||value.version!==1||value.mode!=='read_only'||value.context_min!==2048||![32768,...(S.apiVersion>=25?[1048576]:[])].includes(value.context_max)||!Number.isSafeInteger(value.inherited_context_size)||value.inherited_context_size<1||!['default','last_message'].includes(value.options_source)||!['provider_dependent','instructions'].includes(value.reasoning_control)||typeof value.reasoning_note!=='string'||value.reasoning_note.length>2000||typeof value.context_note!=='string'||value.context_note.length>2000||!Array.isArray(value.thinking_levels)||value.thinking_levels.join(',')!==chatThinkingLevels.join(','))throw Error('Pip chat controls are unavailable or invalid. Refresh before sending another message.');
 checkedChatOptions(value.options,value.context_max);if(value.effective_context_size!==value.options.context_size)throw Error('The requested Pip context budget differs from its displayed value. Refresh before sending.');return value;
}
function checkedChatOptions(value,max=S.chatControls?.context_max||32768){
 if(!record(value)||Object.keys(value).sort().join()!=='context_size,thinking'||!Number.isSafeInteger(value.context_size)||value.context_size<2048||value.context_size>max||!chatThinkingLevels.includes(value.thinking))throw Error('Choose a supported context budget and thinking level.');return {context_size:value.context_size,thinking:value.thinking};
}
function chosenChatOptions(){return checkedChatOptions(chatPreferences.get(S.selected)||S.chatControls?.options);}
// The main chat's two-zone composer, using only controls Pip chat supports.
function composerIcon(name){const paths={shield:'<path d="M8 1.5 13 3.5v4c0 3-2 5-5 7-3-2-5-4-5-7v-4Z"/><path d="m6 8 1.3 1.3L10 6.5"/>',context:'<path d="M7 2a6 6 0 1 0 7 7H7Z"/><path d="M9 1.5V7h5.5A6 6 0 0 0 9 1.5Z"/>',up:'<path d="M8 14V2M3 7l5-5 5 5"/>',chevron:'<path d="m4 10 4-4 4 4"/>',stop:'<rect x="4" y="4" width="8" height="8" rx=".5"/>',image:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.8" r="1.1"/><path d="m2.5 11.5 3.5-3.5 2.5 2.5 2-2 3 3"/>'};return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${paths[name]||''}</svg>`;}
function continuityMarkup(){
 const c=S.continuity;if(!c)return '<p class="composer-scope">A continuation checkpoint is saved when your next reply completes.</p>';
 return `<details class="chat-continuity"><summary>Conversation continuity${c.summarized_messages?' · '+c.summarized_messages+' messages summarized':''}</summary><p class="muted">${esc(c.notice)}</p><p class="muted">${c.strategy==='mechanical'?'Local fallback brief. Some exact details may be omitted; original messages remain saved.':c.strategy==='model'?'Model-generated rolling summary.':'Recent messages are retained verbatim; no summary needed yet.'}</p>${c.summary?`<pre>${esc(c.summary)}</pre>`:''}<p class="muted">Saved from ${esc(c.provenance.model||'the pinned model')} · job v${esc(c.provenance.job_version)} · checkpoint ${c.checkpoint_id}</p></details>`;
}
function chatControlsMarkup(canSend,busy){
 const locked=archived()||!usable()||S.busy,current=S.pip.model_choice?.mode==='model'?S.pip.model_choice.model:'',modelText=current||'Inherit DGC',selected=current?'model:'+current:'default',available=S.apiVersion>=24&&!!S.chatControls,o=available?chosenChatOptions():null;
 const unavailable=`<p class="composer-unavailable">${S.apiVersion<24?'Context / thinking: backend update required.':'Chat controls are unavailable. Refresh before sending.'}</p>`;
 const effort=o?`<div class="composer-effort-control" style="--effort:${chatThinkingLevels.indexOf(o.thinking)/4*100}%"><label class="sr-only" for="chat-thinking">Thinking for next reply</label><input id="chat-thinking" class="composer-effort-slider" type="range" min="0" max="4" step="1" value="${chatThinkingLevels.indexOf(o.thinking)}" aria-valuetext="${esc(o.thinking)}" aria-describedby="chat-thinking-support" title="Thinking for the next reply only. ${esc(S.chatControls.reasoning_note)}"${locked?' disabled':''}><div class="composer-effort-labels"><span>Off</span><output for="chat-thinking">${o.thinking==='xhigh'?'Extra high':o.thinking[0].toUpperCase()+o.thinking.slice(1)}</output><span>Extra high</span></div><p class="composer-scope">For the next reply. Support varies by model.</p><p id="chat-thinking-support" class="sr-only">${esc(S.chatControls.reasoning_note)}</p></div>`:unavailable;
 const modelMenu=S.composerPanel==='model'?`<div class="composer-model-menu" role="dialog" aria-label="Model and thinking"><div class="section-head"><strong>Model and thinking</strong>${button('chat-model-close','Close')}</div>${effort}<div class="composer-model-heading"><strong>Model for this Pip</strong><p class="muted">Changes require review. Queued work keeps its model.</p></div><label class="sr-only" for="chatModelSearch">Search models</label><input id="chatModelSearch" data-draft="chatModelSearch" value="${esc(draft.chatModelSearch)}" placeholder="Search models" autocomplete="off"><div class="composer-model-options" role="listbox" aria-label="Available models"><button type="button" role="option" data-chat-model="default" aria-selected="${selected==='default'}"${locked?' disabled':''}>Inherit DGC${S.defaultModel?`<small>${esc(S.defaultModel)}</small>`:''}</button>${S.models.filter(m=>(m.name+' '+m.id).toLowerCase().includes(draft.chatModelSearch.toLowerCase())).map(m=>`<button type="button" role="option" data-chat-model="model:${esc(m.id)}" aria-selected="${selected==='model:'+m.id}"${locked?' disabled':''}>${esc(m.name)}${m.name!==m.id?`<small>${esc(m.id)}</small>`:''}</button>`).join('')}</div>${S.modelsLoading?'<p class="muted" role="status">Loading models…</p>':''}${S.modelsError?errorMarkup(S.modelsError):''}${current&&!S.modelsLoading&&!S.models.some(m=>m.id===current)?'<p class="muted">The current model is absent from this list. Its saved choice remains unchanged.</p>':''}${button('chat-refresh-models','Refresh models',S.modelsLoading||locked)}</div>`:'';
 const sizes=o?[...new Set([2048,4096,8192,16384,32768,65536,131072,262144,524288,1048576,o.context_size])].filter(n=>n<=S.chatControls.context_max).sort((a,b)=>a-b):[];
 const contextMenu=S.composerPanel==='context'?`<section class="composer-model-menu composer-context-menu" role="dialog" aria-label="Context window"><div class="section-head"><strong>Context window</strong>${button('chat-context-close','Close')}</div>${o?`<div class="composer-context-size"><label for="chat-context">Window size</label><select id="chat-context" aria-label="Context for next reply" title="Context budget for the next reply only. Main DGC requests ${S.chatControls.inherited_context_size.toLocaleString()} tokens; Pips supports 2,048–${S.chatControls.context_max.toLocaleString()}. ${esc(S.chatControls.context_note)}"${locked?' disabled':''}>${sizes.map(n=>`<option value="${n}"${o.context_size===n?' selected':''}>${n===1048576?'1M':n%1024===0?n/1024+'K':n.toLocaleString()}</option>`).join('')}</select></div><p class="composer-scope">Applies to the next reply. Pips supports 2,048–${S.chatControls.context_max.toLocaleString()} tokens; main DGC requests ${S.chatControls.inherited_context_size.toLocaleString()}.</p><p class="muted">${esc(S.chatControls.context_note)}</p>${continuityMarkup()}`:unavailable}</section>`:'';
 const action=busy?`<button type="button" id="chat-stop" class="composer-chip" title="Stop generation" aria-label="Stop generation"${S.busy||!usable()?' disabled':''}>${composerIcon('stop')}</button>`:`<button type="submit" class="chat-send${canSend&&(draft.chatText.trim()||canAttachImages()&&pendingImages().length)?' ready':''}" aria-label="Send message" title="Send message"${canSend?'':' disabled'}>${composerIcon('up')}</button>`;
 return `${modelMenu}${contextMenu}<div class="composer-controls"><div class="composer-left">${canAttachImages()?`<button type="button" id="chat-attach" class="composer-chip" title="Add images" aria-label="Add images"${S.busy||archived()?' disabled':''}>${composerIcon('image')}</button><input type="file" id="chat-attach-input" accept="${PIP_IMAGE_TYPES.join(',')}" multiple hidden>`:''}<button type="button" id="chat-context-toggle" class="composer-chip" title="Context window${o?' · '+o.context_size.toLocaleString()+' tokens':''}" aria-label="Context window" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='context'}">${composerIcon('context')}</button><button type="button" id="chat-permissions" class="composer-chip" title="${personalPip()?'Personal Pip · no project tools or external actions':'Read-only Pip chat · captured source tools only'}" aria-label="Read-only permissions">${composerIcon('shield')}<span class="sr-only">Read-only</span></button></div><div class="composer-right"><button type="button" id="chat-model" class="model-control" aria-label="Change model and thinking" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='model'}" title="${esc(modelText)}${o?' · '+o.thinking:''} — change model and thinking"${locked?' disabled':''}><span class="model-copy"><span class="composer-model-name">${esc(modelText)}</span>${o?`<span class="composer-effort-name">${esc(o.thinking)}</span>`:''}</span><span class="composer-chevron">${composerIcon('chevron')}</span></button>${action}</div></div>`;
}
function fitChatInput(){const input=$('chatText');if(!input)return;const sendButton=document.querySelector('.chat-send');sendButton?.classList.toggle('ready',!sendButton.disabled&&!!draft.chatText.trim()||!sendButton.disabled&&canAttachImages()&&pendingImages().length>0);if(!input.isConnected||input.clientWidth<40||document.hidden)return;input.style.height='auto';const content=input.scrollHeight,capped=content>=160;input.style.overflowY=capped?'auto':'hidden';input.style.height=(capped?160:content+1)+'px';}
function updateChatPreference(kind,value){
 if(S.apiVersion<24||!S.chatControls||!S.selected||!usable()||S.busy||archived())return;
 try{const previous=chosenChatOptions(),next=checkedChatOptions({...previous,[kind]:kind==='context_size'?Number(value):value});chatPreferences.set(S.selected,next);S.error='';render();}catch(error){setError(error);}
}
function reviewChatModel(value){
 if(!usable()||S.busy||archived()||!S.pip)return;
 let choice;try{choice=modelChoice(value,S.models);}catch(error){setError(error);return;}
 S.composerPanel='';draft.chatModelSearch='';const current=S.pip.model_choice||{mode:'default'};if(JSON.stringify(choice)===JSON.stringify(current)){render();return;}
 const version=S.pip.current_version,pip=S.selected;
 void mutate({type:'propose_pip_update',pip_id:pip,expected_version:version,changes:{model_choice:choice},reason:'Model selected in this Pip conversation.'},result=>{const proposal=result.proposal;if(!record(proposal)||proposal.pip_id!==pip||proposal.expected_version!==version||!record(proposal.definition)||JSON.stringify(proposal.definition.model_choice)!==JSON.stringify(choice))throw Error('The saved model choice differs from the selection. Refresh before reviewing it.');S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(p=>p.id!==proposal.id),proposal]};S.notice='Model choice saved for review. Future chats and model-based jobs change only after you accept it.';proposalReview(proposal.id);});
}
function chatResultCards(){
  if(!executionPip(S.pip))return '';
  return S.runs.filter(r=>r.pip_id===S.selected&&['patch','test'].includes(r.manifest?.run_kind)).slice(0,3).map(run=>{
    let changedFiles=null,tests=null,error='';
    try{if(run.result?.execution){const pin=handoffPin(run.manifest.handoff,run,S.workspace.id),result=executionResult(run.result.execution,run.manifest.run_kind,pin.payload.action,pin.payload);changedFiles=result.changes.changed_files;tests=result.tests.length;}}
    catch(e){error=errorText(e);}
    return executionCardMarkup(run,{changedFiles,tests,error,formatDate:date});
  }).join('');
}
function chatSetupCards(){
 // Every change waiting for the user shows here, whoever saved it: the Pip, the main chat or an older build.
 return waitingProposals().map(p=>`<div class="chat-setup-review" aria-label="Change waiting for you"><span class="chat-setup-label">${esc(changeSummary(p))} <small>Waiting for you</small></span><button type="button" class="primary" data-proposal="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>Review</button><button type="button" data-reject="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>Reject</button></div>`).join('');
}
// Above every other tab: what is waiting, in words, with the two choices.
function waitingMarkup(){
 const waiting=waitingProposals();if(!waiting.length||archived())return '';
 return `<section class="waiting" aria-label="Changes waiting for you"><h3>${waiting.length===1?'A change is waiting for you':`${waiting.length} changes are waiting for you`}</h3>${waiting.map(p=>`<div class="waiting-row"><p>${esc(changeSummary(p))}</p><div class="actions"><button type="button" class="primary" data-proposal="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>Review</button><button type="button" data-reject="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>Reject</button></div></div>`).join('')}</section>`;
}
function renderPipMarkdown(text){return window.DgcMarkdown?.render?window.DgcMarkdown.render(text):`<div class="chat-text">${esc(text)}</div>`;}
function chatMarkup(){
  const type=pipType(S.pip,S.types),busy=S.chatActiveRun,canSend=(S.apiVersion<24||!!S.chatControls)&&!archived()&&S.messagesLoaded&&usable()&&type?.available&&supportedSource()&&S.runner?.online&&!S.runner?.paused&&!S.busy&&!busy;
  const markdown=renderPipMarkdown;
  const shown=S.messages.filter(m=>!(m.role==='user'&&m.intro===true));
  // While it answers, the Pip itself is in the chat, at work, with its name: the reply replaces it.
  const simple=simpleMode(),typing=busy&&(simple||S.messages.some(m=>m.role==='user'&&m.intro===true&&m.run_id===S.chatActiveRun?.id))&&!S.stream?.text
   ?(simple?`<div class="pip-working" role="status">${avatar('working',type||characterType(S.pip.pip_type),`working-${S.pip.id}`)}<span>${esc(S.pip.name)} ${!S.runner?.online?'will answer when your Pips are running':S.chatActiveRun?.status==='queued'?'is getting ready':'is working'}</span></div>`
    :`<article class="pip-message assistant typing" aria-label="${esc(S.pip.name)} is writing"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></article>`):'';
  let last=null;
  const timed=m=>{const at=Date.parse(m.created_at),mark=simple&&Number.isFinite(at)&&(last===null||at-last>30*60*1000)?`<p class="chat-time">${esc(chatTime(at))}</p>`:'';if(Number.isFinite(at))last=at;return mark;};
  const messages=shown.map(m=>timed(m)+messageMarkup(m,{imageSrc:messageImageSrc,split:simple,name:type?.name||'Pip',formatDate:date,renderMarkdown:markdown,canSend,prompt:S.messages.find(p=>p.role==='user'&&p.run_id===m.run_id),activity:chatActivities.get(m.run_id)})).join('');
  return `<section class="pip-conversation" aria-label="Pip conversation"><div class="conversation-log" role="log" aria-live="polite">${errorMarkup(S.error)}${S.notice?`<p class="notice" role="status">${esc(S.notice)}</p>`:''}${S.messageCursor&&S.messages.length<200?button('older-messages','Load earlier messages',S.messagesLoading||!usable()):''}${S.messages.length>=200?'<p class="muted">Showing the latest 200 loaded messages. Earlier messages remain saved.</p>':''}${S.messagesError?errorMarkup(S.messagesError):''}${!S.messagesLoaded?'<p role="status" class="muted">Loading conversation…</p>':!S.messages.length?`<div class="conversation-empty"><h3>Talk to ${esc(type?.name||'this Pip')}</h3><p class="muted">${personalPip()?'Talk about your plans, ask questions, or share details to work with.':'Ask about '+(currentTree()?'the captured working-tree source':'the committed source')+' in this workspace.'} This saved conversation belongs to ${esc(S.pip.name)}.</p><p class="muted">${personalPip()?'No project files or app connections are included automatically.':type?esc(type.description):'Unsupported Pip type.'}</p></div>`:''}${messages}${typing}${S.stream?.text?`<article class="pip-message assistant dgc provisional" aria-label="Live reply preview"><span class="sr-only">${esc(type?.name||'Pip')}</span><p class="message-status">Live reply · not yet saved</p>${simple?`<div class="answer split">${replyParts(S.stream.text).map(part=>`<div class="message-body text reply-part">${markdown(part)}</div>`).join('')}</div>`:`<div class="message-body text">${markdown(S.stream.text)}</div>`}${S.stream.limited?'<p class="muted">Live preview is limited to 16,384 characters. The saved reply will replace it when complete.</p>':''}${S.stream.truncated?'<p class="muted">Earlier live text may no longer be retained.</p>':''}</article>`:''}${S.stream?.error?`<p class="muted">${esc(S.stream.error)}</p>`:''}${chatResultCards()}${chatSetupCards()}${emailDraftCards()}${S.omitted?`<p class="context-limit">${S.omitted} earlier saved ${S.omitted===1?'message is':'messages are'} outside the current model input. History remains saved.</p>`:''}</div>${simpleMode()?runnerOffMarkup():''}<form id="chat-form" class="pip-composer">${canAttachImages()?imageStripMarkup():''}<div class="composer-input"><label class="sr-only" for="chatText">Message ${esc(type?.name||'this Pip')}</label><textarea id="chatText" data-draft="chatText" rows="1" placeholder="${simpleMode()?`Ask ${esc(S.pip.name)}`:`Message ${esc(type?.name||'this Pip')}…`}" maxlength="4000"${archived()||!usable()?' disabled':''}>${esc(draft.chatText)}</textarea></div>${chatControlsMarkup(canSend,busy)}</form><p class="composer-hint">${archived()?'Archived · Restore to paused before sending another message. ':''}${personalPip()?'Personal · no project tools':(currentTree()?'Captured working-tree source':'Committed source only')+' · Read-only tools'}${!S.runner?.online?' · Start the runner to send a message.':S.runner?.paused?' · Resume the runner to send a message.':''}</p></section>`;
}
async function toggleChatActivity(runId){
  if(!S.messages.some(m=>m.run_id===runId)||!usable())return;
  const current=chatActivities.get(runId);if(current){current.open=!current.open;render();return;}
  const token=scope(),value={open:true,loading:true,events:[],error:'',hasMore:false,truncated:false};chatActivities.set(runId,value);render();
  try{const page=activityPage(await send('list_pip_run_activity',{run_id:runId,after:0}),{id:runId,pip_id:S.selected,workspace_id:S.workspace.id},0);if(token!==scope()||chatActivities.get(runId)!==value)return;value.events=page.events;value.hasMore=page.has_more;value.truncated=page.history_may_be_truncated;}
  catch(error){if(token===scope()&&chatActivities.get(runId)===value)value.error=errorText(error);}
  finally{if(token===scope()&&chatActivities.get(runId)===value){value.loading=false;render();}}
}
async function loadMessages(more=false){
 if(!more)void loadEmailDrafts();
  if(!S.selected||!usable()||(more&&(!S.messageCursor||S.messagesLoading||S.messages.length>=200)))return;
  const token=scope(),id=S.selected,sequence=++messageSeq,before=more?S.messageCursor:null;S.messagesLoading=true;
  if(!S.messagesLoaded)render();
  try{const page=messagesPage(await send('list_pip_messages',{pip_id:id,limit:20,...(before?{before_id:before}:{})}),id,S.workspace.id);if(token!==scope()||sequence!==messageSeq)return;if(S.apiVersion>=24){S.chatControls=null;S.chatControls=checkedChatControls(page.chat_controls);if(!chatPreferences.has(id))chatPreferences.set(id,{...S.chatControls.options});}
    if(more){if(page.next_before_id===before||page.messages.some(m=>S.messages.some(p=>p.id===m.id)))throw new Error('Conversation history did not advance. Refresh before retrying.');S.messages=[...page.messages,...S.messages].slice(-200);S.messageCursor=page.next_before_id;}
    else{const existing=new Map(S.messages.map((m,i)=>[m.id,i]));const next=[...S.messages];for(const m of page.messages){if(existing.has(m.id))next[existing.get(m.id)]=m;else next.push(m);}if(!S.messagesLoaded)S.messageCursor=page.next_before_id;S.messages=next.slice(-200);}
    S.messagesLoaded=true;S.messagesError='';S.chatActiveRun=page.active_run;S.omitted=page.history_context_omitted_count;S.continuity=chatContinuity(page.continuity,id,S.workspace.id);
    if(!page.active_run){streamSeq++;streamLoading=false;S.stream=null;}else if(!S.stream||S.stream.runId!==page.active_run.id){streamSeq++;streamLoading=false;S.stream={runId:page.active_run.id,cursor:0,text:'',limited:false,error:'',truncated:false};}
    if(page.active_run)void loadChatStream();
  }catch(error){if(token===scope()&&sequence===messageSeq)S.messagesError=errorText(error);}
  finally{if(token===scope()&&sequence===messageSeq){S.messagesLoading=false;render();}}
}
async function loadChatStream(){
  if(!S.stream||streamLoading||S.stream.limited||!usable())return;
  const token=scope(),runId=S.stream.runId,identity={id:runId,pip_id:S.selected,workspace_id:S.workspace.id},sequence=++streamSeq;streamLoading=true;
  try{for(let pageNumber=0;pageNumber<4;pageNumber++){
    const after=S.stream.cursor,page=activityPage(await send('list_pip_run_activity',{run_id:runId,after}),identity,after);
    if(token!==scope()||sequence!==streamSeq||S.stream?.runId!==runId)return;
    S.stream.cursor=page.next_cursor;S.stream.truncated ||= page.history_may_be_truncated;
    for(const event of page.events)if(event.event_type==='pip_run_progress'&&event.payload.kind==='text_delta'&&typeof event.payload.text==='string'){
      const available=16384-S.stream.text.length;S.stream.text+=event.payload.text.slice(0,available);if(event.payload.text.length>available)S.stream.limited=true;
    }
    S.stream.error='';if(!page.has_more||S.stream.limited)break;
  }}catch(error){if(token===scope()&&sequence===streamSeq&&S.stream)S.stream.error='Live preview is unavailable. The saved reply will appear when the run finishes.';}
  finally{if(token===scope()&&sequence===streamSeq){streamLoading=false;render();}}
}
// Images in a Pip's chat (API 43): up to four, 2 MB in all, the types the main chat takes. They are
// added with the image button, pasted or dropped, shown as previews, and sent with the message.
const PIP_IMAGE_TYPES=['image/png','image/jpeg','image/gif','image/webp','image/bmp'],PIP_MAX_IMAGES=4,PIP_MAX_IMAGE_BYTES=2*1024*1024;
const chatImages=new Map(),messageImageCache=new Map(),messageImageFlight=new Set();
function canAttachImages(){return S.apiVersion>=43&&!remoteHost&&personalPip();}
function pendingImages(){return chatImages.get(S.selected)||[];}
function imageStripMarkup(){
 const images=pendingImages();if(!images.length)return '';
 return `<div class="chat-images" aria-label="Images to send">${images.map((image,i)=>`<span class="chat-image-chip"><img src="${esc(image.data)}" alt="Image ${i+1} to send"><button type="button" data-remove-image="${i}" aria-label="Remove image ${i+1}" title="Remove">×</button></span>`).join('')}</div>`;
}
function addImageFiles(files){
 if(!canAttachImages()||!S.selected)return;
 const pip=S.selected,list=[...files].filter(f=>PIP_IMAGE_TYPES.includes(f.type));
 if(!list.length){if(files.length)setError('Add PNG, JPEG, GIF, WebP or BMP images.');return;}
 const current=pendingImages(),room=PIP_MAX_IMAGES-current.length,used=current.reduce((n,i)=>n+i.bytes,0);
 const take=list.slice(0,Math.max(0,room));let bytes=used;
 for(const file of take){bytes+=file.size;}
 if(list.length>room||bytes>PIP_MAX_IMAGE_BYTES){setError(`Send up to ${PIP_MAX_IMAGES} images, 2 MB in all.`);if(list.length>room&&room<=0)return;if(bytes>PIP_MAX_IMAGE_BYTES)return;}
 for(const file of take){const reader=new FileReader();reader.onload=()=>{if(typeof reader.result!=='string'||!reader.result.startsWith('data:image/'))return;const next=[...(chatImages.get(pip)||[]),{data:reader.result,bytes:file.size}].slice(0,PIP_MAX_IMAGES);chatImages.set(pip,next);if(S.selected===pip)render();};reader.readAsDataURL(file);}
}
function messageImageSrc(messageId,index){return messageImageCache.get(`${messageId}:${index}`)||'';}
// Thumbnails of images already sent load one at a time, when their message is on screen.
function hydrateMessageImages(){
 for(const node of document.querySelectorAll('img[data-message-image]')){
  const key=node.dataset.messageImage;if(messageImageCache.has(key)){if(!node.getAttribute('src'))node.src=messageImageCache.get(key);continue;}
  if(messageImageFlight.has(key)||S.apiVersion<43)continue;
  const [messageId,index]=key.split(':'),pip=S.selected;messageImageFlight.add(key);
  send('get_pip_message_image',{pip_id:pip,message_id:messageId,index:Number(index)}).then(result=>{
   if(!record(result)||result.message_id!==messageId||typeof result.image!=='string'||!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(result.image))return;
   messageImageCache.set(key,result.image);for(const img of document.querySelectorAll(`img[data-message-image="${key}"]`))img.src=result.image;
  }).catch(()=>{}).finally(()=>messageImageFlight.delete(key));
 }
}
async function sendChat(){
  if(S.apiVersion>=24&&!S.chatControls||archived()||!supportedSource()||!usable()||!S.messagesLoaded||S.busy||!S.pip||!pipType(S.pip,S.types)?.available||!S.runner?.online||S.runner?.paused||S.chatActiveRun)return;
  const text=draft.chatText.trim(),images=canAttachImages()?pendingImages().map(i=>i.data):[];if(!text&&!images.length){setError('Enter a message.');return;}if(text.length>4000||new TextEncoder().encode(text).length>8192){setError('Use at most 4000 characters and 8 KiB for one message. Nothing was shortened.');return;}
  const options=S.apiVersion>=24?chosenChatOptions():undefined,signature=JSON.stringify({text,...(options?{chat_options:options}:{}),...(images.length?{images:images.map(i=>i.length+':'+i.slice(-64))}:{})});const token=scope(),id=S.selected,generation=selectionGeneration,epoch=S.epoch;let pending=chatRequests.get(id);if(!pending||pending.signature!==signature){pending={text,signature,options,images,key:`pip-chat-${globalThis.crypto.randomUUID()}`};chatRequests.set(id,pending);}S.busy=true;S.error='';render();
  try{const result=await send('send_pip_message',{pip_id:id,text,idempotency_key:pending.key,...(pending.options?{chat_options:pending.options}:{}),...(pending.images?.length?{images:pending.images}:{})});if(epoch!==S.epoch)return;if(!record(result.message)||result.message.pip_id!==id||!record(result.run)||result.run.pip_id!==id)throw new Error('The saved message response did not match this Pip. Refresh before retrying.');if(chatRequests.get(id)?.key===pending.key)chatRequests.delete(id);if(chatDrafts.get(id)?.trim()===text)chatDrafts.delete(id);if(pending.images?.length)chatImages.delete(id);rememberView();if(token!==scope()||generation!==selectionGeneration)return;if(draft.chatText.trim()===text)draft.chatText='';await Promise.all([loadMessages(),refresh(false)]);}
  catch(error){if(token===scope()&&generation===selectionGeneration)setError(error);}
  finally{if(token===scope()&&generation===selectionGeneration){S.busy=false;render();$('chatText')?.focus();}}
}
function hydrateAdaptation(pip){const p=adaptationPolicy(pip.adaptation_policy);draft.adaptationMode=p.mode;draft.adaptationName=p.allowed_fields.includes('name');draft.adaptationSource=p.allowed_fields.includes('source_ref');S.adaptationDraftVersion=pip.current_version;}
// Notifications and finding outcomes (Pips API 41). The settings are the user's display
// preference, not the reviewed job, so they save directly; outcomes are read-only counts.
const auditPip=(pip=S.pip)=>!!pip&&!personalPip(pip)&&['scout','lens','rook','lock'].includes(pip.pip_type??'rook');
let notifyState={pip:'',value:null,loading:false,error:''},outcomeState={pip:'',value:null,loading:false,error:''};
async function loadNotify(){
 const pip=S.selected;if(S.apiVersion<41||!usable()||!pip||notifyState.loading&&notifyState.pip===pip)return;
 const token=scope();notifyState={pip,value:null,loading:true,error:''};
 try{const value=pipNotifySettings((await send('get_pip_notify_settings',{pip_id:pip})).settings,pip);if(token!==scope()||S.selected!==pip)return;notifyState.value=value;draft.notifyMin=value.min_severity;draft.notifyAlert=value.alert_severity||'off';}
 catch(error){if(token===scope()&&S.selected===pip)notifyState.error=errorText(error);}
 finally{if(token===scope()&&S.selected===pip){notifyState.loading=false;render();}}
}
async function loadFindingOutcomes(){
 const pip=S.selected;if(S.apiVersion<41||!usable()||!pip||outcomeState.loading&&outcomeState.pip===pip)return;
 const token=scope();outcomeState={pip,value:null,loading:true,error:''};
 try{const value=pipOutcomes((await send('get_pip_outcomes',{pip_id:pip})).outcomes,pip);if(token!==scope()||S.selected!==pip)return;outcomeState.value=value;}
 catch(error){if(token===scope()&&S.selected===pip)outcomeState.error=errorText(error);}
 finally{if(token===scope()&&S.selected===pip){outcomeState.loading=false;render();}}
}
// Reviewed GitHub reads (Pips API 41): one repository and up to four fixed read kinds, read by DGC
// with the user's own GitHub login before each review. Read-only; the model never picks a read.
const githubPip=(pip=S.pip)=>!!pip&&!personalPip(pip)&&['scout','lens','rook','lock','quill'].includes(pip.pip_type??'rook');
function githubPlanFromDraft(){
 const reads=[];
 if(draft.githubIssues){const labels=String(draft.githubLabels||'').split(',').map(v=>v.trim()).filter(Boolean);reads.push({kind:'open_issues',limit:20,...(labels.length?{labels}:{})});}
 if(draft.githubPulls)reads.push({kind:'open_pulls',limit:20});
 if(draft.githubChecks)reads.push({kind:'commit_checks'});
 if(draft.githubFailed)reads.push({kind:'failed_runs',limit:10});
 return githubReadPlan({schema_version:1,repository:String(draft.githubRepo||'').trim(),reads});
}
function githubReadsMarkup(){
 if(S.apiVersion<41||!githubPip())return '';
 const plan=S.pip.github_plan||null,key=`${S.selected}:${S.pip.current_version}`;
 if(draft.githubFor!==key){const has=kind=>plan?.reads.find(r=>r.kind===kind);Object.assign(draft,{githubFor:key,githubRepo:plan?.repository||'',githubIssues:!!has('open_issues'),githubLabels:(has('open_issues')?.labels||[]).join(', '),githubPulls:!!has('open_pulls'),githubChecks:!!has('commit_checks'),githubFailed:!!has('failed_runs')});}
 const off=S.busy||!usable()||archived(),check=(id,label)=>`<label class="check-field"><input type="checkbox" id="${id}" data-draft="${id}"${draft[id]?' checked':''}${off?' disabled':''}> ${label}</label>`;
 return `<form id="github-form" class="section form"><h2>GitHub reads</h2><p class="muted">Before each run, DGC reads these from GitHub with your own GitHub login (the gh CLI, or GH_TOKEN) and gives them to the model as reference. Read-only: nothing can comment, label, merge or push, and the model never chooses what to read.</p>${plan?`<p>${esc(plan.repository)}</p><ul class="web-reads">${plan.reads.map(r=>`<li>${esc(githubReadLabel(r))}</li>`).join('')}</ul>`:'<p class="muted">No GitHub reads approved.</p>'}<label for="githubRepo">Repository (owner/name)</label><input id="githubRepo" data-draft="githubRepo" value="${esc(draft.githubRepo)}" placeholder="owner/name" autocomplete="off"${off?' disabled':''}><fieldset><legend>Read before each run</legend>${check('githubIssues','Open issues')}<label for="githubLabels">Only issues with these labels (optional, comma-separated)</label><input id="githubLabels" data-draft="githubLabels" value="${esc(draft.githubLabels)}" autocomplete="off"${off?' disabled':''}>${check('githubPulls','Open pull requests')}${check('githubChecks','CI checks for the commit each run reviews')}${check('githubFailed','Recent failed workflow runs')}</fieldset><div class="actions"><button type="submit"${off?' disabled':''}>Review GitHub reads…</button>${plan?button('remove-github-reads','Remove GitHub reads…',off):''}</div></form>`;
}
function githubProposalMarkup(proposal){
 const current=S.pip?.github_plan||null,proposed=proposal.definition?.github_plan||null;
 if(!current&&!proposed)return '';
 const list=v=>v?`${esc(v.repository)}<ul class="web-reads">${v.reads.map(r=>`<li>${esc(githubReadLabel(r))}</li>`).join('')}</ul>`:'None';
 return `<h3>GitHub reads</h3><dl class="meta"><dt>Current</dt><dd>${list(current)}</dd><dt>Proposed</dt><dd>${list(proposed)}</dd></dl><p class="muted">Read-only, with your own GitHub login. DGC makes these reads before each run; the model never chooses what to read.</p>`;
}
// Usage and the daily limit (API 41): what this Pip's runs cost, and a limit on automatic runs.
let usageState={pip:'',value:null,loading:false,error:''};
async function loadUsage(){
 const pip=S.selected;if(S.apiVersion<41||!usable()||!pip||usageState.loading&&usageState.pip===pip)return;
 const token=scope();usageState={pip,value:null,loading:true,error:'',token};
 try{const value=pipUsage((await send('get_pip_usage',{pip_id:pip})).usage,pip);if(token!==scope()||S.selected!==pip)return;usageState.value=value;draft.usageLimit=value.daily_cap===null?'':String(value.daily_cap);}
 catch(error){if(token===scope()&&S.selected===pip)usageState.error=errorText(error);}
 finally{if(usageState.token===token){usageState.loading=false;if(token!==scope()||S.selected!==pip)usageState.pip='';render();}}
}
// Thumbs up or down on a finished result; the Pip's later runs read it (API 41).
const RATED_RUNS=['personal_task','audit','draft'];
let feedbackState={pip:'',value:null,loading:false,error:'',run:''};
async function loadFeedback(){
 const pip=S.selected;if(S.apiVersion<41||!usable()||!pip||feedbackState.loading&&feedbackState.pip===pip)return;
 const token=scope();feedbackState={pip,value:null,loading:true,error:'',run:'',token};
 try{const value=pipFeedback(await send('list_pip_feedback',{pip_id:pip}),pip);if(token!==scope()||S.selected!==pip)return;feedbackState.value=value;}
 catch(error){if(token===scope()&&S.selected===pip)feedbackState.error=errorText(error);}
 finally{if(feedbackState.token===token){feedbackState.loading=false;if(token!==scope()||S.selected!==pip)feedbackState.pip='';render();}}
}
function feedbackMarkup(run){
 if(S.apiVersion<41||!run||run.id!==S.runId||run.status!=='succeeded'||!RATED_RUNS.includes(run.manifest?.run_kind??'audit'))return '';
 if(feedbackState.pip!==S.selected){void loadFeedback();return '';}
 const f=feedbackState.value;
 if(!f)return feedbackState.error?`<section class="section feedback" aria-label="Your rating">${errorMarkup(feedbackState.error)}</section>`:'';
 const mine=f.feedback.find(r=>r.run_id===run.id),off=S.busy||!usable();
 if(feedbackState.run!==run.id){feedbackState.run=run.id;draft.feedbackNote=mine?.note||'';}
 const thumb=(rating,label,glyph)=>`<button type="button" id="rate-${rating}" class="thumb${mine?.rating===rating?' is-on':''}" aria-pressed="${mine?.rating===rating}"${off?' disabled':''}><span aria-hidden="true">${glyph}</span> ${label}</button>`;
 return `<section class="section feedback" aria-label="Your rating"><h3>Was this result useful?</h3><div class="actions">${thumb('up','Useful','👍')}${thumb('down','Not useful','👎')}${mine?button('rate-clear','Clear rating',off):''}</div><label for="feedbackNote">What should it keep doing, or do differently? <span class="muted">Optional</span></label><textarea id="feedbackNote" data-draft="feedbackNote" maxlength="500" rows="2"${off?' disabled':''}>${esc(draft.feedbackNote)}</textarea><p class="muted">Its next runs read your rating and note. The job itself does not change.</p>${errorMarkup(feedbackState.error)}</section>`;
}
function saveFeedback(rating){
 const run=S.run,pip=S.selected;if(S.apiVersion<41||!run||run.id!==S.runId||!feedbackState.value||feedbackState.pip!==pip)return;
 const note=rating===null?'':String(draft.feedbackNote||'').trim();
 if(note.length>500){feedbackState.error='Keep the note to 500 characters.';render();return;}
 feedbackState.error='';
 void mutate({type:'set_pip_feedback',run_id:run.id,rating,note},result=>{const value=pipFeedback(result,pip);const mine=value.feedback.find(r=>r.run_id===run.id);
  if(rating===null?mine:mine?.rating!==rating)throw Error('The saved rating differs from your choice. Refresh this Pip.');
  feedbackState.value=value;draft.feedbackNote=mine?.note??'';
  S.notice=rating===null?'Rating cleared.':`Saved. Its next runs will read your ${rating==='up'?'thumbs up':'thumbs down'}${note?' and note':''}.`;});
}
// Allowed without asking (API 41): a Personal Pip's Always-allow grants, each with Stop allowing.
let grantsState={pip:'',value:null,loading:false,error:'',token:''};
async function loadGrants(){
 const pip=S.selected;if(S.apiVersion<41||!usable()||!pip||grantsState.loading&&grantsState.pip===pip)return;
 const token=scope();grantsState={pip,value:null,loading:true,error:'',token};
 try{const value=actionGrants(await send('list_pip_action_grants',{pip_id:pip}),pip);if(token!==scope()||S.selected!==pip)return;grantsState.value=value;}
 catch(error){if(token===scope()&&S.selected===pip)grantsState.error=errorText(error);}
 finally{if(grantsState.token===token){grantsState.loading=false;if(token!==scope()||S.selected!==pip)grantsState.pip='';render();}}
}
function grantsMarkup(){
 if(S.apiVersion<41||!S.pip||S.pip.source_policy?.mode!=='personal')return '';
 if(grantsState.pip!==S.selected){void loadGrants();return '';}
 const g=grantsState.value;
 if(!g)return grantsState.error?`<section class="section" aria-label="Allowed without asking"><h2>Allowed without asking</h2>${errorMarkup(grantsState.error)}</section>`:'';
 const off=S.busy||!usable();
 return `<section class="section" aria-label="Allowed without asking"><h2>Allowed without asking</h2>${g.grants.length
   ?`<p class="muted">When this Pip drafts one of these, it runs after the run and you are told after. Anything else waits for you.</p>${g.grants.map(x=>`<div class="grant-row"><span>${esc(x.label)} <span class="muted">· ${x.account==='connection_managed'?'the account its connection uses':'account '+esc(x.account)}</span></span><button type="button" data-revoke-grant="${esc(x.id)}"${off?' disabled':''}>Stop allowing</button></div>`).join('')}`
   :'<p class="muted">Nothing. Every email, event or app action this Pip drafts waits for you. Choose <b>Always allow</b> when you approve one to let it do that kind of action on its own.</p>'}</section>`;
}
function revokeGrant(grantId){
 const pip=S.selected;if(S.apiVersion<41||!grantsState.value||grantsState.pip!==pip)return;
 const label=grantsState.value.grants.find(x=>x.id===grantId)?.label||'that action';
 void mutate({type:'revoke_pip_action_grant',pip_id:pip,grant_id:grantId},result=>{grantsState.value=actionGrants(result,pip);S.notice=`This Pip will ask you again before: ${label}.`;});
}
// "200k", "1.5m", "250,000" or empty (no limit). Null for empty; undefined when it is not a number.
function parseTokens(text){
 const raw=String(text||'').trim().toLowerCase().replace(/[,_\s]/g,'');
 if(!raw)return null;
 const m=/^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);if(!m)return undefined;
 return Math.round(Number(m[1])*(m[2]==='k'?1000:m[2]==='m'?1000000:1));
}
function usageChart(u){
 const days=[],[y,mo,d]=u.today.day.split('-').map(Number),byDay=new Map(u.days.map(e=>[e.day,e.tokens]));
 for(let i=13;i>=0;i--){const t=new Date(Date.UTC(y,mo-1,d-i));days.push({day:t.toISOString().slice(0,10),tokens:byDay.get(t.toISOString().slice(0,10))||0});}
 // Scaled to the days themselves: a limit far above them would flatten every bar, so its line is
 // drawn only when it is near enough to read (the form above says the limit in words).
 const busiest=Math.max(1,...days.map(e=>e.tokens)),cap=u.daily_cap&&u.daily_cap<=busiest*1.5?u.daily_cap:0;
 const max=Math.max(busiest,cap),w=14,gap=4,h=40;
 const bars=days.map((e,i)=>{const bh=e.tokens?Math.max(2,Math.round(e.tokens/max*h)):1;return `<rect x="${i*(w+gap)}" y="${h-bh}" width="${w}" height="${bh}" rx="2" class="${e.tokens?'usage-bar':'usage-bar empty'}"><title>${e.day}: ${e.tokens.toLocaleString('en-US')} tokens</title></rect>`;}).join('');
 const capLine=cap?`<line x1="0" x2="${14*(w+gap)-gap}" y1="${h-Math.round(cap/max*h)}" y2="${h-Math.round(cap/max*h)}" class="usage-cap"/>`:'';
 return `<svg class="usage-chart" viewBox="0 0 ${14*(w+gap)-gap} ${h}" preserveAspectRatio="none" role="img" aria-label="Tokens per day for the last 14 days">${bars}${capLine}</svg>`;
}
function usageMarkup(){
 if(S.apiVersion<41||!S.pip)return '';
 if(usageState.pip!==S.selected){void loadUsage();return '<section class="section"><h2>Usage</h2><p class="muted">Loading…</p></section>';}
 const u=usageState.value,off=S.busy||!usable()||!u;
 if(!u)return `<section class="section"><h2>Usage</h2>${errorMarkup(usageState.error)||'<p class="muted">Loading…</p>'}</section>`;
 const n=v=>v.toLocaleString('en-US'),runs=v=>`${v} run${v===1?'':'s'}`;
 return `<form id="usage-form" class="section form"><h2>Usage</h2><dl class="meta usage-counts"><dt>Today</dt><dd>${n(u.today.tokens)} tokens · ${runs(u.today.runs)}</dd><dt>Last 30 days</dt><dd>${n(u.last_30_days.tokens)} tokens · ${runs(u.last_30_days.runs)}</dd></dl>${usageChart(u)}${u.capped_today?'<p class="notice">It reached its daily limit: its schedules and triggers are skipped for the rest of the day. Runs you start still run.</p>':''}${errorMarkup(usageState.error)}<label for="usageLimit">Daily token limit for its scheduled runs</label><input id="usageLimit" data-draft="usageLimit" inputmode="numeric" autocomplete="off" placeholder="No limit (for example 200k)" value="${esc(draft.usageLimit||'')}"${off?' disabled':''}><p class="muted">After that, its scheduled runs wait until tomorrow. Runs you start still run.</p><div class="actions"><button type="submit" class="primary"${off?' disabled':''}>Save limit</button>${u.daily_cap!==null?button('remove-usage-limit','Remove limit',off,'quiet'):''}</div></form>`;
}
function saveUsageLimit(limit){
 const u=usageState.value,pip=S.selected;if(S.apiVersion<41||!u||u.pip_id!==pip)return;
 if(limit===undefined||limit!==null&&(limit<1000||limit>1000000000)){usageState.error='Give a daily limit from 1,000 to 1,000,000,000 tokens, for example 200k, or leave it empty for no limit.';render();return;}
 usageState.error='';
 void mutate({type:'set_pip_daily_cap',pip_id:pip,daily_tokens:limit},result=>{const value=pipUsage(result.usage,pip);if(value.daily_cap!==limit)throw Error('The saved limit differs from your choice. Refresh this Pip.');usageState.value=value;draft.usageLimit=limit===null?'':String(limit);S.notice=limit===null?'Daily limit removed.':`Daily limit saved: ${limit.toLocaleString('en-US')} tokens for automatic runs. The job itself did not change.`;});
}
document.addEventListener('submit',event=>{if(event.target.id!=='usage-form')return;event.preventDefault();if(S.busy||!usable())return;saveUsageLimit(parseTokens(draft.usageLimit));});
function notifyMarkup(){
 if(S.apiVersion<41||!auditPip())return '';
 if(notifyState.pip!==S.selected){void loadNotify();return '<section class="section"><h2>Notifications</h2><p class="muted">Loading…</p></section>';}
 const n=notifyState.value,off=S.busy||!usable()||!n;
 const option=(value,label,chosen)=>`<option value="${value}"${chosen===value?' selected':''}>${label}</option>`;
 return `<form id="notify-form" class="section form"><h2>Notifications</h2><p class="muted">New findings reach you in one daily digest in the main chat, not a message per run. Findings below the threshold stay in this Pip's reports.</p>${errorMarkup(notifyState.error)}<label for="notifyMin">Show new findings that are</label><select id="notifyMin" data-draft="notifyMin"${off?' disabled':''}>${SEVERITIES.map(l=>option(l,l+' or worse',draft.notifyMin)).join('')}</select><label for="notifyAlert">Bring the digest back straight away for</label><select id="notifyAlert" data-draft="notifyAlert"${off?' disabled':''}>${SEVERITIES.map(l=>option(l,l+' or worse',draft.notifyAlert)).join('')}${option('off','Nothing: wait for the next day',draft.notifyAlert)}</select><div class="actions"><button type="submit"${off?' disabled':''}>Save notifications</button></div></form>${findingOutcomesMarkup()}`;
}
function findingOutcomesMarkup(){
 if(S.apiVersion<41||!auditPip())return '';
 if(outcomeState.pip!==S.selected){void loadFindingOutcomes();return '';}
 const o=outcomeState.value;
 const body=o?(o.reported?`<dl class="meta outcome-counts"><dt>Reported</dt><dd>${o.reported}</dd><dt>Accepted</dt><dd>${o.accepted}</dd><dt>Dismissed</dt><dd>${o.dismissed}</dd><dt>Still reported</dt><dd>${o.still_reported}</dd><dt>Gone after their file changed</dt><dd>${o.gone_after_change}</dd><dt>Gone without a change</dt><dd>${o.gone_without_change}</dd></dl><p class="muted">“Gone” means a later run stopped reporting it after a source change. It suggests a fix; it does not prove one.${o.history_truncated?' Counted from the latest 200 reports.':''}</p>`:'<p class="muted">No findings reported yet.</p>'):outcomeState.loading?'<p class="muted">Loading…</p>':'';
 return `<section class="section" aria-label="Finding outcomes"><div class="section-head"><h2>What became of its findings</h2>${button('refresh-findings',outcomeState.loading?'Loading…':'Refresh',!usable()||outcomeState.loading)}</div>${errorMarkup(outcomeState.error)}${body}</section>`;
}
function adaptationMarkup(){
 if(S.apiVersion<10)return '';
 const m=draft.adaptationMode,words={locked:'It never changes its own setup.',context_adaptive:'It uses your shared context, but never changes its own setup.',suggest_changes:'It may suggest changes to its setup. Each one waits for you.',bounded_adaptive:'It may change only what you tick below, and you can see every change.',autonomous:'It may rename itself and move to a newer commit. Nothing else.'}[m]||'';
 return `<form id="adaptation-form" class="section form"><h2>Changes it may make to itself</h2><label for="adaptationMode" class="sr-only">Changes it may make to itself</label><select id="adaptationMode" data-draft="adaptationMode">${Object.entries(ADAPTATION_MODES).map(([key,label])=>`<option value="${key}"${m===key?' selected':''}>${label}</option>`).join('')}</select><p class="muted">${words} It can never change what it does, when it runs, its model or what it may use.</p>${m==='bounded_adaptive'?`<fieldset><legend>It may change</legend><label class="check-field"><input id="adaptationName" data-draft="adaptationName" type="checkbox"${draft.adaptationName?' checked':''}> Its name</label><label class="check-field"><input id="adaptationSource" data-draft="adaptationSource" type="checkbox"${draft.adaptationSource?' checked':''}> The commit it reads</label></fieldset>`:''}${S.adaptationDraftVersion!==S.pip.current_version?'<p class="notice">The Pip changed since you opened this. Reset it and choose again.</p>':''}<div class="actions"><button type="submit" class="primary"${S.busy||!usable()||!S.adaptationDirty?' disabled':''}>Save</button>${S.adaptationDirty?button('reset-adaptation','Reset',S.busy||!usable(),'quiet'):''}</div></form>${adaptationHistoryMarkup()}`;
}
function adaptationHistoryMarkup(){const capped=S.adaptations.length>=200;return `<section class="section" aria-label="Adaptation history"><div class="section-head"><h2>Automatic changes</h2>${button('load-adaptations',S.adaptationsLoading?'Loading…':S.adaptationsLoaded?'Refresh changes':'Load changes',!usable()||S.adaptationsLoading)}</div><p class="muted">These metadata updates used a previously reviewed policy. They are distinct from pending proposals and did not start runs.</p>${errorMarkup(S.adaptationsError)}${S.adaptations.map(a=>`<article class="entry"><h3>Job v${a.from_version} → v${a.to_version}</h3><p class="muted">${esc(date(a.created_at))} · policy v${a.policy_version}</p><p>${esc(adaptationLabel(a.policy))}</p><dl class="meta">${Object.entries(a.changes).map(([key,value])=>`<dt>${key==='name'?'Name':'Source ref'}</dt><dd>${esc(value)}</dd>`).join('')}</dl><p class="goal">${esc(a.reason)}</p><details><summary>Reviewed policy reference</summary><p class="mono">${esc(a.policy_approval_id)}</p></details></article>`).join('')||(S.adaptationsLoaded?'<p class="muted">No automatic metadata changes are recorded for this Pip.</p>':'')}${S.adaptationCursor&&!capped?button('more-adaptations','Older automatic changes',!usable()||S.adaptationsLoading):''}${capped?'<p class="muted">Showing 200 automatic changes. Use the local CLI for older records.</p>':''}</section>`;}
async function loadAdaptations(more=false){
 if(S.apiVersion<10||!usable()||!S.pip||S.adaptationsLoading||more&&(!S.adaptationCursor||S.adaptations.length>=200))return;
 const token=scope(),sequence=++adaptationSeq,before=more?S.adaptationCursor:null;S.adaptationsLoading=true;S.adaptationsError='';render();
 try{const page=adaptationsPage(await send('list_pip_adaptations',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||sequence!==adaptationSeq)return;if(more&&(page.next_before_id===before||page.adaptations.some(a=>S.adaptations.some(old=>old.id===a.id)||a.to_version>=S.adaptations.at(-1).to_version)))throw new Error('Adaptation history did not advance. Refresh before retrying.');S.adaptations=more?[...S.adaptations,...page.adaptations]:page.adaptations;S.adaptationCursor=page.next_before_id;S.adaptationsLoaded=true;}
 catch(error){if(token===scope()&&sequence===adaptationSeq)S.adaptationsError=errorText(error);}
 finally{if(token===scope()&&sequence===adaptationSeq){S.adaptationsLoading=false;render();}}
}
function personalPip(pip=S.pip){return pip?.source_policy?.mode==='personal';}
function currentTree(pip=S.pip){try{return sourcePolicy(pip?.source_policy).mode==='current_tree';}catch{return false;}}
function supportedSource(pip=S.pip){try{const p=sourcePolicy(pip?.source_policy);return p.mode!=='current_tree'||S.apiVersion>=11&&['scout','lens','rook','lock','quill'].includes(pip?.pip_type??'rook')&&!pip.schedule&&!pip.event_trigger;}catch{return false;}}
function jobSourceLabel(pip){if(personalPip(pip))return 'Personal · no project access.';try{return sourcePolicy(pip.source_policy).mode==='current_tree'?'Current working tree, captured for each manual request. Stored ref '+pip.source_ref+' is dormant.':'Committed source at '+pip.source_ref+'.';}catch{return 'Unsupported source policy. Update the computer before starting work.';}}
function pinnedSourceMarkup(value){
 try{const p=sourcePin(value);if(p.kind==='personal')return '<dt>Scope</dt><dd>Personal · no project access</dd>';return p.kind==='committed_only'?`<dt>Source commit</dt><dd class="mono">${esc(p.revision)}</dd>`:`<dt>Source</dt><dd>Current working-tree snapshot</dd><dt>Snapshot SHA-256</dt><dd class="mono">${esc(p.snapshot.sha256)}</dd><dt>Included source</dt><dd>${p.snapshot.files.toLocaleString()} files · ${p.snapshot.bytes.toLocaleString()} bytes</dd><dt>Excluded entries</dt><dd>${p.snapshot.excluded_entries.toLocaleString()} · ${p.snapshot.excluded_directories.toLocaleString()} directories</dd><dt>Capture consistency</dt><dd>Checked, non-atomic</dd><dt>Exclusion policy</dt><dd>safe_source_v1</dd>`;}catch{return '<dt>Source identity</dt><dd>Unavailable or invalid</dd>';}
}
function pinnedSourceNotice(value){try{return sourcePin(value).kind==='current_tree'?'<p class="notice">Historical working-tree capture, not a Git commit or an atomic filesystem snapshot. Safe-source exclusions were applied. This receipt does not describe the current files.</p>':'';}catch{return errorMarkup('The pinned source identity could not be validated.');}}
function committedJob(pip){try{return sourcePolicy(pip?.source_policy).mode==='committed_only';}catch{return false;}}
function samePinnedSource(a,b){const x=sourcePin(a),y=sourcePin(b);return x.kind===y.kind&&x.revision===y.revision&&(x.snapshot===null?y.snapshot===null:Object.keys(x.snapshot).every(k=>x.snapshot[k]===y.snapshot?.[k]));}
function checkedRunSource(run){draftAutomationPin(run.manifest);if(Object.hasOwn(run.manifest||{},'source_policy')||Object.hasOwn(run.manifest||{},'source_snapshot')){if(run.status==='succeeded')sourceResult(run.manifest,run.result);else sourcePin(run.manifest);}}
function handoffSourceAllowed(value){try{return sourcePin(value).kind==='committed_only';}catch{return false;}}
function hydrateSource(pip){try{draft.sourceMode=sourcePolicy(pip.source_policy).mode;}catch{draft.sourceMode='unsupported';}S.sourceDraftVersion=pip.current_version;}
// Reviewed web reads: DGC reads exactly these pages and searches before each run (Pips API 40).
function webReadsLines(plan){return (plan?.reads||[]).map(r=>r.kind==='page'?r.url:'search: '+r.query).join('\n');}
function webReadsFromText(text){
 const reads=String(text||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>/^search:/i.test(line)?{kind:'search',query:line.slice(7).trim()}:{kind:'page',url:line});
 if(!reads.length)throw new Error('Add at least one https page or search, or remove web reads instead.');
 if(reads.length>4)throw new Error('A Pip can have up to four web reads.');
 return webReadPlan({schema_version:1,reads});
}
function webReadsMarkup(){
 let plan=S.pip.web_plan;const old=S.apiVersion<40;
 if(plan)try{webReadPlan(plan);}catch{return '<h3>Web pages</h3><p class="notice">This editor cannot show these pages. Refresh, or update DGC.</p>';}
 return `<h3>Web pages</h3>${plan?`<ul class="web-reads">${plan.reads.map(r=>`<li>${esc(webReadLabel(r))}</li>`).join('')}</ul>`:'<p class="muted">None yet.</p>'}${old?'<p class="muted">Update the DGC CLI to Pips API 40 to review web reads.</p>':`<form id="web-reads-form" class="form"><label for="webReads"><span>Pages it reads before each run: up to four, one per line. A web address, or <code>search:</code> and what to look up.</span></label><textarea id="webReads" data-draft="webReads" rows="4" placeholder="https://example.com/status&#10;search: weather in Pune today"${S.busy||!usable()||remoteHost?' disabled':''}>${esc(draft.webReads||webReadsLines(plan))}</textarea><p class="muted">${S.pip?.computer_plan?'Its computer can open other pages too; anything it would submit waits for you.':'It reads only these. It cannot open other pages, sign in or fill in forms.'}</p><div class="actions"><button type="submit"${S.busy||!usable()||remoteHost?' disabled':''}>Save pages…</button>${plan?button('remove-web-reads','Remove all…',S.busy||!usable(),'quiet'):''}</div></form>`}`;
}
// Pip computers (Pips API 42): a Personal Pip's own browser and files. One switch gives it; the
// user can open the browser and drive it (to sign in); what the Pip would submit waits for Send once.
let computerState={pip:'',value:null,loading:false,error:''},computerViewTimer=null;
async function loadComputer(){
 const pip=S.selected;if(S.apiVersion<42||!usable()||!pip||computerState.loading&&computerState.pip===pip)return;
 const token=scope();computerState={pip,value:null,loading:true,error:''};
 try{const value=pipComputer((await send('get_pip_computer',{pip_id:pip})).computer,pip);if(token!==scope()||S.selected!==pip)return;computerState.value=value;}
 catch(error){if(token===scope()&&S.selected===pip)computerState.error=errorText(error);}
 finally{if(token===scope()&&S.selected===pip){computerState.loading=false;render();}}
}
function computerMarkup(){const inner=computerInner();return inner&&`<div class="computer">${inner}</div>`;}
function computerInner(){
 if(S.apiVersion<42||!personalPip()||remoteHost)return '';
 if(computerState.pip!==S.selected){void loadComputer();return '<h3>Computer</h3><p class="muted">Loading…</p>';}
 const c=computerState.value,off=S.busy||!usable()||archived();
 if(!c)return `<h3>Computer</h3>${errorMarkup(computerState.error)||'<p class="muted">Loading…</p>'}`;
 if(!c.granted)return `<h3>Computer</h3><p class="muted">Give this Pip its own browser and files, separate from yours, so it can look things up and fill in forms for you.</p>${c.available?button('give-computer','Give this Pip a computer…',off):`<p class="muted">${esc(c.reason)}</p>`}`;
 const waiting=c.actions.filter(a=>a.status==='pending');
 return `<h3>Computer</h3><p>This Pip has its own browser and files. It reads websites freely; anything it would submit waits for you here.</p>${c.available?'':`<p class="notice">${esc(c.reason)}</p>`}<div class="actions">${button('open-computer','Open browser',off||!c.available)}${button('stop-computer','Stop computer',off)}${button('remove-computer','Remove computer…',off)}</div>${waiting.length?`<h4>Waiting for you</h4>${waiting.map(a=>`<article class="computer-action"><div><strong>${esc(a.summary.method)} ${esc(a.summary.host)}${esc(a.summary.path)}</strong><span class="muted">from ${esc(a.summary.page)}</span></div>${`<button type="button" data-computer-action="${esc(a.id)}"${off?' disabled':''}>Review…</button>`}</article>`).join('')}`:''}`;
}
function grantComputer(give){
 const name=S.pip?.name||'this Pip';
 openReview({computerGrant:give,title:give?`Give ${name} a computer?`:`Remove ${name}'s computer?`,
  description:give?'The Pip gets its own browser and files, separate from yours.':'The Pip will no longer browse. Its saved sign-ins stay on this computer until you remove them.',
  body:give?'<ul class="computer-rules"><li>It can read public websites.</li><li>Anything that would submit or change something waits for your approval, with a screenshot.</li><li>It never sees your passwords. You sign in yourself with Open browser.</li><li>It cannot reach your home network. A payment waits for your approval like anything else.</li><li>It cannot also read your connected apps.</li></ul>':'',
  confirm:give?'Give computer':'Remove computer',request:{type:'propose_pip_update'}});
}
async function applyComputerGrant(review){
 if(S.busy||!usable())return;const pip=S.pip,token=scope();S.busy=true;renderReview();
 try{
  const proposal=(await send('propose_pip_update',{pip_id:pip.id,expected_version:pip.current_version,changes:{computer_plan:review.computerGrant?{schema_version:1}:null},reason:review.computerGrant?'Give this Pip a computer.':'Remove this Pip\'s computer.'})).proposal;
  if(token!==scope())return;
  if(!record(proposal)||proposal.pip_id!==pip.id||JSON.stringify(proposal.definition?.computer_plan??null)!==JSON.stringify(review.computerGrant?{schema_version:1}:null))throw Error('The saved change differs from your choice. Refresh and try again.');
  await send('accept_pip_update',{pip_id:pip.id,proposal_id:proposal.id,expected_version:pip.current_version});
  if(token!==scope())return;closeReview();computerState.pip='';S.notice=review.computerGrant?`${pip.name} has a computer. Use Open browser to sign in to the sites it needs.`:`${pip.name}'s computer was removed.`;await refresh(true);
 }catch(error){if(token===scope()&&S.review===review)review.error=errorText(error);}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
async function openComputerAction(id){
 const c=computerState.value,a=c?.actions.find(x=>x.id===id);if(!a||!usable())return;
 let image='';
 if(a.frame&&a.run_id){try{image=pipComputerFrame(await send('get_pip_computer_frame',{run_id:a.run_id,frame:a.frame}),a.run_id,a.frame).image;}catch{image='';}}
 const s=a.summary,rows=s.fields.map(f=>`<dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd>`).join('');
 openReview({title:'Send this once?',description:`${S.pip?.name||'The Pip'} wants to ${s.method==='POST'?'submit':s.method.toLowerCase()} to ${s.host}. Nothing has been sent.`,
  body:`${image?`<img class="computer-shot" alt="The page as the Pip left it" src="${image}">`:''}<dl class="meta"><dt>Sends to</dt><dd>${esc(s.method)} ${esc(s.host)}${esc(s.path)}</dd><dt>From page</dt><dd>${esc(s.page)}</dd>${rows}</dl>${s.more_fields?`<p class="muted">And ${s.more_fields} more fields.</p>`:''}${s.payment===true?'<p class="notice">This sends payment card details.</p>':''}<p class="muted">Sent exactly as shown, once. Values marked ••• are hidden here but will be sent.</p>`,secondary:{id:'reject-computer-action',label:'Reject'},
  confirm:'Send once',always:true,expiresAt:a.expires_at,computerAction:a.id,request:{type:'decide_pip_computer_action',action_id:a.id,expected_digest:a.digest,approve:true}});
}
async function decideComputerAction(review,approve){
 if(S.busy||!usable())return;const token=scope();S.busy=true;renderReview();
 try{
  const q=review.request,a=pipComputerAction((await send('decide_pip_computer_action',{action_id:q.action_id,expected_digest:q.expected_digest,approve})).action,S.selected);
  if(token!==scope())return;if(a.id!==q.action_id||a.status!==(approve?'approved':'rejected'))throw Error('The saved decision differs from your choice. Refresh to see it.');
  closeReview();S.notice=approve?'Approved. It is sent within a few seconds, exactly as shown, and the Pip carries on.':'Rejected. Nothing was sent.';computerState.pip='';render();
 }catch(error){if(token===scope()&&S.review===review){review.error=errorText(error);}}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
async function computerCommand(type,notice){
 if(S.busy||!usable())return;const pip=S.selected,token=scope();S.busy=true;render();
 try{await send(type,{pip_id:pip});if(token!==scope())return;S.notice=notice;computerState.pip='';}
 catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();}}
}
function openComputerView(){
 if(!usable()||computerViewTimer)return;
 openReview({computerView:true,readOnly:true,title:`${S.pip?.name||'Pip'}'s browser`,description:'You are driving. What you submit here is sent; the Pip\'s own submits still wait for you.',
  body:`<form id="computer-go" class="computer-bar"><input id="computer-url" aria-label="Address" placeholder="https://" autocomplete="off"><button type="submit">Go</button>${button('computer-back','Back',false)}</form><div class="computer-screen"><img id="computer-screen" alt="The Pip's browser. Select a point to click there."></div><p id="computer-status" class="muted" role="status">Opening the browser…</p><form id="computer-type" class="computer-bar"><input id="computer-text" aria-label="Type into the page" autocomplete="off" placeholder="Select a field, then type here"><button type="submit">Type</button>${button('computer-enter','Enter',false)}${button('computer-tab','Next field',false)}${button('computer-backspace','Delete',false)}${button('computer-scroll-down','Scroll down',false)}${button('computer-scroll-up','Scroll up',false)}</form>`,
  request:{type:'use_pip_computer_view'}});
 void computerView('frame',{},true);
 computerViewTimer=setInterval(()=>{if(!S.review?.computerView){clearInterval(computerViewTimer);computerViewTimer=null;return;}if(!document.hidden)void computerView('frame',{});},1200);
}
let computerViewBusy=false;
async function computerView(op,fields,opening=false){
 const pip=S.selected;if(computerViewBusy&&op==='frame')return;computerViewBusy=true;
 try{
  if(opening)await send('open_pip_computer',{pip_id:pip});
  const reply=pipComputerView((await send('use_pip_computer_view',{pip_id:pip,op,...fields})).view);
  if(!S.review?.computerView||S.selected!==pip)return;
  const img=$('computer-screen'),status=$('computer-status');
  if(reply.ok){img.src=reply.image;img.dataset.width=String(reply.width);img.dataset.height=String(reply.height);status.textContent=reply.watching?'The Pip is using its browser right now. You can watch.':reply.url;}
  else status.textContent=reply.error;
 }catch(error){const status=$('computer-status');if(status)status.textContent=errorText(error);}
 finally{computerViewBusy=false;}
}
// A run's timeline: the screenshots its computer kept, one at a time.
let computerTimeline=null;
function computerUsedMarkup(run){
 const c=run.result?.computer;if(S.apiVersion<42||remoteHost||!record(c)||!Number.isSafeInteger(c.calls)||!Array.isArray(c.held))return '';
 return `<p class="muted">Used its computer: ${c.calls} ${c.calls===1?'step':'steps'}${c.held.length?` · ${c.held.length} waiting for your approval in the Job tab`:''}.</p>${c.calls?`<div class="actions">${button('computer-timeline','What it saw…',S.busy)}</div>`:''}`;
}
async function openComputerTimeline(){
 const run=S.run;if(!run||!usable())return;const token=scope();computerTimeline=null;
 openReview({computerTimeline:true,readOnly:true,title:'What it saw',description:'Screenshots from this run, oldest first. What they show came from websites.',
  body:`<p id="computer-timeline-status" class="muted" role="status">Loading…</p><img id="computer-timeline-img" class="computer-shot computer-timeline-shot" alt=""><p id="computer-timeline-label" class="muted"></p><div class="actions">${button('computer-prev','Previous',true)}${button('computer-next','Next',true)}</div>`,
  request:{type:'list_pip_computer_frames'}});
 try{
  const v=pipComputerFrames(await send('list_pip_computer_frames',{run_id:run.id}),run.id);
  if(token!==scope()||!S.review?.computerTimeline)return;
  computerTimeline={run:run.id,frames:v.frames,index:0};
  if(!v.frames.length){$('computer-timeline-status').textContent='No screenshots were kept for this run.';return;}
  void showTimelineFrame(0);
 }catch(error){const status=$('computer-timeline-status');if(status)status.textContent=errorText(error);}
}
async function showTimelineFrame(i){
 const t=computerTimeline,f=t?.frames[i];if(!f||!S.review?.computerTimeline)return;t.index=i;
 $('computer-timeline-status').textContent=`${i+1} of ${t.frames.length}`;$('computer-timeline-label').textContent=f.url?`${f.label} · ${f.url}`:f.label;
 $('computer-prev').disabled=i===0;$('computer-next').disabled=i===t.frames.length-1;
 try{const v=pipComputerFrame(await send('get_pip_computer_frame',{run_id:t.run,frame:f.frame}),t.run,f.frame);if(computerTimeline===t&&t.index===i&&S.review?.computerTimeline){const img=$('computer-timeline-img');img.src=v.image;img.alt=`Screenshot ${i+1}: ${f.label}`;}}
 catch(error){if(computerTimeline===t)$('computer-timeline-status').textContent=errorText(error);}
}
function sourceSettingsMarkup(){
  if(!personalPip())return '';
  const off=S.busy||!usable();
  return `<section class="section"><h2>What it can use</h2>${computerMarkup()}${webReadsMarkup()}<h3>Connected apps</h3>${S.pip.app_plan?`<p>Reads from your ${esc(S.pip.app_plan.server)} account before each run (${S.pip.app_plan.calls?.length||0} ${S.pip.app_plan.calls?.length===1?'read':'reads'}).</p>`:'<p class="muted">None yet. Connect an app once in DGC Settings, then choose it here.</p>'}<div class="actions">${button('choose-app-access',S.pip.app_plan?'Change…':'Choose an account…',off||S.apiVersion<29||remoteHost)}${button('setup-apps','Set up in chat',off,'quiet')}${S.pip.app_plan?button('remove-app-access','Remove…',off,'quiet'):''}</div>${canReviewMessages()||!remoteHost&&S.apiVersion>=32?`<p class="drafts-links"><span class="muted">What it prepared:</span>${canReviewMessages()?button('message-reviews','Actions',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=32?button('email-drafts','Emails',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=35?button('calendar-drafts','Calendar events',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=37?button('connector-drafts','App actions',S.busy,'link'):''}</p>`:''}</section>`;
}
function projectSourceMarkup(){
 const p=S.pip;if(S.apiVersion<11)return '<section class="section"><h2>Source policy</h2><p class="muted">'+esc(sourcePolicyLabel(p.source_policy))+'. Update the computer to Pips API 11 to review a different source policy.</p></section>';
 if(!['scout','lens','rook','lock','quill'].includes(p.pip_type??'rook'))return '<section class="section"><h2>Committed source only</h2><p class="muted">Patch and Pulse require pinned committed source and explicit reviewed command permissions.</p></section>';
 return `<form id="source-form" class="section form"><h2>Source policy</h2><p class="muted">Current: ${esc(sourcePolicyLabel(p.source_policy))}. Running work keeps its captured source.</p><label for="sourceMode">Source for future requests</label><select id="sourceMode" data-draft="sourceMode"><option value="committed_only"${draft.sourceMode==='committed_only'?' selected':''}>Committed source only</option><option value="current_tree"${draft.sourceMode==='current_tree'?' selected':''}>Current working tree · manual only</option>${draft.sourceMode==='unsupported'?'<option value="unsupported" selected>Unsupported policy</option>':''}</select>${draft.sourceMode==='current_tree'?'<p class="notice">Capture eligible saved working-tree files for each manual audit, draft or conversation. Safe-source exclusions apply; this is a checked but non-atomic copy, not the entire filesystem or unsaved editor buffers. No project files are changed.</p><p class="muted">This review removes the time schedule and event triggers. Current-tree jobs cannot use handoffs. The stored Git ref stays dormant and cannot be automatically changed while this policy is active.</p>':'<p class="muted">Use the stored Git ref for future requests. Uncommitted changes are excluded. Switching back does not restore schedules or event triggers; review those separately.</p>'}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>Save</button>${S.sourceDraftVersion!==p.current_version?'<p class="notice">This draft began on an older job version. Reset before proposing.</p>':''}<div class="actions">${button('reset-source','Reset to current source policy',S.busy||!usable())}</div></form>`;
}
function lifecycleMarkup(){
 if(S.apiVersion<16)return archived()?'<p class="muted">Update the computer to Pips API 16 to restore this archived Pip.</p>':'';
 if(!canLifecycle())return '<p class="notice">Refresh this Pip to obtain its current lifecycle revision before changing its status.</p>';
 return `<details data-details="pip-lifecycle"${archived()?' open':''}><summary>${archived()?'Restore archived Pip':'Archive Pip'}</summary><p class="muted">${archived()?'Restore returns this Pip to paused. Resume is a separate action; restore queues no work.':'Archive keeps the conversation, definitions, reports and review history. Active work or pending job/handoff reviews must be resolved explicitly first; nothing is silently cancelled.'}</p><p class="muted">Job v${S.pip.current_version} · lifecycle v${S.pip.lifecycle_revision}</p>${button(archived()?'restore-pip':'archive-pip',archived()?'Review restore…':'Review archive…',S.busy||!usable())}</details>`;
}
function reviewLifecycle(restore){
 if(!usable()||!canLifecycle()||restore!==archived())return;draft.findingReviewReason='';
 // Changes still waiting for the user would block archiving: say so here, and reject them as part of it.
 const waiting=restore?[]:waitingProposals(),waitingIds=waiting.map(v=>v.id),n=waiting.length;
 openReview({title:restore?`Restore ${S.pip.name}?`:`Archive ${S.pip.name}?`,description:restore?'It comes back paused. Nothing runs until you resume it.':'It stops running. Its conversation and results stay saved, and you can restore it later.',
  body:n?`<p class="notice">${n===1?'One change is':`${n} changes are`} waiting for your review. Archiving rejects ${n===1?'it':'them'} first.</p><ul class="waiting-list">${waiting.map(v=>`<li>${esc(changeSummary(v))}</li>`).join('')}</ul>`:'',
  confirm:restore?'Restore':n?`Reject ${n===1?'it':'them'} and archive`:'Archive',danger:!restore,reasonRequired:true,autoReason:restore?'Restored in the Pips view.':'Archived in the Pips view.',lifecycle:true,rejectFirst:waitingIds,request:{type:restore?'restore_pip':'archive_pip',pip_id:S.selected,expected_version:S.pip.current_version,expected_lifecycle_revision:S.pip.lifecycle_revision}});
}
// Reject the changes still waiting (the user chose to in the archive dialog), then archive as reviewed.
async function rejectWaitingThenConfirm(review){
 if(S.busy||!usable())return;const token=scope(),pip=S.pip;S.busy=true;renderReview();
 try{for(const id of review.rejectFirst){await send('reject_pip_update',{pip_id:pip.id,proposal_id:id,expected_version:pip.current_version});if(token!==scope())return;}
  const done=new Set(review.rejectFirst);review.rejectFirst=[];S.pip={...S.pip,proposals:(S.pip.proposals||[]).filter(v=>!done.has(v.id))};}
 catch(error){if(token===scope()&&S.review===review){review.error=errorText(error);S.busy=false;renderReview();}return;}
 S.busy=false;renderReview();if(S.review===review)$('review-confirm')?.click();
}
function jobSettingsMarkup(){
  if(archived())return `<section class="section"><h2>Archived</h2><p class="goal">${esc(S.pip.goal)}</p><p class="muted">Its conversation and results are saved. Restore it to use it again.</p>${lifecycleMarkup()}</section>`;
  const p=S.pip,off=S.busy||!usable();
  const what=S.editingGoal?`<form id="revision-form" class="form">${field('revisionGoal','What should it do?',true)}<div class="actions"><button type="submit" class="primary"${off?' disabled':''}>Save</button>${button('cancel-goal','Cancel',S.busy,'quiet')}</div></form>`:`<p class="goal">${esc(p.goal)}</p>`;
  return `<section class="section"><div class="section-head"><h2>What it does</h2><div class="actions">${S.editingGoal?'':button('edit-goal','Edit',off,'quiet')}${S.apiVersion>=23?button('setup-in-chat','Change in chat',off,'quiet'):''}</div></div>${what}</section>`
   +`<section class="section"><h2>When it runs</h2>${quickScheduleMarkup()}</section>`
   +sourceSettingsMarkup()+githubReadsMarkup()
   +`<form id="model-form" class="section form"><h2>Model</h2>${modelPicker('pipModel','Model this Pip uses',draft.pipModel)}<div class="actions"><button type="submit" class="primary"${off||!S.modelDirty?' disabled':''}>Save model</button></div></form>`
   +grantsMarkup()+usageMarkup()
   +`<section class="section"><h2>Pause or archive</h2><p class="muted">${p.status==='paused'?'Paused. It does not run until you resume it.':'Pausing stops it from running. Archiving puts it away; you can restore it later.'}</p><div class="actions">${button('toggle-pip',p.status==='paused'?'Resume':'Pause',off||S.apiVersion>=16&&!canLifecycle())}${S.apiVersion>=16&&canLifecycle()?button('archive-pip','Archive…',off,'quiet danger'):''}</div></section>`
   +`<details class="advanced section" data-details="advanced"><summary>Advanced</summary><p class="muted">Most Pips never need these.</p>${notifyMarkup()}${adaptationMarkup()}${personalPip()?'':projectSourceMarkup()}${shareMarkup()}</details>`;
}
function chooseType(id){const type=S.types.find(t=>t.id===id);if(!S.create||!type?.available||S.busy||!usable())return;rememberCreationDraft();S.createType=id;Object.assign(draft,creationDrafts.get(id)||{name:type.default_name,goal:type.default_goal,source_ref:'HEAD',createModel:'default'});S.createStep='configure';S.error='';render();$('name')?.focus();}
function jobMarkup(p) {
  const type=pipType(p,S.types),pose=presentation(p,[],usable(),S.runner),reviews=pendingReviews(p);
  return `<button type="button" class="job" data-character="${esc(type?.id||'core')}" data-state="${esc(pose.state)}" data-job="${esc(p.id)}" title="${esc(p.name)} · ${esc(pose.label)}" aria-label="${esc(p.name)} · ${esc(pose.label)}" aria-current="${S.selected===p.id&&!S.create}">${avatar(pose.state,type,`row-${p.id}`)}<span class="job-copy"><strong>${esc(p.name)}</strong><span class="job-role">${type?`${esc(type.name)} · ${personalPip(p)?'Personal helper':esc(type.role)}`:'Unsupported Pip type'}</span><span class="job-goal">${esc(p.goal||type?.description||'')}</span><small class="job-status"><i aria-hidden="true"></i>${esc(pose.label)}</small><span class="job-schedule">${esc(scheduleLabel(p.schedule))}</span>${reviews?`<span class="review-count">${reviews} waiting for you</span>`:''}</span></button>`;
}
function executionMarkup(run) {
  const e=execution(run);
  const rows=items=>items.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
  return `<section class="execution" aria-label="Run execution"><h3>Execution</h3><dl class="meta">${rows([['Pinned model',e.model],['Runner',e.runner],['Permission policy',e.policy],['Tool calls made',e.calls],['Started',run.started_at?date(run.started_at):'Not recorded'],['Finished',run.finished_at?date(run.finished_at):'Not recorded'],['Queue time',e.queueDuration],['Run time',e.duration]])}</dl><details data-details="execution-usage"><summary>Token usage and limits</summary><p class="muted">Recorded by this run. Missing measurements are not counted as zero.</p><dl class="meta">${rows(e.usage)}</dl><dl class="meta">${rows(e.limits)}</dl></details><details data-details="execution-policy"><summary>Allowed tools and pinned policy</summary>${e.tools===null?'<p class="muted">Allowed tools were not recorded.</p>':e.tools.length?`<ul class="tool-list">${e.tools.map(t=>`<li><code>${esc(t)}</code></li>`).join('')}</ul>`:'<p class="muted">No tools were allowed.</p>'}<p class="muted">This list is the permission boundary, not a record of tools used.</p><p class="muted mono">Policy digest ${esc(e.policyDigest)}</p></details></section>`;
}
function activityMarkup() {
  const a=S.activity,limited=(a?.events.length||0)>=500;
  return `<section class="run-activity" aria-label="Run activity"><div class="section-head"><h3>Tool activity</h3>${button('load-activity',S.activityLoading?'Loading…':!a?'Load activity':a.has_more?'Load more activity':'Check for new activity',!usable()||S.activityLoading||limited)}</div><p class="muted">${a?`${a.events.length} retained events shown for this run. Up to ${a.retention_limit.toLocaleString()} events are retained across the workspace.`:'Load this run’s recorded tool calls and progress.'}</p>${a?.history_may_be_truncated?'<p class="notice">Earlier activity may no longer be retained.</p>':''}${S.activityError?errorMarkup(S.activityError):''}${a?.events.length?`<ol class="activity-list">${a.events.map(event=>`<li><span>${esc(activityLabel(event))}</span><small>${esc(date(event.created_at))}</small></li>`).join('')}</ol>`:a?'<p class="muted">No retained events for this run.</p>':''}${a?.has_more&&!limited?'<p class="muted">More activity is available. Load the next page to continue.</p>':''}${limited?'<p class="notice">This view is limited to 500 events. Use the local CLI for additional activity.</p>':''}</section>`;
}
async function loadActivity() {
  if(!S.run||S.run.id!==S.runId||S.activityLoading||!usable()||(S.activity?.events.length||0)>=500)return;
  const token=scope(),id=S.runId,sequence=++activitySeq,after=S.activity?.next_cursor||0;
  const identity={id,pip_id:S.selected,workspace_id:S.workspace.id};S.activityLoading=true;S.activityError='';render();
  try {
    const result=await send('list_pip_run_activity',{run_id:id,after});
    if(token!==scope()||sequence!==activitySeq||id!==S.runId)return;
    const page=activityPage(result,identity,after);
    const events=[...(S.activity?.events||[]),...page.events];
    S.activity={...page,events:events.slice(0,500),has_more:page.has_more||events.length>500};
  }catch(error){if(token===scope()&&sequence===activitySeq&&id===S.runId)S.activityError=errorText(error);}
  finally{if(token===scope()&&sequence===activitySeq&&id===S.runId){S.activityLoading=false;render();}}
}
function checkpointReportMarkup(run,checkpoint,error) {
  let baseline=null,baselineError='';try{baseline=checkpointBaseline(run.manifest?.audit_checkpoint,S.selected,S.workspace.id);}catch(e){baselineError=errorText(e);}
  const prior=baseline?.checkpoint;
  return `<section class="section" aria-label="Audit checkpoint"><h3>Audit checkpoint</h3>${errorMarkup(error||baselineError)}<p class="muted">${baselineError?'The pinned comparison baseline could not be read.':checkpoint?.comparison?.status==='unavailable'?(checkpoint.comparison.reason==='source_policy_changed'?'Comparison unavailable because the source policy changed. Prior findings are not treated as fixed.':'Comparison unavailable: this source policy has no earlier checkpoint.'):baseline?prior?`Compared against checkpoint ${prior.id}, run ${esc(prior.run_id)}.`:'This run pinned no earlier checkpoint.':'No checkpoint baseline was recorded for this run.'}</p>${prior?`<dl class="meta">${pinnedSourceMarkup(prior)}<dt>Baseline findings</dt><dd>${prior.total_findings}${prior.omitted_findings?` · ${prior.omitted_findings} excerpts omitted from model input`:''}</dd></dl>`:''}${checkpoint?`<dl class="meta"><dt>Checkpoint</dt><dd>${checkpoint.id}</dd><dt>Total findings</dt><dd>${checkpoint.counts.total}</dd><dt>New</dt><dd>${checkpoint.counts.new??'Unavailable'}</dd><dt>Repeated</dt><dd>${checkpoint.counts.repeated??'Unavailable'}</dd><dt>Not observed</dt><dd>${checkpoint.counts.not_observed??'Unavailable'}</dd></dl><p class="muted">These comparison counts were saved with the report. Not observed means a prior exact finding identity was absent here; it does not mean fixed or resolved.</p>`:!error?'<p class="muted">No checkpoint is available for this report. Legacy reports remain readable.</p>':''}</section>`;
}
function findingReviewMarkup(f,index) {
  const r=f.review,label=status=>({open:'Open',accepted:'Accepted',dismissed:'Dismissed'}[status]);
  return `<div class="finding-review"><p><span class="badge">${f.comparison==='uncompared'?'Comparison unavailable':f.comparison==='new'?'New in this report':'Repeated finding'}</span> <span class="badge">${label(r.status)}</span></p><p class="muted">Pip-local assessment · review v${r.revision}${r.actor?` · ${esc(r.actor)}`:''}${r.updated_at?` · ${esc(date(r.updated_at))}`:''}</p>${r.reason?`<p class="muted">${esc(r.reason)}</p>`:''}<div class="actions">${['accepted','dismissed','open'].filter(status=>status!==r.status).map(status=>`<button type="button" data-review-finding="${index}" data-review-status="${status}"${S.busy||!usable()?' disabled':''}>${status==='accepted'?'Accept assessment…':status==='dismissed'?'Dismiss assessment…':'Reopen assessment…'}</button>`).join('')}</div></div>`;
}
function checkpointHistoryMarkup(){
  const capped=S.checkpoints.length>=200;
  return `<section class="section" aria-label="Checkpoint history"><div class="section-head"><h3>Checkpoint history</h3>${button('load-checkpoints',S.checkpointsLoading?'Loading…':S.checkpointsLoaded?'Refresh checkpoints':'Load checkpoints',!usable()||S.checkpointsLoading)}</div><p class="muted">Completed audit comparisons. The local checkpoint archive is limited to 1,000 entries across Pips. Legacy reports may have no checkpoint.</p>${errorMarkup(S.checkpointsError)}${S.checkpoints.map(c=>`<article class="checkpoint-row"><button type="button" data-run="${esc(c.run_id)}">Checkpoint ${c.id} · ${esc(date(c.created_at))}</button><p class="muted">${c.counts.total} findings · ${c.comparison?.status==='unavailable'?'Comparison unavailable':`${c.counts.new} new · ${c.counts.repeated} repeated · ${c.counts.not_observed} not observed`}</p><small>Job v${c.job_version} · ${esc(c.model)}</small></article>`).join('')|| (S.checkpointsLoaded?'<p class="muted">No retained checkpoints for this Pip.</p>':'')}${S.checkpointCursor&&!capped?button('more-checkpoints','Older checkpoints',!usable()||S.checkpointsLoading):''}${capped?'<p class="muted">Showing 200 checkpoints. Use the local CLI for older records.</p>':''}</section>`;
}
async function loadCheckpoints(more=false){
  if(!usable()||!S.selected||S.checkpointsLoading||(more&&(!S.checkpointCursor||S.checkpoints.length>=200)))return;
  const token=scope(),sequence=++checkpointSeq,before=more?S.checkpointCursor:null;S.checkpointsLoading=true;S.checkpointsError='';render();
  try{const page=checkpointsPage(await send('list_pip_checkpoints',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||sequence!==checkpointSeq)return;
    if(more&&(page.checkpoints.some(c=>c.id>=before||S.checkpoints.some(old=>old.id===c.id))||page.next_before_id===before))throw new Error('Checkpoint history did not advance. Refresh before retrying.');
    S.checkpoints=more?[...S.checkpoints,...page.checkpoints]:page.checkpoints;S.checkpointCursor=page.next_before_id;S.checkpointsLoaded=true;
  }catch(error){if(token===scope()&&sequence===checkpointSeq)S.checkpointsError=errorText(error);}
  finally{if(token===scope()&&sequence===checkpointSeq){S.checkpointsLoading=false;render();}}
}
function handoffTitle(payload){return payload.type==='personal_result.v1'?'Shared Personal result':payload.type==='patch_artifact.v1'?'Accepted Patch artifact':payload.source.title;}
function artifactSourceMarkup(source){return `<section aria-label="Pinned Patch artifact"><h3>Accepted Patch artifact</h3><dl class="meta"><dt>Patch run</dt><dd class="mono">${esc(source.run_id)}</dd><dt>Base commit</dt><dd class="mono">${esc(source.source_revision)}</dd><dt>Result digest</dt><dd class="mono">${esc(source.result_digest)}</dd><dt>Outcome review</dt><dd>Accepted · v${source.review_revision}</dd><dt>Artifact</dt><dd class="mono">${esc(source.artifact.path)}</dd><dt>Artifact SHA-256</dt><dd class="mono">${esc(source.artifact.sha256)}</dd><dt>Artifact size</dt><dd>${source.artifact.bytes.toLocaleString()} bytes</dd></dl><h3>Changed paths</h3><pre>${esc(source.changed_files.join('\n'))}</pre><p class="muted">Pulse tests a private reconstruction of this exact accepted diff on its pinned base commit. It does not test an unrelated current HEAD or change your checkout.</p></section>`;}
function patchSource(run){
  if(run?.status!=='succeeded'||run.manifest?.run_kind!=='patch')return null;
  const review=executionReview(run.execution_review,run.id);if(review?.status!=='accepted')return null;
  const pin=handoffPin(run.manifest.handoff,run,S.workspace.id),result=executionResult(run.result?.execution,'patch',pin.payload.action,pin.payload);
  return patchArtifactSource({pip_id:run.pip_id,run_id:run.id,job_version:run.manifest.job_version,source_revision:run.manifest.source_revision,model:run.manifest.model,result_digest:review.result_digest,review_revision:review.revision,review_status:review.status,artifact:result.changes.artifact,changed_files:result.changes.changed_files});
}
function artifactHandoffControl(run){try{return !archived()&&patchSource(run)?`<section class="section"><h3>Test this accepted artifact</h3><p class="muted">Prepare a separate reviewed Pulse handoff with exact test commands. Accepting this result never starts follow-up work automatically.</p>${button('handoff-artifact','Review Pulse handoff…',S.busy||!usable())}</section>`:'';}catch{return '';}}
function executionContextControl(run){
  try{const review=executionReview(run.execution_review,run.id);if(review?.status!=='accepted')return '';
  const recorded=S.context?.entries.some(e=>e.kind==='execution'&&e.provenance.run_id===run.id);
  return `<section class="section" aria-label="Record reviewed outcome"><h3>Workspace context</h3><p class="muted">${recorded?'This run already has an active historical receipt. Archive that record before recording a later review.':'Record a historical receipt for future runs. This stores exact runner evidence and the accepted review revision, not model conclusions or command output.'}</p>${recorded?'':button('record-execution-context','Record reviewed outcome…',S.busy||!usable()||!S.context)}</section>`;}catch{return '';}
}
function inputReceiptMarkup(input){return input?`<section class="section" aria-label="Tested Patch input"><h3>Tested Patch input</h3><dl class="meta"><dt>Patch run</dt><dd class="mono">${esc(input.source_run_id)}</dd><dt>Base commit</dt><dd class="mono">${esc(input.source_revision)}</dd><dt>Artifact SHA-256</dt><dd class="mono">${esc(input.artifact_sha256)}</dd><dt>Reconstructed tree</dt><dd class="mono">${esc(input.tree)}</dd></dl><p class="muted">This receipt identifies the prepared input. The test's changed-files list counts only changes from this execution.</p></section>`:'';}
function lineageMarkup(run){
  if(!run.manifest?.handoff)return '';
  try{const h=handoffPin(run.manifest.handoff,run,S.workspace.id),p=h.payload;return `<section class="section" aria-label="Handoff lineage"><h3>Reviewed handoff</h3><p>${esc(handoffTitle(p))}</p><p class="goal">${esc(p.task)}</p><dl class="meta">${p.type==='patch_artifact.v1'?`<dt>Patch artifact</dt><dd class="mono">${esc(p.source.artifact.sha256)}</dd>`:`<dt>Source finding</dt><dd>${esc(p.source.finding_id)}</dd>`}<dt>Approved by</dt><dd>${esc(h.review.actor)} · ${esc(date(h.review.approved_at))}</dd><dt>Handoff</dt><dd class="mono">${esc(h.handoff_id)}</dd></dl><div class="actions"><button type="button" data-lineage-pip="${esc(p.source.pip_id)}" data-lineage-run="${esc(p.source.run_id)}">Open source report</button><button type="button" data-handoff="${esc(h.handoff_id)}">View approved handoff</button></div></section>`;}catch(error){return errorMarkup(errorText(error));}
}
function executionReviewMarkup(run){
  try{const r=executionReview(run.execution_review,run.id);if(!r)return '<p class="muted">No outcome review is available for this run.</p>';
    return `<section class="section" aria-label="Execution outcome review"><h3>Your outcome review</h3><p>${esc(r.status)} · review v${r.revision}</p><p class="muted">This local decision does not apply, merge, deploy, or independently verify a change.</p>${r.reason?`<p>${esc(r.reason)}</p><p class="muted">${esc(r.actor)} · ${esc(date(r.updated_at))}</p>`:''}<div class="actions">${['accepted','dismissed','open'].filter(status=>status!==r.status).map(status=>`<button type="button" data-execution-review="${status}"${S.busy||!usable()?' disabled':''}>${status==='accepted'?'Accept outcome…':status==='dismissed'?'Dismiss outcome…':'Reopen outcome…'}</button>`).join('')}</div></section>`;
  }catch(error){return errorMarkup(errorText(error));}
}
function executionReportMarkup(run){
  let pin=null,result=null,specialists=null,error='';try{pin=handoffPin(run.manifest.handoff,run,S.workspace.id);specialistPolicy(run.manifest,pin.payload.action);if(run.result)specialists=specialistReceipt(run.result,run.manifest,pin.payload.action);if(run.result?.execution!=null)result=executionResult(run.result.execution,run.manifest.run_kind,pin.payload.action,pin.payload);else if(run.status==='succeeded')throw new Error('The completed run has no execution evidence. Do not assume changes or tests succeeded.');}catch(e){error=errorText(e);}
  const artifact=a=>`<details><summary>Artifact reference</summary><p class="mono">${esc(a.path)}</p><p class="mono">SHA-256 ${esc(a.sha256)}</p><p class="muted">${a.bytes.toLocaleString()} bytes · Reference only; no file is opened automatically.</p></details>`;
  return `<section class="section" aria-label="Execution report"><div class="section-head"><h2>${run.manifest.run_kind==='patch'?'Proposed changes':'Test evidence'} · ${esc(run.status)}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div><p class="mono">Run ${esc(run.id)}</p><dl class="meta">${pinnedSourceMarkup(run.manifest)}</dl>${pinnedSourceNotice(run.manifest)}${executionMarkup(run)}${lineageMarkup(run)}${activityMarkup()}${errorMarkup(error)}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='cancelled'?'<p class="notice">The run was cancelled. No completed change or test verification is implied.</p>':''}${active(run.status)?'<p class="muted" role="status">The runner is executing the reviewed handoff. This view refreshes while visible.</p>':''}${result?`<p class="notice">Changes stay in a private copy. Nothing was applied, merged or deployed to the user working tree.</p><h3>Changed files (${result.changes.changed_files.length})</h3><pre>${esc(result.changes.changed_files.join('\n')||'No source files changed.')}</pre><h3>Diff</h3><pre>${esc(result.changes.diff||'No textual diff recorded.')}</pre>${result.changes.diff_truncated?'<p class="notice">Diff preview truncated. The artifact records the bounded full diff.</p>':''}${artifact(result.changes.artifact)}${inputReceiptMarkup(result.input)}${specialistReceiptMarkup(specialists)}<h3>Test invocations (${result.tests.length} of ${pin.payload.action.tests.length} approved)</h3>${result.tests.map(t=>`<article class="entry"><h3>Command ${t.index+1} · ${esc(t.status.replaceAll('_',' '))}</h3><pre>${esc(JSON.stringify(t.argv,null,2))}</pre><dl class="meta"><dt>Working directory</dt><dd class="mono">${esc(t.cwd)}</dd><dt>Exit code</dt><dd>${t.exit_code===null?'Not recorded':t.exit_code}</dd></dl><pre>${esc(t.output||'No output recorded.')}</pre>${t.output_truncated?'<p class="notice">Output preview truncated.</p>':''}${artifact(t.artifact)}</article>`).join('')||'<p class="muted">No test invocation evidence is recorded.</p>'}<p class="muted">A zero exit code describes this exact invocation. It does not establish that every defect is fixed or all possible tests passed.</p>${run.status==='succeeded'?executionReviewMarkup(run)+artifactHandoffControl(run)+executionContextControl(run):''}`:''}</section>`;
}
function draftReportMarkup(run){
  let result=null,error='';try{checkedRunSource(run);if(run.status==='succeeded')result=documentationDraft(run.result);}catch(e){result=null;error=errorText(e);}
  return `<section class="section" aria-label="Documentation draft"><div class="section-head"><h2>${result?esc(result.title):'Documentation draft'} · ${esc(run.status)}</h2>${active(run.status)?button('cancel-run','Cancel draft…',S.busy||!usable(),'danger'):''}</div><p class="mono">Run ${esc(run.id)}</p><dl class="meta">${pinnedSourceMarkup(run.manifest)}</dl>${pinnedSourceNotice(run.manifest)}${executionMarkup(run)}${draftAutomationMarkup(run.manifest)}${eventReceiptMarkup(run.manifest)}${activityMarkup()}${errorMarkup(error)}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${active(run.status)?'<p role="status" class="muted">Quill is preparing a private draft from its pinned source. No project files are changed.</p>':''}${run.status==='cancelled'?'<p class="notice">The draft run was cancelled. No completed document is implied.</p>':''}${result?`<p class="notice">${esc(result.verification)}</p><p class="goal">${esc(result.summary)}</p><h3>Draft Markdown</h3><pre class="documentation-markdown" tabindex="0" aria-label="Draft Markdown text">${esc(result.draft.markdown)}</pre><div class="actions">${button('copy-draft','Copy draft',S.busy)}${remoteHost&&options.downloadDraft!==false?button('download-draft','Download Markdown',S.busy):''}</div><p class="muted">Copying or downloading exports this text for your review. It does not publish documentation or change project files.</p><h3>Cited source excerpts</h3>${result.draft.citations.map(c=>`<article class="entry"><p class="mono">${esc(c.path)}:${c.line}</p><pre>${esc(c.excerpt)}</pre><p class="muted">Source excerpt checked. The surrounding draft remains model-authored.</p></article>`).join('')}<details><summary>Private artifact reference</summary><p class="mono">${esc(result.draft.artifact.path)}</p><p class="mono">SHA-256 ${esc(result.draft.artifact.sha256)}</p><p class="muted">${result.draft.artifact.bytes} UTF-8 bytes · Export uses the received draft text; this path is not opened or fetched.</p></details>`:''}</section>`;
}
function draftAutomationMarkup(manifest){
 try{const grant=draftAutomationPin(manifest);if(!grant)return '';return `<section class="section" aria-label="Reviewed draft automation"><h3>${grant.trigger==='schedule'?'Scheduled draft':'Event-triggered draft'}</h3><p>${esc(grant.trigger==='schedule'?scheduleLabel(grant.policy):eventTriggerLabel(grant.policy))}</p>${grant.trigger==='schedule'?`<dl class="meta"><dt>Scheduled for</dt><dd>${esc(date(manifest.scheduled_at))}</dd></dl>`:''}<p class="muted">${esc(quillAutomationNotice)}</p><details><summary>Saved automation grant</summary><dl class="meta"><dt>Job version</dt><dd>${grant.job_version}</dd><dt>Definition digest</dt><dd class="mono">${esc(grant.definition_digest)}</dd><dt>Compact job digest</dt><dd class="mono">${esc(grant.job_digest)}</dd><dt>Grant digest</dt><dd class="mono">${esc(grant.digest)}</dd></dl><p class="muted">Historical approval provenance recorded by the controller; these hashes are not signatures or a new approval.</p></details></section>`;}catch(error){return errorMarkup(errorText(error));}
}
function eventReceiptMarkup(manifest){
 if(manifest?.trigger!=='event')return '';try{const pin=eventRunPin(manifest);return `<section class="section" aria-label="Event-trigger receipt"><h3>Event-triggered ${manifest.pip_type==='quill'?'draft':'audit'}</h3><p>${esc(eventTriggerLabel(pin.policy))}</p><dl class="meta"><dt>Event</dt><dd>${esc(['workspace_session_turn_completed','workspace_committed_paths_changed'].includes(pin.event.event_type)?activityLabel(pin.event):pin.event.event_type.replaceAll('_',' '))}</dd><dt>Occurred</dt><dd>${esc(date(pin.event.created_at))}</dd><dt>${pin.commit_path_match?'Checked for enqueue':'Observed'}</dt><dd>${esc(date(pin.checked_at))}</dd><dt>Event identity</dt><dd class="mono">${esc(pin.event.event_id)} · ${pin.event.seq}</dd></dl>${pin.event.event_type==='workspace_session_turn_completed'?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">${esc(pin.source_semantics)} This event grants no tool permission; its payload was not copied into the model input.</p>${commitMatchMarkup(pin,manifest)}${pin.history_may_be_incomplete?'<p class="notice">Earlier event history may be incomplete. This is not a replay of every change.</p>':''}</section>`;}catch(error){return errorMarkup(errorText(error));}
}
function reportMarkup(){return runReportMarkup()+feedbackMarkup(S.run);}
function runReportMarkup() {
  const run=S.run;
  if(!S.runId) return '<p class="muted">Choose a run to inspect its pinned inputs and report.</p>';
  if(!run || run.id!==S.runId) return '<p role="status">Loading run…</p>';
  if(run.manifest?.run_kind==='personal_task')return `<section class="section" aria-label="Personal result"><div class="section-head"><h2>${esc(statusLabel(run.status))}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div><p class="muted">Saved privately with this Pip. No project files or external actions were changed.</p>${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='succeeded'&&typeof run.result?.text==='string'?`<div class="message-body text final personal-result-text" tabindex="0">${renderPipMarkdown(run.result.text)}</div>${run.manifest.handoff?`<p class="muted">Prepared from a reviewed result shared by another Pip. <button type="button" data-handoff="${esc(run.manifest.handoff.handoff_id)}">View handoff</button></p>`:''}<div class="actions">${button('copy-personal-result','Copy result',S.busy)}${!remoteHost?button('open-personal-result','Open Markdown',S.busy)+button('save-personal-result','Save Markdown…',S.busy)+(S.apiVersion>=31&&!archived()?button('prepare-message','Prepare email…',S.busy):'')+(S.apiVersion>=34&&!archived()?button('prepare-calendar','Prepare calendar event…',S.busy):'')+(S.apiVersion>=36&&!archived()?button('prepare-connector','Use a connected tool…',S.busy):'')+(S.apiVersion>=30&&!archived()?button('handoff-personal','Share with another Pip…',S.busy):''):''}</div>`:''}${run.status==='succeeded'?computerUsedMarkup(run):''}${activityMarkup()}</section>`;
  if(run.manifest?.run_kind==='conversation')return `<section class="section" aria-label="Conversation run"><h2>Conversation reply</h2><p class="muted">${esc(statusLabel(run.status))}. This is a chat turn, not an audit report.</p>${run.status==='failed'?errorMarkup(errorText(run.error)):''}<button type="button" data-tab="chat">Open saved conversation</button>${executionMarkup(run)}${memoryPinMarkup(run)}</section>`;
  if(Object.hasOwn(run.manifest||{},'pulse_verification')||run.manifest?.run_kind==='test'&&!run.manifest?.handoff)return pulseReportMarkup(run);
  if(['patch','test'].includes(run.manifest?.run_kind))return executionReportMarkup(run);
  if(run.manifest?.run_kind==='draft')return draftReportMarkup(run);
  let result=report(run.result);const m=record(run.manifest)?run.manifest:{};let sourceError='';if(run.status==='succeeded'){try{checkedRunSource(run);}catch(error){sourceError=errorText(error);result=null;}}let checkpoint=null,checkpointError='';
  try{checkpoint=runCheckpoint(run.checkpoint,{id:run.id,pip_id:S.selected,workspace_id:S.workspace.id});if(checkpoint&&checkpoint.schema_version===2&&!samePinnedSource(checkpoint,m))throw new Error('Checkpoint source does not match this run.');if(checkpoint&&(!result||checkpoint.findings.length!==result.findings.length||checkpoint.findings.some((f,i)=>['title','path','line','evidence'].some(key=>f[key]!==result.findings[i][key]))))throw new Error('Checkpoint findings do not match the saved report.');}catch(error){checkpoint=null;checkpointError=errorText(error);}
  let pinned=null,pinnedInvalid=false;
  if(m.workspace_context!=null){try{pinned=context(m.workspace_context,S.workspace.id);if(typeof pinned.digest!=='string'||!/^[a-f0-9]{64}$/.test(pinned.digest))throw new Error('Invalid digest');}catch{pinned=null;pinnedInvalid=true;}}
  return `<section class="section" aria-label="Run report"><div class="section-head"><h2>${statusLabel(run.status)}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div><dl class="meta"><dt>Run</dt><dd class="mono">${esc(run.id)}</dd><dt>Job version</dt><dd>${esc(m.job_version??'Unavailable')}</dd>${pinnedSourceMarkup(m)}<dt>Created</dt><dd>${esc(date(run.created_at))}</dd><dt>Trigger</dt><dd>${m.trigger==='schedule'?'Scheduled':m.trigger==='manual'?'Manual':m.trigger==='handoff'?'Reviewed handoff':m.trigger==='event'?'Event-triggered':'Not recorded'}</dd>${m.trigger==='schedule'?`<dt>Scheduled for</dt><dd>${esc(date(m.scheduled_at))}</dd>`:''}<dt>Context version</dt><dd>${pinned?`v${esc(pinned.revision)} · ${pinned.entries.length} records`:pinnedInvalid?'Unavailable (invalid snapshot)':'Not recorded'}</dd></dl>${executionMarkup(run)}${lineageMarkup(run)}${pinnedSourceNotice(m)}${errorMarkup(sourceError)}${eventReceiptMarkup(m)}${memoryPinMarkup(run)}${checkpointReportMarkup(run,checkpoint,checkpointError)}${activityMarkup()}${pinnedInvalid?errorMarkup('The pinned context snapshot is invalid. Its records could not be displayed.'):''}${pinned?`<details data-details="pinned"><summary>Context used by this run</summary><p class="muted mono">Digest ${esc(pinned.digest || 'unavailable')}</p>${contextEntries(pinned.entries)}</details>`:''}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='cancelled'?'<p class="notice">This run was cancelled. No completed audit is implied.</p>':''}${active(run.status)?'<p role="status" class="muted">The runner is processing this run. This view refreshes while visible.</p>':''}${run.status==='succeeded'&&!result?errorMarkup('The completed run has no valid report. Do not interpret this as no findings.'):''}${run.status==='succeeded'&&result?`<p class="notice">Model assessment · Source excerpts only · Tests were not executed</p><p class="goal">${esc(result.summary)}</p><h3>Findings (${result.findings.length})</h3>${result.findings.length?result.findings.map((f,i)=>`<article class="finding"><span class="badge">${esc(f.severity)}</span><h3>${esc(f.title)}</h3><p class="mono">${esc(f.path)}:${f.line}</p><pre>${esc(f.evidence)}</pre>${checkpoint?findingReviewMarkup(checkpoint.findings[i],i):''}${checkpoint&&S.apiVersion>=14?`<button type="button" data-record-exception="${i}"${S.busy||!usable()?' disabled':''}>Record Pip exception…</button>`:''}${checkpoint&&!archived()&&!currentTree()&&handoffSourceAllowed(m)?`<button type="button" data-handoff-finding="${i}"${S.busy||!usable()?' disabled':''}>Review handoff…</button>`:''}<div class="actions"><button type="button" data-finding="${i}"${S.busy||!usable()||!S.context?' disabled':''}>Review for workspace context…</button></div></article>`).join(''):'<p class="muted">The model reported no findings in this audit. This does not establish that the code is defect-free.</p>'}<div class="section"><h3>Verification and limits</h3><p>${esc(result.verification)}</p>${result.limitations.map(x=>`<p class="muted">${esc(x)}</p>`).join('')}</div>`:''}</section>`;
}
function pulsePlanEditor(){
 if(S.pip?.verification_plan?.action?.network==='loopback_http_v1')return `<label class="check-field"><input type="checkbox" id="verificationEnabled" data-draft="verificationEnabled"${draft.verificationEnabled?' checked':''}> Enable the reviewed local HTTP plan</label>${draft.verificationEnabled?pulsePlanReview(S.pip.verification_plan):'<p class="muted">Remove this standing plan. Select Manual only to remove its calendar too, then review the change.</p>'}<p class="muted">Change these URLs through Change setup in chat. Schedule edits retain the displayed HTTP plan.</p>`;
 return `<p class="notice">A standing plan authorizes these exact commands for manual or calendar runs. No model is invoked. Chat and separately approved handoffs keep their existing behavior.</p><label class="check-field"><input type="checkbox" id="verificationEnabled" data-draft="verificationEnabled"${draft.verificationEnabled?' checked':''}> Enable a reviewed standing command plan</label>${draft.verificationEnabled?`<p class="muted">One field is one argument, including spaces. Nothing is split, trimmed, expanded or interpreted as shell text. Use 1–4 commands and 1–32 arguments each.</p>${pulseCommands.map((t,i)=>`<fieldset><legend>Command ${i+1}</legend>${t.argv.map((arg,j)=>`<label for="pulse-${i}-arg-${j}">${j===0?'Executable':`Argument ${j}`}<input id="pulse-${i}-arg-${j}" data-pulse-command="${i}" data-pulse-arg="${j}" value="${esc(arg)}" autocomplete="off" spellcheck="false"></label>${j>0?`<button type="button" data-pulse-remove-arg="${i}:${j}">Remove argument ${j}</button>`:''}`).join('')}<button type="button" data-pulse-add-arg="${i}"${t.argv.length>=32?' disabled':''}>Add argument</button><label for="pulse-${i}-cwd">Relative working directory<input id="pulse-${i}-cwd" data-pulse-command="${i}" value="${esc(t.cwd)}" autocomplete="off" spellcheck="false"></label>${pulseCommands.length>1?`<button type="button" data-pulse-remove-command="${i}">Remove command ${i+1}</button>`:''}</fieldset>`).join('')}${button('pulse-add-command','Add command',pulseCommands.length>=4)}<p class="muted">At most 1,024 UTF-8 bytes per argument and 8,192 across all arguments. Commands read the pinned committed source; only private scratch is writable. Network is off. ${seatbeltRunner()?'Per command: 60 seconds wall time, 30 seconds CPU per process, 64 KiB output. On this macOS runner, 512 MiB of memory across all processes, 32 processes and 64 MiB of scratch are sampled limits, not kernel limits.':'Per command: 60 seconds wall time, 30 seconds CPU and 512 MiB address space per process, 64 KiB output, 32 processes. The parent samples aggregate memory; this is not an exact aggregate RAM ceiling.'}</p>`:'<p class="muted">No standing command permission. Removing an existing plan also removes its calendar in this saved review. Existing receipts remain historical; new execution requires a separate handoff.</p>'}`;
}
function pulsePlanReview(value){
 try{const plan=pulsePlan(value);if(!plan)return '<p class="muted">No standing command plan.</p>';if(plan.action.network==='loopback_http_v1')return `<p class="notice">Standing permission · Local HTTP GET only · No model</p>${plan.action.tests.map(t=>`<article class="entry"><h4>GET ${esc(t.argv[1])}</h4><p>Expected HTTP ${esc(t.argv[2])}</p></article>`).join('')}<p class="muted">10 seconds and 64 KiB body per URL. No redirects, credentials, cookies, shell or external hosts. Checks the running app, which may differ from recorded source. Status only; no rendering or authenticated journey verification.</p>`;return `<p class="notice">Standing permission · Exact commands only · No model · Network off</p>${plan.action.tests.map((t,i)=>`<article class="entry"><h4>Command ${i+1}</h4><ol start="0">${t.argv.map(arg=>`<li><pre>${esc(arg)}</pre></li>`).join('')}</ol><p class="mono">Working directory: ${esc(t.cwd)}</p></article>`).join('')}<p class="muted">Read-only prepared source; private scratch only. Per command: ${seatbeltRunner()?'wall 60s, CPU 30s per process, output 64 KiB; on this macOS runner memory 512 MiB across all processes and 32 processes are sampled, not kernel limits':'wall 60s, CPU 30s and address space 512 MiB per process, output 64 KiB, 32 processes'}. No network, source writes, model calls or automatic retries. A schedule invokes this plan at each approved occurrence until changed or removed.</p>`;}catch(error){return errorMarkup(errorText(error));}
}
function pulseProposalBody(proposal,{stale,unavailable,pulseUnsupported,reject}){
 const next=proposal.definition;
 return `<h3>${esc(next.name)}</h3><p class="muted">${esc(proposal.actor||'Requester not recorded')} · ${proposal.expires_at?'Expires '+esc(date(proposal.expires_at)):'Expiry not recorded'}</p><p class="goal">${esc(proposal.reason)}</p><h3>Proposed command permission</h3>${pulsePlanReview(next.verification_plan)}${S.pip.verification_plan!=null&&next.verification_plan==null?'<p class="notice">This removes the standing command permission and its calendar. Existing receipts stay historical; no command starts.</p>':''}<h3>Calendar</h3><dl class="meta"><dt>Current</dt><dd>${esc(scheduleLabel(S.pip.schedule))}</dd><dt>Proposed</dt><dd>${esc(scheduleLabel(next.schedule))}</dd><dt>Source ref</dt><dd>${esc(S.pip.source_ref)} → ${esc(next.source_ref)}</dd></dl><p class="muted">The approved local ref is resolved to a committed snapshot when each run queues. Pulse events and working-tree source are unavailable. Paused or busy Pips skip due occurrences; an active Pip coalesces overdue work after runner downtime. An accepted one-time occurrence is consumed even if execution fails or is cancelled. No automatic retry.</p><details><summary>Current command plan</summary>${pulsePlanReview(S.pip.verification_plan)}</details><details><summary>Other saved job fields</summary><dl class="meta"><dt>Name</dt><dd>${esc(S.pip.name)} → ${esc(next.name)}</dd><dt>Current goal</dt><dd>${esc(S.pip.goal)}</dd><dt>Proposed goal</dt><dd>${esc(next.goal)}</dd><dt>Source policy</dt><dd>${esc(sourcePolicyLabel(next.source_policy))}</dd><dt>Adaptation</dt><dd>${esc(adaptationLabel(next.adaptation_policy))}</dd><dt>Model choice</dt><dd>${esc(modelLabel(next.model_choice))} · unused by standalone commands</dd></dl></details><details><summary>Complete saved definition</summary><pre>${esc(JSON.stringify(next,null,2))}</pre></details>${pulseUnsupported?errorMarkup('Update to Pips API 21 and refresh the saved plan before accepting this revision.'):''}${!reject&&stale?errorMarkup('The job changed. Dismiss this proposal and prepare a current review.'):''}${unavailable?errorMarkup('This saved review is unavailable or no longer pending. Refresh before accepting.'):''}${proposal.expires_at&&Date.parse(proposal.expires_at)<=Date.now()?errorMarkup('This review has expired. Create a new proposal.'):''}`;
}
function pulseRunsMarkup(runs){
 let eligible=false,invalid='';try{eligible=!!pulsePlan(S.pip.verification_plan);if(eligible)pulseRunPins(S.pip);}catch(error){eligible=false;invalid=errorText(error);}
 const disabled=S.busy||!usable()||S.apiVersion<21||!eligible||!S.runner?.online||S.runner.paused||S.pip.status!=='active'||!!S.pip.active_run||runs.some(r=>active(r.status))||!supportedSource();
 return `<section class="section"><div class="section-head"><h2>Pulse command runs</h2>${eligible?button('run','Run approved commands',disabled,'primary'):''}</div><p class="muted">${eligible?'The standing plan runs exact approved commands without a model. Each invocation has its own recorded outcome.':'A reviewed standing plan enables manual or calendar commands on API 21. Separately approved handoffs remain available.'} Chat stays read-only.</p>${errorMarkup(invalid)}${S.apiVersion<21?'<p class="notice">Update the computer to Pips API 21 before using a standing command plan.</p>':''}<div class="actions"><button type="button" data-tab="schedule">Review plan and schedule</button><button type="button" data-tab="handoffs">Open handoffs</button></div>${runs.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${r.execution_mode==='standalone_plan'&&pulseProgress(r)?`${pulseProgress(r).failed} failed · ${pulseProgress(r).passed} passed · ${esc(r.status)}`:r.manifest?.pulse_verification&&r.status==='succeeded'?'Command capture complete':esc(statusLabel(r.status))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No command runs yet.</p>'}</section>${reportMarkup()}`;
}
function pulseReportMarkup(run){
 let grant=null,receipt=null,error='';try{grant=pulseVerificationPin(run.manifest);if(!grant||grant.pip_id!==run.pip_id||grant.pip_id!==S.selected||grant.workspace_id!==S.workspace.id||run.workspace_id!==undefined&&run.workspace_id!==grant.workspace_id)throw Error('This command run has no matching standalone Pulse grant for this workspace.');if(run.result!=null)receipt=pulseVerificationReceipt(run.result,run.manifest,run.status);else if(!active(run.status))throw Error('The terminal command receipt is missing. Outcomes are unavailable.');}catch(e){grant=null;receipt=null;error=errorText(e);}
 const counts={passed:0,failed:0,stopped:0,unexecuted:0,unknown:0};for(const c of receipt?.commands||[]){const label=pulseCommandLabel(c);counts[label==='Passed invocation'?'passed':label==='Failed invocation'?'failed':label==='Stopped invocation'?'stopped':label==='Unexecuted'?'unexecuted':'unknown']++;}
 const title=receipt?`${counts.failed} failed · ${counts.passed} passed invocation${counts.passed===1?'':'s'}`:'Command outcomes unavailable';
 return `<section class="section" aria-label="Pulse command receipt"><div class="section-head"><h2>${esc(title)}</h2>${active(run.status)?button('cancel-run','Cancel command run…',S.busy||!usable(),'danger'):''}</div>${grant?'<p class="notice">Exact invocation outcomes · Model not invoked. A zero exit code is not proof that project tests passed or the source is correct.</p>':'<p class="notice">Standalone command evidence is unavailable. No completed verification is implied.</p>'}${grant&&run.manifest.job.verification_plan.action.network==='loopback_http_v1'?'<p class="notice">Local HTTP status checks only. The running app may differ from the recorded source. These checks do not verify rendering or authenticated user journeys.</p>':''}${errorMarkup(error)}${run.error?errorMarkup(errorText(run.error)):''}${receipt?`<p>${counts.stopped} stopped · ${counts.unexecuted} unexecuted · ${counts.unknown} outcome unknown</p><p class="muted">${receipt.phase==='running'?'Capture is still in progress. Counts are provisional.':`Terminal reason: ${receipt.terminal_reason.replaceAll('_',' ')}.`} A launch reservation without a final capture has an unknown outcome. Later commands never reserved are unexecuted.</p>`:''}${grant?`<dl class="meta"><dt>Run status</dt><dd>${esc(run.status)}</dd><dt>Model</dt><dd>Not invoked</dd><dt>Job version</dt><dd>${grant.job_version}</dd><dt>Trigger</dt><dd>${grant.trigger==='schedule'?'Scheduled':'Manual'}</dd>${grant.trigger==='schedule'?`<dt>Scheduled for</dt><dd>${esc(date(run.manifest.scheduled_at))}</dd>`:''}${pinnedSourceMarkup(run.manifest)}</dl>${receipt?receipt.commands.map((c,i)=>{const approved=run.manifest.job.verification_plan.action.tests[i],t=c.outcome;return `<article class="entry"><h3>Command ${i+1} · ${esc(pulseCommandLabel(c))}</h3><ol start="0">${approved.argv.map(arg=>`<li><pre>${esc(arg)}</pre></li>`).join('')}</ol><p class="mono">Working directory: ${esc(approved.cwd)}</p>${t?`<p>Exit code: ${t.exit_code===null?'No process launched':t.exit_code} · ${esc(t.status.replaceAll('_',' '))}</p><pre>${esc(t.output||'No output recorded.')}</pre>${t.output_truncated?'<p class="notice">Output preview truncated.</p>':''}<details><summary>Output artifact identity</summary><p class="mono">${esc(t.artifact.path)} · ${t.artifact.bytes} bytes</p><p class="mono">${esc(t.artifact.sha256)}</p><p class="muted">The digest identifies private artifact bytes, not this redacted preview. This path is not opened or downloaded.</p></details>`:''}</article>`;}).join(''):'<p role="status">No durable command capture has been recorded yet.</p>'}<details><summary>Saved command permission and receipt identity</summary><dl class="meta"><dt>Run</dt><dd class="mono">${esc(run.id)}</dd><dt>Approval</dt><dd class="mono">${esc(grant.approval_id)}</dd><dt>Lifecycle revision at queue</dt><dd>${grant.lifecycle_revision}</dd><dt>Plan digest</dt><dd class="mono">${esc(grant.plan_digest)}</dd><dt>Grant digest</dt><dd class="mono">${esc(grant.digest)}</dd><dt>Definition digest</dt><dd class="mono">${esc(grant.definition_digest)}</dd></dl><p class="muted">The controller validates saved approval, command and calendar identity. Hashes are not signatures or new permissions. No execution assessment or Workspace Context promotion is available for this receipt.</p></details>`:''}${activityMarkup()}</section>`;
}
function runsMarkup() {
  const audits=S.runs.filter(r=>r.manifest?.run_kind!=='conversation');
  if(S.pip?.source_policy?.mode==='personal')return `<section class="section"><div class="section-head"><h2>Results</h2>${button('run','Run now',S.busy||!usable()||!S.runner?.online||S.runner?.paused||S.pip.status!=='active'||S.runs.some(r=>active(r.status)),'primary')}</div><p class="muted">Manual and scheduled results stay with this Pip, across your projects.</p>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}"><span>${esc(statusLabel(r.status))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No results yet.</p>'}</section>${reportMarkup()}`;
  if(pulsePip(S.pip))return pulseRunsMarkup(audits);
  if(executionPip(S.pip))return `<section class="section"><h2>Reviewed execution runs</h2><p class="muted">Only an approved handoff can start this Pip. Chat stays read-only; there is no Run audit button or schedule.</p><button type="button" data-tab="handoffs">Open handoffs</button>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${esc(r.status)}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No reviewed execution runs yet.</p>'}</section>${reportMarkup()}`;
  if(documentationPip(S.pip))return `<section class="section"><div class="section-head"><h2>Documentation drafts</h2>${button('run','Create draft',S.busy||!usable()||!S.runner?.online||S.runner?.paused||S.pip?.status!=='active'||S.runs.some(r=>active(r.status))||!!S.pip?.active_run||!pipType(S.pip,S.types)?.available||!supportedSource(),'primary')}</div><p class="muted">Private drafts from the approved source policy. Reviewed schedules require API 20. No project writes or publishing. Conversation replies stay in Chat.</p>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${r.status==='succeeded'?'Draft ready':r.status==='running'?'Drafting documentation':esc(statusLabel(r.status))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No drafts yet. Each draft pins the goal, source identity and workspace context.</p>'}</section>${reportMarkup()}`;
  return `<section class="section"><div class="section-head"><h2>Audit runs</h2>${button('run','Run audit',S.busy||!usable()||!S.runner?.online||S.runner?.paused||S.pip?.status!=='active'||S.runs.some(r=>active(r.status))||!!S.pip?.active_run||!pipType(S.pip,S.types)?.available||!supportedSource(),'primary')}</div><p class="muted">Manual, scheduled and event-triggered reports appear here. Conversation replies stay in Chat.</p>${!S.runner?.online?'<p class="muted">Start the local runner to keep audits running independently of this editor.</p>':''}${audits.length?audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${statusLabel(r.status)}</span><small>${esc(date(r.created_at))}</small></button></div>`).join(''):'<p class="muted">No audit runs yet. Each audit pins this goal, source identity, and workspace context.</p>'}</section>${reportMarkup()}${checkpointHistoryMarkup()}`;
}
// When it runs, in the shapes people use: when asked, every day, weekdays, every few hours. Anything
// else (a cron line, once, events, a Pulse command plan) stays under Advanced, shown here as it is.
function quickKind(pip){
 const v=pip.schedule;if(pip.event_trigger)return 'custom';if(v==null)return 'manual';if(v.type==='daily')return 'daily';
 if(v.type==='interval')return v.minutes%60===0?'hours':'custom';
 return v.type==='cron'&&/^\d{1,2} \d{1,2} \* \* 1-5$/.test(v.cron)?'weekdays':'custom';
}
function hydrateQuickSchedule(pip){
 const v=pip.schedule,m=v?.type==='cron'?/^(\d{1,2}) (\d{1,2}) /.exec(v.cron):null;
 draft.quickKind=quickKind(pip);draft.quickTime=v?.type==='daily'?v.time:m?`${m[2].padStart(2,'0')}:${m[1].padStart(2,'0')}`:'08:30';
 draft.quickHours=String(v?.type==='interval'?Math.max(1,Math.round(v.minutes/60)):4);draft.quickZone=v?.timezone||defaultZone;S.quickDirty=false;
}
function quickSchedule(){
 const k=draft.quickKind,zone=draft.quickZone||defaultZone;
 if(k==='manual')return null;
 if(k==='daily')return scheduleFromDraft({scheduleType:'daily',scheduleTime:draft.quickTime,scheduleZone:zone});
 if(k==='weekdays'){const m=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(draft.quickTime);if(!m)throw Error('Choose a time.');return scheduleFromDraft({scheduleType:'cron',scheduleCron:`${Number(m[2])} ${Number(m[1])} * * 1-5`,scheduleZone:zone});}
 if(k==='hours'){const h=Number(draft.quickHours);if(!Number.isInteger(h)||h<1||h>168)throw Error('Choose every 1 to 168 hours.');return scheduleFromDraft({scheduleType:'interval',scheduleMinutes:String(h*60)});}
 throw Error('Choose when it runs.');
}
function quickScheduleMarkup(){
 const p=S.pip,off=S.busy||!usable(),next=record(p.schedule_state)?p.schedule_state.next_due_at:null;
 if(executionPip(p)&&!pulsePip(p))return '<p class="muted">It runs only when you approve a handoff to it.</p>';
 if(currentTree())return '<p class="muted">It runs when you ask. A schedule needs committed source (see Advanced).</p>';
 if(pulsePip(p)||documentationPip(p)&&S.apiVersion<20)return `<p>${esc(p.event_trigger?eventTriggerLabel(p.event_trigger):scheduleLabel(p.schedule))}</p><button type="button" data-tab="schedule">Change…</button>`;
 const kinds=[['manual','When I ask'],['daily','Every day'],['weekdays','Weekdays'],['hours','Every few hours'],...(draft.quickKind==='custom'?[['custom',p.event_trigger?eventTriggerLabel(p.event_trigger):scheduleLabel(p.schedule)]]:[])];
 return `<form id="quick-schedule-form" class="quick-schedule"><select id="quickKind" data-draft="quickKind" aria-label="When it runs"${off?' disabled':''}>${kinds.map(([key,label])=>`<option value="${key}"${draft.quickKind===key?' selected':''}>${esc(label)}</option>`).join('')}</select>${['daily','weekdays'].includes(draft.quickKind)?`<label class="inline">at <input id="quickTime" data-draft="quickTime" type="time" step="60" value="${esc(draft.quickTime)}" required${off?' disabled':''}></label>`:draft.quickKind==='hours'?`<label class="inline">every <input id="quickHours" data-draft="quickHours" type="number" min="1" max="168" step="1" value="${esc(draft.quickHours)}" required${off?' disabled':''}> hours</label>`:''}<button type="submit" class="primary"${off||draft.quickKind==='custom'||!S.quickDirty?' disabled':''}>Save</button></form><p class="muted">${draft.quickKind==='custom'?'Set in Advanced.':draft.quickKind==='manual'?'It runs when you ask it to.':draft.quickKind==='hours'?'':`Times are in ${esc(draft.quickZone)}.`}${next&&!S.quickDirty?` Next run ${esc(date(next))}.`:''}</p>`;
}
function hydrateSchedule(pip) {
  const value=pip.schedule;draft.verificationEnabled=pip.verification_plan!=null;
  pulseCommands=pip.verification_plan?.action?.tests?.map(t=>({argv:[...t.argv],cwd:t.cwd}))||[{argv:[''],cwd:'.'}];
  draft.scheduleType=value?.type||'manual';draft.scheduleMinutes=String(value?.minutes||60);
  const trigger=eventTrigger(pip.event_trigger);if(trigger)draft.scheduleType='events';draft.triggerContext=trigger?.events.includes('context_updated')??false;draft.triggerFinding=trigger?.events.includes('finding_accepted')??false;draft.triggerCommit=trigger?.events.includes('commit_changed')??false;draft.triggerSession=trigger?.events.includes('session_turn_completed')??false;draft.triggerMinutes=String(trigger?.minimum_minutes??5);draft.triggerPaths=trigger?.events.includes('committed_paths_changed')??false;commitRules=trigger?.commit_paths?.map(r=>({...r}))||[{kind:'exact',path:''}];
  draft.scheduleTime=value?.time||'09:00';draft.scheduleZone=value?.timezone||defaultZone;draft.scheduleAt=value?.at||'';draft.scheduleCron=value?.cron||'0 9 * * 1-5';
  S.scheduleDraftVersion=pip.current_version;
}
const sessionTurnNotice='After a native foreground turn is successfully saved. No transcript is shared. This does not mean the project or session is finished, or that tests passed. An audit uses the approved committed ref at enqueue, not the source from the saved turn.';
const quillAutomationNotice='Quill creates private, model-authored drafts; it does not publish documentation, update shared context, or verify prose or tests. Each run reads the approved ref’s current local commit at enqueue, which may differ from the triggering event. No transcript is shared.';
const commitPathNotice='Watches literal entries in committed trees at this Pip’s approved local ref. Dirty files, editor writes and remote activity are excluded. The first observation is silent. A run uses the approved commit at enqueue, which can differ from the observed commit pair.';
function commitRulesMarkup(value,title='Committed path rules'){
 if(value==null)return '';try{const rules=commitPathRules(value);return `<h3>${esc(title)}</h3><ol>${rules.map(r=>`<li><span>${r.kind==='directory'?'Directory descendants':'Exact tree entry'}</span> <code>${esc(r.path)}</code></li>`).join('')}</ol>`;}catch(error){return errorMarkup(errorText(error));}
}
function commitRulesEditor(){
 return `<fieldset><legend>Literal committed paths</legend>${commitRules.map((r,i)=>`<label for="commit-kind-${i}">Rule ${i+1}<select id="commit-kind-${i}" data-commit-rule="${i}" data-commit-kind><option value="exact"${r.kind==='exact'?' selected':''}>Exact tree entry</option><option value="directory"${r.kind==='directory'?' selected':''}>Directory descendants</option></select></label><label for="commit-path-${i}">Repository path<input id="commit-path-${i}" data-commit-rule="${i}" value="${esc(r.path)}" autocomplete="off" spellcheck="false"></label>${commitRules.length>1?`<button type="button" data-remove-commit-rule="${i}">Remove rule ${i+1}</button>`:''}`).join('')}${button('add-commit-rule','Add path rule',commitRules.length>=32)}</fieldset><p class="muted">Case-sensitive literal paths, no wildcards. Directory src matches src/a.py, not src2/a.py or the entry src. Deleted entries count; symlinks and gitlinks are not followed. Up to 32 unique paths, 256 UTF-8 bytes each and 2,048 bytes together. Spaces inside a path are literal; nothing is trimmed or broadened.</p><p class="notice">Other selected events are OR conditions: each can wake this Pip independently of a path match. The minimum interval applies to the whole policy.</p><p class="muted">${esc(commitPathNotice)}</p>`;
}
function commitMatchMarkup(pin,manifest){
 const m=pin.commit_path_match;if(!m)return '';const c=m.comparison;return `<h4>Recorded committed-path match</h4><ol>${c.matched_rule_indices.map(i=>{const r=pin.policy.commit_paths[i];return `<li>${r.kind==='directory'?'Directory descendants':'Exact tree entry'} <code>${esc(r.path)}</code></li>`;}).join('')}</ol><p>${c.changed_entries} changed tree entries in the bounded comparison.</p><dl class="meta"><dt>Observed before commit</dt><dd class="mono">${esc(c.before_revision)}</dd><dt>Observed after commit</dt><dd class="mono">${esc(c.after_revision)}</dd><dt>Run source commit at enqueue</dt><dd class="mono">${esc(manifest.source_revision)}</dd></dl><p class="notice">The observed pair is a wakeup reason, not the source selection for this run. Intermediate changes may not have been observed. This receipt is metadata, not a test result.</p><details><summary>Match receipt identities</summary><dl class="meta"><dt>Approved source ref</dt><dd>${esc(m.source_ref)}</dd><dt>Rule digest</dt><dd class="mono">${esc(m.policy_digest)}</dd><dt>Comparison digest</dt><dd class="mono">${esc(c.digest)}</dd><dt>Match digest</dt><dd class="mono">${esc(m.digest)}</dd><dt>Binding</dt><dd class="mono">${esc(m.binding_id)}</dd></dl><p class="muted">The controller validates saved scope, rules and event identity. Digests bind stored bytes; they are not independent proof of a Git observation.</p></details>`;
}

function pathProposalBody(proposal,{stale,unavailable,pathUnsupported,reject}){
 const next=proposal.definition;return `<h3>${esc(next.name)}</h3><p class="goal">${esc(proposal.reason)}</p><dl class="meta"><dt>Current events</dt><dd>${esc(eventTriggerLabel(S.pip.event_trigger))}</dd><dt>Proposed events</dt><dd>${esc(eventTriggerLabel(next.event_trigger))}</dd><dt>Source ref</dt><dd>${esc(S.pip.source_ref)} → ${esc(next.source_ref)}</dd><dt>Proposed calendar</dt><dd>${esc(scheduleLabel(next.schedule))}</dd><dt>Requested by</dt><dd>${esc(proposal.actor||'Not recorded')}</dd><dt>Expires</dt><dd>${proposal.expires_at?esc(date(proposal.expires_at)):'Not recorded'}</dd></dl>${commitRulesMarkup(S.pip.event_trigger?.commit_paths,'Current committed path rules')}${commitRulesMarkup(next.event_trigger?.commit_paths,'Proposed committed path rules')}${!next.event_trigger?.commit_paths?'<p class="notice">This removes the committed-path filter. Review any remaining event choices above.</p>':''}<p class="notice">Other selected events can wake this Pip independently of a path match (OR). The shared minimum interval applies to all selected events.</p><p class="muted">${esc(commitPathNotice)}</p><p class="muted">Approving a trigger does not replay old history. Paused or busy Pips skip backlog; active Pips coalesce retained events. No new tool permission is granted.</p>${documentationPip(S.pip)?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${next.event_trigger?.events?.includes('session_turn_completed')?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<details><summary>Complete saved definition</summary><pre>${esc(JSON.stringify(next,null,2))}</pre></details>${pathUnsupported?errorMarkup('Valid committed-path rules and Pips API 22 are required before accepting this revision.'):''}${!reject&&stale?errorMarkup('The job changed. Dismiss this proposal and prepare a current review.'):''}${unavailable?errorMarkup('This saved review is unavailable or no longer pending. Refresh before accepting.'):''}`;
}
function commitObservationMarkup(pip){
 if(!pip.event_trigger?.commit_paths)return '';try{const value=commitPathObservation(pip.commit_path_observation,pip);if(!value)return '<p class="muted">No committed-path observation has been recorded.</p>';if(value.status==='unavailable')return '<p class="notice">Stored committed-path observation unavailable. This does not mean unchanged or unmatched.</p>';
 const p=value.last_probe,c=value.last_comparison,labels={baselined:'Baseline established · no wakeup',unchanged:'Same observed commit',compared:'Comparison recorded',unavailable:'Latest probe unavailable'};return `<details data-details="commit-observation"><summary>Committed-path observations · ${p?esc(labels[p.status]):'not checked yet'}</summary><p class="muted">Stored metadata only; opening this view does not probe Git. A successful prior comparison does not establish that the current ref or source is available.</p><dl class="meta"><dt>Baseline commit</dt><dd class="mono">${esc(value.revision??'Not established')}</dd><dt>Latest probe</dt><dd>${value.last_checked_at?esc(date(value.last_checked_at)):'Not checked yet'}</dd>${p?.reason?`<dt>Probe limitation</dt><dd>${esc(p.reason.replaceAll('_',' '))}</dd>`:''}<dt>Completed changed-commit observations</dt><dd>${value.observed_changes} · not a run or match count</dd></dl>${c?`<h4>Last successful comparison</h4><p>${esc(date(value.last_comparison_at))} · ${c.status==='matched'?'Matched reviewed rules':'No reviewed rule matched'} · ${c.changed_entries} changed entries</p><dl class="meta"><dt>Observed before</dt><dd class="mono">${esc(c.before_revision)}</dd><dt>Observed after</dt><dd class="mono">${esc(c.after_revision)}</dd></dl>${c.matched_rule_indices.length?commitRulesMarkup(c.matched_rule_indices.map(i=>pip.event_trigger.commit_paths[i]),'Matched rules'):''}<p class="muted">This comparison retains its original timestamp when a later probe is unavailable. It does not imply a queued run or a clean source tree.</p>`:'<p class="muted">No complete comparison recorded. Unknown is not unchanged.</p>'}</details>`;
 }catch(error){return errorMarkup(errorText(error));}
}

function eventTriggerFields(){return `<fieldset><legend>Run after these changes</legend>${[['triggerContext','Workspace context changes'],['triggerFinding','A finding is accepted'],['triggerCommit','The committed source changes'],...(S.apiVersion>=18?[['triggerSession','Session turn saved']]:[]),...(S.apiVersion>=22?[['triggerPaths','Selected committed paths change']]:[])].map(([id,label])=>`<label class="check-field"><input type="checkbox" id="${id}" data-draft="${id}"${draft[id]?' checked':''}${id==='triggerCommit'&&draft.triggerPaths||id==='triggerPaths'&&draft.triggerCommit?' disabled':''}> ${label}</label>`).join('')}</fieldset>${draft.triggerPaths?S.apiVersion>=22?commitRulesEditor():'<p class="notice">Update the computer to Pips API 22 to change committed-path rules.</p>':''}<label>Minimum interval in minutes<input id="triggerMinutes" data-draft="triggerMinutes" type="number" min="5" max="10080" step="1" value="${esc(draft.triggerMinutes)}" required></label><p class="muted">Context means a recorded, archived or promoted entry. A finding must be explicitly accepted; generating one does not trigger another run. Commit changes watch this Pip’s approved local ref. The first observation establishes a baseline; dirty files and uncommitted edits are excluded. Nothing is fetched from a Git remote.</p>${S.apiVersion>=18?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">This is a minimum interval, not an exact run time. Approving a trigger starts at the current event cursor and does not replay history. Active jobs coalesce retained events after downtime; paused or busy jobs skip backlog. No overlapping runs or backlog burst.</p>`;}
function currentEventMarkup(p){const state=record(p.event_trigger_state)?p.event_trigger_state:null;return p.event_trigger?`<section class="section" aria-label="Current event trigger"><h2>Current event trigger</h2><p>${esc(eventTriggerLabel(p.event_trigger))}</p>${commitRulesMarkup(p.event_trigger.commit_paths)}${commitObservationMarkup(p)}<dl class="meta"><dt>Next allowed</dt><dd>${state?.next_allowed_at?esc(date(state.next_allowed_at)):'Not recorded'}</dd><dt>Last checked</dt><dd>${state?.last_checked_at?esc(date(state.last_checked_at)):'Not checked yet'}</dd></dl><p class="muted">Times are shown in ${esc(defaultZone)}. An eligible retained event and an active, available runner are still required. This does not promise a run at that time.</p></section>`:'';}
function scheduleMarkup() {
  if(archived())return `<section class="section"><h2>Archived schedule</h2><p>${esc(S.pip.event_trigger?eventTriggerLabel(S.pip.event_trigger):scheduleLabel(S.pip.schedule))}</p><p class="muted">Automation is inactive. Restore to paused, then explicitly resume when ready.</p></section>`;
  if(currentTree())return '<section class="section"><h2>Manual working-tree requests</h2><p class="muted">Current-tree source does not support schedules or event triggers. Review a switch to committed source in Job before adding automation.</p></section>';
  if(pulsePip(S.pip)&&S.apiVersion<21)return '<section class="section"><h2>Pulse command plans</h2><p class="notice">Update the computer to Pips API 21 for a reviewed standing command plan and calendar. Existing handoffs and read-only chat remain available.</p></section>'+savedProposalsMarkup();
  if(executionPip(S.pip)&&!pulsePip(S.pip))return '<section class="section"><h2>Explicit handoffs only</h2><p class="muted">Patch and Pulse do not run on schedules. Review one handoff with exact permissions for each execution. Chat stays read-only.</p></section>';
  const p=S.pip,state=record(p.schedule_state)?p.schedule_state:null,quill=documentationPip(p),pulse=pulsePip(p),legacyQuill=quill&&S.apiVersion<20;
  const upgrade='<p class="notice">Update the computer to Pips API 20 to review Quill schedules or event triggers. Manual drafts remain available.</p>';
  if(legacyQuill&&!p.schedule&&!p.event_trigger)return `<section class="section"><h2>Manual drafts</h2>${upgrade}</section>${savedProposalsMarkup()}`;
  const choices=[['manual','Manual only'],...(!legacyQuill&&(!pulse||draft.verificationEnabled)?[['interval','Interval'],['daily','Daily'],['once','Once'],['cron','Cron'],...(S.apiVersion>=10&&!pulse&&!personalPip()?[['events','On events']]:[])]:draft.scheduleType!=='manual'?[[draft.scheduleType,'Current automation · requires API 20']]:[])];
  return `${legacyQuill?upgrade:''}${quill?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${currentEventMarkup(p)}<section class="section"><h2>Current schedule</h2><p>${esc(p.event_trigger?'No time schedule · events enabled':scheduleLabel(p.schedule))}</p>${p.schedule?`<dl class="meta"><dt>Next due</dt><dd>${state?.next_due_at?esc(date(state.next_due_at)):'Not currently scheduled'}</dd><dt>Last occurrence</dt><dd>${state?.last_due_at?esc(date(state.last_due_at)):'No occurrence recorded'}</dd></dl><p class="muted">Due times above are shown in ${esc(defaultZone)}.</p>`:''}${p.status==='paused'||S.runner?.paused?'<p class="notice">This Pip is paused. Scheduling stays suspended until the Pip and runner are resumed.</p>':''}<p class="muted">${personalPip()?'Schedules prepare personal results from your approved goal and any separately reviewed app reads.':pulse?'Schedules invoke only the approved exact commands. No model is invoked.':quill?'Schedules create private model-authored documentation drafts using read-only source tools.':'Schedules use the existing read-only audit policy.'} The local runner must be online. Individually paused or busy Pips skip due occurrences and resume at the next scheduled time. After the runner was offline or globally stopped, an active Pip coalesces overdue work to one latest occurrence, never a backlog burst. Global stop also pauses every Pip; resume each Pip explicitly.</p><p class="muted">Daily and cron schedules skip a time that does not exist during a clock change. A repeated time runs once, on its first occurrence. A one-time occurrence skipped while paused or busy is consumed. Changing its goal or model does not re-arm it.</p></section><form id="schedule-form" class="section form"><h2>${pulse?'Command plan and schedule':'Change schedule'}</h2>${pulse?pulsePlanEditor():''}${pulse?'<p class="muted">The commands are reviewed once before they can run.</p>':''}<label for="scheduleType">Run schedule</label><select id="scheduleType" data-draft="scheduleType">${choices.map(([key,label])=>`<option value="${key}"${draft.scheduleType===key?' selected':''}>${label}</option>`).join('')}</select>${draft.scheduleType==='events'?eventTriggerFields():draft.scheduleType==='interval'?`<label>Interval in minutes<input id="scheduleMinutes" data-draft="scheduleMinutes" type="number" min="5" max="10080" step="1" value="${esc(draft.scheduleMinutes)}" required></label><p class="muted">From 5 minutes to 7 days.</p>`:draft.scheduleType==='daily'?`<div class="two-fields"><label>Time<input id="scheduleTime" data-draft="scheduleTime" type="time" step="60" value="${esc(draft.scheduleTime)}" required></label>${field('scheduleZone','IANA time zone')}</div><p class="muted">The time is interpreted in the named zone. For example, Europe/Paris.</p>`:draft.scheduleType==='once'?`${field('scheduleAt','Date and time with UTC offset')}<p class="muted">Enter an ISO timestamp, for example 2099-10-02T09:00:00+05:30. The offset is required. The saved proposal shows the same instant in UTC; it must still be in the future when accepted.</p>`:draft.scheduleType==='cron'?`${field('scheduleCron','Cron expression')}${field('scheduleZone','IANA time zone')}<p class="muted">Five numeric fields: minute hour day month weekday. Use *, comma lists, ranges, or */step and range/step; no names, macros, or seconds. Minimum spacing is five minutes. When both day fields are restricted, either may match. The backend rejects impossible schedules and calendar gaps longer than 366 days.</p>`:''}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>${pulse?'Review plan and schedule…':draft.scheduleType==='events'?'Review trigger…':'Review schedule…'}</button>${S.scheduleDraftVersion!==p.current_version?'<p class="notice">This draft began on an older job version. Reset it to the current schedule before proposing.</p>':''}<div class="actions">${button('reset-schedule','Reset to current schedule',S.busy||!usable())}</div></form>${pulse?capabilityMarkup():''}${savedProposalsMarkup()}`;
}
function specialistDraft(){const roles=SPECIALIST_ROLES.filter(role=>draft['specialist'+role[0].toUpperCase()+role.slice(1)]);if(!roles.length)return undefined;if(S.apiVersion<15)throw Error('Update the computer to Pips API 15 before reviewing specialists.');return specialistGrant({roles,max_calls:Number(draft.specialistCalls)});}
function specialistFormMarkup(){if(S.apiVersion<15)return '<p class="muted">Optional specialist calls require Pips API 15.</p>';return `<details data-details="specialist-grant"><summary>Optional specialists</summary><p class="muted">Off by default. Select only the builtin roles this one Patch run may call.</p>${SPECIALIST_ROLES.map(role=>{const key='specialist'+role[0].toUpperCase()+role.slice(1);return `<label class="check-field"><input type="checkbox" id="${key}" data-draft="${key}"${draft[key]?' checked':''}> ${role[0].toUpperCase()+role.slice(1)} · ${role==='worker'?'same reviewed write paths':'read only'}</label>`;}).join('')}<label for="specialistCalls">Total specialist calls</label><select id="specialistCalls" data-draft="specialistCalls">${[1,2,3].map(n=>`<option value="${n}"${String(n)===draft.specialistCalls?' selected':''}>${n}</option>`).join('')}</select><p class="muted">Synchronous calls share the parent’s pinned model, private source, 12 request reservations, 64 tool calls and 300-second deadline. No background work, nesting, shell, network, custom agents or model changes. Test commands stay separately reviewed.</p></details>`;}
function specialistGrantMarkup(grant){if(grant===undefined)return '';const g=specialistGrant(grant);return `<section class="section" aria-label="Reviewed specialists"><h3>Specialist permission</h3><p>${esc(g.roles.map(r=>r[0].toUpperCase()+r.slice(1)).join(', '))} · at most ${g.max_calls} total calls</p><p class="muted">Explorer and Critic read only. Worker can edit only the same exact reviewed paths. All use this run’s model and private copy, with shared limits of 12 request reservations, 64 tools and 300 seconds; at most 4,096 output tokens allocated per request. No nested, background, command, network or custom-agent access.</p>${S.apiVersion<15?'<p class="notice error">Update the computer to Pips API 15 before approving this specialist grant.</p>':''}</section>`;}
function specialistReceiptMarkup(v){if(!v)return '';return `<section class="section" aria-label="Specialist receipts"><h3>Specialist assessments</h3><p class="notice">Specialist prose is a model assessment, not verified findings or test evidence. The controller’s exact test invocations are recorded separately below.</p><dl class="meta"><dt>Specialist calls</dt><dd>${v.calls.length}</dd><dt>Reserved request slots</dt><dd>${v.requests}</dd><dt>Model calls</dt><dd>${v.model_calls}</dd><dt>Transport attempts</dt><dd>${v.transport_attempts}</dd><dt>Reserved output tokens</dt><dd>${v.output_token_reservations.toLocaleString()} · allocation, not measured usage</dd><dt>Whole-run tool calls</dt><dd>${v.tool_calls}</dd></dl>${v.calls.map(c=>`<article class="entry"><h3>${esc(c.role)} · ${esc(c.status)}</h3><p class="goal">${esc(c.summary||'No assessment text recorded.')}</p><dl class="meta"><dt>Pinned model</dt><dd>${esc(c.model)}</dd><dt>Reserved requests / model calls / transports</dt><dd>${c.requests} / ${c.model_calls} / ${c.transport_attempts}</dd><dt>Tools</dt><dd>${c.tool_calls}</dd><dt>Reported input / output tokens</dt><dd>${c.usage.input_tokens.toLocaleString()} / ${c.usage.output_tokens.toLocaleString()}</dd><dt>Reported cached / reasoning tokens</dt><dd>${c.usage.cached_input_tokens.toLocaleString()} / ${c.usage.reasoning_tokens.toLocaleString()}</dd><dt>Reported usage requests</dt><dd>${c.usage.requests}</dd></dl></article>`).join('')||'<p class="muted">No specialist calls were recorded.</p>'}<details><summary>Saved policy identity</summary><p class="mono">${esc(v.policy_digest)}</p></details></section>`;}

function actionMarkup(action) {
  if(action.kind==='read_only')return '<p class="notice">Read-only source inspection. This approval grants no file changes or test execution.</p>';
  return `<p class="notice">One reviewed execution · Network off · User working tree unchanged</p>${action.kind==='patch'?`<h3>Allowed file changes</h3><pre>${esc(action.write_paths.join('\n'))}</pre><p class="muted">Exact filenames in an independent private copy. No merge or application to your working tree.</p>`:''}${specialistGrantMarkup(action.specialists)}<h3>Exact test commands (${action.tests.length})</h3>${action.tests.map((test,i)=>`<article class="entry"><h3>Command ${i+1}</h3><pre>${esc(JSON.stringify(test.argv,null,2))}</pre><p class="mono">Working directory: ${esc(test.cwd)}</p></article>`).join('')||'<p class="muted">No test commands approved.</p>'}<p class="muted">Tests read the prepared source copy and may write only private scratch. No network access or commands beyond the exact reviewed argv are authorized.</p>${executionLimitsMarkup()}`;
}
// macOS (Seatbelt) has no per-process address-space limit or process namespace: memory, process
// count and scratch are sampled there, and the policy view says so rather than reuse Linux wording.
function seatbeltRunner(){return S.executionCapability?.available===true&&S.executionCapability.backend==='seatbelt';}
function executionLimitsMarkup(){
  return seatbeltRunner()?'<dl class="meta"><dt>Wall limit per command</dt><dd>60 seconds</dd><dt>CPU limit per process</dt><dd>30 seconds</dd><dt>Memory, all processes (sampled)</dt><dd>512 MiB</dd><dt>Output limit</dt><dd>64 KiB</dd><dt>Process limit (sampled)</dt><dd>32</dd></dl><p class="muted">This macOS runner has no per-process address-space limit or process namespace. It samples memory, process count and the 64 MiB private scratch about every 50 ms, so a spike can exceed them between samples.</p>':'<dl class="meta"><dt>Wall limit per command</dt><dd>60 seconds</dd><dt>CPU limit per process</dt><dd>30 seconds</dd><dt>Address-space limit per process</dt><dd>512 MiB</dd><dt>Output limit</dt><dd>64 KiB</dd><dt>Process limit</dt><dd>32</dd></dl><p class="muted">The parent also samples aggregate resident memory; a spike can occur between samples. Private scratch is limited to 64 MiB.</p>';
}
function capabilityMarkup(){
  const c=S.executionCapability;
  return `<section class="section" aria-label="Execution isolation"><h3>Local execution support</h3>${S.executionLoading?'<p role="status">Checking sandbox support…</p>':c?`<p class="${c.available?'muted':'notice error'}">${c.available?'Isolated execution is available.':esc(c.reason||'Isolated execution is unavailable on this runner.')}</p><p class="muted">${esc(c.platform)}${c.backend?' · '+esc(c.backend):''} · Network off · Test source read-only</p>${c.available&&c.limitations?.length?`<p>Weaker guarantees on this runner:</p><ul>${c.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}`:'<p class="muted">Execution support has not been verified.</p>'}${errorMarkup(S.executionError)}${button('check-execution','Check execution support',S.executionLoading||!usable())}</section>`;
}
async function loadExecution(){
  if(S.executionLoading||!usable())return;const epoch=S.epoch;S.executionLoading=true;S.executionError='';render();
  try{const c=await send('get_pip_execution');if(epoch!==S.epoch)return;
    if(!record(c)||typeof c.available!=='boolean'||typeof c.platform!=='string'||![null,'bwrap','seatbelt'].includes(c.backend)||!(c.reason===null||typeof c.reason==='string')||c.network!==false||c.test_workspace!=='read_only'||!(c.limitations===undefined||Array.isArray(c.limitations)&&c.limitations.length<=12&&c.limitations.every(x=>typeof x==='string'&&x.length>0&&x.length<=1000))||(c.backend==='seatbelt'&&!c.limitations?.length)||!record(c.limits)||Object.entries({wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32}).some(([key,v])=>c.limits[key]!==v))throw new Error('The runner returned an unsupported execution policy.');
    S.executionCapability=c;
  }catch(error){if(epoch===S.epoch){S.executionCapability=null;S.executionError=errorText(error);}}
  finally{if(epoch===S.epoch){S.executionLoading=false;render();if(S.review)renderReview();}}
}
function personalHandoffForm(d,targets,target){
 return `<form id="handoff-form" class="section form"><h2>Share a result with another Pip</h2><p class="muted">From ${esc(d.sourceName)}. Select exactly what to share. Other messages, accounts and permissions stay private.</p>${field('handoffText','Result excerpt to share',true)}<p class="muted">Use an exact excerpt of the saved result, up to 12,000 UTF-8 bytes. Nothing is silently shortened.</p><label for="handoffTarget">Recipient Pip</label><select id="handoffTarget" data-draft="handoffTarget"><option value="">Choose a Personal Pip</option>${targets.map(p=>`<option value="${esc(p.id)}"${p.id===draft.handoffTarget?' selected':''}>${esc(p.name)}${p.status==='paused'?' · paused':''}</option>`).join('')}</select>${targets.length?'':'<p>Create another Personal Pip before sharing this result.</p>'}${field('handoffTask','What should the recipient do?',true)}<p class="muted">The recipient uses its own model and reviewed app-read permissions. No messages are sent and no files are changed. Saving prepares a review; approving it starts one run.</p><div class="actions"><button type="submit"${S.busy||!usable()||!target?' disabled':''}>Save for review</button>${button('cancel-handoff-draft','Cancel',S.busy)}</div></form>`;
}
function reviewPersonalHandoff(h,reject){
 const p=h.payload,pending=h.status==='pending';draft.findingReviewReason='';
 openReview({title:reject?'Reject this handoff?':pending?'Share with '+p.target.name+'?':'Saved Personal handoff',description:'Only the excerpt below is shared. Approval queues one run; it does not change either Pip’s job or grant permissions.',body:`<h3>Shared result</h3><pre>${esc(p.source.text)}</pre><h3>Task for ${esc(p.target.name)}</h3><p>${esc(p.task)}</p><dl class="meta"><dt>Recipient model</dt><dd>${esc(p.target.model)}</dd><dt>Source result</dt><dd>${esc(p.source.run_id)}</dd><dt>Job versions</dt><dd>Source ${p.source.job_version} · Recipient ${p.target.job_version}</dd><dt>Expires</dt><dd>${esc(date(h.expires_at))}</dd><dt>Status</dt><dd>${esc(h.status)}</dd></dl><h3>Recipient’s existing app access</h3>${p.target.app_plan?`<pre>${esc(JSON.stringify(p.target.app_plan.calls,null,2))}</pre><p class="muted">Uses ${esc(p.target.app_plan.server)}. These existing reads may run for this task.</p>`:'<p>No connected-app reads.</p>'}<p class="muted">No project files, browser, shell, sends or purchases. The shared result is model-authored reference text, not instructions that can add permissions.</p><details><summary>Saved identity</summary><pre>${esc(h.payload_digest)}</pre></details>`,confirm:reject?'Reject handoff':'Approve and queue',reasonRequired:reject,note:'Note (optional)',autoReason:'Rejected in the Pips view.',readOnly:!pending,expiresAt:h.expires_at,blocked:!pending||S.apiVersion<30||remoteHost,request:{type:reject?'reject_pip_handoff':'accept_pip_handoff',handoff_id:h.id,expected_revision:h.revision}});
}
function submitPersonalHandoff(saved,target){
 const text=draft.handoffText,task=draft.handoffTask.trim();
 if(S.apiVersion<30||remoteHost||!personalPip()||!target||!personalPip(target)||target.status==='archived'||!text||new TextEncoder().encode(text).length>12000||!saved.text.includes(text)||!task||new TextEncoder().encode(task).length>4000){setError('Choose another Personal Pip, an exact result excerpt (up to 12,000 bytes), and a task (up to 4,000 bytes).');return;}
 const request={type:'propose_pip_personal_handoff',source_run_id:saved.runId,target_pip_id:target.id,shared_text:text,task},signature=JSON.stringify(request);
 if(saved.signature!==signature){saved.signature=signature;saved.key='editor-handoff-'+globalThis.crypto.randomUUID();}
 void mutate({...request,idempotency_key:saved.key},result=>{const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.payload.type!=='personal_result.v1'||h.source_run_id!==saved.runId||h.target_pip_id!==target.id||h.payload.source.text!==text||h.payload.task!==task)throw Error('The saved handoff does not match your selection.');S.handoffDraft=null;S.notice='Handoff saved for review. Nothing has started.';reviewHandoff(h);void loadHandoffs();});
}
function handoffsMarkup(){
  const d=archived()?null:S.handoffDraft,targets=S.jobs.filter(p=>p.status!=='archived'&&p.id!==S.selected&&(personalPip()?personalPip(p):committedJob(p)&&!documentationPip(p))&&pipType(p,S.types)?.available&&(!d?.artifact||p.pip_type==='pulse')),target=targets.find(p=>p.id===draft.handoffTarget),kind=target?.pip_type==='patch'?'patch':target?.pip_type==='pulse'?'test':'read_only';
  const form=d?.personal?personalHandoffForm(d,targets,target):d?`<form id="handoff-form" class="section form"><h2>${d.artifact?'Prepare a Patch artifact handoff':'Prepare a finding handoff'}</h2><p class="muted">From ${esc(d.sourceName)} · run ${esc(d.runId)}${d.artifact?'':` · finding ${d.index+1}`}</p>${d.artifact?artifactSourceMarkup(d.artifact):`<h3>${esc(d.finding.title)}</h3><p class="mono">${esc(d.finding.path)}:${d.finding.line}</p><pre>${esc(d.finding.evidence)}</pre>`}<label for="handoffTarget">Recipient Pip</label><select id="handoffTarget" data-draft="handoffTarget"><option value="">Choose a Pip</option>${targets.map(p=>`<option value="${esc(p.id)}"${p.id===draft.handoffTarget?' selected':''}>${esc(p.name)} · ${esc(pipType(p,S.types).name)}${p.status==='paused'?' · paused':''}</option>`).join('')}</select>${targets.length?'':'<p class="notice">Create another compatible Pip in this workspace before preparing a handoff.</p>'}${field('handoffTask','Task for the recipient',true)}${kind==='patch'?`${field('handoffPaths','Allowed file paths, one per line',true)}<p class="muted">Exact relative filenames only, at most 32. No directories or wildcards. Changes stay in a private copy.</p>`:''}${kind==='patch'?specialistFormMarkup():''}${kind!=='read_only'?`${field('handoffTests','Tests: JSON array of argv and cwd',true)}<p class="muted">Example: [{"argv":["python3","-m","unittest"],"cwd":"."}]. No shell parsing. At most four commands; Pulse needs at least one. Each command is reviewed exactly as entered.</p>${capabilityMarkup()}`:'<p class="muted">The recipient uses its read-only source policy. No files are edited and no tests are run.</p>'}<p class="muted">Saving creates a durable review. It does not start work or change the source review. You will review the pinned source, target, model and exact permissions next.</p><div class="actions"><button type="submit"${S.busy||!usable()||!target?' disabled':''}>Save for review</button>${button('cancel-handoff-draft','Cancel draft',S.busy)}</div></form>`:'';
  return `${form}<section class="section" aria-label="Handoff history"><div class="section-head"><h2>Handoffs</h2>${button('load-handoffs',S.handoffsLoading?'Loading…':S.handoffsLoaded?'Refresh handoffs':'Load handoffs',S.handoffsLoading||!usable())}</div><p class="muted">Incoming and outgoing handoffs for this Pip. Saved reviews survive closing the editor and expire after seven days. Acceptance authorizes one pinned run.</p>${errorMarkup(S.handoffsError)}${S.handoffs.map(h=>`<article class="entry"><h3>${esc(handoffTitle(h.payload))}</h3><p>${esc(h.source_pip_id===S.selected?'To '+h.payload.target.name:'From '+pipName(h.source_pip_id))} · ${esc(h.status)}${h.run_status?' · '+esc(h.run_status):''}</p><p class="goal">${esc(h.payload.task)}</p><p class="muted">Requested ${esc(requester(h.requested_by))} · Expires ${esc(date(h.expires_at))}</p><div class="actions"><button type="button" data-handoff="${esc(h.id)}">${h.status==='pending'?'Review handoff…':'View handoff'}</button>${h.status==='pending'?`<button type="button" data-reject-handoff="${esc(h.id)}">Reject…</button>`:''}${h.run_id?`<button type="button" data-lineage-pip="${esc(h.target_pip_id)}" data-lineage-run="${esc(h.run_id)}">Open recipient run</button>`:''}</div></article>`).join('')||(S.handoffsLoaded?`<p class="muted">No saved handoffs for this Pip. ${personalPip()?'Share a result from a completed task to hand it to another Pip.':'Start from a finding in a completed source report.'}</p>`:'')}${S.handoffCursor&&S.handoffs.length<200?button('more-handoffs','Older handoffs',S.handoffsLoading||!usable()):''}${S.handoffs.length>=200?'<p class="muted">Showing 200 handoffs. Use the local CLI for older records.</p>':''}</section>`;
}
// Handoff rows name Pips and requesters the way people know them, never by stored ID.
function pipName(id){return S.jobs.find(p=>p.id===id)?.name||'another Pip';}
function requester(actor){const a=String(actor||'');return a==='editor-user'?'by you in the editor':a==='local-console'?'by you in the terminal':a.startsWith('main-')?'from the main chat':a.startsWith('core')?'by Core':'by another DGC surface';}
async function loadHandoffs(more=false){
  if(!usable()||!S.selected||S.handoffsLoading||(more&&(!S.handoffCursor||S.handoffs.length>=200)))return;
  const token=scope(),sequence=++handoffSeq,before=more?S.handoffCursor:null;S.handoffsLoading=true;S.handoffsError='';render();
  try{const page=handoffsPage(await send('list_pip_handoffs',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||sequence!==handoffSeq)return;
    if(more&&(page.next_before_id===before||page.handoffs.some(h=>S.handoffs.some(old=>old.id===h.id))))throw new Error('Handoff history did not advance. Refresh before retrying.');
    S.handoffs=more?[...S.handoffs,...page.handoffs]:page.handoffs;S.handoffCursor=page.next_before_id;S.handoffsLoaded=true;
  }catch(error){if(token===scope()&&sequence===handoffSeq)S.handoffsError=errorText(error);}
  finally{if(token===scope()&&sequence===handoffSeq){S.handoffsLoading=false;render();}}
}
function reviewHandoff(h,reject=false){
  if(h.payload.type==='personal_result.v1'){reviewPersonalHandoff(h,reject);return;}
  const p=h.payload,privileged=p.action.kind!=='read_only',pending=h.status==='pending';
  draft.findingReviewReason='';
  openReview({title:reject?'Reject this handoff?':pending?'Approve this handoff?':'Saved handoff',description:reject?'Rejecting this saved handoff queues no work. The original source review stays unchanged.':pending?'Approval queues one run with the exact saved source, recipient and permissions below. It grants no standing permission and does not change the recipient’s job.':'This is the recorded handoff envelope and resolution.',body:`${p.type==='patch_artifact.v1'?artifactSourceMarkup(p.source):`<h3>${esc(handoffTitle(p))}</h3><p class="mono">${esc(p.source.path)}:${p.source.line}</p><pre>${esc(p.source.evidence)}</pre>`}<dl class="meta"><dt>Source Pip / run</dt><dd>${esc(h.source_pip_id)} / ${esc(h.source_run_id)}</dd><dt>Source commit</dt><dd class="mono">${esc(p.source.source_revision)}</dd><dt>Source assessment</dt><dd>${esc(p.source.review_status)} · review v${p.source.review_revision}</dd><dt>Recipient</dt><dd>${esc(p.target.name)} · ${esc(p.target.pip_type)} · job v${p.target.job_version}</dd><dt>Recipient model</dt><dd>${esc(p.target.model)}</dd><dt>Recipient ref</dt><dd>${esc(p.target.source_ref)}</dd><dt>Requested by</dt><dd>${esc(h.requested_by)}</dd><dt>Expires</dt><dd>${esc(date(h.expires_at))}</dd><dt>Status</dt><dd>${esc(h.status)}</dd>${h.resolved_by?`<dt>Resolved by</dt><dd>${esc(h.resolved_by)} · ${esc(date(h.resolved_at))}</dd>`:''}</dl><h3>Approved task</h3><p class="goal">${esc(p.task)}</p>${actionMarkup(p.action)}${privileged?capabilityMarkup():''}<details><summary>Payload identity</summary><p class="mono">${esc(h.payload_digest)}</p><p class="mono">Action ${esc(p.action_digest)}</p></details>${h.resolution_reason?`<p class="muted">${esc(h.resolution_reason)}</p>`:''}`,confirm:reject?'Reject handoff':'Approve and queue',reasonRequired:reject,note:'Note (optional)',autoReason:'Rejected in the Pips view.',readOnly:!pending,expiresAt:h.expires_at,blocked:!pending,requiresExecution:!reject&&privileged,requiresSpecialists:!reject&&!!p.action.specialists,request:{type:reject?'reject_pip_handoff':'accept_pip_handoff',handoff_id:h.id,expected_revision:h.revision}});
}
async function openSavedHandoff(id,reject=false){
  const token=scope(),sequence=++handoffDetailSeq;
  try{const result=await send('get_pip_handoff',{handoff_id:id});if(token!==scope()||sequence!==handoffDetailSeq)return;
    const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.id!==id)throw new Error('The handoff response did not match the requested review.');
    if(['patch','test'].includes(h.payload.action.kind)&&!reject)await loadExecution();
    if(token===scope()&&sequence===handoffDetailSeq)reviewHandoff(h,reject);
  }catch(error){if(token===scope()&&sequence===handoffDetailSeq)setError(error);}
}
async function openLineage(pip,run){
  if(!S.jobs.some(p=>p.id===pip)){setError('The linked Pip is not available in this workspace.');return;}
  const selecting=select(pip),token=scope();await selecting;if(token!==scope()||S.selected!==pip)return;S.tab='runs';rememberView();await loadRun(run);
}
function savedProposalsMarkup() {
  const p=S.pip;
  return `<section class="section"><h2>Saved proposals</h2><p class="muted">Saved reviews survive closing the editor. Pending reviews expire after seven days; accepting a newer version supersedes older proposals. ${pulsePip(p)?'Review exact standing command permissions and calendar changes before accepting.':'Tool permissions are unchanged.'}</p>${p.proposals?.length?p.proposals.map(v=>`<article class="proposal"><h3>Proposed from v${esc(v.expected_version)}</h3><p class="goal">${esc(v.definition?.goal)}</p><p>${esc(scheduleLabel(v.definition?.schedule))}</p>${v.definition?.event_trigger?`<p>${esc(eventTriggerLabel(v.definition.event_trigger))}</p>`:''}<p class="muted">${esc(v.reason||'No reason provided.')}</p><p class="muted">Requested by ${esc(v.actor||'Not recorded')} · ${esc(approvalStatus(v.approval_status||'pending'))}${v.expires_at?` · Expires ${esc(date(v.expires_at))}`:' · Expiry not recorded'}</p><div class="actions"><button type="button" data-proposal="${esc(v.id)}"${S.busy||!usable()?' disabled':''}>Review proposal…</button><button type="button" data-reject="${esc(v.id)}"${S.busy||!usable()?' disabled':''}>Dismiss…</button></div></article>`).join(''):'<p class="muted">No saved proposals.</p>'}</section>`;
}
function approvalsMarkup() {
  const capped=S.approvals.length>=200;
  return `<section class="section" aria-label="Review history"><div class="section-head"><h2>Review history</h2>${button('load-approvals',S.approvalsLoading?'Loading…':S.approvalsLoaded?'Refresh reviews':'Load reviews',S.busy||!usable()||S.approvalsLoading)}</div><p class="muted">Durable decisions about jobs and schedules. An accepted Pulse plan authorizes only its exact reviewed checks.</p>${errorMarkup(S.approvalsError)}${S.approvals.map(a=>`<article class="approval"><span class="badge">${esc(approvalStatus(a.status))}</span><h3>${esc(a.action_summary)}</h3><p class="muted">${a.expected_version===0?'Creation · first job version':(a.action_type==='schedule_update'?'Schedule change':'Job change')+' · based on v'+a.expected_version}</p><dl class="meta"><dt>Requested by</dt><dd>${esc(a.requested_by)}</dd><dt>Created</dt><dd>${esc(date(a.created_at))}</dd><dt>Expires</dt><dd>${esc(date(a.expires_at))}</dd>${a.resolved_at?`<dt>Resolved</dt><dd>${esc(date(a.resolved_at))}</dd><dt>Resolved by</dt><dd>${esc(a.resolved_by||'Not recorded')}</dd>`:''}</dl>${a.status==='pending'&&S.pip?.proposals?.some(p=>p.id===a.proposal_id)?`<button type="button" data-proposal="${esc(a.proposal_id)}"${S.busy||!usable()?' disabled':''}>Review proposal…</button>`:''}</article>`).join('')|| (S.approvalsLoaded?'<p class="muted">No saved reviews for this Pip.</p>':'')}${S.approvalCursor&&!capped?button('more-approvals','Older reviews',S.busy||!usable()||S.approvalsLoading):''}${capped?'<p class="notice">Showing up to 200 reviews. Use the local CLI to inspect older records.</p>':''}</section>`;
}
async function loadApprovals(more=false) {
  if(!S.pip||!usable()||S.approvalsLoading||(more&&(!S.approvalCursor||S.approvals.length>=200)))return;
  const token=scope(),sequence=++approvalSeq,prior=more?S.approvalCursor:null;
  S.approvalsLoading=true;S.approvalsError='';render();
  try {
    const result=await send('list_pip_approvals',{pip_id:S.selected,limit:20,...(prior?{before_id:prior}:{})});
    if(token!==scope()||sequence!==approvalSeq)return;
    const page=approvalsPage(result,S.selected);
    if(prior&&page.next_before_id===prior)throw new Error('Review history did not advance. Refresh reviews before retrying.');
    if(more&&page.approvals.some(a=>S.approvals.some(p=>p.id===a.id)))throw new Error('Review history repeated an entry. Refresh reviews before retrying.');
    S.approvals=more?[...S.approvals,...page.approvals]:page.approvals;S.approvalCursor=page.next_before_id;S.approvalsLoaded=true;
  }catch(error){if(token===scope()&&sequence===approvalSeq)S.approvalsError=errorText(error);}
  finally{if(token===scope()&&sequence===approvalSeq){S.approvalsLoading=false;render();}}
}
function revisionsMarkup() {
  const p=S.pip;
  return `${archived()?'<section class="section"><h2>Archived job reviews</h2><p class="muted">Restore to paused before changing the job.</p></section>':`${savedProposalsMarkup()}<form id="revision-form" class="section form"><h2>Change what it does</h2>${field('revisionGoal','What should it do?',true)}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>Save</button></form>`}<section class="section"><div class="section-head"><h2>Version history</h2>${button('load-history',S.historyLoaded?'Refresh history':'Load history',S.busy||!usable())}</div>${S.versions.map(v=>`<article class="version"><h3>Version ${esc(v.version)} <span class="muted">· ${esc(date(v.created_at))}</span></h3><p class="goal">${esc(v.definition?.goal)}</p><p class="muted">${esc(v.reason)} · ${esc(v.actor)}</p><small>Source ref ${esc(v.definition?.source_ref)} · ${esc(scheduleLabel(v.definition?.schedule))}</small></article>`).join('')}${S.cursor!==null?button('more-history','Older versions',S.busy||!usable()):''}</section>${approvalsMarkup()}`;
}

function resetOutcomes(){resetCommandReceipts();notificationSeq++;notifications=null;notificationItems=[];notificationLoading=false;notificationError='';notificationMark='';outcomeSessionSeq++;outcomeSeq++;outcomeInspectSeq++;outcomeReviewSeq++;outcomeSessions=[];outcomeSessionsCursor='';outcomeSessionsMore=false;outcomeSessionsLoaded=false;outcomeSessionsLoading=false;outcomeSessionsError='';outcomeHistory=[];outcomeCursor=null;outcomeLoaded=false;outcomeLoading=false;outcomeError='';outcomeInspection=null;outcomeInspecting=false;outcomeRetry=null;draft.outcomeSession='';draft.outcomeTitle='';draft.outcomeText='';draft.outcomeSourceKind='commit';draft.outcomeSourceValue='';}
function sessionStatementDetails(p,digest){return `<details><summary>Statement reference and identity</summary><dl class="meta"><dt>Session</dt><dd class="mono">${esc(p.session.id)}</dd><dt>Session revision</dt><dd>${p.session.revision}</dd><dt>Session SHA-256</dt><dd class="mono">${esc(p.session.sha256)}</dd><dt>Transcript bytes hashed</dt><dd>${p.session.bytes}</dd><dt>Statement SHA-256</dt><dd class="mono">${esc(digest)}</dd><dt>Selected reference</dt><dd class="mono">${esc(p.source_reference.selection.kind==='pip_run'?p.source_reference.selection.run_id:p.source_reference.selection.revision)}</dd>${pinnedSourceMarkup(p.source_reference)}</dl>${pinnedSourceNotice(p.source_reference)}<p class="muted">The computer hashes the saved session locally. No transcript text is included in this statement. The source is a reference selected by the user, not evidence that a command used it.</p></details>`;}
function outcomesMarkup(){
 if(S.apiVersion<12)return '<section class="section"><h3>Reviewed session statements</h3><p class="muted">Update the computer to Pips API 12 to record a reviewed statement from a saved session. Existing context remains readable.</p></section>';
 const inspected=outcomeInspection?.id===draft.outcomeSession?outcomeInspection:null;
 return `<section class="section" aria-label="Session statement history"><div class="section-head"><h3>Reviewed session statements</h3>${button('load-outcomes',outcomeLoading?'Loading…':'Refresh statements',!usable()||outcomeLoading)}</div><p class="muted">Saved authored claims, not verified execution receipts. Recording one never starts a Pip or changes permissions.</p>${errorMarkup(outcomeError)}${outcomeHistory.map(p=>`<article class="entry"><span class="badge">${esc(p.status)}</span><h4>${esc(p.title)}</h4><p class="muted">Session ${esc(p.session.id)} · revision ${p.session.revision} · ${esc(date(p.created_at))}</p><div class="actions"><button type="button" data-outcome="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>${p.status==='pending'?'Review statement…':'View statement'}</button>${p.status==='pending'?`<button type="button" data-reject-outcome="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>Reject statement…</button>`:''}</div></article>`).join('')}${outcomeLoaded&&!outcomeHistory.length?'<p class="muted">No saved session statements.</p>':''}${outcomeCursor&&outcomeHistory.length<100?button('more-outcomes','Older statements',outcomeLoading||!usable()):''}${outcomeCursor&&outcomeHistory.length>=100?'<p class="muted">Showing 100 statements. Use the local CLI to inspect older records.</p>':''}</section><form id="outcome-form" class="section form"><h3>Record a session statement</h3><p class="notice">You write the statement. DGC does not reconstruct tests or treat model replies as evidence. Review the exact saved text before adding it to future workspace context.</p><label for="outcomeSession">Saved workspace session</label><select id="outcomeSession" data-draft="outcomeSession"><option value="">Choose a saved session</option>${outcomeSessions.map(row=>`<option value="${esc(row.session_id)}"${row.session_id===draft.outcomeSession?' selected':''}>${esc(row.session_id)} · ${esc(date(row.updated_at))}</option>`).join('')}</select><div class="actions">${button('load-outcome-sessions',outcomeSessionsLoading?'Loading…':'Refresh sessions',!usable()||outcomeSessionsLoading)}${outcomeSessionsMore&&outcomeSessions.length<100?button('more-outcome-sessions','More sessions',!usable()||outcomeSessionsLoading):''}${button('inspect-outcome-session',outcomeInspecting?'Inspecting…':'Inspect saved session',!usable()||S.busy||outcomeInspecting||!draft.outcomeSession)}</div>${errorMarkup(outcomeSessionsError)}${outcomeSessionsLoaded&&!outcomeSessions.length?'<p class="muted">No saved session identity is associated with this workspace. Save a normal DGC session on this computer first.</p>':''}${outcomeSessionsMore&&outcomeSessions.length>=100?'<p class="muted">Showing 100 session identities. Use the local CLI for older identities.</p>':''}${inspected?`<p class="muted">Inspected revision ${inspected.revision} · ${inspected.bytes} bytes. Transcript text stays on the computer. Changed or missing session files must be inspected again.</p>`:''}<label for="outcomeSourceKind">Reference selected for this statement</label><select id="outcomeSourceKind" data-draft="outcomeSourceKind"><option value="commit"${draft.outcomeSourceKind==='commit'?' selected':''}>Exact Git commit</option><option value="pip_run"${draft.outcomeSourceKind==='pip_run'?' selected':''}>Completed Pip run</option></select>${field('outcomeSourceValue',draft.outcomeSourceKind==='commit'?'Full commit hash':'Completed run ID')}${draft.outcomeSourceKind==='pip_run'&&S.run?.status==='succeeded'?button('use-outcome-run','Use selected completed run',S.busy):''}${field('outcomeTitle','Statement title')}${field('outcomeText','Your statement',true)}<p class="muted">Title: 240 UTF-8 bytes. Statement: 1,536 UTF-8 bytes. The selected reference does not attest that this session executed against it.</p><button type="submit"${S.busy||!usable()||!S.context||!inspected?' disabled':''}>Save for review…</button></form>`;
}
async function loadOutcomeSessions(more=false){
 if(S.apiVersion<12||!usable()||outcomeSessionsLoading||more&&(!outcomeSessionsMore||outcomeSessions.length>=100))return;const token=scope(),sequence=++outcomeSessionSeq,after=more?outcomeSessionsCursor:'';outcomeSessionsLoading=true;outcomeSessionsError='';render();
 try{const page=workspaceSessionsPage(await send('list_workspace_sessions',{workspace_id:S.workspace.id,limit:20,...(after?{after}:{})}),S.workspace.id,after);if(token!==scope()||sequence!==outcomeSessionSeq)return;outcomeSessions=more?[...outcomeSessions,...page.sessions]:page.sessions;outcomeSessionsCursor=page.next_cursor;outcomeSessionsMore=page.has_more;outcomeSessionsLoaded=true;if(draft.outcomeSession&&!outcomeSessions.some(r=>r.session_id===draft.outcomeSession)){draft.outcomeSession='';outcomeInspection=null;}}
 catch(error){if(token===scope()&&sequence===outcomeSessionSeq)outcomeSessionsError=errorText(error);}finally{if(token===scope()&&sequence===outcomeSessionSeq){outcomeSessionsLoading=false;render();}}
}
async function inspectOutcomeSession(){
 if(S.apiVersion<12||!usable()||outcomeInspecting||!outcomeSessions.some(row=>row.session_id===draft.outcomeSession))return;const token=scope(),sequence=++outcomeInspectSeq,id=draft.outcomeSession;outcomeInspecting=true;outcomeInspection=null;outcomeSessionsError='';render();
 try{const answer=await send('inspect_workspace_session_outcome',{workspace_id:S.workspace.id,session_id:id});if(token!==scope()||sequence!==outcomeInspectSeq||id!==draft.outcomeSession)return;if(answer.workspace_id!==S.workspace.id)throw Error('The session belongs to another workspace.');const inspected=sessionGeneration(answer.session);if(inspected.id!==id)throw Error('The inspected session identity changed.');outcomeInspection=inspected;}
 catch(error){if(token===scope()&&sequence===outcomeInspectSeq)outcomeSessionsError=errorText(error);}finally{if(token===scope()&&sequence===outcomeInspectSeq){outcomeInspecting=false;render();}}
}
async function loadOutcomes(more=false){
 if(S.apiVersion<12||!usable()||outcomeLoading||more&&(!outcomeCursor||outcomeHistory.length>=100))return;const token=scope(),sequence=++outcomeSeq,before=more?outcomeCursor:null;outcomeLoading=true;outcomeError='';render();
 try{const page=sessionStatementsPage(await send('list_workspace_session_outcomes',{workspace_id:S.workspace.id,limit:20,...(before?{before_id:before}:{})}),S.workspace.id);if(token!==scope()||sequence!==outcomeSeq)return;if(more&&(page.next_before_id!==null&&page.next_before_id>=before||page.proposals.some(p=>outcomeHistory.some(old=>old.id===p.id))))throw Error('Statement history did not advance. Refresh before retrying.');outcomeHistory=more?[...outcomeHistory,...page.proposals]:page.proposals;outcomeCursor=page.next_before_id;outcomeLoaded=true;}
 catch(error){if(token===scope()&&sequence===outcomeSeq)outcomeError=errorText(error);}finally{if(token===scope()&&sequence===outcomeSeq){outcomeLoading=false;render();}}
}
function reviewOutcome(p,reject=false){
 sessionStatement(p,S.workspace.id);const pending=p.status==='pending';openReview({title:reject?'Reject this session statement?':pending?'Record this reviewed statement?':'Saved session statement',readOnly:!pending,blocked:!pending||!S.context,description:SESSION_STATEMENT_NOTICE.trim(),body:`<h3>${esc(p.title)}</h3><p class="goal">${esc(p.statement)}</p><dl class="meta"><dt>Saved by</dt><dd>${esc(p.created_by)}</dd><dt>Status</dt><dd>${esc(p.status)}</dd><dt>Session revision</dt><dd>${p.session.revision}</dd><dt>Statement SHA-256</dt><dd class="mono">${esc(p.digest)}</dd><dt>Workspace context</dt><dd>v${S.context?.revision??'Unavailable'}</dd></dl>${sessionStatementDetails(p,p.digest)}<p class="muted">${reject?'Rejecting adds nothing to context and dispatches no work.':'The computer rechecks the saved session, source reference, proposal digest and context revision. If any has changed, inspect and prepare a new statement.'}</p>`,confirm:reject?'Reject statement':'Record reviewed statement',request:{type:reject?'reject_workspace_session_outcome':'accept_workspace_session_outcome',workspace_id:S.workspace.id,proposal_id:p.id,expected_digest:p.digest,...(reject?{}:{expected_context_revision:S.context?.revision})}});
}
async function openOutcome(id,reject=false){
 if(S.apiVersion<12||!usable()||S.busy)return;const token=scope(),sequence=++outcomeReviewSeq;
 try{const answer=await send('get_workspace_session_outcome',{workspace_id:S.workspace.id,proposal_id:id});if(token!==scope()||sequence!==outcomeReviewSeq)return;if(answer.workspace_id!==S.workspace.id)throw Error('The saved statement belongs to another workspace.');const p=sessionStatement(answer.proposal,S.workspace.id);if(p.id!==id)throw Error('The saved statement identity changed.');reviewOutcome(p,reject);}catch(error){if(token===scope()&&sequence===outcomeReviewSeq)setError(error);}
}

function memorySourceMarkup(source){
 const f=source.finding;return `<h3>${esc(f.title)}</h3><p class="mono">${esc(f.path)}:${f.line}</p><pre>${esc(f.evidence)}</pre><p class="muted">${esc(f.severity)} · Checked excerpt; the model assessment remains unverified.</p><details data-details="memory-source-${esc(source.run_id)}-${source.finding_index}"><summary>Exact source and review identity</summary><dl class="meta"><dt>Run</dt><dd class="mono">${esc(source.run_id)}</dd><dt>Checkpoint / finding</dt><dd>${source.checkpoint_id} / ${source.finding_index+1}</dd><dt>Finding review</dt><dd>v${source.finding_review_revision}</dd><dt>Job</dt><dd>v${source.job_version}</dd>${pinnedSourceMarkup(source)}<dt>Historical context</dt><dd>${source.context_reference?`v${source.context_reference.revision} · ${esc(source.context_reference.digest)}`:'Not recorded'}</dd><dt>Finding identity</dt><dd class="mono">${esc(source.finding_identity)}</dd><dt>Occurrence</dt><dd class="mono">${esc(source.finding_id)}</dd></dl>${pinnedSourceNotice(source)}<p class="muted">Matching source and job do not establish agreement with current workspace context.</p></details>`;
}
function memoryRecordMarkup(m,readOnly=false,asOf=null){const expired=m.status==='active'&&m.expires_at!==null&&Date.parse(m.expires_at)<=(asOf===null?Date.now():Date.parse(asOf));const status=m.status==='revoked'?'Revoked':expired?'Expired':'Active reference';return `<article class="entry"><span class="badge">${status}${asOf===null?'':' at queue time'}</span>${memorySourceMarkup(m.source)}<h3>Recorded rationale</h3><p class="goal">${esc(m.reason)}</p><p class="muted">${esc(m.created_by)} · ${esc(date(m.created_at))} · ${m.expires_at?`Expires ${esc(date(m.expires_at))}`:'No automatic expiry'}</p>${m.status==='revoked'?`<p class="goal">${esc(m.revoke_reason)}</p><p class="muted">Revoked by ${esc(m.revoked_by)} · ${esc(date(m.revoked_at))}</p>`:''}<details><summary>Memory identity</summary><p class="mono">${esc(m.id)}</p><p class="mono">${esc(m.digest)}</p></details>${!readOnly&&m.status==='active'?`<button type="button" data-revoke-memory="${esc(m.id)}"${S.busy||!usable()?' disabled':''}>Revoke exception…</button>`:''}</article>`;}
function memoriesMarkup(){if(S.apiVersion<14)return '<section class="section"><h2>Pip memory</h2><p>Update the computer to Pips API 14 to review source-bound exceptions.</p></section>';return `<section class="section" aria-label="Pip memory"><div class="section-head"><h2>Pip memory</h2>${button('load-memories',memoryLoading?'Loading…':'Refresh',memoryLoading||!usable())}</div><p class="muted">Recorded exceptions guide audits and read-only Pip chats; they never hide findings or grant permissions.</p><details data-details="memory-explainer"><summary>How exceptions work</summary><p class="muted">${PIP_MEMORY_NOTICE}</p><p class="muted">Open a checked finding in Runs to record an explicit exception. Audits and this Pip’s read-only chats receive these references. Documentation drafts and Patch/Pulse execution do not. This ledger shows current eligibility for future queued work; existing run pins stay unchanged.</p></details>${errorMarkup(memoryError)}${memories.map(m=>memoryRecordMarkup(m)).join('')}${memoryLoaded&&!memories.length?'<p class="muted">No recorded exceptions for this Pip.</p>':''}${memoryCursor!==null&&memories.length<100?button('more-memories','Older exceptions',memoryLoading||!usable()):''}${memoryCursor!==null&&memories.length>=100?'<p class="muted">Showing 100 records. Refresh returns to the latest page.</p>':''}<p class="muted">${S.apiVersion>=19?'Exceptions share capacity with claims and preferences.':'At most 32 unexpired active exceptions per Pip; 1,000 history entries across this computer.'} Expired and revoked decisions remain historical.</p></section>`;}
function typedMemoryPinMarkup(pin){
 const labels={finding_exception:'Exceptions',fact:'Recorded claims',preference:'Preferences'},source={not_observed:'Source not observed',same_pinned_source:'Same pinned source',historical_source:'Historical source'},job={same_pinned_job:'Same pinned job',historical_job:'Historical job'},context={not_recorded:'Context not recorded',same_pinned_context:'Same pinned context',historical_context:'Historical context'};
 return `<details data-details="memory-pin" aria-label="Pinned Pip memory"><summary>Pip memory at queue time · ${pin.entries.length} included</summary><p class="muted">${PIP_STATEMENT_NOTICE}</p><p class="muted">Eligibility was captured at ${esc(date(pin.as_of))}. Records may since have expired or been revoked. Identity matches do not prove truth, relevance, current source health or agreement with current context.</p><ul>${Object.entries(pin.counts_by_kind).map(([kind,c])=>`<li>${labels[kind]}: ${c.eligible_records-c.omitted_records} included · ${c.omitted_records} omitted · ${c.revoked_records} revoked · ${c.expired_records} expired · ${c.total_records} retained</li>`).join('')}</ul><p class="muted">Whole references are selected within a shared size limit. Omissions are not resolution or a complete history. Live eligibility is shown separately in Memory.</p>${pin.entries.map(e=>`<div><p class="muted">${source[e.applicability.source]} · ${job[e.applicability.job]} · ${context[e.applicability.context]}</p>${e.memory.kind==='finding_exception'?memoryRecordMarkup(e.memory,true,pin.as_of):statementRecordMarkup(e.memory,'active',pin.as_of,true,true)}</div>`).join('')}<details><summary>Queue-time memory identity</summary><p class="mono">Context v${pin.context_reference.revision} · ${esc(pin.context_reference.digest)}</p><p class="mono">Pin ${esc(pin.digest)}</p></details></details>`;
}
function memoryPinMarkup(run){
 if(run.manifest?.pip_memory===undefined)return '';
 try{const pin=pipMemoryPin(run.manifest.pip_memory,{...run,workspace_id:run.workspace_id||S.workspace.id});if(pin.schema_version===2)return typedMemoryPinMarkup(pin);return `<details data-details="memory-pin" aria-label="Pinned Pip memory"><summary>Pip memory at queue time · ${pin.entries.length} included</summary><p class="muted">${PIP_MEMORY_NOTICE}</p><p class="muted">${pin.total_records} retained · ${pin.eligible_records} eligible · ${pin.omitted_records} omitted · ${pin.revoked_records} revoked · ${pin.expired_records} expired at ${esc(date(pin.as_of))}.</p><p class="muted">This immutable queue-time history may include a decision revoked later or an exception that has since expired. Eligibility below is evaluated when this run was queued; current eligibility is shown in Memory. Omission does not mean a risk was resolved.</p>${pin.entries.map(e=>`<div><span class="badge">${esc(({exact_source_and_job:'Exact source and job',historical_source:'Historical source',historical_job:'Historical job',historical_source_and_job:'Historical source and job'})[e.applicability])}</span>${memoryRecordMarkup(e.memory,true,pin.as_of)}</div>`).join('')}<p class="mono">Pin ${esc(pin.digest)}</p></details>`;}catch(error){return errorMarkup(errorText(error));}
}
async function loadMemories(more=false){
 if(!usable()||S.apiVersion<14||!S.selected||memoryLoading)return;const token=scope(),seq=++memorySeq,before=more?memoryCursor:null;memoryLoading=true;memoryError='';render();
 try{const page=pipMemoriesPage(await send('list_pip_memories',{pip_id:S.selected,limit:20,...(before!==null?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||seq!==memorySeq)return;if(more&&(page.memories.some(m=>memories.some(old=>old.id===m.id))||page.next_before_id!==null&&page.next_before_id>=before))throw Error('Memory history did not advance. Refresh before retrying.');memories=more?[...memories,...page.memories]:page.memories;memoryCursor=page.next_before_id;memoryLoaded=true;}
 catch(error){if(token===scope()&&seq===memorySeq)memoryError=errorText(error);}finally{if(token===scope()&&seq===memorySeq){memoryLoading=false;render();}}
}
async function reviewException(index){
 if(!usable()||S.apiVersion<14||S.busy||S.run?.status!=='succeeded')return;const token=scope(),seq=++memorySourceSeq,run=S.run;
 try{const checkpoint=runCheckpoint(run.checkpoint,{id:run.id,pip_id:S.selected,workspace_id:S.workspace.id}),finding=checkpoint?.findings[index];if(!finding)return;const c=pipExceptionCandidate(await send('get_pip_exception_source',{pip_id:S.selected,run_id:run.id,finding_index:index}),S.selected,S.workspace.id);if(token!==scope()||seq!==memorySourceSeq||S.runId!==run.id)return;
 const source=c.source;if(source.run_id!==run.id||source.checkpoint_id!==checkpoint.id||source.finding_index!==index||source.finding_id!==finding.finding_id||source.finding_identity!==finding.identity||source.finding_review_revision!==finding.review.revision||!pipExceptionSourceEqual(source,{...source,job_version:run.manifest.job_version,source_policy:sourcePolicy(run.manifest.source_policy),source_revision:run.manifest.source_revision,source_snapshot:run.manifest.source_snapshot??null,context_reference:checkpoint.context_revision===null?null:{revision:checkpoint.context_revision,digest:checkpoint.context_digest}})||['title','severity','path','line','evidence','verification'].some(k=>source.finding[k]!==finding[k]))throw Error('The finding changed while the exception source was read. Refresh the report and review again.');
 draft.findingReviewReason='';draft.memoryExpiry='';openReview({title:'Record a Pip-local exception?',description:PIP_MEMORY_NOTICE,body:memorySourceMarkup(source)+`<details><summary>Source review digest</summary><p class="mono">${esc(c.digest)}</p></details>`,confirm:'Record exception',reasonRequired:true,note:'Why this is fine (optional)',autoReason:'Accepted as an exception in the Pips view.',memoryRecord:true,memorySource:source,request:{type:'record_pip_exception',pip_id:S.selected,run_id:run.id,finding_index:index,expected_source_digest:c.digest}});
 }catch(error){if(token===scope()&&seq===memorySourceSeq)setError(error);}
}
function revokeMemoryReview(id){if(S.apiVersion<14||!usable())return;const m=memories.find(m=>m.id===id);if(!m||m.status!=='active')return;draft.findingReviewReason='';openReview({title:'Revoke this Pip exception?',description:'Future queued audits and read-only Pip chats will exclude it. Existing run pins keep their original historical reference. This does not change finding decisions or workspace context.',body:memoryRecordMarkup(m,true),confirm:'Revoke exception',reasonRequired:true,autoReason:'Removed in the Pips view.',request:{type:'revoke_pip_exception',pip_id:S.selected,memory_id:m.id,expected_revision:m.revision}});}

function statementAnchorMarkup(a,digest){
 const s=a.source_reference;return `<p class="notice">${s?'Selected historical audit reference. It does not prove this statement or its relevance.':'Source not observed. This statement has no selected source evidence.'}</p>${s?`<dl class="meta"><dt>Selected audit</dt><dd class="mono">${esc(s.run_id)}</dd><dt>Audit job</dt><dd>v${s.job_version}</dd>${pinnedSourceMarkup(s)}</dl>${pinnedSourceNotice(s)}`:''}<details><summary>Recording scope and reference details</summary><dl class="meta"><dt>Pip</dt><dd class="mono">${esc(a.pip_id)}</dd><dt>Workspace</dt><dd class="mono">${esc(a.workspace_id)}</dd><dt>Job / lifecycle at review</dt><dd>v${a.job_version} / v${a.lifecycle_revision}</dd><dt>Context at recording review</dt><dd>v${a.context_reference.revision} · ${esc(a.context_reference.digest)}</dd><dt>Job definition digest</dt><dd class="mono">${esc(a.job_digest)}</dd><dt>Runner / binding</dt><dd class="mono">${esc(a.binding.runner_id)} / ${esc(a.binding.binding_id)}</dd><dt>Binding observed</dt><dd>${esc(date(a.binding.updated_at))}</dd><dt>Binding root digest</dt><dd class="mono">${esc(a.binding.root_digest)}</dd>${s?`<dt>Checkpoint</dt><dd>${s.checkpoint_id} · ${esc(s.checkpoint_digest)}</dd><dt>Checkpoint digest basis</dt><dd>Original stored checkpoint bytes</dd><dt>Audit context</dt><dd>v${s.context_reference.revision} · ${esc(s.context_reference.digest)}</dd>`:''}<dt>Reviewed anchor digest</dt><dd class="mono">${esc(digest)}</dd></dl><p class="muted">Job, context and binding hashes identify metadata; they do not verify this claim or identify current source contents. The computer validates the immutable record digests.</p></details>`;
}
function statementRecordMarkup(m,status,asOf,readOnly=false,atQueue=false){
 return `<article class="entry"><span class="badge">${m.kind==='fact'?'Recorded claim':'Recorded preference'} · ${esc(status)}${atQueue?' at queue time':''}</span><h3>${esc(m.title)}</h3><p class="goal">${esc(m.statement)}</p><p class="muted">${m.kind==='fact'?'User-recorded claim; may be wrong.':'Advisory preference; does not override the approved job.'} Execution is not verified.</p><p class="goal">Reason: ${esc(m.reason)}</p><p class="muted">${esc(m.created_by)} · ${esc(date(m.created_at))}. ${m.expires_at?`Expiry: ${esc(date(m.expires_at))}.`:'No automatic expiry.'} ${atQueue?'Status when queued':'Status as of'} ${esc(date(asOf))}.</p>${m.status==='revoked'?`<p class="goal">Revoked: ${esc(m.revoke_reason)}</p><p class="muted">${esc(m.revoked_by)} · ${esc(date(m.revoked_at))}</p>`:''}${statementAnchorMarkup(m.anchor,m.anchor_digest)}<details><summary>Statement identity</summary><p class="mono">${esc(m.id)}</p><p class="mono">${esc(m.digest)}</p></details>${!readOnly&&m.status==='active'?`<button type="button" data-revoke-statement="${esc(m.id)}"${S.busy||!usable()?' disabled':''}>Revoke statement…</button>`:''}</article>`;
}
function statementsMarkup(){
 if(S.apiVersion<19)return '';const sources=S.runs.filter(r=>r.status==='succeeded'&&(!r.manifest?.run_kind||r.manifest.run_kind==='audit'));const c=statementPage?.counts;
 return `<section class="section" aria-label="Recorded claims and preferences"><div class="section-head"><h2>Claims and preferences</h2>${button('load-statements',statementLoading?'Loading…':'Refresh',statementLoading||!usable())}</div><p class="muted">${PIP_STATEMENT_NOTICE}</p>${archived()?'<p class="muted">Archived Pip: history and revocation remain available. Restore to paused before recording a new statement.</p>':`<details data-details="new-pip-statement"><summary>Record a claim or preference</summary><form id="pip-statement-form" class="form"><label for="statementKind">Record type</label><select id="statementKind" data-draft="statementKind"><option value="fact"${draft.statementKind==='fact'?' selected':''}>Recorded claim</option><option value="preference"${draft.statementKind==='preference'?' selected':''}>Recorded preference</option></select>${field('statementTitle','Title')}${field('statementText','Statement',true)}<label for="statementSource">Optional historical audit reference</label><select id="statementSource" data-draft="statementSource"><option value="">No source selected · not observed</option>${draft.statementSource&&!sources.some(r=>r.id===draft.statementSource)?`<option value="${esc(draft.statementSource)}" selected>Previously selected audit · refresh before review</option>`:''}${sources.map(r=>`<option value="${esc(r.id)}"${draft.statementSource===r.id?' selected':''}>${esc(date(r.created_at))} · ${esc(r.id)}</option>`).join('')}</select><p class="muted">Only loaded successful audits of this Pip are offered. Selecting one does not establish that its source supports your statement.</p><label for="statementExpiry">Optional expiry, with time zone</label><input id="statementExpiry" data-draft="statementExpiry" value="${esc(draft.statementExpiry)}" placeholder="2026-12-01T09:00:00Z"><button type="submit"${statementInspecting||S.busy||!usable()?' disabled':''}>${statementInspecting?'Reading review scope…':'Review statement…'}</button></form></details>`}${errorMarkup(statementError)}${c?`<p class="muted">Statement ledger: ${c.retained} retained · ${c.active} active · ${c.expired} expired · ${c.revoked} revoked, as of ${esc(date(statementPage.as_of))}. Exception history above has its own ordering.</p>`:''}${statementRows.map(e=>statementRecordMarkup(e.memory,e.effective_status,e.asOf)).join('')}${statementLoaded&&!statementRows.length?'<p class="muted">No recorded claims or preferences for this Pip.</p>':''}${statementPage?.page_reduced_for_budget?'<p class="muted">This page was shortened to fit the response limit; each statement is complete.</p>':''}${statementPage?.has_more&&statementRows.length<100?button('more-statements','Older statements',statementLoading||!usable()):''}${statementPage?.has_more&&statementRows.length>=100?'<p class="muted">Showing 100 loaded statements. Refresh returns to the latest page.</p>':''}<p class="muted">Exceptions and statements share a limit of 32 active, unexpired records per Pip and 1,000 retained records across this computer. Revocation and expiry keep the historical record.</p></section>`;
}
async function loadStatements(more=false){
 if(S.apiVersion<19||!usable()||!S.selected||statementLoading)return;const token=scope(),seq=++statementSeq,before=more?statementPage?.next_before_id:null;statementLoading=true;statementError='';render();
 try{const page=pipStatementsPage(await send('list_pip_statements',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||seq!==statementSeq)return;if(more&&(page.entries.some(e=>statementRows.some(old=>old.memory.id===e.memory.id))||page.next_before_id!==null&&page.next_before_id>=before))throw Error('Statement history did not advance. Refresh before retrying.');const rows=page.entries.map(e=>({...e,asOf:page.as_of}));statementRows=more?[...statementRows,...rows]:rows;statementPage=page;statementLoaded=true;}
 catch(error){if(token===scope()&&seq===statementSeq)statementError=errorText(error);}finally{if(token===scope()&&seq===statementSeq){statementLoading=false;render();}}
}
function statementFormValue(){return pipStatementDraft({kind:draft.statementKind,title:draft.statementTitle.trim(),statement:draft.statementText.trim(),reason:draft.statementReason.trim()||'Recorded in the Pips view.',expiry:draft.statementExpiry.trim(),source_run_id:draft.statementSource});}
async function reviewStatement(){
 if(S.apiVersion<19||!usable()||!S.pip||archived()||S.busy||statementInspecting)return;const token=scope(),seq=++statementAnchorSeq;
 try{const authored=statementFormValue();if(authored.source_run_id&&!S.runs.some(r=>r.id===authored.source_run_id&&r.status==='succeeded'&&(!r.manifest?.run_kind||r.manifest.run_kind==='audit')))throw Error('Refresh and choose a successful audit of this Pip, or leave the source unobserved.');const signature=JSON.stringify(authored);statementInspecting=true;S.error='';render();
  const candidate=pipStatementCandidate(await send('get_pip_statement_anchor',{pip_id:S.selected,...(authored.source_run_id?{source_run_id:authored.source_run_id}:{})}),S.selected,S.workspace.id);if(token!==scope()||seq!==statementAnchorSeq)return;if(signature!==JSON.stringify(statementFormValue()))throw Error('The statement changed while its scope was read. Review the current draft again.');const a=candidate.anchor;if(a.job_version!==S.pip.current_version||a.lifecycle_revision!==S.pip.lifecycle_revision||(a.source_reference?.run_id??undefined)!==authored.source_run_id)throw Error('The Pip or selected source changed. Refresh before reviewing the statement.');
  const request={type:'record_pip_statement',pip_id:S.selected,...authored,expected_anchor_digest:candidate.digest},body=JSON.stringify(request);if(statementRetry?.body!==body)statementRetry={body,key:window.crypto.randomUUID()};request.request_key=statementRetry.key;
  openReview({title:authored.kind==='fact'?'Record this Pip-local claim?':'Record this Pip-local preference?',description:PIP_STATEMENT_NOTICE,body:`<h3>${esc(authored.title)}</h3><p class="goal">${esc(authored.statement)}</p><p class="goal">Reason: ${esc(authored.reason)}</p><p class="muted">${authored.expires_at?`Expires ${esc(date(authored.expires_at))}`:'No automatic expiry'}</p>${statementAnchorMarkup(a,candidate.digest)}<p class="muted">The computer rechecks this exact job, lifecycle, binding and context when recording. A changed scope requires a fresh review.</p>`,confirm:'Record statement',statementAnchor:a,request});
 }catch(error){if(token===scope()&&seq===statementAnchorSeq)setError(error);}finally{if(token===scope()&&seq===statementAnchorSeq){statementInspecting=false;render();}}
}
function revokeStatementReview(id){
 if(S.apiVersion<19||!usable()||S.busy)return;const e=statementRows.find(e=>e.memory.id===id);if(!e||e.memory.status!=='active')return;draft.findingReviewReason='';openReview({title:'Revoke this Pip statement?',description:'Future queued work excludes this reference. Existing queue-time pins remain historical. No finding, job, permission or shared context changes.',body:statementRecordMarkup(e.memory,e.effective_status,e.asOf,true),confirm:'Revoke statement',reasonRequired:true,autoReason:'Removed in the Pips view.',statementMemory:e.memory,request:{type:'revoke_pip_statement',pip_id:S.selected,memory_id:id,expected_revision:0}});
}

function notificationsMarkup(){
 if(S.apiVersion<13)return '<section class="section"><h2>Notifications</h2><p class="muted">Update the computer to Pips API 13 to read notification metadata.</p></section>';
 return `<section class="section" aria-label="Workspace notifications"><div class="section-head"><h2>Notifications</h2>${button('refresh-notifications',notificationLoading?'Loading…':'Refresh',notificationLoading||!usable())}</div><p class="muted">${notifications?`${notifications.unread_count} unread · ${notifications.retained_count} retained in this workspace.`:'Notification counts have not been received.'} Read status is shared on this computer. Marking read does not approve, reject, retry or start anything.</p>${notificationError?errorMarkup(notificationError):''}${notifications?.sync_pending?'<p class="notice">Catching up: notification counts are incomplete. Refresh reads the next bounded batch.</p>':''}${notifications?.history_may_be_incomplete?'<p class="muted">Earlier notifications may be missing because source events were unavailable or the retained inbox was pruned.</p>':''}${notificationItems.map(n=>`<article class="entry"><span class="badge">${n.revision?'Read':'Unread'}</span><h3>${esc(n.title)}</h3>${n.pip_id?`<p class="muted">${esc(S.jobs.find(p=>p.id===n.pip_id)?.name||n.pip_id.slice(0,16)+'…')}</p>`:''}<p class="muted">${esc(date(n.occurred_at))} · ${esc(n.source_status)}${!n.actionable?' · Historical notice':''}</p><div class="actions">${n.source_status!=='unavailable'?`<button type="button" data-open-notification="${esc(n.id)}"${!usable()?' disabled':''}>${n.source_kind==='run'?'View run':'Open saved review'}</button>`:'<span class="muted">The source record is unavailable.</span>'}${!n.revision?`<button type="button" data-read-notification="${esc(n.id)}"${notificationMark||notificationLoading||!usable()?' disabled':''}>${notificationMark===n.id?'Marking…':'Mark read'}</button>`:''}</div></article>`).join('')}${notifications&&!notificationItems.length?'<p class="muted">No notifications in the received page.</p>':''}${notifications?.has_more&&notificationItems.length<100?button('more-notifications','Older notifications',notificationLoading||!usable()):''}${notifications?.has_more&&notificationItems.length>=100?'<p class="muted">Showing 100 notices. Refresh returns to the latest page.</p>':''}<p class="muted">Up to 500 notices are retained across this computer. Needs review remains the authoritative pending-request list; an unread notice may already be resolved.</p></section>`;
}
async function loadNotifications(more=false){
 if(S.apiVersion<13||!usable()||!S.workspace||notificationLoading||notificationMark)return;const token=scope(),sequence=++notificationSeq,before=more?notifications?.next_before_seq:null;notificationLoading=true;notificationError='';render();
 try{const page=notificationsPage(await send('list_pip_notifications',{workspace_id:S.workspace.id,limit:20,...(before?{before_seq:before}:{})}),S.workspace.id);if(token!==scope()||sequence!==notificationSeq)return;if(more&&(page.notifications.some(n=>n.seq>=before||notificationItems.some(old=>old.id===n.id))))throw Error('Notification paging did not advance. Refresh the inbox.');notificationItems=more?[...notificationItems,...page.notifications]:page.notifications;notifications=page;}
 catch(error){if(token===scope()&&sequence===notificationSeq)notificationError=errorText(error);}
 finally{if(token===scope()&&sequence===notificationSeq){notificationLoading=false;render();}}
}
async function markNotification(id){
 const n=notificationItems.find(n=>n.id===id);if(!n||n.revision||S.apiVersion<13||!usable()||notificationMark||notificationLoading)return;const token=scope();notificationMark=id;notificationError='';render();
 try{const result=await send('mark_pip_notification_read',{workspace_id:S.workspace.id,notification_id:n.id,expected_revision:n.revision});if(token!==scope())return;const next=pipNotification(result.notification,S.workspace.id);if(next.id!==n.id||next.seq!==n.seq||next.revision!==1||next.source_kind!==n.source_kind||JSON.stringify(next.reference)!==JSON.stringify(n.reference)||typeof result.replayed!=='boolean')throw Error('The read mark did not match this notification. Refresh the inbox.');notificationItems=notificationItems.map(old=>old.id===id?next:old);if(notifications)notifications={...notifications,unread_count:Math.max(0,notifications.unread_count-1)};}
 catch(error){if(token===scope())notificationError=errorText(error);}
 finally{if(token===scope()){notificationMark='';render();}}
}
async function openNotification(id){const n=notificationItems.find(n=>n.id===id);if(!n||n.source_status==='unavailable'||!usable())return;try{await navigateFromHost(notificationNavigation(n));}catch(error){setError(error);}}

function resetCommandReceipts(){commandSeq++;commandDetailSeq++;commandReceipts=[];commandCursor=null;commandMore=false;commandTotal=0;commandLoaded=false;commandLoading=false;commandError='';commandSession='';}
function commandObservationMarkup(label,v){return `<h3>${esc(label)}</h3>${v?.status==='observed'?`<dl class="meta"><dt>Observation SHA-256</dt><dd class="mono">${esc(v.sha256)}</dd><dt>Eligible source</dt><dd>${v.files} files · ${v.bytes} bytes</dd><dt>Excluded</dt><dd>${v.excluded_entries} entries · ${v.excluded_directories} directories</dd><dt>Consistency</dt><dd>Checked, non-atomic · safe_source_v1</dd></dl>`:`<p class="muted">${v?'Unavailable: '+esc(v.reason.replaceAll('_',' ')):'No final observation recorded.'}</p>`}`;}
function commandContextSummary(entry){const s=commandOutcomeSummary(entry);return `<p class="muted">${esc(s.qualifier)}</p><dl class="meta command-outcome-summary"><dt>Native outcome</dt><dd>${esc(s.outcome)}</dd><dt>Output</dt><dd>${esc(s.output)}</dd><dt>Source</dt><dd>${esc(s.source)}</dd></dl>`;}
function commandContextDetails(entry){const p=entry.provenance;return `<details><summary>Receipt details</summary><div class="goal">${esc(entry.content)}</div><pre>${esc(p.command.preview)}</pre>${p.command.truncated?'<p class="muted">Command preview shortened to 256 UTF-8 bytes.</p>':''}${p.command.redacted?'<p class="muted">This command preview is redacted. Its hash describes the original command.</p>':''}<dl class="meta"><dt>Attempt</dt><dd class="mono">${esc(p.attempt_id)}</dd><dt>Session</dt><dd class="mono">${esc(p.session_id)} · revision ${p.session_revision_at_attempt}</dd><dt>Attempt SHA-256</dt><dd class="mono">${esc(p.attempt_digest)}</dd><dt>Final SHA-256</dt><dd class="mono">${esc(p.final_digest)}</dd><dt>Reviewed display SHA-256</dt><dd class="mono">${esc(p.view_digest)}</dd><dt>Command SHA-256</dt><dd class="mono">${esc(p.command.sha256)}</dd><dt>Captured output SHA-256</dt><dd class="mono">${esc(p.facts.output_sha256)}</dd></dl>${commandObservationMarkup('Before command',p.source_before)}${commandObservationMarkup('After command',p.source_after)}</details>`;}
function commandReceiptsMarkup(){
 if(S.apiVersion<17)return '';
 return `<details class="section" data-details="command-outcomes"><summary>Recorded command outcomes</summary><p class="muted">Historical foreground configured-verifier receipts. Viewing or recording one never runs a command. Exit 0 does not establish that tests ran or passed.</p><label for="commandReceiptSession">Session filter</label><select id="commandReceiptSession"><option value="">All workspace sessions</option>${outcomeSessions.map(r=>`<option value="${esc(r.session_id)}"${r.session_id===commandSession?' selected':''}>${esc(r.session_id)}</option>`).join('')}${commandSession&&!outcomeSessions.some(r=>r.session_id===commandSession)?`<option selected value="${esc(commandSession)}">${esc(commandSession)}</option>`:''}</select><div class="actions">${button('load-command-receipts',commandLoading?'Loading…':commandLoaded?'Refresh outcomes':'View recent outcomes',!usable()||commandLoading)}${!outcomeSessionsLoaded?button('load-outcome-sessions','Load session identities',!usable()||outcomeSessionsLoading):''}${outcomeSessionsMore&&outcomeSessions.length<100?button('more-outcome-sessions','More session identities',!usable()||outcomeSessionsLoading):''}</div>${errorMarkup(commandError)}${commandReceipts.map(r=>`<article class="entry"><span class="badge">${esc(r.state.replaceAll('_',' '))}${r.exit_code!==null?' · exit '+r.exit_code:''}</span><pre>${esc(r.command_preview||'Command preview is empty.')}</pre>${r.command_truncated?'<small>Command preview shortened; open the receipt to review the full display.</small>':''}<p class="muted">${esc(date(r.created_at))} · Session ${esc(r.session_id)}${r.recording?' · Context record '+esc(r.recording.status):''}${r.redacted?' · Redacted display':''}</p><button type="button" data-command-receipt="${esc(r.id)}"${S.busy||!usable()?' disabled':''}>View receipt…</button></article>`).join('')}${commandLoaded&&!commandReceipts.length?'<p class="muted">No recorded configured-verifier attempts in this scope. Ordinary Bash calls and transcripts are not reconstructed as receipts.</p>':''}${commandLoaded?`<p class="muted">Showing ${commandReceipts.length} of ${commandTotal} saved attempts. The archive accepts at most 10,000 attempts; old receipts are not silently deleted.</p>`:''}${commandMore&&commandReceipts.length<100?button('more-command-receipts','Older outcomes',!usable()||commandLoading):''}${commandMore&&commandReceipts.length>=100?'<p class="notice">Display limited to 100 outcomes. Filter by session or use the local CLI to inspect older records.</p>':''}</details>`;
}
async function loadCommandReceipts(more=false){
 if(S.apiVersion<17||!usable()||!S.workspace||commandLoading||more&&(!commandMore||commandReceipts.length>=100))return;
 const token=scope(),sequence=++commandSeq,session=commandSession||null,before=more?commandCursor:null;commandLoading=true;commandError='';render();
 try{const page=commandReceiptsPage(await send('list_workspace_execution_receipts',{workspace_id:S.workspace.id,limit:20,...(session?{session_id:session}:{}),...(before?{before_id:before}:{})}),S.workspace.id,session);if(token!==scope()||sequence!==commandSeq)return;if(more&&page.receipts.some(r=>commandReceipts.some(old=>old.id===r.id)))throw Error('Receipt history did not advance. Refresh before retrying.');commandReceipts=more?[...commandReceipts,...page.receipts]:page.receipts;commandCursor=page.next_before_id;commandMore=page.has_more;commandTotal=page.total_in_scope;commandLoaded=true;}
 catch(error){if(token===scope()&&sequence===commandSeq)commandError=errorText(error);}
 finally{if(token===scope()&&sequence===commandSeq){commandLoading=false;render();}}
}
async function openCommandReceipt(id){
 if(S.apiVersion<17||!usable()||S.busy||!S.workspace)return;const token=scope(),sequence=++commandDetailSeq;
 try{const answer=await send('get_workspace_execution_receipt',{workspace_id:S.workspace.id,attempt_id:id});if(token!==scope()||sequence!==commandDetailSeq)return;if(answer.workspace_id!==S.workspace.id)throw Error('The command receipt belongs to another workspace.');const r=commandReceipt(answer.receipt,S.workspace.id,id),f=r.facts,blocked=!r.can_record||!S.context;
 openReview({title:blocked?'Recorded command receipt':'Record this command outcome?',readOnly:blocked,blocked,commandOutcome:true,description:'Review historical native process facts. Exit code zero does not establish that tests ran or passed. Recording grants no permission and starts no command.',body:`<h3>Configured command${r.command.redacted?' · redacted display':''}</h3><pre>${esc(r.command.text)}</pre><dl class="meta"><dt>Native state</dt><dd>${esc(r.state.replaceAll('_',' '))}</dd><dt>Exit code</dt><dd>${f?.exit_code??'Not recorded'}</dd>${f?`<dt>Duration</dt><dd>${f.duration_ms} ms</dd><dt>Started</dt><dd>${esc(f.started_at?date(f.started_at):'Did not start')}</dd><dt>Ended</dt><dd>${esc(date(f.ended_at))}</dd>`:''}<dt>Context revision</dt><dd>${S.context?.revision??'Unavailable'}</dd></dl>${!f?'<p class="notice">Unfinalized: no native final was recorded. This proves neither launch nor success and cannot be recorded as an outcome.</p>':`<h3>Captured output preview${r.output_preview.redacted?' · display redacted again':''}</h3><pre>${esc(r.output_preview.text||'No output preview recorded.')}</pre><p class="muted">Captured ${f.output_bytes} decoded/redacted UTF-8 bytes. Stored preview: ${f.preview_bytes} bytes; ${f.omitted_bytes} captured bytes omitted from that preview. Display redaction can change the text length.</p>${!f.output_complete?'<p class="notice">Output capture was incomplete. Additional missing output has an unknown size.</p>':''}<p class="muted">${r.source_comparison==='unchanged_observation'?'Before and after observations match.':r.source_comparison==='changed_observation'?'Before and after observations differ.':'Source comparison is unavailable.'} These are checked, non-atomic observations. They cannot rule out edits and reversions, external inputs or side effects, and do not attest which source the command continuously used.</p>`}${r.recording?`<p class="notice">Previously recorded in context revision ${r.recording.created_revision} · ${esc(r.recording.status)}. ${r.recording.status==='active'?'Archive that context record before recording it again.':'The earlier archived recording remains historical.'}</p>`:''}<details><summary>Exact receipt identities and source observations</summary><dl class="meta"><dt>Attempt</dt><dd class="mono">${esc(r.id)}</dd><dt>Session</dt><dd class="mono">${esc(r.session_id)} · revision ${r.session_revision_at_attempt}</dd><dt>Attempt SHA-256</dt><dd class="mono">${esc(r.attempt_digest)}</dd><dt>Final SHA-256</dt><dd class="mono">${esc(r.final_digest??'No final')}</dd><dt>Reviewed display SHA-256</dt><dd class="mono">${esc(r.view_digest)}</dd><dt>Original command SHA-256</dt><dd class="mono">${esc(r.command.sha256)}</dd>${f?`<dt>Captured output SHA-256</dt><dd class="mono">${esc(f.output_sha256)}</dd>`:''}${r.recording?`<dt>Context record</dt><dd class="mono">${esc(r.recording.id)}</dd>`:''}</dl>${commandObservationMarkup('Before command',r.source_before)}${commandObservationMarkup('After command',r.source_after)}<p class="muted">${esc(COMMAND_OUTCOME_NOTICE)}</p></details><p class="muted">Context keeps native facts, historical source observations and a bounded command preview. Output prose is not copied. Current source and circumstances may differ.</p>`,confirm:'Record command outcome',request:{type:'record_workspace_execution_context',workspace_id:S.workspace.id,attempt_id:r.id,expected_attempt_digest:r.attempt_digest,expected_final_digest:r.final_digest,expected_view_digest:r.view_digest,expected_context_revision:S.context?.revision}});
 }catch(error){if(token===scope()&&sequence===commandDetailSeq)setError(error);}
}
function contextMarkup() {
  return `<section class="section"><h2>Workspace context ${S.context?`<span class="badge">v${S.context.revision}</span>`:''}</h2><p class="muted">Records for future runs in this workspace. Existing runs retain the exact context they started with.</p>${S.context?contextEntries(S.context.entries,true):'<p role="status">Context is unavailable. Refresh to retry.</p>'}</section>${commandReceiptsMarkup()}<form id="context-form" class="form context-form"><h2>Record context</h2><p class="muted">Up to 32 active records and 16 KiB total. Content is never silently shortened.</p><label for="contextKind">Kind</label><select id="contextKind" data-draft="contextKind">${['decision','milestone','command','risk','exception'].map(k=>`<option${draft.contextKind===k?' selected':''}>${k}</option>`).join('')}</select>${field('contextTitle','Title')}${field('contextContent','Record',true)}<p class="muted">Commands are reference notes, not execution permission. To revise a record, archive it and create a new one.</p><button type="submit"${S.busy||!usable()||!S.context?' disabled':''}>Review record…</button></form>${outcomesMarkup()}`;
}
// Starter Pips (Pips API 41): common jobs saved as an ordinary setup card for review.
let starterCatalog=null,starterLoading=false;
async function loadStarters(){
 if(S.apiVersion<41||starterCatalog||starterLoading||!usable())return;
 starterLoading=true;
 try{const value=await send('list_pip_starters',{});starterCatalog=Array.isArray(value?.starters)?value.starters.filter(v=>record(v)&&typeof v.id==='string'&&typeof v.title==='string'&&typeof v.summary==='string'&&['project','personal'].includes(v.scope)&&Array.isArray(v.params)):[];}
 catch{starterCatalog=[];}
 finally{starterLoading=false;render();}
}
// Sharing (API 41): export a Pip's job to a file, or import one as a setup card to review.
function importMarkup(){
 if(S.apiVersion<41||remoteHost)return '';
 return `<p class="muted import-pip">${button('import-pip-file','Import a shared Pip…',S.busy||!usable())} A file someone exported from DGC. It opens as a setup card for you to review.</p>`;
}
async function importPipFile(){
 if(S.apiVersion<41||!usable()||S.busy)return;
 const token=scope();S.busy=true;render();let card=null;
 try{const result=await send('import_pip_file',{});if(token!==scope()||result?.cancelled)return;
  card=pipSetup(result.setup,S.workspace.id);setupRows=[...setupRows.filter(row=>row.id!==card.id),card];S.create=false;S.overview=true;
  const left=Array.isArray(result.left_out)?result.left_out.filter(x=>typeof x==='string'):[];
  S.notice='Imported as a setup card. Review it before anything is created.'+(left.length?' Not included: '+left.join(' '):'');}
 catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();}}
 if(card&&token===scope())await openSetup(card.id);
}
function shareMarkup(){
 if(S.apiVersion<41||remoteHost||!S.pip||S.pip.pip_type==='patch')return '';
 return `<section class="section"><h2>Share this Pip</h2><p class="muted">Save its job as a file someone else can import into their DGC: name, goal, type, schedule and the pages it reads. Your connected accounts, memory, history and findings stay here.</p><div class="actions">${button('export-pip-file','Export…',S.busy||!usable())}</div></section>`;
}
async function exportPipFile(){
 if(S.apiVersion<41||!usable()||S.busy||!S.pip)return;
 const token=scope();S.busy=true;render();
 try{const result=await send('export_pip_file',{pip_id:S.pip.id});if(token!==scope())return;
  const left=Array.isArray(result?.left_out)?result.left_out.filter(x=>typeof x==='string'):[];
  S.notice='The shared Pip file is open. Save it where you like.'+(left.length?' Not included: '+left.join(' '):'');}
 catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();}}
}
function startersMarkup(scope){
 if(S.apiVersion<41||remoteHost)return '';
 if(!starterCatalog){void loadStarters();return '';}
 const list=starterCatalog.filter(v=>v.scope===scope);if(!list.length)return '';
 return `<div class="starters" role="group" aria-label="Starter Pips"><p class="step">Start from a common job</p>${list.map(v=>`<button type="button" class="starter" data-starter="${esc(v.id)}"${S.busy||!usable()?' disabled':''}><strong>${esc(v.title)}</strong><span>${esc(v.summary)}</span></button>`).join('')}<p class="muted">Or describe your own below.</p></div>`;
}
function openStarter(id){
 const v=(starterCatalog||[]).find(item=>item.id===id);if(!v||S.apiVersion<41||!usable())return;
 let zone='';try{zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch{}
 const has=key=>v.params.includes(key);
 const body=`<div class="form">${has('branch')?`<label for="starter-branch">Branch to review</label><input id="starter-branch" placeholder="the checked-out branch" autocomplete="off">`:''}${has('time')?`<label for="starter-time">Time</label><input id="starter-time" type="time" value="${esc(v.default_time||'09:00')}">`:''}${has('timezone')?`<label for="starter-timezone">Time zone</label><input id="starter-timezone" value="${esc(zone)}" autocomplete="off">`:''}${has('web_reads')?`<label for="starter-web">Pages and searches to read, one per line: an https page, or <code>search: your query</code>. Up to four; you can add apps later.</label><textarea id="starter-web" rows="3" placeholder="${esc(typeof v.web_example==='string'&&v.web_example?v.web_example:'https://example.com/status\nsearch: weather in your city today').replace(/\n/g,'&#10;')}"></textarea>`:''}</div>`;
 openReview({starterForm:{id:v.id,params:v.params},title:v.title,description:v.summary+' DGC prepares a setup card from these choices; nothing is created until you approve the card.',body,confirm:'Prepare setup card',request:{type:'propose_starter_pip'}});
}
function prepareStarter(review){
 const form=review.starterForm,params={},value=id=>($(id)?.value||'').trim();
 if(form.params.includes('branch')&&value('starter-branch'))params.branch=value('starter-branch');
 if(form.params.includes('time')&&value('starter-time'))params.time=value('starter-time');
 if(form.params.includes('timezone'))params.timezone=value('starter-timezone');
 if(form.params.includes('web_reads')&&value('starter-web')){try{params.web_reads=webReadsFromText(value('starter-web')).reads;}catch(error){review.error=errorText(error);renderReview();return;}}
 if(S.busy||!usable())return;
 const token=scope();S.busy=true;renderReview();
 void (async()=>{
  let card=null;
  try{const result=await send('propose_starter_pip',{starter:form.id,params});if(token!==scope()||!usable())return;card=pipSetup(result.setup,S.workspace.id);setupRows=[...setupRows.filter(row=>row.id!==card.id),card];closeReview();S.create=false;S.overview=true;}
  catch(error){if(token===scope()&&S.review===review){review.error=errorText(error);}}
  finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
  if(card&&token===scope())await openSetup(card.id);   // the card opens straight into its review
 })();
}
function setupsMarkup(){
 if(S.apiVersion>=23&&!S.overview&&!S.create&&S.tab==='chat')return setupRows.length||setupError?`<div class="chat-setup-banner">${button('chat-review-setups',setupError?'Check setup reviews':`${setupRows.length} setup${setupRows.length===1?'':'s'} waiting for review`)}</div>`:'';
 if(S.apiVersion<23||!setupRows.length&&!setupError&&(S.create||S.selected&&!S.overview))return '';
 return `<section class="setup-inbox" aria-label="Pip setup reviews"><details data-details="setup-inbox"${setupError?' open':''}><summary class="setup-inbox-toggle">${setupRows.length?`${setupRows.length} setup${setupRows.length===1?'':'s'} waiting for your review`:'Set up a Pip with DGC'}<span>Review</span></summary><div class="section-head"><h2>Setup reviews${setupRows.length?' · '+setupRows.length:''}</h2>${button('refresh-setups',setupLoading?'Checking…':'Check for setups',setupLoading||S.busy||!usable())}</div>${errorMarkup(setupError)}${setupRows.map(s=>`<article class="setup-card">${avatar('waiting_approval',S.types.find(t=>t.id===s.pip_type),`setup-${s.id}`)}<div class="setup-card-copy"><span class="badge">Waiting for your review</span><h3>${esc(s.name)}</h3><p class="goal">${esc(s.goal)}</p><p class="muted">${esc(s.source_policy==='personal'?'Personal · across your projects':s.project_root)} · ${esc((s.event_trigger?`After each new commit to ${s.source_ref}`:scheduleLabel(s.schedule)))}${s.run_now?' · also run once':''}</p></div><div class="actions"><button type="button" data-setup="${esc(s.id)}"${S.busy||!usable()?' disabled':''}>Review setup</button><button type="button" data-reject-setup="${esc(s.id)}"${S.busy||!usable()?' disabled':''}>Reject</button></div></article>`).join('')}${setupRows.length>=5?'<p class="muted">Showing up to five pending setups. Resolve a card to reveal more.</p>':''}${!setupRows.length&&!setupError?'<p class="muted">Describe a job in the main DGC chat. Its proposed setup will appear here for your review.</p>':''}</details></section>`;
}
async function loadSetups(){

 if(S.apiVersion<23||!usable()||!S.workspace||setupLoading)return;
 const epoch=S.epoch,workspace=S.workspace.id,sequence=++setupSeq;setupLoading=true;
 try{const value=await send('list_pip_setups',{workspace_id:workspace});if(epoch!==S.epoch||workspace!==S.workspace?.id||sequence!==setupSeq)return;setupRows=pipSetups(value,workspace);setupError='';}
 catch(error){if(epoch===S.epoch&&sequence===setupSeq){setupRows=[];setupError=errorText(error);}}
 finally{if(epoch===S.epoch&&sequence===setupSeq){setupLoading=false;render();}}
}
async function openSetup(id,reject=false){
 if(S.apiVersion<23||!usable()||S.busy)return;
 const listed=setupRows.find(s=>s.id===id);if(!listed)return;
 const token=scope(),sequence=++setupDetailSeq;
 try{const answer=await send('get_pip_setup',{setup_id:id});if(token!==scope()||sequence!==setupDetailSeq)return;const s=pipSetup(answer.setup,S.workspace.id,id);if(s.status!=='pending'||s.digest!==listed.digest)throw Error('This setup changed or was already resolved. Check for setups again.');
 const type=S.types.find(t=>t.id===s.pip_type),body=`<dl class="meta setup-summary"><dt>${s.source_policy==='personal'?'Scope':'Project'}</dt><dd>${esc(s.source_policy==='personal'?'Personal · across your projects':s.project_root)}</dd><dt>Pip</dt><dd>${esc(s.name)} · ${esc(type?.name||s.pip_type)}${s.pip_id?' · update existing Pip':' · create new Pip'}</dd><dt>Responsibility</dt><dd class="goal">${esc(s.goal)}</dd><dt>Source</dt><dd>${s.source_policy==='personal'?'Personal · no project access':'Committed source at '+esc(s.source_ref)}</dd><dt>${s.event_trigger?'Runs':'Schedule'}</dt><dd>${s.event_trigger?esc(`After each new commit to ${s.source_ref}, at most every ${s.event_trigger.minimum_minutes} minutes`):esc(scheduleLabel(s.schedule))}</dd><dt>Next scheduled run</dt><dd>${s.next_run_at?esc(date(s.next_run_at))+' · '+esc(s.next_run_at):'Manual only'}</dd><dt>Also run once now</dt><dd>${s.run_now?'Yes · one run will be queued':'No'}</dd><dt>Permissions</dt><dd>${s.pip_type==='pulse'||s.source_policy==='personal'?esc(s.scope_notice):'Read-only source tools. No live application checks, shell commands, tests, writes, or new permissions.'}</dd></dl>${s.app_plan?`<h3>Reviewed app reads</h3><p>${esc(s.app_plan.server)}</p><pre>${esc(JSON.stringify(s.app_plan.calls,null,2))}</pre>`:''}${s.web_plan?`<h3>Reviewed web reads</h3><ul class="web-reads">${s.web_plan.reads.map(r=>`<li>${esc(webReadLabel(r))}</li>`).join('')}</ul><p class="muted">DGC reads exactly these before each run. The Pip cannot open other pages.</p>`:''}${s.verification_plan?pulsePlanReview(s.verification_plan):''}${s.run_now_policy?`<p class="notice">${esc(s.run_now_policy)}</p>`:''}<p class="muted">${esc(s.scope_notice)}</p><p class="notice">${esc(s.runner_notice)}</p><p class="muted">${esc(s.reason)}</p><p class="muted">Review expires ${esc(date(s.expires_at))}. To change these choices, ask DGC for a new proposal.</p>`;
 openReview({setup:JSON.parse(JSON.stringify(s)),title:reject?'Reject this setup?':'Review Pip setup',description:reject?'This rejects only the proposal. Existing jobs and schedules stay unchanged.':'Save only if the project, responsibility, schedule and one-time run match what you asked for.',body,confirm:reject?'Reject setup':s.run_now?'Save and run once':'Save setup',expiresAt:s.expires_at,request:{type:reject?'reject_pip_setup':'accept_pip_setup',setup_id:s.id,expected_digest:s.digest}});
 }catch(error){if(token===scope()&&sequence===setupDetailSeq)setError(error);}
}
async function resolveSetup(review){
 if(S.busy||review!==S.review||review.scope!==scope()||!usable())return;
 if(reviewBlocked(review)){review.error='This setup expired. Ask DGC for a new proposal.';renderReview();return;}
 const token=scope(),workspace=S.workspace.id;S.busy=true;renderReview();
 try{const result=await send(review.request.type,{setup_id:review.request.setup_id,expected_digest:review.request.expected_digest});if(token!==scope()||!usable())return;const accepted=review.request.type==='accept_pip_setup',s=pipSetupResolution(result.setup,review.setup,accepted);
 closeReview();setupRows=setupRows.filter(row=>row.id!==s.id);S.busy=false;
 if(accepted){const selecting=select(s.receipt.pip_id),selectedScope=scope();await selecting;if(selectedScope!==scope()||!usable()||S.workspace?.id!==workspace)return;S.notice=s.receipt.run_id?`Setup saved. Pip is active. One run was queued (${s.receipt.run_id}). ${s.pip_type==='pulse'?'Reviewed checks are queued; inspect their results before claiming a pass.':s.work_kind==='documentation_draft'?'A documentation draft is queued.':'A source review is queued; this is not a completed application smoke test.'}`:s.next_run_at?`Setup saved. Pip is active. Next scheduled run: ${date(s.next_run_at)}. No immediate run was requested.`:'Setup saved for manual runs. Pip is active. Nothing was queued.';}else S.notice='Setup rejected. Existing jobs and schedules were not changed.';
 await refresh(true);
 }catch(error){if(token===scope()){if(S.review){S.review.error=errorText(error);renderReview();}else setError(error);}}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
function describeSetup(){
 if(S.apiVersion<23||remoteHost||typeof options.onSetupPrompt!=='function'||!usable()||S.busy)return;
 try{const prompt=pipSetupPrompt(S.workspace,draft.setupTask,setupEditing?S.pip:null);const result=options.onSetupPrompt(prompt);if(result!==true)throw Error(typeof result==='string'?result:'The main chat already has a draft. Send or save it before describing this setup.');draft.setupTask='';S.create=false;S.overview=!S.selected;render();}catch(error){setError(error);}
}
document.addEventListener('submit',event=>{if(event.target.id==='setup-prompt-form'){event.preventDefault();describeSetup();}});
// Chat, Results and Settings, always. The rest (schedule details, handoffs, versions and reviews, memory,
// context, notifications) sit under More; the one open now shows beside the three.
function tabsMarkup(){
 if(!S.pip&&!S.selected)return '';
 const all=[['chat','Chat'],['runs',personalPip()?'Results':'Runs'],['job','Settings'],['schedule',pulsePip(S.pip)?'Plan & schedule':'Schedule'],['handoffs','Handoffs'],['revisions','Versions and reviews'],...(S.apiVersion>=14?[['memory','Memory']]:[]),['context','Context'],...(S.apiVersion>=13?[['notifications','Notifications']]:[])]
  .filter(([key])=>personalPip()&&key==='handoffs'?S.apiVersion>=30&&!remoteHost:key==='schedule'?(!executionPip(S.pip)||pulsePip(S.pip)):key!=='handoffs'||personalPip()||!documentationPip(S.pip));
 const main=['chat','runs','job'],tab=([key,text])=>`<button type="button" data-tab="${key}" aria-pressed="${S.tab===key}"${['revisions','schedule'].includes(key)&&!S.pip?' disabled':''}>${text}</button>`;
 const shown=all.filter(([key])=>main.includes(key)||key===S.tab),more=all.filter(([key])=>!main.includes(key)&&key!==S.tab);
 return shown.map(tab).join('')+(more.length?`<details class="tabs-more" data-details="tabs-more"><summary aria-label="More sections">More</summary><div class="tabs-menu">${more.map(tab).join('')}</div></details>`:'');
}
function detailMarkup() {
  if(S.tab==='memory')return memoriesMarkup()+statementsMarkup();
  if(S.tab==='notifications')return notificationsMarkup();
  if (S.tab==='context') return contextMarkup();
  if(S.tab==='handoffs')return handoffsMarkup();
  if (S.create) return createMarkup();
  if(!S.selected) return `<div class="empty">${avatar()}<h2>${S.jobs.length?'Choose a conversation':'Create your first Pip'}</h2><p class="muted">${S.jobs.length?'Select a Pip from your list to continue its saved conversation, or create another Pip.':S.apiVersion>=23?'Describe a job to DGC, then review its project, schedule and permissions in one setup card.':'Choose a character and a job for the committed code in this workspace. Execution permissions are reviewed separately.'}</p>${button('create-first',S.apiVersion>=23?'Describe a job':'Choose a Pip',!usable()||!S.types.length,'primary')}</div>`;
  if(!S.pip) return '<p role="status">Loading Pip…</p>';
  const p=S.pip, pose=presentation(p,S.runs,usable(),S.runner),type=pipType(p,S.types),reviews=pendingReviews(p);
  return `<div class="hero">${avatar(pose.state,type,`detail-${p.id}`)}<div class="copy"><h2>${esc(p.name)}</h2><p class="type-role">${type?`${esc(type.name)} · ${personalPip(p)?'Personal helper':esc(type.role)}`:'Unsupported Pip type'}</p><p class="muted">${esc(pose.label)} · ${executionPip(p)&&!pulsePip(p)?'runs on approved handoffs':esc(p.event_trigger?'runs on events':p.schedule?scheduleLabel(p.schedule):'runs when you ask')}</p>${reviews?`<span class="review-count">${reviews} waiting for you</span>`:''}</div></div>${archived()?'<p class="notice">Archived · Conversation and evidence are retained. Restore from Job before changing this Pip or starting new work.</p>':''}${!type?'<p class="notice error">This Pip type is not supported by this editor. Existing reports remain readable; update the lab before starting new work.</p>':''}${S.tab==='chat'?'':waitingMarkup()}${S.tab==='chat'?chatMarkup():S.tab==='job'?jobSettingsMarkup():S.tab==='revisions'?revisionsMarkup():S.tab==='schedule'?scheduleMarkup():runsMarkup()}`;
}
// ---------------------------------------------------------------- Simple Pips (API 43)
// Personal Pips the way people meet them: Core is your Primary Pip, a new Pip is a character
// and a name, and each Pip is a chat that sets itself up. The detailed sections (results,
// settings, memory) stay one tap away in the chat's menu. Project Pips keep the full view.
const SIMPLE_CHARACTERS=['core','scout','lens','patch','rook','pulse','lock','quill'];
function simpleMode(){return S.apiVersion>=43&&!remoteHost&&S.workspace?.kind==='personal';}
// "Today 9:47 AM", "Yesterday 6:02 PM", or "Mon 5 Oct, 9:47 AM", like a messaging app.
function chatTime(at){
 const when=new Date(at),now=new Date(),day=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
 const time=when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}),days=Math.round((day(now)-day(when))/86400000);
 return days===0?`Today ${time}`:days===1?`Yesterday ${time}`:`${when.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})}, ${time}`;
}
function characterType(id){const i=SIMPLE_CHARACTERS.indexOf(id);return S.types.find(t=>t.id===id)||{id,name:id?id[0].toUpperCase()+id.slice(1):'Pip',character_index:i<0?4:i};}
const simpleIcon=name=>`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{back:'<path d="M10 3 5 8l5 5"/>',computer:'<rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11v3"/>',more:'<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',plus:'<path d="M8 3v10M3 8h10"/>'}[name]}</svg>`;
function meetCoreMarkup(){
 return `<section class="meet-core" aria-label="Meet Core">${avatar('idle',characterType('core'),'meet-core')}<h2>Meet Core</h2><p>Core is your Primary Pip. It is your go-to for everyday tasks, looks after your other Pips, and checks in when it needs your help.</p>${button('create-core',S.busy?'Creating…':'Create Core',S.busy||!usable(),'primary pill')}</section>`;
}
function simpleHomeMarkup(){
 const all=S.jobs.filter(p=>S.showArchived||p.status!=='archived'),live=S.jobs.filter(p=>p.status!=='archived');
 if(!live.length&&!S.jobs.length)return meetCoreMarkup();
 const order=[...all.filter(p=>p.pip_type==='core'),...all.filter(p=>p.pip_type!=='core')];
 const row=p=>{const type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,[],usable(),S.runner),waiting=pendingReviews(p);
  return `<button type="button" class="pip-row" data-job="${esc(p.id)}">${avatar(pose.state,type,`row-${p.id}`)}<span class="pip-row-copy"><strong>${esc(p.name)}${p.pip_type==='core'?'<span class="primary-badge" title="Your Primary Pip" aria-label="Primary Pip">★</span>':''}</strong><small>${p.status==='archived'?'Archived':waiting?`${waiting} waiting for you`:esc(pose.label)}</small></span></button>`;};
 return `<section class="simple-home" aria-label="Your Pips"><div class="simple-home-head"><h2>Your Pips</h2>${button('simple-new','New Pip',S.busy||!usable(),'primary pill')}</div>${live.some(p=>p.pip_type==='core')?'':`<div class="core-offer">${avatar('idle',characterType('core'),'core-offer')}<p><strong>Meet Core</strong><span>Your Primary Pip, for everyday tasks.</span></p>${button('create-core','Create',S.busy||!usable(),'primary pill')}</div>`}<div class="pip-rows">${order.map(row).join('')}</div>${S.jobs.some(p=>p.status==='archived')?button('show-archived',S.showArchived?'Hide archived':'Show archived',false,'link'):''}</section>`;
}
function newPipBody(){
 return `<div class="character-grid" role="radiogroup" aria-label="Character">${SIMPLE_CHARACTERS.filter(id=>id!=='core').map(id=>{const t=characterType(id);return `<button type="button" class="character-choice" role="radio" aria-checked="${draft.newPipCharacter===id}" data-new-character="${id}">${avatar('idle',t,`new-${id}`)}<span>${esc(t.name)}</span></button>`;}).join('')}</div><label for="newPipName">Name<input id="newPipName" data-draft="newPipName" maxlength="60" autocomplete="off" placeholder="Like Gmail, Travel or Money" value="${esc(draft.newPipName)}"></label><p class="muted">It says hello and sets itself up in its chat. No job form.</p>`;
}
function openNewPip(){
 if(S.busy||!usable())return;
 draft.newPipName='';draft.newPipCharacter=draft.newPipCharacter||'scout';
 openReview({title:'New Pip',description:'Pick a character and give it a name.',body:newPipBody(),confirm:'Create',newPip:true,request:{type:'create_pip'}});
 $('newPipName')?.focus();
}
// A Pip you meet should answer: creating one starts this computer's runner when it is off. A global
// stop is the user's own emergency brake, so it is shown, never lifted here.
async function ensureRunner(){
 if(remoteHost||S.runner?.online||S.runner?.paused)return;
 try{await send('pips_runtime',{action:'start'});}catch(error){S.notice=`Pips could not start on this computer: ${errorText(error)}`;}
}
function runnerOffMarkup(){
 if(remoteHost||S.runner?.online)return '';
 return S.runner?.paused?`<div class="runner-off" role="status"><span>Pips are stopped on this computer.</span>${button('resume-runner','Resume…',S.busy||!usable(),'quiet')}</div>`
  :`<div class="runner-off" role="status"><span>Your Pips aren't running on this computer, so ${esc(S.pip?.name||'this Pip')} can't answer yet.</span>${button('start-runner','Start',S.busy||!usable(),'primary pill')}</div>`;
}
async function createSimplePip(type,name,review=null){
 name=(name||'').trim();
 if(!name){if(review){review.error='Give it a name.';renderReview();$('newPipName')?.focus();}return;}
 if(S.busy||!usable())return;const token=scope();S.busy=true;if(review)renderReview();else render();
 try{
  const created=await send('create_pip',{workspace_id:S.workspace.id,pip_type:type,name,goal:'',source_ref:'HEAD',model_choice:{mode:'default'}});
  if(token!==scope())return;const pip=created?.pip;
  if(!record(pip)||typeof pip.id!=='string'||pip.workspace_id!==S.workspace.id)throw Error('The new Pip did not come back as expected. Refresh to see it.');
  // Its hello is a first turn DGC sends; the chat opens while it is being written.
  await ensureRunner();
  try{await send('introduce_pip',{pip_id:pip.id});}catch{/* the chat still opens; say hi to start it */}
  if(token!==scope())return;if(review)closeReview();S.busy=false;
  await refresh(true);if(token!==scope())return;await select(pip.id);
 }catch(error){if(token===scope()){if(review&&S.review===review){review.error=errorText(error);renderReview();}else setError(error);}}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
function simpleTabContent(){
 if(S.tab==='memory')return memoriesMarkup()+statementsMarkup();
 if(S.tab==='notifications')return notificationsMarkup();
 if(S.tab==='context')return contextMarkup();
 if(S.tab==='handoffs')return handoffsMarkup();
 return S.tab==='job'?jobSettingsMarkup():S.tab==='revisions'?revisionsMarkup():S.tab==='schedule'?scheduleMarkup():runsMarkup();
}
function simplePipHeader(){
 const p=S.pip,type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,S.runs,usable(),S.runner),onChat=S.tab==='chat';
 const sections=[['chat','Chat'],['runs','Results'],['job','Settings'],...(S.apiVersion>=14?[['memory','Memory']]:[]),['revisions','Versions and reviews'],...(S.apiVersion>=13?[['notifications','Notifications']]:[])].filter(([key])=>key!==S.tab);
 const computer=S.apiVersion>=42&&personalPip()?`<button type="button" id="pip-computer-open" class="topbar-icon" aria-label="Computer" title="${computerState.pip===S.selected&&computerState.value?.granted?'Open its computer':'Its computer'}"${S.busy||!usable()||archived()?' disabled':''}>${simpleIcon('computer')}</button>`:'';
 return `<header class="pip-topbar"><button type="button" id="${onChat?'simple-back':'simple-to-chat'}" class="topbar-icon" aria-label="${onChat?'Your Pips':'Back to the chat'}" title="${onChat?'Your Pips':'Back to the chat'}">${simpleIcon('back')}</button><div class="pip-pill">${avatar(pose.state,type,`pill-${p.id}`)}<span>${esc(p.name)}</span>${onChat?'':`<small>${esc(sections.length&&{runs:'Results',job:'Settings',memory:'Memory',revisions:'Versions',notifications:'Notifications',schedule:'Schedule',handoffs:'Handoffs',context:'Context'}[S.tab]||'')}</small>`}</div><div class="topbar-actions">${computer}<details class="pip-menu" data-details="pip-menu"><summary class="topbar-icon" aria-label="More" title="More">${simpleIcon('more')}</summary><div class="tabs-menu">${sections.map(([key,label])=>`<button type="button" data-tab="${key}">${label}</button>`).join('')}</div></details></div></header>`;
}
function simpleMarkup(){
 const picker=S.workspaces.length>1?`<label class="simple-scope"><span class="sr-only">Pips in</span><select id="pip-workspace" aria-label="Which Pips"${S.busy?' disabled':''}>${S.workspaces.map(w=>`<option value="${esc(w.id)}"${w.id===S.workspace?.id?' selected':''}>${esc(w.kind==='personal'?'Your Pips':'Project · '+w.name)}</option>`).join('')}</select></label>`:'';
 const bar=`<header class="simple-bar"><h1><span class="pips-wordmark">Pips</span></h1>${picker}${runnerMarkup()}</header>`;
 const notes=`${S.error?`<div class="simple-note">${errorMarkup(S.error)}</div>`:''}${S.notice?`<p class="notice simple-note" role="status">${esc(S.notice)}</p>`:''}`;
 if(!S.selected||S.overview||S.create)return `${bar}${notes}${setupRows.length?setupsMarkup():''}<div class="simple-content">${simpleHomeMarkup()}</div>`;
 if(!S.pip)return `${bar}<p role="status" class="muted simple-note">Loading…</p>`;
 return `${simplePipHeader()}<div class="simple-content${S.tab==='chat'?' chat':''}" data-view="${esc(S.tab)}">${S.tab==='chat'?chatMarkup():`${notes}${waitingMarkup()}${simpleTabContent()}`}</div>`;
}
function render() {
  if(disposed)return;
  const focus=document.activeElement; const focusId=focus?.id; const focusActivity=focus?.dataset?.chatActivity; const focusData=focus?.getAttribute?.('data-run')||focus?.getAttribute?.('data-job')||focus?.getAttribute?.('data-pip-type'); const selection=focus&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null;
  const oldLog=document.querySelector('.conversation-log'),oldScroll=oldLog?.scrollTop||0,oldHeight=oldLog?.scrollHeight||0,atEnd=!oldLog||oldHeight-oldScroll-oldLog.clientHeight<32,oldFirst=oldLog?.querySelector('[data-message]')?.dataset.message;
  const opened=new Set([...document.querySelectorAll('details[open][data-details]')].map(e=>e.dataset.details));
  const intro=welcome(),chatView=!intro&&!S.create&&!S.overview&&!!S.pip&&S.tab==='chat';
  shell.classList.toggle('sidebar-pinned',S.sidebarPinned);
  shell.classList.toggle('chat-open',!intro&&!S.create&&!S.overview&&!!S.pip&&S.tab==='chat');
  shell.classList.toggle('simple-pips',!intro&&simpleMode());
  const scopePicker=!remoteHost&&S.workspaces.some(w=>w.kind==='personal')?`<label class="pip-scope-picker">Pips in <select id="pip-workspace" aria-label="Pip workspace"${S.busy?' disabled':''}>${S.workspaces.map(w=>`<option value="${esc(w.id)}"${w.id===S.workspace?.id?' selected':''}>${esc(w.kind==='personal'?'Personal · this computer':w.name)}</option>`).join('')}</select></label>`:'';
  const header=scopePicker+(embedded?`<header class="embedded-header"><span class="workspace-name" title="${esc(S.workspace?.name||'Current workspace')}">${esc(S.workspace?.name||'Pips')}</span>${runnerMarkup()}</header>`:`<header><div class="heading"><div>${options.close?button('return-main','Back to DGC',false,'back-control'):''}<h1><span class="pips-wordmark">Pips</span></h1><p class="muted">${esc(S.workspace?.kind==='personal'?'Personal':S.workspace?.name||'Current workspace')}</p></div></div>${runnerMarkup()}</header>`);
  const markup=!intro&&simpleMode()?simpleMarkup():`${header}${S.error&&!chatView?`<div style="padding:0 20px">${errorMarkup(S.error)}</div>`:''}${S.notice&&!chatView?`<p class="notice" role="status">${esc(S.notice)}</p>`:''}${!intro&&S.overview&&!S.create?setupsMarkup():''}${intro?`<div class="content">${intro}</div>`:`<div class="layout ${S.overview&&!S.create?'overview':'selected'}"><aside aria-label="Workspace Pips"><div class="aside-heading">${!remoteHost?`<button type="button" id="pin-pips-sidebar" class="sidebar-toggle" aria-label="${S.sidebarPinned?'Collapse Pip sidebar':'Pin Pip sidebar open'}" title="${S.sidebarPinned?'Collapse Pip sidebar':'Pin Pip sidebar open'}" aria-pressed="${S.sidebarPinned}"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12"/></svg></button>`:''}<h2>Your Pips</h2><button type="button" id="new-pip" aria-label="New Pip" title="New Pip"${S.busy||!usable()||!S.types.length?' disabled':''}><span aria-hidden="true" class="new-pip-mark">+</span><span class="new-pip-text">New</span></button></div>${S.overview&&!S.create?`<div class="pips-overview-intro${S.jobs.length?'':' welcome'}"><span class="pips-eyebrow">${S.workspace?.kind==='personal'?'A little help, day to day':'Your project, looked after'}</span><h2>A little team. A clear purpose.</h2><p>Give each Pip a job. Stay in the conversation, and review what comes back.</p></div>`:''}<div class="job-list">${S.jobs.filter(p=>S.showArchived||p.status!=='archived').map(jobMarkup).join('')||`<div class="pips-first-job"><div class="pips-welcome-cast">${S.types.filter(t=>['scout','rook','pulse'].includes(t.id)).map(t=>avatar('idle',t,`welcome-${t.id}`)).join('')}</div><h3>What should your first Pip look after?</h3><p>Describe the job to DGC. You’ll review the scope and schedule before it starts.</p>${button('create-first','Describe a job',!usable()||!S.types.length,'primary')}<small>No Pips yet · Nothing is running for this project</small></div>`}</div>${S.jobs.some(p=>p.status==='archived')?button('show-archived',S.showArchived?'Hide archived Pips':`Show archived Pips (${S.jobs.filter(p=>p.status==='archived').length})`):''}${button('workspace-context','Workspace context',!usable())}${S.apiVersion>=13?button('workspace-notifications','Notifications',!usable()):''}${!embedded&&!remoteHost?`<details><summary>Local controls</summary><p class="muted">Stop pauses all Pips across local workspaces and cancels active runs. Resume the runner here, then resume individual Pips.</p>${button('disable','Disable local Pips…',S.busy||!usable())}</details>`:''}</aside><div class="content" data-view="${esc(S.tab)}">${!S.create&&(S.selected||['context','notifications'].includes(S.tab))?button('back-pips','Back to Pips',false,'back-control'):''}${S.overview&&!S.create?'':setupsMarkup()}<nav class="tabs" aria-label="Pip sections"${S.create||!S.selected?' hidden':''}>${tabsMarkup()}</nav>${detailMarkup()}</div></div>`}`;
  if(markup===lastMarkup) return;
  lastMarkup=markup;
  const previousAvatars=new Map([...document.querySelectorAll('[data-avatar-key]')].map(node=>[node.dataset.avatarKey,node]));
  avatarObserver?.disconnect();
  $('app').innerHTML=markup;
  for(const node of document.querySelectorAll('[data-avatar-key]')){const old=previousAvatars.get(node.dataset.avatarKey);if(old&&old.dataset.character===node.dataset.character&&old.dataset.pose===node.dataset.pose)node.replaceWith(old);}
  observeAvatars();fitChatInput();hydrateMessageImages();
  const newLog=document.querySelector('.conversation-log');if(newLog){const first=newLog.querySelector('[data-message]')?.dataset.message;newLog.scrollTop=atEnd?newLog.scrollHeight:first!==oldFirst?oldScroll+newLog.scrollHeight-oldHeight:oldScroll;}
  for(const el of document.querySelectorAll('details[data-details]')) if(opened.has(el.dataset.details)) el.open=true;
  if(focusId && !S.review) { const next=$(focusId);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange) next.setSelectionRange(...selection); }
  else if(focusActivity&&!S.review)[...document.querySelectorAll('[data-chat-activity]')].find(e=>e.dataset.chatActivity===focusActivity)?.focus({preventScroll:true});
  else if(focusData && !S.review) [...document.querySelectorAll('[data-job],[data-run],[data-pip-type]')].find(e=>e.dataset.job===focusData||e.dataset.run===focusData||e.dataset.pipType===focusData)?.focus({preventScroll:true});
}
async function chooseAppConnection(){
 if(remoteHost||S.apiVersion<29||!personalPip()||!usable())return;
 openReview({title:'Connected apps',description:'Reuse a connection from DGC Settings. Choosing one lists its account identities; it does not read app contents.',readOnly:true,body:'<p class="muted">Loading connections…</p>',request:{type:'list_pip_connections'}});
 const ticket=S.review;
 try{const answer=await send('list_pip_connections');if(S.review!==ticket||ticket.scope!==scope())return;
 if(!Array.isArray(answer.connections)||answer.connections.length>64)throw Error('The connection list is invalid.');
 const supported=answer.connections.filter(c=>c?.enabled===true&&c.pip_read_adapter===true&&typeof c.name==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(c.name));
 ticket.body=supported.length?'<div class="actions">'+supported.map(c=>`<button type="button" data-app-connection="${esc(c.name)}">${esc(c.provider||c.name)} · ${esc(c.name)}</button>`).join('')+'</div>':'<p>No supported connection is enabled. Connect Composio once in DGC Settings, then return here. No second sign-in is needed for a Pip.</p>';renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function chooseAppAccount(server){
 if(remoteHost||S.apiVersion<29||!personalPip()||!usable())return;
 openReview({title:'Choose app access',description:'Loading account identities and supported read tools. No app contents are fetched.',readOnly:true,body:'<p class="muted">Checking the existing connection…</p>',request:{type:'list_pip_accounts',server}});
 const ticket=S.review;
 try{const [discovery,inspection]=await Promise.all([send('list_pip_accounts',{server}),send('inspect_pip_connection',{server})]);if(S.review!==ticket||ticket.scope!==scope())return;
 const choices=accountChoices(server,discovery,inspection).filter(c=>S.apiVersion>=39||!extraReadTools.includes(c.tool));
 if(!choices.length){ticket.description='No selectable accounts were returned.';ticket.body='<p>This endpoint must return active, stable account IDs and a supported read tool. Open Connect Apps in Composio, then refresh here. DGC will not guess an account or start another sign-in.</p>';renderReview();return;}
 ticket.readOnly=false;ticket.confirm='Prepare review';ticket.appPicker={server,fingerprint:discovery.connection_digest,choices};ticket.description='Choose exactly what this Pip can read. This prepares a saved proposal; access changes only after you accept that proposal.';
 ticket.body=`<div class="form"><label for="app-account">Account and app</label><select id="app-account"><option value="">Choose an account…</option>${choices.map((c,i)=>`<option value="${i}">${esc(appLabels[c.toolkit])} · ${esc(c.label)} · …${esc(c.id.slice(-6))}</option>`).join('')}</select><p id="app-read-notice" class="muted"></p><label id="app-query-label" for="app-query">Search query (optional)</label><input id="app-query" maxlength="1024" placeholder="For example: is:unread"><label for="app-limit">Maximum items per run</label><input id="app-limit" type="number" min="1" max="20" value="5"><div id="app-calendar-window" hidden>${S.apiVersion>=33?`<label for="app-window-mode">Calendar window</label><select id="app-window-mode"><option value="fixed">Fixed dates</option><option value="calendar_days">Move with each run</option></select><div id="app-relative-window" hidden><label for="app-window-zone">Timezone</label><input id="app-window-zone" value="${esc(defaultZone)}" maxlength="100"><label for="app-window-start">Start day (0 means today)</label><input id="app-window-start" type="number" min="0" max="30" value="0"><label for="app-window-days">Number of calendar days</label><input id="app-window-days" type="number" min="1" max="31" value="1"><p class="muted">From midnight in this timezone on the day this run reads the calendar, through the end of the selected days. A delayed run uses its actual read day. No calendar changes are permitted.</p></div>`:''}<div id="app-fixed-window"><label for="app-start">Calendar start (${esc(defaultZone)})</label><input id="app-start" type="datetime-local"><label for="app-end">Calendar end (${esc(defaultZone)})</label><input id="app-end" type="datetime-local"><p class="muted">This is an exact date range. It will not move forward automatically on scheduled runs.</p></div></div></div><p>App content goes to ${esc(modelLabel(S.pip.model_choice))} as reference data. Sending and changing app data are not granted.</p>${S.pip.app_plan?'<label for="app-plan-mode">Existing app reads</label><select id="app-plan-mode"><option value="replace">Replace existing reads</option><option value="add">Add to existing reads</option></select><p class="muted">The final review shows both versions. Up to four reads from the same connection.</p>':''}<p id="app-picker-error" role="alert" class="error"></p>`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
function prepareAppReview(review){
 try{const draft={query:$('app-query').value,limit:$('app-limit').value,start:$('app-start').value,end:$('app-end').value,windowMode:$('app-window-mode')?.value,startDay:$('app-window-start')?.value,days:$('app-window-days')?.value,timezone:$('app-window-zone')?.value};const p=review.appPicker;
 let plan=accountReadPlan(p.server,p.fingerprint,p.choices,$('app-account').value,draft);if($('app-plan-mode')?.value==='add')plan=combineReadPlans(appReadPlan(S.pip.app_plan),plan);appReadPlan(plan);
 void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{app_plan:plan},reason:'User selected a connected account and exact read scope.'},result=>{S.pip={...S.pip,proposals:[...(S.pip.proposals||[]),result.proposal]};proposalReview(result.proposal.id);});
 }catch(error){$('app-picker-error').textContent=errorText(error);}
}
const canReviewMessages=()=>!remoteHost&&S.apiVersion>=31&&personalPip()&&usable();
async function loadEmailDrafts(calendar=false){
 if(!calendar&&S.apiVersion>=37)void loadConnectorDrafts();
 if(!calendar&&S.apiVersion>=35)void loadEmailDrafts(true);
 if(remoteHost||S.apiVersion<(calendar?35:32)||!personalPip()||!usable())return;const token=scope(),sequence=calendar?++calendarDraftSeq:++emailDraftSeq;
 try{const answer=emailDraftsPage(await send(calendar?'list_pip_calendar_drafts':'list_pip_message_drafts',{pip_id:S.selected,limit:20}),S.selected,S.workspace.id,calendar);if(token!==scope()||sequence!==(calendar?calendarDraftSeq:emailDraftSeq))return;S[calendar?'calendarDrafts':'emailDrafts']=answer.drafts;S[calendar?'calendarDraftError':'emailDraftError']='';render();}catch(error){if(token===scope()&&sequence===(calendar?calendarDraftSeq:emailDraftSeq)){S[calendar?'calendarDraftError':'emailDraftError']=errorText(error);render();}}
}
function emailDraftCards(){
 if(remoteHost||S.apiVersion<32||!personalPip())return '';
 return [...(S.emailDrafts||[]),...(S.apiVersion>=35?S.calendarDrafts||[]:[]),...(S.apiVersion>=37?S.connectorDrafts||[]:[])].filter(d=>d.status==='pending'&&!d.expired).map(d=>{const label=d.id.startsWith('conndraft_')?'Connector draft':d.id.startsWith('caldraft_')?'Calendar draft':'Email draft';return `<div class="chat-setup-review" aria-label="${label}"><span class="chat-setup-label">${label} <small>${esc(d.subject)}</small></span><button type="button" data-email-draft="${esc(d.id)}"${S.busy?' disabled':''}>Review</button></div>`;}).join('')+(S.emailDraftError?errorMarkup(S.emailDraftError):'')+(S.calendarDraftError?errorMarkup(S.calendarDraftError):'')+(S.connectorDraftError?errorMarkup(S.connectorDraftError):'');
}
async function openEmailDraft(id){
 if(id.startsWith('conndraft_')){await openConnectorDraft(id);return;}
 const calendar=id.startsWith('caldraft_');
 if(remoteHost||S.apiVersion<(calendar?35:32)||!personalPip()||!usable())return;
 const command=calendar?'get_pip_calendar_draft':'get_pip_message_draft';
 openReview({title:calendar?'Calendar draft':'Email draft',description:'Loading the saved draft. No external action is performed.',readOnly:true,body:'<p>Loading…</p>',request:{type:command,draft_id:id}});const ticket=S.review;
 try{const value=emailDraft((await send(command,{draft_id:id})).draft,S.selected,S.workspace.id,calendar);if(S.review!==ticket||ticket.scope!==scope())return;if(value.id!==id)throw Error('The returned draft does not match this review.');
 if(value.status==='prepared'){await openMessageReview(value.action_id);return;}
 const available=value.status==='pending'&&!value.expired&&!archived();ticket.emailDraft=value;ticket.calendarAction=calendar;ticket.readOnly=!available;ticket.confirm=calendar?'Choose calendar account':'Choose sending account';ticket.description=available?'This is an editable draft. Choose a connected account next; the external action still needs a separate approval.':value.expired?'This draft has expired. Ask for a new draft.':'This draft was dismissed.';
 const e=value.payload.event;
 ticket.body=calendar?`<dl class="meta"><dt>Title</dt><dd>${esc(e.summary)}</dd><dt>Start</dt><dd>${esc(e.start_datetime)}</dd><dt>End</dt><dd>${esc(e.end_datetime)}</dd><dt>Time zone</dt><dd>${esc(e.timezone)}</dd>${calendarExtras(e)}</dl><pre class="message-review-body">${esc(e.description)}</pre><p class="muted">No account selected. No event created. Edit these details after choosing an account.</p>`:`<dl class="meta"><dt>To</dt><dd>${esc(value.payload.message.recipient_email)}</dd><dt>Subject</dt><dd>${esc(value.payload.message.subject)}</dd></dl><pre class="message-review-body">${esc(value.payload.message.body)}</pre><p class="muted">No sending account selected. Nothing sent.</p>`;
 ticket.body+=available?'<button type="button" id="dismiss-email-draft">Dismiss draft</button>':'';renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function emailDraftHistory(before=null,calendar=false){
 if(remoteHost||S.apiVersion<(calendar?35:32)||!personalPip()||!usable())return;
 const command=calendar?'list_pip_calendar_drafts':'list_pip_message_drafts';
 openReview({title:calendar?'Calendar drafts':'Email drafts',description:'Model-written drafts. Account selection and external actions need your review.',readOnly:true,body:'<p>Loading…</p>',request:{type:command,pip_id:S.selected}});const ticket=S.review;
 try{const page=emailDraftsPage(await send(command,{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id,calendar);if(S.review!==ticket||ticket.scope!==scope())return;
 ticket.body=page.drafts.length?page.drafts.map(d=>`<article class="entry"><button type="button" data-email-draft="${esc(d.id)}">${esc(d.subject)}</button><p class="muted">${d.expired?'Expired':d.status==='prepared'?'Action review prepared':d.status==='dismissed'?'Dismissed':'Needs your review'}</p></article>`).join(''):'<p>No drafts. Ask this Pip to draft '+(calendar?'a calendar event with exact dates, times and time zone.':'an email and provide the recipient address.')+'</p>';if(page.next_cursor)ticket.body+=`<button type="button" data-${calendar?'calendar':'email'}-draft-more="${esc(page.next_cursor)}">Older drafts</button>`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}

function calendarExtras(e){
 const d=calendarDetails(e);
 return `<dt>Guests</dt><dd>${esc(d.guests)}</dd><dt>Repeat</dt><dd>${esc(d.repeat)}</dd><dt>Invitations</dt><dd>${esc(d.notifications)}</dd>`;
}
function calendarExtraFields(e={}){
 if(S.apiVersion<38)return '';
 return `<label for="calendar-guests">Guest email addresses (up to ten, one per line)</label><textarea id="calendar-guests" rows="3">${esc((e.attendees||[]).join('\n'))}</textarea><label class="check-field" for="calendar-invite"><input type="checkbox" id="calendar-invite" ${e.send_invitations?'checked':''}> Send invitations to these guests</label><label for="calendar-repeat">Repeat</label><select id="calendar-repeat">${[['','Does not repeat'],['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']].map(([v,label])=>`<option value="${v}" ${(e.repeat?.frequency||'')===v?'selected':''}>${label}</option>`).join('')}</select><label for="calendar-interval">Every (periods, for repeats)</label><input id="calendar-interval" type="number" min="1" max="12" value="${esc(e.repeat?.interval||1)}"><label for="calendar-count">Occurrences, including the first (for repeats)</label><input id="calendar-count" type="number" min="2" max="52" value="${esc(e.repeat?.count||'')}">`;
}
function readCalendarExtras(){
 if(S.apiVersion<38)return {};
 const attendees=$('calendar-guests').value.trim().split('\n').map(s=>s.trim()).filter(Boolean),frequency=$('calendar-repeat').value;
 // Preserve the original simple-event shape when the user has not requested additions.
 if(!attendees.length&&!frequency&&!$('calendar-invite').checked)return {};
 return {attendees,send_invitations:$('calendar-invite').checked,repeat:frequency?{frequency,interval:Number($('calendar-interval').value),count:Number($('calendar-count').value)}:null};
}
function showCalendarReview(a){
 const p=a.payload,e=p.event,pending=a.status==='pending';if(extendedCalendar(e)&&S.apiVersion<38)throw Error('Calendar invitations and series need Pips API 38. Reload with the updated backend.');
 openReview({title:pending?'Review calendar event':a.status==='succeeded'?'Calendar event created':messageStates[a.status],description:pending?'Approval creates this exact event or finite series, with the listed invitations. It grants no permission to create further events.':a.status==='succeeded'?'Google Calendar confirmed the reviewed event or series. Invitation delivery and acceptance are not confirmed.':['unknown','dispatching'].includes(a.status)?'Creation is unconfirmed. Check the calendar or Composio log before preparing another event. DGC will not retry this action.':'This review cannot create an event.',readOnly:!pending,blocked:archived(),confirm:calendarDetails(e).confirm,expiresAt:a.expires_at,messageAction:a.id,messageDigest:a.digest,
 body:`<dl class="meta"><dt>Connection</dt><dd>${esc(p.server)}</dd><dt>Account</dt><dd>${esc(p.account)}</dd><dt>Calendar</dt><dd>Primary</dd><dt>Title</dt><dd>${esc(e.summary)}</dd><dt>Start</dt><dd>${esc(e.start_datetime)}</dd><dt>End</dt><dd>${esc(e.end_datetime)}</dd><dt>Time zone</dt><dd>${esc(e.timezone)}</dd>${calendarExtras(e)}</dl><pre class="message-review-body">${esc(e.description)}</pre><p class="muted">Private and busy; invitees can see event details. No meeting link. The provider expands repeats in the named time zone; invalid dates or local times may be skipped. Calendar reminders, sharing and administrator access still apply. Review expires ${esc(date(a.expires_at))}.</p>${pending?'<button type="button" id="reject-message-review">Reject event</button>':''}`,always:pending,request:{type:'accept_pip_app_action',action_id:a.id,expected_digest:a.digest}});
}
async function loadConnectorDrafts(){
 if(remoteHost||S.apiVersion<37||!personalPip()||!usable())return;const token=scope(),seq=++connectorDraftSeq;
 try{const result=connectorDraftsPage(await send('list_pip_connector_drafts',{pip_id:S.selected,limit:20}),S.selected);if(token!==scope()||seq!==connectorDraftSeq)return;S.connectorDrafts=result.drafts;S.connectorDraftError='';render();}catch(error){if(token===scope()&&seq===connectorDraftSeq){S.connectorDraftError=errorText(error);render();}}
}
async function openConnectorDraft(id){
 if(remoteHost||S.apiVersion<37||!personalPip()||!usable())return;
 openReview({title:'Connector draft',description:'Loading the saved draft. Nothing is being executed.',readOnly:true,body:'<p>Loading…</p>',request:{type:'get_pip_connector_draft',draft_id:id}});const ticket=S.review;
 try{const d=connectorDraft((await send('get_pip_connector_draft',{draft_id:id})).draft,S.selected,S.workspace.id);if(S.review!==ticket||ticket.scope!==scope())return;if(d.id!==id)throw Error('The saved draft identity changed.');if(d.status==='prepared'){await openMessageReview(d.action_id);return;}
 const available=d.status==='pending'&&!d.expired&&!archived();ticket.readOnly=!available;ticket.confirm='Edit and prepare review';ticket.savedConnectorDraft=d;ticket.sourceRun=d.source_run_id;ticket.connectorSummary=d.payload.action.call.arguments;
 ticket.description=available?'Model-prepared inputs. Review and edit them before saving a separate Run once approval.':d.expired?'This draft expired. Ask for another draft.':'This draft was dismissed.';
 ticket.body=`<dl class="meta"><dt>Connection</dt><dd>${esc(d.payload.action.server)}</dd><dt>Tool</dt><dd>${esc(d.payload.action.call.tool)}</dd></dl><div id="connector-review-values"></div><p class="muted">The connector manages its account and defaults. Nothing has run.</p>${available?'<button type="button" id="dismiss-connector-draft">Dismiss draft</button>':''}`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function connectorDraftHistory(before=null){
 if(remoteHost||S.apiVersion<37||!personalPip()||!usable())return;
 openReview({title:'Connector drafts',description:'Model-prepared actions. Each needs a separate review before execution.',readOnly:true,body:'<p>Loading…</p>',request:{type:'list_pip_connector_drafts',pip_id:S.selected}});const ticket=S.review;
 try{const page=connectorDraftsPage(await send('list_pip_connector_drafts',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected);if(S.review!==ticket||ticket.scope!==scope())return;
 ticket.body=page.drafts.length?page.drafts.map(d=>`<article class="entry"><button type="button" data-email-draft="${esc(d.id)}">${esc(d.subject)}</button><p class="muted">${d.expired?'Expired':d.status==='prepared'?'Action review prepared':d.status==='dismissed'?'Dismissed':'Needs your review'}</p></article>`).join(''):'<p>No connector drafts. Ask this Pip to prepare an action using your connected tools.</p>';ticket.connectorCursor=page.next_cursor;if(page.next_cursor)ticket.body+='<button type="button" id="connector-drafts-more">Older drafts</button>';renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function chooseConnectorConnection(){
 if(!canReviewMessages()||S.apiVersion<36||archived()||S.run?.status!=='succeeded'||S.run.manifest?.run_kind!=='personal_task')return;
 openReview({title:'Use a connected tool',description:'Choose a saved connection. You will review the tool and exact inputs before approving one attempt.',readOnly:true,body:'<p>Loading connections…</p>',request:{type:'list_pip_connections'}});
 const ticket=S.review;ticket.sourceRun=S.run.id;
 try{const answer=await send('list_pip_connections');if(S.review!==ticket||ticket.scope!==scope())return;
 if(!Array.isArray(answer.connections))throw Error('Connections could not be loaded.');
 const choices=answer.connections.filter(c=>c?.enabled===true&&c.pip_action_adapter===true&&['zapier','arcade','make','n8n'].includes(c.name));
 ticket.body=choices.length?'<div class="actions">'+choices.map(c=>`<button type="button" data-connector-connection="${esc(c.name)}">${esc(c.provider||c.name)}</button>`).join('')+'</div>':'<p>Connect Zapier, Arcade, Make or n8n once in DGC Settings, then return here. Your existing connection is reused.</p>';renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function chooseConnectorTool(server,savedDraft=null){
 if(S.apiVersion<36||!canReviewMessages()||!S.review?.sourceRun)return;
 const source=S.review.sourceRun;
 openReview({title:'Choose a tool',description:'Reading the connector’s tool descriptions. No tool is being called.',readOnly:true,body:'<p>Loading tools…</p>',request:{type:'inspect_pip_connector_actions',server}});
 const ticket=S.review;
 try{const inspection=connectorInspection(await send('inspect_pip_connector_actions',{server}),server);if(S.review!==ticket||ticket.scope!==scope())return;
 if(!inspection.tools.length){ticket.body='<p>No tools are exposed. Choose tools or workflows in the connector, then return here.</p>';renderReview();return;}
 if(savedDraft){const a=savedDraft.payload.action;inspection.tools=inspection.tools.filter(t=>t.tool===a.call.tool&&t.schema_digest===a.schema_digest);if(inspection.connection_digest!==a.connection_digest||inspection.tools.length!==1)throw Error('The saved connector or tool changed. Ask for a fresh draft.');}
 ticket.connectorForm={source,inspection,key:window.crypto.randomUUID(),selected:0,inputs:inspection.tools.map(t=>createConnectorInputs(t.input_schema,savedDraft?.payload.action.call.arguments)),savedDraft};ticket.readOnly=false;ticket.confirm='Save for review';ticket.description='Choose a tool and enter its exact inputs. Saving does not run it.';
 ticket.body=`<div class="form"><label for="connector-tool">Tool</label><select id="connector-tool">${inspection.tools.map((t,i)=>`<option value="${i}">${esc(t.tool)}</option>`).join('')}</select><p id="connector-description" class="muted"></p><div id="connector-fields"></div><details><summary>Tool descriptions and input schemas</summary>${inspection.tools.map(t=>`<h3>${esc(t.tool)}</h3><p>${esc(t.description)}</p><pre>${esc(JSON.stringify(t.input_schema,null,2))}</pre>`).join('')}</details></div><p class="muted">The connector controls its accounts, defaults and workflow contents. Check them before approving. This grants one call, not recurring access.</p><p id="connector-error" class="error" role="alert"></p>`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
function prepareConnector(review){
 try{const form=review.connectorForm,index=$('connector-tool').value;if(!/^\d{1,3}$/.test(index)||!form.inspection.tools[Number(index)])throw Error('Choose a tool.');
 const tool=form.inspection.tools[Number(index)],call=connectorCall({tool:tool.tool,arguments:readConnectorInputs(form.inputs[Number(index)])});
 const fingerprint=JSON.stringify(call);if(form.fingerprint&&form.fingerprint!==fingerprint)form.key=window.crypto.randomUUID();form.fingerprint=fingerprint;
 const expected={source_run_id:form.source,server:form.inspection.server,connection_digest:form.inspection.connection_digest,schema_digest:tool.schema_digest,call};
 const request=form.savedDraft?{type:'prepare_pip_connector_draft',draft_id:form.savedDraft.id,expected_digest:form.savedDraft.digest,call}:{type:'propose_pip_connector_action',...expected,request_key:form.key};
 void mutate(request,result=>showMessageReview(messageReview(result.action,S.selected,S.workspace.id,expected)));
 }catch(error){$('connector-error').textContent=errorText(error);}
}
function showConnectorReview(a){
 const p=a.payload,pending=a.status==='pending';
 openReview({title:pending?'Review connector action':actionStatus(a),description:pending?'Run once authorizes this exact call. The connector controls the account and workflow contents. Check those in its dashboard before approving.':a.status==='succeeded'?a.receipt.meaning:['unknown','dispatching'].includes(a.status)?'The action may still be running at the provider. DGC will not retry an uncertain attempt.':'This review is closed. No further attempt can be approved.',readOnly:!pending,blocked:archived(),confirm:'Run once',expiresAt:a.expires_at,messageAction:a.id,messageDigest:a.digest,connectorSummary:p.call.arguments,
 body:`<dl class="meta"><dt>Connection</dt><dd>${esc(p.server)}</dd><dt>Tool</dt><dd>${esc(p.call.tool)}</dd><dt>Account</dt><dd>Managed by this connection</dd></dl><div id="connector-review-values"></div><details><summary>Exact inputs (JSON)</summary><pre class="message-review-body">${esc(JSON.stringify(p.call.arguments,null,2))}</pre></details><p class="muted">One call only. A workflow can keep running after DGC times out. No automatic retry.</p>${a.receipt?.response_preview?`<h3>Connector response</h3><pre>${esc(a.receipt.response_preview)}</pre>`:''}${pending?'<button type="button" id="reject-message-review">Reject action</button>':''}`,always:pending,request:{type:'accept_pip_app_action',action_id:a.id,expected_digest:a.digest}});
}
async function chooseMessageConnection(savedDraft=null,calendar=false){
 if(calendar&&S.apiVersion<34)return;
 if(!canReviewMessages()||archived())return;
 if(savedDraft){emailDraft(savedDraft,S.selected,S.workspace.id,calendar);if(S.apiVersion<(calendar?35:32)||savedDraft.expired||savedDraft.status!=='pending')return;}else if(S.run?.status!=='succeeded'||S.run.manifest?.run_kind!=='personal_task')return;
 openReview({title:calendar?'Prepare a calendar event':'Prepare an email',description:calendar?'Choose an existing connection. Nothing is created until you review and approve the saved event.':'Choose an existing connection. Nothing is sent until you review and approve the saved message.',readOnly:true,body:'<p>Loading connections…</p>',request:{type:'list_pip_connections'}});
 const ticket=S.review;ticket.sourceRun=savedDraft?.source_run_id||S.run.id;ticket.savedEmailDraft=savedDraft;ticket.calendarAction=calendar;
 try{const answer=await send('list_pip_connections');if(S.review!==ticket||ticket.scope!==scope())return;
 if(!Array.isArray(answer.connections))throw Error('Connections could not be loaded.');
 const choices=answer.connections.filter(c=>c?.enabled===true&&c.pip_read_adapter===true&&typeof c.name==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(c.name));
 ticket.body=choices.length?'<div class="actions">'+choices.map(c=>`<button type="button" data-message-connection="${esc(c.name)}">${esc(c.provider||c.name)} · ${esc(c.name)}</button>`).join('')+'</div>':'<p>No supported connection is enabled. Connect Composio once in DGC Settings, then return here.</p>';renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function chooseMessageAccount(server){
 if(!canReviewMessages()||!S.review?.sourceRun)return;const source=S.review.sourceRun,savedDraft=S.review.savedEmailDraft,calendar=S.review.calendarAction;
 const inspectionCommand=calendar?'inspect_pip_calendar_connection':'inspect_pip_send_connection';
 openReview({title:calendar?'Prepare a calendar event':'Prepare an email',description:calendar?'Checking account identities and the supported calendar tool. This does not read or create events.':'Checking account identities and the supported send tool. This does not read or send email.',readOnly:true,body:'<p>Checking connection…</p>',request:{type:inspectionCommand,server}});
 const ticket=S.review;
 try{const [discovery,inspection]=await Promise.all([send('list_pip_accounts',{server}),send(inspectionCommand,{server})]);if(S.review!==ticket||ticket.scope!==scope())return;
 const choices=(calendar?calendarAccounts:sendAccounts)(server,discovery,inspection);
 if(!choices.length){ticket.body='<p>No supported '+(calendar?'Google Calendar':'Gmail')+' account was returned. Connect an account in Composio. DGC will not choose a default account.</p>';renderReview();return;}
 ticket.messageForm={source,server,fingerprint:discovery.connection_digest,choices,key:window.crypto.randomUUID(),savedDraft,calendar};ticket.readOnly=false;ticket.confirm='Save for review';ticket.description='Edit the exact plain-text message. Saving prepares a review; it does not send.';
 ticket.body=`<div class="form"><label for="message-account">Gmail account</label><select id="message-account"><option value="">Choose an account…</option>${choices.map((c,i)=>`<option value="${i}">${esc(c.label)} · ${esc(c.id)}</option>`).join('')}</select><label for="message-recipient">To</label><input id="message-recipient" type="email" autocomplete="off" maxlength="254" value="${esc(savedDraft?.payload.message?.recipient_email||'')}"><label for="message-subject">Subject</label><input id="message-subject" maxlength="200" value="${esc(savedDraft?.payload.message?.subject||'')}"><label for="message-body">Message</label><textarea id="message-body" rows="8" maxlength="12000">${esc(savedDraft?.payload.message?.body||'')}</textarea></div><p class="muted">One recipient. Plain text only. No attachments, CC or BCC. The review expires in 24 hours.</p><p id="message-form-error" role="alert" class="error"></p>`;
 if(calendar){ticket.description='Prepare one event in the selected account’s primary calendar. Creating it needs a separate approval.';ticket.body=`<div class="form"><label for="message-account">Google Calendar account</label><select id="message-account"><option value="">Choose an account…</option>${choices.map((c,i)=>`<option value="${i}">${esc(c.label)} · ${esc(c.id)}</option>`).join('')}</select><label for="calendar-summary">Title</label><input id="calendar-summary" maxlength="200" value="${esc(savedDraft?.payload.event?.summary||'')}"><label for="calendar-start">Start, including UTC offset</label><input id="calendar-start" value="${esc(savedDraft?.payload.event?.start_datetime||'')}" placeholder="2026-12-01T11:00:00+05:30"><label for="calendar-end">End, including UTC offset</label><input id="calendar-end" value="${esc(savedDraft?.payload.event?.end_datetime||'')}" placeholder="2026-12-01T11:30:00+05:30"><label for="calendar-zone">IANA time zone</label><input id="calendar-zone" value="${esc(savedDraft?.payload.event?.timezone||'')}" placeholder="Asia/Kolkata"><label for="calendar-description">Description</label><textarea id="calendar-description" maxlength="8000" rows="5">${esc(savedDraft?.payload.event?.description||'')}</textarea>${calendarExtraFields(savedDraft?.payload.event)}</div><p class="muted">The exact guests and any finite series appear in the next review. Invitations require the checkbox above. No meeting link. Existing calendar reminders, sharing and administrator access still apply.</p><p id="message-form-error" role="alert" class="error"></p>`;}renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
function prepareMessage(review){
 try{const form=review.messageForm,selection=$('message-account').value;if(!/^\d{1,2}$/.test(selection)||!form.choices[Number(selection)])throw Error(form.calendar?'Choose the calendar account.':'Choose the sending account.');const choice=form.choices[Number(selection)];
 const message=form.calendar?calendarDraft({summary:$('calendar-summary').value.trim(),description:$('calendar-description').value.trim(),start_datetime:$('calendar-start').value.trim(),end_datetime:$('calendar-end').value.trim(),timezone:$('calendar-zone').value.trim(),...readCalendarExtras()}):messageDraft({recipient_email:$('message-recipient').value.trim(),subject:$('message-subject').value.trim(),body:$('message-body').value.trim()});
 const fingerprint=JSON.stringify({account:choice.id,message});if(form.fingerprintOfDraft&&form.fingerprintOfDraft!==fingerprint)form.key=window.crypto.randomUUID();form.fingerprintOfDraft=fingerprint;
 const request={...(form.savedDraft?{type:form.calendar?'prepare_pip_calendar_draft':'prepare_pip_message_draft',draft_id:form.savedDraft.id,expected_digest:form.savedDraft.digest}:{type:form.calendar?'propose_pip_calendar_action':'propose_pip_app_action',source_run_id:form.source,request_key:form.key}),server:form.server,connection_digest:form.fingerprint,account:choice.id,schema_digest:choice.schema_digest,[form.calendar?'event':'message']:message};
 // Keep typed fields on a failed save: mutate's loading render reconstructs the dialog.
 for(const element of document.querySelectorAll('.dialog .form input,.dialog .form select,.dialog .form textarea')){if(element.tagName==='SELECT'){for(const option of element.options)option.toggleAttribute('selected',option.selected);}else if(element.tagName==='TEXTAREA')element.textContent=element.value;else if(element.type==='checkbox')element.toggleAttribute('checked',element.checked);else element.setAttribute('value',element.value);}
 review.body=document.querySelector('[role=dialog] .form').outerHTML+'<p class="muted">Saving this review does not perform an external action.</p><p id="message-form-error" role="alert" class="error"></p>';
 void mutate(request,result=>showMessageReview(messageReview(result.action,S.selected,S.workspace.id,{...request,source_run_id:form.source})));
 }catch(error){$('message-form-error').textContent=errorText(error);}
}
function showMessageReview(value){
 const a=messageReview(value,S.selected,S.workspace.id),p=a.payload,pending=a.status==='pending';
 if(p.kind==='connector_call'){showConnectorReview(a);return;}
 if(p.kind==='calendar_create'){showCalendarReview(a);return;}
 openReview({title:pending?'Review email':messageStates[a.status],description:pending?'Send once authorizes one attempt with this exact account, recipient and message. It does not grant future sending permission.':a.status==='succeeded'?'Gmail accepted the message. Delivery to the recipient is not confirmed.':['unknown','dispatching'].includes(a.status)?'Delivery is unconfirmed. DGC will not retry this action. Check Gmail Sent or the Composio log before preparing another message.':'This review cannot send a message.',readOnly:!pending,blocked:archived(),confirm:'Send once',expiresAt:a.expires_at,messageAction:a.id,messageDigest:a.digest,
 body:`<dl class="meta"><dt>Connection</dt><dd>${esc(p.server)}</dd><dt>Account</dt><dd>${esc(p.account)}</dd><dt>To</dt><dd>${esc(p.message.recipient_email)}</dd><dt>Subject</dt><dd>${esc(p.message.subject)}</dd></dl><pre class="message-review-body">${esc(p.message.body)}</pre><p class="muted">No CC, BCC, attachments or HTML. Source job v${p.source.job_version}. Review expires ${esc(date(a.expires_at))}.</p>${pending?'<button type="button" id="reject-message-review">Reject message</button>':''}<details><summary>Saved review details</summary><p class="mono">${esc(a.id)}</p><p class="mono">${esc(a.digest)}</p></details>`,always:pending,request:{type:'accept_pip_app_action',action_id:a.id,expected_digest:a.digest}});
}
async function openMessageReview(id){
 if(!canReviewMessages())return;
 openReview({title:'External action review',description:'Loading the exact saved action.',readOnly:true,body:'<p>Loading…</p>',request:{type:'get_pip_app_action',action_id:id}});const ticket=S.review;
 try{const answer=await send('get_pip_app_action',{action_id:id});if(S.review!==ticket||ticket.scope!==scope())return;if(answer.action?.id!==id)throw Error('The returned review does not match the selected action.');showMessageReview(answer.action);}catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function messageReviews(before=null){
 if(!canReviewMessages())return;
 openReview({title:'External action reviews',description:'Preparing and performing an external action are separate decisions. A completed Pip run never performs one automatically.',readOnly:true,body:'<p>Loading reviews…</p>',request:{type:'list_pip_app_actions',pip_id:S.selected}});const ticket=S.review;
 try{const answer=messageHistory(await send('list_pip_app_actions',{pip_id:S.selected,...(before?{before_id:before}:{}),limit:20}),S.selected);if(S.review!==ticket||ticket.scope!==scope())return;
 ticket.body=answer.actions.length?answer.actions.map(a=>`<article class="entry"><button type="button" data-message-review="${esc(a.id)}">${esc(a.subject)}</button><p class="muted">${esc(a.recipient)} · ${esc(actionStatus(a))}</p></article>`).join(''):'<p>No external action reviews yet. Open a completed Personal result to prepare an email or calendar event.</p>';
 if(answer.next_cursor)ticket.body+=`<button type="button" data-message-more="${esc(answer.next_cursor)}">Older reviews</button>`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}

function closeReview() { if(computerViewTimer){clearInterval(computerViewTimer);computerViewTimer=null;} const wasOpen=!!S.review;S.review=null;$('review-root').innerHTML='';$('app').inert=false; if(wasOpen) render(); if(dialogReturn) { const target=dialogReturn.id?$(dialogReturn.id):[...document.querySelectorAll('button')].find(b=>Object.entries(dialogReturn.data).some(([k,v])=>b.dataset[k]===v)); target?.focus({preventScroll:true}); } }
function openReview(review) { dialogReturn={id:document.activeElement?.id||'',data:{...document.activeElement?.dataset}}; S.review={...review,scope:scope(),request:JSON.parse(JSON.stringify(review.request)),error:''}; render(); renderReview(); }
const reviewBlocked=r=>!!r.blocked || (r.setup&&(S.apiVersion<23||r.setup.pip_type==='pulse'&&S.apiVersion<27)) || (r.requiresCommitPaths&&S.apiVersion<22) || (r.requiresPulsePlan&&S.apiVersion<21) || (r.requiresQuillAutomation&&S.apiVersion<20) || (r.requiresSessionTurn&&S.apiVersion<18) || (r.commandOutcome&&S.apiVersion<17) || (r.requiresSpecialists&&S.apiVersion<15) || (r.requiresExecution&&S.executionCapability?.available!==true) || (r.expiresAt && Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt)<=Date.now());
function renderReview() {
  const r=S.review;if(!r)return;
  $('app').inert=true;
  $('review-root').innerHTML=`<div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">${esc(r.title)}</h2><p>${esc(r.description)}</p>${r.body||''}${r.reasonRequired&&r.note?`<label>${esc(r.note)}<textarea id="findingReviewReason" data-draft="findingReviewReason"${S.busy?' disabled':''}>${esc(draft.findingReviewReason)}</textarea></label>`:''}${r.memoryRecord?`<label>Optional expiry, with time zone<input id="memoryExpiry" data-draft="memoryExpiry" value="${esc(draft.memoryExpiry)}" placeholder="2026-12-01T09:00:00Z"${S.busy?' disabled':''}></label><p class="muted">Leave empty for no automatic expiry. The source and job scope stay explicit.</p>`:''}${errorMarkup(r.error)}<div class="actions">${r.secondary?button(r.secondary.id,r.secondary.label,S.busy||!usable(),'secondary-action'):''}${button('review-cancel',r.readOnly?'Close':'Cancel',S.busy)}${r.always&&!r.readOnly&&S.apiVersion>=41?button('review-always','Always allow',S.busy||!usable()||reviewBlocked(r)):''}${r.readOnly?'':button('review-confirm',S.busy?'Applying…':r.confirm,S.busy||!usable()||reviewBlocked(r),r.danger?'danger':'primary')}</div></section></div>`;
  if(r.connectorSummary)mountConnectorSummary($('connector-review-values'),r.connectorSummary);
  if(r.connectorForm){
    const form=r.connectorForm,select=$('connector-tool');select.value=String(form.selected);select.disabled=S.busy;
    const mount=()=>{$('connector-description').textContent=form.inspection.tools[form.selected].description;mountConnectorInputs($('connector-fields'),form.inputs[form.selected],S.busy);};
    select.addEventListener('change',()=>{const index=Number(select.value);if(Number.isSafeInteger(index)&&form.inspection.tools[index]){form.selected=index;mount();}});mount();
  }
  $('review-title')?.focus({preventScroll:true});document.querySelector('[role=dialog]')?.scrollTo?.(0,0);
}
function clearSelection() { S.editingGoal=false;S.quickDirty=false;connectorDraftSeq++;S.connectorDrafts=[];S.connectorDraftError=""; calendarDraftSeq++;S.calendarDrafts=[];S.calendarDraftError="";emailDraftSeq++;S.emailDrafts=[];S.emailDraftError=""; chatActivities.clear(); S.composerPanel='';S.chatControls=null;S.continuity=null;draft.chatModelSearch=''; statementSeq++;statementAnchorSeq++;statementRows=[];statementPage=null;statementLoaded=false;statementLoading=false;statementError='';statementInspecting=false;statementRetry=null;draft.statementKind='fact';draft.statementTitle='';draft.statementText='';draft.statementReason='';draft.statementExpiry='';draft.statementSource=''; memorySeq++;memorySourceSeq++;memories=[];memoryCursor=null;memoryLoaded=false;memoryLoading=false;memoryError='';draft.memoryExpiry='';resetOutcomes(); S.sourceDirty=false;S.sourceDraftVersion=null;draft.sourceReason=''; adaptationSeq++;S.adaptations=[];S.adaptationCursor=null;S.adaptationsLoaded=false;S.adaptationsLoading=false;S.adaptationsError='';S.adaptationDirty=false;S.adaptationDraftVersion=null;draft.adaptationReason='';handoffSeq++;handoffDetailSeq++;S.handoffs=[];S.handoffCursor=null;S.handoffsLoaded=false;S.handoffsLoading=false;S.handoffsError='';S.handoffDraft=null;checkpointSeq++;S.checkpoints=[];S.checkpointCursor=null;S.checkpointsLoaded=false;S.checkpointsLoading=false;S.checkpointsError='';draft.findingReviewReason='';selectionGeneration++;if(S.selected)chatDrafts.set(S.selected,draft.chatText);messageSeq++;streamSeq++;streamLoading=false;S.stream=null;S.messages=[];S.messageCursor=null;S.messagesLoaded=false;S.messagesLoading=false;S.messagesError='';S.chatActiveRun=null;S.omitted=0;S.modelDirty=false;draft.modelReason='';S.busy=false;approvalSeq++;S.approvals=[];S.approvalCursor=null;S.approvalsLoaded=false;S.approvalsLoading=false;S.approvalsError='';S.scheduleDirty=false;S.scheduleDraftVersion=null;draft.scheduleReason=''; activitySeq++;S.activity=null;S.activityLoading=false;S.activityError=''; selectionSeq++;detailSeq++;historySeq++;S.pip=null;S.runs=[];S.run=null;S.runId='';S.versions=[];S.cursor=null;S.historyLoaded=false;draft.revisionGoal='';draft.revisionReason='';closeReview(); }
async function loadRun(id) {
  if(id!==S.runId){activitySeq++;S.activity=null;S.activityLoading=false;S.activityError='';}
  S.runId=id;const sequence=++detailSeq;const token=scope();render();
  try { const answer=await send('get_pip_run',{run_id:id});if(token!==scope()||sequence!==detailSeq||id!==S.runId)return;if(!record(answer.run)||answer.run.id!==id||answer.run.pip_id!==S.selected)throw new Error('Run did not match the selected Pip.');const wasActive=active(S.run?.status);S.run=answer.run;render();if(S.activity&&!S.activity.has_more&&(wasActive||active(S.run.status)))void loadActivity(); }
  catch(error){if(token===scope()&&sequence===detailSeq)setError(error);}
}
async function loadSelected(chooseLatest=false) {
  if(!S.selected)return;const id=S.selected,sequence=++selectionSeq,token=scope();
  try{const [p,r]=await Promise.all([send('get_pip',{pip_id:id}),send('list_pip_runs',{pip_id:id})]);if(token!==scope()||sequence!==selectionSeq)return;
    if(!record(p.pip)||p.pip.id!==id||p.pip.workspace_id!==S.workspace.id||!Array.isArray(r.runs)||!r.runs.every(run=>run.pip_id===id))throw new Error('Pip details do not match this workspace.');
    S.pip=p.pip;S.runs=r.runs;if(!S.modelDirty)draft.pipModel=p.pip.model_choice?.mode==='model'?`model:${p.pip.model_choice.model}`:'default';if(!S.scheduleDirty)hydrateSchedule(p.pip);if(!S.quickDirty)hydrateQuickSchedule(p.pip);if(!S.adaptationDirty)hydrateAdaptation(p.pip);if(!S.sourceDirty)hydrateSource(p.pip);if(!draft.revisionGoal)draft.revisionGoal=p.pip.goal;render();
    const desired=S.runId||(chooseLatest?r.runs.find(run=>run.manifest?.run_kind!=='conversation')?.id:'');if(desired&&S.tab!=='chat')await loadRun(desired);if(S.tab==='chat')await loadMessages();
  }catch(error){if(token===scope()&&sequence===selectionSeq)setError(error);}
}
async function select(id) {if(id===S.selected&&!S.create){S.overview=false;S.tab='chat';rememberView();render();void loadMessages();return;}clearSelection();S.selected=id;S.create=false;S.overview=false;S.tab='chat';draft.chatText=chatDrafts.get(id)||'';S.error='';rememberView();render();await loadSelected(true);}
let refreshFlight=null;
function refresh(includeContext=false) {
  if(!usable()||!S.workspace)return Promise.resolve();
  const epoch=S.epoch;
  if(refreshFlight?.epoch===epoch)return refreshFlight.promise.then(()=>includeContext?refresh(true):undefined);
  const flight={epoch,promise:null};
  refreshFlight=flight;
  flight.promise=refreshNow(includeContext).finally(()=>{if(refreshFlight===flight)refreshFlight=null;});
  return flight.promise;
}
async function refreshNow(includeContext=false) {
  if(!usable()||!S.workspace)return;const token=scope(),epoch=S.epoch,sequence=++refreshSeq;S.refreshing=true;void loadSetups();
  try {
    const results=await Promise.allSettled([send('list_pips',{workspace_id:S.workspace.id}),send('get_pip_runner'),...(includeContext?[send('get_workspace_context',{workspace_id:S.workspace.id})]:[])]);
    if(token!==scope())return;
    if(results[0].status==='fulfilled'){const jobs=results[0].value.pips;if(!Array.isArray(jobs)||!jobs.every(p=>p.workspace_id===S.workspace.id))throw new Error('Pips list does not match this workspace.');S.jobs=jobs;}else S.error=errorText(results[0].reason);
    if(results[1].status==='fulfilled'){S.runner=null;S.runner=runner(results[1].value.runner);}else{S.runner=null;S.error=errorText(results[1].reason);}
    if(includeContext){if(results[2].status==='fulfilled'){S.context=null;S.context=context(results[2].value.context,S.workspace.id);}else{S.context=null;S.error=errorText(results[2].reason);}}
    if(S.selected&&!S.jobs.some(p=>p.id===S.selected)){clearSelection();S.selected='';}
    if(restoreView&&!S.create){restoreView=false;if(savedView?.workspace_id===S.workspace.id&&record(savedView.drafts))for(const [id,text] of Object.entries(savedView.drafts).slice(-20))if(typeof text==='string'&&text.length<=4000)chatDrafts.set(id,text);if(savedView?.workspace_id===S.workspace.id&&!savedView.overview&&S.jobs.some(p=>p.id===savedView.selected))await select(savedView.selected);}if(S.selected)await loadSelected(false);
  }catch(error){if(token===scope())S.error=errorText(error);}
  finally{if(epoch===S.epoch&&sequence===refreshSeq){S.refreshing=false;render();}}
}
async function initialize() {
  const epoch=S.epoch;S.loading=true;render();
  try {const [result,catalog]=await Promise.all([send('list_workspaces'),send('list_pip_types')]);if(epoch!==S.epoch)return;S.types=pipTypes(catalog);S.workspaces=result.workspaces||[];const personalHome=S.apiVersion>=43&&!remoteHost?result.workspaces?.find(w=>w.kind==='personal')?.id:null;const workspace=result.workspaces?.find(w=>w.id===(options.workspaceId||(savedView?.workspace_id&&result.workspaces.some(w=>w.id===savedView.workspace_id&&w.kind==='personal')?savedView.workspace_id:personalHome||result.current_workspace_id)));if(!workspace)throw new Error('DGC could not resolve the selected registered workspace.');S.workspace=workspace;S.loading=false;await refresh(true);if(epoch===S.epoch&&navigationPending){navigationPending=false;await navigateFromHost(options.navigation);}}
  catch(error){if(epoch===S.epoch){S.loading=false;setError(error);}}
}
async function navigateFromHost(value) {
  if(!record(value))return;
  if(['context','notifications'].includes(value.section)&&!value.pip){clearSelection();S.selected='';S.tab=value.section;S.overview=false;rememberView();render();if(S.tab==='notifications'){await loadNotifications();return;}if(S.apiVersion>=12){void loadOutcomeSessions();void loadOutcomes();if(value.reviewKind==='session_outcome'&&typeof value.review==='string'&&value.review)await openOutcome(value.review);}return;}
  if(typeof value.pip!=='string'||!value.pip)return;
  if(!remoteHost&&['email_draft','calendar_draft','connector_draft'].includes(value.reviewKind)&&S.apiVersion>=(value.reviewKind==='connector_draft'?37:value.reviewKind==='calendar_draft'?35:32)&&value.workspace!==S.workspace.id){
    const token=scope(),answer=await send(value.reviewKind==='connector_draft'?'get_pip_connector_draft':value.reviewKind==='calendar_draft'?'get_pip_calendar_draft':'get_pip_message_draft',{draft_id:value.review});if(token!==scope())return;
    if((value.reviewKind==='connector_draft'?connectorDraft(answer.draft,value.pip,value.workspace):emailDraft(answer.draft,value.pip,value.workspace,value.reviewKind==='calendar_draft')).id!==value.review)throw Error('The saved email draft identity changed.');
    const target=S.workspaces.find(w=>w.id===value.workspace&&w.kind==='personal');
    if(!target)throw Error('The Personal workspace for this draft is unavailable.');
    S.epoch++;clearSelection();S.selected='';S.jobs=[];S.context=null;S.create=false;S.overview=true;S.workspace=target;setupRows=[];setupError='';S.error='';rememberView();await refresh(true);
  }
  if(!S.jobs.some(p=>p.id===value.pip))throw new Error('This Pip is not available in the selected workspace. Refresh the dashboard.');
  S.error='';
  const selecting=select(value.pip),token=scope();await selecting;if(token!==scope()||S.selected!==value.pip||!usable())return;
  const allowed=['chat','job','runs','schedule','handoffs','revisions','context','notifications'];
  let tab=allowed.includes(value.section)?value.section:'chat';
  if(tab==='schedule'&&executionPip(S.pip)&&!pulsePip(S.pip)||tab==='handoffs'&&documentationPip(S.pip))tab='chat';
  S.tab=tab;rememberView();render();
  if(tab==='runs'){await loadSelected(true);if(token===scope()&&typeof value.run==='string'&&value.run){const result=await send('get_pip_run',{run_id:value.run});if(token!==scope())return;if(result.run?.pip_id!==S.selected||result.run?.workspace_id!==S.workspace.id||result.run?.id!==value.run)throw Error('This run does not belong to the selected Pip.');S.run=result.run;S.runId=value.run;render();}}else if(tab==='notifications')await loadNotifications();else if(tab==='job')await loadModels();else if(tab==='handoffs')await loadHandoffs();else if(tab==='revisions')await loadApprovals();else if(tab==='context'&&S.apiVersion>=12){void loadOutcomeSessions();void loadOutcomes();}
  if(token!==scope()||S.selected!==value.pip||!usable())return;
  if(typeof value.review==='string'&&value.review){
    if(['email_draft','calendar_draft','connector_draft'].includes(value.reviewKind)&&tab==='chat'&&S.apiVersion>=(value.reviewKind==='connector_draft'?37:value.reviewKind==='calendar_draft'?35:32))await openEmailDraft(value.review);
    else if(value.reviewKind==='session_outcome'&&tab==='context'&&S.apiVersion>=12)await openOutcome(value.review);
    else if(value.reviewKind==='handoff'&&tab==='handoffs')await openSavedHandoff(value.review);
    else if(['job_update','schedule_update'].includes(value.reviewKind)&&tab==='revisions'){
      const response=await send('get_pip_proposal',{pip_id:S.selected,proposal_id:value.review});if(token!==scope()||!usable())return;
      const proposal=savedProposal(response,S.selected,S.workspace.id,value.review);S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(p=>p.id!==proposal.id),proposal]};
      proposalReview(value.review);
    }
  }
}
async function mutate(request,after) {
  if(S.busy||!usable())return;if(archived()&&['propose_pip_update','accept_pip_update','reject_pip_update','propose_pip_handoff','propose_pip_artifact_handoff','accept_pip_handoff','pause_pip','resume_pip','run_pip','send_pip_message','record_pip_statement'].includes(request.type)){setError('Restore this archived Pip to paused before changing it or starting work.');return;}const token=scope();S.busy=true;S.error='';render();if(S.review)renderReview();
  try{const result=await broker.request(request);if(token!==scope()||!usable())return;closeReview();await after?.(result);if(token===scope())await refresh(true);}
  catch(error){if(token===scope()){if(S.review){S.review.error=errorText(error);renderReview();}else S.error=errorText(error);}}
  finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
async function history(more=false) {
  const token=scope(),sequence=++historySeq;const args={pip_id:S.selected,limit:20,...(more&&S.cursor!==null?{before_version:S.cursor}:{})};
  try{const answer=await send('list_pip_versions',args);if(token!==scope()||sequence!==historySeq)return;if(!Array.isArray(answer.versions)||!answer.versions.every(v=>v.pip_id===S.selected)||!(answer.next_before_version===null||Number.isInteger(answer.next_before_version)))throw new Error('Version history response is invalid.');S.versions=more?[...S.versions,...answer.versions]:answer.versions;S.cursor=answer.next_before_version;S.historyLoaded=true;render();}
  catch(error){if(token===scope())setError(error);}
}
// Changes saved for this Pip that still wait for the user (from its chat, the main chat or an older build).
function waitingProposals(){return (S.pip?.proposals||[]).filter(v=>record(v)&&(v.approval_status||'pending')==='pending');}
// One line a person can read: what accepting this change would change.
function changeSummary(v){
 const d=record(v.definition)?v.definition:{},p=S.pip||{},differs=k=>Object.hasOwn(d,k)&&JSON.stringify(d[k]??null)!==JSON.stringify(p[k]??null),parts=[];
 if(differs('name'))parts.push(`Name: ${d.name}`);
 if(differs('goal'))parts.push(`What it does: ${String(d.goal).slice(0,120)}${String(d.goal).length>120?'…':''}`);
 if(differs('schedule')||differs('event_trigger'))parts.push(`When it runs: ${d.event_trigger?eventTriggerLabel(d.event_trigger):scheduleLabel(d.schedule)}`);
 if(differs('model_choice'))parts.push(`Model: ${modelLabel(d.model_choice)}`);
 if(differs('web_plan'))parts.push(d.web_plan?.reads?.length?`Web pages: ${d.web_plan.reads.map(webReadLabel).join(', ')}`:'Web pages: none');
 if(differs('app_plan'))parts.push(d.app_plan?`Reads from ${d.app_plan.server}`:'No connected app reads');
 if(differs('computer_plan'))parts.push(d.computer_plan?'Gets its own computer':'Computer removed');
 if(differs('github_plan'))parts.push(d.github_plan?'GitHub reads':'No GitHub reads');
 if(differs('source_policy'))parts.push(`Source: ${sourcePolicyLabel(d.source_policy)}`);
 if(differs('adaptation_policy'))parts.push(`Changes it may make itself: ${adaptationLabel(d.adaptation_policy)}`);
 if(differs('verification_plan'))parts.push('Commands it may run');
 return parts.join(' · ')||String(v.reason||'A saved change');
}
// A change the user makes in this view is theirs: it is saved and accepted in one step, with the
// reason filled in. `same` checks the saved definition matches the choice before accepting it.
async function applyOwnChange(changes,same,notice){
 if(S.busy||!usable()||!S.pip)return false;const pip=S.pip,token=scope();S.busy=true;S.error='';render();
 try{
  const proposal=(await send('propose_pip_update',{pip_id:pip.id,expected_version:pip.current_version,changes,reason:'Changed in the Pips view.'})).proposal;
  if(token!==scope())return false;
  if(!record(proposal)||proposal.pip_id!==pip.id||!record(proposal.definition)||!same(proposal.definition))throw Error('The saved change differs from your choice. Refresh and try again.');
  await send('accept_pip_update',{pip_id:pip.id,proposal_id:proposal.id,expected_version:pip.current_version});
  if(token!==scope())return false;S.notice=notice;await refresh(true);return true;
 }catch(error){if(token===scope())S.error=errorText(error);return false;}
 finally{if(token===scope()){S.busy=false;render();}}
}
function personalProposalBody(proposal){
 const plan=proposal.definition?.app_plan,web=proposal.definition?.web_plan;
 if(plan)appReadPlan(plan);
 if(web)webReadPlan(web);
 const webList=v=>v?`<ul class="web-reads">${v.reads.map(r=>`<li>${esc(webReadLabel(r))}</li>`).join('')}</ul>`:'<p class="muted">None</p>';
 const webChanged=JSON.stringify(S.pip.web_plan||null)!==JSON.stringify(web||null);
 return `<dl class="meta"><dt>Scope</dt><dd>Personal · no project tools</dd><dt>Name</dt><dd>${esc(proposal.definition?.name)}</dd><dt>Goal</dt><dd>${esc(proposal.definition?.goal)}</dd><dt>Model</dt><dd>${esc(modelLabel(proposal.definition?.model_choice))}</dd><dt>Schedule</dt><dd>${esc(scheduleLabel(proposal.definition?.schedule))}</dd></dl><h3>Current app access</h3><pre>${esc(JSON.stringify(S.pip.app_plan||'None',null,2))}</pre><h3>Proposed app access</h3><pre>${esc(JSON.stringify(plan||'None',null,2))}</pre><p class="muted">Only these exact read calls are approved. App content is sent to the selected model as untrusted reference data. No sending, bookings or other external actions. Removing access stops further reads; an already sent read cannot be recalled.</p>${webChanged?`<h3>Current web reads</h3>${webList(S.pip.web_plan)}<h3>Proposed web reads</h3>${webList(web)}<p class="muted">DGC reads exactly these public pages and searches before each run. The Pip cannot open other pages, follow links, sign in or fill in forms.</p>`:''}<p>${esc(proposal.reason)}</p>`;
}
function proposalReview(id,reject=false) {
  const proposal=S.pip?.proposals?.find(p=>p.id===id);if(!proposal)return;
  const stale=proposal.expected_version!==S.pip.current_version;
  let sourceUnsupported=false;try{sourceUnsupported=sourcePolicy(proposal.definition?.source_policy).mode==='current_tree'&&S.apiVersion<11;}catch{sourceUnsupported=true;}
  const pathTrigger=record(proposal.definition?.event_trigger)&&(Object.hasOwn(proposal.definition.event_trigger,'commit_paths')||proposal.definition.event_trigger.events?.includes('committed_paths_changed'));let pathUnsupported=pathTrigger&&S.apiVersion<22;try{if(pathTrigger)eventTrigger(proposal.definition.event_trigger);}catch{pathUnsupported=true;}
  const sessionTrigger=Array.isArray(proposal.definition?.event_trigger?.events)&&proposal.definition.event_trigger.events.includes('session_turn_completed'),sessionUnsupported=sessionTrigger&&S.apiVersion<18;
  const quillAutomation=(documentationPip(S.pip)||documentationPip(proposal.definition))&&!!(proposal.definition?.schedule||proposal.definition?.event_trigger),quillUnsupported=quillAutomation&&S.apiVersion<20;
  const pulseChange=Object.hasOwn(proposal.definition||{},'verification_plan')||pulsePip(S.pip)&&(S.pip.verification_plan!=null||!!proposal.definition?.schedule);let pulseUnsupported=pulseChange&&S.apiVersion<21;try{pulsePlan(proposal.definition?.verification_plan);}catch{pulseUnsupported=true;}
  const unavailable=(!reject&&(sourceUnsupported||sessionUnsupported||pathUnsupported||quillUnsupported||pulseUnsupported))||proposal.approval_status&&proposal.approval_status!=='pending';
  const currentSchedule=S.pip.event_trigger?'No time schedule':scheduleLabel(S.pip.schedule),proposedSchedule=proposal.definition?.event_trigger?'No time schedule':scheduleLabel(proposal.definition?.schedule);
  openReview({title:reject?'Dismiss saved proposal?':'Accept this job revision?',description:reject?'The saved proposal will be marked rejected. The current job stays unchanged.':`Review the complete saved definition from version ${proposal.expected_version}. Future runs use the accepted version; existing runs keep their inputs.`,body:personalPip()?personalProposalBody(proposal):pulseChange?pulseProposalBody(proposal,{stale,unavailable,pulseUnsupported,reject}):pathTrigger||S.pip.event_trigger?.commit_paths?pathProposalBody(proposal,{stale,unavailable,pathUnsupported,reject}):`<dl class="meta"><dt>Name</dt><dd>${esc(proposal.definition?.name)}</dd><dt>Source ref</dt><dd>${esc(proposal.definition?.source_ref)}</dd><dt>Current model</dt><dd>${esc(modelLabel(S.pip.model_choice))}</dd><dt>Proposed model</dt><dd>${esc(modelLabel(proposal.definition?.model_choice))}</dd><dt>Requested by</dt><dd>${esc(proposal.actor||'Not recorded')}</dd><dt>Expires</dt><dd>${proposal.expires_at?esc(date(proposal.expires_at)):'Not recorded'}</dd></dl><h3>Proposed goal</h3><p class="goal">${esc(proposal.definition?.goal)}</p><h3>Source policy</h3><dl class="meta"><dt>Current source</dt><dd>${esc(sourcePolicyLabel(S.pip.source_policy))}</dd><dt>Proposed source</dt><dd>${esc(sourcePolicyLabel(proposal.definition?.source_policy))}</dd></dl><p class="muted">Current-tree source captures eligible saved files with safe-source exclusions. It is checked but non-atomic, not a Git commit. It permits only manual read-only requests and no handoffs. Its stored source ref is dormant. Changing source policy removes automation; switching back does not restore it.</p><h3>Adaptation policy</h3><dl class="meta"><dt>Current policy</dt><dd>${esc(adaptationLabel(S.pip.adaptation_policy))}</dd><dt>Proposed policy</dt><dd>${esc(adaptationLabel(proposal.definition?.adaptation_policy))}</dd></dl><p class="muted">Automatic source-ref changes select the committed source for later authorized work. The allowed fields above do not include goal, model, schedule, triggers, permissions or this policy. Accepting this policy alone runs nothing.</p>${pulseChange?`<h3>Current Pulse command plan</h3>${pulsePlanReview(S.pip.verification_plan)}<h3>Proposed Pulse command plan</h3>${pulsePlanReview(proposal.definition?.verification_plan)}`:''}<h3>Schedule</h3><dl class="meta"><dt>Current</dt><dd>${esc(currentSchedule)}</dd><dt>Proposed</dt><dd>${esc(proposedSchedule)}</dd></dl><h3>Event triggers</h3><dl class="meta"><dt>Current events</dt><dd>${esc(eventTriggerLabel(S.pip.event_trigger))}</dd><dt>Proposed events</dt><dd>${esc(eventTriggerLabel(proposal.definition?.event_trigger))}</dd></dl>${commitRulesMarkup(S.pip.event_trigger?.commit_paths,'Current committed path rules')}${commitRulesMarkup(proposal.definition?.event_trigger?.commit_paths,'Proposed committed path rules')}${pathTrigger?`<p class="notice">Other selected events can wake this Pip independently of a path match (OR). The shared minimum interval applies to all selected events.</p><p class="muted">${esc(commitPathNotice)}</p>`:''}${quillAutomation?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${sessionTrigger?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">Time schedules and event triggers are mutually exclusive. Approving an event trigger does not replay old history. Active Pips coalesce retained events after downtime; paused or busy Pips skip backlog. ${documentationPip(S.pip)?'Quill events create private model-authored drafts.':'Events start read-only audits.'} They never start handoffs, edits or tests.</p><p class="muted">Accepting a time schedule schedules future runs when this Pip and its runner are active. Offline time coalesces to one latest occurrence when the Pip is active; there is no backlog burst. Individually paused or busy Pips skip due occurrences and resume at the next scheduled time. Daily clock gaps are skipped and repeated times run once. Tool permissions remain unchanged.</p><p class="muted">${esc(proposal.reason)}</p><details><summary>Complete saved definition</summary><pre>${esc(JSON.stringify(proposal.definition,null,2))}</pre></details>${!reject&&stale?'<p class="notice error">This proposal is based on an older version. Dismiss it and create a current proposal.</p>':''}${pulseUnsupported?'<p class="notice error">A valid saved Pulse plan and Pips API 21 are required before accepting this revision.</p>':''}${quillUnsupported?'<p class="notice error">Update the computer to Pips API 20 before accepting Quill automation.</p>':''}${pathUnsupported?'<p class="notice error">Valid committed-path rules and Pips API 22 are required before accepting this revision.</p>':''}${sessionUnsupported?'<p class="notice error">Update the computer to Pips API 18 before accepting Session turn saved.</p>':''}${sourceUnsupported?'<p class="notice error">Update the computer before reviewing this source policy.</p>':''}${unavailable?'<p class="notice error">This review is unavailable or no longer pending. Refresh the saved reviews.</p>':''}${proposal.expires_at&&Date.parse(proposal.expires_at)<=Date.now()?'<p class="notice error">This review has expired. Create a new proposal before accepting changes.</p>':''}`,confirm:reject?'Dismiss proposal':'Accept revision',requiresCommitPaths:!reject&&pathTrigger,requiresPulsePlan:!reject&&pulseChange,requiresQuillAutomation:!reject&&quillAutomation,requiresSessionTurn:!reject&&sessionTrigger,blocked:unavailable||(!reject&&stale),expiresAt:proposal.expires_at,request:{type:reject?'reject_pip_update':'accept_pip_update',pip_id:S.selected,proposal_id:proposal.id,expected_version:proposal.expected_version}});
  // GitHub reads are shown whichever body variant reviewed the rest; a plan this view cannot read blocks acceptance.
  // A Personal Pip's computer is shown whenever the proposal keeps, gives or removes one.
  if(S.review&&personalPip()&&(S.pip?.computer_plan||proposal.definition?.computer_plan)){const label=v=>v?'Its own browser and files. Submits wait for your approval.':'None';S.review.body+=`<dl class="meta"><dt>Computer now</dt><dd>${label(S.pip.computer_plan)}</dd><dt>Computer after</dt><dd>${label(proposal.definition?.computer_plan)}</dd></dl>`;renderReview();}
  if(S.review&&!personalPip()&&(S.pip?.github_plan||proposal.definition?.github_plan)){let section;try{if(proposal.definition?.github_plan)githubReadPlan(proposal.definition.github_plan);section=githubProposalMarkup(proposal);}catch{section='<p class="notice">These GitHub reads are not supported by this view. Update DGC before accepting.</p>';if(!reject)S.review.blocked=true;}S.review.body+=section;renderReview();}
}
function updateDraft(event) {
  if(event.target.dataset?.commitRule!==undefined){const row=commitRules[Number(event.target.dataset.commitRule)];if(row){if(event.target.dataset.commitKind!==undefined)row.kind=event.target.value;else row.path=event.target.value;S.scheduleDirty=true;}return;}
  if(event.target.dataset?.pulseCommand!==undefined){const i=Number(event.target.dataset.pulseCommand),row=pulseCommands[i];if(row){if(event.target.dataset.pulseArg!==undefined)row.argv[Number(event.target.dataset.pulseArg)]=event.target.value;else row.cwd=event.target.value;S.scheduleDirty=true;}return;}
  const key=event.target.dataset?.draft;if(!(key in draft))return;draft[key]=event.target.type==='checkbox'?event.target.checked:event.target.value;
  if(key==='outcomeSession'){outcomeInspectSeq++;outcomeInspection=null;outcomeInspecting=false;outcomeSessionsError='';}
  if(key==='chatText'&&S.selected){chatDrafts.set(S.selected,draft.chatText);rememberView();fitChatInput();}if(key==='chatModelSearch')render();
  if(key==='sourceMode'||key==='sourceReason')S.sourceDirty=true;
  if(key==='pipModel')S.modelDirty=true;
  if(key.startsWith('schedule')||key.startsWith('trigger')||key==='verificationEnabled')S.scheduleDirty=true;
  if((key==='triggerPaths'||key==='triggerCommit')&&event.type==='change')render();
  if(key==='verificationEnabled'&&event.type==='change'){if(!draft.verificationEnabled)draft.scheduleType='manual';render();}
  if(key.startsWith('adaptation'))S.adaptationDirty=true;
  if(key.startsWith('quick')){S.quickDirty=true;if(key==='quickKind'&&event.type==='change')render();}
  if((key==='scheduleType'||key==='handoffTarget'||key==='adaptationMode'||key==='sourceMode'||key==='outcomeSession'||key==='outcomeSourceKind')&&event.type==='change'){render();if(key==='handoffTarget'&&executionPip(S.jobs.find(p=>p.id===draft.handoffTarget)))void loadExecution();}
}
document.addEventListener('input',updateDraft);
document.addEventListener('paste',event=>{if(event.target?.id!=='chatText'||!canAttachImages())return;const files=[...(event.clipboardData?.files||[])].filter(f=>PIP_IMAGE_TYPES.includes(f.type));if(!files.length)return;event.preventDefault();addImageFiles(files);});
document.addEventListener('dragover',event=>{if(canAttachImages()&&event.target?.closest?.('#chat-form')&&[...(event.dataTransfer?.types||[])].includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{if(!canAttachImages()||!event.target?.closest?.('#chat-form'))return;const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();addImageFiles(files);});
document.addEventListener('change',event=>{if(event.target.id==='chat-attach-input'){addImageFiles(event.target.files||[]);event.target.value='';return;}if(event.target.id==='keep-running'){void setKeepRunning(event.target.checked);return;}if(event.target.id==='desktop-notifications'){void setDesktopNotifications(event.target.checked);return;}if(event.target.id==='pip-workspace'){const chosen=S.workspaces.find(w=>w.id===event.target.value);if(chosen){S.epoch++;clearSelection();S.selected='';S.jobs=[];S.context=null;S.create=false;S.overview=true;S.workspace=chosen;setupRows=[];setupError='';S.error='';rememberView();void refresh(true);}return;}if(event.target.id==='chat-context'){updateChatPreference('context_size',event.target.value);return;}if(event.target.id==='chat-thinking'){updateChatPreference('thinking',chatThinkingLevels[Number(event.target.value)]);return;}if(event.target.id==='commandReceiptSession'){commandDetailSeq++;commandSeq++;commandLoading=false;commandSession=event.target.value;commandReceipts=[];commandLoaded=false;commandCursor=null;commandMore=false;void loadCommandReceipts();return;}updateDraft(event);});
document.addEventListener('submit',event=>{
  if(event.target.id==='computer-go'){event.preventDefault();const url=$('computer-url').value.trim();if(url)void computerView('go',{url:/^https?:\/\//i.test(url)?url:'https://'+url});return;}
  if(event.target.id==='computer-type'){event.preventDefault();const input=$('computer-text'),text=input.value;if(text){input.value='';void computerView('type',{text});}return;}
  const id=event.target.id;if(!['create-form','revision-form','context-form','schedule-form','chat-form','model-form','handoff-form','adaptation-form','source-form','outcome-form','pip-statement-form','web-reads-form','notify-form','github-form','quick-schedule-form'].includes(id))return;event.preventDefault();
  if(!usable()||S.busy||!S.workspace)return;if(archived()&&['revision-form','schedule-form','chat-form','model-form','handoff-form','adaptation-form','source-form','pip-statement-form','web-reads-form','quick-schedule-form'].includes(id)){setError('Restore this archived Pip to paused before changing it or starting work.');return;}
  if(id==='pip-statement-form'){void reviewStatement();return;}
  if(id==='quick-schedule-form'){
    let schedule;try{schedule=quickSchedule();}catch(error){setError(error);return;}
    void applyOwnChange(S.apiVersion>=10?{schedule,event_trigger:null}:{schedule},d=>JSON.stringify(d.schedule??null)===JSON.stringify(schedule),schedule?`Saved. It runs ${scheduleLabel(schedule).replace(/^Daily/,'every day').replace(/^Weekdays/,'on weekdays').replace(/^Every/,'every')}.`:'Saved. It runs when you ask it to.').then(ok=>{if(ok){S.quickDirty=false;S.scheduleDirty=false;}});return;
  }
  if(id==='outcome-form'){
    try{if(S.apiVersion<12||!outcomeInspection||outcomeInspection.id!==draft.outcomeSession)throw Error('Inspect the saved session before proposing a statement.');const title=draft.outcomeTitle.trim(),statement=draft.outcomeText.trim();if(!title||!statement||new TextEncoder().encode(title).length>240||new TextEncoder().encode(statement).length>1536)throw Error('Enter a title up to 240 UTF-8 bytes and a statement up to 1,536 UTF-8 bytes. Nothing is shortened.');const source=sessionSourceSelection(draft.outcomeSourceKind==='commit'?{kind:'commit',revision:draft.outcomeSourceValue.trim()}:{kind:'pip_run',run_id:draft.outcomeSourceValue.trim()});
      const request={type:'propose_workspace_session_outcome',workspace_id:S.workspace.id,session_id:outcomeInspection.id,title,statement,source,expected_session_revision:outcomeInspection.revision},signature=JSON.stringify(request);if(outcomeRetry?.signature!==signature)outcomeRetry={signature,key:'editor-statement-'+globalThis.crypto.randomUUID()};
      void mutate({...request,request_key:outcomeRetry.key},answer=>{if(answer.workspace_id!==S.workspace.id)throw Error('The saved statement belongs to another workspace.');const p=sessionStatement(answer.proposal,S.workspace.id);if(p.title!==title||p.statement!==statement||p.session.id!==request.session_id||p.session.revision!==request.expected_session_revision||p.session.sha256!==outcomeInspection.sha256||p.session.bytes!==outcomeInspection.bytes||JSON.stringify(p.source_reference.selection)!==JSON.stringify(source))throw Error('The saved statement differs from this draft. Refresh before review.');outcomeHistory=[p,...outcomeHistory.filter(old=>old.id!==p.id)].slice(0,100);outcomeLoaded=true;S.notice='Statement saved for review. No context or authority changed.';reviewOutcome(p);});
    }catch(error){setError(error);}return;
  }
  if(id==='chat-form'){void sendChat();return;}
  if(id==='handoff-form'){
    const saved=S.handoffDraft,target=S.jobs.find(p=>p.id===draft.handoffTarget&&p.id!==S.selected);
    if(saved?.personal){submitPersonalHandoff(saved,target);return;}
    if(archived()||!saved||!target||target.status==='archived'||!committedJob(target)||documentationPip(target)||!pipType(target,S.types)?.available||(saved.artifact&&target.pip_type!=='pulse')){setError('Choose an available recipient in this workspace.');return;}
    let action;try{action=handoffAction(target.pip_type==='patch'?'patch':target.pip_type==='pulse'?'test':'read_only',draft.handoffPaths,draft.handoffTests,target.pip_type==='patch'?specialistDraft():undefined);}catch(error){setError(error);return;}
    const handoffScope=scope(),task=draft.handoffTask.trim();if(!task||new TextEncoder().encode(task).length>4000){setError('Enter a task of at most 4,000 UTF-8 bytes.');return;}
    const request={type:saved.artifact?'propose_pip_artifact_handoff':'propose_pip_handoff',source_run_id:saved.runId,...(saved.artifact?{}:{finding_index:saved.index}),target_pip_id:target.id,task,action},signature=JSON.stringify(request);
    if(saved.signature!==signature){saved.signature=signature;saved.key='editor-handoff-'+globalThis.crypto.randomUUID();}
    void mutate({...request,idempotency_key:saved.key},async result=>{const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.source_run_id!==saved.runId||(saved.artifact?(h.payload.type!=='patch_artifact.v1'||h.payload.source.artifact.sha256!==saved.artifact.artifact.sha256||h.payload.source.result_digest!==saved.artifact.result_digest||h.payload.source.review_revision!==saved.artifact.review_revision):h.payload.source.finding_index!==saved.index)||h.target_pip_id!==target.id)throw new Error('Saved handoff does not match this draft.');S.handoffDraft=null;S.notice='Handoff saved for review. Nothing has started.';if(h.payload.action.kind!=='read_only')await loadExecution();if(handoffScope!==scope())return;reviewHandoff(h);void loadHandoffs();});return;
  }
  if(id==='web-reads-form'){
    if(S.apiVersion<40||!personalPip()){setError('Web reads need a Personal Pip and Pips API 40.');return;}
    let plan;try{plan=webReadsFromText(draft.webReads||webReadsLines(S.pip.web_plan));}catch(error){setError(error);return;}
    void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{web_plan:plan},reason:'Review these exact web reads for this Personal Pip.'},result=>{const p=result.proposal;if(!record(p)||p.pip_id!==S.selected||JSON.stringify(p.definition?.web_plan)!==JSON.stringify(plan))throw new Error('The saved web reads differ from this review. Refresh before accepting.');draft.webReads='';S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(v=>v.id!==p.id),p]};proposalReview(p.id);});
    return;
  }
  if(id==='source-form'){
    if(S.apiVersion<11||!['scout','lens','rook','lock','quill'].includes(S.pip?.pip_type??'rook')){setError('Update the computer to Pips API 11 and choose a read-only source Pip.');return;}
    let policy;try{policy=sourcePolicy(draft.sourceMode==='current_tree'?{mode:'current_tree',exclusions:'safe_source_v1'}:{mode:draft.sourceMode});}catch(error){setError(error);return;}
    if(S.sourceDraftVersion!==S.pip.current_version){setError('The Pip changed while you edited this. Reset it and choose again.');return;}
    const changes={source_policy:policy,schedule:null,event_trigger:null};
    void applyOwnChange(changes,d=>JSON.stringify(sourcePolicy(d.source_policy))===JSON.stringify(policy)&&d.schedule===null&&d.event_trigger===null,'Source saved. Its schedule was turned off; set one again if you want it.').then(ok=>{if(ok)S.sourceDirty=false;});return;
  }
  if(id==='github-form'){
    if(S.apiVersion<41||!githubPip()){setError('GitHub reads need a project reviewer or Quill and Pips API 41.');return;}
    let plan;try{plan=githubPlanFromDraft();}catch{setError('Name the repository as owner/name, choose at least one read, and use up to five labels without commas.');return;}
    void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{github_plan:plan},reason:'Review these exact GitHub reads for this Pip.'},result=>{const p=result.proposal;if(!record(p)||p.pip_id!==S.selected||JSON.stringify(p.definition?.github_plan)!==JSON.stringify(plan))throw new Error('The saved GitHub reads differ from this review. Refresh before accepting.');S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(v=>v.id!==p.id),p]};proposalReview(p.id);});
    return;
  }
  if(id==='notify-form'){
    const n=notifyState.value,pip=S.selected;if(S.apiVersion<41||!n||n.pip_id!==pip)return;
    const min=draft.notifyMin,alert=draft.notifyAlert==='off'?null:draft.notifyAlert;
    if(!SEVERITIES.includes(min)||alert!==null&&SEVERITIES.indexOf(alert)<SEVERITIES.indexOf(min)){notifyState.error='Alerts must be at least as severe as the findings the digest shows.';render();return;}
    void mutate({type:'set_pip_notify_settings',pip_id:pip,min_severity:min,alert_severity:alert,expected_revision:n.revision},result=>{const value=pipNotifySettings(result.settings,pip);if(value.min_severity!==min||value.alert_severity!==alert)throw Error('The saved settings differ from your choice. Refresh and try again.');notifyState={pip,value,loading:false,error:''};S.notice='Notifications saved. The job itself did not change.';});
    return;
  }
  if(id==='adaptation-form'){
    if(S.apiVersion<10){setError('Update the computer to review adaptation policy.');return;}
    let policy;try{policy=adaptationPolicy({mode:draft.adaptationMode,allowed_fields:draft.adaptationMode==='bounded_adaptive'?[...(draft.adaptationName?['name']:[]),...(draft.adaptationSource?['source_ref']:[])]:draft.adaptationMode==='autonomous'?['name','source_ref']:[]});}catch(error){setError(error);return;}
    if(S.adaptationDraftVersion!==S.pip.current_version){setError('The Pip changed while you edited this. Reset it and choose again.');return;}
    void applyOwnChange({adaptation_policy:policy},d=>JSON.stringify(adaptationPolicy(d.adaptation_policy))===JSON.stringify(policy),'Saved. The Pip uses this from its next run.').then(ok=>{if(ok)S.adaptationDirty=false;});return;
  }
  if(id==='model-form'){
    let choice;try{choice=modelChoice(draft.pipModel,S.models);}catch(error){setError(error);return;}
    void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`Model saved: ${modelLabel(choice)}. Its next run uses it.`).then(ok=>{if(ok)S.modelDirty=false;});return;
  }
  if(id==='create-form'){
    if(S.workspace?.kind==='personal'){S.createType=$('personal-character').value;S.createStep='configure';draft.source_ref='HEAD';}
    const selectedType=S.types.find(t=>t.id===S.createType);
    if(!S.create||S.createStep!=='configure'||!selectedType?.available){setError('Choose an available Pip type first.');return;}
    if(!draft.name.trim()||!draft.goal.trim()||!draft.source_ref.trim()){setError('Enter a name, job goal, and source ref.');return;}
    let choice;try{choice=modelChoice(draft.createModel,S.models);}catch(error){setError(error);return;}
    const request={type:'create_pip',workspace_id:S.workspace.id,pip_type:selectedType.id,model_choice:choice,name:draft.name.trim(),goal:draft.goal.trim(),source_ref:draft.source_ref.trim()};
    if(executionPip(selectedType)&&S.workspace?.kind!=='personal'){
      openReview({title:'Create '+selectedType.name+' with reviewed execution?',description:selectedType.id==='pulse'?'This creates a saved read-only conversation with no standing command plan. Review a handoff or, on API 21, a command plan separately before execution.':'This creates a saved read-only conversation. It grants no standing file-write or test permission. Each execution needs a separate reviewed handoff.',body:`<h3>${esc(request.name)}</h3><p class="goal">${esc(request.goal)}</p><dl class="meta"><dt>Source ref</dt><dd>${esc(request.source_ref)}</dd><dt>Model</dt><dd>${esc(modelLabel(choice))}</dd><dt>Execution policy</dt><dd>Review required for each handoff</dd></dl><p class="muted">${selectedType.id==='patch'?'Patch can change only the exact file paths approved for a private copy.':'Pulse can run only the exact test argument arrays approved for a private copy.'} Network is disabled. The user working tree is never changed. ${selectedType.id==='pulse'?'A standing plan and calendar can be separately reviewed on API 21 after creation.':'There are no automatic schedules for this type.'}</p><p class="muted">${seatbeltRunner()?'Each approved test is bounded to 60 seconds wall time, 30 seconds CPU per process and 64 KiB output. On this macOS runner, 512 MiB of memory across all processes, 32 processes and 64 MiB of private scratch are sampled rather than hard-capped. Source is read-only to tests.':'Each approved test is bounded to 60 seconds wall time, 30 seconds CPU and 512 MiB address space per process, 64 KiB output, and 32 processes. Source is read-only to tests, with 64 MiB private scratch. Aggregate memory is sampled rather than hard-capped.'} These limits are reviewed again with each exact command.</p>`,confirm:'Create Pip',request});
    }else void mutate(request,finishCreate);
  }else if(id==='revision-form'){
    const goal=draft.revisionGoal.trim();if(!goal){setError('Say what this Pip should do.');return;}
    void applyOwnChange({goal},d=>d.goal===goal,'Saved. Its next run works on this.').then(ok=>{if(ok){draft.revisionGoal='';S.editingGoal=false;}});
  }else if(id==='schedule-form'){
    if(currentTree()||executionPip(S.pip)&&!pulsePip(S.pip)){setError('Schedules are unavailable for current-tree source and Patch.');return;}
    let verification_plan;try{if(pulsePip(S.pip)){if(S.apiVersion<21)throw Error('Update the computer to Pips API 21 for reviewed Pulse plans.');verification_plan=draft.verificationEnabled?(S.pip.verification_plan?.action?.network==='loopback_http_v1'?pulsePlan({...S.pip.verification_plan,action:{...S.pip.verification_plan.action,tests:pulseCommands}}):pulsePlanFromCommands(pulseCommands)):null;if(draft.scheduleType==='events'||!verification_plan&&draft.scheduleType!=='manual')throw Error('Pulse requires an approved command plan for calendar runs; events are unavailable.');}}catch(error){setError(error);return;}
    if(documentationPip(S.pip)&&draft.scheduleType!=='manual'&&S.apiVersion<20){setError('Update the computer to Pips API 20 to review Quill schedules or event triggers.');return;}
    let schedule=null,event_trigger=null;try{if(draft.scheduleType==='events'){if(S.apiVersion<10)throw new Error('Update the computer to Pips API 10 to review event triggers.');event_trigger=eventTriggerFromDraft(draft,commitRules);if(event_trigger.events.includes('committed_paths_changed')&&S.apiVersion<22)throw Error('Update the computer to Pips API 22 to review committed-path rules.');if(event_trigger.events.includes('session_turn_completed')&&S.apiVersion<18)throw new Error('Update the computer to Pips API 18 to review Session turn saved.');}else schedule=scheduleFromDraft(draft);}catch(error){setError(error);return;}
    if(S.scheduleDraftVersion!==S.pip?.current_version){setError('The Pip changed while you edited its schedule. Reset it and choose again.');return;}
    const changes=verification_plan!==undefined?{verification_plan,schedule,event_trigger:null}:S.apiVersion>=10?{schedule,event_trigger}:{schedule};
    // The full schedule form (events, cron, once, path rules, Pulse commands) shows one review of exactly
    // what will run; the quick control in Settings saves directly.
    void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.scheduleDraftVersion,changes,reason:'Changed in the Pips view.'},result=>{
      const proposal=result.proposal;
      if(!record(proposal)||proposal.pip_id!==S.selected||typeof proposal.id!=='string'||!record(proposal.definition))throw new Error('The saved proposal response was invalid. Refresh before retrying.');
      if(verification_plan!==undefined&&!pulsePlanEqual(proposal.definition.verification_plan,verification_plan))throw Error('The saved Pulse commands differ from this draft. Refresh before accepting.');
      if(S.apiVersion>=10&&(JSON.stringify(eventTrigger(proposal.definition.event_trigger))!==JSON.stringify(event_trigger)||JSON.stringify(proposal.definition.schedule??null)!==JSON.stringify(schedule)))throw new Error('The saved trigger differs from the requested review. Refresh before accepting.');
      S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(p=>p.id!==proposal.id),proposal]};
      S.notice='Trigger or schedule proposal saved. Nothing changes until you accept it. Closing this review keeps it pending.';
      proposalReview(proposal.id);
    });
  }else if(id==='context-form'){
    if(!S.context||!draft.contextTitle.trim()||!draft.contextContent.trim()){setError('Enter a title and context record.');return;}
    const bytes=value=>new TextEncoder().encode(value).length;
    if(bytes(draft.contextTitle.trim())>240||bytes(draft.contextContent)>4096){setError('Use at most 240 UTF-8 bytes for the title and 4096 for the record. Nothing was shortened.');return;}
    openReview({title:'Record workspace context?',description:'This user record will be included in future run snapshots. It does not grant new permissions.',body:`<h3>${esc(draft.contextTitle.trim())}</h3><p class="goal">${esc(draft.contextContent)}</p>`,confirm:'Record context',request:{type:'record_workspace_context',workspace_id:S.workspace.id,kind:draft.contextKind,title:draft.contextTitle.trim(),content:draft.contextContent,expected_revision:S.context.revision}});
  }
});
document.addEventListener('pointerout',event=>{
 const aside=event.target.closest?.('aside');
 if(aside&&!aside.contains(event.relatedTarget))shell.classList.remove('sidebar-dismissed');
});
document.addEventListener('pointerover',event=>{
 if(!event.target.closest?.('aside'))shell.classList.remove('sidebar-dismissed');
});
document.addEventListener('click',event=>{
  const link=event.target.closest?.('.md-link');
  if(link){event.preventDefault();const target=window.DgcMarkdown?.linkTarget?.(link.dataset.target+(link.dataset.line?`:${link.dataset.line}`:''));if(target?.kind==='external')vscode.postMessage({type:'openExternal',url:target.target});else if(target?.kind==='file')vscode.postMessage({type:'openFile',path:target.target,line:target.line});return;}
  const copy=event.target.closest?.('button.copy[data-c]');if(copy){event.preventDefault();try{vscode.postMessage({type:'copy',text:decodeURIComponent(copy.dataset.c)});copy.classList.add('done');copy.title='Copied';copy.setAttribute('aria-label','Copied');copy.innerHTML=transcriptIcon('check');}catch{/* malformed generated data is not copied */}return;}
  const target=event.target.closest('button');if(!target||target.disabled)return;
  if(target.id==='chat-attach'){$('chat-attach-input')?.click();return;}
  if(target.dataset.removeImage!==undefined){const i=Number(target.dataset.removeImage),images=[...pendingImages()];if(Number.isInteger(i)&&i>=0&&i<images.length){images.splice(i,1);images.length?chatImages.set(S.selected,images):chatImages.delete(S.selected);render();$('chatText')?.focus();}return;}
  if(target.dataset.newCharacter){if(SIMPLE_CHARACTERS.includes(target.dataset.newCharacter)&&target.dataset.newCharacter!=='core'){draft.newPipCharacter=target.dataset.newCharacter;if(S.review?.newPip){S.review.body=newPipBody();renderReview();}}return;}
  if(target.id==='pin-pips-sidebar'){S.sidebarPinned=!S.sidebarPinned;rememberView();render();return;}
  if(target.dataset.chatActivity){void toggleChatActivity(target.dataset.chatActivity);return;}
  if(target.dataset.chatAction){
    const m=S.messages.find(m=>m.id===target.dataset.messageId);if(!m)return;
    if(target.dataset.chatAction==='copy'){vscode.postMessage({type:'copy',text:m.text});target.innerHTML=transcriptIcon('check')+'<span class="sr-only">Copied</span>';target.title='Copied';target.setAttribute('aria-label','Copied');const status=target.parentElement.querySelector('.copy-feedback');if(status)status.textContent='Copied';return;}
    const prompt=S.messages.find(p=>p.role==='user'&&p.run_id===m.run_id);if(!prompt||archived()||!usable())return;
    if(draft.chatText.trim()&&draft.chatText!==prompt.text){S.notice='Your unsent draft is still in the composer. Copy this message or send your draft before editing an earlier prompt.';render();return;}
    draft.chatText=prompt.text;chatDrafts.set(S.selected,draft.chatText);rememberView();render();$('chatText')?.focus();
    if(target.dataset.chatAction==='retry')void sendChat();
    return;
  }
  if(target.dataset.removeCommitRule!==undefined){if(S.busy||archived()||S.apiVersion<22)return;const i=Number(target.dataset.removeCommitRule);if(Number.isInteger(i)&&i>=0&&i<commitRules.length&&commitRules.length>1){commitRules.splice(i,1);S.scheduleDirty=true;render();}return;}
  if(target.dataset.pulseAddArg!==undefined||target.dataset.pulseRemoveArg!==undefined||target.dataset.pulseRemoveCommand!==undefined){
    if(S.busy||archived()||S.apiVersion<21)return;
    if(target.dataset.pulseAddArg!==undefined){const row=pulseCommands[Number(target.dataset.pulseAddArg)];if(row&&row.argv.length<32)row.argv.push('');}
    if(target.dataset.pulseRemoveArg!==undefined){const [i,j]=target.dataset.pulseRemoveArg.split(':').map(Number);if(j>0)pulseCommands[i]?.argv.splice(j,1);}
    if(target.dataset.pulseRemoveCommand!==undefined&&pulseCommands.length>1)pulseCommands.splice(Number(target.dataset.pulseRemoveCommand),1);
    S.scheduleDirty=true;render();return;
  }
  if(target.dataset.commandReceipt){void openCommandReceipt(target.dataset.commandReceipt);return;}
  if(target.dataset.outcome){void openOutcome(target.dataset.outcome);return;}
  if(target.dataset.rejectOutcome){void openOutcome(target.dataset.rejectOutcome,true);return;}
  if(target.dataset.pipType){chooseType(target.dataset.pipType);return;}
  if(target.dataset.starter){openStarter(target.dataset.starter);return;}
  if(target.dataset.computerAction){void openComputerAction(target.dataset.computerAction);return;}
  if(target.dataset.revokeGrant){revokeGrant(target.dataset.revokeGrant);return;}
  if(target.dataset.job){if(event.detail>0&&!S.sidebarPinned)shell.classList.add('sidebar-dismissed');void select(target.dataset.job);return;}
  if(target.dataset.chatRun){S.tab='runs';S.overview=false;render();void loadRun(target.dataset.chatRun);return;}
  if(target.dataset.run){void loadRun(target.dataset.run);return;}
  if(target.dataset.readNotification){void markNotification(target.dataset.readNotification);return;}
  if(target.dataset.openNotification){void openNotification(target.dataset.openNotification);return;}
  if(target.dataset.tab){document.querySelectorAll('details[data-details="tabs-more"],details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));S.tab=target.dataset.tab;S.create=false;S.overview=false;rememberView();render();if(S.tab==='memory'){void loadMemories();if(S.apiVersion>=19)void loadStatements();}else if(S.tab==='notifications')void loadNotifications();else if(S.tab==='chat')void loadMessages();else if(S.tab==='runs')void loadSelected(true);else if(S.tab==='job')void loadModels();else if(S.tab==='context'&&S.apiVersion>=12){if(!outcomeSessionsLoaded)void loadOutcomeSessions();if(!outcomeLoaded)void loadOutcomes();}else if(S.tab==='handoffs'&&!S.handoffsLoaded)void loadHandoffs();return;}
  if(target.dataset.recordException!==undefined){void reviewException(Number(target.dataset.recordException));return;}
  if(target.dataset.revokeStatement){revokeStatementReview(target.dataset.revokeStatement);return;}
  if(target.dataset.revokeMemory){revokeMemoryReview(target.dataset.revokeMemory);return;}
  if(target.dataset.executionReview){
    try{const r=executionReview(S.run?.execution_review,S.runId),status=target.dataset.executionReview;if(!r||status===r.status||!['accepted','dismissed','open'].includes(status)||S.run?.status!=='succeeded')return;
      draft.findingReviewReason='';openReview({title:status==='accepted'?'Accept this execution outcome?':status==='dismissed'?'Dismiss this execution outcome?':'Reopen this execution outcome?',description:'Record your assessment of this exact saved result. This does not apply changes, merge, deploy, or establish that all tests passed.',body:`<p class="mono">Run ${esc(S.runId)}</p><p>${esc(r.status)} → ${esc(status)} · review v${r.revision}</p><details><summary>Result identity</summary><p class="mono">${esc(r.result_digest)}</p></details>`,reasonRequired:true,note:'Note (optional)',autoReason:'Reviewed in the Pips view.',confirm:'Record outcome decision',request:{type:'review_pip_execution',run_id:S.runId,status,expected_revision:r.revision}});
    }catch(error){setError(error);}return;
  }
  if(target.id==='handoff-personal'){
    if(!remoteHost&&S.apiVersion>=30&&personalPip()&&!archived()&&S.run?.status==='succeeded'&&S.run.manifest?.run_kind==='personal_task'&&typeof S.run.result?.text==='string'){S.handoffDraft={personal:true,runId:S.runId,text:S.run.result.text,sourceName:S.pip.name};draft.handoffText=S.run.result.text;draft.handoffTask='';draft.handoffTarget='';S.tab='handoffs';S.error='';render();void loadHandoffs();}return;
  }
  if(target.id==='handoff-artifact'){
    try{const source=patchSource(S.run);if(!source)return;S.handoffDraft={runId:S.runId,artifact:source,sourceName:S.pip.name};draft.handoffTask='Test the accepted Patch artifact with the reviewed commands.';draft.handoffTarget='';draft.handoffPaths='';draft.handoffTests='[]';draft.specialistExplorer=false;draft.specialistCritic=false;draft.specialistWorker=false;draft.specialistCalls='1';S.tab='handoffs';S.error='';render();void loadHandoffs();}catch(error){setError(error);}return;
  }
  if(target.dataset.handoffFinding!==undefined){
    try{if(currentTree()||!handoffSourceAllowed(S.run?.manifest))throw new Error('Handoffs require committed source.');const c=runCheckpoint(S.run?.checkpoint,{id:S.runId,pip_id:S.selected,workspace_id:S.workspace.id}),index=Number(target.dataset.handoffFinding),f=c?.findings[index];if(!f)return;S.handoffDraft={runId:S.runId,index,finding:f,sourceName:S.pip.name};draft.handoffTask='Investigate: '+f.title;draft.handoffTarget='';draft.handoffPaths=f.path;draft.handoffTests='[]';draft.specialistExplorer=false;draft.specialistCritic=false;draft.specialistWorker=false;draft.specialistCalls='1';S.tab='handoffs';S.error='';render();void loadHandoffs();}catch(error){setError(error);}return;
  }
  if(target.dataset.chatModel){reviewChatModel(target.dataset.chatModel);return;}
  if(target.dataset.setup){void openSetup(target.dataset.setup);return;}
  if(target.dataset.rejectSetup){void openSetup(target.dataset.rejectSetup,true);return;}
  if(target.dataset.handoff){void openSavedHandoff(target.dataset.handoff);return;}
  if(target.dataset.rejectHandoff){void openSavedHandoff(target.dataset.rejectHandoff,true);return;}
  if(target.dataset.lineagePip){void openLineage(target.dataset.lineagePip,target.dataset.lineageRun);return;}
  if(target.dataset.proposal){proposalReview(target.dataset.proposal);return;}
  if(target.dataset.reject){proposalReview(target.dataset.reject,true);return;}
  if(target.dataset.archive){const entry=S.context?.entries.find(e=>e.id===target.dataset.archive);if(entry)openReview({title:'Archive this context record?',description:'It will be excluded from future runs. Existing run snapshots retain it.',body:`<h3>${esc(entry.title)}</h3><p class="goal">${esc(entry.content)}</p>`,confirm:'Archive record',request:{type:'archive_workspace_context',workspace_id:S.workspace.id,entry_id:entry.id,expected_revision:S.context.revision}});return;}
  if(target.dataset.reviewFinding!==undefined){
    try{const c=runCheckpoint(S.run?.checkpoint,{id:S.runId,pip_id:S.selected,workspace_id:S.workspace.id}),index=Number(target.dataset.reviewFinding),f=c?.findings[index],status=target.dataset.reviewStatus;if(!f||!['accepted','dismissed','open'].includes(status)||status===f.review.status)return;
      draft.findingReviewReason='';openReview({title:status==='accepted'?'Accept this assessment?':status==='dismissed'?'Dismiss this assessment?':'Reopen this assessment?',description:'This records your Pip-local decision. It does not verify the model’s conclusion, mark code as fixed, or add workspace context.',body:`<h3>${esc(f.title)}</h3><p class="mono">${esc(f.path)}:${f.line}</p><pre>${esc(f.evidence)}</pre><p class="muted">${esc(f.review.status)} → ${esc(status)} · review v${f.review.revision}</p>`,reasonRequired:true,note:'Note for the Pip (optional)',autoReason:'Reviewed in the Pips view.',confirm:'Record decision',request:{type:'review_pip_finding',run_id:S.runId,finding_index:index,status,expected_revision:f.review.revision}});
    }catch(error){setError(error);}return;
  }
  if(target.id==='record-execution-context'){
    try{const run=S.run,r=executionReview(run?.execution_review,run?.id);if(!run||run.status!=='succeeded'||!r||r.status!=='accepted'||!S.context)return;
      const pin=handoffPin(run.manifest.handoff,run,S.workspace.id),e=executionResult(run.result?.execution,run.manifest.run_kind,pin.payload.action,pin.payload);
      openReview({title:'Record this reviewed outcome?',executionResultDigest:r.result_digest,description:'The computer will construct a historical runner receipt for future workspace context. Model conclusions, raw command arguments and command output are not promoted. This does not apply changes or grant permission.',body:`<dl class="meta"><dt>Source run</dt><dd class="mono">${esc(run.id)}</dd><dt>Source revision</dt><dd class="mono">${esc(run.manifest.source_revision)}</dd><dt>Result SHA-256</dt><dd class="mono">${esc(r.result_digest)}</dd><dt>Accepted review</dt><dd>v${r.revision}</dd><dt>Workspace context</dt><dd>v${S.context.revision}</dd><dt>Private changed files</dt><dd>${e.changes.changed_files.length}</dd><dt>Recorded test commands</dt><dd>${e.tests.length}</dd></dl><p class="muted">Historical evidence at that review revision, not proof of correctness or current source health. Later reviews do not rewrite this receipt; archive it explicitly if needed.</p>`,confirm:'Record reviewed outcome',request:{type:'accept_pip_execution_context',workspace_id:S.workspace.id,run_id:run.id,expected_revision:S.context.revision,expected_review_revision:r.revision}});
    }catch(error){setError(error);}return;
  }
  if(target.dataset.finding!==undefined){const index=Number(target.dataset.finding),finding=report(S.run?.result)?.findings[index];if(!finding||!S.context)return;openReview({title:'Save this model assessment?',description:'The exact source excerpt will become workspace context. The conclusion stays labelled as a model assessment, not a verified fact.',body:`<h3>${esc(finding.title)}</h3><p class="mono">${esc(finding.path)}:${finding.line}</p><pre>${esc(finding.evidence)}</pre><p class="muted">From run ${esc(S.run.id)} · context v${S.context.revision}</p>`,confirm:'Save assessment',request:{type:'accept_pip_finding',workspace_id:S.workspace.id,run_id:S.run.id,finding_index:index,expected_revision:S.context.revision}});return;}
  if(target.dataset.emailDraft){void openEmailDraft(target.dataset.emailDraft);return;}
  if(target.dataset.calendarDraftMore){void emailDraftHistory(target.dataset.calendarDraftMore,true);return;}
  if(target.dataset.emailDraftMore){void emailDraftHistory(target.dataset.emailDraftMore);return;}
  if(target.dataset.connectorConnection){void chooseConnectorTool(target.dataset.connectorConnection);return;}
  if(target.dataset.messageConnection){void chooseMessageAccount(target.dataset.messageConnection);return;}
  if(target.dataset.messageReview){void openMessageReview(target.dataset.messageReview);return;}
  if(target.dataset.messageMore){void messageReviews(target.dataset.messageMore);return;}
  switch(target.id){
    case 'workspace-notifications':S.tab='notifications';S.overview=false;S.create=false;rememberView();render();void loadNotifications();break;
    case 'refresh-notifications':void loadNotifications();break;
    case 'more-notifications':void loadNotifications(true);break;
    case 'workspace-context':S.tab='context';S.overview=false;S.create=false;rememberView();render();if(S.apiVersion>=12){if(!outcomeSessionsLoaded)void loadOutcomeSessions();if(!outcomeLoaded)void loadOutcomes();}break;
    case 'load-outcome-sessions':void loadOutcomeSessions();break;
    case 'more-outcome-sessions':void loadOutcomeSessions(true);break;
    case 'inspect-outcome-session':void inspectOutcomeSession();break;
    case 'use-outcome-run':if(S.run?.status==='succeeded'){draft.outcomeSourceValue=S.run.id;render();}break;
    case 'load-command-receipts':void loadCommandReceipts();break;
    case 'more-command-receipts':void loadCommandReceipts(true);break;
    case 'load-outcomes':void loadOutcomes();break;
    case 'more-outcomes':void loadOutcomes(true);break;
    case 'reconnect':vscode.postMessage({type:'pipsReconnect'});break;
    case 'enable':if(!remoteHost)void enable();break;
    case 'new-pip':case 'create-first':setupEditing=false;rememberCreationDraft();S.create=true;S.overview=false;S.createStep=S.apiVersion>=23?'describe':'type';S.tab='runs';S.error='';render();($('setupTask')||document.querySelector('[data-pip-type]:not(:disabled)'))?.focus();void loadModels();break;
    case 'advanced-create':S.createStep='type';render();document.querySelector('[data-pip-type]:not(:disabled)')?.focus();break;
    case 'connector-drafts-more':void connectorDraftHistory(S.review?.connectorCursor);break;
    case 'connector-drafts':void connectorDraftHistory();break;
    case 'dismiss-connector-draft':{const d=S.review?.savedConnectorDraft;if(d&&!S.busy)void mutate({type:'dismiss_pip_connector_draft',draft_id:d.id,expected_digest:d.digest},r=>{const v=connectorDraft(r.draft,S.selected,S.workspace.id);if(v.id!==d.id||v.digest!==d.digest||v.status!=='dismissed')throw Error('Dismissal did not match the draft.');void loadConnectorDrafts();});break;}
    case 'calendar-drafts':void emailDraftHistory(null,true);break;
    case 'email-drafts':void emailDraftHistory();break;
    case 'dismiss-email-draft':{const d=S.review?.emailDraft;if(d&&!S.busy)void mutate({type:d.id.startsWith('caldraft_')?'dismiss_pip_calendar_draft':'dismiss_pip_message_draft',draft_id:d.id,expected_digest:d.digest},r=>{const v=emailDraft(r.draft,S.selected,S.workspace.id,d.id.startsWith('caldraft_'));if(v.id!==d.id||v.digest!==d.digest||v.status!=='dismissed')throw Error('The dismissal does not match this draft.');void loadEmailDrafts();});break;}
    case 'prepare-connector':void chooseConnectorConnection();break;
    case 'prepare-calendar':void chooseMessageConnection(null,true);break;
    case 'prepare-message':void chooseMessageConnection();break;
    case 'message-reviews':void messageReviews();break;
    case 'reject-message-review':{const r=S.review;if(r?.messageAction&&!S.busy)void mutate({type:'reject_pip_app_action',action_id:r.messageAction,expected_digest:r.messageDigest},result=>{const a=messageReview(result.action,S.selected,S.workspace.id);if(a.id!==r.messageAction||a.digest!==r.messageDigest||a.status!=='rejected')throw Error('The rejection receipt does not match this review.');showMessageReview(a);});break;}
    case 'choose-app-access':void chooseAppConnection();break;
    case 'setup-apps':setupEditing=true;S.create=true;S.overview=false;S.createStep='describe';draft.setupTask=`Help ${S.pip.name} use an app I connected in DGC Settings. Inspect the existing connection metadata, ask what I want to read and which account to use, then propose exact read access for review. Do not sign in again or activate anything yet.`;render();break;
    case 'remove-github-reads':
      if(githubPip()&&S.pip.github_plan)void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{github_plan:null},reason:'Remove this Pip’s GitHub reads.'},result=>{S.pip={...S.pip,proposals:[...(S.pip.proposals||[]),result.proposal]};proposalReview(result.proposal.id);});break;
    case 'remove-web-reads':
      if(personalPip()&&S.pip.web_plan)void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{web_plan:null},reason:'Remove this personal Pip’s web reads.'},result=>{draft.webReads='';S.pip={...S.pip,proposals:[...(S.pip.proposals||[]),result.proposal]};proposalReview(result.proposal.id);});break;
    case 'remove-app-access':
      if(personalPip()&&S.pip.app_plan)void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{app_plan:null},reason:'Remove this personal Pip’s app-read access.'},result=>{S.pip={...S.pip,proposals:[...(S.pip.proposals||[]),result.proposal]};proposalReview(result.proposal.id);});break;
    case 'setup-in-chat':if(S.apiVersion>=23&&!archived()){setupEditing=true;S.create=true;S.overview=false;S.createStep='describe';draft.setupTask=`Change the setup for ${S.pip.name}: `;render();$('setupTask')?.focus();}break;
    case 'refresh-setups':void loadSetups();break;
    case 'give-computer':grantComputer(true);break;
    case 'remove-computer':grantComputer(false);break;
    case 'stop-computer':void computerCommand('stop_pip_computer','Stopping the computer. Anything waiting for you is cancelled.');break;
    case 'open-computer':openComputerView();break;
    case 'computer-timeline':void openComputerTimeline();break;
    case 'computer-prev':if(computerTimeline)void showTimelineFrame(computerTimeline.index-1);break;
    case 'computer-next':if(computerTimeline)void showTimelineFrame(computerTimeline.index+1);break;
    case 'reject-computer-action':if(S.review?.computerAction)void decideComputerAction(S.review,false);break;
    case 'computer-back':void computerView('back',{});break;
    case 'computer-enter':void computerView('key',{key:'Enter'});break;
    case 'computer-tab':void computerView('key',{key:'Tab'});break;
    case 'computer-backspace':void computerView('key',{key:'Backspace'});break;
    case 'computer-scroll-down':void computerView('scroll',{dy:500});break;
    case 'computer-scroll-up':void computerView('scroll',{dy:-500});break;
    case 'remove-usage-limit':saveUsageLimit(null);break;
    case 'rate-up':saveFeedback('up');break;
    case 'rate-down':saveFeedback('down');break;
    case 'rate-clear':saveFeedback(null);break;
    case 'import-pip-file':void importPipFile();break;
    case 'export-pip-file':void exportPipFile();break;
    case 'refresh-findings':outcomeState.pip='';void loadFindingOutcomes();break;
    case 'back-types':rememberCreationDraft();S.createStep='type';render();[...document.querySelectorAll('[data-pip-type]')].find(b=>b.dataset.pipType===S.createType)?.focus();break;
    case 'cancel-create':rememberCreationDraft();S.create=false;S.overview=!S.selected;render();break;
    case 'back-pips':chatDrafts.set(S.selected,draft.chatText);if(!S.selected)S.tab='chat';S.overview=true;rememberView();render();break;
    case 'return-main':options.close?.();break;
    case 'chat-review-setups':S.overview=true;rememberView();render();break;
    case 'chat-model':S.composerPanel=S.composerPanel==='model'?'':'model';draft.chatModelSearch='';render();if(S.composerPanel){void loadModels();$('chatModelSearch')?.focus();}break;
    case 'chat-model-close':S.composerPanel='';render();$('chat-model')?.focus();break;
    case 'chat-context-toggle':S.composerPanel=S.composerPanel==='context'?'':'context';render();if(S.composerPanel)($('chat-context')||$('chat-context-close'))?.focus();break;
    case 'chat-context-close':S.composerPanel='';render();$('chat-context-toggle')?.focus();break;
    case 'chat-refresh-models':void loadModels();break;
    case 'chat-permissions':S.composerPanel='';render();openReview({title:'Read-only Pip chat',description:personalPip()?'This Pip has no project file, shell or browser tools. It can use details you share and separately reviewed app reads. No messages are sent and no external actions are performed.':'Messages can inspect the captured source. They cannot run shell commands, browse a live application, edit files, or change permissions. Execution is configured separately through a reviewed job or handoff.',readOnly:true,request:{}});break;
    case 'older-messages':void loadMessages(true);break;
    case 'refresh-models':void loadModels();break;
    case 'chat-stop':if(S.chatActiveRun?.id)void mutate({type:'cancel_pip_run',run_id:S.chatActiveRun.id},()=>loadMessages());break;
    case 'refresh':S.error='';S.notice='';void refresh(true);break;
    case 'open-personal-result':case 'save-personal-result':
      if(!remoteHost&&S.run?.status==='succeeded'){void send('open_pip_document',{run_id:S.run.id,save:target.id==='save-personal-result'}).catch(setError);}break;
    case 'copy-personal-result':
      if(S.run?.manifest?.run_kind==='personal_task'&&S.run.status==='succeeded'&&typeof S.run.result?.text==='string'){if(!window.navigator.clipboard?.writeText){setError('Select the result text to copy it.');break;}void window.navigator.clipboard.writeText(S.run.result.text).catch(()=>setError('Select the result text to copy it.'));}break;
    case 'copy-draft':{
      const token=scope();try{const result=documentationDraft(S.run?.result);if(S.run?.manifest?.run_kind!=='draft'||S.run.status!=='succeeded')return;checkedRunSource(S.run);if(!window.navigator.clipboard?.writeText)throw new Error('Clipboard access is unavailable. Select the draft text and copy it manually.');void window.navigator.clipboard.writeText(result.draft.markdown).then(()=>{if(token===scope()){S.notice='Draft copied. Nothing was published or applied.';render();}},()=>{if(token===scope())setError('Clipboard access was refused. Select the draft text and copy it manually.');});}catch(error){setError(error);}break;
    }
    case 'download-draft':{
      if(!remoteHost||options.downloadDraft===false)return;try{const result=documentationDraft(S.run?.result);if(S.run?.manifest?.run_kind!=='draft'||S.run.status!=='succeeded')return;checkedRunSource(S.run);const url=window.URL.createObjectURL(new window.Blob([result.draft.markdown],{type:'text/markdown;charset=utf-8'})),link=owner.createElement('a');link.href=url;link.download='quill-draft.md';link.hidden=true;owner.body.append(link);link.click();link.remove();window.setTimeout(()=>window.URL.revokeObjectURL(url),0);}catch(error){setError(error);}break;
    }
    case 'run':if(pulsePip(S.pip)){try{if(S.apiVersion<21)throw Error('Update the computer to Pips API 21 for standalone Pulse commands.');if(!supportedSource()||!S.runner?.online||S.runner.paused||S.pip.status!=='active'||S.pip.active_run||S.runs.some(r=>active(r.status)))break;const pins=pulseRunPins(S.pip);void mutate({type:'run_pip',pip_id:S.selected,idempotency_key:`editor-${globalThis.crypto.randomUUID()}`,...pins},async result=>{await loadRun(result.run.id);});}catch(error){setError(error);}break;}if(supportedSource()&&!executionPip(S.pip)&&S.runner?.online&&!S.runner.paused&&S.pip?.status==='active'&&pipType(S.pip,S.types)?.available&&!S.pip.active_run)void mutate({type:'run_pip',pip_id:S.selected,idempotency_key:`editor-${Date.now()}-${globalThis.crypto.randomUUID()}`},async result=>{await loadRun(result.run.id);});break;
    case 'toggle-pip':if(archived())break;if(S.apiVersion>=16&&!canLifecycle()){setError('Refresh the Pip to obtain its current lifecycle revision.');break;}void mutate({type:S.pip.status==='paused'?'resume_pip':'pause_pip',pip_id:S.selected,...(S.apiVersion>=16?{expected_lifecycle_revision:S.pip.lifecycle_revision}:{})});break;
    case 'archive-pip':reviewLifecycle(false);break;
    case 'restore-pip':reviewLifecycle(true);break;
    case 'show-archived':S.showArchived=!S.showArchived;render();break;
    case 'cancel-run':openReview({title:'Cancel this run?',description:'The runner will stop this run. Cancellation may take a moment to be confirmed.',body:`<p class="mono">${esc(S.runId)}</p>`,confirm:'Cancel run',danger:true,request:{type:'cancel_pip_run',run_id:S.runId}});break;
    case 'stop-all':openReview({title:'Stop all local Pips?',description:'This stops Pips across every workspace on this computer: active jobs are paused and queued or running Pip runs are cancelled. The stop persists after restarting DGC.',body:'<p class="muted">To recover, explicitly Resume runner here, then resume individual Pips. From a local terminal, use <code>dgc pips resume</code>, then <code>dgc pips serve</code>.</p>',confirm:'Stop all Pips',danger:true,request:{type:'stop_pips'}});break;
    case 'start-runner':if(remoteHost)break;void mutate({type:'pips_runtime',action:'start'});break;
    case 'resume-runner':if(remoteHost)break;openReview({title:'Resume the local runner?',description:'Clear the persistent global stop and start the local runner. Individual Pips remain paused until you explicitly resume them.',confirm:'Resume runner',request:{type:'pips_runtime',action:'resume'}});break;
    case 'disable':if(remoteHost)break;openReview({title:'Disable local Pips?',description:'This first stops all Pips across local workspaces, pauses their jobs, and cancels active runs. It then disables Pips. Enabling it later does not clear the global stop.',confirm:'Stop and disable',danger:true,request:{type:'pips_enable',enabled:false}});break;
    case 'check-execution':void loadExecution();break;
    case 'load-statements':void loadStatements();break;
    case 'more-statements':void loadStatements(true);break;
    case 'load-memories':void loadMemories();break;
    case 'more-memories':void loadMemories(true);break;
    case 'load-handoffs':void loadHandoffs();break;
    case 'more-handoffs':void loadHandoffs(true);break;
    case 'cancel-handoff-draft':S.handoffDraft=null;render();break;
    case 'load-checkpoints':void loadCheckpoints();break;
    case 'more-checkpoints':void loadCheckpoints(true);break;
    case 'load-activity':void loadActivity();break;
    case 'load-history':void history();break;
    case 'load-approvals':void loadApprovals();break;
    case 'more-approvals':void loadApprovals(true);break;
    case 'load-adaptations':void loadAdaptations();break;
    case 'more-adaptations':void loadAdaptations(true);break;
    case 'reset-source':S.sourceDirty=false;draft.sourceReason='';hydrateSource(S.pip);S.error='';render();break;
    case 'reset-adaptation':S.adaptationDirty=false;draft.adaptationReason='';hydrateAdaptation(S.pip);S.error='';render();break;
    case 'add-commit-rule':if(S.apiVersion>=22&&!S.busy&&!archived()&&commitRules.length<32){commitRules.push({kind:'exact',path:''});S.scheduleDirty=true;render();}break;
    case 'pulse-add-command':if(pulseCommands.length<4){pulseCommands.push({argv:[''],cwd:'.'});S.scheduleDirty=true;render();}break;
    case 'reset-schedule':S.scheduleDirty=false;draft.scheduleReason='';hydrateSchedule(S.pip);S.error='';render();break;
    case 'more-history':void history(true);break;
    case 'review-cancel':if(!S.busy)closeReview();break;
    case 'review-always':{
      // This one now, and the same kind of action with this connection, account and tool from now on.
      const review=S.review;if(!review||review.scope!==scope()||!usable()||!review.always||reviewBlocked(review))return;
      const pip=S.selected;
      if(review.computerAction){
        // This submit now, and the same kind on this site (method and path) from now on, from this Pip's computer.
        void mutate({type:'always_allow_pip_computer_action',action_id:review.request.action_id,expected_digest:review.request.expected_digest},result=>{
          const a=pipComputerAction(result.action,pip),g=actionGrant(result.grant);
          if(a.id!==review.computerAction||a.status!=='approved')throw Error('The saved decision differs from your choice. Refresh to see it.');
          computerState.pip='';grantsState.pip='';
          S.notice=`Always allowed: ${g.label}. It is sent within a few seconds, and this Pip will do the same there without asking and tell you after.`;
        });
        break;
      }
      void mutate({type:'always_allow_pip_app_action',action_id:review.request.action_id,expected_digest:review.request.expected_digest},result=>{
        const a=messageReview(result.action,pip,S.workspace.id),g=actionGrant(result.grant);
        if(a.id!==review.messageAction||a.digest!==review.messageDigest)throw Error('The receipt does not match this saved review.');
        grantsState.pip='';
        S.notice=`Always allowed: ${g.label}. This Pip will do this again without asking and tell you after. Take it back under Allowed without asking in its Job tab.`;
        showMessageReview(a);
      });
      break;
    }
    case 'simple-new':openNewPip();break;
    case 'create-core':void createSimplePip('core','Core');break;
    case 'simple-back':chatDrafts.set(S.selected,draft.chatText);S.overview=true;rememberView();render();break;
    case 'simple-to-chat':S.tab='chat';rememberView();render();void loadMessages();break;
    case 'pip-computer-open':{
      // The Pip's computer, one tap from its chat: open its screen, or offer it one.
      if(S.apiVersion<42||!personalPip()||archived())break;
      const open=()=>{if(computerState.pip!==S.selected||!computerState.value)return;if(computerState.value.granted)void openComputerView();else grantComputer(true);};
      if(computerState.pip===S.selected&&computerState.value)open();else void loadComputer().then(open);
      break;}
    case 'edit-goal':S.editingGoal=true;draft.revisionGoal=S.pip?.goal||'';render();$('revisionGoal')?.focus();break;
    case 'cancel-goal':S.editingGoal=false;draft.revisionGoal='';render();break;
    case 'review-confirm':{
      const review=S.review;if(!review||review.scope!==scope()||!usable())return;
      if(review.emailDraft){void chooseMessageConnection(review.emailDraft,review.calendarAction===true);return;}
      if(review.savedConnectorDraft){void chooseConnectorTool(review.savedConnectorDraft.payload.action.server,review.savedConnectorDraft);return;}
      if(review.connectorForm){prepareConnector(review);return;}
      if(review.newPip){void createSimplePip(draft.newPipCharacter,draft.newPipName,review);return;}
      if(review.computerGrant!==undefined){void applyComputerGrant(review);return;}
      if(review.computerAction){if(!reviewBlocked(review))void decideComputerAction(review,true);else{review.error='This action expired. Nothing was sent.';renderReview();}return;}
      if(review.messageForm){prepareMessage(review);return;}
      if(review.appPicker){prepareAppReview(review);return;}
      if(review.starterForm){prepareStarter(review);return;}
      if(review.setup){void resolveSetup(review);return;}
      if(reviewBlocked(review)){review.error='This review is stale or expired. Refresh before making a new proposal.';renderReview();return;}
      if(review.rejectFirst?.length){void rejectWaitingThenConfirm(review);return;}
      let reason;if(review.reasonRequired){reason=(review.note&&draft.findingReviewReason.trim())||review.autoReason||'Decided in the Pips view.';if(new TextEncoder().encode(reason).length>1000){review.error='Keep the note under 1,000 UTF-8 bytes.';renderReview();$('findingReviewReason')?.focus();return;}}
      let memoryArgs={};if(review.lifecycle){const body=JSON.stringify({reason});if(review.lifecycleRetry?.body!==body)review.lifecycleRetry={body,key:window.crypto.randomUUID()};memoryArgs={request_key:review.lifecycleRetry.key};}
      if(review.memoryRecord){
        const raw=draft.memoryExpiry.trim();let expiry=null;if(raw){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw)||Number.isNaN(Date.parse(raw))||Date.parse(raw)<=Date.now()){review.error='Enter a future time with seconds and an explicit offset or Z.';renderReview();return;}expiry=new Date(raw).toISOString();}
        const keyBody=JSON.stringify({reason,expiry});if(review.memoryRetry?.body!==keyBody)review.memoryRetry={body:keyBody,key:window.crypto.randomUUID()};memoryArgs={expires_at:expiry,request_key:review.memoryRetry.key};
      }
      void mutate({...review.request,...(reason?{reason}:{}),...memoryArgs},async result=>{
        if(review.request.type==='accept_pip_app_action'){const a=messageReview(result.action,S.selected,S.workspace.id);if(a.id!==review.messageAction||a.digest!==review.messageDigest)throw Error('The send receipt does not match this saved review.');showMessageReview(a);return;}
        if(review.request.type==='record_workspace_execution_context'){
          const c=context(result.context,S.workspace.id),saved=commandRecording(result.recording),q=review.request;
          if(typeof result.replayed!=='boolean'||saved.created_revision!==q.expected_context_revision+1||c.revision<saved.created_revision)throw Error('The command context receipt does not match the reviewed revision. Refresh before retrying.');
          const entry=c.entries.find(e=>e.id===saved.id);
          if(!result.replayed&&(saved.status!=='active'||c.revision!==saved.created_revision)||saved.status==='active'&&!entry)throw Error('The recorded command context is missing from the returned revision.');
          if(entry){commandOutcomeEntry(entry,S.workspace.id);const p=entry.provenance;if(p.attempt_id!==q.attempt_id||p.attempt_digest!==q.expected_attempt_digest||p.final_digest!==q.expected_final_digest||p.view_digest!==q.expected_view_digest||entry.created_revision!==saved.created_revision)throw Error('The recorded command differs from the reviewed receipt.');}
          S.context=c;S.notice=result.replayed?`The original command-outcome recording was replayed (${saved.status}). No context was appended again.`:'Historical command outcome recorded. No command ran, and no tests-passed or correctness claim was added.';commandLoaded=false;void loadCommandReceipts();return;
        }
        if(['archive_pip','restore_pip'].includes(review.request.type)){const v=archivalResult(result,{...review.request,reason},S.workspace.id);S.pip=v.pip;S.jobs=S.jobs.map(p=>p.id===v.pip.id?v.pip:p);draft.findingReviewReason='';S.notice=v.replayed?`The original ${v.receipt.operation} receipt was replayed; current status is ${v.pip.status}. No transition was repeated.`:v.receipt.operation==='archive'?'Pip archived. All conversation and evidence history remains saved.':'Pip restored to paused. Resume explicitly when you want automation active.';return;}
        if(['record_pip_statement','revoke_pip_statement'].includes(review.request.type)){
          const q={...review.request,...(reason?{reason}:{})},v=pipStatementResult(result,q,S.workspace.id,review.statementAnchor,review.statementMemory);
          if(q.type==='record_pip_statement'){draft.statementTitle='';draft.statementText='';draft.statementReason='';draft.statementExpiry='';statementRetry=null;}else draft.findingReviewReason='';
          S.notice=v.replayed?'The original statement receipt was replayed; it was not reactivated or duplicated.':q.type==='record_pip_statement'?'Pip-local reference recorded. No finding, shared context, job or permission changed.':'Statement revoked for future references. Existing queue-time history remains unchanged.';statementLoaded=false;void loadStatements();return;
        }
        if(['record_pip_exception','revoke_pip_exception'].includes(review.request.type)){
          const m=pipMemory(result.memory,S.selected,S.workspace.id);if(typeof result.replayed!=='boolean'||(review.memoryRecord?(m.source.run_id!==review.request.run_id||m.source.finding_index!==review.request.finding_index||!pipExceptionSourceEqual(m.source,review.memorySource)):m.id!==review.request.memory_id||m.status!=='revoked'||m.revision!==1))throw Error('The memory receipt does not match this review. Refresh its history.');
          draft.findingReviewReason='';draft.memoryExpiry='';S.notice=review.memoryRecord?(m.status==='revoked'?'The original exception is already revoked. Retrying did not reactivate it.':'Pip exception recorded as reference only. Findings and workspace context were not changed.'):'Exception revoked for future audit and read-only Pip chat references. Already queued runs retain their historical pin.';memoryLoaded=false;void loadMemories();return;
        }
        if(['accept_pip_handoff','reject_pip_handoff'].includes(review.request.type)){
          const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.id!==review.request.handoff_id)throw new Error('The handoff resolution does not match this review.');
          if(review.request.type==='accept_pip_handoff'&&(!record(result.run)||result.run.id!==h.run_id||result.run.pip_id!==h.target_pip_id))throw new Error('The queued run does not match the approved handoff. Refresh its history.');
          S.notice=review.request.type==='accept_pip_handoff'?'Handoff accepted. One recipient run was queued.':'Handoff rejected. No work was queued.';draft.findingReviewReason='';void loadHandoffs();return;
        }
        if(['accept_workspace_session_outcome','reject_workspace_session_outcome'].includes(review.request.type)){
          if(result.workspace_id!==S.workspace.id)throw Error('The statement resolution belongs to another workspace.');const p=sessionStatement(result.proposal,S.workspace.id),accepted=review.request.type==='accept_workspace_session_outcome';if(p.id!==review.request.proposal_id||p.digest!==review.request.expected_digest||p.status!==(accepted?'accepted':'rejected'))throw Error('The statement resolution does not match this review.');
          if(accepted){const c=context(result.context,S.workspace.id),entry=c.entries.find(e=>e.id===p.entry_id&&e.kind==='session_outcome'&&e.provenance.proposal.id===p.id&&e.provenance.proposal_digest===p.digest);if(typeof result.replayed!=='boolean'||(!result.replayed&&(!entry||c.revision!==review.request.expected_context_revision+1)))throw Error('The recorded context does not match this reviewed statement.');S.context=c;draft.outcomeTitle='';draft.outcomeText='';outcomeRetry=null;}
          S.notice=accepted?'User-reviewed statement recorded. Execution remains unverified; no permission or work was granted.':'Statement rejected. No context or work was created.';outcomeLoaded=false;void loadOutcomes();return;
        }
        if(review.request.type==='create_pip'){await finishCreate(result);return;}
        if(review.request.type==='review_pip_execution'){
          const r=executionReview(result.review,review.request.run_id);if(!r||r.status!==review.request.status||r.revision!==review.request.expected_revision+1)throw new Error('The outcome review response does not match this decision. Refresh the run.');
          if(S.run?.id===review.request.run_id)S.run={...S.run,execution_review:r};draft.findingReviewReason='';S.notice='Outcome decision recorded. No changes were applied or merged.';return;
        }
        if(review.request.type==='accept_pip_execution_context'){
          const c=context(result.context,S.workspace.id),entry=c.entries.find(e=>e.kind==='execution'&&e.provenance.run_id===review.request.run_id&&e.provenance.review_revision===review.request.expected_review_revision);
          if(!entry||entry.provenance.result_digest!==review.executionResultDigest||c.revision!==review.request.expected_revision+1)throw new Error('The recorded context does not match this reviewed outcome. Refresh context before retrying.');
          S.context=c;S.notice='Historical execution receipt recorded. No changes were applied and no new permission was granted.';return;
        }
        if(review.request.type==='review_pip_finding'){const checkpoint=runCheckpoint(result.checkpoint,{id:review.request.run_id,pip_id:S.selected,workspace_id:S.workspace.id});if(!checkpoint)throw new Error('The finding decision response is invalid. Refresh the report.');if(S.run?.id===review.request.run_id)S.run={...S.run,checkpoint};draft.findingReviewReason='';}
        if(review.request.type==='pips_enable'){S.enabled=result.enabled===true;S.runner=null;}
        if(review.request.type==='record_workspace_context'){draft.contextTitle='';draft.contextContent='';}
        if(review.request.type==='accept_pip_update'){S.adaptationDirty=false;draft.adaptationReason='';S.scheduleDirty=false;S.modelDirty=false;draft.modelReason='';draft.scheduleReason='';}
        if(['accept_pip_update','reject_pip_update'].includes(review.request.type)&&S.approvalsLoaded)void loadApprovals();
        S.notice=review.request.type==='review_pip_finding'?'Finding decision recorded. Workspace context was not changed.':review.request.type==='stop_pips'?'Global stop recorded. Runs are being cancelled.':review.request.type==='pips_enable'?'Local Pips disabled.':'Change recorded.';
      });break;
    }
  }
});
document.addEventListener('click',event=>{const img=event.target.closest?.('#computer-screen');if(!img||!img.dataset.width||!S.review?.computerView)return;const r=img.getBoundingClientRect();if(!r.width||!r.height)return;void computerView('click',{x:Math.round((event.clientX-r.left)*Number(img.dataset.width)/r.width),y:Math.round((event.clientY-r.top)*Number(img.dataset.height)/r.height)});});
document.addEventListener('click',event=>{const server=event.target.closest?.('[data-app-connection]')?.dataset.appConnection;if(server)void chooseAppAccount(server);});
document.addEventListener('change',event=>{if(event.target.id==='app-window-mode'){const relative=event.target.value==='calendar_days';$('app-relative-window').hidden=!relative;$('app-fixed-window').hidden=relative;}if(event.target.id==='app-account'&&S.review?.appPicker){const choice=S.review.appPicker.choices[Number(event.target.value)];$('app-calendar-window').hidden=event.target.value===''||choice?.toolkit!=='googlecalendar';const extra=extraReadTools.includes(choice?.tool);$('app-query').placeholder=({googledrive:'File name, for example Budget',notion:'Page title, for example Reading',googlecontacts:'Name, for example Alex',googlecalendar:'Optional event search',gmail:'For example: is:unread'})[choice?.toolkit]||'';$('app-query-label').textContent=extra?'Name or title to search (required)':'Search query (optional)';$('app-read-notice').textContent=appReadNotices[choice?.toolkit]||'';$('app-query').required=extra;}});
async function enable(){
  if(!S.connected||!S.supported||S.busy)return;const epoch=S.epoch;S.busy=true;render();
  try{const result=await send('pips_enable',{enabled:true});if(epoch!==S.epoch||!S.connected)return;S.enabled=result.enabled===true;S.notice=result.message||'Local Pips enabled.';if(S.enabled)await initialize();}
  catch(error){if(epoch===S.epoch)setError(error);}finally{if(epoch===S.epoch){S.busy=false;render();}}
}
document.addEventListener('keydown',event=>{
  if(!S.review&&event.target.id==='chatModelSearch'&&event.key==='Enter'){event.preventDefault();return;}
  if(!S.review&&S.composerPanel){if(event.key==='Escape'){event.preventDefault();const target=S.composerPanel==='context'?'chat-context-toggle':'chat-model';S.composerPanel='';render();$(target)?.focus();return;}if(['ArrowUp','ArrowDown'].includes(event.key)&&event.target.closest?.('.composer-model-options')){event.preventDefault();const items=[...document.querySelectorAll('[data-chat-model]:not(:disabled)')],at=items.indexOf(event.target);items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();return;}}
  if(!S.review&&event.target.id==='chatText'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void sendChat();return;}
  if(!S.review)return;
  if(event.key==='Escape'&&!S.busy){event.preventDefault();closeReview();return;}
  if(event.key==='Tab'){
    const items=[...$('review-root').querySelectorAll('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];if(!items.length){event.preventDefault();return;}
    const first=items[0],last=items[items.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===$('review-title'))){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
const stopMessages=options.onMessage(message=>{
  if(disposed||!record(message))return;
  if(message.type==='pipsReply'){broker.receive(message);return;}
  if(message.type==='pipsVisibility'){S.visible=message.visible===true;motion();if(S.visible)void refresh(false);return;}
  if(message.type==='pipsConnection'){
    if(message.generation !== undefined && message.generation === S.generation) return;
    S.generation=message.generation ?? null;
    savedView=options.getState?.()||savedView;S.epoch++;broker.reset();clearSelection();S.selected='';S.overview=true;restoreView=true;chatDrafts.clear();chatRequests.clear();chatPreferences.clear();draft.chatText='';S.workspace=null;S.jobs=[];setupSeq++;setupDetailSeq++;setupRows=[];setupLoading=false;setupError='';draft.setupTask='';S.types=[];S.models=[];S.defaultModel='';S.modelsError='';S.modelsLoading=false;S.executionCapability=null;S.executionLoading=false;S.executionError='';draft.createModel='default';S.create=false;S.createStep='type';S.createType='';creationDrafts.clear();avatarIds.clear();S.runner=null;S.context=null;S.refreshing=false;S.busy=false;S.loading=false;S.error='';S.notice='';S.apiVersion=Number.isSafeInteger(message.apiVersion)?message.apiVersion:9;S.connected=message.connected===true;S.supported=message.supported===true;S.enabled=message.enabled===true;
    render();if(usable())void initialize();
  }
});
disposers.push(stopMessages);
const onPageHide=()=>{avatarObserver?.disconnect();avatarObserver=null;};window.addEventListener('pagehide',onPageHide);disposers.push(()=>window.removeEventListener('pagehide',onPageHide));
function motion(){document.body.classList.toggle('motion-paused',!S.visible||document.hidden||motionPaused);}
document.addEventListener('visibilitychange',()=>{motion();if(!document.hidden){fitChatInput();void refresh(false);}});
if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(fitChatInput);observer.observe(shell);disposers.push(()=>observer.disconnect());}
// One bounded polling loop for the entire tab, paused while hidden; no timers per avatar or job.
const pollingTimer=window.setInterval(()=>{broker.expire(Date.now());if(polling||!S.visible||document.hidden||!usable()||S.busy||S.review||S.create||!['runs','chat'].includes(S.tab))return;polling=true;void refresh(false).finally(()=>{polling=false;});},4000);
motion();render();vscode.postMessage({type:'pipsReady'});
return {async navigate(value){if(!S.workspace||!usable()){options.navigation=value;navigationPending=true;return;}try{await refresh(false);await navigateFromHost(value);}catch(error){setError(error);}},setMotionPaused(paused){motionPaused=paused===true;motion();},setVisible(visible){S.visible=visible===true;motion();if(S.visible)void refresh(false);},dispose(){if(disposed)return;disposed=true;S.epoch++;broker.reset();window.clearInterval(pollingTimer);avatarObserver?.disconnect();characterCleanup?.();characterCleanup=null;for(const dispose of disposers)dispose?.();characterStyles.remove();if(embedded)shell.remove();}};

}
if(typeof window!=='undefined')window.DgcPips={mount:mountPips,mountSetupCards,mountDigestBar};
if(typeof window!=='undefined'&&typeof acquireVsCodeApi==='function'&&!window.document.getElementById('pips-host')){
  const api=acquireVsCodeApi();
  mountPips({root:window.document,postMessage:message=>api.postMessage(message),getState:()=>api.getState?.(),setState:value=>api.setState?.(value),onMessage:listener=>{const handle=event=>listener(event.data);window.addEventListener('message',handle);return()=>window.removeEventListener('message',handle);}});
}
